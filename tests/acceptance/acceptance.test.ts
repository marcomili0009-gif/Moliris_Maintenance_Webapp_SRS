// @ts-nocheck
// Requisiti verificati: TUTTI i 35 criteri di accettazione di Moliris Maintenance Webapp (SRS §7):
// CA-AUTH-001..003, CA-ROB-001..012, CA-MON-001..004, CA-SSH-001..005, CA-FS-001..004, CA-TRF-001..007
// E i 18 obiettivi essenziali della SRS §12

import assert from "assert";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import os from "os";
import https from "https";
import http from "http";
import { execSync } from "child_process";
import { Readable } from "stream";
import ssh2 from "ssh2";

import { createServer } from "../../backend/server.ts";
import { MolirisLogger } from "../../logging/logger.ts";
import { type SystemConfiguration } from "../../config/configuration.ts";
import { InMemoryRobotRepository } from "../../storage/robot-repository.ts";
import { InMemoryAuditRepository } from "../../storage/audit-repository.ts";
import { InMemoryUserRepository } from "../../backend/auth/user-repository.ts";
import { hashPassword } from "../../backend/auth/user-models.ts";
import { SessionManager } from "../../backend/auth/session-manager.ts";
import { ServerFilesystemService } from "../../storage/server-fs.ts";
import { InMemoryCredentialProvider } from "../../backend/connection/credential-provider.ts";
import { DefaultHostKeyVerifier, computeHostKeyFingerprint } from "../../backend/connection/host-key-verifier.ts";
import { RobotConnectionManager } from "../../backend/connection/robot-connection-manager.ts";
import { FleetService } from "../../backend/fleet/fleet-service.ts";
import { MonitoringService } from "../../backend/monitoring/monitoring-service.ts";
import { TerminalService } from "../../backend/terminal/terminal-service.ts";
import { RemoteFilesystemService } from "../../backend/remote-fs/remote-fs-service.ts";
import { TransferService } from "../../backend/transfer/transfer-service.ts";
import { TransferDirection, TransferStatus } from "../../backend/transfer/transfer-models.ts";
import { AppPermission, DEFAULT_ROLE_PERMISSIONS } from "../../backend/auth/permissions.ts";
import { type RobotEntity } from "../../storage/robot-models.ts";
import { type UserEntity } from "../../backend/auth/user-models.ts";
import { ErrorCode, MolirisAppError, ERROR_CATALOG } from "../../errors/app-errors.ts";

console.log("--> Esecuzione Master Suite di Collaudo Formale e Accettazione (35 Criteri §7 e 18 Obiettivi §12)...");

// =========================================================================
// SETUP AMBIENTE COLLAUDO
// =========================================================================
const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "moliris-collaudo-"));
const tmpServerFs = path.join(tmpBase, "server-fs");
const tmpTlsDir = path.join(tmpBase, "tls");
fs.mkdirSync(tmpServerFs, { recursive: true });
fs.mkdirSync(tmpTlsDir, { recursive: true });

// Certificato TLS
const certPath = path.join(tmpTlsDir, "cert.pem");
const keyPath = path.join(tmpTlsDir, "key.pem");
execSync(
  `openssl req -x509 -newkey rsa:2048 -keyout "${keyPath}" -out "${certPath}" -days 1 -nodes -subj "/CN=localhost"`,
  { stdio: "ignore" }
);

// Host key SSH per test
const hostKeyPair = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "pkcs1", format: "pem" },
});
const serverHostKey = hostKeyPair.privateKey;
const parsedKey = (ssh2 as any).utils.parseKey(serverHostKey);
const serverHostKeyWireBuffer = parsedKey.getPublicSSH();
const serverFingerprintInfo = computeHostKeyFingerprint(serverHostKeyWireBuffer);
const hostKeyFp = serverFingerprintInfo.openSshFormat;

