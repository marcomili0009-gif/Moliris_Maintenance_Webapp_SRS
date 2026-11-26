// Requisiti soddisfatti: RF-TRF-001..005, RF-TRF-009, RF-TRF-011, RF-AUTH-005, RF-SRVFS-005,
// RNF-SEC-004, RNF-SEC-005, RNF-PERF-001, RNF-REL-004, RNF-MNT-001
//
// TEST SUITE: CARICAMENTO MASSIVO MULTI-TARGET, PRE-CHECK CONFLITTI E JAIL OPERATORE

import assert from "assert";
import crypto from "crypto";
import fs from "fs";
import https from "node:https";
import os from "os";
import path from "path";
import ssh2 from "ssh2";
import { loadConfig } from "../../src/config/index.ts";
import { type SystemConfiguration } from "../../config/configuration.ts";
import { MolirisLogger } from "../../logging/logger.ts";
import { InMemoryCredentialProvider } from "../../backend/connection/credential-provider.ts";
import { DefaultHostKeyVerifier, computeHostKeyFingerprint } from "../../backend/connection/host-key-verifier.ts";
import { RobotConnectionManager } from "../../backend/connection/robot-connection-manager.ts";
import { InMemoryRobotRepository } from "../../storage/robot-repository.ts";
import { InMemoryAuditRepository } from "../../storage/audit-repository.ts";
import { SessionManager } from "../../backend/auth/session-manager.ts";
import { InMemoryUserRepository } from "../../backend/auth/user-repository.ts";
import { ServerFilesystemService } from "../../storage/server-fs.ts";
import { RemoteFilesystemService } from "../../backend/remote-fs/remote-fs-service.ts";
import { TransferService } from "../../backend/transfer/transfer-service.ts";
import { TransferDirection } from "../../backend/transfer/transfer-models.ts";
import { AppPermission, DEFAULT_ROLE_PERMISSIONS } from "../../backend/auth/permissions.ts";
import { type RobotEntity } from "../../storage/robot-models.ts";
import { type UserEntity } from "../../backend/auth/user-models.ts";
import { ErrorCode, MolirisAppError } from "../../errors/app-errors.ts";
import { PhysicalFileLogger } from "../../backend/logging/physical-file-logger.ts";
import { createServer } from "../../backend/server.ts";
import { execSync } from "child_process";

console.log("--> Esecuzione test suite Caricamento Massivo Multi-Target e Jail RBAC Operatore...");

// 1. Setup cartelle temporanee e certificati TLS
const tmpServerRoot = fs.mkdtempSync(path.join(os.tmpdir(), "moliris-bulk-srv-"));
const tmpTlsDir = fs.mkdtempSync(path.join(os.tmpdir(), "moliris-bulk-tls-"));
const certPath = path.join(tmpTlsDir, "test-cert.pem");
const keyPath = path.join(tmpTlsDir, "test-key.pem");
execSync(`openssl req -x509 -newkey rsa:2048 -keyout "${keyPath}" -out "${certPath}" -days 1 -nodes -subj "/CN=localhost"`, {
  stdio: "pipe",
});

const logger = new MolirisLogger();

// 2. Setup server SSH/SFTP mock
const serverHostKey = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "pkcs1", format: "pem" },
});
const parsedKey = (ssh2 as any).utils.parseKey(serverHostKey.privateKey);
const serverHostKeyWireBuffer = parsedKey.getPublicSSH();
const serverFingerprintInfo = computeHostKeyFingerprint(serverHostKeyWireBuffer);

const mockRemoteFs: Record<string, Buffer> = {
  "/upload": Buffer.from("DIR"),
  "/upload/existing_remote.txt": Buffer.from("Contenuto originario del robot non toccare!"),
  "/etc/secret.conf": Buffer.from("conf_segreto"),
};

let nextHandleId = 1;
const openHandles = new Map<string, { path: string; isDir: boolean; readSent?: boolean }>();

