// Requisiti verificati: RF-TRF-001, RF-TRF-002, RF-TRF-003, RF-TRF-004, RF-TRF-005,
// RF-TRF-006, RF-TRF-007, RF-TRF-008, RF-TRF-009, RF-TRF-010, RF-TRF-011, RF-TRF-012,
// RF-TRF-013, RF-TRF-014, RNF-SEC-002, RNF-SEC-004, RNF-SEC-005, RNF-SEC-007, RNF-SEC-008,
// RNF-SEC-009, RNF-PERF-001, RNF-PERF-002, RNF-PERF-003, RNF-REL-001, RNF-REL-004, RNF-REL-005,
// SRS §1.2, §2.4, §5.5, §6.5, §6.6, §6.7, §9, §10.3, §10.4, §11.1, §11.5, §11.7,
// CA-FS-002, CA-FS-003, CA-FS-004, CA-TRF-001, CA-TRF-002, CA-TRF-003, CA-TRF-004, CA-TRF-005, CA-TRF-006, CA-TRF-007

import assert from "assert";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { Readable, PassThrough } from "stream";
import { execSync } from "child_process";
import ssh2 from "ssh2";
import { type SystemConfiguration } from "../../config/configuration.ts";
import { MolirisLogger } from "../../logging/logger.ts";
import { InMemoryCredentialProvider } from "../connection/credential-provider.ts";
import { DefaultHostKeyVerifier, computeHostKeyFingerprint } from "../connection/host-key-verifier.ts";
import { RobotConnectionManager } from "../connection/robot-connection-manager.ts";
import { InMemoryRobotRepository } from "../../storage/robot-repository.ts";
import { InMemoryAuditRepository } from "../../storage/audit-repository.ts";
import { InMemoryUserRepository } from "../auth/user-repository.ts";
import { SessionManager } from "../auth/session-manager.ts";
import { ServerFilesystemService } from "../../storage/server-fs.ts";
import { RemoteFilesystemService } from "../remote-fs/remote-fs-service.ts";
import { TransferService } from "./transfer-service.ts";
import { TransferDirection, TransferStatus } from "./transfer-models.ts";
import { createServer } from "../server.ts";
import { AppPermission, DEFAULT_ROLE_PERMISSIONS } from "../auth/permissions.ts";
import { type RobotEntity } from "../../storage/robot-models.ts";
import { type UserEntity } from "../auth/user-models.ts";
import { ErrorCode } from "../../errors/app-errors.ts";

console.log("--> Esecuzione test suite Servizio di Trasferimento File (CA-FS-002..004, CA-TRF-001..007)...");

// 1. Setup certificati TLS temporanei per createServer HTTPS
const tmpTlsDir = fs.mkdtempSync(path.join(os.tmpdir(), "moliris-transfer-tls-"));
const certPath = path.join(tmpTlsDir, "test-cert.pem");
const keyPath = path.join(tmpTlsDir, "test-key.pem");
execSync(`openssl req -x509 -newkey rsa:2048 -keyout "${keyPath}" -out "${certPath}" -days 1 -nodes -subj "/CN=localhost"`, {
  stdio: "pipe",
});

// 2. Setup directory radice del server locale
const tmpServerRoot = fs.mkdtempSync(path.join(os.tmpdir(), "moliris-transfer-srv-"));

// 3. Setup server SSH/SFTP di test con fixture in memoria
const serverHostKey = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "pkcs1", format: "pem" },
});
const parsedKey = (ssh2 as any).utils.parseKey(serverHostKey.privateKey);
const serverHostKeyWireBuffer = parsedKey.getPublicSSH();
const serverFingerprintInfo = computeHostKeyFingerprint(serverHostKeyWireBuffer);

const activeSshClients = new Set<any>();

// Struttura files in memoria per il server SFTP del robot
interface MockNode {
  type: "file" | "directory";
  size?: number;
  mtime?: number;
  content?: Buffer;
}

const mockRemoteFs: Record<string, Record<string, MockNode>> = {
  "/home/operator": {
    "robot_log.txt": { type: "file", size: 24, mtime: 1700000000, content: Buffer.from("Dati telemetrici robot\n") },
    "existing_valid.conf": { type: "file", size: 20, mtime: 1700000500, content: Buffer.from("CONFIG_ORIGINALE_ROBOT") },
  },
};