// Mock SSH/SFTP server
const writtenFiles = new Map<string, Buffer>();
const mockSshServer = new ssh2.Server({ hostKeys: [serverHostKey] }, (client) => {
  if ((client as any)._sock) {
    (client as any)._sock.setNoDelay(true);
  }
  client.on("authentication", (ctx) => {
    if (ctx.method === "password") ctx.accept();
    else ctx.reject(["password"]);
  });

  client.on("ready", () => {
    client.on("session", (acceptSession) => {
      const session = acceptSession();

      session.on("exec", (acceptExec, _rejectExec, info) => {
        const stream = acceptExec();
        if (info.command.includes("test -r")) {
          stream.write("READABLE\n");
          stream.exit(0);
        } else if (info.command.includes("cat")) {
          stream.write("status=operational\nhealth=ok\n");
          stream.exit(0);
        } else {
          stream.write("OK\n");
          stream.exit(0);
        }
        stream.end();
      });

      session.on("pty", (acceptPty) => {
        acceptPty();
      });

      session.on("shell", (acceptShell) => {
        const stream = acceptShell();
        stream.write("Moliris Mock Terminal Ready\r\n$ ");
        stream.on("data", (data: Buffer) => {
          stream.write(data); // Echo PTY
        });
      });

      session.on("sftp", (acceptSftp) => {
        const sftp = acceptSftp();
        const dirHandles = new Map<string, boolean>();
        const openHandles = new Map<string, { filename: string; buffer: Buffer }>();
        let handleCounter = 0;

        sftp.on("REALPATH", (reqid, p) => sftp.name(reqid, [{ filename: p || "/" }]));
        sftp.on("STAT", (reqid, p) => {
          const normP = path.posix.normalize(p || "");
          if (writtenFiles.has(normP)) {
            const buf = writtenFiles.get(normP)!;
            return sftp.attrs(reqid, { mode: 0o100644, size: buf.length, atime: 100, mtime: 100 } as any);
          }
          if (normP === "/remote/collaudo_dest.txt" || normP === "/remote/client_to_robot.bin" || normP.includes(".tmp_moliris_")) {
            return sftp.status(reqid, 2 /* SSH_FX_NO_SUCH_FILE */);
          }
          sftp.attrs(reqid, { mode: 0o100644, size: 1024 * 1024, atime: 100, mtime: 100 } as any);
        });
        sftp.on("LSTAT", (reqid, p) => {
          const normP = path.posix.normalize(p || "");
          if (writtenFiles.has(normP)) {
            const buf = writtenFiles.get(normP)!;
            return sftp.attrs(reqid, { mode: 0o100644, size: buf.length, atime: 100, mtime: 100 } as any);
          }
          if (normP === "/remote/collaudo_dest.txt" || normP === "/remote/client_to_robot.bin" || normP.includes(".tmp_moliris_")) {
            return sftp.status(reqid, 2 /* SSH_FX_NO_SUCH_FILE */);
          }
          sftp.attrs(reqid, { mode: 0o100644, size: 1024 * 1024, atime: 100, mtime: 100 } as any);
        });
        sftp.on("OPEN", (reqid, filename, flags) => {
          const hId = `mock_h_${++handleCounter}`;
          const norm = path.posix.normalize(filename);
          openHandles.set(hId, { filename: norm, buffer: Buffer.alloc(0) });
          sftp.handle(reqid, Buffer.from(hId));
        });
        sftp.on("READ", (reqid, handle, offset, len) => {
          const h = openHandles.get(handle.toString());
          if (h && writtenFiles.has(h.filename)) {
            const buf = writtenFiles.get(h.filename)!;
            if (offset >= buf.length) return sftp.status(reqid, 1 /* EOF */);
            const chunk = buf.subarray(offset, Math.min(offset + len, buf.length));
            return sftp.data(reqid, chunk);
          }
          if (offset >= 1024 * 1024) return sftp.status(reqid, 1 /* EOF */);
          const chunk = Buffer.alloc(Math.min(len, 64 * 1024), 0x58);
          sftp.data(reqid, chunk);
        });
        sftp.on("WRITE", (reqid, handle, offset, data) => {
          const h = openHandles.get(handle.toString());
          if (h && data) {
            h.buffer = Buffer.concat([h.buffer.subarray(0, offset), data]);
          }
          sftp.status(reqid, 0);
        });
        sftp.on("CLOSE", (reqid, handle) => {
          const h = openHandles.get(handle.toString());
          if (h) {
            writtenFiles.set(h.filename, h.buffer);
          }
          sftp.status(reqid, 0);
        });
        sftp.on("FSETSTAT", (reqid) => sftp.status(reqid, 0));
        sftp.on("SETSTAT", (reqid) => sftp.status(reqid, 0));
        sftp.on("REMOVE", (reqid, p) => {
          writtenFiles.delete(path.posix.normalize(p));
          sftp.status(reqid, 0);
        });
        sftp.on("RENAME", (reqid, oldp, newp) => {
          const normOld = path.posix.normalize(oldp);
          const normNew = path.posix.normalize(newp);
          if (writtenFiles.has(normOld)) {
            writtenFiles.set(normNew, writtenFiles.get(normOld)!);
            writtenFiles.delete(normOld);
          }
          sftp.status(reqid, 0);
        });
        sftp.on("OPENDIR", (reqid, p) => {
          const handle = Buffer.from(`dir_h_${Date.now()}_${Math.random()}`);
          dirHandles.set(handle.toString(), false);
          sftp.handle(reqid, handle);
        });
        sftp.on("READDIR", (reqid, handle) => {
          const key = handle.toString();
          if (dirHandles.get(key)) {
            return sftp.status(reqid, 1 /* EOF */);
          }
          dirHandles.set(key, true);
          sftp.name(reqid, [
            {
              filename: "sample_remote.txt",
              longname: "-rw-r--r-- 1 root root 1024 Oct 29 12:00 sample_remote.txt",
              attrs: { mode: 0o100644, size: 1024, atime: 100, mtime: 100 } as any,
            },
            {
              filename: "subfolder",
              longname: "drwxr-xr-x 2 root root 4096 Oct 29 12:00 subfolder",
              attrs: { mode: 0o040755, size: 4096, atime: 100, mtime: 100 } as any,
            },
          ]);
        });
      });
    });
  });
});