const createSftpTestServer = (
  remoteFiles: Record<string, Buffer>,
  corruptWrite = () => false,
  failOperation?: (operation: "WRITE" | "CLOSE" | "RENAME", offset: number) => number | null | undefined,
  writeDelay = () => 0,
  readLimit = () => Number.POSITIVE_INFINITY
) => new ssh2.Server(
  {
    hostKeys: [serverHostKey.privateKey],
  },
  (client) => {
    client.on("authentication", (ctx) => {
      if (ctx.method === "password" && ctx.username === "operator" && ctx.password === "TestPassword123!") {
        ctx.accept();
      } else {
        ctx.reject(["password"]);
      }
    });

    client.on("ready", () => {
      client.on("session", (accept) => {
        const session = accept();
        session.on("sftp", (acceptSftp) => {
          const sftp = acceptSftp();

          sftp.on("REALPATH", (reqid: number, p: string) => {
            sftp.name(reqid, [{ filename: path.posix.normalize(p || "/") }] as any);
          });

          sftp.on("STAT", (reqid: number, p: string) => {
            const norm = path.posix.normalize(p);
            if (remoteFiles[norm] !== undefined) {
              const isDir = remoteFiles[norm].toString() === "DIR";
              return sftp.attrs(reqid, {
                mode: isDir ? 0o040755 : 0o100644,
                size: remoteFiles[norm].length,
                mtime: Math.floor(Date.now() / 1000),
                atime: Math.floor(Date.now() / 1000),
              } as any);
            }
            return sftp.status(reqid, 2 /* SSH_FX_NO_SUCH_FILE */);
          });

          sftp.on("OPENDIR", (reqid: number, dirPath: string) => {
            const norm = path.posix.normalize(dirPath);
            const handle = Buffer.from(`dir_${nextHandleId++}`);
            openHandles.set(handle.toString(), { path: norm, isDir: true, readSent: false });
            sftp.handle(reqid, handle);
          });

          sftp.on("READDIR", (reqid: number, handle: Buffer) => {
            const h = openHandles.get(handle.toString());
            if (!h || h.readSent) {
              return sftp.status(reqid, 1 /* SSH_FX_EOF */);
            }
            h.readSent = true;
            const entries: Array<{ filename: string; attrs: any }> = [];
            const dirPrefix = h.path.endsWith("/") ? h.path : `${h.path}/`;
            for (const key of Object.keys(remoteFiles)) {
              if (key !== h.path && key.startsWith(dirPrefix)) {
                const sub = key.slice(dirPrefix.length);
                if (!sub.includes("/")) {
                  const isDir = remoteFiles[key].toString() === "DIR";
                  entries.push({
                    filename: sub,
                    attrs: {
                      mode: isDir ? 0o040755 : 0o100644,
                      size: remoteFiles[key].length,
                      mtime: Math.floor(Date.now() / 1000),
                    },
                  });
                }
              }
            }
            sftp.name(reqid, entries as any);
          });

          sftp.on("OPEN", (reqid: number, filename: string, pflags: number) => {
            const norm = path.posix.normalize(filename);
            if (!remoteFiles[norm] && path.posix.dirname(norm) !== "/" && !remoteFiles[path.posix.dirname(norm)]) {
              return sftp.status(reqid, 2);
            }
            const handle = Buffer.from(`file_${nextHandleId++}`);
            openHandles.set(handle.toString(), { path: norm, isDir: false });
            if (!remoteFiles[norm]) {
              remoteFiles[norm] = Buffer.alloc(0);
            }
            sftp.handle(reqid, handle);
          });

          sftp.on("WRITE", (reqid: number, handle: Buffer, offset: number, data: Buffer) => {
            const h = openHandles.get(handle.toString());
            if (!h) return sftp.status(reqid, 4 /* SSH_FX_FAILURE */);
            const failure = failOperation?.("WRITE", offset);
            if (failure === null) return;
            if (failure !== undefined) {
              setTimeout(() => sftp.status(reqid, failure), 40);
              return;
            }
            const cur = remoteFiles[h.path] || Buffer.alloc(0);
            const needed = offset + data.length;
            let nextBuf = cur;
            if (cur.length < needed) {
              nextBuf = Buffer.alloc(needed);
              cur.copy(nextBuf, 0, 0, cur.length);
            }
            data.copy(nextBuf, offset);
            if (data.length > 0 && corruptWrite()) nextBuf[offset] ^= 0xff;
            remoteFiles[h.path] = nextBuf;
            const delay = writeDelay();
            if (delay > 0) setTimeout(() => sftp.status(reqid, 0), delay);
            else sftp.status(reqid, 0);
          });

          sftp.on("READ", (reqid, handle, offset, length) => {
            const opened = openHandles.get(handle.toString());
            const buffer = opened && remoteFiles[opened.path];
            if (!buffer) return sftp.status(reqid, 4);
            if (offset >= buffer.length) return sftp.status(reqid, 1);
            sftp.data(reqid, buffer.subarray(offset, offset + Math.min(length, readLimit())));
          });

          sftp.on("CLOSE", (reqid: number, handle: Buffer) => {
            const wasTemporary = openHandles.get(handle.toString())?.path.endsWith(".part");
            openHandles.delete(handle.toString());
            sftp.status(reqid, wasTemporary ? failOperation?.("CLOSE", 0) ?? 0 : 0);
          });

          sftp.on("RENAME", (reqid: number, oldPath: string, newPath: string) => {
            const normOld = path.posix.normalize(oldPath);
            const normNew = path.posix.normalize(newPath);
            const failure = failOperation?.("RENAME", 0);
            if (failure != null) return sftp.status(reqid, failure);
            if (remoteFiles[normNew] !== undefined) return sftp.status(reqid, 4);
            if (remoteFiles[normOld] !== undefined) {
              remoteFiles[normNew] = remoteFiles[normOld];
              delete remoteFiles[normOld];
              return sftp.status(reqid, 0);
            }
            return sftp.status(reqid, 2);
          });

          sftp.on("REMOVE", (reqid: number, p: string) => {
            const norm = path.posix.normalize(p);
            delete remoteFiles[norm];
            sftp.status(reqid, 0);
          });
        });
      });
    });
  }
);

const sftpServer = createSftpTestServer(mockRemoteFs);
await new Promise<void>((resolve) => {
  sftpServer.listen(0, "127.0.0.1", () => resolve());
});
const sshPort = (sftpServer.address() as any).port;

// 3. Configurazione e componenti di sistema
const config: SystemConfiguration = {
  credentialProviderType: "in-memory",
  serverFilesystemRoot: tmpServerRoot,
  pollingIntervalSeconds: 10,
  sshConnectionTimeoutMs: 2500,
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
  defaultSshPort: sshPort,
  maxBulkUploadFiles: 100,
  defaultOperatorAllowedPaths: ["upload", "shared", "logs"],
  remoteFsAllowedPaths: ["/upload", "/shared", "/home/robot/TEST"],
};

const robotRepo = new InMemoryRobotRepository();
const auditRepo = new InMemoryAuditRepository();
const sessionManager = new SessionManager(30);

const credentialProvider = new InMemoryCredentialProvider(["password"]);
credentialProvider.registerSecret("vault://creds/robot1", {
  method: "password",
  password: "TestPassword123!",
});

const hostKeyVerifier = new DefaultHostKeyVerifier();

const connLimits = {
  maxConcurrentPerUser: 5,
  maxConcurrentPerRobot: 5,
  maxConcurrentServer: 10,
  connectionTimeoutMs: 2500,
};
const connectionManager = new RobotConnectionManager(
  credentialProvider,
  hostKeyVerifier,
  connLimits,
  logger,
  auditRepo
);

const serverFsService = new ServerFilesystemService(
  config.serverFilesystemRoot,
  auditRepo,
  logger,
  config.defaultOperatorAllowedPaths
);

const remoteFsService = new RemoteFilesystemService(
  config,
  connectionManager,
  auditRepo,
  logger,
  DEFAULT_ROLE_PERMISSIONS
);

const transferService = new TransferService(
  config,
  robotRepo,
  serverFsService,
  remoteFsService,
  sessionManager,
  auditRepo,
  logger,
  DEFAULT_ROLE_PERMISSIONS,
  undefined,
  connectionManager
);

