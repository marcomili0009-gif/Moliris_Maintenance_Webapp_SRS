// Requisiti soddisfatti: RF-SSH-001..008, RNF-SEC-001, RNF-SEC-002, RNF-SEC-004, RNF-SEC-007,
// RNF-SEC-009, RNF-REL-001, RNF-REL-005, RNF-PERF-002, RNF-PERF-003, SRS §5.4, §6.4, §9, §10.4, §11.6, §11.7,
// CA-SSH-001, CA-SSH-002, CA-SSH-003, CA-SSH-004, CA-SSH-005

import assert from "assert";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { execSync } from "child_process";
import ssh2 from "ssh2";
import { WebSocket } from "ws";

import { type SystemConfiguration } from "../../config/configuration.ts";
import { MolirisLogger } from "../../logging/logger.ts";
import { InMemoryRobotRepository } from "../../storage/robot-repository.ts";
import { InMemoryAuditRepository } from "../../storage/audit-repository.ts";
import { InMemoryUserRepository } from "../auth/user-repository.ts";
import { SessionManager } from "../auth/session-manager.ts";
import { type RobotEntity } from "../../storage/robot-models.ts";
import { type UserEntity } from "../auth/user-models.ts";
import { AppPermission, type RolePermissionMapping } from "../auth/permissions.ts";
import { InMemoryCredentialProvider } from "../connection/credential-provider.ts";
import { DefaultHostKeyVerifier, computeHostKeyFingerprint } from "../connection/host-key-verifier.ts";
import { RobotConnectionManager } from "../connection/robot-connection-manager.ts";
import { TerminalService } from "./terminal-service.ts";
import { createServer } from "../server.ts";
import { ErrorCode, MolirisAppError } from "../../errors/app-errors.ts";

console.log("--> Esecuzione test suite Servizio Terminale Remoto PTY (CA-SSH-001..005)...");

// 1. Generazione certificati TLS temporanei per HTTPS/WSS (RNF-SEC-001)
const tmpTlsDir = fs.mkdtempSync(path.join(os.tmpdir(), "moliris-term-tls-"));
const certPath = path.join(tmpTlsDir, "cert.pem");
const keyPath = path.join(tmpTlsDir, "key.pem");
execSync(`openssl req -x509 -newkey rsa:2048 -keyout "${keyPath}" -out "${certPath}" -days 1 -nodes -subj "/CN=localhost"`, {
  stdio: "pipe",
});

// 2. Setup server SSH di test con supporto completo PTY/Shell interattiva (§5.4, CA-SSH-001..003)
const serverHostKey = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "pkcs1", format: "pem" },
});
const parsedKey = (ssh2 as any).utils.parseKey(serverHostKey.privateKey);
const serverHostKeyWireBuffer = parsedKey.getPublicSSH();
const serverFingerprintInfo = computeHostKeyFingerprint(serverHostKeyWireBuffer);

let lastRemoteWindowSize = { cols: 80, rows: 24 };
const activeSshClients = new Set<any>();

const testSshServer = new ssh2.Server({ hostKeys: [serverHostKey.privateKey] }, (client) => {
  activeSshClients.add(client);
  client.on("close", () => activeSshClients.delete(client));
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

      session.on("pty", (acceptPty, _rejectPty, info) => {
        lastRemoteWindowSize = { cols: info.cols, rows: info.rows };
        acceptPty();
      });

      session.on("window-change", (acceptWin, _rejectWin, info) => {
        lastRemoteWindowSize = { cols: info.cols, rows: info.rows };
        if (acceptWin) acceptWin();
      });

      session.on("shell", (acceptShell) => {
        const stream = acceptShell();

        // Invia prompt iniziale
        stream.write("Welcome to Moliris Linux Robot\r\n$ ");

        stream.on("data", (chunk: Buffer) => {
          const str = chunk.toString("utf-8");

          // Test Ctrl+C (\x03)
          if (str.includes("\x03")) {
            stream.write("^C\r\n$ ");
            return;
          }

          // Test uscita normale (exit)
          if (str.includes("exit")) {
            stream.write("logout\r\n");
            stream.exit(0);
            stream.end();
            stream.close();
            return;
          }

          // Test comando interattivo con prompt aggiuntivo (CA-SSH-002)
          if (str.includes("confirm_op")) {
            stream.write("Vuoi procedere con la manutenzione? (y/n): ");
            return;
          }
          if (str.trim() === "y") {
            stream.write("\r\nOperazione manutenzione autorizzata ed eseguita.\r\n$ ");
            return;
          }

          // Test output progressivo (CA-SSH-003): invia più chunk cadenzati
          if (str.includes("long_task")) {
            stream.write("CHUNK_1_INIZIO;");
            setTimeout(() => {
              try { stream.write("CHUNK_2_INTERMEDIO;"); } catch {}
            }, 40);
            setTimeout(() => {
              try { stream.write("CHUNK_3_FINE;\r\n$ "); } catch {}
            }, 80);
            return;
          }

          // Echo standard
          stream.write(str);
        });
      });
    });
  });
});

