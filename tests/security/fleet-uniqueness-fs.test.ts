// Requisiti soddisfatti: RF-ROB-006, RF-ROB-008, RF-ROB-010, RF-ROB-011, RF-ROB-012, RF-ROB-013, RF-ROB-014, RF-SRVFS-005, RF-SRVFS-007, RNF-FS-001, RNF-FS-002, RNF-FS-003, RNF-FS-004, RNF-SEC-002, RNF-SEC-008, RNF-SEC-009, §8.2, §8.3, §8.4, §10.1, §11.1, §11.3
//
// MASTER TEST SUITE: UNICITÀ DELLA FLOTTA, ISOLAMENTO FILESYSTEM E HARDENING CORRETTIVO
// ==============================================================================
// Verifica approfondita dei 10 punti di collaudo richiesti dal committente:
// 1. Unicità secondo il Problema 1 nelle due modalità ("per_host" e "globale")
// 2. Due robot con stesso username su host diversi -> directory distinte (<username>_<id>), zero collisioni
// 3. Collisione dell'underscore: id con "_" categoricamente rifiutato; combinazioni ambigue impossibili
// 4. Re-registrazione dopo la rimozione: nuovo id, nuova directory, file della vecchia directory intatti
// 5. Percorso salvato a DB usato sempre, anche se la regola di naming cambia
// 6. Directory preesistente (policy "accetta"): file intatti, flag persistito, rollback sicuro, repair
// 7. Whitelist username: lunghezze 1, 2, 31, 32; maiuscole, punto, spazio, unicode, byte nullo, "..", "/", "\"
// 8. Directory .tmp riservata con permessi 0700: non visibile, non raggiungibile, upload respinti con audit
// 9. Rimozione non cancella file (CA-ROB-011); robot irraggiungibile compare in lista con stati separati (CA-ROB-012)
// 10. Assoluta assenza di credenziali nelle risposte DTO e nelle comunicazioni applicative

import assert from "assert";
import fs from "fs";
import os from "os";
import path from "path";
import { Readable } from "stream";

import { InMemoryRobotRepository } from "../../storage/robot-repository.ts";
import { InMemoryAuditRepository } from "../../storage/audit-repository.ts";
import { InMemoryCredentialProvider } from "../../backend/connection/credential-provider.ts";
import { DefaultHostKeyVerifier } from "../../backend/connection/host-key-verifier.ts";
import { RobotConnectionManager } from "../../backend/connection/robot-connection-manager.ts";
import { FleetService } from "../../backend/fleet/fleet-service.ts";
import { ServerFilesystemService } from "../../storage/server-fs.ts";
import { StandardRobotDirectoryNamingPolicy, type RobotEntity } from "../../storage/robot-models.ts";
import { MolirisLogger } from "../../logging/logger.ts";
import { ErrorCode, MolirisAppError } from "../../errors/app-errors.ts";
import { AppPermission, DEFAULT_ROLE_PERMISSIONS } from "../../backend/auth/permissions.ts";
import { type UserEntity } from "../../backend/auth/user-models.ts";
import { type SystemConfiguration } from "../../config/configuration.ts";
import { SessionManager } from "../../backend/auth/session-manager.ts";
import { InMemoryUserRepository } from "../../backend/auth/user-repository.ts";

console.log("--> Esecuzione suite di test Unicità Flotta, Isolamento Filesystem e Hardening Correttivo...");

const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "moliris-uniqueness-test-"));
const logger = new MolirisLogger();

const adminUser: UserEntity = {
  id: "admin-user",
  username: "admin_test",
  roles: ["amministratore"],
  enabled: true,
  createdAt: new Date(),
  updatedAt: new Date(),
  passwordHash: "hash_admin",
};

const operatorUser: UserEntity = {
  id: "operator-user",
  username: "operator_test",
  roles: ["operatore"],
  enabled: true,
  createdAt: new Date(),
  updatedAt: new Date(),
  passwordHash: "hash_op",
};