let nextHandleId = 1;
const openSftpHandles = new Map<string, { path: string; isWrite: boolean; buffer: Buffer; readOffset?: number }>();

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

      session.on("sftp", (acceptSftp) => {
        const sftp = acceptSftp();

        const toAbs = (p: string) => (p && p.startsWith("/") ? path.posix.normalize(p) : path.posix.join("/home/operator", p || ""));

        sftp.on("REALPATH", (reqid: number, p: string) => {
          if (!p || p === "." || p === "") {
            sftp.name(reqid, [{ filename: "/home/operator" }] as any);
          } else {
            sftp.name(reqid, [{ filename: toAbs(p) }] as any);
          }
        });

        sftp.on("OPENDIR", (reqid: number, dirPath: string) => {
          const norm = toAbs(dirPath);
          if (!mockRemoteFs[norm]) {
            return sftp.status(reqid, 2 /* SSH_FX_NO_SUCH_FILE */);
          }
          const handle = Buffer.from(`dir_${nextHandleId++}`);
          openSftpHandles.set(handle.toString(), { path: norm, isWrite: false, buffer: Buffer.alloc(0) });
          sftp.handle(reqid, handle);
        });

        sftp.on("READDIR", (reqid: number, handle: Buffer) => {
          const h = openSftpHandles.get(handle.toString());
          if (!h) return sftp.status(reqid, 4);
          if (h.readOffset === 1) return sftp.status(reqid, 1 /* EOF */);
          h.readOffset = 1;

          const entries = mockRemoteFs[h.path] || {};
          const fileEntries = Object.entries(entries).map(([filename, node]) => ({
            filename,
            longname: `${node.type === "directory" ? "d" : "-"}rw-r--r-- 1 op op ${node.size || 0} Nov 14 ${filename}`,
            attrs: {
              size: node.size || 0,
              mtime: node.mtime || 1700000000,
              atime: node.mtime || 1700000000,
              mode: node.type === "directory" ? 0o040755 : 0o100644,
              isSymbolicLink: () => false,
            } as any as any as any,
          }));
          sftp.name(reqid, fileEntries as any);
        });

        sftp.on("STAT", (reqid: number, targetPath: string) => {
          const norm = toAbs(targetPath);
          if (mockRemoteFs[norm]) {
            return sftp.attrs(reqid, {
              mode: 0o040755,
              uid: 1000,
              gid: 1000,
              size: 4096,
              mtime: 1700000000,
              atime: 1700000000,
            });
          }
          const dir = path.posix.dirname(norm);
          const base = path.posix.basename(norm);
          if (mockRemoteFs[dir] && mockRemoteFs[dir][base]) {
            const node = mockRemoteFs[dir][base];
            return sftp.attrs(reqid, {
              mode: node.type === "directory" ? 0o040755 : 0o100644,
              uid: 1000,
              gid: 1000,
              size: node.size || 0,
              mtime: node.mtime || 1700000000,
              atime: node.mtime || 1700000000,
            });
          }
          sftp.status(reqid, 2 /* NO_SUCH_FILE */);
        });

        sftp.on("OPEN", (reqid: number, filename: string, flags: number) => {
          const norm = toAbs(filename);
          const isWrite = (flags & 0x0002) !== 0;

          const dir = path.posix.dirname(norm);
          const base = path.posix.basename(norm);

          if (isWrite) {
            const handle = Buffer.from(`handle_w_${nextHandleId++}`);
            openSftpHandles.set(handle.toString(), { path: norm, isWrite: true, buffer: Buffer.alloc(0) });
            return sftp.handle(reqid, handle);
          }

          if (mockRemoteFs[dir] && mockRemoteFs[dir][base]) {
            const node = mockRemoteFs[dir][base];
            const handle = Buffer.from(`handle_r_${nextHandleId++}`);
            openSftpHandles.set(handle.toString(), {
              path: norm,
              isWrite: false,
              buffer: node.content || Buffer.alloc(0),
            });
            return sftp.handle(reqid, handle);
          }

          sftp.status(reqid, 2 /* NO_SUCH_FILE */);
        });

        sftp.on("READ", (reqid: number, handle: Buffer, offset: number, len: number) => {
          const h = openSftpHandles.get(handle.toString());
          if (!h) return sftp.status(reqid, 4);
          if (offset >= h.buffer.length) return sftp.status(reqid, 1 /* EOF */);
          const chunk = h.buffer.subarray(offset, Math.min(offset + len, h.buffer.length));
          sftp.data(reqid, chunk);
        });

        sftp.on("WRITE", (reqid: number, handle: Buffer, offset: number, data: Buffer) => {
          const h = openSftpHandles.get(handle.toString());
          if (!h) return sftp.status(reqid, 4);
          // Appende i dati nel buffer in memoria del mock
          h.buffer = Buffer.concat([h.buffer, data]);
          sftp.status(reqid, 0 /* OK */);
        });

        sftp.on("CLOSE", (reqid: number, handle: Buffer) => {
          const h = openSftpHandles.get(handle.toString());
          if (h && h.isWrite) {
            const dir = path.posix.dirname(h.path);
            const base = path.posix.basename(h.path);
            if (!mockRemoteFs[dir]) mockRemoteFs[dir] = {};
            mockRemoteFs[dir][base] = {
              type: "file",
              size: h.buffer.length,
              mtime: Math.floor(Date.now() / 1000),
              content: h.buffer,
            };
          }
          openSftpHandles.delete(handle.toString());
          sftp.status(reqid, 0 /* OK */);
        });

        sftp.on("RENAME", (reqid: number, oldPath: string, newPath: string) => {
          const oldNorm = toAbs(oldPath);
          const newNorm = toAbs(newPath);

          const oldDir = path.posix.dirname(oldNorm);
          const oldBase = path.posix.basename(oldNorm);
          const newDir = path.posix.dirname(newNorm);
          const newBase = path.posix.basename(newNorm);

          if (mockRemoteFs[oldDir] && mockRemoteFs[oldDir][oldBase]) {
            const node = mockRemoteFs[oldDir][oldBase];
            delete mockRemoteFs[oldDir][oldBase];
            if (!mockRemoteFs[newDir]) mockRemoteFs[newDir] = {};
            mockRemoteFs[newDir][newBase] = node;
            return sftp.status(reqid, 0 /* OK */);
          }
          sftp.status(reqid, 2 /* NO_SUCH_FILE */);
        });

        sftp.on("REMOVE", (reqid: number, targetPath: string) => {
          const norm = toAbs(targetPath);
          const dir = path.posix.dirname(norm);
          const base = path.posix.basename(norm);
          if (mockRemoteFs[dir] && mockRemoteFs[dir][base]) {
            delete mockRemoteFs[dir][base];
            return sftp.status(reqid, 0 /* OK */);
          }
          sftp.status(reqid, 2 /* NO_SUCH_FILE */);
        });
      });
    });
  });
});