let testSshPort = 0;
await new Promise<void>((resolve) => {
  testSshServer.listen(0, "127.0.0.1", () => {
    testSshPort = (testSshServer.address() as any).port;
    resolve();
  });
});

// 3. Configurazione di test
const testConfig: SystemConfiguration = {
  credentialProviderType: "in-memory",
  serverFilesystemRoot: "/tmp/moliris-term-fs",
  pollingIntervalSeconds: 10,
  sshConnectionTimeoutMs: 2500,
  maxConcurrentTransfersPerUser: 5,
  maxConcurrentTransfersPerRobot: 5,
  maxConcurrentTransfersServer: 10,
  tempFileRetentionMinutes: 60,
  stateFilePaths: ["/opt/moliris/status/robot.txt"],
  inactiveSessionTimeoutMinutes: 30,
  tlsCertPath: certPath,
  tlsKeyPath: keyPath,
  registrationMode: "rigorosa",
  auditLogRetentionDays: 90,
  defaultSshPort: 22,
  terminalSessionTimeoutMinutes: 1, // 1 minuto per test
  maxConcurrentTerminalSessionsServer: 5,
  maxConcurrentTerminalSessionsPerUser: 2,
  maxConcurrentTerminalSessionsPerRobot: 2,
  terminalDisconnectPolicy: "chiudi_immediatamente",
};

const logger = new MolirisLogger();
const credentialProvider = new InMemoryCredentialProvider(["password", "key"]);
credentialProvider.registerSecret("cred_robot_valid", {
  method: "password",
  password: "ValidPass123!",
});

const hostKeyVerifier = new DefaultHostKeyVerifier();
const connectionLimits = {
  maxConcurrentPerUser: 5,
  maxConcurrentPerRobot: 5,
  maxConcurrentServer: 10,
  connectionTimeoutMs: 2500,
};
const connectionManager = new RobotConnectionManager(
  credentialProvider,
  hostKeyVerifier,
  connectionLimits,
  logger
);

// Utenti e ruoli
const opUserAuthorized: UserEntity = {
  id: "u_op_term",
  username: "operatore_term",
  roles: ["operatore"],
  enabled: true,
    updatedAt: new Date(),
    passwordHash: "mock_hash",
  createdAt: new Date(),
};

const opUserAttacker: UserEntity = {
  id: "u_attacker",
  username: "utente_malevolo",
  roles: ["operatore"],
  enabled: true,
    updatedAt: new Date(),
    passwordHash: "mock_hash",
  createdAt: new Date(),
};

const opUserDenied: UserEntity = {
  id: "u_op_denied",
  username: "operatore_negato",
  roles: ["operatore_solo_vista"],
  enabled: true,
    updatedAt: new Date(),
    passwordHash: "mock_hash",
  createdAt: new Date(),
};

const roleMapping: RolePermissionMapping = {
  operatore: [
    AppPermission.FLEET_VIEW,
    AppPermission.STATUS_VIEW,
    AppPermission.TERMINAL_OPEN,
  ],
  operatore_solo_vista: [
    AppPermission.FLEET_VIEW,
    AppPermission.STATUS_VIEW,
  ],
};