function buildFleetTestEnvironment(overrides: Partial<SystemConfiguration> = {}) {
  const fsRoot = fs.mkdtempSync(path.join(tmpBase, "fsroot-"));
  const cfg: SystemConfiguration = {
    serverFilesystemRoot: fsRoot,
    pollingIntervalSeconds: 10,
    sshConnectionTimeoutMs: 1000,
    maxConcurrentTransfersPerUser: 5,
    maxConcurrentTransfersPerRobot: 5,
    maxConcurrentTransfersServer: 10,
    tempFileRetentionMinutes: 60,
    stateFilePaths: ["/tmp/status.txt"],
    inactiveSessionTimeoutMinutes: 30,
    tlsCertPath: "dummy.pem",
    tlsKeyPath: "dummy.pem",
    standardSubdirectories: ["logs", "configs", "backups"],
    registrationMode: "differita",
    auditLogRetentionDays: 90,
    defaultSshPort: 22,
    existingDirectoryPolicy: "accetta",
    credentialProviderType: "in-memory",
    robotUsernameUniqueness: overrides.robotUsernameUniqueness ?? "per_host",
    serverDirectoryPermissions: "0750",
    ...overrides,
  };

  const repo = new InMemoryRobotRepository(cfg.robotUsernameUniqueness);
  const audit = new InMemoryAuditRepository();
  const serverFs = new ServerFilesystemService(cfg.serverFilesystemRoot, audit, logger);
  const creds = new InMemoryCredentialProvider(["password", "key"]);
  const hostVerifier = new DefaultHostKeyVerifier();
  const connMgr = new RobotConnectionManager(creds, hostVerifier, {
    maxConcurrentPerUser: 5,
    maxConcurrentPerRobot: 5,
    maxConcurrentServer: 10,
    connectionTimeoutMs: 1000,
  }, logger);

  const fleetService = new FleetService(
    cfg,
    repo,
    audit,
    serverFs,
    creds,
    hostVerifier,
    connMgr,
    logger,
    DEFAULT_ROLE_PERMISSIONS
  );

  return { cfg, repo, audit, serverFs, fleetService, fsRoot };
}

