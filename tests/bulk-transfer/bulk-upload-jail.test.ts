// Requisiti soddisfatti: RF-TRF-001..005, RF-TRF-009, RF-TRF-011, RF-AUTH-005, RF-SRVFS-005,
// RNF-SEC-004, RNF-SEC-005, RNF-PERF-001, RNF-REL-004, RNF-MNT-001
//
// TEST SUITE: CARICAMENTO MASSIVO MULTI-TARGET, PRE-CHECK CONFLITTI E JAIL OPERATORE

import assert from "assert";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import ssh2 from "ssh2";
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
import { AppPermission, DEFAULT_ROLE_PERMISSIONS } from "../../backend/auth/permissions.ts";
import { type RobotEntity } from "../../storage/robot-models.ts";
import { type UserEntity } from "../../backend/auth/user-models.ts";
import { ErrorCode, MolirisAppError } from "../../errors/app-errors.ts";
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

const sftpServer = new ssh2.Server(
  {
    hostKeys: [serverHostKey.privateKey],
  },
  (client) => {
    client.on("authentication", (ctx) => {
      ctx.accept();
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
            if (mockRemoteFs[norm] !== undefined) {
              const isDir = mockRemoteFs[norm].toString() === "DIR";
              return sftp.attrs(reqid, {
                mode: isDir ? 0o040755 : 0o100644,
                size: mockRemoteFs[norm].length,
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
            for (const key of Object.keys(mockRemoteFs)) {
              if (key !== h.path && key.startsWith(dirPrefix)) {
                const sub = key.slice(dirPrefix.length);
                if (!sub.includes("/")) {
                  const isDir = mockRemoteFs[key].toString() === "DIR";
                  entries.push({
                    filename: sub,
                    attrs: {
                      mode: isDir ? 0o040755 : 0o100644,
                      size: mockRemoteFs[key].length,
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
            const handle = Buffer.from(`file_${nextHandleId++}`);
            openHandles.set(handle.toString(), { path: norm, isDir: false });
            if (!mockRemoteFs[norm]) {
              mockRemoteFs[norm] = Buffer.alloc(0);
            }
            sftp.handle(reqid, handle);
          });

          sftp.on("WRITE", (reqid: number, handle: Buffer, offset: number, data: Buffer) => {
            const h = openHandles.get(handle.toString());
            if (!h) return sftp.status(reqid, 4 /* SSH_FX_FAILURE */);
            const cur = mockRemoteFs[h.path] || Buffer.alloc(0);
            const needed = offset + data.length;
            let nextBuf = cur;
            if (cur.length < needed) {
              nextBuf = Buffer.alloc(needed);
              cur.copy(nextBuf, 0, 0, cur.length);
            }
            data.copy(nextBuf, offset);
            mockRemoteFs[h.path] = nextBuf;
            sftp.status(reqid, 0 /* SSH_FX_OK */);
          });

          sftp.on("CLOSE", (reqid: number, handle: Buffer) => {
            openHandles.delete(handle.toString());
            sftp.status(reqid, 0);
          });

          sftp.on("RENAME", (reqid: number, oldPath: string, newPath: string) => {
            const normOld = path.posix.normalize(oldPath);
            const normNew = path.posix.normalize(newPath);
            if (mockRemoteFs[normOld] !== undefined) {
              mockRemoteFs[normNew] = mockRemoteFs[normOld];
              delete mockRemoteFs[normOld];
              return sftp.status(reqid, 0);
            }
            return sftp.status(reqid, 2);
          });

          sftp.on("UNLINK", (reqid: number, p: string) => {
            const norm = path.posix.normalize(p);
            delete mockRemoteFs[norm];
            sftp.status(reqid, 0);
          });
        });
      });
    });
  }
);

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
  maxBulkUploadFiles: 20,
  defaultOperatorAllowedPaths: ["upload", "shared", "logs"],
  remoteFsAllowedPaths: ["/upload", "/shared"],
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
  roles: ["amministratore"],
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
  if (!fs.existsSync(stagingDir)) fs.mkdirSync(stagingDir, { recursive: true });
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
  if (!fs.existsSync(stagingDir)) fs.mkdirSync(stagingDir, { recursive: true });

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

  const server = createServer(config, logger, {
    sessionManager,
    userRepository: userRepo,
    auditRepository: auditRepo,
    robotRepository: robotRepo,
    serverFsService,
    credentialProvider,
    hostKeyVerifier,
    connectionManager,
    transferService,
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
    cookies: { moliris_session: sessionOp.sessionId },
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
    cookies: { moliris_session: sessionAdmin.sessionId },
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
    },
    cookies: { moliris_session: sessionAdmin.sessionId },
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
    },
    cookies: { moliris_session: sessionAdmin.sessionId },
    payload: multipartSuccess,
  });
  assert.strictEqual(resSuccess.statusCode, 200, "Upload multipart valido deve restituire 200 OK");
  const successJson = JSON.parse(resSuccess.body);
  assert.strictEqual(successJson.success, true);
  assert.strictEqual(successJson.summary.completed, 1);

  const writtenRestFile = path.join(robot1.serverDirectoryPath, "upload", "rest_upload_file.txt");
  assert.strictEqual(fs.readFileSync(writtenRestFile, "utf-8"), restFileContent);

  await server.close();
  console.log("  PASS: Test 6 - Endpoint REST Fastify /pre-check e /upload multipart collaudati con successo.");
}

// Chiusura risorse
transferService.stopCleanupTask();
await connectionManager.closeAll();
sftpServer.close();
fs.rmSync(tmpServerRoot, { recursive: true, force: true });
fs.rmSync(tmpTlsDir, { recursive: true, force: true });

console.log("PASS: Tutti i test del modulo Caricamento Massivo Multi-Target e Jail RBAC completati con successo.");