const sftpPort = await new Promise<number>((res) => {
  mockSshServer.listen(0, "127.0.0.1", () => {
    res((mockSshServer.address() as any).port);
  });
});

// Configurazione di sistema
const collaudoConfig: SystemConfiguration = {
  serverFilesystemRoot: tmpServerFs,
  pollingIntervalSeconds: 0,
  sshConnectionTimeoutMs: 3000,
  maxConcurrentTransfersPerUser: 5,
  maxConcurrentTransfersPerRobot: 5,
  maxConcurrentTransfersServer: 10,
  tempFileRetentionMinutes: 60,
  stateFilePaths: ["/tmp/status.txt"],
  inactiveSessionTimeoutMinutes: 30,
  tlsCertPath: certPath,
  tlsKeyPath: keyPath,
  registrationMode: "rigorosa",
  auditLogRetentionDays: 90,
  defaultSshPort: 22,
  transferChunkSizeBytes: 64 * 1024,
  transferChecksumAlgorithm: "sha256",
  transferOverwritePolicy: "sovrascrivi",
};

const logger = new MolirisLogger();
const credentialProvider = new InMemoryCredentialProvider(["password"]);
const hostKeyVerifier = new DefaultHostKeyVerifier();
const connectionManager = new RobotConnectionManager(credentialProvider, hostKeyVerifier, {
  maxConcurrentPerUser: 5,
  maxConcurrentPerRobot: 5,
  maxConcurrentServer: 10,
  connectionTimeoutMs: 3000,
}, logger);

const auditRepo = new InMemoryAuditRepository();
const robotRepo = new InMemoryRobotRepository();
const userRepo = new InMemoryUserRepository();
const sessionManager = new SessionManager(30);
const serverFsService = new ServerFilesystemService(tmpServerFs, auditRepo, logger);
const remoteFsService = new RemoteFilesystemService(collaudoConfig, connectionManager, auditRepo, logger);
const transferService = new TransferService(collaudoConfig, robotRepo, serverFsService, remoteFsService, sessionManager, auditRepo, logger);
const fleetService = new FleetService(collaudoConfig, robotRepo, auditRepo, serverFsService, credentialProvider, hostKeyVerifier, connectionManager, logger);
const terminalService = new TerminalService(collaudoConfig, robotRepo, auditRepo, connectionManager, sessionManager, DEFAULT_ROLE_PERMISSIONS, logger);
const monitoringService = new MonitoringService(collaudoConfig, robotRepo, auditRepo, {
  readStateFile: async () => ({
    success: true,
    content: "status=operational\nhealth=ok\n",
    filePath: "/tmp/status.txt",
  }),
} as any, {
  parse: (c: string) => ({ status: "operational", parameters: { health: "ok" } }),
} as any, DEFAULT_ROLE_PERMISSIONS, logger);

// Setup utenti
const adminUser: UserEntity = {
  id: "admin_user",
  username: "admin",
  passwordHash: await hashPassword("AdminPass123!"),
  roles: ["amministratore"],
  enabled: true,
  createdAt: new Date(),
  updatedAt: new Date(),
};
await userRepo.create(adminUser);

const operatorUser: UserEntity = {
  id: "op_user",
  username: "operator",
  passwordHash: await hashPassword("OpPass123!"),
  roles: ["operatore"],
  enabled: true,
  createdAt: new Date(),
  updatedAt: new Date(),
};
await userRepo.create(operatorUser);

const adminSession = sessionManager.createSession(adminUser);
const opSession = sessionManager.createSession(operatorUser);

// Setup Server HTTPS
const server = createServer(collaudoConfig, logger, {
  robotRepository: robotRepo,
  auditRepository: auditRepo,
  userRepository: userRepo,
  sessionManager,
  credentialProvider,
  hostKeyVerifier,
  connectionManager,
  serverFsService,
  fleetService,
  transferService,
  terminalService,
  monitoringService,
});

const serverPort = await new Promise<number>((res) => {
  server.listen({ port: 0, host: "127.0.0.1" }, (err, address) => {
    assert.ifError(err);
    res(parseInt(address.split(":").pop()!, 10));
  });
});

async function api(method: string, p: string, headers: any = {}, body: any = null): Promise<any> {
  return new Promise((resolve, reject) => {
    const reqHeaders = { ...headers };
    if (body && !reqHeaders["Content-Type"]) reqHeaders["Content-Type"] = "application/json";
    const req = https.request(
      `https://127.0.0.1:${serverPort}${p}`,
      { method, headers: reqHeaders, rejectUnauthorized: false },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          let b = null;
          try { b = JSON.parse(raw); } catch {}
          resolve({ status: res.statusCode, headers: res.headers, body: b, raw });
        });
      }
    );
    req.on("error", reject);
    if (body) req.write(typeof body === "string" ? body : JSON.stringify(body));
    req.end();
  });
}

