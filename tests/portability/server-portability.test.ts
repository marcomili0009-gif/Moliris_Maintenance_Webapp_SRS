// Requisiti verificati: RNF-SEC-006, RNF-FS-001..004, RNF-SEC-002, RNF-SEC-004, RF-ROB-008, RF-ROB-009, RBAC
// Suite TDD per la portabilità di Moliris Maintenance Webapp tra server diversi (cambio MOLIRIS_FS_ROOT, cambio host, ripristino DB)

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execSync } from "node:child_process";
import { InMemoryRobotRepository } from "../../storage/robot-repository.ts";
import { InMemoryAuditRepository } from "../../storage/audit-repository.ts";
import { ServerFilesystemService } from "../../storage/server-fs.ts";
import { type RobotEntity } from "../../storage/robot-models.ts";
import { MolirisLogger } from "../../logging/logger.ts";
import { type SystemConfiguration } from "../../config/configuration.ts";
import { FleetService } from "../../backend/fleet/fleet-service.ts";
import { InMemoryCredentialProvider } from "../../backend/connection/credential-provider.ts";
import { MongoCredentialProvider } from "../../backend/connection/mongo-credential-provider.ts";
import { DefaultHostKeyVerifier } from "../../backend/connection/host-key-verifier.ts";
import { DestinationValidator } from "../../backend/connection/connection-validator.ts";
import { RobotConnectionManager } from "../../backend/connection/robot-connection-manager.ts";
import { verifyRobotConnection } from "../../backend/connection/connection-verifier.ts";
import { RemoteRobotReader } from "../../backend/monitoring/robot-reader.ts";
import { MonitoringService } from "../../backend/monitoring/monitoring-service.ts";
import { MolirisStateFileParser } from "../../backend/monitoring/state-file-parser.ts";
import { DEFAULT_ROLE_PERMISSIONS } from "../../backend/auth/permissions.ts";
import { SessionManager, type AuthorizedContext } from "../../backend/auth/session-manager.ts";
import { InMemoryUserRepository } from "../../backend/auth/user-repository.ts";
import { type UserEntity } from "../../backend/auth/user-models.ts";
import { ErrorCode, MolirisAppError } from "../../errors/app-errors.ts";
import { createServer } from "../../backend/server.ts";
import { migrateRobotDirectories } from "../../scripts/migrate-robot-directories.ts";

console.log("--> Avvio test suite Portabilità Server & Diagnostica (TDD)...");

const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "moliris-portability-test-"));
const newFsRoot = path.join(tmpBase, "new-server-fs");
const oldFsRoot = path.join(tmpBase, "old-server-robots-nonexistent");
const tlsCertPath = path.join(tmpBase, "test-cert.pem");
const tlsKeyPath = path.join(tmpBase, "test-key.pem");
fs.mkdirSync(newFsRoot, { recursive: true });
execSync(
  `openssl req -x509 -newkey rsa:2048 -keyout "${tlsKeyPath}" -out "${tlsCertPath}" -days 1 -nodes -subj "/CN=localhost"`,
  { stdio: "pipe" }
);

const logger = new MolirisLogger();

function makeConfig(overrides: Partial<SystemConfiguration> = {}): SystemConfiguration {
  return {
    serverFilesystemRoot: newFsRoot,
    pollingIntervalSeconds: 60,
    sshConnectionTimeoutMs: 1000,
    maxConcurrentTransfersPerUser: 3,
    maxConcurrentTransfersPerRobot: 2,
    maxConcurrentTransfersServer: 10,
    tempFileRetentionMinutes: 60,
    stateFilePaths: ["/etc/moliris-state.json"],
    inactiveSessionTimeoutMinutes: 30,
    tlsCertPath,
    tlsKeyPath,
    registrationMode: "rigorosa",
    auditLogRetentionDays: 30,
    defaultSshPort: 22,
    standardSubdirectories: ["upload", "download", "shared", "logs", "configs", "backups"],
    serverDirectoryPermissions: "0750",
    existingDirectoryPolicy: "accetta",
    allowedDestinations: ["192.168.10.10"],
    ...overrides,
  };
}

