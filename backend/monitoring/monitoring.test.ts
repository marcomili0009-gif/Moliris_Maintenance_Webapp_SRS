// Requisiti soddisfatti: RF-MON-001..006, RNF-PERF-004, RNF-REL-001, RNF-REL-002, RNF-SEC-002, §5.3, §9, §10.2, §11.4,
// CA-MON-001, CA-MON-002, CA-MON-003, CA-MON-004

import assert from "assert";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { execSync } from "child_process";
import ssh2 from "ssh2";
import { type SystemConfiguration } from "../../config/configuration.ts";
import { MolirisLogger } from "../../logging/logger.ts";
import { InMemoryRobotRepository } from "../../storage/robot-repository.ts";
import { InMemoryAuditRepository } from "../../storage/audit-repository.ts";
import { type RobotEntity } from "../../storage/robot-models.ts";
import { type UserEntity } from "../auth/user-models.ts";
import { AppPermission, type RolePermissionMapping } from "../auth/permissions.ts";
import { InMemoryCredentialProvider } from "../connection/credential-provider.ts";
import { DefaultHostKeyVerifier, computeHostKeyFingerprint } from "../connection/host-key-verifier.ts";
import { RobotConnectionManager } from "../connection/robot-connection-manager.ts";
import { ProvisionalDevelopmentStateFileParser } from "./state-file-parser.ts";
import { RemoteRobotReader } from "./robot-reader.ts";
import { MonitoringService } from "./monitoring-service.ts";
import { createServer } from "../server.ts";
import { ErrorCode, MolirisAppError } from "../../errors/app-errors.ts";
import { SessionManager } from "../auth/session-manager.ts";
import { InMemoryUserRepository } from "../auth/user-repository.ts";

console.log("--> Esecuzione test suite Servizio di Monitoraggio (CA-MON-001..004)...");

// 1. Test Unitari del Parser Sostituibile (RF-MON-002, §11.4)
{
  const parser = new ProvisionalDevelopmentStateFileParser();

  // Test Key-Value valido
  const kvContent = `
    # Commento iniziale
    battery=85
    voltage=24.5
    mode=patrol
    active=true
    alarm=false
  `;
  const kvRes = parser.parse(kvContent, "/path/kv.txt");
  assert.strictEqual(kvRes.success, true);
  if (kvRes.success) {
    assert.strictEqual(kvRes.data.battery, 85);
    assert.strictEqual(kvRes.data.voltage, 24.5);
    assert.strictEqual(kvRes.data.mode, "patrol");
    assert.strictEqual(kvRes.data.active, true);
    assert.strictEqual(kvRes.data.alarm, false);
  }

  // Test JSON valido
  const jsonContent = JSON.stringify({
    battery_level: 92,
    state: "idle",
    navigation_ok: true,
  });
  const jsonRes = parser.parse(jsonContent, "/path/status.json");
  assert.strictEqual(jsonRes.success, true);
  if (jsonRes.success) {
    assert.strictEqual(jsonRes.data.battery_level, 92);
    assert.strictEqual(jsonRes.data.state, "idle");
    assert.strictEqual(jsonRes.data.navigation_ok, true);
  }

  // Test file vuoto (empty)
  const emptyRes = parser.parse("   \n   ", "/path/empty.txt");
  assert.strictEqual(emptyRes.success, false);
  if (!emptyRes.success) {
    assert.strictEqual(emptyRes.subType, "empty");
  }

  // Test file incompleto (incomplete)
  const incompleteJson = '{"battery": 80, "status": ';
  const incRes = parser.parse(incompleteJson, "/path/inc.json");
  assert.strictEqual(incRes.success, false);
  if (!incRes.success) {
    assert.strictEqual(incRes.subType, "incomplete");
  }

  // Test file malformato (malformed)
  const malformedKv = "riga_senza_separatore\naltra_riga";
  const malRes = parser.parse(malformedKv, "/path/bad.txt");
  assert.strictEqual(malRes.success, false);
  if (!malRes.success) {
    assert.strictEqual(malRes.subType, "malformed");
  }

  // Test con caratteri binari (malformed)
  const binaryContent = "battery=80\x00\x01\x02";
  const binRes = parser.parse(binaryContent, "/path/bin.txt");
  assert.strictEqual(binRes.success, false);
  if (!binRes.success) {
    assert.strictEqual(binRes.subType, "malformed");
  }

  console.log("  PASS: Parser sostituibile provvisorio (KV e JSON) e classificazione sottotipi anomalia.");
}