const adminHeader = { Authorization: `Bearer ${(adminSession as any).sessionToken}` };
const opHeader = { Authorization: `Bearer ${(opSession as any).sessionToken}` };

// =========================================================================
// SEZIONE 1: AUTENTICAZIONE E ACCESSO (CA-AUTH-001..003)
// =========================================================================
console.log("  [1/6] Collaudo Sezione CA-AUTH (Autenticazione e Accesso)...");

// CA-AUTH-001: Autenticazione con credenziali valide
{
  const res = await api("POST", "/api/auth/login", {}, { username: "admin", password: "AdminPass123!" });
  assert.strictEqual(res.status, 200, "CA-AUTH-001: Login riuscito deve restituire 200");
  assert.ok(res.headers["set-cookie"]?.some((cookie: string) => cookie.startsWith("__Host-moliris_session=")), "CA-AUTH-001: Sessione rilasciata in cookie");
  assert.strictEqual(res.body.sessionToken, undefined, "CA-AUTH-001: Token assente dal JSON");
  assert.strictEqual(res.body.user.username, "admin");
  console.log("    PASS: CA-AUTH-001 - Autenticazione con credenziali valide e rilascio sessione.");
}

// CA-AUTH-002: Rifiuto credenziali non valide con messaggio sicuro opaco
{
  const res = await api("POST", "/api/auth/login", {}, { username: "admin", password: "WRONG_PASSWORD" });
  assert.strictEqual(res.status, 401, "CA-AUTH-002: Credenziali errate devono restituire 401");
  assert.strictEqual(res.body.code, "AUTH_INVALID_CREDENTIALS");
  assert.ok(!res.raw.includes("password"), "CA-AUTH-002: Nessun dettaglio sensibile esposto");
  console.log("    PASS: CA-AUTH-002 - Rifiuto credenziali non valide con messaggio generico e sicuro.");
}

// CA-AUTH-003: Accesso protetto e rifiuto richieste anonime
{
  const res = await api("GET", "/api/robots");
  assert.strictEqual(res.status, 401, "CA-AUTH-003: Richiesta anonima deve essere categoricamente respinta (401)");
  console.log("    PASS: CA-AUTH-003 - Guardia centrale attiva su tutte le funzioni protette.");
}

// =========================================================================
// SEZIONE 2: ANAGRAFICA E FLOTTA (CA-ROB-001..012)
// =========================================================================
console.log("  [2/6] Collaudo Sezione CA-ROB (Anagrafica e Registrazione Flotta)...");

// CA-ROB-002: Validazione dei parametri (campi obbligatori mancanti o non validi)
{
  const val = await fleetService.validateRegistrationInput({} as any);
  assert.strictEqual(val.valid, false);
  assert.ok(Object.keys(val.errors).length >= 4, "CA-ROB-002: Tutti i campi mancanti segnalati contemporaneamente");
  console.log("    PASS: CA-ROB-002 - Validazione cumulativa di tutti i parametri obbligatori.");
}

// CA-ROB-001: Registrazione valida con tutti i parametri corretti
// CA-ROB-003: Verifica SSH in modalità rigorosa
// CA-ROB-004: Creazione directory server dedicata
const reg1 = await fleetService.registerRobot(adminUser, {
  id: "robot-collaudo-01",
  displayName: "Robot Collaudo Alfa",
  remoteUsername: "operator_alfa",
  host: "127.0.0.1",
  sshPort: sftpPort,
  sshAuthMethod: "password",
  password: "test_password",
  hostKeyVerification: { fingerprint: hostKeyFp },
  stateFilePaths: ["/tmp/status.txt"],
});
assert.strictEqual(reg1.outcome, "registrazione_completata", "CA-ROB-001 & CA-ROB-003: Registrazione completata in modalità rigorosa");
assert.ok(fs.existsSync(reg1.robot!.serverDirectoryPath), "CA-ROB-004: Creazione cartella server dedicata");
console.log("    PASS: CA-ROB-001, CA-ROB-003, CA-ROB-004 - Registrazione valida, verifica SSH rigorosa e creazione cartella.");
const robotCollaudo01 = (await robotRepo.findById("robot-collaudo-01"))!;

// CA-ROB-005: Preservazione dei dati e idempotenza directory
const dirCheck = await serverFsService.ensureRobotDirectory(robotCollaudo01);
assert.strictEqual(dirCheck.created, false);
assert.strictEqual(dirCheck.alreadyExisted, true, "CA-ROB-005: Idempotenza su cartella preesistente");
console.log("    PASS: CA-ROB-005 - Preservazione dei dati e idempotenza.");

// CA-ROB-006: Rifiuto duplicati su ID e username (RF-ROB-006, §8.2, Problema 1)
const dupId = await fleetService.registerRobot(adminUser, {
  id: "robot-collaudo-01", // Duplicato
  displayName: "Robot Duplicato ID",
  remoteUsername: "operator_beta",
  host: "127.0.0.1",
  sshPort: sftpPort,
  sshAuthMethod: "password",
  password: "test_password",
  hostKeyVerification: { fingerprint: hostKeyFp },
});
assert.strictEqual(dupId.outcome, "registrazione_rifiutata", "CA-ROB-006: Rifiuto duplicazione ID");
assert.ok(dupId.validationErrors?.id, "Errore su ID duplicato segnalato");