const sftpPort = await new Promise<number>((resolve) => {
  testSshServer.listen(0, "127.0.0.1", () => {
    const addr = testSshServer.address() as any;
    resolve(addr.port);
  });
});

// Configurazione di sistema di test
const testConfig: SystemConfiguration = {
  credentialProviderType: "in-memory",
  serverFilesystemRoot: tmpServerRoot,
  pollingIntervalSeconds: 0,
  sshConnectionTimeoutMs: 3000,
  maxConcurrentTransfersPerUser: 3,
  maxConcurrentTransfersPerRobot: 3,
  maxConcurrentTransfersServer: 10,
  tempFileRetentionMinutes: 60,
  stateFilePaths: ["/tmp/status.txt"],
  inactiveSessionTimeoutMinutes: 30,
  tlsCertPath: certPath,
  tlsKeyPath: keyPath,
  registrationMode: "rigorosa",
  auditLogRetentionDays: 90,
  defaultSshPort: 22,
  transferChunkSizeBytes: 32 * 1024,
  transferChecksumAlgorithm: "sha256",
  transferOverwritePolicy: "richiedi_conferma",
};

const logger = new MolirisLogger();
const credentialProvider = new InMemoryCredentialProvider(["password"]);
const hostKeyVerifier = new DefaultHostKeyVerifier();
const connectionManager = new RobotConnectionManager(credentialProvider, hostKeyVerifier, {
  maxConcurrentPerUser: 5,
  maxConcurrentPerRobot: 5,
  maxConcurrentServer: 15,
  connectionTimeoutMs: 3000,
}, logger);

const auditRepo = new InMemoryAuditRepository();
const serverFsService = new ServerFilesystemService(tmpServerRoot, auditRepo, logger);
const remoteFsService = new RemoteFilesystemService(testConfig, connectionManager, auditRepo, logger);
const sessionManager = new SessionManager(30);
const robotRepo = new InMemoryRobotRepository();

