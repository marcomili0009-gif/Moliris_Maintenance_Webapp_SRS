// Requisiti testati: RF-ROB-001..014, RNF-SEC-002..006, RNF-SEC-009, RNF-REL-001, RNF-REL-003,
// RNF-FS-001..004, RNF-PERF-003, SRS §6.2, §6.3, §8.1..8.4, §9, §10.1, §10.2, §11.2, §11.3,
// CA-ROB-001..012, CA-AUTH-003, CA-SSH-005

import assert from "assert";
import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
import ssh2 from "ssh2";
import { type SystemConfiguration } from "../../config/configuration.ts";
import { InMemoryRobotRepository } from "../../storage/robot-repository.ts";
import { InMemoryClientRepository, InMemoryPlantRepository } from "../../storage/client-plant-repository.ts";
import { InMemoryAuditRepository } from "../../storage/audit-repository.ts";
import { AuditOperation } from "../../storage/audit-models.ts";
import { ServerFilesystemService } from "../../storage/server-fs.ts";
import { InMemoryCredentialProvider } from "../connection/credential-provider.ts";
import { DefaultHostKeyVerifier, computeHostKeyFingerprint } from "../connection/host-key-verifier.ts";
import { RobotConnectionManager } from "../connection/robot-connection-manager.ts";
import { FleetService } from "./fleet-service.ts";
import { type UserEntity } from "../auth/user-models.ts";
import { AppPermission, DEFAULT_ROLE_PERMISSIONS } from "../auth/permissions.ts";
import { MolirisLogger } from "../../logging/logger.ts";
import { MolirisAppError, ErrorCode } from "../../errors/app-errors.ts";

console.log("--> Esecuzione test suite Gestione della Flotta (CA-ROB-001..012)...");

// 1. Setup ambiente di test: cartelle temporanee isolate
const testFsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "moliris-fleet-test-"));
const testLogger = new MolirisLogger();

// 2. Setup server SSH locale di test per collaudare le verifiche di connessione
const serverHostKey = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "pkcs1", format: "pem" },
});
const parsedKey = (ssh2 as any).utils.parseKey(serverHostKey.privateKey);
const serverHostKeyWireBuffer = parsedKey.getPublicSSH();
const serverFingerprintInfo = computeHostKeyFingerprint(serverHostKeyWireBuffer);

let testServerPort = 0;
const testServer = new ssh2.Server({ hostKeys: [serverHostKey.privateKey] }, (client) => {
  client.on("error", () => {});
  client.on("authentication", (ctx) => {
    if (ctx.method === "password" && ctx.password === "ValidPass123!") {
      ctx.accept();
    } else {
      ctx.reject();
    }
  });
  client.on("ready", () => {
    client.on("session", (accept) => {
      const session = accept();
      session.on("error", () => {});
      session.on("exec", (acceptExec, _rejectExec, info) => {
        const stream = acceptExec();
        if (info.command.includes("test -r") || info.command.includes("cat")) {
          stream.write("READABLE\n");
        } else {
          stream.write("OK\n");
        }
        stream.exit(0);
        stream.end();
      });
    });
  });
});

await new Promise<void>((resolve) => {
  testServer.listen(0, "127.0.0.1", () => {
    testServerPort = (testServer.address() as any).port;
    resolve();
  });
});

// Configurazione di test
const testConfig: SystemConfiguration = {
  credentialProviderType: "in-memory",
  serverFilesystemRoot: testFsRoot,
  pollingIntervalSeconds: 10,
  sshConnectionTimeoutMs: 3000,
  maxConcurrentTransfersPerUser: 5,
  maxConcurrentTransfersPerRobot: 5,
  maxConcurrentTransfersServer: 10,
  tempFileRetentionMinutes: 60,
  stateFilePaths: ["/opt/moliris/status/robot.txt"],
  inactiveSessionTimeoutMinutes: 30,
  tlsCertPath: "dummy-cert.pem",
  tlsKeyPath: "dummy-key.pem",
  standardSubdirectories: ["logs", "configs", "backups"],
  registrationMode: "rigorosa",
  auditLogRetentionDays: 90,
  defaultSshPort: 22,
};

// Utenti per i test
const adminUser: UserEntity = {
  id: "admin_01",
  username: "amministratore",
  roles: ["amministratore"],
  enabled: true,
    updatedAt: new Date(),
    passwordHash: "mock_hash",
  createdAt: new Date(),
    
    
  
};

const opUser: UserEntity = {
  id: "op_01",
  username: "operatore",
  roles: ["operatore"],
  enabled: true,
    updatedAt: new Date(),
    passwordHash: "mock_hash",
  createdAt: new Date(),
    
    
  
};

const opRestrictedUser: UserEntity = {
  id: "op_restricted",
  username: "operatore_limitato",
  roles: [],
  permissions: [],
  robotPermissions: {
    "robot-ammesso": [AppPermission.FLEET_VIEW, AppPermission.STATUS_VIEW],
  },
  enabled: true,
    updatedAt: new Date(),
    passwordHash: "mock_hash",
  createdAt: new Date(),
    
    
  
};

function createService(
  overrides: Partial<SystemConfiguration> = {},
  repoOverride?: InMemoryRobotRepository,
  clientRepoOverride?: InMemoryClientRepository,
  plantRepoOverride?: InMemoryPlantRepository,
  auditOverride?: InMemoryAuditRepository
) {
  const cfg = { ...testConfig, ...overrides };
  const repo = repoOverride || new InMemoryRobotRepository();
  const clientRepo = clientRepoOverride || new InMemoryClientRepository();
  const plantRepo = plantRepoOverride || new InMemoryPlantRepository();
  const audit = auditOverride || new InMemoryAuditRepository();
  const serverFs = new ServerFilesystemService(cfg.serverFilesystemRoot, audit, testLogger);
  const creds = new InMemoryCredentialProvider(cfg.allowedSshAuthMethods);
  const hostVerifier = new DefaultHostKeyVerifier();
  const connMgr = new RobotConnectionManager(creds, hostVerifier, {
    maxConcurrentPerUser: 5,
    maxConcurrentPerRobot: 5,
    maxConcurrentServer: 10,
    connectionTimeoutMs: cfg.sshConnectionTimeoutMs,
  }, testLogger);

  const service = new FleetService(
    cfg,
    repo,
    audit,
    serverFs,
    creds,
    hostVerifier,
    connMgr,
    testLogger,
    DEFAULT_ROLE_PERMISSIONS,
    undefined,
    clientRepo,
    plantRepo
  );

  return { service, repo, clientRepo, plantRepo, audit, serverFs, creds, connMgr, cfg };
}