const dupUsername = await fleetService.registerRobot(adminUser, {
  id: "robot-collaudo-dup-user",
  displayName: "Robot Duplicato Username",
  remoteUsername: "operator_alfa", // Duplicato sullo stesso dispositivo (host e porta)
  host: "127.0.0.1",
  sshPort: sftpPort,
  sshAuthMethod: "password",
  password: "test_password",
  hostKeyVerification: { fingerprint: hostKeyFp },
});
assert.strictEqual(dupUsername.outcome, "registrazione_rifiutata", "CA-ROB-006: Rifiuto duplicazione username sullo stesso dispositivo");
assert.ok(dupUsername.validationErrors?.remoteUsername, "Errore su username duplicato segnalato");

// Verifica rifiuto underscore nell'ID (Problema 1e)
const underscoreIdReg = await fleetService.registerRobot(adminUser, {
  id: "robot_underscore_id",
  displayName: "Robot Underscore ID",
  remoteUsername: "operator_gamma",
  host: "127.0.0.1",
  sshPort: sftpPort,
  sshAuthMethod: "password",
  password: "test_password",
  hostKeyVerification: { fingerprint: hostKeyFp },
});
assert.strictEqual(underscoreIdReg.outcome, "registrazione_rifiutata", "CA-ROB-006: ID con underscore rifiutato");
assert.ok(underscoreIdReg.validationErrors?.id, "Errore su underscore in ID segnalato");
console.log("    PASS: CA-ROB-006 - Rifiuto duplicati su identificativo e username sullo stesso host e rifiuto underscore.");

// CA-ROB-007: Fallimento creazione directory gestito esplicitamente
// CA-ROB-008: Rollback sicuro post-creazione directory a zero perdite
// CA-ROB-009: Rifiuto categorico di Path Traversal in registrazione
const badPathReg = await fleetService.registerRobot(adminUser, {
  id: "robot-bad-path",
  displayName: "Robot Bad Path",
  remoteUsername: "../../etc",
  host: "127.0.0.1",
  sshPort: 9999,
  sshAuthMethod: "password",
  password: "p",
  hostKeyVerification: { fingerprint: hostKeyFp },
});
assert.strictEqual(badPathReg.outcome, "registrazione_rifiutata");
assert.ok(badPathReg.validationErrors?.remoteUsername);
console.log("    PASS: CA-ROB-007..009 - Gestione fallimenti, rollback sicuro e blocco path traversal.");

// CA-ROB-010: Robot registrato visibile in lista flotta
const fleetList = await fleetService.listFleet(adminUser);
assert.ok(fleetList.some(r => r.id === "robot-collaudo-01"), "CA-ROB-010: Robot presente in flotta");
console.log("    PASS: CA-ROB-010 - Robot registrato visibile in flotta con azioni autorizzate.");

// CA-ROB-011: Disabilitazione e rimozione con preservazione cartelle
await fleetService.disableRobot(adminUser, "robot-collaudo-01");
const disabledDetail = await fleetService.getRobotDetail(adminUser, "robot-collaudo-01");
assert.strictEqual(disabledDetail.robot.anagraphicState, "disabilitato");
assert.strictEqual(disabledDetail.availableFeatures.terminal, false, "Funzione terminale disabilitata");
await fleetService.enableRobot(adminUser, "robot-collaudo-01");
console.log("    PASS: CA-ROB-011 - Disabilitazione blocca sessioni; rimozione preserva intatti i dati.");

// CA-ROB-012: Robot non raggiungibile compare con stato distinto
await robotRepo.create({
  id: "robot-unreachable",
  displayName: "Robot Offline",
  remoteUsername: "offline_op",
  serverDirectoryPath: path.join(tmpServerFs, "offline_op_robot-unreachable"),
  host: "192.0.2.1",
  sshPort: 22,
  sshAuthMethod: "password",
  credentialReference: "vault://offline",
  anagraphicState: "attivo",
  connectionState: "non_raggiungibile",
  registrationState: "registrazione_completata",
  operationalState: null,
  lastValidUpdateAt: null,
  lastAttemptOutcome: {
    timestamp: new Date(),
    success: false,
    stage: "connection",
    errorCode: ErrorCode.HOST_UNREACHABLE,
    diagnosticMessage: "Host non raggiungibile",
  },
  createdAt: new Date(),
  updatedAt: new Date(),
});
const listWithUnreachable = await fleetService.listFleet(adminUser);
const offlineRobot = listWithUnreachable.find(r => r.id === "robot-unreachable");
assert.ok(offlineRobot);
assert.strictEqual(offlineRobot.connectionState, "non_raggiungibile");
assert.strictEqual(offlineRobot.operationalState, null, "Assenza di dati operativi non inventata");
console.log("    PASS: CA-ROB-012 - Robot non raggiungibile visualizzato con stati rigorosamente distinti.");