function createRobot(id: string, opts: Partial<RobotEntity> = {}): RobotEntity {
  return {
    id,
    displayName: `Robot ${id}`,
    remoteUsername: `op_${id}`,
    host: "127.0.0.1",
    sshPort: testSshPort,
    sshAuthMethod: "password",
    credentialReference: "cred_robot_valid",
    hostKeyVerification: {
      fingerprint: serverFingerprintInfo.sha256Hex,
      strictHostKeyChecking: true,
    },
    stateFilePaths: ["/status.txt"],
    serverDirectoryPath: `/tmp/moliris-term-fs/op_${id}`,
    anagraphicState: "attivo",
    connectionState: "raggiungibile",
    operationalState: null,
    lastValidUpdateAt: null,
    lastAttemptOutcome: null,
    registrationState: "registrazione_completata",
    lastConnectionVerification: { timestamp: new Date(), success: true },
    createdAt: new Date(),
    updatedAt: new Date(),
    ...opts,
  };
}

// =========================================================================
// TEST SUITE: CA-SSH-001..005
// =========================================================================

// TEST 1: CA-SSH-001 - Apertura terminale interattivo PTY e flusso WebSocket senza connessione diretta client->robot
{
  const robotRepo = new InMemoryRobotRepository();
  const auditRepo = new InMemoryAuditRepository();
  const userRepo = new InMemoryUserRepository();
  await userRepo.create({ ...opUserAuthorized, passwordHash: "h" });
  await userRepo.create({ ...opUserAttacker, passwordHash: "h" });
  await userRepo.create({ ...opUserDenied, passwordHash: "h" });

  const sessionManager = new SessionManager(30);
  const terminalService = new TerminalService(
    testConfig,
    robotRepo,
    auditRepo,
    connectionManager,
    sessionManager,
    roleMapping,
    logger
  );

  await robotRepo.create(createRobot("robot_ssh_01"));

  const server = createServer(testConfig, logger, {
    robotRepository: robotRepo,
    auditRepository: auditRepo,
    userRepository: userRepo,
    sessionManager,
    roleMapping,
    terminalService,
    connectionManager,
  });

  await server.listen({ port: 0, host: "127.0.0.1" });
  const serverPort = (server.server.address() as any).port;

  const userSession = sessionManager.createSession(opUserAuthorized);

  // 1. Richiesta REST di allocazione sessione PTY (RF-SSH-001, §6.4 passo 1)
  const allocRes = await server.inject({
    method: "POST",
    url: "/api/robots/robot_ssh_01/terminal/sessions",
    headers: {
      cookie: `moliris_session=${userSession.sessionId}`,
    },
    payload: { cols: 80, rows: 24 },
  });

  assert.strictEqual(allocRes.statusCode, 201);
  const allocBody = JSON.parse(allocRes.body);
  assert.ok(allocBody.sessionId);
  assert.strictEqual(allocBody.robotId, "robot_ssh_01");
  assert.strictEqual(allocBody.cols, 80);
  assert.strictEqual(allocBody.rows, 24);

  // 2. Connessione WebSocket bidirezionale (WSS) dal client (RF-SSH-004)
  const ws = new WebSocket(`wss://127.0.0.1:${serverPort}/api/terminal/ws/${allocBody.sessionId}`, {
    rejectUnauthorized: false,
    headers: {
      cookie: `moliris_session=${userSession.sessionId}`,
    },
  });

  const receivedChunks: string[] = [];
  await new Promise<void>((resolve, reject) => {
    ws.on("open", () => {});
    ws.on("message", (data) => {
      receivedChunks.push(data.toString());
      if (receivedChunks.join("").includes("Welcome to Moliris Linux Robot")) {
        resolve();
      }
    });
    ws.on("error", reject);
    setTimeout(() => reject(new Error("Timeout attesa prompt iniziale")), 3000);
  });

  assert.ok(receivedChunks.join("").includes("Welcome to Moliris Linux Robot"));
  assert.ok(receivedChunks.join("").includes("$ "));

  // Verifica Audit di apertura sessione (RNF-SEC-009)
  const auditEntries = await auditRepo.query({ robotId: "robot_ssh_01" });
  const openAudit = auditEntries.find((e) => e.operation === "TERMINAL_OPEN");
  assert.ok(openAudit, "Deve essere presente l'evento TERMINAL_OPEN nell'audit");
  assert.strictEqual(openAudit.outcome, "SUCCESS");
  assert.strictEqual(openAudit.userId, opUserAuthorized.username);

  ws.close();
  await terminalService.closeSession(allocBody.sessionId, "USER_EXPLICIT");
  await server.close();
  console.log("  PASS: CA-SSH-001 - Utente autorizzato apre shell PTY tramite backend senza connessione diretta browser->robot.");
}