// Entità Robot registrata
const robot1: RobotEntity = {
  id: "robot1",
  displayName: "Robot 1 Test",
  remoteUsername: "operator",
  host: "127.0.0.1",
  sshPort,
  sshAuthMethod: "password",
  credentialReference: "vault://creds/robot1",
  hostKeyVerification: { fingerprint: serverFingerprintInfo.openSshFormat, strictHostKeyChecking: true },
  stateFilePaths: ["/tmp/status.txt"],
  serverDirectoryPath: path.join(tmpServerRoot, "operator_robot1"),
  anagraphicState: "attivo",
  connectionState: "raggiungibile",
  operationalState: null,
  lastValidUpdateAt: null,
  lastAttemptOutcome: null,
  registrationState: "registrazione_completata",
  lastConnectionVerification: { timestamp: new Date(), success: true, message: "OK" },
  createdAt: new Date(),
  updatedAt: new Date(),
};
await robotRepo.create(robot1);
await serverFsService.ensureRobotDirectory(robot1, {
  standardSubdirectories: ["upload", "shared", "logs", "backups", "configs"],
});

// Utenti e Contesti: Operatore vs Admin
const operatorUser: UserEntity = {
  id: "user-op",
  username: "operatore_test",
  roles: ["operatore"],
  enabled: true,
  createdAt: new Date(),
  updatedAt: new Date(),
  passwordHash: "hash",
};

const adminUser: UserEntity = {
  id: "user-admin",
  username: "admin_test",
  roles: ["admin"],
  enabled: true,
  createdAt: new Date(),
  updatedAt: new Date(),
  passwordHash: "hash",
};

const sessionOp = sessionManager.createSession(operatorUser);
const contextOp = sessionManager.createAuthorizedContext(sessionOp, operatorUser, undefined, DEFAULT_ROLE_PERMISSIONS);

const sessionAdmin = sessionManager.createSession(adminUser);
const contextAdmin = sessionManager.createAuthorizedContext(sessionAdmin, adminUser, undefined, DEFAULT_ROLE_PERMISSIONS);

// =========================================================================
// TEST 1: Jail Operatore su Filesystem Server (RF-AUTH-005, RF-SRVFS-005, RNF-SEC-004)
// =========================================================================
{
  // 1a. Operatore tenta di navigare su cartella fuori jail ("configs") -> 403 Forbidden
  await assert.rejects(
    async () => await serverFsService.listDirectory(contextOp, robot1, "configs"),
    (err: any) => {
      assert(err instanceof MolirisAppError);
      assert.strictEqual(err.code, ErrorCode.INSUFFICIENT_PERMISSIONS);
      return true;
    },
    "Operatore deve essere bloccato con 403 fuori dalle cartelle consentite sul server"
  );

  // 1b. Operatore tenta di scrivere fuori jail ("configs/test.txt") -> 403 Forbidden
  await assert.rejects(
    async () => await serverFsService.openFileWriteStream(contextOp, robot1, "configs/test.txt"),
    (err: any) => {
      assert(err instanceof MolirisAppError);
      assert.strictEqual(err.code, ErrorCode.INSUFFICIENT_PERMISSIONS);
      return true;
    },
    "Operatore non può scrivere fuori dalle cartelle consentite"
  );

  // 1c. Operatore navigazione dentro cartella consentita ("upload") -> Permessa
  const allowedList = await serverFsService.listDirectory(contextOp, robot1, "upload");
  assert(Array.isArray(allowedList), "Operatore può accedere alla cartella consentita");

  // 1d. Operatore che elenca la root vede SOLO le cartelle consentite (upload, shared, logs)
  const rootList = await serverFsService.listDirectory(contextOp, robot1, "");
  const folderNames = rootList.map((i) => i.name);
  assert(folderNames.includes("upload"), "Root include cartella consentita upload");
  assert(folderNames.includes("shared"), "Root include cartella consentita shared");
  assert(!folderNames.includes("configs"), "Root per operatore NON deve mostrare cartella non consentita configs");

  // 1e. Admin ha accesso completo a tutte le cartelle, inclusa configs
  const adminList = await serverFsService.listDirectory(contextAdmin, robot1, "configs");
  assert(Array.isArray(adminList), "Admin può navigare ovunque sul filesystem server");

  console.log("  PASS: Test 1 - Jail Operatore su filesystem server e bypass Admin verificati.");
}

// =========================================================================
// TEST 2: Jail Operatore su Filesystem Remoto Robot (RF-FS-007, RNF-SEC-005)
// =========================================================================
{
  // 2a. Operatore tenta di navigare fuori jail (/etc) -> 403 Forbidden
  await assert.rejects(
    async () => await remoteFsService.listDirectory(contextOp, robot1, "/etc"),
    (err: any) => {
      assert(err instanceof MolirisAppError);
      assert.strictEqual(err.code, ErrorCode.INSUFFICIENT_PERMISSIONS);
      return true;
    },
    "Operatore deve essere bloccato con 403 su percorsi remoti fuori jail"
  );

  // 2b. Operatore tenta di eliminare file fuori jail -> 403 Forbidden
  await assert.rejects(
    async () => await remoteFsService.deleteRemoteFile(contextOp, robot1, "/etc/secret.conf"),
    (err: any) => {
      assert(err instanceof MolirisAppError);
      assert.strictEqual(err.code, ErrorCode.INSUFFICIENT_PERMISSIONS);
      return true;
    },
    "Operatore non può eliminare file al di fuori delle cartelle consentite"
  );

  // 2c. Operatore su percorso consentito (/upload) -> Permesso
  const remoteListing = await remoteFsService.listDirectory(contextOp, robot1, "/upload");
  assert.strictEqual(remoteListing.currentPath, "/upload");

  console.log("  PASS: Test 2 - Jail Operatore su filesystem remoto SFTP verificato.");
}