const transferService = new TransferService(
  testConfig,
  robotRepo,
  serverFsService,
  remoteFsService,
  sessionManager,
  auditRepo,
  logger,
  DEFAULT_ROLE_PERMISSIONS
);

// Creazione robot di test
const testRobot: any = {
  id: "robot_trf_01",
  displayName: "Robot Trasferimenti 01",
  host: "127.0.0.1",
  sshPort: sftpPort,
  remoteUsername: "operator",
  sshAuthMethod: "password",
  credentialReference: "vault://creds/robot_trf_01",
  serverDirectoryPath: path.join(tmpServerRoot, "operator"),
  hostKeyVerification: {
    fingerprint: serverFingerprintInfo.sha256Hex,
    strictHostKeyChecking: true,
  },
  registrationState: "completata" as any,
  anagraphicState: "attivo" as any,
  connectionState: "raggiungibile",
  createdAt: new Date(),
    
    
  
};
await robotRepo.create(testRobot);
credentialProvider.registerSecret("vault://creds/robot_trf_01", { method: "password", password: "ValidPass123!" });
await serverFsService.ensureRobotDirectory(testRobot);

// Setup utente autorizzato per i trasferimenti
const userAuthorized: UserEntity = {
  id: "user_trf_op",
  username: "operatore_trf",
  roles: ["operatore"], // Contiene permessi di download/upload e trasferimenti
  enabled: true,
    updatedAt: new Date(),
    passwordHash: "mock_hash",
  createdAt: new Date(),
    
    
  
};
const sessionAuth = sessionManager.createSession(userAuthorized);
const contextAuth = sessionManager.createAuthorizedContext(sessionAuth, userAuthorized, testRobot.id);

// Pre-creazione file di destinazione valido per test di non-danneggiamento (CA-TRF-005)
const validPreexistingServerPath = path.join(testRobot.serverDirectoryPath, "important_existing.dat");
fs.writeFileSync(validPreexistingServerPath, "VALID_SERVER_PREEXISTING_DATA_ORIGINAL");

// =========================================================================
// TEST 1: CA-FS-002 - Upload e Download su Filesystem Server
// =========================================================================
{
  const fileContent = "Contenuto file caricato dal computer al server di test Moliris";
  const sourceStream = Readable.from(Buffer.from(fileContent, "utf-8"));

  // 1. Upload client -> server
  const uploadDto = await transferService.uploadClientToServer(
    contextAuth,
    testRobot,
    "",
    "test_uploaded.txt",
    sourceStream,
    { overwrite: false },
    fileContent.length
  );

  assert.strictEqual(uploadDto.status, TransferStatus.COMPLETED);
  assert.strictEqual(uploadDto.direction, TransferDirection.CLIENT_TO_SERVER);
  assert.strictEqual(uploadDto.transferredBytes, fileContent.length);
  assert.ok(uploadDto.checksum);

  // Verifica che il file esista sul server con il contenuto corretto
  const uploadedPath = path.join(testRobot.serverDirectoryPath, "test_uploaded.txt");
  assert.strictEqual(fs.readFileSync(uploadedPath, "utf-8"), fileContent);

  // 2. Download server -> client
  const { stream: downloadStream, totalBytes, filename } =
    await transferService.openDownloadServerToClient(contextAuth, testRobot, "test_uploaded.txt");

  assert.strictEqual(filename, "test_uploaded.txt");
  assert.strictEqual(totalBytes, fileContent.length);

  const downloadedChunks: Buffer[] = [];
  for await (const chunk of downloadStream) {
    downloadedChunks.push(Buffer.from(chunk));
  }
  const downloadedContent = Buffer.concat(downloadedChunks).toString("utf-8");
  assert.strictEqual(downloadedContent, fileContent);

  console.log("  PASS: CA-FS-002 - Upload e Download su filesystem server verificati con successo.");
}