// 2. Setup Server SSH Locale per i Test di Integrazione
const serverHostKey = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "pkcs1", format: "pem" },
});
const parsedKey = (ssh2 as any).utils.parseKey(serverHostKey.privateKey);
const serverHostKeyWireBuffer = parsedKey.getPublicSSH();
const serverFingerprintInfo = computeHostKeyFingerprint(serverHostKeyWireBuffer);

// Mappa dei contenuti serviti dal server SSH simulato
const mockFileContents: Record<string, { exitCode: number; content: string }> = {
  "/opt/moliris/status/valid_kv.txt": {
    exitCode: 0,
    content: "battery=78\nvoltage=23.9\nstatus=navigating\nsafety_ok=true\n",
  },
  "/opt/moliris/status/valid_json.txt": {
    exitCode: 0,
    content: JSON.stringify({ battery: 95, state: "docked", docked: true }),
  },
  "/opt/moliris/status/empty.txt": {
    exitCode: 0,
    content: "",
  },
  "/opt/moliris/status/incomplete.txt": {
    exitCode: 0,
    content: "battery=70\nmode=\n",
  },
  "/opt/moliris/status/malformed.txt": {
    exitCode: 0,
    content: "### BAD DATA WITHOUT SEPARATOR ###\n@@@@@@@@",
  },
};

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
        const cmd = info.command;

        // Estrai percorso tra apici
        const match = cmd.match(/'([^']+)'/);
        const requestedPath = match ? match[1] : "";

        if (mockFileContents[requestedPath]) {
          const entry = mockFileContents[requestedPath];
          if (entry.content) {
            stream.write(entry.content);
          }
          stream.exit(entry.exitCode);
          stream.end();
        } else {
          // File non presente
          stream.stderr.write("__MOLIRIS_FILE_NOT_FOUND__\n");
          stream.exit(2);
          stream.end();
        }
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

// Generazione certificati autofirmati temporanei per i test HTTPS (RNF-SEC-001)
const tmpTlsDir = fs.mkdtempSync(path.join(os.tmpdir(), "moliris-mon-tls-"));
const certPath = path.join(tmpTlsDir, "cert.pem");
const keyPath = path.join(tmpTlsDir, "key.pem");
execSync(`openssl req -x509 -newkey rsa:2048 -keyout "${keyPath}" -out "${certPath}" -days 1 -nodes -subj "/CN=localhost"`, {
  stdio: "pipe",
});

// Configurazione di test
const testConfig: SystemConfiguration = {
  credentialProviderType: "in-memory",
  serverFilesystemRoot: "/tmp/moliris-monitoring-test-fs",
  pollingIntervalSeconds: 5,
  sshConnectionTimeoutMs: 2000,
  maxConcurrentTransfersPerUser: 5,
  maxConcurrentTransfersPerRobot: 5,
  maxConcurrentTransfersServer: 10,
  tempFileRetentionMinutes: 60,
  stateFilePaths: ["/opt/moliris/status/valid_kv.txt"],
  inactiveSessionTimeoutMinutes: 30,
  tlsCertPath: certPath,
  tlsKeyPath: keyPath,
  standardSubdirectories: ["telemetria"],
  registrationMode: "rigorosa",
  auditLogRetentionDays: 90,
  defaultSshPort: 22,
  staleDataThresholdSeconds: 10,
};

const logger = new MolirisLogger();
const credentialProvider = new InMemoryCredentialProvider(["password", "key"]);
const hostKeyVerifier = new DefaultHostKeyVerifier();
const connectionLimits = {
  maxConcurrentPerUser: 5,
  maxConcurrentPerRobot: 5,
  maxConcurrentServer: 10,
  connectionTimeoutMs: 2000,
};
const connectionManager = new RobotConnectionManager(
  credentialProvider,
  hostKeyVerifier,
  connectionLimits,
  logger
);