try {
  // =========================================================================
  // TEST 1: Unicità secondo Problema 1 nelle due modalità ("per_host" e "globale")
  // =========================================================================
  {
    console.log("  -> [Test 1] Unicità robotUsernameUniqueness: 'per_host' vs 'globale'...");

    // 1a. Modalità per_host (default di produzione):
    // Stesso username su host diversi DEVE avere successo; stesso username su stesso host/porta DEVE fallire.
    const envPerHost = buildFleetTestEnvironment({ robotUsernameUniqueness: "per_host" });

    // Robot 1: operator_user su 192.168.1.10:22
    const reg1 = await envPerHost.fleetService.registerRobot(adminUser, {
      id: "robot-ph-01",
      displayName: "Rover 1",
      remoteUsername: "operator_user",
      host: "192.168.1.10",
      sshPort: 22,
      sshAuthMethod: "password",
      password: "secret_password",
      hostKeyVerification: { fingerprint: "a".repeat(64) },
    });
    assert.strictEqual(reg1.outcome, "ssh_non_verificata");

    // Robot 2: stesso username operator_user ma su host DIVERSO (192.168.1.20:22) -> SUCCESSO
    const reg2 = await envPerHost.fleetService.registerRobot(adminUser, {
      id: "robot-ph-02",
      displayName: "Rover 2",
      remoteUsername: "operator_user",
      host: "192.168.1.20",
      sshPort: 22,
      sshAuthMethod: "password",
      password: "secret_password",
      hostKeyVerification: { fingerprint: "b".repeat(64) },
    });
    assert.strictEqual(reg2.outcome, "ssh_non_verificata", "In modalità per_host, lo stesso username su host diverso deve essere accettato");

    // Robot 3: stesso username operator_user sullo STESSO host e porta (192.168.1.10:22) -> RIFIUTATO
    const reg3 = await envPerHost.fleetService.registerRobot(adminUser, {
      id: "robot-ph-03",
      displayName: "Rover 3 Duplicate Device",
      remoteUsername: "operator_user",
      host: "192.168.1.10",
      sshPort: 22,
      sshAuthMethod: "password",
      password: "secret_password",
      hostKeyVerification: { fingerprint: "c".repeat(64) },
    });
    assert.strictEqual(reg3.outcome, "registrazione_rifiutata", "Stesso account sullo stesso dispositivo deve essere rifiutato");
    assert.ok(reg3.validationErrors?.remoteUsername, "Errore di violazione unicità sullo stesso dispositivo segnalato");

    // 1b. Modalità globale:
    // Stesso username su host DIVERSO DEVE essere categoricamente rifiutato.
    const envGlobale = buildFleetTestEnvironment({ robotUsernameUniqueness: "globale" });

    const regGlob1 = await envGlobale.fleetService.registerRobot(adminUser, {
      id: "robot-gl-01",
      displayName: "Rover Global 1",
      remoteUsername: "global_op",
      host: "10.0.0.1",
      sshPort: 22,
      sshAuthMethod: "password",
      password: "secret_password",
      hostKeyVerification: { fingerprint: "d".repeat(64) },
    });
    assert.strictEqual(regGlob1.outcome, "ssh_non_verificata");

    const regGlob2 = await envGlobale.fleetService.registerRobot(adminUser, {
      id: "robot-gl-02",
      displayName: "Rover Global 2",
      remoteUsername: "global_op", // Duplicato globale su host diverso
      host: "10.0.0.2",
      sshPort: 22,
      sshAuthMethod: "password",
      password: "secret_password",
      hostKeyVerification: { fingerprint: "e".repeat(64) },
    });
    assert.strictEqual(regGlob2.outcome, "registrazione_rifiutata", "In modalità globale, lo username duplicato deve essere rifiutato anche su host diversi");
    assert.ok(regGlob2.validationErrors?.remoteUsername);

    console.log("    PASS: Test 1 completato con successo.");
  }

  // =========================================================================
  // TEST 2: Due robot con stesso username su host diversi -> directory distinte (<username>_<id>)
  // =========================================================================
  {
    console.log("  -> [Test 2] Naming directory <username>_<id>, zero collisioni e isolamento...");
    const { fleetService, fsRoot, repo } = buildFleetTestEnvironment({ robotUsernameUniqueness: "per_host" });

    const regA = await fleetService.registerRobot(adminUser, {
      id: "amr01",
      displayName: "AMR Warehouse 01",
      remoteUsername: "operator",
      host: "192.168.10.1",
      sshPort: 22,
      sshAuthMethod: "password",
      password: "pass",
      hostKeyVerification: { fingerprint: "1".repeat(64) },
    });
    assert.strictEqual(regA.outcome, "ssh_non_verificata");

    const regB = await fleetService.registerRobot(adminUser, {
      id: "amr02",
      displayName: "AMR Warehouse 02",
      remoteUsername: "operator",
      host: "192.168.10.2",
      sshPort: 22,
      sshAuthMethod: "password",
      password: "pass",
      hostKeyVerification: { fingerprint: "2".repeat(64) },
    });
    assert.strictEqual(regB.outcome, "ssh_non_verificata");

    const expectedDirA = path.join(fsRoot, "operator_amr01");
    const expectedDirB = path.join(fsRoot, "operator_amr02");

    assert.strictEqual(regA.robot?.serverDirectoryPath, expectedDirA);
    assert.strictEqual(regB.robot?.serverDirectoryPath, expectedDirB);
    assert.notStrictEqual(expectedDirA, expectedDirB);

    assert.ok(fs.existsSync(expectedDirA), "Directory amr01 creata");
    assert.ok(fs.existsSync(expectedDirB), "Directory amr02 creata");

    // Scrittura di un file su amr01: non deve comparire su amr02
    fs.writeFileSync(path.join(expectedDirA, "logs", "session_a.log"), "DATA AMR 01");
    assert.strictEqual(fs.existsSync(path.join(expectedDirB, "logs", "session_a.log")), false);

    console.log("    PASS: Test 2 completato con successo.");
  }

  // =========================================================================
  // TEST 3: Collisione dell'underscore: id con "_" rifiutato; combinazioni ambigue impossibili
  // =========================================================================
  {
    console.log("  -> [Test 3] Rifiuto categorico di underscore nell'id ed eliminazione ambiguità...");
    const { fleetService } = buildFleetTestEnvironment();

    // ID con underscore: rifiutato
    const underscoreIds = ["robot_01", "amr_alpha", "op_a_b", "_leading", "trailing_"];
    for (const badId of underscoreIds) {
      const res = await fleetService.registerRobot(adminUser, {
        id: badId,
        displayName: "Bad Underscore ID",
        remoteUsername: "operator",
        host: "127.0.0.1",
        sshPort: 22,
        sshAuthMethod: "password",
        password: "pass",
        hostKeyVerification: { fingerprint: "3".repeat(64) },
      });
      assert.strictEqual(res.outcome, "registrazione_rifiutata", `ID '${badId}' con underscore deve essere rifiutato`);
      assert.ok(res.validationErrors?.id, `Errore su ID '${badId}' segnalato`);
    }

    // ID con caratteri non ammessi
    const invalidIds = ["robot 01", "ROBOT-01", "robot/01", "robot..01", "a".repeat(33)];
    for (const invId of invalidIds) {
      const res = await fleetService.registerRobot(adminUser, {
        id: invId,
        displayName: "Invalid ID",
        remoteUsername: "operator",
        host: "127.0.0.1",
        sshPort: 22,
        sshAuthMethod: "password",
        password: "pass",
        hostKeyVerification: { fingerprint: "3".repeat(64) },
      });
      assert.strictEqual(res.outcome, "registrazione_rifiutata");
      assert.ok(res.validationErrors?.id);
    }

    // ID valido con caratteri minuscoli, cifre e trattino (senza underscore)
    const validId = "robot-01-amr-42";
    const validRes = await fleetService.registerRobot(adminUser, {
      id: validId,
      displayName: "Valid ID Robot",
      remoteUsername: "operator",
      host: "127.0.0.1",
      sshPort: 22,
      sshAuthMethod: "password",
      password: "pass",
      hostKeyVerification: { fingerprint: "3".repeat(64) },
    });
    assert.strictEqual(validRes.outcome, "ssh_non_verificata");

    console.log("    PASS: Test 3 completato con successo.");
  }

  // =========================================================================
  // TEST 4: Re-registrazione dopo la rimozione: nuovo id, nuova directory, file vecchi intatti
  // =========================================================================
  {
    console.log("  -> [Test 4] Re-registrazione post-rimozione, unicità record storici e preservazione file...");
    const { fleetService, fsRoot, repo } = buildFleetTestEnvironment();

    // 1. Registra robot iniziale
    await fleetService.registerRobot(adminUser, {
      id: "robot-old",
      displayName: "Old Robot",
      remoteUsername: "operator_dev",
      host: "192.168.100.5",
      sshPort: 22,
      sshAuthMethod: "password",
      password: "pass",
      hostKeyVerification: { fingerprint: "4".repeat(64) },
    });

    const oldDir = path.join(fsRoot, "operator_dev_robot-old");
    const oldFile = path.join(oldDir, "logs", "essential-history.log");
    fs.writeFileSync(oldFile, "CRITICAL AUDIT LOGS FROM OLD ROBOT");

    // 2. Rimuove il robot (richiede confirm: true)
    await fleetService.removeRobot(adminUser, "robot-old", true);

    const oldEntity = await repo.findById("robot-old");
    assert.strictEqual(oldEntity?.anagraphicState, "rimosso");

    // 3. Verifica che i file e la directory vecchia siano ancora intatti (RF-ROB-013, CA-ROB-011)
    assert.ok(fs.existsSync(oldFile), "I file storici del robot rimosso non devono MAI essere cancellati");
    assert.strictEqual(fs.readFileSync(oldFile, "utf8"), "CRITICAL AUDIT LOGS FROM OLD ROBOT");

    // 4. Tentativo di riutilizzare il VECCHIO ID: categoricamente respinto (RF-ROB-006, Problema 1d)
    const reuseOldIdRes = await fleetService.registerRobot(adminUser, {
      id: "robot-old", // Già usato in passato
      displayName: "Attempt Reusing Old ID",
      remoteUsername: "operator_dev",
      host: "192.168.100.5",
      sshPort: 22,
      sshAuthMethod: "password",
      password: "pass",
      hostKeyVerification: { fingerprint: "4".repeat(64) },
    });
    assert.strictEqual(reuseOldIdRes.outcome, "registrazione_rifiutata", "Un ID non può mai essere riutilizzato anche se il robot è stato rimosso");
    assert.ok(reuseOldIdRes.validationErrors?.id);

    // 5. Re-registrazione dello STESSO dispositivo con NUOVO ID: ha successo
    const newReg = await fleetService.registerRobot(adminUser, {
      id: "robot-new",
      displayName: "New Robot for Same Device",
      remoteUsername: "operator_dev",
      host: "192.168.100.5", // Stesso host/porta del rimosso
      sshPort: 22,
      sshAuthMethod: "password",
      password: "pass",
      hostKeyVerification: { fingerprint: "4".repeat(64) },
    });
    assert.strictEqual(newReg.outcome, "ssh_non_verificata", "Re-registrazione dispositivo con nuovo ID consentita");

    const newDir = path.join(fsRoot, "operator_dev_robot-new");
    assert.strictEqual(newReg.robot?.serverDirectoryPath, newDir);
    assert.notStrictEqual(oldDir, newDir);
    assert.ok(fs.existsSync(newDir));
    // La nuova directory non contiene per errore il file della vecchia directory
    assert.strictEqual(fs.existsSync(path.join(newDir, "logs", "essential-history.log")), false);
    // E il vecchio file esiste ancora intatto
    assert.ok(fs.existsSync(oldFile));

    console.log("    PASS: Test 4 completato con successo.");
  }

  // =========================================================================
  // TEST 5: Percorso salvato a DB usato sempre, anche se la regola di naming cambia
  // =========================================================================
  {
    console.log("  -> [Test 5] Invarianza operativa: uso del percorso persistito nel record...");
    const { repo, serverFs, fsRoot, audit } = buildFleetTestEnvironment();

    // Creiamo una directory con naming legacy/custom
    const customLegacyDir = path.join(fsRoot, "custom_legacy_path_for_robot");
    fs.mkdirSync(path.join(customLegacyDir, "logs"), { recursive: true });
    fs.writeFileSync(path.join(customLegacyDir, "logs", "data.txt"), "LEGACY STORED DATA");

    const legacyRobot: RobotEntity = {
      id: "robot-legacy",
      displayName: "Robot Legacy",
      remoteUsername: "legacy_user",
      serverDirectoryPath: customLegacyDir, // Percorso registrato diverso dalla regola nuova
      host: "10.0.0.99",
      sshPort: 22,
      sshAuthMethod: "password",
      credentialReference: "vault://mock",
      anagraphicState: "attivo",
      connectionState: "raggiungibile",
      registrationState: "registrazione_completata",
      operationalState: null,
      lastValidUpdateAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await repo.create(legacyRobot);

    // Navigazione sul filesystem server: deve usare customLegacyDir, non ricalcolare il percorso!
    const userContext = {
      user: adminUser,
      permissions: new Set([AppPermission.FS_SERVER_NAVIGATE, AppPermission.FS_SERVER_DOWNLOAD]),
      effectiveRole: "amministratore",
    } as any;

    const list = await serverFs.listDirectory(userContext, legacyRobot, "logs");
    assert.ok(list.some(e => e.name === "data.txt"), "Deve elencare i dati dentro serverDirectoryPath salvato nel record");

    console.log("    PASS: Test 5 completato con successo.");
  }

  // =========================================================================
  // TEST 6: Directory preesistente (policy "accetta"): file intatti, flag persistito, rollback
  // =========================================================================
  {
    console.log("  -> [Test 6] Directory preesistente, flag persistito e rollback non distruttivo...");
    const { fleetService, fsRoot, repo } = buildFleetTestEnvironment({ existingDirectoryPolicy: "accetta" });

    // Creiamo una directory preesistente con file
    const preDir = path.join(fsRoot, "pre_user_robot-pre-01");
    fs.mkdirSync(path.join(preDir, "configs"), { recursive: true });
    fs.writeFileSync(path.join(preDir, "configs", "critical_hw_config.bin"), "IMMUTABLE CONTENT");

    // Registrazione: deve accettare la directory senza distruggere i file
    const regRes = await fleetService.registerRobot(adminUser, {
      id: "robot-pre-01",
      displayName: "Robot Preexisting Dir",
      remoteUsername: "pre_user",
      host: "192.168.1.55",
      sshPort: 22,
      sshAuthMethod: "password",
      password: "pass",
      hostKeyVerification: { fingerprint: "6".repeat(64) },
    });

    assert.strictEqual(regRes.outcome, "ssh_non_verificata");

    // Verifica persistenza flag directoryPreexisting nel record DB (Problema 3)
    const saved = await repo.findById("robot-pre-01");
    assert.strictEqual(saved?.directoryPreexisting, true, "Il flag directoryPreexisting deve essere persistito come true");

    // File preesistente totalmente intatto
    const fileAfter = fs.readFileSync(path.join(preDir, "configs", "critical_hw_config.bin"), "utf8");
    assert.strictEqual(fileAfter, "IMMUTABLE CONTENT");

    // Test rollback sicuro: in caso di rollback, se directoryPreexisting === true, la directory NON viene rimossa
    const faultyRepo = new InMemoryRobotRepository();
    faultyRepo.updateRegistrationState = async () => {
      throw new Error("Simulated Failure in Phase 3");
    };
    const envRollback = buildFleetTestEnvironment();
    // Creiamo cartella preesistente
    const preRollbackDir = path.join(envRollback.fsRoot, "roll_user_robot-roll-01");
    fs.mkdirSync(preRollbackDir, { recursive: true });
    fs.writeFileSync(path.join(preRollbackDir, "dont_touch.txt"), "MUST NOT BE DELETED");

    // Chiamata ensureRobotDirectory con directoryPreexisting = true
    const dirResult = await envRollback.serverFs.ensureRobotDirectory({
      id: "robot-roll-01",
      remoteUsername: "roll_user",
      serverDirectoryPath: preRollbackDir,
      directoryPreexisting: true,
    } as any);

    assert.strictEqual(dirResult.alreadyExisted, true);

    // Rollback tentato su directory preesistente: deve preservarla
    await envRollback.serverFs.rollbackRobotDirectory(dirResult);
    assert.ok(fs.existsSync(preRollbackDir), "Directory preesistente non deve essere eliminata dal rollback");
    assert.ok(fs.existsSync(path.join(preRollbackDir, "dont_touch.txt")));

    console.log("    PASS: Test 6 completato con successo.");
  }

  // =========================================================================
  // TEST 7: Whitelist username: lunghezze 1, 2, 31, 32; maiuscole, punto, spazio, unicode...
  // =========================================================================
  {
    console.log("  -> [Test 7] Whitelist username esatta ^[a-z_][a-z0-9_-]{1,31}$...");
    const { fleetService } = buildFleetTestEnvironment();

    const testRegistrationUsername = async (u: string) => {
      return await fleetService.registerRobot(adminUser, {
        id: `rob-${Math.random().toString(36).substring(2, 8)}`,
        displayName: "Username Test",
        remoteUsername: u,
        host: "127.0.0.1",
        sshPort: 22,
        sshAuthMethod: "password",
        password: "pass",
        hostKeyVerification: { fingerprint: "7".repeat(64) },
      });
    };

    // Lunghezza 1: rifiutato (minimo 2 caratteri per via di {1,31} dopo il primo carattere)
    const len1 = await testRegistrationUsername("a");
    assert.strictEqual(len1.outcome, "registrazione_rifiutata", "Username lunghezza 1 deve essere rifiutato");
    assert.ok(len1.validationErrors?.remoteUsername);

    // Lunghezza 2: valido
    const len2 = await testRegistrationUsername("ab");
    assert.strictEqual(len2.outcome, "ssh_non_verificata", "Username lunghezza 2 deve essere accettato");

    // Lunghezza 31: valido
    const u31 = "a" + "b".repeat(30);
    const len31 = await testRegistrationUsername(u31);
    assert.strictEqual(len31.outcome, "ssh_non_verificata", "Username lunghezza 31 deve essere accettato");

    // Lunghezza 32: valido
    const u32 = "a" + "b".repeat(31);
    const len32 = await testRegistrationUsername(u32);
    assert.strictEqual(len32.outcome, "ssh_non_verificata", "Username lunghezza 32 deve essere accettato");

    // Lunghezza 33: rifiutato
    const u33 = "a" + "b".repeat(32);
    const len33 = await testRegistrationUsername(u33);
    assert.strictEqual(len33.outcome, "registrazione_rifiutata", "Username lunghezza 33 deve essere rifiutato");
    assert.ok(len33.validationErrors?.remoteUsername);

    // Maiuscole: rifiutato
    const upper = await testRegistrationUsername("Operator");
    assert.strictEqual(upper.outcome, "registrazione_rifiutata");
    assert.ok(upper.validationErrors?.remoteUsername);

    // Punto: rifiutato
    const dot = await testRegistrationUsername("operator.user");
    assert.strictEqual(dot.outcome, "registrazione_rifiutata");
    assert.ok(dot.validationErrors?.remoteUsername);

    // Spazio: rifiutato
    const space = await testRegistrationUsername("operator user");
    assert.strictEqual(space.outcome, "registrazione_rifiutata");
    assert.ok(space.validationErrors?.remoteUsername);

    // Unicode: rifiutato
    const unicode = await testRegistrationUsername("opératör");
    assert.strictEqual(unicode.outcome, "registrazione_rifiutata");
    assert.ok(unicode.validationErrors?.remoteUsername);

    // Byte nullo: rifiutato
    const nullByte = await testRegistrationUsername("operator\0");
    assert.strictEqual(nullByte.outcome, "registrazione_rifiutata");
    assert.ok(nullByte.validationErrors?.remoteUsername);

    // Path traversal: rifiutato
    const traversal = await testRegistrationUsername("../../operator");
    assert.strictEqual(traversal.outcome, "registrazione_rifiutata");
    assert.ok(traversal.validationErrors?.remoteUsername);

    // Slash e backslash: rifiutato
    const slash = await testRegistrationUsername("operator/sub");
    assert.strictEqual(slash.outcome, "registrazione_rifiutata");
    const backslash = await testRegistrationUsername("operator\\sub");
    assert.strictEqual(backslash.outcome, "registrazione_rifiutata");

    console.log("    PASS: Test 7 completato con successo.");
  }

  // =========================================================================
  // TEST 8: .tmp non raggiungibile da utenti; nomi riservati rifiutati
  // =========================================================================
  {
    console.log("  -> [Test 8] Isolamento directory .tmp, nomi riservati e audit di sicurezza...");
    const { fleetService, serverFs, fsRoot, audit, repo } = buildFleetTestEnvironment();

    const reg = await fleetService.registerRobot(adminUser, {
      id: "robot-tmp-test",
      displayName: "Robot Tmp Test",
      remoteUsername: "tmp_user",
      host: "127.0.0.1",
      sshPort: 22,
      sshAuthMethod: "password",
      password: "pass",
      credentialReference: `vault://robots/robot-tmp-test`,
      hostKeyVerification: { fingerprint: "8".repeat(64) },
    });
    assert.strictEqual(reg.outcome, "ssh_non_verificata");
    const robot = await repo.findById("robot-tmp-test") as RobotEntity;

    const userContext = {
      user: adminUser,
      permissions: new Set([AppPermission.FS_SERVER_NAVIGATE, AppPermission.FS_SERVER_UPLOAD]),
      effectiveRole: "amministratore",
    } as any;

    // Assicuriamo directory temporanea .tmp con permessi 0700
    await serverFs.ensureTempDirectory(robot);
    const tmpDir = path.join(robot.serverDirectoryPath, ".tmp");
    assert.ok(fs.existsSync(tmpDir));

    // 1. listDirectory non mostra .tmp
    const rootList = await serverFs.listDirectory(userContext, robot, "");
    assert.strictEqual(rootList.some(e => e.name === ".tmp" || e.name === ".moliris_tmp"), false);

    // 2. Tentativo di navigare dentro .tmp: respinto con eccezione sicura e audit
    await assert.rejects(
      async () => await serverFs.listDirectory(userContext, robot, ".tmp"),
      (err: any) => err instanceof MolirisAppError && (err.code === ErrorCode.SECURITY_VIOLATION || err.code === ErrorCode.SERVER_DIR_INACCESSIBLE)
    );

    // 3. Tentativo di traversal verso .tmp
    await assert.rejects(
      async () => await serverFs.listDirectory(userContext, robot, "logs/../../.tmp"),
      (err: any) => err instanceof MolirisAppError && (err.code === ErrorCode.SECURITY_VIOLATION || err.code === ErrorCode.SERVER_DIR_INACCESSIBLE)
    );

    // 4. Tentativo di upload su file o cartelle riservate (.tmp)
    await assert.rejects(
      async () => await serverFs.openFileWriteStream(userContext, robot, ".tmp/stolen.bin"),
      (err: any) => err instanceof MolirisAppError && (err.code === ErrorCode.SECURITY_VIOLATION || err.code === ErrorCode.SERVER_DIR_INACCESSIBLE)
    );

    // Verifica registrazione audit della violazione di sicurezza
    const securityAuditEvents = await audit.query({ robotId: robot.id });
    assert.ok(securityAuditEvents.some(e => e.details?.reason === "RESERVED_DIRECTORY_ACCESS_DENIED" || e.operation === "SECURITY_AUTHORIZATION_ERROR"));

    console.log("    PASS: Test 8 completato con successo.");
  }

  // =========================================================================
  // TEST 9: Rimozione non cancella file; robot irraggiungibile ancora in lista
  // =========================================================================
  {
    console.log("  -> [Test 9] Preservazione file in rimozione (CA-ROB-011) e visibilità offline (CA-ROB-012)...");
    const { fleetService, fsRoot } = buildFleetTestEnvironment();

    // Registrazione robot
    await fleetService.registerRobot(adminUser, {
      id: "robot-persist",
      displayName: "Robot To Persist",
      remoteUsername: "persist_user",
      host: "192.168.10.10",
      sshPort: 22,
      sshAuthMethod: "password",
      password: "pass",
      hostKeyVerification: { fingerprint: "9".repeat(64) },
    });

    const robotDir = path.join(fsRoot, "persist_user_robot-persist");
    const dataFile = path.join(robotDir, "logs", "robot_history.log");
    fs.writeFileSync(dataFile, "CRUCIAL TELEMETRY DATA");

    // Rimozione
    await fleetService.removeRobot(adminUser, "robot-persist", true);

    // CA-ROB-011: I file e la directory DEVONO restare intatti
    assert.ok(fs.existsSync(robotDir), "La directory deve essere preservata");
    assert.ok(fs.existsSync(dataFile), "I file devono essere preservati");
    assert.strictEqual(fs.readFileSync(dataFile, "utf8"), "CRUCIAL TELEMETRY DATA");

    // CA-ROB-012: Robot irraggiungibile compare nella lista con stato distinto
    await fleetService.registerRobot(adminUser, {
      id: "robot-offline-list",
      displayName: "Robot Offline List",
      remoteUsername: "offline_user",
      host: "192.0.2.1", // IP non raggiungibile
      sshPort: 22,
      sshAuthMethod: "password",
      password: "pass",
      hostKeyVerification: { fingerprint: "9".repeat(64) },
    });

    const list = await fleetService.listFleet(adminUser);
    const offlineItem = list.find(r => r.id === "robot-offline-list");
    assert.ok(offlineItem, "Robot offline deve essere presente nella lista flotta");
    assert.strictEqual(offlineItem.connectionState, "non_raggiungibile");
    assert.strictEqual(offlineItem.anagraphicState, "attivo");

    console.log("    PASS: Test 9 completato con successo.");
  }

  // =========================================================================
  // TEST 10: Assoluta assenza di credenziali nelle risposte
  // =========================================================================
  {
    console.log("  -> [Test 10] Assenza assoluta di credenziali in DTO, risposte e liste (RNF-SEC-002)...");
    const { fleetService } = buildFleetTestEnvironment();

    const reg = await fleetService.registerRobot(adminUser, {
      id: "robot-dto-sec",
      displayName: "Robot DTO Security",
      remoteUsername: "dto_user",
      host: "127.0.0.1",
      sshPort: 22,
      sshAuthMethod: "password",
      password: "SuperSecretPassword123!",
      hostKeyVerification: { fingerprint: "0".repeat(64) },
    });

    // 1. Nel risultato della registrazione
    const regDto = reg.robot as any;
    assert.strictEqual(regDto.password, undefined);
    assert.strictEqual(regDto.privateKey, undefined);
    assert.strictEqual(regDto.credentialReference, undefined);

    // 2. Nel dettaglio del robot
    const detail = await fleetService.getRobotDetail(adminUser, "robot-dto-sec");
    const detailDto = detail.robot as any;
    assert.strictEqual(detailDto.password, undefined);
    assert.strictEqual(detailDto.privateKey, undefined);
    assert.strictEqual(detailDto.credentialReference, undefined);

    // 3. Nella lista flotta
    const fleetList = await fleetService.listFleet(adminUser);
    const foundDto = fleetList.find(r => r.id === "robot-dto-sec") as any;
    assert.strictEqual(foundDto.password, undefined);
    assert.strictEqual(foundDto.privateKey, undefined);
    assert.strictEqual(foundDto.credentialReference, undefined);

    // 4. Nella risposta di aggiornamento configurazione
    const updateRes = await fleetService.updateConfiguration(adminUser, "robot-dto-sec", {
      password: "NewSuperSecretPassword456!",
    }) as any;
    assert.strictEqual(updateRes.password, undefined);
    assert.strictEqual(updateRes.privateKey, undefined);
    assert.strictEqual(updateRes.credentialReference, undefined);

    console.log("    PASS: Test 10 completato con successo.");
  }

  console.log("PASS: Tutti i 10 test di Unicità Flotta, Isolamento Filesystem e Hardening superati con successo.");
} finally {
  try {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  } catch {}
}