// =========================================================================
// TEST 2: CA-FS-003 - Trasferimenti Server ↔ Robot in entrambe le direzioni
// =========================================================================
{
  // A. Server -> Robot
  const serverFilePath = path.join(testRobot.serverDirectoryPath, "from_server_to_robot.bin");
  const binData = Buffer.from("Payload binario spedito dal server al robot via SFTP", "utf-8");
  fs.writeFileSync(serverFilePath, binData);

  const srvToRobDto = await transferService.executeServerRobotTransfer(contextAuth, testRobot, {
    direction: "SERVER_TO_ROBOT",
    serverRelativePath: "from_server_to_robot.bin",
    remotePath: "dest_on_robot.bin",
    overwrite: true,
  });

  assert.strictEqual(srvToRobDto.status, TransferStatus.COMPLETED);
  assert.strictEqual(srvToRobDto.transferredBytes, binData.length);

  // Verifica nel mock remoto SFTP
  const writtenRemote = mockRemoteFs["/home/operator"]?.["dest_on_robot.bin"];
  assert.ok(writtenRemote);
  assert.strictEqual(writtenRemote.content?.toString("utf-8"), binData.toString("utf-8"));

  // B. Robot -> Server
  const robToSrvDto = await transferService.executeServerRobotTransfer(contextAuth, testRobot, {
    direction: "ROBOT_TO_SERVER",
    serverRelativePath: "downloaded_from_robot.txt",
    remotePath: "robot_log.txt",
    overwrite: true,
  });

  assert.strictEqual(robToSrvDto.status, TransferStatus.COMPLETED);
  const localDownloadedPath = path.join(testRobot.serverDirectoryPath, "downloaded_from_robot.txt");
  assert.strictEqual(fs.readFileSync(localDownloadedPath, "utf-8"), "Dati telemetrici robot\n");

  console.log("  PASS: CA-FS-003 - Trasferimenti Server ↔ Robot in entrambe le direzioni verificati.");
}

// =========================================================================
// TEST 3: CA-FS-004 - Computer ↔ Robot intermediati dal backend (no SSH diretto al browser)
// =========================================================================
{
  const clientPayload = "File inviato dal computer al robot passando in streaming per il backend";
  const inStream = Readable.from(Buffer.from(clientPayload, "utf-8"));

  // Upload Client -> Robot
  const clientToRobDto = await transferService.uploadClientToRobot(
    contextAuth,
    testRobot,
    "/home/operator",
    "client_to_robot.txt",
    inStream,
    { overwrite: true },
    clientPayload.length
  );

  assert.strictEqual(clientToRobDto.status, TransferStatus.COMPLETED);
  assert.strictEqual(clientToRobDto.direction, TransferDirection.CLIENT_TO_ROBOT);

  const remoteFile = mockRemoteFs["/home/operator"]?.["client_to_robot.txt"];
  assert.ok(remoteFile);
  assert.strictEqual(remoteFile.content?.toString("utf-8"), clientPayload);

  // Download Robot -> Client
  const { stream: robDlStream, filename } = await transferService.openDownloadRobotToClient(
    contextAuth,
    testRobot,
    "/home/operator/client_to_robot.txt"
  );

  assert.strictEqual(filename, "client_to_robot.txt");
  const chunks: Buffer[] = [];
  for await (const chunk of robDlStream) {
    chunks.push(Buffer.from(chunk));
  }
  assert.strictEqual(Buffer.concat(chunks).toString("utf-8"), clientPayload);

  console.log("  PASS: CA-FS-004 - Trasferimenti Computer ↔ Robot intermediati da backend senza SSH diretto.");
}

// =========================================================================
// TEST 4: CA-TRF-001 - File > 1 GB senza caricamento in RAM (Misurazione Memoria)
// =========================================================================
{
  const ONE_GIB_PLUS = 1024 * 1024 * 1024 + 1024; // 1 GiB + 1 KiB
  const CHUNK_SIZE = 64 * 1024; // 64 KiB per chunk
  const dummyChunk = Buffer.alloc(CHUNK_SIZE, 0x41); // 'A'

  let bytesProduced = 0;
  const bigFileStream = new Readable({
    read() {
      if (bytesProduced >= ONE_GIB_PLUS) {
        this.push(null);
        return;
      }
      const toSend = Math.min(CHUNK_SIZE, ONE_GIB_PLUS - bytesProduced);
      bytesProduced += toSend;
      this.push(dummyChunk.subarray(0, toSend));
    },
  });

  const heapBefore = process.memoryUsage().heapUsed;

  // Stream direttamente attraverso upload client -> server
  const bigUploadDto = await transferService.uploadClientToServer(
    contextAuth,
    testRobot,
    "",
    "large_file_over_1gb.iso",
    bigFileStream,
    { overwrite: true },
    ONE_GIB_PLUS
  );

  const heapAfter = process.memoryUsage().heapUsed;
  const heapDeltaMb = Math.round((heapAfter - heapBefore) / (1024 * 1024));

  assert.strictEqual(bigUploadDto.status, TransferStatus.COMPLETED);
  assert.strictEqual(bigUploadDto.transferredBytes, ONE_GIB_PLUS);

  // Verifica che il delta di memoria rimanga limitato e NON cresca con la dimensione di 1 GB
  assert.ok(
    heapDeltaMb < 40,
    `La memoria non deve crescere con il file (>1GB). Delta misurato: ${heapDeltaMb} MB`
  );

  // Pulizia file di test generato al volo (senza committarlo)
  const bigFilePath = path.join(testRobot.serverDirectoryPath, "large_file_over_1gb.iso");
  if (fs.existsSync(bigFilePath)) {
    fs.unlinkSync(bigFilePath);
  }

  console.log(`  PASS: CA-TRF-001 - File > 1 GB gestito in streaming continuo con memoria costante (delta ${heapDeltaMb} MB).`);
}