// =========================================================================
// TEST 3: Pre-check Conflitti di Sovrascrittura Multi-Target (RF-TRF-009, RF-TRF-011)
// =========================================================================
{
  // Creiamo un file preesistente sul server
  const serverExistingPath = path.join(robot1.serverDirectoryPath, "upload", "existing_server.txt");
  fs.writeFileSync(serverExistingPath, "Contenuto originario del file server preesistente");

  const checkReq = {
    filenames: ["existing_server.txt", "existing_remote.txt", "brand_new_file.txt"],
    targets: [
      { type: "server" as const, robotId: robot1.id, directory: "upload" },
      { type: "robot" as const, robotId: robot1.id, directory: "/upload" },
    ],
  };

  const preCheckRes = await transferService.checkBulkConflicts(contextAdmin, checkReq);
  assert.strictEqual(preCheckRes.hasConflicts, true, "I conflitti devono essere rilevati");
  assert.strictEqual(preCheckRes.conflicts.length, 2, "Devono essere rilevati 2 conflitti");

  const serverConflict = preCheckRes.conflicts.find((c) => c.filename === "existing_server.txt" && c.target.type === "server");
  assert.ok(serverConflict, "Rilevato conflitto file server");
  assert.strictEqual(serverConflict?.existingSizeBytes, Buffer.byteLength("Contenuto originario del file server preesistente"));

  const remoteConflict = preCheckRes.conflicts.find((c) => c.filename === "existing_remote.txt" && c.target.type === "robot");
  assert.ok(remoteConflict, "Rilevato conflitto file remoto");

  // Verifica che un operatore che tenta target fuori jail nel pre-check venga respinto con 403
  await assert.rejects(
    async () =>
      await transferService.checkBulkConflicts(contextOp, {
        filenames: ["file.txt"],
        targets: [{ type: "server", robotId: robot1.id, directory: "configs" }],
      }),
    (err: any) => {
      assert(err instanceof MolirisAppError);
      assert.strictEqual(err.code, ErrorCode.INSUFFICIENT_PERMISSIONS);
      return true;
    },
    "Pre-check deve respingere target fuori jail per l'operatore"
  );

  console.log("  PASS: Test 3 - Pre-check preventivo dei conflitti e RBAC validati.");
}

// =========================================================================
// TEST 4: Annullamento su Conflitto: Destinazioni Integre e Zero Residui (RNF-REL-004)
// =========================================================================
{
  const serverFile = path.join(robot1.serverDirectoryPath, "upload", "existing_server.txt");
  const originalServerContent = fs.readFileSync(serverFile, "utf-8");
  const originalRemoteContent = mockRemoteFs["/upload/existing_remote.txt"].toString();

  // File di staging
  const stagingDir = path.join(tmpServerRoot, ".tmp_bulk");
  if (!fs.existsSync(stagingDir)) fs.mkdirSync(stagingDir, { recursive: true, mode: 0o700 });
  const stagingFile = path.join(stagingDir, "staging_abort_test.part");
  fs.writeFileSync(stagingFile, "Nuovo contenuto che NON deve sovrascrivere");

  const stagedFiles = [
    {
      filename: "existing_server.txt",
      stagingPath: stagingFile,
      sizeBytes: fs.statSync(stagingFile).size,
      sha256: crypto.createHash("sha256").update(fs.readFileSync(stagingFile)).digest("hex"),
    },
  ];

  // Esecuzione senza overwrite (annullamento / non confermata)
  const bulkRes = await transferService.executeBulkUpload(contextAdmin, {
    targets: [{ type: "server", robotId: robot1.id, directory: "upload" }],
    overwrite: false,
    stagedFiles,
  });

  assert.strictEqual(bulkRes.summary.skipped, 1, "Il trasferimento deve essere saltato per mancata conferma");
  assert.strictEqual(fs.readFileSync(serverFile, "utf-8"), originalServerContent, "Il file server originario deve rimanere intatto");
  assert.strictEqual(mockRemoteFs["/upload/existing_remote.txt"].toString(), originalRemoteContent, "Il file remoto originario deve rimanere intatto");

  // Verifica zero file temporanei .part o orfani
  const tempDir = path.join(robot1.serverDirectoryPath, ".tmp");
  if (fs.existsSync(tempDir)) {
    const tempFiles = fs.readdirSync(tempDir);
    assert.strictEqual(tempFiles.length, 0, "Nessun file .part residuo nella directory temporanea server");
  }

  // Pulizia file staging
  if (fs.existsSync(stagingFile)) fs.unlinkSync(stagingFile);

  console.log("  PASS: Test 4 - Annullamento su conflitto preserva dati intatti a zero residui .part.");
}

// =========================================================================
// TEST 5: Caricamento Massivo Multi-Target con Sostituzione Atomica e Checksum (RF-TRF-001..005, RF-TRF-011)
// =========================================================================
{
  const stagingDir = path.join(tmpServerRoot, ".tmp_bulk");
  if (!fs.existsSync(stagingDir)) fs.mkdirSync(stagingDir, { recursive: true, mode: 0o700 });

  const file1Content = "Contenuto del primo file per upload massivo multi-target";
  const file2Content = "Contenuto del secondo file per upload massivo multi-target";

  const stage1 = path.join(stagingDir, "stage_1.part");
  const stage2 = path.join(stagingDir, "stage_2.part");
  fs.writeFileSync(stage1, file1Content);
  fs.writeFileSync(stage2, file2Content);

  const hash1 = crypto.createHash("sha256").update(file1Content).digest("hex");
  const hash2 = crypto.createHash("sha256").update(file2Content).digest("hex");

  const stagedFiles = [
    {
      filename: "bulk_file_1.txt",
      stagingPath: stage1,
      sizeBytes: Buffer.byteLength(file1Content),
      sha256: hash1,
    },
    {
      filename: "bulk_file_2.txt",
      stagingPath: stage2,
      sizeBytes: Buffer.byteLength(file2Content),
      sha256: hash2,
    },
  ];

  const targets = [
    { type: "server" as const, robotId: robot1.id, directory: "upload" },
    { type: "robot" as const, robotId: robot1.id, directory: "/upload" },
  ];

  const result = await transferService.executeBulkUpload(contextAdmin, {
    targets,
    overwrite: true,
    stagedFiles,
  });

  assert.strictEqual(result.success, true, "Tutti i file devono avere successo");
  assert.strictEqual(result.totalFiles, 2);
  assert.strictEqual(result.summary.completed, 4, "2 file x 2 target = 4 completati");
  assert.strictEqual(result.summary.failed, 0);

  // Verifica su filesystem server
  const srvFile1 = path.join(robot1.serverDirectoryPath, "upload", "bulk_file_1.txt");
  const srvFile2 = path.join(robot1.serverDirectoryPath, "upload", "bulk_file_2.txt");
  assert.strictEqual(fs.readFileSync(srvFile1, "utf-8"), file1Content);
  assert.strictEqual(fs.readFileSync(srvFile2, "utf-8"), file2Content);

  // Verifica su filesystem remoto SFTP robot
  assert.strictEqual(mockRemoteFs["/upload/bulk_file_1.txt"].toString(), file1Content);
  assert.strictEqual(mockRemoteFs["/upload/bulk_file_2.txt"].toString(), file2Content);

  // Pulizia
  fs.unlinkSync(stage1);
  fs.unlinkSync(stage2);

  console.log("  PASS: Test 5 - Caricamento massivo multi-target completato con sostituzione atomica e checksum.");
}