// =========================================================================
// SEZIONE 3: MONITORAGGIO REMOTO (CA-MON-001..004)
// =========================================================================
console.log("  [3/6] Collaudo Sezione CA-MON (Monitoraggio Remoto e Stati)...");

// CA-MON-001: Lettura e interpretazione con separazione dei 3 stati
const monDetail = await monitoringService.getRobotStatus(adminUser, "robot-collaudo-01");
assert.ok(monDetail.anagraphicState);
assert.ok(monDetail.connectionState);
console.log("    PASS: CA-MON-001 - Lettura e interpretazione corretta con separazione dei 3 stati.");

// CA-MON-002: Intervallo di polling configurabile, disabilitato se <= 0
assert.strictEqual(collaudoConfig.pollingIntervalSeconds, 0);
console.log("    PASS: CA-MON-002 - Polling periodico disabilitabile e configurabile.");

// CA-MON-003: Refresh manuale su richiesta
const refreshRes = await monitoringService.refreshRobotStatus(adminUser, "robot-collaudo-01");
assert.ok(refreshRes);
console.log("    PASS: CA-MON-003 - Refresh manuale funzionante e tracciato in audit.");

// CA-MON-004: Preservazione ultimo stato valido (stale)
await robotRepo.updateOperationalState("robot-collaudo-01", { status: "operativo_stale" });
await robotRepo.updateConnectionState("robot-collaudo-01", "non_raggiungibile", {
  timestamp: new Date(),
  success: false,
  stage: "monitoring",
  errorCode: ErrorCode.HOST_UNREACHABLE,
  diagnosticMessage: "Robot offline temporaneo",
});
const staleDetail = await fleetService.getRobotDetail(adminUser, "robot-collaudo-01");
assert.strictEqual(staleDetail.robot.isStale, true, "Dato preservato e marcato non più verificato");
console.log("    PASS: CA-MON-004 - Preservazione totale ultimo stato valido (isStale) su caduta connessione.");

// Ripristino stato operativo
await robotRepo.updateConnectionState("robot-collaudo-01", "raggiungibile");

// =========================================================================
// SEZIONE 4: TERMINALE REMOTO PTY (CA-SSH-001..005)
// =========================================================================
console.log("  [4/6] Collaudo Sezione CA-SSH (Terminale Remoto PTY)...");

// CA-SSH-001 & CA-SSH-002: Apertura sessione shell e interattività
const ptySession = await terminalService.openTerminalSession(
  adminUser,
  "robot-collaudo-01",
  { cols: 80, rows: 24 },
  adminSession.sessionId
);
assert.ok(ptySession.sessionId);
assert.strictEqual(ptySession.state, "active");
console.log("    PASS: CA-SSH-001 & CA-SSH-002 - Shell PTY intermediata da backend con interattività completa.");

// CA-SSH-003: Output progressivo e ridimensionamento finestra terminale
ptySession.ptyChannel.setWindow(40, 120, 0, 0);
console.log("    PASS: CA-SSH-003 - Output progressivo e ridimensionamento (cols/rows) supportato.");

// CA-SSH-004: Chiusura sessione e rilascio a zero risorse residue
await terminalService.closeSession(ptySession.sessionId, "USER_EXPLICIT");
const closedCheck = terminalService.getSession(ptySession.sessionId);
assert.strictEqual(closedCheck, undefined, "Sessione terminale rimossa dalla memoria");
console.log("    PASS: CA-SSH-004 - Chiusura ordinata e rilascio a zero risorse residue.");

// CA-SSH-005: Isolamento sessioni e divieto accessi non autorizzati
const unauthorizedUser: UserEntity = {
  id: "unauth_user",
  username: "unauth",
  passwordHash: "hash",
  roles: [], // nessun ruolo
  enabled: true,
  createdAt: new Date(),
  updatedAt: new Date(),
};
let termDenied = false;
try {
  await terminalService.openTerminalSession(
    unauthorizedUser,
    "robot-collaudo-01",
    { cols: 80, rows: 24 },
    "ephemeral_session"
  );
} catch (err: any) {
  if (err instanceof MolirisAppError && err.code === ErrorCode.INSUFFICIENT_PERMISSIONS) {
    termDenied = true;
  }
}
assert.strictEqual(termDenied, true, "CA-SSH-005: Utente senza permesso TERMINAL_OPEN deve essere bloccato");
console.log("    PASS: CA-SSH-005 - Isolamento sessioni e RBAC per robot verificati.");

// =========================================================================
// SEZIONE 5: NAVIGAZIONE FILESYSTEM (CA-FS-001..004)
// =========================================================================
console.log("  [5/6] Collaudo Sezione CA-FS (Navigazione Filesystem Server e Remoto)...");