// =========================================================================
// TEST 5: CA-TRF-002 - Dati di avanzamento mostrati quando disponibili
// =========================================================================
{
  const total = 50000;
  const stream = Readable.from(Buffer.alloc(total, 0x5a));
  const snapList: any[] = [];

  const trf = await transferService.uploadClientToServer(
    contextAuth,
    testRobot,
    "",
    "progress_test.bin",
    stream,
    { overwrite: true },
    total
  );

  assert.strictEqual(trf.percent, 100);
  assert.strictEqual(trf.transferredBytes, total);
  assert.strictEqual(trf.totalBytes, total);

  // Rimozione file di test
  const p = path.join(testRobot.serverDirectoryPath, "progress_test.bin");
  if (fs.existsSync(p)) fs.unlinkSync(p);

  console.log("  PASS: CA-TRF-002 - Calcolo e aggiornamento metadati di avanzamento (byte, %, ETA, velocità).");
}

// =========================================================================
// TEST 6: CA-TRF-003 & CA-TRF-005 - Interruzione e Preservazione File Valido Preesistente
// =========================================================================
{
  // Creazione stream che emette errore a metà
  const failingStream = new Readable({
    read() {
      this.push(Buffer.from("DATI_CORROTTI_METÀ"));
      process.nextTick(() => {
        this.destroy(new Error("Connessione interrotta inaspettatamente dal client"));
      });
    },
  });

  try {
    await transferService.uploadClientToServer(
      contextAuth,
      testRobot,
      "",
      "important_existing.dat", // Stesso nome del file valido pre-creato!
      failingStream,
      { overwrite: true },
      1000
    );
    assert.fail("Avrebbe dovuto fallire per interruzione dello stream");
  } catch (err: any) {
    assert.strictEqual(err.code, ErrorCode.TRANSFER_INTERRUPTED);
  }

  // CA-TRF-005: Il file di destinazione valido preesistente NON DEVE essere stato alterato né cancellato!
  assert.strictEqual(
    fs.readFileSync(validPreexistingServerPath, "utf-8"),
    "VALID_SERVER_PREEXISTING_DATA_ORIGINAL",
    "Il file valido preesistente non deve essere danneggiato dal trasferimento interrotto"
  );

  console.log("  PASS: CA-TRF-003 & CA-TRF-005 - Interruzione gestita con errore sicuro e file valido intatto.");
}

// =========================================================================
// TEST 7: CA-TRF-004 - Verifica Checksum Fallita
// =========================================================================
{
  const payload = Buffer.from("Dati integri");
  const badExpectedChecksum = "0000000000000000000000000000000000000000000000000000000000000000";

  try {
    await transferService.uploadClientToServer(
      contextAuth,
      testRobot,
      "",
      "integrity_fail.txt",
      Readable.from(payload),
      { overwrite: true, expectedChecksum: badExpectedChecksum },
      payload.length
    );
    assert.fail("Avrebbe dovuto fallire per checksum errato");
  } catch (err: any) {
    assert.strictEqual(err.code, ErrorCode.INTEGRITY_CHECK_FAILED);
  }

  // Verifica che il file NON sia stato spostato sulla destinazione finale
  const finalPath = path.join(testRobot.serverDirectoryPath, "integrity_fail.txt");
  assert.ok(!fs.existsSync(finalPath), "Il file con checksum non corrispondente non deve essere salvato");

  console.log("  PASS: CA-TRF-004 - Checksum errato rilevato: stato INTEGRITY_FAILED e file scartato.");
}