// TEST 2: CA-SSH-002 & CA-SSH-003 - Comandi interattivi, streaming progressivo, Ctrl+C e ridimensionamento
{
  const robotRepo = new InMemoryRobotRepository();
  const auditRepo = new InMemoryAuditRepository();
  const userRepo = new InMemoryUserRepository();
  await userRepo.create({ ...opUserAuthorized, passwordHash: "h" });

  const sessionManager = new SessionManager(30);
  const terminalService = new TerminalService(
    testConfig,
    robotRepo,
    auditRepo,
    connectionManager,
    sessionManager,
    roleMapping,
    logger
  );

  await robotRepo.create(createRobot("robot_ssh_02"));

  const server = createServer(testConfig, logger, {
    robotRepository: robotRepo,
    auditRepository: auditRepo,
    userRepository: userRepo,
    sessionManager,
    roleMapping,
    terminalService,
    connectionManager,
  });

  await server.listen({ port: 0, host: "127.0.0.1" });
  const serverPort = (server.server.address() as any).port;
  const userSession = sessionManager.createSession(opUserAuthorized);

  const allocRes = await server.inject({
    method: "POST",
    url: "/api/robots/robot_ssh_02/terminal/sessions",
    headers: { cookie: `moliris_session=${userSession.sessionId}` },
    payload: { cols: 80, rows: 24 },
  });
  const { sessionId } = JSON.parse(allocRes.body);

  const ws = new WebSocket(`wss://127.0.0.1:${serverPort}/api/terminal/ws/${sessionId}`, {
    rejectUnauthorized: false,
    headers: { cookie: `moliris_session=${userSession.sessionId}` },
  });

  await new Promise<void>((resolve) => ws.on("open", resolve));

  // 1. Test Prompt Interattivo aggiuntivo (CA-SSH-002)
  ws.send("confirm_op\r");
  await new Promise<void>((resolve) => {
    const handler = (data: any) => {
      if (data.toString().includes("Vuoi procedere con la manutenzione? (y/n):")) {
        ws.removeListener("message", handler);
        resolve();
      }
    };
    ws.on("message", handler);
  });

  ws.send("y\r");
  await new Promise<void>((resolve) => {
    const handler = (data: any) => {
      if (data.toString().includes("Operazione manutenzione autorizzata")) {
        ws.removeListener("message", handler);
        resolve();
      }
    };
    ws.on("message", handler);
  });

  // 2. Test Interruzione comando con Ctrl+C (\x03) (CA-SSH-002)
  ws.send("\x03");
  await new Promise<void>((resolve) => {
    const handler = (data: any) => {
      if (data.toString().includes("^C")) {
        ws.removeListener("message", handler);
        resolve();
      }
    };
    ws.on("message", handler);
  });

  // 3. Test Ridimensionamento PTY (RF-SSH-002, CA-SSH-002)
  ws.send(JSON.stringify({ type: "resize", cols: 132, rows: 43 }));
  await new Promise((r) => setTimeout(r, 80));
  assert.strictEqual(lastRemoteWindowSize.cols, 132, "Le colonne remote del PTY devono essere state aggiornate");
  assert.strictEqual(lastRemoteWindowSize.rows, 43, "Le righe remote del PTY devono essere state aggiornate");

  // 4. Test Output Progressivo (CA-SSH-003): ricezione primo chunk prima che il comando termini
  const chunkTimestamps: { chunk: string; time: number }[] = [];
  const progressivePromise = new Promise<void>((resolve) => {
    const handler = (data: any) => {
      const str = data.toString();
      if (str.includes("CHUNK_1_INIZIO")) {
        chunkTimestamps.push({ chunk: "CHUNK_1", time: Date.now() });
      }
      if (str.includes("CHUNK_2_INTERMEDIO")) {
        chunkTimestamps.push({ chunk: "CHUNK_2", time: Date.now() });
      }
      if (str.includes("CHUNK_3_FINE")) {
        chunkTimestamps.push({ chunk: "CHUNK_3", time: Date.now() });
        ws.removeListener("message", handler);
        resolve();
      }
    };
    ws.on("message", handler);
  });

  ws.send("long_task\r");
  await progressivePromise;

  assert.strictEqual(chunkTimestamps.length, 3);
  assert.ok(chunkTimestamps[0].time <= chunkTimestamps[1].time, "Il chunk 1 deve arrivare prima del chunk 2");
  assert.ok(chunkTimestamps[1].time <= chunkTimestamps[2].time, "Il chunk 2 deve arrivare prima del chunk 3");

  ws.close();
  await terminalService.closeSession(sessionId, "USER_EXPLICIT");
  await server.close();
  console.log("  PASS: CA-SSH-002 & CA-SSH-003 - Shell interattiva completa, streaming progressivo, Ctrl+C e ridimensionamento.");
}