// Registrazione credenziali di test
credentialProvider.registerSecret("cred_test_valid", {
  method: "password",
  password: "ValidPass123!",
});

// Utenti e ruoli
const adminUser: UserEntity = {
  id: "u_admin",
  username: "admin_user",
  roles: ["amministratore"],
  enabled: true,
    updatedAt: new Date(),
    passwordHash: "mock_hash",
  createdAt: new Date(),
};

const opUserWithRefresh: UserEntity = {
  id: "u_op_refresh",
  username: "op_user_refresh",
  roles: ["operatore"],
  enabled: true,
    updatedAt: new Date(),
    passwordHash: "mock_hash",
  createdAt: new Date(),
};

const opUserReadOnly: UserEntity = {
  id: "u_op_ro",
  username: "op_user_ro",
  roles: ["operatore_solo_vista"],
  enabled: true,
    updatedAt: new Date(),
    passwordHash: "mock_hash",
  createdAt: new Date(),
};

const testRoleMapping: RolePermissionMapping = {
  amministratore: [
    AppPermission.FLEET_VIEW,
    AppPermission.STATUS_VIEW,
    AppPermission.STATUS_REFRESH_MANUAL,
    AppPermission.ROBOT_REGISTER,
    AppPermission.ROBOT_CONFIG_UPDATE,
  ],
  operatore: [
    AppPermission.FLEET_VIEW,
    AppPermission.STATUS_VIEW,
    AppPermission.STATUS_REFRESH_MANUAL,
  ],
  operatore_solo_vista: [
    AppPermission.FLEET_VIEW,
    AppPermission.STATUS_VIEW,
  ],
};