try {
  // =========================================================================
  // CA-ROB-001: Registrazione valida con tutti i parametri obbligatori
  // =========================================================================
  {
    const { service, repo, audit } = createService();
    const result = await service.registerRobot(adminUser, {
      id: "robot-01",
      displayName: "Moliris Rover 1",
      remoteUsername: "moliris_op",
      host: "127.0.0.1",
      sshPort: testServerPort,
      sshAuthMethod: "password",
      password: "ValidPass123!",
      hostKeyVerification: {
        fingerprint: serverFingerprintInfo.sha256Hex,
        strictHostKeyChecking: true,
      },
    });

    assert.strictEqual(result.outcome, "registrazione_completata", "Esito deve essere registrazione_completata");
    assert(result.robot, "Deve restituire il dettaglio del robot registrato");
    assert.strictEqual(result.robot.id, "robot-01");
    assert.strictEqual(result.robot.displayName, "Moliris Rover 1");
    assert.strictEqual(result.robot.connectionState, "raggiungibile");
    assert.strictEqual(result.robot.anagraphicState, "attivo");
    // Verifica sicurezza DTO: nessuna password né credentialReference nel DTO restituito
    assert.strictEqual((result.robot as any).password, undefined);
    assert.strictEqual((result.robot as any).credentialReference, undefined);

    // Verifica persistenza a DB
    const persisted = await repo.findById("robot-01");
    assert(persisted, "Robot deve essere memorizzato a DB");
    assert.strictEqual(persisted.serverDirectoryPath, path.join(testFsRoot, "moliris_op_robot-01"));

    // Verifica audit
    const events = await audit.query({ robotId: "robot-01" });
    assert(events.some(e => e.operation === "ROBOT_REGISTRATION" && e.outcome === "SUCCESS"));

    console.log("  PASS: CA-ROB-001 - Registrazione valida con parametri obbligatori completata con successo.");
  }

  // =========================================================================
  // CA-ROB-002: Campi mancanti o non validi -> Rifiuto con elenco errori, nessun effetto collaterale
  // =========================================================================
  {
    const { service, repo } = createService();
    const result = await service.registerRobot(adminUser, {
      id: "", // Mancante
      displayName: "", // Mancante
      remoteUsername: "", // Mancante
      host: "invalid host with spaces!!!",
      sshPort: 999999, // Porta fuori range
      sshAuthMethod: "password",
      hostKeyVerification: { strictHostKeyChecking: true }, // Manca fingerprint o known_hosts
    });

    assert.strictEqual(result.outcome, "registrazione_rifiutata");
    assert(result.validationErrors, "Deve restituire un elenco di errori di validazione");
    assert(result.validationErrors["id"], "Errore su ID mancante");
    assert(result.validationErrors["displayName"], "Errore su displayName mancante");
    assert(result.validationErrors["remoteUsername"], "Errore su remoteUsername mancante");
    assert(result.validationErrors["host"], "Errore su host non valido");
    assert(result.validationErrors["password"], "Errore su password mancante per auth password");
    assert(result.validationErrors["hostKeyVerification"], "Errore su verifica chiave host incompleta");

    // Nessun effetto collaterale sul repository
    const list = await repo.list();
    assert.strictEqual(list.length, 0, "Nessun robot deve essere stato inserito nel DB");
    console.log("  PASS: CA-ROB-002 - Campi mancanti/non validi segnalati in blocco, nessun effetto collaterale.");
  }

  // =========================================================================
  // CA-ROB-003: Modalità rigorosa vs differita
  // =========================================================================
  {
    // Caso 3a: Modalità rigorosa -> fallimento SSH respinge la registrazione
    const { service: strictService, repo: strictRepo } = createService({ registrationMode: "rigorosa" });
    const strictResult = await strictService.registerRobot(adminUser, {
      id: "robot-strict-fail",
      displayName: "Robot Strict Test",
      remoteUsername: "moliris_op",
      host: "127.0.0.1",
      sshPort: testServerPort,
      sshAuthMethod: "password",
      password: "WRONG_PASSWORD_FAIL",
      hostKeyVerification: {
        fingerprint: serverFingerprintInfo.sha256Hex,
        strictHostKeyChecking: true,
      },
    });

    assert.strictEqual(strictResult.outcome, "ssh_non_verificata");
    assert.strictEqual(strictResult.robot, undefined, "In modalità rigorosa non deve registrare il robot");
    const strictCheck = await strictRepo.findById("robot-strict-fail");
    assert.strictEqual(strictCheck, null, "Robot non registrato a DB in modalità rigorosa con SSH fallito");

    // Caso 3b: Modalità differita -> registra il robot con stato esplicito 'ssh_non_verificata'
    const { service: deferredService, repo: deferredRepo } = createService({ registrationMode: "differita" });
    const deferredResult = await deferredService.registerRobot(adminUser, {
      id: "robot-deferred-ok",
      displayName: "Robot Deferred Test",
      remoteUsername: "moliris_op_def",
      host: "127.0.0.1",
      sshPort: testServerPort,
      sshAuthMethod: "password",
      password: "WRONG_PASSWORD_FAIL", // Fallirà la verifica iniziale
      hostKeyVerification: {
        fingerprint: serverFingerprintInfo.sha256Hex,
        strictHostKeyChecking: true,
      },
    });

    assert.strictEqual(deferredResult.outcome, "ssh_non_verificata");
    assert(deferredResult.robot, "In modalità differita il robot deve essere registrato");
    assert.strictEqual(deferredResult.robot.connectionState, "non_raggiungibile");
    assert.strictEqual(deferredResult.robot.registrationState, "ssh_non_verificata");

    // Funzionalità operative non disponibili se connessione non verificata (RF-ROB-011)
    assert.strictEqual(deferredResult.availableFeatures?.terminal, false);
    assert.strictEqual(deferredResult.availableFeatures?.monitoring, false);
    assert.strictEqual(deferredResult.availableFeatures?.remoteFs, false);
    // Ma il filesystem server è comunque disponibile se l'utente ha il permesso
    assert.strictEqual(deferredResult.availableFeatures?.serverFs, true);

    console.log("  PASS: CA-ROB-003 - Rispetto rigoroso modalità rigorosa vs differita (§8.1).");
  }

  // =========================================================================
  // CA-ROB-004: Directory creata con nome = <username>_<id> dentro la root configurata
  // =========================================================================
  {
    const { service } = createService();
    const result = await service.registerRobot(adminUser, {
      id: "robot-dir-01",
      displayName: "Robot Dir Test",
      remoteUsername: "robot_dir_user",
      host: "127.0.0.1",
      sshPort: testServerPort,
      sshAuthMethod: "password",
      password: "ValidPass123!",
      hostKeyVerification: {
        fingerprint: serverFingerprintInfo.sha256Hex,
        strictHostKeyChecking: true,
      },
    });

    assert.strictEqual(result.outcome, "registrazione_completata");
    const expectedDir = path.join(testFsRoot, "robot_dir_user_robot-dir-01");
    assert(fs.existsSync(expectedDir), `Directory ${expectedDir} deve essere stata creata sul filesystem`);

    // Sottodirectory standard create (logs, configs, backups)
    assert(fs.existsSync(path.join(expectedDir, "logs")));
    assert(fs.existsSync(path.join(expectedDir, "configs")));
    assert(fs.existsSync(path.join(expectedDir, "backups")));
    console.log("  PASS: CA-ROB-004 - Directory creata con nome = <username>_<id> e sottodirectory standard (RF-ROB-008).");
  }

  // =========================================================================
  // CA-ROB-005: File di altri robot intatti; directory esistente non sovrascritta
  // =========================================================================
  {
    // Creiamo una directory esistente con file preesistente
    const existingDir = path.join(testFsRoot, "existing_user_robot-existing-01");
    fs.mkdirSync(existingDir, { recursive: true });
    fs.writeFileSync(path.join(existingDir, "precious_data.txt"), "IMMUTABLE DATA");

    // Modalità accetta directory esistente
    const { service } = createService({ existingDirectoryPolicy: "accetta" });
    const result = await service.registerRobot(adminUser, {
      id: "robot-existing-01",
      displayName: "Robot Existing Dir",
      remoteUsername: "existing_user",
      host: "127.0.0.1",
      sshPort: testServerPort,
      sshAuthMethod: "password",
      password: "ValidPass123!",
      hostKeyVerification: {
        fingerprint: serverFingerprintInfo.sha256Hex,
        strictHostKeyChecking: true,
      },
    });

    assert.strictEqual(result.outcome, "registrazione_completata");
    const fileContent = fs.readFileSync(path.join(existingDir, "precious_data.txt"), "utf8");
    assert.strictEqual(fileContent, "IMMUTABLE DATA", "I file preesistenti non devono MAI essere toccati o svuotati");
    console.log("  PASS: CA-ROB-005 - Preservazione totale file preesistenti su directory già esistente (RF-SRVFS-006).");
  }

  // =========================================================================
  // CA-ROB-006: Identificativo e username duplicati rifiutati
  // =========================================================================
  {
    const { service } = createService();
    // Primo robot ok
    await service.registerRobot(adminUser, {
      id: "robot-dup-01",
      displayName: "Robot Dup 1",
      remoteUsername: "dup_user",
      host: "127.0.0.1",
      sshPort: testServerPort,
      sshAuthMethod: "password",
      password: "ValidPass123!",
      hostKeyVerification: {
        fingerprint: serverFingerprintInfo.sha256Hex,
        strictHostKeyChecking: true,
      },
    });

    // Tentativo con stesso ID
    const resDupId = await service.registerRobot(adminUser, {
      id: "robot-dup-01",
      displayName: "Robot Dup 2",
      remoteUsername: "other_user",
      host: "127.0.0.1",
      sshPort: testServerPort,
      sshAuthMethod: "password",
      password: "ValidPass123!",
      hostKeyVerification: {
        fingerprint: serverFingerprintInfo.sha256Hex,
        strictHostKeyChecking: true,
      },
    });
    assert.strictEqual(resDupId.outcome, "registrazione_rifiutata");
    assert(resDupId.validationErrors?.id, "ID duplicato deve essere rifiutato");

    // Tentativo con stesso Username sullo stesso host e porta
    const resDupUser = await service.registerRobot(adminUser, {
      id: "robot-dup-02",
      displayName: "Robot Dup 3",
      remoteUsername: "dup_user",
      host: "127.0.0.1",
      sshPort: testServerPort,
      sshAuthMethod: "password",
      password: "ValidPass123!",
      hostKeyVerification: {
        fingerprint: serverFingerprintInfo.sha256Hex,
        strictHostKeyChecking: true,
      },
    });
    assert.strictEqual(resDupUser.outcome, "registrazione_rifiutata");
    assert(resDupUser.validationErrors?.remoteUsername, "Username duplicato sullo stesso host deve essere rifiutato");

    console.log("  PASS: CA-ROB-006 - Unicità di identificativo e username remoto garantita (RF-ROB-006).");
  }

  // =========================================================================
  // CA-ROB-007: Directory non creabile -> Errore, nessun successo dichiarato
  // =========================================================================
  {
    const unwritableRoot = path.join(testFsRoot, "unwritable_root");
    fs.mkdirSync(unwritableRoot, { mode: 0o555 }); // Sola lettura

    const { service } = createService({ serverFilesystemRoot: unwritableRoot });
    const res = await service.registerRobot(adminUser, {
      id: "robot-fail-dir",
      displayName: "Robot Unwritable Dir",
      remoteUsername: "unwritable_user",
      host: "127.0.0.1",
      sshPort: testServerPort,
      sshAuthMethod: "password",
      password: "ValidPass123!",
      hostKeyVerification: {
        fingerprint: serverFingerprintInfo.sha256Hex,
        strictHostKeyChecking: true,
      },
    });

    assert.strictEqual(res.outcome, "creazione_directory_fallita");
    fs.chmodSync(unwritableRoot, 0o777); // Ripristino permessi per pulizia
    console.log("  PASS: CA-ROB-007 - Directory non creabile gestita con fallimento esplicito, nessun successo.");
  }

  // =========================================================================
  // CA-ROB-008: Errore DB dopo creazione directory -> Rollback reversibile o stato incompleto
  // =========================================================================
  {
    // Creiamo un repository che fallisce sul metodo create
    const repoFaulty = new InMemoryRobotRepository();
    repoFaulty.create = async () => {
      throw new Error("Simulated Database I/O Fault");
    };

    const { service } = createService({}, repoFaulty);
    const targetDir = path.join(testFsRoot, "rollback_test_user_robot-rollback-01");

    // Il salvataggio deve lanciare DB_PERSISTENCE_ERROR e la cartella creata deve essere stata rimossa
    await assert.rejects(
      async () => await service.registerRobot(adminUser, {
        id: "robot-rollback-01",
        displayName: "Robot Rollback Test",
        remoteUsername: "rollback_test_user",
        host: "127.0.0.1",
        sshPort: testServerPort,
        sshAuthMethod: "password",
        password: "ValidPass123!",
        hostKeyVerification: {
          fingerprint: serverFingerprintInfo.sha256Hex,
          strictHostKeyChecking: true,
        },
      }),
      (err: any) => {
        assert(err instanceof MolirisAppError);
        assert.strictEqual(err.code, ErrorCode.DB_PERSISTENCE_ERROR);
        return true;
      }
    );

    // Verifica che la directory creata sia stata rimossa in rollback
    assert.strictEqual(fs.existsSync(targetDir), false, "La directory deve essere stata rimossa dal rollback selettivo");
    console.log("  PASS: CA-ROB-008 - Rollback automatico a zero perdite dati in caso di guasto DB post-creazione directory.");
  }

  // =========================================================================
  // CA-ROB-009: Rifiuto categorico di path traversal e percorsi non autorizzati
  // =========================================================================
  {
    const { service } = createService();
    const resTraversal = await service.registerRobot(adminUser, {
      id: "robot-traversal",
      displayName: "Robot Traversal",
      remoteUsername: "traversal_user",
      host: "127.0.0.1",
      sshPort: testServerPort,
      sshAuthMethod: "password",
      password: "ValidPass123!",
      hostKeyVerification: {
        fingerprint: serverFingerprintInfo.sha256Hex,
        strictHostKeyChecking: true,
      },
      remoteMonitoringPath: "/etc/../../passwd", // Path traversal
    });

    assert.strictEqual(resTraversal.outcome, "registrazione_rifiutata");
    assert(resTraversal.validationErrors?.remoteMonitoringPath, "Path traversal deve essere bloccato");
    console.log("  PASS: CA-ROB-009 - Path traversal e percorsi non conformi categoricamente respinti (CA-ROB-009).");
  }

  // =========================================================================
  // CA-ROB-010: Visibilità in flotta e disponibilità funzioni post-registrazione
  // =========================================================================
  {
    const { service } = createService();
    await service.registerRobot(adminUser, {
      id: "robot-feat-01",
      displayName: "Robot Features Test",
      remoteUsername: "feat_user",
      host: "127.0.0.1",
      sshPort: testServerPort,
      sshAuthMethod: "password",
      password: "ValidPass123!",
      hostKeyVerification: {
        fingerprint: serverFingerprintInfo.sha256Hex,
        strictHostKeyChecking: true,
      },
    });

    const fleet = await service.listFleet(adminUser);
    const found = fleet.find(r => r.id === "robot-feat-01");
    assert(found, "Il robot deve comparire nella lista flotta");
    assert.strictEqual(found.connectionState, "raggiungibile");
    assert.strictEqual(found.operationalState, null, "Stato operativo non ancora disponibile = null (RF-MON-005)");

    const detail = await service.getRobotDetail(adminUser, "robot-feat-01");
    assert.strictEqual(detail.availableFeatures.monitoring, true);
    assert.strictEqual(detail.availableFeatures.terminal, true);
    assert.strictEqual(detail.availableFeatures.remoteFs, true);
    assert.strictEqual(detail.availableFeatures.serverFs, true);
    assert.strictEqual(detail.availableFeatures.transfers, true);
    console.log("  PASS: CA-ROB-010 - Robot visibile in flotta con funzioni autorizzate attive (RF-ROB-011).");
  }

  // =========================================================================
  // CA-ROB-011: Disabilitazione e rimozione preservano directory e file
  // =========================================================================
  {
    const { service, repo, connMgr } = createService();
    await service.registerRobot(adminUser, {
      id: "robot-remove-01",
      displayName: "Robot To Remove",
      remoteUsername: "remove_user",
      host: "127.0.0.1",
      sshPort: testServerPort,
      sshAuthMethod: "password",
      password: "ValidPass123!",
      hostKeyVerification: {
        fingerprint: serverFingerprintInfo.sha256Hex,
        strictHostKeyChecking: true,
      },
    });

    const robotDir = path.join(testFsRoot, "remove_user_robot-remove-01");
    fs.writeFileSync(path.join(robotDir, "logs", "session_log.txt"), "DO NOT DELETE ME");

    // 1. Disabilitazione
    const disabled = await service.disableRobot(adminUser, "robot-remove-01");
    assert.strictEqual(disabled.anagraphicState, "disabilitato");

    // Verifica blocco connessioni su robot disabilitato
    const robotEntity = (await repo.findById("robot-remove-01"))!;
    await assert.rejects(
      async () => await connMgr.acquireConnection("admin_01", robotEntity),
      (err: any) => err instanceof MolirisAppError && err.code === ErrorCode.INSUFFICIENT_PERMISSIONS
    );

    // Nella lista flotta, il robot compare con stato 'disabilitato'
    const listWithDisabled = await service.listFleet(adminUser);
    const disabledInList = listWithDisabled.find(r => r.id === "robot-remove-01");
    assert(disabledInList, "Robot disabilitato deve comparire nella lista flotta");
    assert.strictEqual(disabledInList.anagraphicState, "disabilitato");

    // 2. Rimozione dall'anagrafica attiva (richiede conferma)
    await assert.rejects(
      async () => await service.removeRobot(adminUser, "robot-remove-01", false),
      (err: any) => err instanceof MolirisAppError && err.code === ErrorCode.MISSING_ROBOT_PARAMS
    );

    await service.removeRobot(adminUser, "robot-remove-01", true);

    // Robot rimosso NON compare nella lista attiva (RF-ROB-014, CA-ROB-012)
    const listAfterRemoval = await service.listFleet(adminUser);
    assert.strictEqual(listAfterRemoval.some(r => r.id === "robot-remove-01"), false);

    // Directory e file rimangono intatti sul server (RF-ROB-013, CA-ROB-011)
    assert(fs.existsSync(robotDir), "La directory server del robot rimosso non deve essere cancellata");
    assert(fs.existsSync(path.join(robotDir, "logs", "session_log.txt")), "I file server devono essere preservati");

    console.log("  PASS: CA-ROB-011 - Disabilitazione blocca connessioni; rimozione preserva intatti file e cartelle.");
  }

  // =========================================================================
  // CA-ROB-012: Robot irraggiungibile resta in lista con stato appropriato
  // =========================================================================
  {
    const { service } = createService({ registrationMode: "differita" });
    await service.registerRobot(adminUser, {
      id: "robot-unreach-01",
      displayName: "Robot Irraggiungibile",
      remoteUsername: "unreach_user",
      host: "192.0.2.1", // Non instradabile
      sshPort: 22,
      sshAuthMethod: "password",
      password: "ValidPass123!",
      hostKeyVerification: {
        fingerprint: serverFingerprintInfo.sha256Hex,
        strictHostKeyChecking: true,
      },
    });

    const fleet = await service.listFleet(adminUser);
    const unreach = fleet.find(r => r.id === "robot-unreach-01");
    assert(unreach, "Robot irraggiungibile deve comparire nella lista (RF-ROB-014, CA-ROB-012)");
    assert.strictEqual(unreach.connectionState, "non_raggiungibile");
    assert.strictEqual(unreach.anagraphicState, "attivo");
    console.log("  PASS: CA-ROB-012 - Robot irraggiungibile compare in lista con stato di connessione appropriato.");
  }

  // =========================================================================
  // Test autorizzazioni per robot (CA-SSH-005, RF-AUTH-005) e modifica configurazione
  // =========================================================================
  {
    const { service } = createService();
    await service.registerRobot(adminUser, {
      id: "robot-ammesso",
      displayName: "Robot Ammesso",
      remoteUsername: "ammesso_user",
      host: "127.0.0.1",
      sshPort: testServerPort,
      sshAuthMethod: "password",
      password: "ValidPass123!",
      hostKeyVerification: {
        fingerprint: serverFingerprintInfo.sha256Hex,
        strictHostKeyChecking: true,
      },
    });

    await service.registerRobot(adminUser, {
      id: "robot-negato",
      displayName: "Robot Negato",
      remoteUsername: "negato_user",
      host: "127.0.0.1",
      sshPort: testServerPort,
      sshAuthMethod: "password",
      password: "ValidPass123!",
      hostKeyVerification: {
        fingerprint: serverFingerprintInfo.sha256Hex,
        strictHostKeyChecking: true,
      },
    });

    // L'utente operatore_limitato ha permesso FLEET_VIEW solo su 'robot-ammesso'
    const restrictedList = await service.listFleet(opRestrictedUser);
    assert.strictEqual(restrictedList.length, 1);
    assert.strictEqual(restrictedList[0].id, "robot-ammesso");

    // Tentativo di visualizzare robot-negato negato
    await assert.rejects(
      async () => await service.getRobotDetail(opRestrictedUser, "robot-negato"),
      (err: any) => err instanceof MolirisAppError && err.code === ErrorCode.INSUFFICIENT_PERMISSIONS
    );

    // Modifica configurazione (Step 9): cambio porta o credenziali riporta lo stato a 'non_verificato' (§8.3)
    const updated = await service.updateConfiguration(adminUser, "robot-ammesso", {
      sshPort: 2222, // Porta cambiata
    });
    assert.strictEqual(updated.sshPort, 2222);
    assert.strictEqual(updated.connectionState, "non_verificato", "Cambio porta deve resettare connectionState a non_verificato (§8.3)");

    console.log("  PASS: Valutazione permessi per robot e aggiornamento configurazione (§8.3) verificati.");
  }

  // =========================================================================
  // Test Ripeti Verifica Connessione e Riparazione (Step 5 e 6)
  // =========================================================================
  {
    const { service } = createService({ registrationMode: "differita" });
    await service.registerRobot(adminUser, {
      id: "robot-reverify-01",
      displayName: "Robot Re-Verify",
      remoteUsername: "reverif_user",
      host: "127.0.0.1",
      sshPort: testServerPort,
      sshAuthMethod: "password",
      password: "WrongPasswordInitially",
      hostKeyVerification: {
        fingerprint: serverFingerprintInfo.sha256Hex,
        strictHostKeyChecking: true,
      },
    });

    // Inizialmente 'ssh_non_verificata'
    let detail = await service.getRobotDetail(adminUser, "robot-reverify-01");
    assert.strictEqual(detail.robot.registrationState, "ssh_non_verificata");

    // Aggiorniamo con la password corretta
    await service.updateConfiguration(adminUser, "robot-reverify-01", {
      password: "ValidPass123!",
    });

    // Eseguiamo 'verifyConnection'
    const reverifResult = await service.verifyConnection(adminUser, "robot-reverify-01");
    assert.strictEqual(reverifResult.success, true);
    assert.strictEqual(reverifResult.connectionState, "raggiungibile");
    assert.strictEqual(reverifResult.registrationState, "registrazione_completata");

    detail = await service.getRobotDetail(adminUser, "robot-reverify-01");
    assert.strictEqual(detail.robot.registrationState, "registrazione_completata");
    assert.strictEqual(detail.availableFeatures.terminal, true);

    console.log("  PASS: Ripeti verifica connessione e promozione da differita a completata verificati.");
  }

  // =========================================================================
  // RF-05: Associazione dati Cliente e Impianto
  // =========================================================================
  {
    console.log("--> Esecuzione test suite RF-05 (Associazione Cliente e Impianto)...");
    const clientRepo = new InMemoryClientRepository();
    const plantRepo = new InMemoryPlantRepository();
    const repo = new InMemoryRobotRepository();
    const { service } = createService({ registrationMode: "differita" }, repo, clientRepo, plantRepo);

    // 1. Creazione di un robot con Nome Cliente e Nome Impianto
    const regResult = await service.registerRobot(adminUser, {
      id: "robot-rf05-01",
      displayName: "Robot Verniciatura 1",
      remoteUsername: "op_paint_1",
      host: "127.0.0.1",
      sshPort: testServerPort,
      sshAuthMethod: "password",
      password: "ValidPass123!",
      hostKeyVerification: {
        fingerprint: serverFingerprintInfo.sha256Hex,
        strictHostKeyChecking: true,
      },
      customerName: "Ferrari S.p.A.",
      plantName: "Maranello Verniciatura",
    });

    assert.ok(regResult.robot, "Il robot deve essere restituito dopo la registrazione");
    assert.strictEqual(regResult.robot?.customerName, "Ferrari S.p.A.", "customerName deve coincidere");
    assert.strictEqual(regResult.robot?.plantName, "Maranello Verniciatura", "plantName deve coincidere");
    assert.ok(regResult.robot?.clientId?.startsWith("cli_"), "clientId deve essere generato");
    assert.ok(regResult.robot?.plantId?.startsWith("plant_"), "plantId deve essere generato");

    // Verifica entità collegate nei rispettivi repository
    const savedClient = await clientRepo.findByName("Ferrari S.p.A.");
    assert.ok(savedClient, "L'entità cliente deve esistere nella collezione clients");
    assert.strictEqual(savedClient.id, regResult.robot?.clientId);

    const savedPlant = await plantRepo.findByNameAndClient(savedClient.id, "Maranello Verniciatura");
    assert.ok(savedPlant, "L'entità impianto deve esistere nella collezione plants collegata al cliente");
    assert.strictEqual(savedPlant.id, regResult.robot?.plantId);
    assert.strictEqual(savedPlant.clientId, savedClient.id);

    // 2. Modifica dei due dati
    const updated = await service.updateConfiguration(adminUser, "robot-rf05-01", {
      customerName: "Ferrari Corse",
      plantName: "Maranello Reparto Corse",
    });
    assert.strictEqual(updated.customerName, "Ferrari Corse", "customerName aggiornato");
    assert.strictEqual(updated.plantName, "Maranello Reparto Corse", "plantName aggiornato");

    const updatedClient = await clientRepo.findByName("Ferrari Corse");
    assert.ok(updatedClient, "Nuova anagrafica cliente creata o associata");
    assert.strictEqual(updated.clientId, updatedClient.id);

    // 3. Salvataggio e recupero dal database
    const fetchedDetail = await service.getRobotDetail(adminUser, "robot-rf05-01");
    assert.strictEqual(fetchedDetail.robot.customerName, "Ferrari Corse");
    assert.strictEqual(fetchedDetail.robot.plantName, "Maranello Reparto Corse");
    assert.strictEqual(fetchedDetail.robot.clientId, updatedClient.id);

    const fleetList = await service.listFleet(adminUser);
    const summaryRobot = fleetList.find(r => r.id === "robot-rf05-01");
    assert.ok(summaryRobot, "Robot presente nella lista flotta");
    assert.strictEqual(summaryRobot.customerName, "Ferrari Corse");
    assert.strictEqual(summaryRobot.plantName, "Maranello Reparto Corse");

    // 4. Gestione dei campi mancanti o non validi
    // 4a. Campi mancanti durante creazione -> campi undefined / non valorizzati
    const robotNoClient = await service.registerRobot(adminUser, {
      id: "robot-rf05-no-client",
      displayName: "Robot Senza Cliente",
      remoteUsername: "op_no_cli",
      host: "127.0.0.1",
      sshPort: testServerPort,
      sshAuthMethod: "password",
      password: "ValidPass123!",
      hostKeyVerification: {
        fingerprint: serverFingerprintInfo.sha256Hex,
        strictHostKeyChecking: true,
      },
    });
    assert.strictEqual(robotNoClient.robot?.customerName, undefined);
    assert.strictEqual(robotNoClient.robot?.plantName, undefined);

    // 4b. Validazione campi non validi (null byte, tipo non stringa, lunghezza eccessiva)
    const valResult1 = await service.validateRegistrationInput({
      id: "robot-val-err",
      displayName: "Robot Err",
      remoteUsername: "op_val_err",
      host: "127.0.0.1",
      sshAuthMethod: "password",
      hostKeyVerification: { strictHostKeyChecking: true, fingerprint: serverFingerprintInfo.sha256Hex },
      customerName: "Cliente Con NullByte\0",
    });
    assert.strictEqual(valResult1.valid, false);
    assert.ok(valResult1.errors["customerName"]?.includes("caratteri non validi"));

    const valResult2 = await service.validateRegistrationInput({
      id: "robot-val-err2",
      displayName: "Robot Err",
      remoteUsername: "op_val_err2",
      host: "127.0.0.1",
      sshAuthMethod: "password",
      hostKeyVerification: { strictHostKeyChecking: true, fingerprint: serverFingerprintInfo.sha256Hex },
      plantName: "A".repeat(101),
    });
    assert.strictEqual(valResult2.valid, false);
    assert.ok(valResult2.errors["plantName"]?.includes("100 caratteri"));

    // 5. Compatibilità con i robot già esistenti (senza campi cliente/impianto)
    await repo.create({
      id: "robot-legacy-01",
      displayName: "Robot Legacy",
      remoteUsername: "op_legacy",
      serverDirectoryPath: path.join(testFsRoot, "op_legacy"),
      host: "127.0.0.1",
      sshPort: 22,
      sshAuthMethod: "password",
      credentialReference: "vault://creds/legacy",
      hostKeyVerification: { strictHostKeyChecking: true, fingerprint: serverFingerprintInfo.sha256Hex },
      stateFilePaths: ["/status.txt"],
      anagraphicState: "attivo",
      connectionState: "raggiungibile",
      operationalState: null,
      lastValidUpdateAt: null,
      lastAttemptOutcome: null,
      registrationState: "registrazione_completata",
      lastConnectionVerification: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const legacyDetail = await service.getRobotDetail(adminUser, "robot-legacy-01");
    assert.strictEqual(legacyDetail.robot.customerName, undefined);
    assert.strictEqual(legacyDetail.robot.plantName, undefined);

    const legacySummary = (await service.listFleet(adminUser)).find(r => r.id === "robot-legacy-01");
    assert.strictEqual(legacySummary?.customerName, undefined);
    assert.strictEqual(legacySummary?.plantName, undefined);

    // Possibilità di aggiornare un robot legacy aggiungendo Cliente e Impianto
    const updatedLegacy = await service.updateConfiguration(adminUser, "robot-legacy-01", {
      customerName: "Cliente Aggiunto",
      plantName: "Impianto Aggiunto",
    });
    assert.strictEqual(updatedLegacy.customerName, "Cliente Aggiunto");
    assert.strictEqual(updatedLegacy.plantName, "Impianto Aggiunto");

    // 6. Rimozione/Svuotamento dei dati cliente e impianto durante modifica
    const clearedLegacy = await service.updateConfiguration(adminUser, "robot-legacy-01", {
      customerName: "",
      plantName: "",
    });
    assert.strictEqual(clearedLegacy.customerName, undefined);
    assert.strictEqual(clearedLegacy.plantName, undefined);

    // 7. Persistenza dei dati dopo il riavvio del backend (simulato riutilizzando il repository esistente)
    const { service: restartedService } = createService({ registrationMode: "differita" }, repo, clientRepo, plantRepo);
    const postRestartDetail = await restartedService.getRobotDetail(adminUser, "robot-rf05-01");
    assert.strictEqual(postRestartDetail.robot.customerName, "Ferrari Corse");
    assert.strictEqual(postRestartDetail.robot.plantName, "Maranello Reparto Corse");
    assert.strictEqual(postRestartDetail.robot.clientId, updatedClient.id);

    console.log("  PASS: Requisito RF-05 pienamente verificato (Creazione, Modifica, DB, Compatibilità, Persistenza).");
  }

  // =========================================================================
  // PROBLEMA 3 – TEST SUITE: SINCRONIZZAZIONE CLIENTI E IMPIANTI MOLIRIS
  // =========================================================================
  {
    console.log("\n--> Collaudo Problema 3: Sincronizzazione atomica/idempotente Clienti e Impianti...");

    const repo = new InMemoryRobotRepository();
    const clientRepo = new InMemoryClientRepository();
    const plantRepo = new InMemoryPlantRepository();
    const auditRepo = new InMemoryAuditRepository();
    const { service } = createService({ registrationMode: "differita" }, repo, clientRepo, plantRepo, auditRepo);

    // Setup iniziale: 1 Cliente con 2 Impianti, e 3 Robot
    const c1 = await clientRepo.create({
      id: "cli_sync_01",
      name: "Acme Robotics",
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const p1 = await plantRepo.create({
      id: "plant_sync_01",
      clientId: c1.id,
      name: "Stabilimento Nord",
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const p2 = await plantRepo.create({
      id: "plant_sync_02",
      clientId: c1.id,
      name: "Stabilimento Sud",
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Robot 1: Acme Robotics / Stabilimento Nord
    await repo.create({
      id: "robot-sync-01",
      displayName: "Robot Nord 1",
      remoteUsername: "bot_nord_1",
      serverDirectoryPath: path.join(testFsRoot, "bot_nord_1"),
      host: "127.0.0.1",
      sshPort: 22,
      sshAuthMethod: "password",
      credentialReference: "vault://creds/1",
      stateFilePaths: ["/status.txt"],
      anagraphicState: "attivo",
      connectionState: "non_verificato",
      operationalState: null,
      lastValidUpdateAt: null,
      lastAttemptOutcome: null,
      registrationState: "registrazione_completata",
      lastConnectionVerification: null,
      clientId: c1.id,
      clientName: c1.name,
      customerName: c1.name,
      plantId: p1.id,
      plantName: p1.name,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Robot 2: Acme Robotics / Stabilimento Nord
    await repo.create({
      id: "robot-sync-02",
      displayName: "Robot Nord 2",
      remoteUsername: "bot_nord_2",
      serverDirectoryPath: path.join(testFsRoot, "bot_nord_2"),
      host: "127.0.0.1",
      sshPort: 22,
      sshAuthMethod: "password",
      credentialReference: "vault://creds/2",
      stateFilePaths: ["/status.txt"],
      anagraphicState: "attivo",
      connectionState: "non_verificato",
      operationalState: null,
      lastValidUpdateAt: null,
      lastAttemptOutcome: null,
      registrationState: "registrazione_completata",
      lastConnectionVerification: null,
      clientId: c1.id,
      clientName: c1.name,
      customerName: c1.name,
      plantId: p1.id,
      plantName: p1.name,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Robot 3: Acme Robotics / Stabilimento Sud
    await repo.create({
      id: "robot-sync-03",
      displayName: "Robot Sud 1",
      remoteUsername: "bot_sud_1",
      serverDirectoryPath: path.join(testFsRoot, "bot_sud_1"),
      host: "127.0.0.1",
      sshPort: 22,
      sshAuthMethod: "password",
      credentialReference: "vault://creds/3",
      stateFilePaths: ["/status.txt"],
      anagraphicState: "attivo",
      connectionState: "non_verificato",
      operationalState: null,
      lastValidUpdateAt: null,
      lastAttemptOutcome: null,
      registrationState: "registrazione_completata",
      lastConnectionVerification: null,
      clientId: c1.id,
      clientName: c1.name,
      customerName: c1.name,
      plantId: p2.id,
      plantName: p2.name,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Scenario 1: Rinomina cliente propaga a tutti i robot associati (clientName e customerName)
    console.log("  Scenario 1: Rinomina cliente propaga a tutti i robot associati");
    const updatedClient = await service.updateClientName(adminUser, c1.id, "Acme Corporation SpA");
    assert.strictEqual(updatedClient.name, "Acme Corporation SpA");
    assert.strictEqual(updatedClient.version, 2);

    const r1 = await repo.findById("robot-sync-01");
    const r2 = await repo.findById("robot-sync-02");
    const r3 = await repo.findById("robot-sync-03");

    assert.strictEqual(r1?.clientName, "Acme Corporation SpA");
    assert.strictEqual(r1?.customerName, "Acme Corporation SpA");
    assert.strictEqual(r2?.clientName, "Acme Corporation SpA");
    assert.strictEqual(r2?.customerName, "Acme Corporation SpA");
    assert.strictEqual(r3?.clientName, "Acme Corporation SpA");
    assert.strictEqual(r3?.customerName, "Acme Corporation SpA");
    // ID cliente e impianto rimangono tassativamente intatti
    assert.strictEqual(r1?.clientId, c1.id);
    assert.strictEqual(r2?.clientId, c1.id);
    assert.strictEqual(r3?.clientId, c1.id);

    // Scenario 2: Rinomina impianto propaga ai soli robot dell'impianto interessato
    console.log("  Scenario 2: Rinomina impianto propaga ai robot associati");
    const updatedPlant = await service.updatePlantName(adminUser, p1.id, "Stabilimento Nord Avanzato");
    assert.strictEqual(updatedPlant.name, "Stabilimento Nord Avanzato");
    assert.strictEqual(updatedPlant.version, 2);

    const r1AfterPlant = await repo.findById("robot-sync-01");
    const r2AfterPlant = await repo.findById("robot-sync-02");
    const r3AfterPlant = await repo.findById("robot-sync-03");

    assert.strictEqual(r1AfterPlant?.plantName, "Stabilimento Nord Avanzato");
    assert.strictEqual(r2AfterPlant?.plantName, "Stabilimento Nord Avanzato");
    // Robot 3 apparteneva a p2 e non deve essere modificato nel plantName
    assert.strictEqual(r3AfterPlant?.plantName, "Stabilimento Sud");
    assert.strictEqual(r1AfterPlant?.plantId, p1.id);
    assert.strictEqual(r2AfterPlant?.plantId, p1.id);
    assert.strictEqual(r3AfterPlant?.plantId, p2.id);

    // Scenario 3: Due rinomine concorrenti dello stesso cliente (gestione lock / serializzazione)
    console.log("  Scenario 3: Rinomine concorrenti dello stesso cliente");
    const pClientA = service.updateClientName(adminUser, c1.id, "Acme Nome A");
    const pClientB = service.updateClientName(adminUser, c1.id, "Acme Nome B");
    const clientResults = await Promise.allSettled([pClientA, pClientB]);
    const clientFulfilled = clientResults.filter(r => r.status === "fulfilled");
    const clientRejected = clientResults.filter(r => r.status === "rejected");
    // Il lock in-memory deve permettere a una di passare e all'altra di essere respinta in modo sicuro
    assert.strictEqual(clientFulfilled.length, 1);
    assert.strictEqual(clientRejected.length, 1);

    // Scenario 4: Due rinomine concorrenti dello stesso impianto (gestione lock / serializzazione)
    console.log("  Scenario 4: Rinomine concorrenti dello stesso impianto");
    const pPlantA = service.updatePlantName(adminUser, p1.id, "Nord Variant A");
    const pPlantB = service.updatePlantName(adminUser, p1.id, "Nord Variant B");
    const plantResults = await Promise.allSettled([pPlantA, pPlantB]);
    const plantFulfilled = plantResults.filter(r => r.status === "fulfilled");
    const plantRejected = plantResults.filter(r => r.status === "rejected");
    assert.strictEqual(plantFulfilled.length, 1);
    assert.strictEqual(plantRejected.length, 1);

    // Scenario 5: Errore durante propagazione ai robot e audit logging
    console.log("  Scenario 5: Gestione errore propagazione robot e audit");
    const failingRepo = new InMemoryRobotRepository();
    failingRepo.updateClientNameForRobots = async () => {
      throw new Error("Simulazione errore I/O robot repository");
    };
    const { service: failingService } = createService(
      { registrationMode: "differita" },
      failingRepo,
      clientRepo,
      plantRepo,
      auditRepo
    );

    let caughtError: any = null;
    try {
      await failingService.updateClientName(adminUser, c1.id, "Acme Name With Failing Repo");
    } catch (err: any) {
      caughtError = err;
    }
    assert.ok(caughtError, "Deve sollevare eccezione in caso di errore propagazione");
    assert.strictEqual(caughtError.code, ErrorCode.DB_PERSISTENCE_ERROR);

    const auditLogs = await auditRepo.query();
    const failureLog = auditLogs.find(
      l => l.operation === AuditOperation.ROBOT_UPDATE &&
           l.outcome === "FAILURE" &&
           l.details?.reason === "CLIENT_ROBOT_PROPAGATION_FAILED"
    );
    assert.ok(failureLog, "Deve registrare evento di audit con outcome FAILURE per mancata propagazione");

    // Scenario 6: Idempotenza della rinomina (ripetizione con stesso nome completa la propagazione)
    console.log("  Scenario 6: Idempotenza rinomina cliente");
    // Creiamo un robot disallineato manualmente per simulare stato post-interruzione
    await repo.create({
      id: "robot-sync-unpropagated",
      displayName: "Robot Non Propagato",
      remoteUsername: "bot_unprop",
      serverDirectoryPath: path.join(testFsRoot, "bot_unprop"),
      host: "127.0.0.1",
      sshPort: 22,
      sshAuthMethod: "password",
      credentialReference: "vault://creds/unprop",
      stateFilePaths: ["/status.txt"],
      anagraphicState: "attivo",
      connectionState: "non_verificato",
      operationalState: null,
      lastValidUpdateAt: null,
      lastAttemptOutcome: null,
      registrationState: "registrazione_completata",
      lastConnectionVerification: null,
      clientId: c1.id,
      clientName: "Vecchio Nome Obsoleto",
      customerName: "Vecchio Nome Obsoleto",
      plantId: p1.id,
      plantName: p1.name,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const currentClientDoc = await clientRepo.findById(c1.id);
    assert.ok(currentClientDoc);
    // Esecuzione con il medesimo nome già presente nel documento cliente
    await service.updateClientName(adminUser, c1.id, currentClientDoc.name);
    const completedRobot = await repo.findById("robot-sync-unpropagated");
    assert.strictEqual(completedRobot?.clientName, currentClientDoc.name);
    assert.strictEqual(completedRobot?.customerName, currentClientDoc.name);

    // Scenario 7: Protezione del controllo versione (OCC) contro aggiornamenti obsoleti
    console.log("  Scenario 7: Protezione versione OCC");
    let versionConflictCaught = false;
    try {
      // Tentativo di aggiornare con expectedVersion precedente (v1 quando il documento è già v3 o superiore)
      await clientRepo.updateName(c1.id, "Nome Conflittuale", 1);
    } catch (err: any) {
      versionConflictCaught = true;
      assert.strictEqual(err.code, ErrorCode.DB_PERSISTENCE_ERROR);
    }
    assert.ok(versionConflictCaught, "Deve bloccare aggiornamenti con expectedVersion disallineata");

    // Scenario 8: Riconciliazione robot disallineati (reconcileRobotEntityNames)
    console.log("  Scenario 8: Riconciliazione robot (reconcileRobotEntityNames)");
    // Disallineiamo un robot appositamente
    await repo.updateConfiguration("robot-sync-01", {
      clientName: "Disallineato Client",
      customerName: "Disallineato Customer",
      plantName: "Disallineato Plant",
    });

    const reconcileResult = await service.reconcileRobotEntityNames("robot-sync-01");
    assert.strictEqual(reconcileResult.examined, 1);
    assert.strictEqual(reconcileResult.reconciled, 1);

    const reconciledRobot = await repo.findById("robot-sync-01");
    const freshClient = await clientRepo.findById(c1.id);
    const freshPlant = await plantRepo.findById(p1.id);
    assert.strictEqual(reconciledRobot?.clientName, freshClient?.name);
    assert.strictEqual(reconciledRobot?.customerName, freshClient?.name);
    assert.strictEqual(reconciledRobot?.plantName, freshPlant?.name);

    // Scenario 9: Protezione delle relazioni (clientId e plantId immutabili)
    console.log("  Scenario 9: Immutabilità clientId e plantId");
    assert.strictEqual(reconciledRobot?.clientId, c1.id);
    assert.strictEqual(reconciledRobot?.plantId, p1.id);

    // Scenario 10: Compatibilità con record privi del campo version (legacy)
    console.log("  Scenario 10: Compatibilità record senza version");
    const legacyClient = await clientRepo.create({
      id: "cli_legacy_no_ver",
      name: "Legacy Client Senza Version",
      // version omessa intenzionalmente
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any);

    const updatedLegacyClient = await service.updateClientName(adminUser, legacyClient.id, "Legacy Client Ridenominato");
    assert.strictEqual(updatedLegacyClient.name, "Legacy Client Ridenominato");
    assert.strictEqual(updatedLegacyClient.version, 2);

    // Scenario 11: Verifica autorizzazioni e audit logging
    console.log("  Scenario 11: Verifica RBAC e audit");
    const unprivilegedUser: UserEntity = {
      id: "user-unprivileged",
      username: "viewer_user",
      roles: ["operatore"], // l'operatore non ha ROBOT_CONFIG_UPDATE per default
      enabled: true,
      passwordHash: "dummy",
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    let forbiddenCaught = false;
    try {
      await service.updateClientName(unprivilegedUser, c1.id, "Nuovo Nome Non Autorizzato");
    } catch (err: any) {
      forbiddenCaught = true;
      assert.strictEqual(err.code, ErrorCode.INSUFFICIENT_PERMISSIONS);
    }
    assert.ok(forbiddenCaught, "Utente senza ROBOT_CONFIG_UPDATE deve ricevere 403 / INSUFFICIENT_PERMISSIONS");

    console.log("  PASS: Tutti gli 11 scenari di test del Problema 3 superati con successo.");
  }

  console.log("PASS: Tutti i test di Gestione della Flotta superati con successo.");
} finally {
  testServer.close();
  // Pulizia directory temporanea
  try {
    fs.rmSync(testFsRoot, { recursive: true, force: true });
  } catch {}
}