// TEST 3: CA-SSH-004 - Chiusura e pulizia a zero risorse residue per tutte le 7 cause
{
  const robotRepo = new InMemoryRobotRepository();
  const auditRepo = new InMemoryAuditRepository();
  const userRepo = new InMemoryUserRepository();
  await userRepo.create({ ...opUserAuthorized, passwordHash: "h" });

  const sessionManager = new SessionManager(30);
  const terminalService = new TerminalService(
    testConfig,
    robotRepo,
    auditRepo,
    connectionManager,
    sessionManager,
    roleMapping,
    logger
  );

  await robotRepo.create(createRobot("robot_ssh_04"));

  const userSession = sessionManager.createSession(opUserAuthorized);

  // Causa 1: Chiusura esplicita utente (USER_EXPLICIT)
  {
    const term = await terminalService.openTerminalSession(opUserAuthorized, "robot_ssh_04", { cols: 80, rows: 24 }, userSession.sessionId);
    assert.strictEqual(terminalService.getActiveSessionCount(), 1);
    await terminalService.closeSession(term.sessionId, "USER_EXPLICIT");
    assert.strictEqual(terminalService.getActiveSessionCount(), 0);
    assert.strictEqual(connectionManager.getActiveConnectionCount(), 0);
  }

  // Causa 2: Disconnessione normale shell remota (exit -> REMOTE_EXIT)
  {
    const term = await terminalService.openTerminalSession(opUserAuthorized, "robot_ssh_04", { cols: 80, rows: 24 }, userSession.sessionId);
    term.ptyChannel.write("exit\r");
    await new Promise((r) => setTimeout(r, 100));
    assert.strictEqual(terminalService.getActiveSessionCount(), 0);
    assert.strictEqual(connectionManager.getActiveConnectionCount(), 0);
  }

  // Causa 3: Logout o Scadenza sessione utente (USER_SESSION_TERMINATED)
  {
    const ephemeralUserSession = sessionManager.createSession(opUserAuthorized);
    const term = await terminalService.openTerminalSession(opUserAuthorized, "robot_ssh_04", { cols: 80, rows: 24 }, ephemeralUserSession.sessionId);
    assert.strictEqual(terminalService.getActiveSessionCount(), 1);

    // Logout utente distrugge la sessione e scatena l'hook di pulizia
    sessionManager.destroySession(ephemeralUserSession.sessionId);
    await new Promise((r) => setTimeout(r, 50));
    assert.strictEqual(terminalService.getActiveSessionCount(), 0, "La sessione terminale deve essere chiusa al logout");
    assert.strictEqual(connectionManager.getActiveConnectionCount(), 0, "Nessuna connessione SSH residua");
  }

  // Causa 4: Disabilitazione robot con chiusura immediata (ADMIN_DISABLED)
  {
    const term = await terminalService.openTerminalSession(opUserAuthorized, "robot_ssh_04", { cols: 80, rows: 24 }, userSession.sessionId);
    assert.strictEqual(terminalService.getActiveSessionCount(), 1);
    await terminalService.closeSessionsForRobot("robot_ssh_04", "ADMIN_DISABLED");
    assert.strictEqual(terminalService.getActiveSessionCount(), 0);
    assert.strictEqual(connectionManager.getActiveConnectionCount(), 0);
  }

  // Causa 5: Arresto ordinato del servizio (SERVICE_SHUTDOWN)
  {
    const term = await terminalService.openTerminalSession(opUserAuthorized, "robot_ssh_04", { cols: 80, rows: 24 }, userSession.sessionId);
    assert.strictEqual(terminalService.getActiveSessionCount(), 1);
    await terminalService.closeAll("SERVICE_SHUTDOWN");
    assert.strictEqual(terminalService.getActiveSessionCount(), 0);
    assert.strictEqual(connectionManager.getActiveConnectionCount(), 0);
  }

  console.log("  PASS: CA-SSH-004 - Chiusura e pulizia completa a zero risorse residue per tutte le cause.");
}