const adminUser: UserEntity = {
  id: "u-admin",
  username: "admin",
  passwordHash: "hash",
  roles: ["admin"],
  enabled: true,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const operatorUser: UserEntity = {
  id: "u-op",
  username: "operatore1",
  passwordHash: "hash",
  roles: ["operatore"],
  enabled: true,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function makeAdminContext(robotId?: string): AuthorizedContext {
  return {
    sessionId: "sess-admin",
    userId: adminUser.id,
    username: adminUser.username,
    roles: ["admin"],
    permissions: new Set(DEFAULT_ROLE_PERMISSIONS.admin),
    targetRobotId: robotId,
  };
}

function makeRobot(id: string, overrides: Partial<RobotEntity> = {}): RobotEntity {
  const username = overrides.remoteUsername || "robot";
  return {
    id,
    displayName: overrides.displayName || `Robot ${id}`,
    remoteUsername: username,
    host: overrides.host || "192.168.10.10",
    sshPort: overrides.sshPort ?? 22,
    sshAuthMethod: overrides.sshAuthMethod || "password",
    credentialReference: overrides.credentialReference || `vault://robots/${id}`,
    hostKeyVerification: {
      fingerprint: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      strictHostKeyChecking: true,
    },
    stateFilePaths: ["/etc/moliris-state.json"],
    serverDirectoryPath: overrides.serverDirectoryPath || path.join(oldFsRoot, `${username}_${id}`),
    anagraphicState: "attivo",
    connectionState: "non_verificato",
    operationalState: null,
    lastValidUpdateAt: null,
    lastAttemptOutcome: null,
    registrationState: "registrazione_completata",
    lastConnectionVerification: null,
    customerName: "Cliente Test",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

try {
  // =========================================================================
  // 1. PORTABILITÀ serverDirectoryPath RISPETTO A MOLIRIS_FS_ROOT
  // =========================================================================
  {
    const auditRepo = new InMemoryAuditRepository();
    const robotRepo = new InMemoryRobotRepository();
    const serverFs = new ServerFilesystemService(newFsRoot, auditRepo, logger);
    const credProvider = new InMemoryCredentialProvider();
    const hostKeyVerifier = new DefaultHostKeyVerifier();
    const config = makeConfig();
    const connMgr = new RobotConnectionManager(
      credProvider,
      hostKeyVerifier,
      {
        maxConcurrentPerUser: 3,
        maxConcurrentPerRobot: 2,
        maxConcurrentServer: 10,
        connectionTimeoutMs: 1000,
      },
      logger,
      auditRepo,
      new DestinationValidator(config.allowedDestinations)
    );
    const fleetService = new FleetService(
      config,
      robotRepo,
      auditRepo,
      serverFs,
      credProvider,
      hostKeyVerifier,
      connMgr,
      logger,
      DEFAULT_ROLE_PERMISSIONS
    );

    const staleRobot = makeRobot("robot-migrated-01", {
      serverDirectoryPath: path.join(oldFsRoot, "robot_robot-migrated-01"),
    });
    await robotRepo.create(staleRobot);

    // Pre-copia di un file reale nella cartella omonima sotto il NUOVO MOLIRIS_FS_ROOT
    // per verificare che non venga mai classificata come "deleted_robot" né sovrascritta!
    const preCopiedDir = path.join(newFsRoot, "robot_robot-migrated-01");
    fs.mkdirSync(preCopiedDir, { recursive: true });
    fs.writeFileSync(path.join(preCopiedDir, "preserved-backup.txt"), "DATI_PREZIOSI");

    // 1a. ServerFilesystemService deve rilevare il path fuori MOLIRIS_FS_ROOT e bloccare accessi non sicuri (RNF-FS-001..004)
    assert.strictEqual(
      serverFs.isRobotDirectoryUnderFsRoot(staleRobot.serverDirectoryPath),
      false,
      "Un percorso proveniente da un vecchio MOLIRIS_FS_ROOT deve essere rilevato come esterno"
    );

    await assert.rejects(
      () => serverFs.resolveRobotPath(staleRobot, "logs"),
      (err: any) =>
        err instanceof MolirisAppError &&
        err.code === ErrorCode.SERVER_DIR_INACCESSIBLE &&
        /MOLIRIS_FS_ROOT|riallinea/i.test(err.userMessage),
      "resolveRobotPath deve rifiutare percorsi fuori MOLIRIS_FS_ROOT con diagnostica di riallineamento"
    );

    await assert.rejects(
      () => serverFs.ensureRobotDirectory(staleRobot),
      (err: any) =>
        err instanceof MolirisAppError &&
        err.code === ErrorCode.SERVER_DIR_INACCESSIBLE &&
        /MOLIRIS_FS_ROOT|riallinea/i.test(err.userMessage),
      "ensureRobotDirectory non deve mai creare cartelle fuori MOLIRIS_FS_ROOT"
    );
    assert.strictEqual(
      fs.existsSync(staleRobot.serverDirectoryPath),
      false,
      "La vecchia directory fuori MOLIRIS_FS_ROOT non deve essere creata sul disco"
    );

    // 1b. listAggregateGeneralDirectory non deve perdere il robot né classificarlo erroneamente come deleted_robot
    const generalItems = await serverFs.listAggregateGeneralDirectory(
      makeAdminContext(),
      await robotRepo.list(),
      ""
    );
    const staleEntry = generalItems.find((i) => i.robotId === staleRobot.id);
    assert.ok(staleEntry, "Il robot con path su vecchio MOLIRIS_FS_ROOT deve comparire con stato di riallineamento");
    assert.strictEqual(staleEntry!.needsRealignment, true, "L'elemento deve avere needsRealignment=true");
    assert.strictEqual(staleEntry!.exists, false, "Non deve dichiarare accessibile una directory fuori fsRoot");
    const misclassifiedDeleted = generalItems.find(
      (i) => i.scope === "deleted_robot" && i.name === "robot_robot-migrated-01"
    );
    assert.strictEqual(
      misclassifiedDeleted,
      undefined,
      "Una cartella pre-copiata appartenente a un robot attivo non deve essere classificata come deleted_robot"
    );

    // 1c. RBAC: un operatore non può riallineare la directory server
    await assert.rejects(
      () => fleetService.realignServerDirectory(operatorUser, staleRobot.id),
      (err: any) => err instanceof MolirisAppError && err.code === ErrorCode.INSUFFICIENT_PERMISSIONS,
      "L'operatore deve ricevere INSUFFICIENT_PERMISSIONS sul riallineamento directory"
    );

    // 1d. Admin riallinea la directory del robot al MOLIRIS_FS_ROOT corrente preservando i file esistenti
    const realignRes = await fleetService.realignServerDirectory(adminUser, staleRobot.id);
    const expectedNewDir = path.join(newFsRoot, "robot_robot-migrated-01");
    assert.strictEqual(realignRes.pathUpdated, true);
    assert.strictEqual(realignRes.currentPath, expectedNewDir);
    assert.strictEqual(realignRes.robot.serverDirectoryPath, expectedNewDir);
    assert.strictEqual(
      fs.readFileSync(path.join(expectedNewDir, "preserved-backup.txt"), "utf8"),
      "DATI_PREZIOSI",
      "I file preesistenti nella nuova directory devono essere preservati intatti"
    );
    for (const sub of config.standardSubdirectories!) {
      assert.strictEqual(
        fs.existsSync(path.join(expectedNewDir, sub)),
        true,
        `La sottodirectory standard '${sub}' deve essere creata`
      );
    }

    // Dopo il riallineamento, listDirectory e listAggregateGeneralDirectory funzionano normalmente
    const updatedRobot = (await robotRepo.findById(staleRobot.id))!;
    const listed = await serverFs.listDirectory(makeAdminContext(updatedRobot.id), updatedRobot, "");
    assert.ok(listed.some((i) => i.name === "preserved-backup.txt"));
    const generalAfter = await serverFs.listAggregateGeneralDirectory(
      makeAdminContext(),
      await robotRepo.list(),
      ""
    );
    const alignedEntry = generalAfter.find((i) => i.robotId === staleRobot.id);
    assert.ok(alignedEntry);
    assert.strictEqual(alignedEntry!.exists, true);
    assert.ok(!alignedEntry!.needsRealignment);

    console.log("  PASS 1: Portabilità serverDirectoryPath, jail RNF-FS-001..004, RBAC e riallineamento admin.");
  }

  // =========================================================================
  // 2. ENDPOINT HTTP POST /api/robots/:robotId/realign-directory + /api/fs/general/list
  // =========================================================================
  {
    const httpFsRoot = path.join(tmpBase, "http-fs-root");
    fs.mkdirSync(httpFsRoot, { recursive: true });
    const robotRepo = new InMemoryRobotRepository();
    const userRepo = new InMemoryUserRepository();
    const auditRepo = new InMemoryAuditRepository();
    const httpConfig = makeConfig({ serverFilesystemRoot: httpFsRoot });
    const sessionManager = new SessionManager(30, 5, 120);

    const httpAdminUser: UserEntity = {
      id: "http-admin",
      username: "admin_http",
      passwordHash: "hash",
      roles: ["admin"],
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const httpOpUser: UserEntity = {
      id: "http-op",
      username: "op_http",
      passwordHash: "hash",
      roles: ["operatore"],
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await userRepo.create(httpAdminUser);
    await userRepo.create(httpOpUser);

    const staleHttpRobot = makeRobot("robot-http-01", {
      serverDirectoryPath: "/legacy/server/robots/robot_robot-http-01",
    });
    await robotRepo.create(staleHttpRobot);

    const app = createServer(httpConfig, logger, {
      robotRepository: robotRepo,
      userRepository: userRepo,
      auditRepository: auditRepo,
      sessionManager,
      credentialProvider: new InMemoryCredentialProvider(),
    });

    const adminSession = sessionManager.createSession(httpAdminUser);
    const opSession = sessionManager.createSession(httpOpUser);

    // GET /api/fs/general/list espone needsRealignment=true
    const listRes = await app.inject({
      method: "GET",
      url: "/api/fs/general/list",
      headers: { authorization: `Bearer ${adminSession.sessionId}` },
    });
    assert.strictEqual(listRes.statusCode, 200, `Expected 200, got ${listRes.statusCode}: ${listRes.body}`);
    const listBody = listRes.json();
    const found = listBody.entries.find((e: any) => e.robotId === "robot-http-01");
    assert.ok(found, "Il robot fuori root deve essere visibile in /api/fs/general/list");
    assert.strictEqual(found.needsRealignment, true);

    // Operatore -> 403 su POST /api/robots/:robotId/realign-directory
    const opRealignRes = await app.inject({
      method: "POST",
      url: "/api/robots/robot-http-01/realign-directory",
      headers: { authorization: `Bearer ${opSession.sessionId}` },
    });
    assert.strictEqual(opRealignRes.statusCode, 403, "L'operatore deve ricevere 403 Forbidden");

    // Admin -> 200 su POST /api/robots/:robotId/realign-directory
    const adminRealignRes = await app.inject({
      method: "POST",
      url: "/api/robots/robot-http-01/realign-directory",
      headers: { authorization: `Bearer ${adminSession.sessionId}` },
    });
    assert.strictEqual(adminRealignRes.statusCode, 200);
    const realignJson = adminRealignRes.json();
    assert.strictEqual(
      realignJson.robot.serverDirectoryPath,
      path.join(httpFsRoot, "robot_robot-http-01")
    );
    assert.strictEqual(fs.existsSync(path.join(httpFsRoot, "robot_robot-http-01", "logs")), true);

    await app.close();
    console.log("  PASS 2: Endpoint HTTP /api/fs/general/list e POST /api/robots/:robotId/realign-directory (RBAC verificato).");
  }

  // =========================================================================
  // 3. SCRIPT DI MIGRAZIONE SICURO (scripts/migrate-robot-directories.ts)
  // =========================================================================
  {
    const migFsRoot = path.join(tmpBase, "mig-fs-root");
    fs.mkdirSync(migFsRoot, { recursive: true });
    const robotRepo = new InMemoryRobotRepository();
    const auditRepo = new InMemoryAuditRepository();

    const r1 = makeRobot("mig-r1", { host: "192.168.10.11", serverDirectoryPath: "/old/srv/robot_mig-r1" });
    const r2 = makeRobot("mig-r2", { host: "192.168.10.12", serverDirectoryPath: path.join(migFsRoot, "robot_mig-r2") }); // path ok ma cartella assente
    const r3 = makeRobot("mig-r3", { host: "192.168.10.13", serverDirectoryPath: "/another-old/srv/robot_mig-r1" }); // collisione di basename con r1!

    await robotRepo.create(r1);
    await robotRepo.create(r2);
    await robotRepo.create(r3);

    // Dry-run: nessuna modifica DB né creazione cartelle
    const dryReport = await migrateRobotDirectories({
      robotRepository: robotRepo,
      auditRepository: auditRepo,
      fsRoot: migFsRoot,
      directoryPermissions: "0750",
      standardSubdirectories: ["logs", "configs", "backups"],
      apply: false,
      logger,
    });
    assert.strictEqual(dryReport.apply, false);
    assert.strictEqual((await robotRepo.findById("mig-r1"))!.serverDirectoryPath, "/old/srv/robot_mig-r1");
    assert.strictEqual(fs.existsSync(path.join(migFsRoot, "robot_mig-r1")), false);
    assert.strictEqual(fs.existsSync(path.join(migFsRoot, "robot_mig-r2")), false);
    assert.ok(dryReport.items.some((i) => i.robotId === "mig-r1" && i.action === "would_realign"));
    assert.ok(dryReport.items.some((i) => i.robotId === "mig-r2" && i.action === "would_create_dir"));

    // Apply: r1 allineato, r2 creato, r3 gestito senza sovrascrivere r1 (fallback a <username>_<id> o skip collisione)
    const applyReport = await migrateRobotDirectories({
      robotRepository: robotRepo,
      auditRepository: auditRepo,
      fsRoot: migFsRoot,
      directoryPermissions: "0750",
      standardSubdirectories: ["logs", "configs", "backups"],
      apply: true,
      logger,
    });
    assert.strictEqual(applyReport.apply, true);
    assert.strictEqual(
      (await robotRepo.findById("mig-r1"))!.serverDirectoryPath,
      path.join(migFsRoot, "robot_mig-r1")
    );
    assert.strictEqual(fs.existsSync(path.join(migFsRoot, "robot_mig-r1", "logs")), true);
    assert.strictEqual(fs.existsSync(path.join(migFsRoot, "robot_mig-r2", "configs")), true);
    const r3After = (await robotRepo.findById("mig-r3"))!;
    assert.notStrictEqual(
      r3After.serverDirectoryPath,
      path.join(migFsRoot, "robot_mig-r1"),
      "La migrazione non deve mai assegnare la stessa directory a due robot diversi"
    );

    // Idempotenza: rieseguendo apply non rompe né sovrascrive nulla
    fs.writeFileSync(path.join(migFsRoot, "robot_mig-r1", "logs", "keep.log"), "KEEP");
    const secondReport = await migrateRobotDirectories({
      robotRepository: robotRepo,
      auditRepository: auditRepo,
      fsRoot: migFsRoot,
      directoryPermissions: "0750",
      standardSubdirectories: ["logs", "configs", "backups"],
      apply: true,
      logger,
    });
    assert.strictEqual(
      fs.readFileSync(path.join(migFsRoot, "robot_mig-r1", "logs", "keep.log"), "utf8"),
      "KEEP"
    );
    assert.ok(secondReport.items.some((i) => i.robotId === "mig-r1" && i.action === "already_ok"));

    console.log("  PASS 3: Script migrate-robot-directories.ts (dry-run, apply, permessi, subdirs, collisioni, idempotenza).");
  }

  // =========================================================================
  // 4. DIAGNOSTICA CHIARA PER RNF-SEC-006 (MOLIRIS_ALLOWED_DESTINATIONS)
  // =========================================================================
  {
    const auditRepo = new InMemoryAuditRepository();
    const robotRepo = new InMemoryRobotRepository();
    const serverFs = new ServerFilesystemService(newFsRoot, auditRepo, logger);
    const credProvider = new InMemoryCredentialProvider();
    const hostKeyVerifier = new DefaultHostKeyVerifier();

    // 4a. Registrazione con MOLIRIS_ALLOWED_DESTINATIONS=none ([])
    const denyAllConfig = makeConfig({ allowedDestinations: [] });
    const denyAllConnMgr = new RobotConnectionManager(
      credProvider,
      hostKeyVerifier,
      { maxConcurrentPerUser: 3, maxConcurrentPerRobot: 2, maxConcurrentServer: 10, connectionTimeoutMs: 500 },
      logger,
      auditRepo,
      new DestinationValidator(denyAllConfig.allowedDestinations)
    );
    const denyAllFleet = new FleetService(
      denyAllConfig,
      robotRepo,
      auditRepo,
      serverFs,
      credProvider,
      hostKeyVerifier,
      denyAllConnMgr,
      logger,
      DEFAULT_ROLE_PERMISSIONS
    );

    const regResNone = await denyAllFleet.registerRobot(adminUser, {
      id: "robot-blocked-none",
      displayName: "Robot Blocked None",
      remoteUsername: "robot",
      host: "10.20.30.40",
      sshPort: 22,
      sshAuthMethod: "password",
      password: "super-secret-password-never-leak",
      hostKeyVerification: {
        fingerprint: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        strictHostKeyChecking: true,
      },
      customerName: "Cliente Test",
    });
    assert.strictEqual(regResNone.outcome, "registrazione_rifiutata");
    const hostErrNone = regResNone.validationErrors?.host || "";
    assert.ok(
      hostErrNone.includes("MOLIRIS_ALLOWED_DESTINATIONS") &&
        hostErrNone.includes(".env") &&
        /none/i.test(hostErrNone),
      `Diagnostica registrazione (none) deve citare MOLIRIS_ALLOWED_DESTINATIONS in .env e 'none', ricevuto: ${hostErrNone}`
    );
    assert.ok(!hostErrNone.includes("super-secret-password-never-leak"), "Nessun segreto deve comparire nel messaggio");

    // 4b. Registrazione con whitelist che non include l'host inserito
    const restrictedConfig = makeConfig({ allowedDestinations: ["192.168.1.50"] });
    const restrictedFleet = new FleetService(
      restrictedConfig,
      robotRepo,
      auditRepo,
      serverFs,
      credProvider,
      hostKeyVerifier,
      denyAllConnMgr,
      logger,
      DEFAULT_ROLE_PERMISSIONS
    );
    const regResList = await restrictedFleet.registerRobot(adminUser, {
      id: "robot-blocked-list",
      displayName: "Robot Blocked List",
      remoteUsername: "robot",
      host: "10.20.30.41",
      sshPort: 22,
      sshAuthMethod: "password",
      password: "super-secret-password-2",
      hostKeyVerification: {
        fingerprint: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        strictHostKeyChecking: true,
      },
      customerName: "Cliente Test",
    });
    assert.strictEqual(regResList.outcome, "registrazione_rifiutata");
    const hostErrList = regResList.validationErrors?.host || "";
    assert.ok(
      hostErrList.includes("MOLIRIS_ALLOWED_DESTINATIONS") &&
        hostErrList.includes(".env") &&
        hostErrList.includes("10.20.30.41"),
      `Diagnostica registrazione (whitelist) deve citare host e MOLIRIS_ALLOWED_DESTINATIONS in .env, ricevuto: ${hostErrList}`
    );

    // 4c. Polling di un robot preesistente nel DB il cui host non è in MOLIRIS_ALLOWED_DESTINATIONS
    const existingBlockedRobot = makeRobot("robot-poll-blocked", {
      host: "10.99.88.77",
      serverDirectoryPath: path.join(newFsRoot, "robot_robot-poll-blocked"),
    });
    await robotRepo.create(existingBlockedRobot);
    const remoteReader = new RemoteRobotReader(denyAllConnMgr, 500, logger);
    const monitoringService = new MonitoringService(
      denyAllConfig,
      robotRepo,
      auditRepo,
      remoteReader,
      new MolirisStateFileParser("auto"),
      DEFAULT_ROLE_PERMISSIONS,
      logger
    );

    const polled = await monitoringService.pollSingleRobot(existingBlockedRobot.id, "system_poller");
    assert.ok(polled);
    assert.strictEqual(polled!.connectionState, "errore", "Il blocco RNF-SEC-006 in polling deve produrre stato 'errore'");
    assert.ok(
      polled!.lastAttemptOutcome?.diagnosticMessage?.includes("MOLIRIS_ALLOWED_DESTINATIONS") &&
        polled!.lastAttemptOutcome?.diagnosticMessage?.includes(".env"),
      `Diagnostica polling deve citare MOLIRIS_ALLOWED_DESTINATIONS in .env, ricevuto: ${polled!.lastAttemptOutcome?.diagnosticMessage}`
    );

    // 4d. verifyConnection manuale su robot con host bloccato
    const verifRes = await denyAllFleet.verifyConnection(adminUser, existingBlockedRobot.id);
    assert.strictEqual(verifRes.success, false);
    assert.strictEqual(verifRes.connectionState, "errore");
    assert.ok(
      verifRes.message.includes("MOLIRIS_ALLOWED_DESTINATIONS") && verifRes.message.includes(".env"),
      `verifyConnection deve esporre diagnostica MOLIRIS_ALLOWED_DESTINATIONS, ricevuto: ${verifRes.message}`
    );

    console.log("  PASS 4: Messaggistica diagnostica RNF-SEC-006 (registrazione, verifyConnection e polling).");
  }

  // =========================================================================
  // 5. DIAGNOSTICA CHIARA PER MISMATCH DI master.key
  // =========================================================================
  {
    const keyA = crypto.randomBytes(32);
    const keyB = crypto.randomBytes(32);
    const secretPassword = "UltraSecretRobotPassword!2026";

    // Fake Mongo collection in memoria per testare MongoCredentialProvider senza toccare MongoDB reale
    const storedDocs = new Map<string, any>();
    const fakeCollection = {
      createIndex: async () => "ok",
      updateOne: async (filter: any, update: any) => {
        storedDocs.set(filter.robotId, { ...update.$set });
      },
      findOne: async (filter: any) => {
        if (filter?.robotId) return storedDocs.get(filter.robotId) || null;
        if (Array.isArray(filter?.$or)) {
          for (const clause of filter.$or) {
            if (clause.robotId && storedDocs.has(clause.robotId)) {
              return storedDocs.get(clause.robotId);
            }
            if (clause.credentialReference) {
              for (const doc of storedDocs.values()) {
                if (doc.credentialReference === clause.credentialReference) return doc;
              }
            }
          }
        }
        return null;
      },
      deleteOne: async (filter: any) => {
        storedDocs.delete(filter.robotId);
      },
    };
    const fakeDb: any = { collection: () => fakeCollection };

    const providerKeyA = new MongoCredentialProvider(fakeDb, keyA);
    const credRef = await providerKeyA.store("robot-key-mismatch", {
      method: "password",
      password: secretPassword,
    });

    // Server ripristinato con una master.key diversa (keyB)
    const providerKeyB = new MongoCredentialProvider(fakeDb, keyB);

    // 5a. Errore diretto di decryptMaterial / getCredentials
    await assert.rejects(
      () => providerKeyB.getCredentials(credRef, "password"),
      (err: any) => {
        assert.ok(err instanceof MolirisAppError);
        assert.strictEqual(err.code, ErrorCode.SSH_AUTH_FAILED);
        const text = `${err.message} ${err.userMessage}`;
        assert.ok(/master\.key/i.test(text), `Deve citare master.key: ${text}`);
        assert.ok(/reencrypt-credentials\.ts/i.test(text), `Deve citare reencrypt-credentials.ts: ${text}`);
        assert.ok(/reinserire le credenziali/i.test(text), `Deve invitare a reinserire le credenziali dalla UI: ${text}`);
        assert.ok(!text.includes(secretPassword), "Non deve mai esporre la password in chiaro");
        assert.ok(!text.includes(keyA.toString("hex")) && !text.includes(keyB.toString("hex")), "Non deve mai esporre la master.key");
        return true;
      }
    );

    // 5b. Polling con mismatch master.key -> stato 'errore' e diagnostica chiara (non errore generico di connessione)
    const auditRepo = new InMemoryAuditRepository();
    const robotRepo = new InMemoryRobotRepository();
    const hostKeyVerifier = new DefaultHostKeyVerifier();
    const config = makeConfig({ allowedDestinations: ["127.0.0.1"] });
    const connMgr = new RobotConnectionManager(
      providerKeyB,
      hostKeyVerifier,
      { maxConcurrentPerUser: 3, maxConcurrentPerRobot: 2, maxConcurrentServer: 10, connectionTimeoutMs: 500 },
      logger,
      auditRepo,
      new DestinationValidator(config.allowedDestinations)
    );
    const robotMismatch = makeRobot("robot-key-mismatch", {
      host: "127.0.0.1",
      sshPort: 2222,
      credentialReference: credRef,
      serverDirectoryPath: path.join(newFsRoot, "robot_robot-key-mismatch"),
    });
    await robotRepo.create(robotMismatch);

    const remoteReader = new RemoteRobotReader(connMgr, 500, logger);
    const monitoringService = new MonitoringService(
      config,
      robotRepo,
      auditRepo,
      remoteReader,
      new MolirisStateFileParser("auto"),
      DEFAULT_ROLE_PERMISSIONS,
      logger
    );

    const polled = await monitoringService.pollSingleRobot(robotMismatch.id, "system_poller");
    assert.ok(polled);
    assert.strictEqual(polled!.connectionState, "errore", "Mismatch master.key deve produrre stato 'errore', non 'non_raggiungibile'");
    assert.strictEqual(polled!.lastAttemptOutcome?.errorCode, ErrorCode.SSH_AUTH_FAILED);
    assert.strictEqual(polled!.lastAttemptOutcome?.subType, "credential_decryption_error");
    assert.ok(
      /master\.key/i.test(polled!.lastAttemptOutcome?.diagnosticMessage || "") &&
        /reencrypt-credentials\.ts/i.test(polled!.lastAttemptOutcome?.diagnosticMessage || ""),
      `La diagnostica del robot deve guidare su master.key e reencrypt-credentials.ts, ricevuto: ${polled!.lastAttemptOutcome?.diagnosticMessage}`
    );

    // 5c. verifyRobotConnection & FleetService.verifyConnection (con socket TCP aperto in locale per arrivare al passo credenziali)
    const net = await import("node:net");
    const mockSshServer = net.createServer((socket) => {
      socket.write("SSH-2.0-OpenSSH_9.0_MolirisTest\r\n");
      socket.on("error", () => {});
    });
    await new Promise<void>((resolve) => mockSshServer.listen(0, "127.0.0.1", () => resolve()));
    const addr = mockSshServer.address() as { port: number };
    await robotRepo.updateConfiguration(robotMismatch.id, { sshPort: addr.port });

    try {
      const serverFs = new ServerFilesystemService(newFsRoot, auditRepo, logger);
      const fleetService = new FleetService(
        config,
        robotRepo,
        auditRepo,
        serverFs,
        providerKeyB,
        hostKeyVerifier,
        connMgr,
        logger,
        DEFAULT_ROLE_PERMISSIONS
      );

      const report = await verifyRobotConnection((await robotRepo.findById(robotMismatch.id))!, {
        credentialProvider: providerKeyB,
        hostKeyVerifier,
        destinationValidator: new DestinationValidator(config.allowedDestinations),
        timeoutMs: 1000,
        logger,
      });
      assert.strictEqual(report.overallSuccess, false);
      const authStep = report.steps.find((s) => s.step === "ssh_authentication");
      assert.ok(authStep && authStep.status === "FAILED" && authStep.errorCode === ErrorCode.SSH_AUTH_FAILED);
      assert.ok(/master\.key/i.test(authStep.diagnosticDetail || authStep.message || ""));

      const verifRes = await fleetService.verifyConnection(adminUser, robotMismatch.id);
      assert.strictEqual(verifRes.success, false);
      assert.strictEqual(verifRes.connectionState, "errore");
      assert.ok(/master\.key/i.test(verifRes.message) && /reencrypt-credentials\.ts/i.test(verifRes.message));
    } finally {
      await new Promise<void>((resolve) => mockSshServer.close(() => resolve()));
    }

    console.log("  PASS 5: Messaggistica diagnostica chiara su mismatch master.key (decrypt, polling e verifyConnection).");
  }

  console.log("PASS: Tutti i test di portabilità server e diagnostica completati con successo!");
} finally {
  fs.rmSync(tmpBase, { recursive: true, force: true });
}