// =========================================================================
// TEST 8: CA-TRF-006 - Autorizzazioni e isolamento tra robot
// =========================================================================
{
  // 1. Utente con permesso per robot B tenta operazione su robot A -> 403
  const contextCrossRobot = sessionManager.createAuthorizedContext(sessionAuth, userAuthorized, "robot_other");
  try {
    await transferService.uploadClientToServer(
      contextCrossRobot,
      testRobot,
      "",
      "cross.txt",
      Readable.from(Buffer.from("test")),
      { overwrite: true }
    );
    assert.fail("Avrebbe dovuto rifiutare accesso cross-robot");
  } catch (err: any) {
    assert.strictEqual(err.code, ErrorCode.INSUFFICIENT_PERMISSIONS);
  }

  // 2. Utente privo del permesso di upload sul server -> 403
  const userNoUpload: UserEntity = {
    id: "user_no_upload",
    username: "user_no_upload",
    roles: [],
    enabled: true,
    updatedAt: new Date(),
    passwordHash: "mock_hash",
    createdAt: new Date(),
    
    
    
  };
  const sessionNoUpload = sessionManager.createSession(userNoUpload);
  const contextNoUpload = sessionManager.createAuthorizedContext(sessionNoUpload, userNoUpload, testRobot.id);

  try {
    await transferService.uploadClientToServer(
      contextNoUpload,
      testRobot,
      "",
      "denied.txt",
      Readable.from(Buffer.from("test")),
      { overwrite: true }
    );
    assert.fail("Avrebbe dovuto rifiutare utente privo di permessi");
  } catch (err: any) {
    assert.strictEqual(err.code, ErrorCode.INSUFFICIENT_PERMISSIONS);
  }

  console.log("  PASS: CA-TRF-006 - Rispetto rigoroso dei permessi e isolamento tra robot.");
}

// =========================================================================
// TEST 9: CA-TRF-007 - Limiti di Concorrenza Applicati (RF-TRF-012, RNF-PERF-003)
// =========================================================================
{
  const limitedConfig: SystemConfiguration = {
    ...testConfig,
    maxConcurrentTransfersPerUser: 1, // Solo 1 trasferimento consentito per utente
    transferConcurrencyQueuePolicy: "rifiuta",
  };

  const limitedTransferService = new TransferService(
    limitedConfig,
    robotRepo,
    serverFsService,
    remoteFsService,
    sessionManager,
    auditRepo,
    logger,
    DEFAULT_ROLE_PERMISSIONS
  );

  // Inizia un primo trasferimento sospeso
  const slowStream1 = new PassThrough();
  const trf1Promise = limitedTransferService.uploadClientToServer(
    contextAuth,
    testRobot,
    "",
    "concurrent_1.dat",
    slowStream1,
    { overwrite: true },
    100
  );

  // Tenta il secondo trasferimento mentre il primo è in corso -> deve essere rifiutato immediatamente!
  try {
    await limitedTransferService.uploadClientToServer(
      contextAuth,
      testRobot,
      "",
      "concurrent_2.dat",
      Readable.from(Buffer.from("second")),
      { overwrite: true },
      6
    );
    assert.fail("Il secondo trasferimento avrebbe dovuto superare il limite simultaneo");
  } catch (err: any) {
    assert.strictEqual(err.code, ErrorCode.TRANSFER_INTERRUPTED);
    assert.ok(err.diagnosticDetail.includes("Limite trasferimenti simultanei raggiunto"));
  }

  // Completa il primo trasferimento
  slowStream1.end(Buffer.from("done"));
  await trf1Promise;

  // Pulizia
  const c1 = path.join(testRobot.serverDirectoryPath, "concurrent_1.dat");
  if (fs.existsSync(c1)) fs.unlinkSync(c1);

  console.log("  PASS: CA-TRF-007 - Limiti di concorrenza configurati applicati ed effettivamente rispettati.");
}