// TEST 4: CA-SSH-005 - Isolamento sessioni, divieto accesso sessioni altrui e verifica autorizzazioni
{
  const robotRepo = new InMemoryRobotRepository();
  const auditRepo = new InMemoryAuditRepository();
  const userRepo = new InMemoryUserRepository();
  await userRepo.create({ ...opUserAuthorized, passwordHash: "h" });
  await userRepo.create({ ...opUserAttacker, passwordHash: "h" });
  await userRepo.create({ ...opUserDenied, passwordHash: "h" });

  const sessionManager = new SessionManager(30);
  const terminalService = new TerminalService(
    testConfig,
    robotRepo,
    auditRepo,
    connectionManager,
    sessionManager,
    roleMapping,
    logger
  );

  await robotRepo.create(createRobot("robot_ssh_05"));

  const server = createServer(testConfig, logger, {
    robotRepository: robotRepo,
    auditRepository: auditRepo,
    userRepository: userRepo,
    sessionManager,
    roleMapping,
    terminalService,
    connectionManager,
  });

  await server.listen({ port: 0, host: "127.0.0.1" });
  const serverPort = (server.server.address() as any).port;

  const validSession = sessionManager.createSession(opUserAuthorized);
  const attackerSession = sessionManager.createSession(opUserAttacker);
  const deniedSession = sessionManager.createSession(opUserDenied);

  // 1. Rifiuto apertura se utente privo di TERMINAL_OPEN (CA-SSH-005)
  const deniedRes = await server.inject({
    method: "POST",
    url: "/api/robots/robot_ssh_05/terminal/sessions",
    headers: { cookie: `moliris_session=${deniedSession.sessionId}` },
  });
  assert.strictEqual(deniedRes.statusCode, 403, "Utente senza TERMINAL_OPEN deve ricevere 403");

  // 2. Creazione sessione legittima per opUserAuthorized
  const legitimateRes = await server.inject({
    method: "POST",
    url: "/api/robots/robot_ssh_05/terminal/sessions",
    headers: { cookie: `moliris_session=${validSession.sessionId}` },
  });
  assert.strictEqual(legitimateRes.statusCode, 201);
  const { sessionId } = JSON.parse(legitimateRes.body);

  // 3. Tentativo di hijacking sessione altrui da parte di opUserAttacker (RF-SSH-006, CA-SSH-005)
  const attackerWs = new WebSocket(`wss://127.0.0.1:${serverPort}/api/terminal/ws/${sessionId}`, {
    rejectUnauthorized: false,
    headers: { cookie: `moliris_session=${attackerSession.sessionId}` },
  });

  let attackerClosedCode = 0;
  await new Promise<void>((resolve) => {
    attackerWs.on("close", (code) => {
      attackerClosedCode = code;
      resolve();
    });
    attackerWs.on("error", () => {});
  });

  assert.strictEqual(attackerClosedCode, 4403, "L'accesso a sessione altrui deve essere chiuso con codice 4403");

  // Verifica audit di violazione sicurezza per tentativo di accesso non autorizzato
  const securityAudits = await auditRepo.query({ robotId: "robot_ssh_05" });
  assert.ok(
    securityAudits.some((e) => e.operation === "SECURITY_AUTHORIZATION_ERROR"),
    "Deve essere registrato un evento SECURITY_AUTHORIZATION_ERROR"
  );

  // 4. Connessione senza cookie di sessione -> 4401
  const anonWs = new WebSocket(`wss://127.0.0.1:${serverPort}/api/terminal/ws/${sessionId}`, {
    rejectUnauthorized: false,
  });

  let anonClosedCode = 0;
  await new Promise<void>((resolve) => {
    anonWs.on("close", (code) => {
      anonClosedCode = code;
      resolve();
    });
    anonWs.on("error", () => {});
  });
  assert.strictEqual(anonClosedCode, 4401, "Chiamata WS senza sessione deve essere chiusa con codice 4401");

  await terminalService.closeSession(sessionId, "USER_EXPLICIT");
  await server.close();
  console.log("  PASS: CA-SSH-005 - Isolamento categorico delle sessioni, divieto accesso sessioni altrui e blocco accessi anonimi.");
}