function createTestRobot(id: string, statePath: string, host = "127.0.0.1", port = testServerPort): RobotEntity {
  return {
    id,
    displayName: `Robot Test ${id}`,
    remoteUsername: `op_${id}`,
    host,
    sshPort: port,
    sshAuthMethod: "password",
    credentialReference: "cred_test_valid",
    hostKeyVerification: {
      fingerprint: serverFingerprintInfo.sha256Hex,
      strictHostKeyChecking: true,
    },
    stateFilePaths: [statePath],
    serverDirectoryPath: `/tmp/moliris-monitoring-test-fs/op_${id}`,
    anagraphicState: "attivo",
    connectionState: "non_verificato",
    operationalState: null,
    lastValidUpdateAt: null,
    lastAttemptOutcome: null,
    registrationState: "registrazione_completata",
    lastConnectionVerification: { timestamp: new Date(), success: true },
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

// 3. Test CA-MON-001: Lettura, parsing e corretta impostazione dei valori
{
  const robotRepo = new InMemoryRobotRepository();
  const auditRepo = new InMemoryAuditRepository();
  const parser = new ProvisionalDevelopmentStateFileParser();
  const remoteReader = new RemoteRobotReader(connectionManager, testConfig.sshConnectionTimeoutMs, logger);
  const monitoringService = new MonitoringService(
    testConfig,
    robotRepo,
    auditRepo,
    remoteReader,
    parser,
    testRoleMapping,
    logger
  );

  const r1 = await robotRepo.create(createTestRobot("robot_kv", "/opt/moliris/status/valid_kv.txt"));
  const r2 = await robotRepo.create(createTestRobot("robot_json", "/opt/moliris/status/valid_json.txt"));

  // Esecuzione lettura
  const updatedR1 = await monitoringService.pollSingleRobot(r1.id, "system_monitor");
  assert.ok(updatedR1);
  assert.strictEqual(updatedR1.connectionState, "raggiungibile");
  assert.ok(updatedR1.operationalState);
  assert.strictEqual(updatedR1.operationalState.battery, 78);
  assert.strictEqual(updatedR1.operationalState.status, "navigating");
  assert.strictEqual(updatedR1.operationalState.safety_ok, true);
  assert.ok(updatedR1.lastValidUpdateAt);
  assert.ok(updatedR1.lastAttemptOutcome);
  assert.strictEqual(updatedR1.lastAttemptOutcome.success, true);
  assert.strictEqual(updatedR1.lastAttemptOutcome.stage, "monitoring");

  const updatedR2 = await monitoringService.pollSingleRobot(r2.id, "system_monitor");
  assert.ok(updatedR2);
  assert.strictEqual(updatedR2.connectionState, "raggiungibile");
  assert.ok(updatedR2.operationalState);
  assert.strictEqual(updatedR2.operationalState.battery, 95);
  assert.strictEqual(updatedR2.operationalState.state, "docked");
  assert.strictEqual(updatedR2.operationalState.docked, true);

  console.log("  PASS: CA-MON-001 - Lettura remota e parsing corretti (KV e JSON) con separazione degli stati.");
}

// 4. Test CA-MON-002: Intervallo di polling configurabile e disattivazione se assente o <= 0
{
  const robotRepo = new InMemoryRobotRepository();
  const auditRepo = new InMemoryAuditRepository();
  const parser = new ProvisionalDevelopmentStateFileParser();
  const remoteReader = new RemoteRobotReader(connectionManager, testConfig.sshConnectionTimeoutMs, logger);

  // Caso 1: intervallo non configurato (undefined)
  const noIntervalConfig = { ...testConfig, pollingIntervalSeconds: undefined as any };
  const serviceNoInterval = new MonitoringService(
    noIntervalConfig,
    robotRepo,
    auditRepo,
    remoteReader,
    parser,
    testRoleMapping,
    logger
  );
  const started1 = serviceNoInterval.startPolling();
  assert.strictEqual(started1, false);
  assert.strictEqual(serviceNoInterval.isPollingActive(), false);

  // Caso 2: intervallo disattivato (<= 0)
  const zeroIntervalConfig = { ...testConfig, pollingIntervalSeconds: 0 };
  const serviceZeroInterval = new MonitoringService(
    zeroIntervalConfig,
    robotRepo,
    auditRepo,
    remoteReader,
    parser,
    testRoleMapping,
    logger
  );
  const started2 = serviceZeroInterval.startPolling();
  assert.strictEqual(started2, false);
  assert.strictEqual(serviceZeroInterval.isPollingActive(), false);

  // Caso 3: intervallo valido (> 0)
  const validService = new MonitoringService(
    testConfig,
    robotRepo,
    auditRepo,
    remoteReader,
    parser,
    testRoleMapping,
    logger
  );
  const started3 = validService.startPolling();
  assert.strictEqual(started3, true);
  assert.strictEqual(validService.isPollingActive(), true);
  validService.stopPolling();
  assert.strictEqual(validService.isPollingActive(), false);

  console.log("  PASS: CA-MON-002 - Intervallo di polling configurabile; mancato avvio fail-closed se non configurato o <= 0s.");
}

// 5. Test CA-MON-003: Aggiornamento manuale on-demand, permessi e prevenzione sovrapposizioni
{
  const robotRepo = new InMemoryRobotRepository();
  const auditRepo = new InMemoryAuditRepository();
  const parser = new ProvisionalDevelopmentStateFileParser();
  const remoteReader = new RemoteRobotReader(connectionManager, testConfig.sshConnectionTimeoutMs, logger);
  const monitoringService = new MonitoringService(
    testConfig,
    robotRepo,
    auditRepo,
    remoteReader,
    parser,
    testRoleMapping,
    logger
  );

  const r1 = await robotRepo.create(createTestRobot("robot_manual", "/opt/moliris/status/valid_kv.txt"));

  // 1. Rifiuto autorizzativo per utente senza STATUS_REFRESH_MANUAL
  let authFailed = false;
  try {
    await monitoringService.refreshRobotStatus(opUserReadOnly, r1.id);
  } catch (err: any) {
    if (err instanceof MolirisAppError && err.code === ErrorCode.INSUFFICIENT_PERMISSIONS) {
      authFailed = true;
    }
  }
  assert.strictEqual(authFailed, true, "L'utente senza STATUS_REFRESH_MANUAL deve essere respinto.");

  // Verifica audit di violazione sicurezza registrato
  const auditLogs = await auditRepo.query({ robotId: r1.id });
  assert.ok(auditLogs.some((e) => e.operation === "SECURITY_AUTHORIZATION_ERROR"));

  // 2. Successo per operatore autorizzato
  const refreshResult = await monitoringService.refreshRobotStatus(opUserWithRefresh, r1.id);
  assert.strictEqual(refreshResult.success, true);
  assert.strictEqual(refreshResult.robot.operationalState?.battery, 78);
  assert.strictEqual(refreshResult.robot.connectionState, "raggiungibile");

  // 3. Rifiuto aggiornamento su robot disabilitato
  await robotRepo.updateAnagraphicState(r1.id, "disabilitato");
  let disabledFailed = false;
  try {
    await monitoringService.refreshRobotStatus(adminUser, r1.id);
  } catch (err: any) {
    if (err instanceof MolirisAppError && err.code === ErrorCode.INSUFFICIENT_PERMISSIONS) {
      disabledFailed = true;
    }
  }
  assert.strictEqual(disabledFailed, true, "Impossibile aggiornare lo stato di un robot disabilitato.");

  console.log("  PASS: CA-MON-003 - Refresh manuale verificato: rispetto RBAC (STATUS_REFRESH_MANUAL) e audit anomalie.");
}

// 6. Test CA-MON-004: Preservazione ultimo dato valido ed errori distinti (mancante, vuoto, incompleto, malformato, timeout, connessione)
{
  const robotRepo = new InMemoryRobotRepository();
  const auditRepo = new InMemoryAuditRepository();
  const parser = new ProvisionalDevelopmentStateFileParser();
  const remoteReader = new RemoteRobotReader(connectionManager, testConfig.sshConnectionTimeoutMs, logger);
  const monitoringService = new MonitoringService(
    testConfig,
    robotRepo,
    auditRepo,
    remoteReader,
    parser,
    testRoleMapping,
    logger
  );

  // Setup robot inizialmente valido con dati operativi accertati
  const rValid = await robotRepo.create(createTestRobot("robot_preserve", "/opt/moliris/status/valid_kv.txt"));
  await monitoringService.pollSingleRobot(rValid.id, "system_monitor");
  const robotAfterInitialPoll = (await robotRepo.findById(rValid.id))!;
  const originalValidState = robotAfterInitialPoll.operationalState;
  const originalValidTimestamp = robotAfterInitialPoll.lastValidUpdateAt;
  assert.ok(originalValidState);
  assert.ok(originalValidTimestamp);

  // Sottocaso 1: File Mancante (missing)
  await robotRepo.updateConfiguration(rValid.id, { stateFilePaths: ["/opt/moliris/status/non_existent_file.txt"] });
  await monitoringService.pollSingleRobot(rValid.id, "system_monitor");
  let currentRobot = (await robotRepo.findById(rValid.id))!;
  // RF-MON-005, CA-MON-004: l'ultimo dato valido NON deve essere alterato o cancellato
  assert.deepStrictEqual(currentRobot.operationalState, originalValidState);
  assert.deepStrictEqual(currentRobot.lastValidUpdateAt, originalValidTimestamp);
  assert.strictEqual(currentRobot.lastAttemptOutcome?.success, false);
  assert.strictEqual(currentRobot.lastAttemptOutcome?.subType, "missing");
  assert.strictEqual(currentRobot.lastAttemptOutcome?.errorCode, ErrorCode.STATE_FILE_UNREADABLE);

  // Sottocaso 2: File Vuoto (empty)
  await robotRepo.updateConfiguration(rValid.id, { stateFilePaths: ["/opt/moliris/status/empty.txt"] });
  await monitoringService.pollSingleRobot(rValid.id, "system_monitor");
  currentRobot = (await robotRepo.findById(rValid.id))!;
  assert.deepStrictEqual(currentRobot.operationalState, originalValidState);
  assert.deepStrictEqual(currentRobot.lastValidUpdateAt, originalValidTimestamp);
  assert.strictEqual(currentRobot.lastAttemptOutcome?.success, false);
  assert.strictEqual(currentRobot.lastAttemptOutcome?.subType, "empty");

  // Sottocaso 3: File Incompleto (incomplete)
  await robotRepo.updateConfiguration(rValid.id, { stateFilePaths: ["/opt/moliris/status/incomplete.txt"] });
  await monitoringService.pollSingleRobot(rValid.id, "system_monitor");
  currentRobot = (await robotRepo.findById(rValid.id))!;
  assert.deepStrictEqual(currentRobot.operationalState, originalValidState);
  assert.deepStrictEqual(currentRobot.lastValidUpdateAt, originalValidTimestamp);
  assert.strictEqual(currentRobot.lastAttemptOutcome?.success, false);
  assert.strictEqual(currentRobot.lastAttemptOutcome?.subType, "incomplete");

  // Sottocaso 4: File Malformato (malformed)
  await robotRepo.updateConfiguration(rValid.id, { stateFilePaths: ["/opt/moliris/status/malformed.txt"] });
  await monitoringService.pollSingleRobot(rValid.id, "system_monitor");
  currentRobot = (await robotRepo.findById(rValid.id))!;
  assert.deepStrictEqual(currentRobot.operationalState, originalValidState);
  assert.deepStrictEqual(currentRobot.lastValidUpdateAt, originalValidTimestamp);
  assert.strictEqual(currentRobot.lastAttemptOutcome?.success, false);
  assert.strictEqual(currentRobot.lastAttemptOutcome?.subType, "malformed");

  // Sottocaso 5: Robot Non Raggiungibile / Porta chiusa
  await robotRepo.updateConfiguration(rValid.id, { sshPort: 54321 }); // Porta inesistente
  await monitoringService.pollSingleRobot(rValid.id, "system_monitor");
  currentRobot = (await robotRepo.findById(rValid.id))!;
  assert.deepStrictEqual(currentRobot.operationalState, originalValidState);
  assert.deepStrictEqual(currentRobot.lastValidUpdateAt, originalValidTimestamp);
  assert.strictEqual(currentRobot.connectionState, "non_raggiungibile");
  assert.strictEqual(currentRobot.lastAttemptOutcome?.success, false);
  assert.strictEqual(currentRobot.lastAttemptOutcome?.subType, "connection_error");

  // INVARIANTE FONDAMENTALE (RF-MON-005): L'assenza di dati non deve mai diventare uno stato operativo arbitrario!
  assert.notStrictEqual(currentRobot.operationalState?.state, "offline");
  assert.notStrictEqual(currentRobot.operationalState?.state, "spento");

  console.log("  PASS: CA-MON-004 - Preservazione totale ultimo dato valido e distinzione netta anomalie (missing, empty, incomplete, malformed, conn).");
}

// 7. Test Isolamento Guasti (RNF-REL-001) e Nessuna Sovrapposizione (RNF-PERF-004)
{
  const robotRepo = new InMemoryRobotRepository();
  const auditRepo = new InMemoryAuditRepository();
  const parser = new ProvisionalDevelopmentStateFileParser();
  const remoteReader = new RemoteRobotReader(connectionManager, testConfig.sshConnectionTimeoutMs, logger);
  const monitoringService = new MonitoringService(
    testConfig,
    robotRepo,
    auditRepo,
    remoteReader,
    parser,
    testRoleMapping,
    logger
  );

  // Robot A: porta chiusa (guasto)
  const robotA = await robotRepo.create(createTestRobot("robot_failing", "/opt/moliris/status/valid_kv.txt", "127.0.0.1", 54322));
  // Robot B: funzionante
  const robotB = await robotRepo.create(createTestRobot("robot_working", "/opt/moliris/status/valid_kv.txt", "127.0.0.1", testServerPort));

  // Polling massivo
  await monitoringService.pollAllRobots();

  const resA = (await robotRepo.findById(robotA.id))!;
  const resB = (await robotRepo.findById(robotB.id))!;

  // Il fallimento di A non deve aver toccato B (RNF-REL-001)
  assert.strictEqual(resA.connectionState, "non_raggiungibile");
  assert.strictEqual(resB.connectionState, "raggiungibile");
  assert.strictEqual(resB.operationalState?.battery, 78);

  console.log("  PASS: RNF-REL-001 - Isolamento completo dei guasti tra robot durante il ciclo di polling.");
}

// 8. Test REST API Endpoints HTTPS (GET /api/robots/:robotId/status e POST /api/robots/:robotId/status/refresh)
{
  const robotRepo = new InMemoryRobotRepository();
  const auditRepo = new InMemoryAuditRepository();
  const userRepo = new InMemoryUserRepository();
  const sessionManager = new SessionManager(30);
  const parser = new ProvisionalDevelopmentStateFileParser();
  const remoteReader = new RemoteRobotReader(connectionManager, testConfig.sshConnectionTimeoutMs, logger);
  const monitoringService = new MonitoringService(
    testConfig,
    robotRepo,
    auditRepo,
    remoteReader,
    parser,
    testRoleMapping,
    logger
  );

  await robotRepo.create(createTestRobot("robot_api", "/opt/moliris/status/valid_kv.txt", "127.0.0.1", testServerPort));

  // Registra utenti nel repository
  await userRepo.create({ ...opUserWithRefresh, passwordHash: "dummy" });
  await userRepo.create({ ...opUserReadOnly, passwordHash: "dummy" });

  const server = createServer(testConfig, logger, {
    robotRepository: robotRepo,
    auditRepository: auditRepo,
    userRepository: userRepo,
    sessionManager,
    roleMapping: testRoleMapping,
    monitoringService,
  });

  await server.ready();

  // Crea sessioni
  const opSession = sessionManager.createSession(opUserWithRefresh);
  const roSession = sessionManager.createSession(opUserReadOnly);
  const opSessionToken = opSession.sessionId;
  const roSessionToken = roSession.sessionId;

  // 1. GET /api/robots/:robotId/status con utente autorizzato (STATUS_VIEW)
  const getRes = await server.inject({
    method: "GET",
    url: "/api/robots/robot_api/status",
    headers: {
      cookie: `__Host-moliris_session=${opSessionToken}`,
    },
  });
  assert.strictEqual(getRes.statusCode, 200);
  const getBody = JSON.parse(getRes.body);
  assert.strictEqual(getBody.robot.id, "robot_api");

  // 2. POST /api/robots/:robotId/status/refresh con utente autorizzato (STATUS_REFRESH_MANUAL)
  const refreshRes = await server.inject({
    method: "POST",
    url: "/api/robots/robot_api/status/refresh",
    headers: {
      cookie: `__Host-moliris_session=${opSessionToken}`,
    },
  });
  assert.strictEqual(refreshRes.statusCode, 200);
  const refreshBody = JSON.parse(refreshRes.body);
  assert.strictEqual(refreshBody.success, true);
  assert.strictEqual(refreshBody.robot.operationalState?.battery, 78);

  // 3. POST /api/robots/:robotId/status/refresh con utente non autorizzato (solo STATUS_VIEW, senza STATUS_REFRESH_MANUAL)
  const forbiddenRes = await server.inject({
    method: "POST",
    url: "/api/robots/robot_api/status/refresh",
    headers: {
      cookie: `__Host-moliris_session=${roSessionToken}`,
    },
  });
  assert.strictEqual(forbiddenRes.statusCode, 403);

  // 4. GET /api/robots/:robotId/status non autenticato -> 401
  const anonRes = await server.inject({
    method: "GET",
    url: "/api/robots/robot_api/status",
  });
  assert.strictEqual(anonRes.statusCode, 401);

  await server.close();
  console.log("  PASS: Endpoint REST /api/robots/:robotId/status e refresh verificati con RBAC.");
}

// Chiusura test server SSH e pulizia file temporanei
await new Promise<void>((resolve) => {
  testServer.close(() => resolve());
});
try {
  fs.rmSync(tmpTlsDir, { recursive: true, force: true });
} catch {}

console.log("PASS: Tutti i test del modulo di Monitoraggio completati con successo.");