// =========================================================================
// TEST 6: Endpoint REST Fastify /api/transfers/bulk/pre-check e /upload (RF-TRF-001..005)
// =========================================================================
{
  const userRepo = new InMemoryUserRepository();
  await userRepo.create(adminUser);
  await userRepo.create(operatorUser);

  const physicalFileLogger = new PhysicalFileLogger(path.join(tmpTlsDir, "logs"));
  const server = createServer(config, logger, {
    physicalFileLogger,
    sessionManager,
    userRepository: userRepo,
    auditRepository: auditRepo,
    robotRepository: robotRepo,
    serverFsService,
    credentialProvider,
    hostKeyVerifier,
    connectionManager,
    transferService,
    appConfig: loadConfig({
      env: { MOLIRIS_MAX_BULK_UPLOAD_FILES: "100" },
      overrides: { maxFileUploadBytes: 1024 * 1024 },
    }),
  });
  await server.ready();

  // 6a. Richiesta non autenticata -> 401
  const resUnauth = await server.inject({
    method: "POST",
    url: "/api/transfers/bulk/pre-check",
    payload: { filenames: ["test.txt"], targets: [] },
  });
  assert.strictEqual(resUnauth.statusCode, 401, "Richiesta senza autenticazione deve restituire 401");

  // 6b. Richiesta con operatore fuori jail -> 403 Forbidden
  const resJail = await server.inject({
    method: "POST",
    url: "/api/transfers/bulk/pre-check",
    headers: { origin: "http://localhost" },
    cookies: { "__Host-moliris_session": sessionOp.sessionId },
    payload: {
      filenames: ["file.txt"],
      targets: [{ type: "server", robotId: robot1.id, directory: "configs" }],
    },
  });
  assert.strictEqual(resJail.statusCode, 403, "Tentativo fuori jail via API REST deve restituire 403 Forbidden");

  // 6c. Pre-check valido con rilevamento conflitti -> 200 OK con hasConflicts
  const resPreCheck = await server.inject({
    method: "POST",
    url: "/api/transfers/bulk/pre-check",
    headers: { origin: "http://localhost" },
    cookies: { "__Host-moliris_session": sessionAdmin.sessionId },
    payload: {
      filenames: ["existing_server.txt"],
      targets: [{ type: "server", robotId: robot1.id, directory: "upload" }],
    },
  });
  assert.strictEqual(resPreCheck.statusCode, 200);
  const preCheckJson = JSON.parse(resPreCheck.body);
  assert.strictEqual(preCheckJson.hasConflicts, true);

  // 6d. Upload multipart con conflitto e overwrite: false -> 409 Conflict
  const boundary = "----WebKitFormBoundary" + crypto.randomBytes(16).toString("hex");
  const multipartConflict = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="targets"\r\n\r\n${JSON.stringify([{ type: "server", robotId: robot1.id, directory: "upload" }])}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="overwrite"\r\n\r\nfalse\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="existing_server.txt"\r\nContent-Type: text/plain\r\n\r\nTentativo di sovrascrittura non autorizzato\r\n`),
    Buffer.from(`--${boundary}--\r\n`),
  ]);

  const resConflict = await server.inject({
    method: "POST",
    url: "/api/transfers/bulk/upload",
    headers: {
      "content-type": `multipart/form-data; boundary=${boundary}`,
      origin: "http://localhost",
    },
    cookies: { "__Host-moliris_session": sessionAdmin.sessionId },
    payload: multipartConflict,
  });
  assert.strictEqual(resConflict.statusCode, 409, "Conflitto non confermato via REST deve restituire 409 Conflict");

  // 6e. Upload multipart valido con streaming multi-target -> 200 OK
  const boundary2 = "----WebKitFormBoundary" + crypto.randomBytes(16).toString("hex");
  const restFileContent = "Contenuto scritto tramite upload multipart REST Fastify";
  const multipartSuccess = Buffer.concat([
    Buffer.from(`--${boundary2}\r\nContent-Disposition: form-data; name="targets"\r\n\r\n${JSON.stringify([{ type: "server", robotId: robot1.id, directory: "upload" }])}\r\n`),
    Buffer.from(`--${boundary2}\r\nContent-Disposition: form-data; name="overwrite"\r\n\r\ntrue\r\n`),
    Buffer.from(`--${boundary2}\r\nContent-Disposition: form-data; name="files"; filename="rest_upload_file.txt"\r\nContent-Type: text/plain\r\n\r\n${restFileContent}\r\n`),
    Buffer.from(`--${boundary2}--\r\n`),
  ]);

  const resSuccess = await server.inject({
    method: "POST",
    url: "/api/transfers/bulk/upload",
    headers: {
      "content-type": `multipart/form-data; boundary=${boundary2}`,
      origin: "http://localhost",
    },
    cookies: { "__Host-moliris_session": sessionAdmin.sessionId },
    payload: multipartSuccess,
  });
  assert.strictEqual(resSuccess.statusCode, 200, "Upload multipart valido deve restituire 200 OK");
  const successJson = JSON.parse(resSuccess.body);
  assert.strictEqual(successJson.success, true);
  assert.strictEqual(successJson.summary.completed, 1);

  const writtenRestFile = path.join(robot1.serverDirectoryPath, "upload", "rest_upload_file.txt");
  assert.strictEqual(fs.readFileSync(writtenRestFile, "utf-8"), restFileContent);

  // Il wizard usa /upload come cartella comune anche quando i target includono l'archivio.
  const secondRemoteFs: Record<string, Buffer> = { "/shared": Buffer.from("DIR") };
  let corruptSecondRemoteWrite = false;
  let failingOperation: "WRITE" | "CLOSE" | "RENAME" | undefined;
  let stallSecondRemoteWrite = false;
  let delaySecondRemoteWrite = 0;
  const secondSftpServer = createSftpTestServer(secondRemoteFs, () => corruptSecondRemoteWrite,
    (operation, offset) => operation === failingOperation && (operation !== "WRITE" || offset >= 100000)
      ? (operation === "RENAME" ? 3 : stallSecondRemoteWrite ? null : 4)
      : undefined,
    () => delaySecondRemoteWrite,
    () => 8192);

  await new Promise<void>((resolve) => secondSftpServer.listen(0, "127.0.0.1", resolve));
  const robot2: RobotEntity = {
    ...robot1,
    id: "robot2",
    displayName: "Robot 2 Test",
    sshPort: (secondSftpServer.address() as { port: number }).port,
    serverDirectoryPath: path.join(tmpServerRoot, "operator_robot2"),
  };
  await robotRepo.create(robot2);
  await serverFsService.ensureRobotDirectory(robot2, { standardSubdirectories: ["upload"] });
  const mixedTargets = [
    { type: "server", robotId: robot1.id, directory: "/upload" },
    { type: "server", robotId: robot2.id, directory: "/upload" },
    { type: "robot", robotId: robot1.id, directory: "/upload" },
    { type: "robot", robotId: robot2.id, directory: "/shared" },
  ];
  const files = Array.from({ length: 11 }, (_, index) => ({
    filename: `wizard_${index}.txt`,
    contents: `Payload ${index} — Caricamento Massivo`,
  }));
  const authHeaders = { origin: "http://localhost" };
  const cookies = { "__Host-moliris_session": sessionAdmin.sessionId };
  const mixedPreCheck = await server.inject({
    method: "POST",
    url: "/api/transfers/bulk/pre-check",
    headers: authHeaders,
    cookies,
    payload: { filenames: files.map(({ filename }) => filename), targets: mixedTargets },
  });
  assert.strictEqual(mixedPreCheck.statusCode, 200, mixedPreCheck.body);
  assert.strictEqual(mixedPreCheck.json().totalChecks, 44);
  assert.strictEqual(connectionManager.getUserConnectionCount(contextAdmin.username), 0);

  const upload = (targets: unknown, inputFiles: typeof files = files, overwrite = false) => {
    const form = new FormData();
    form.append("targets", JSON.stringify(targets));
    if (overwrite) form.append("overwrite", "true");
    form.append("fileSizes", JSON.stringify(inputFiles.map(({ contents }) => Buffer.byteLength(contents))));
    for (const { filename, contents } of inputFiles) {
      form.append("files", new Blob([contents]), filename);
    }
    return new Request("http://localhost", { method: "POST", body: form });
  };
  const baseUrl = await server.listen({ host: "127.0.0.1", port: 0 });
  const submit = async (request: Request) => {
    const body = Buffer.from(await request.arrayBuffer());
    const headers = {
      origin: baseUrl,
      cookie: `__Host-moliris_session=${sessionAdmin.sessionId}`,
      "content-type": request.headers.get("content-type")!,
      "content-length": body.length,
    };
    const response = await new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
      const client = https.request(`${baseUrl}/api/transfers/bulk/upload`, {
        method: "POST", headers, ca: fs.readFileSync(certPath), servername: "localhost",
      }, (res) => {
        let responseBody = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => { responseBody += chunk; });
        res.on("end", () => resolve({ statusCode: res.statusCode!, body: responseBody }));
        res.on("error", reject);
      });
      client.on("error", reject);
      client.end(body);
    });
    return { ...response, json: () => JSON.parse(response.body) };
  };

  const mixedUpload = await submit(upload(mixedTargets));
  assert.strictEqual(mixedUpload.statusCode, 200, mixedUpload.body);
  assert.deepStrictEqual(mixedUpload.json().summary, { completed: 44, failed: 0, skipped: 0 });
  assert.strictEqual(connectionManager.getUserConnectionCount(contextAdmin.username), 0);
  for (const [index, { filename, contents }] of files.entries()) {
    const sha256 = crypto.createHash("sha256").update(contents).digest("hex");
    assert.deepStrictEqual(mixedUpload.json().results[index].targets.map((item: { checksum: string }) => item.checksum), Array(4).fill(sha256));
    for (const robot of [robot1, robot2]) {
      assert.strictEqual(fs.readFileSync(path.join(robot.serverDirectoryPath, "upload", filename), "utf-8"), contents);
    }
    assert.strictEqual(mockRemoteFs[`/upload/${filename}`]?.toString(), contents);
    assert.strictEqual(secondRemoteFs[`/shared/${filename}`]?.toString(), contents);
  }
  assert.deepStrictEqual(fs.readdirSync(path.join(tmpServerRoot, ".tmp_bulk")), []);
  console.log("  PASS: Test 7 - Wizard, 11 file e 4 destinazioni, verifica contenuti e SHA-256.");

  const stagingDir = path.join(tmpServerRoot, ".tmp_bulk");
  const assertNoParts = () => {
    for (const directory of [
      stagingDir,
      path.join(robot1.serverDirectoryPath, ".tmp"),
      path.join(robot2.serverDirectoryPath, ".tmp"),
      path.join(serverFsService.getGeneralFsRoot(), ".tmp"),
    ]) {
      if (fs.existsSync(directory)) assert.deepStrictEqual(fs.readdirSync(directory), [], directory);
    }
    for (const remoteFs of [mockRemoteFs, secondRemoteFs]) {
      assert.ok(Object.keys(remoteFs).every((filename) => !filename.endsWith(".part")));
    }
    assert.strictEqual(connectionManager.getUserConnectionCount(contextAdmin.username), 0);
  };

  const missingDirectoryFiles = Array.from({ length: 12 }, (_, index) => ({
    filename: `missing-directory-${index}.txt`,
    contents: "X".repeat(100 + index * 4501),
  }));
  const missingDirectory = await submit(upload(
    [...mixedTargets.slice(0, 3), { ...mixedTargets[3], directory: "/home/robot/TEST" }],
    missingDirectoryFiles
  ));
  assert.strictEqual(missingDirectory.statusCode, 200, missingDirectory.body);
  assert.deepStrictEqual(missingDirectory.json().summary, { completed: 36, failed: 12, skipped: 0 });
  const missingRecords = transferService.listTransfers(contextAdmin)
    .filter((item) => item.batchId === missingDirectory.json().batchId && item.status === "FAILED");
  assert.strictEqual(missingRecords.length, 12);
  assert.deepStrictEqual(missingRecords.map((item) => item.transferredBytes), Array(12).fill(0));
  for (const item of missingRecords) assert.match(item.error ?? "", /Cartella di destinazione assente/);
  assertNoParts();
  const mixedFailureLog = await physicalFileLogger.getTransferLogs({ outcome: "FALLIMENTO", limit: 200 });
  assert.strictEqual(mixedFailureLog.filter((line) => line.includes("missing-directory-")).length, 12,
    "I 12 errori individuali devono essere persistiti in transfers.log");
  console.log("  PASS: 12 file, destinazione assente sul secondo robot, zero byte confermati e causa specifica.");

  // Entrambi i tipi di destinazione devono funzionare anche senza target misti.
  for (const [type, filename] of [["server", "server_only.txt"], ["robot", "remote_only.txt"]]) {
    const response = await submit(upload(mixedTargets.filter((target) => target.type === type), [{ filename, contents: type }]));
    assert.strictEqual(response.statusCode, 200, response.body);
    assert.deepStrictEqual(response.json().summary, { completed: 2, failed: 0, skipped: 0 });
  }

  const duplicate = await submit(upload(mixedTargets, [
    { filename: "duplicate.txt", contents: "A" },
    { filename: "duplicate.txt", contents: "B" },
  ], true));
  assert.strictEqual(duplicate.statusCode, 400, duplicate.body);
  assert.match(duplicate.body, /file con lo stesso nome/);
  assert.ok(!fs.existsSync(path.join(robot1.serverDirectoryPath, "upload", "duplicate.txt")));
  assert.ok(!mockRemoteFs["/upload/duplicate.txt"]);

  const oversized = await submit(upload(mixedTargets, [
    { filename: "would-have-succeeded.txt", contents: "A" },
    { filename: "oversized.txt", contents: "B".repeat(1024 * 1024 + 1) },
  ]));
  assert.strictEqual(oversized.statusCode, 413, oversized.body);
  assert.ok(!fs.existsSync(path.join(robot1.serverDirectoryPath, "upload", "would-have-succeeded.txt")));
  assertNoParts();

  // Un file della stessa dimensione cambiato durante la scrittura SFTP deve
  // essere respinto dal readback, preservando le copie delle altre destinazioni.
  config.transferVerifyMode = "readback";
  corruptSecondRemoteWrite = true;
  secondRemoteFs["/shared/partial.txt"] = Buffer.from("File originale");
  const partial = await submit(upload(mixedTargets, [{ filename: "partial.txt", contents: "Payload da verificare" }], true));
  assert.strictEqual(partial.statusCode, 200, partial.body);
  assert.strictEqual(partial.json().success, false);
  assert.deepStrictEqual(partial.json().summary, { completed: 3, failed: 1, skipped: 0 });
  assert.strictEqual(mockRemoteFs["/upload/partial.txt"].toString(), "Payload da verificare");
  assert.strictEqual(secondRemoteFs["/shared/partial.txt"].toString(), "File originale");
  corruptSecondRemoteWrite = false;
  assertNoParts();

  for (const operation of ["WRITE", "CLOSE", "RENAME"] as const) {
    failingOperation = operation;
    const filename = `fault-${operation}.bin`;
    const contents = "R".repeat(170_000);
    const response = await submit(upload([mixedTargets[3]], [{ filename, contents }]));
    assert.strictEqual(response.statusCode, 200, response.body);
    assert.deepStrictEqual(response.json().summary, { completed: 0, failed: 1, skipped: 0 });
    const failure = transferService.listTransfers(contextAdmin).find((item) =>
      item.batchId === response.json().batchId && item.direction === TransferDirection.CLIENT_TO_ROBOT);
    assert.ok(failure);
    assert.strictEqual(failure.status, "FAILED");
    assert.match(failure.error ?? "", operation === "WRITE" ? /scrittura SFTP/
      : operation === "CLOSE" ? /chiusura temporaneo SFTP/ : /pubblicazione/);
    if (operation === "WRITE") {
      assert.ok(failure.transferredBytes > 0 && failure.transferredBytes < contents.length, JSON.stringify(failure));
    } else {
      assert.strictEqual(failure.transferredBytes, contents.length);
      assert.strictEqual(failure.percent, 100);
    }
    assert.ok(!secondRemoteFs[`/shared/${filename}`]);
    assertNoParts();
  }
  failingOperation = undefined;
  console.log("  PASS: riconosciuti WRITE parziale, CLOSE e RENAME con 100% confermato, senza .part residui.");

  const originalIdleTimeout = config.transferIdleTimeoutMs;
  config.transferIdleTimeoutMs = 650;
  failingOperation = "WRITE";
  stallSecondRemoteWrite = true;
  const stalled = await submit(upload([mixedTargets[3]], [{ filename: "stalled.bin", contents: "R".repeat(170_000) }]));
  assert.strictEqual(stalled.statusCode, 200, stalled.body);
  assert.deepStrictEqual(stalled.json().summary, { completed: 0, failed: 1, skipped: 0 });
  assert.match(stalled.json().results[0].targets[0].error, /timeout|tempo massimo/i);
  assert.ok(!secondRemoteFs["/shared/stalled.bin"]);
  stallSecondRemoteWrite = false;
  failingOperation = undefined;
  config.transferIdleTimeoutMs = originalIdleTimeout;
  assertNoParts();

  delaySecondRemoteWrite = 160;
  const racing = await Promise.all(["A", "B"].map((letter) => submit(upload([mixedTargets[3]], [{
    filename: "same-destination.bin",
    contents: letter.repeat(100_000),
  }], true))));
  delaySecondRemoteWrite = 0;
  assert.deepStrictEqual(racing.map((item) => item.json().summary.completed).sort(), [0, 1]);
  assert.match(racing.find((item) => item.json().summary.failed === 1)?.json().results[0].targets[0].error ??
    "", /in corso|un altro trasferimento/i);
  assert.ok(["A", "B"].some((letter) => secondRemoteFs["/shared/same-destination.bin"]?.toString() === letter.repeat(100_000)));
  assertNoParts();
  console.log("  PASS: timeout SFTP con pulizia e due batch simultanei sulla stessa destinazione.");

  const stress = async (count: number) => {
    const stressFiles = Array.from({ length: count }, (_, index) => ({
      filename: `stress-${count}-${index}.bin`,
      contents: String(count % 10).repeat(index === 0 ? 0 : index === 1 ? 138_000 : index * 113 % 8_000),
    }));
    const response = await submit(upload(mixedTargets, stressFiles));
    assert.strictEqual(response.statusCode, 200, response.body);
    assert.deepStrictEqual(response.json().summary, { completed: count * 4, failed: 0, skipped: 0 });
    for (const [index, { filename, contents }] of stressFiles.entries()) {
      assert.strictEqual(fs.readFileSync(path.join(robot1.serverDirectoryPath, "upload", filename), "utf8"), contents);
      assert.strictEqual(fs.readFileSync(path.join(robot2.serverDirectoryPath, "upload", filename), "utf8"), contents);
      assert.strictEqual(mockRemoteFs[`/upload/${filename}`]?.toString(), contents);
      assert.strictEqual(secondRemoteFs[`/shared/${filename}`]?.toString(), contents);
      const sha256 = crypto.createHash("sha256").update(contents).digest("hex");
      assert.deepStrictEqual(response.json().results[index].targets.map((target: { checksum: string }) => target.checksum),
        Array(4).fill(sha256));
    }
    const items = transferService.listTransfers(contextAdmin).filter((item) => item.batchId === response.json().batchId);
    assert.strictEqual(items.filter((item) => !item.isBulkStaging).length, count * 4);
    assert.strictEqual(items.filter((item) => item.isBulkStaging).length, count);
    assert.ok(items.every((item) => item.status === "COMPLETED" && item.percent === 100 && item.transferredBytes === item.totalBytes));
    console.log(`  PASS: ${count} file, ${count * 4} invii misti, byte e SHA-256 verificati.`);
  };
  await stress(1);
  await stress(12);
  await Promise.all([stress(10), stress(50)]);
  await stress(100);
  assertNoParts();

  // Il rename fallisce se la destinazione è una directory. L'originale resta
  // al suo posto e il .part viene rimosso anche dopo una pipeline riuscita.
  const occupiedPath = path.join(robot1.serverDirectoryPath, "upload", "occupied.txt");
  fs.mkdirSync(occupiedPath, { mode: 0o750 });
  const cannotPublish = await submit(upload([mixedTargets[0]], [{ filename: "occupied.txt", contents: "A" }], true));
  assert.deepStrictEqual(cannotPublish.json().summary, { completed: 0, failed: 1, skipped: 0 });
  assert.ok(fs.statSync(occupiedPath).isDirectory());
  assertNoParts();

  const serverSource = await server.inject({
    method: "POST",
    url: "/api/transfers/bulk/server-source",
    headers: authHeaders,
    cookies,
    payload: {
      sourceScope: "server",
      sourceRobotId: robot1.id,
      sourcePaths: ["/upload/wizard_0.txt"],
      targets: [{ type: "general", directory: "/" }, { type: "server", robotId: robot2.id, directory: "/" }],
    },
  });
  assert.strictEqual(serverSource.statusCode, 200, serverSource.body);
  assert.deepStrictEqual(serverSource.json().summary, { completed: 2, failed: 0, skipped: 0 });
  assert.strictEqual(fs.readFileSync(path.join(serverFsService.getGeneralFsRoot(), files[0].filename), "utf8"), files[0].contents);
  assert.strictEqual(fs.readFileSync(path.join(robot1.serverDirectoryPath, "upload", files[0].filename), "utf8"), files[0].contents);
  assertNoParts();

  const outgoing = path.join(tmpServerRoot, "outside-robot");
  fs.mkdirSync(outgoing, { mode: 0o750 });
  fs.symlinkSync(outgoing, path.join(robot1.serverDirectoryPath, "test-link"), "dir");
  for (const directory of ["/upload/../configs", "/.tmp", "/test-link/new-directory"]) {
    const denied = await submit(upload([{ ...mixedTargets[0], directory }], [{ filename: "blocked.txt", contents: "A" }]));
    assert.strictEqual(denied.statusCode, 400, denied.body);
  }
  assert.deepStrictEqual(fs.readdirSync(outgoing), []);
  assertNoParts();

  fs.renameSync(stagingDir, `${stagingDir}.test-backup`);
  fs.symlinkSync(outgoing, stagingDir, "dir");
  const unsafeStaging = await submit(upload([mixedTargets[0]], [{ filename: "blocked.txt", contents: "A" }]));
  assert.strictEqual(unsafeStaging.statusCode, 400, unsafeStaging.body);
  assert.deepStrictEqual(fs.readdirSync(outgoing), []);
  fs.unlinkSync(stagingDir);
  fs.renameSync(`${stagingDir}.test-backup`, stagingDir);
  assertNoParts();
  console.log("  PASS: Test 8 - HTTPS per target omogenei, duplicati, limite multipart, esito parziale, readback, sorgente server, pulizia e jail.");

  await server.close();
  secondSftpServer.close();
  console.log("  PASS: Test 6 - Endpoint REST Fastify /pre-check e /upload multipart collaudati con successo.");
}

// Chiusura risorse
transferService.stopCleanupTask();
await connectionManager.closeAll();
sftpServer.close();
fs.rmSync(tmpServerRoot, { recursive: true, force: true });
fs.rmSync(tmpTlsDir, { recursive: true, force: true });

console.log("PASS: Tutti i test del modulo Caricamento Massivo Multi-Target e Jail RBAC completati con successo.");