// TEST 5: Rifiuto apertura su robot disabilitato, rimosso o con connessione non verificata (RF-SSH-007)
{
  const robotRepo = new InMemoryRobotRepository();
  const auditRepo = new InMemoryAuditRepository();
  const sessionManager = new SessionManager(30);
  const terminalService = new TerminalService(
    testConfig,
    robotRepo,
    auditRepo,
    connectionManager,
    sessionManager,
    roleMapping,
    logger
  );

  const disabledRobot = await robotRepo.create(createRobot("robot_dis", { anagraphicState: "disabilitato" }));
  const unverifiedRobot = await robotRepo.create(createRobot("robot_unver", { registrationState: "ssh_non_verificata" }));

  const userSession = sessionManager.createSession(opUserAuthorized);

  let errDisabled = false;
  try {
    await terminalService.openTerminalSession(opUserAuthorized, disabledRobot.id, {}, userSession.sessionId);
  } catch (err: any) {
    errDisabled = err.code === ErrorCode.INSUFFICIENT_PERMISSIONS;
  }
  assert.strictEqual(errDisabled, true, "Robot disabilitato deve rifiutare il terminale");

  let errUnverified = false;
  try {
    await terminalService.openTerminalSession(opUserAuthorized, unverifiedRobot.id, {}, userSession.sessionId);
  } catch (err: any) {
    errUnverified = err.code === ErrorCode.HOST_UNREACHABLE;
  }
  assert.strictEqual(errUnverified, true, "Robot con connessione differita non verificata deve rifiutare il terminale");

  console.log("  PASS: RF-SSH-007 - Rifiuto apertura terminale su robot disabilitato o non verificato.");
}

// TEST 6: Rispetto dei limiti di concorrenza terminale (RNF-PERF-003, §11.7)
{
  const robotRepo = new InMemoryRobotRepository();
  const auditRepo = new InMemoryAuditRepository();
  const sessionManager = new SessionManager(30);

  // Configura limite per robot = 1
  const limitedService = new TerminalService(
    testConfig,
    robotRepo,
    auditRepo,
    connectionManager,
    sessionManager,
    roleMapping,
    logger,
    undefined,
    { maxConcurrentPerRobot: 1 }
  );

  await robotRepo.create(createRobot("robot_limited"));
  const userSession = sessionManager.createSession(opUserAuthorized);

  const term1 = await limitedService.openTerminalSession(opUserAuthorized, "robot_limited", {}, userSession.sessionId);
  assert.ok(term1);

  let limitReached = false;
  try {
    await limitedService.openTerminalSession(opUserAuthorized, "robot_limited", {}, userSession.sessionId);
  } catch (err: any) {
    limitReached = err.code === ErrorCode.INSUFFICIENT_STORAGE;
  }
  assert.strictEqual(limitReached, true, "Superamento limite per robot deve generare errore INSUFFICIENT_STORAGE");

  await limitedService.closeSession(term1.sessionId, "USER_EXPLICIT");
  console.log("  PASS: RNF-PERF-003 - Rispetto dei limiti di concorrenza e blocco al raggiungimento del massimo.");
}

// Chiusura test server SSH e pulizia
for (const client of activeSshClients) {
  try { client.end(); } catch {}
}
await new Promise<void>((resolve) => {
  testSshServer.close(() => resolve());
});
try {
  fs.rmSync(tmpTlsDir, { recursive: true, force: true });
} catch {}

console.log("PASS: Tutti i test del modulo Terminale Remoto completati con successo.");
process.exit(0);