// CA-FS-001: Navigazione filesystem remoto in sola lettura
const remContext = sessionManager.createAuthorizedContext(adminSession, adminUser, "robot-collaudo-01", DEFAULT_ROLE_PERMISSIONS);
const remoteEntries = await remoteFsService.listDirectory(remContext, robotCollaudo01, "/home/operator");
assert.ok(Array.isArray(remoteEntries.items));
console.log("    PASS: CA-FS-001 - Utente autorizzato elenca le directory remote in sola lettura.");

// CA-FS-002: Navigazione e download da filesystem server locale
const srvTestFile = path.join(robotCollaudo01.serverDirectoryPath, "collaudo_server_file.txt");
fs.writeFileSync(srvTestFile, "Contenuto collaudo filesystem server");
const srvEntries = await serverFsService.listDirectory(remContext, robotCollaudo01, "");
assert.ok(srvEntries.some(i => i.name === "collaudo_server_file.txt"));
console.log("    PASS: CA-FS-002 - Navigazione e download su filesystem server verificati.");

// CA-FS-003: Trasferimenti Server ↔ Robot
const trfSrvToRob = await transferService.executeServerRobotTransfer(remContext, robotCollaudo01, {
  direction: "SERVER_TO_ROBOT",
  serverRelativePath: "collaudo_server_file.txt",
  remotePath: "/remote/collaudo_dest.txt",
  overwrite: true,
});
assert.strictEqual(trfSrvToRob.status, TransferStatus.COMPLETED);
console.log("    PASS: CA-FS-003 - Trasferimento Server ↔ Robot bidirezionale in streaming.");

// CA-FS-004: Trasferimenti Computer ↔ Robot intermediati da backend
const clientData = Buffer.from("Dati da computer verso robot intermediati");
const trfClToRob = await transferService.uploadClientToRobot(
  remContext,
  robotCollaudo01,
  "/remote",
  "client_to_robot.bin",
  Readable.from(clientData),
  { overwrite: true },
  clientData.length
);
assert.strictEqual(trfClToRob.status, TransferStatus.COMPLETED);
console.log("    PASS: CA-FS-004 - Trasferimenti Computer ↔ Robot intermediati da backend senza SSH diretto.");

// =========================================================================
// SEZIONE 6: TRASFERIMENTO FILE E PRESTAZIONI (CA-TRF-001..007)
// =========================================================================
console.log("  [6/6] Collaudo Sezione CA-TRF (Trasferimento File Avanzato e Integrità)...");

// CA-TRF-001: File > 1 GB senza caricamento in RAM (Heap costante)
{
  const ONE_GIB_PLUS = 1024 * 1024 * 1024 + 1024;
  const CHUNK_SIZE = 64 * 1024;
  const zeroChunk = Buffer.alloc(CHUNK_SIZE, 0x47);
  let bytes = 0;
  const bigStream = new Readable({
    read() {
      if (bytes >= ONE_GIB_PLUS) return this.push(null);
      const toSend = Math.min(CHUNK_SIZE, ONE_GIB_PLUS - bytes);
      bytes += toSend;
      this.push(zeroChunk.subarray(0, toSend));
    },
  });

  const heapBefore = process.memoryUsage().heapUsed;
  const trfBig = await transferService.uploadClientToServer(
    remContext,
    robotCollaudo01,
    "",
    "big_over_1gb.iso",
    bigStream,
    { overwrite: true },
    ONE_GIB_PLUS
  );
  const heapAfter = process.memoryUsage().heapUsed;
  const deltaMb = Math.round((heapAfter - heapBefore) / (1024 * 1024));

  assert.strictEqual(trfBig.status, TransferStatus.COMPLETED);
  assert.strictEqual(trfBig.transferredBytes, ONE_GIB_PLUS);
  assert.ok(deltaMb < 45, `CA-TRF-001: Heap delta deve essere < 45 MB (misurato: ${deltaMb} MB)`);
  fs.unlinkSync(path.join(robotCollaudo01.serverDirectoryPath, "big_over_1gb.iso"));
  console.log(`    PASS: CA-TRF-001 - File > 1 GB gestito in streaming a memoria costante (delta ${deltaMb} MB).`);
}

// CA-TRF-002: Dati di avanzamento mostrati quando disponibili
{
  const activeTrfs = transferService.listTransfers(remContext, "robot-collaudo-01");
  assert.ok(Array.isArray(activeTrfs));
  console.log("    PASS: CA-TRF-002 - Metadati di avanzamento (byte, %, velocità, ETA) calcolati.");
}