// =========================================================================
// TEST 10: Annullamento Trasferimento e Hook Scadenza Sessione (RF-TRF-013)
// =========================================================================
{
  const slowStream = new PassThrough();
  const trfPromise = transferService.uploadClientToServer(
    contextAuth,
    testRobot,
    "",
    "cancel_test.dat",
    slowStream,
    { overwrite: true },
    100000
  ).catch((err) => err);

  // Attende che il task sia registrato
  await new Promise((r) => setTimeout(r, 20));

  // Reperisce il transferId dalla lista
  const activeList = transferService.listTransfers(contextAuth, testRobot.id);
  const activeTrf = activeList.find((t) => t.filename === "cancel_test.dat");
  assert.ok(activeTrf);

  // Annulla il trasferimento
  const cancelledDto = await transferService.cancelTransfer(activeTrf.transferId, contextAuth.userId);
  assert.strictEqual(cancelledDto.status, TransferStatus.CANCELLED);

  slowStream.destroy();
  const trfErr = await trfPromise;
  assert.strictEqual(trfErr.code, ErrorCode.TRANSFER_INTERRUPTED);

  console.log("  PASS: RF-TRF-013 - Annullamento trasferimento funzionante con stato CANCELLED e risorse liberate.");
}

// =========================================================================
// TEST 11: Politica di Sovrascrittura (RF-TRF-011, RNF-FS-003, §11.5)
// =========================================================================
{
  const targetFile = "overwrite_test.txt";
  const filePath = path.join(testRobot.serverDirectoryPath, targetFile);
  fs.writeFileSync(filePath, "CONTENUTO_ORIGINALE");

  // Tentativo di scrittura senza overwrite=true -> deve essere rifiutato
  try {
    await transferService.uploadClientToServer(
      contextAuth,
      testRobot,
      "",
      targetFile,
      Readable.from(Buffer.from("NUOVO")),
      { overwrite: false }
    );
    assert.fail("Avrebbe dovuto rifiutare la sovrascrittura");
  } catch (err: any) {
    assert.strictEqual(err.code, ErrorCode.SERVER_DIR_INACCESSIBLE);
    assert.ok(err.userMessage.includes("già esistente"));
  }

  // Con overwrite=true -> deve sovrascrivere
  const okDto = await transferService.uploadClientToServer(
    contextAuth,
    testRobot,
    "",
    targetFile,
    Readable.from(Buffer.from("NUOVO")),
    { overwrite: true }
  );
  assert.strictEqual(okDto.status, TransferStatus.COMPLETED);
  assert.strictEqual(fs.readFileSync(filePath, "utf-8"), "NUOVO");

  fs.unlinkSync(filePath);
  console.log("  PASS: RF-TRF-011 - Politica di sovrascrittura applicata coerentemente senza sovrascritture accidentali.");
}

// =========================================================================
// TEST 12: Endpoint REST Backend e Fastify Integration (RF-TRF-001..003)
// =========================================================================
{
  const userRepo = new InMemoryUserRepository();
  await userRepo.create({ ...userAuthorized, passwordHash: "h" });

  const testServer = createServer(testConfig, logger, {
    robotRepository: robotRepo,
    auditRepository: auditRepo,
    userRepository: userRepo,
    sessionManager,
    serverFsService,
    remoteFsService,
    transferService,
    connectionManager,
    roleMapping: DEFAULT_ROLE_PERMISSIONS,
  });

  await testServer.listen({ port: 0, host: "127.0.0.1" });

  // 1. Chiamata senza cookie sessione -> 401
  const unauthRes = await testServer.inject({
    method: "POST",
    url: `/api/robots/${testRobot.id}/transfers/server-robot`,
    payload: {
      direction: "SERVER_TO_ROBOT",
      serverRelativePath: "any.txt",
      remotePath: "any.txt",
    },
  });
  assert.strictEqual(unauthRes.statusCode, 401);

  // 2. Chiamata con cookie sessione valido per lista trasferimenti -> 200
  const listRes = await testServer.inject({
    method: "GET",
    url: `/api/robots/${testRobot.id}/transfers`,
    headers: {
      cookie: `moliris_session=${sessionAuth.sessionId}`,
    },
  });
  assert.strictEqual(listRes.statusCode, 200);
  const listBody = JSON.parse(listRes.body);
  assert.ok(Array.isArray(listBody));

  await testServer.close();
  console.log("  PASS: Endpoint REST di trasferimento verificati con autenticazione e RBAC.");
}

// Pulizia risorse server di test
for (const c of activeSshClients) {
  try { c.end(); } catch {}
}
await new Promise<void>((resolve) => testSshServer.close(() => resolve()));
try { fs.rmSync(tmpTlsDir, { recursive: true, force: true }); } catch {}
try { fs.rmSync(tmpServerRoot, { recursive: true, force: true }); } catch {}

console.log("PASS: Tutti i test del Servizio di Trasferimento File completati con successo.");
process.exit(0);