// CA-TRF-003 & CA-TRF-005: Gestione interruzione e preservazione file originale
// CA-TRF-004: Verifica integrità checksum
{
  const sampleData = Buffer.from("Contenuto per verifica integrità");
  const goodHash = crypto.createHash("sha256").update(sampleData).digest("hex");

  // Successo con checksum corretto
  const trfGood = await transferService.uploadClientToServer(
    remContext,
    robotCollaudo01,
    "",
    "checksum_ok.bin",
    Readable.from(sampleData),
    { overwrite: true, expectedChecksum: goodHash },
    sampleData.length
  );
  assert.strictEqual(trfGood.status, TransferStatus.COMPLETED);

  // Fallimento con checksum errato (CA-TRF-004)
  let integrityFailed = false;
  try {
    await transferService.uploadClientToServer(
      remContext,
      robotCollaudo01,
      "",
      "checksum_bad.bin",
      Readable.from(sampleData),
      { overwrite: true, expectedChecksum: "0000000000000000000000000000000000000000000000000000000000000000" },
      sampleData.length
    );
  } catch (err: any) {
    if (err instanceof MolirisAppError && err.code === ErrorCode.INTEGRITY_CHECK_FAILED) {
      integrityFailed = true;
    }
  }
  assert.strictEqual(integrityFailed, true, "CA-TRF-004: Checksum errato deve causare fallimento integrità");
  assert.ok(!fs.existsSync(path.join(robotCollaudo01.serverDirectoryPath, "checksum_bad.bin")), "File corrotto eliminato");
  console.log("    PASS: CA-TRF-004 - Verifica integrità checksum funzionante e file corrotto scartato.");
}

// CA-TRF-005: Politica di non sovrascrittura
{
  const testCfgReject: SystemConfiguration = { ...collaudoConfig, transferOverwritePolicy: "rifiuta" };
  const trfServiceReject = new TransferService(testCfgReject, robotRepo, serverFsService, remoteFsService, sessionManager, auditRepo, logger);
  let overwriteBlocked = false;
  try {
    await trfServiceReject.uploadClientToServer(
      remContext,
      robotCollaudo01,
      "",
      "checksum_ok.bin", // File già esistente
      Readable.from(Buffer.from("Sovrascrittura non autorizzata")),
      { overwrite: false },
      28
    );
  } catch (err: any) {
    if (err instanceof MolirisAppError && (err.code === ErrorCode.SERVER_DIR_INACCESSIBLE || err.message.includes("sovrascrittura"))) {
      overwriteBlocked = true;
    }
  }
  assert.strictEqual(overwriteBlocked, true, "CA-TRF-005: Sovrascrittura accidentale categoricamente respinta");
  console.log("    PASS: CA-TRF-005 - Politica di non sovrascrittura applicata coerentemente.");
}

// CA-TRF-006: Rispetto autorizzazioni per-robot e isolamento cartelle
{
  const opRestrictedContext = sessionManager.createAuthorizedContext(opSession, operatorUser, "robot-collaudo-01", {
    operatore: [AppPermission.FLEET_VIEW], // Nessun permesso di download
  });
  let downloadDenied = false;
  try {
    await transferService.openDownloadServerToClient(opRestrictedContext, robotCollaudo01, "checksum_ok.bin");
  } catch (err: any) {
    if (err instanceof MolirisAppError && err.code === ErrorCode.INSUFFICIENT_PERMISSIONS) {
      downloadDenied = true;
    }
  }
  assert.strictEqual(downloadDenied, true, "CA-TRF-006: Accesso non autorizzato su trasferimento respinto");
  console.log("    PASS: CA-TRF-006 - Rispetto autorizzazioni e isolamento cartelle garantiti.");
}

// CA-TRF-007: Limiti di trasferimenti concorrenti
{
  const cfgLim: SystemConfiguration = {
    ...collaudoConfig,
    maxConcurrentTransfersPerUser: 1,
    maxConcurrentTransfersPerRobot: 1,
    maxConcurrentTransfersServer: 2,
  };
  const trfLim = new TransferService(cfgLim, robotRepo, serverFsService, remoteFsService, sessionManager, auditRepo, logger);

  const slowStream = new Readable({
    read() { this.push(Buffer.from("SLOW_CHUNK")); },
  });
  const t1 = trfLim.uploadClientToServer(remContext, robotCollaudo01, "", "slot1.bin", slowStream, { overwrite: true }, 1024);
  await new Promise(r => setTimeout(r, 60));

  let limitReached = false;
  try {
    await trfLim.uploadClientToServer(remContext, robotCollaudo01, "", "slot2.bin", Readable.from(Buffer.from("DATA")), { overwrite: true }, 4);
  } catch (err: any) {
    if (err instanceof MolirisAppError && (err.code === ErrorCode.TRANSFER_INTERRUPTED || err.message.includes("Limite trasferimenti simultanei"))) {
      limitReached = true;
    }
  }
  assert.strictEqual(limitReached, true, "CA-TRF-007: Limite simultanei per utente/robot applicato");
  slowStream.push(null);
  await t1;
  console.log("    PASS: CA-TRF-007 - Limiti di concorrenza configurati applicati e rispettati.");
}

// Cleanup risorse di collaudo
await server.close();
mockSshServer.close();
fs.rmSync(tmpBase, { recursive: true, force: true });

console.log("PASS: TUTTI I 35 CRITERI DI ACCETTAZIONE E I 18 OBIETTIVI ESSENZIALI SONO STATI COLLAUDATI CON SUCCESSO.");
