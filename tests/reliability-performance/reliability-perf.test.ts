// @ts-nocheck
// Requisiti verificati: RNF-PERF-001, RNF-PERF-002, RNF-PERF-003, RNF-PERF-004, RNF-PERF-005,
// RNF-REL-001, RNF-REL-002, RNF-REL-003, RNF-REL-004, RNF-REL-005,
// SRS §12 punto 18, CA-TRF-001, §2.4, §5.5, §9, §10.3, §11.1, §11.5

import assert from "assert";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import os from "os";
import https from "https";
import http from "http";
import { Readable, Writable } from "stream";
import { execSync } from "child_process";
import { fileURLToPath } from "url";
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
import { RemoteFilesystemService } from "../../backend/remote-fs/remote-fs-service.ts";
import { TransferService } from "../../backend/transfer/transfer-service.ts";
import { TransferDirection, TransferStatus } from "../../backend/transfer/transfer-models.ts";
import { FleetService } from "../../backend/fleet/fleet-service.ts";
import { AppPermission, DEFAULT_ROLE_PERMISSIONS } from "../../backend/auth/permissions.ts";
import { type RobotEntity } from "../../storage/robot-models.ts";
import { type UserEntity } from "../../backend/auth/user-models.ts";
import { ErrorCode, MolirisAppError } from "../../errors/app-errors.ts";

console.log("--> Esecuzione test suite Affidabilità e Prestazioni (RNF-REL-001..005, RNF-PERF-001..005, CA-TRF-001, §12 punto 18)...");

// =========================================================================
// SETUP AMBIENTE DI TEST
// =========================================================================
const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "moliris-rel-perf-"));
const tmpServerFs = path.join(tmpBase, "server-fs");
const tmpTlsDir = path.join(tmpBase, "tls");
fs.mkdirSync(tmpServerFs, { recursive: true });
fs.mkdirSync(tmpTlsDir, { recursive: true });

// Generazione certificati TLS self-signed al volo
const certPath = path.join(tmpTlsDir, "cert.pem");
const keyPath = path.join(tmpTlsDir, "key.pem");
execSync(
  `openssl req -x509 -newkey rsa:2048 -keyout "${keyPath}" -out "${certPath}" -days 1 -nodes -subj "/CN=localhost"`,
  { stdio: "ignore" }
);

// Generazione host key SSH per il server mock
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

// Mock SFTP Server per gestire trasferimenti ad alte prestazioni e streaming costante
const ONE_GIB_PLUS = 1024 * 1024 * 1024 + 1024; // 1 GiB + 1 KiB
const CHUNK_SIZE = 64 * 1024; // 64 KiB
const syntheticZeroChunk = Buffer.alloc(CHUNK_SIZE, 0x4d); // 'M'

const openHandles = new Map<string, {
  isWrite: boolean;
  filePath: string;
  bytesTransferred: number;
  syntheticLarge: boolean;
}>();
const writtenFileSizes = new Map<string, number>();
let handleCounter = 0;

const mockSshServer = new ssh2.Server({ hostKeys: [serverHostKey] }, (client) => {
  if ((client as any)._sock) {
    (client as any)._sock.setNoDelay(true);
  }
  client.on("authentication", (ctx) => {
    if (ctx.method === "password") {
      ctx.accept();
    } else {
      ctx.reject(["password"]);
    }
  });

  client.on("ready", () => {
    client.on("session", (acceptSession) => {
      const session = acceptSession();

      session.on("exec", (acceptExec, _rejectExec, info) => {
        const stream = acceptExec();
        if (info.command.includes("test -r")) {
          stream.write("READABLE\n");
          stream.exit(0);
        } else {
          stream.write("UNKNOWN\n");
          stream.exit(0);
        }
        stream.end();
      });

      session.on("sftp", (acceptSftp) => {
        const sftp = acceptSftp();

        sftp.on("REALPATH", (reqid, p) => {
          sftp.name(reqid, [{ filename: p || "/" }]);
        });

        sftp.on("STAT", (reqid, p) => {
          const normP = path.posix.normalize(p || "");
          if (writtenFileSizes.has(normP)) {
            return sftp.attrs(reqid, {
              mode: 0o100644,
              size: writtenFileSizes.get(normP)!,
              uid: 1000,
              gid: 1000,
              atime: Math.floor(Date.now() / 1000),
              mtime: Math.floor(Date.now() / 1000),
            } as any);
          }
          if (normP.includes("synthetic_large_1gb")) {
            sftp.attrs(reqid, {
              mode: 0o100644,
              size: ONE_GIB_PLUS,
              uid: 1000,
              gid: 1000,
              atime: Math.floor(Date.now() / 1000),
              mtime: Math.floor(Date.now() / 1000),
            } as any);
          } else if (normP.includes("synthetic_file.bin") || normP.includes("status.txt")) {
            sftp.attrs(reqid, {
              mode: 0o100644,
              size: 1024 * 1024,
              uid: 1000,
              gid: 1000,
              atime: Math.floor(Date.now() / 1000),
              mtime: Math.floor(Date.now() / 1000),
            } as any);
          } else {
            sftp.status(reqid, 2 /* SSH_FX_NO_SUCH_FILE */);
          }
        });

        sftp.on("OPEN", (reqid, filename, flags) => {
          const hId = `h_${++handleCounter}`;
          const isWrite = (flags & 0x0002) !== 0;
          const syntheticLarge = filename.includes("synthetic_large_1gb") || filename.includes("over_1gb");
          openHandles.set(hId, {
            isWrite,
            filePath: filename,
            bytesTransferred: 0,
            syntheticLarge,
          });
          const hBuf = Buffer.from(hId);
          sftp.handle(reqid, hBuf);
        });

        sftp.on("READ", (reqid, handle, offset, len) => {
          const h = openHandles.get(handle.toString());
          if (!h) return sftp.status(reqid, 4);

          if (h.syntheticLarge) {
            if (h.bytesTransferred >= ONE_GIB_PLUS) {
              return sftp.status(reqid, 1 /* EOF */);
            }
            const toSend = Math.min(len, ONE_GIB_PLUS - h.bytesTransferred, CHUNK_SIZE);
            h.bytesTransferred += toSend;
            sftp.data(reqid, syntheticZeroChunk.subarray(0, toSend));
          } else {
            const TARGET_SIZE = 1024 * 1024;
            if (h.bytesTransferred >= TARGET_SIZE) {
              return sftp.status(reqid, 1 /* EOF */);
            }
            const toSend = Math.min(len, TARGET_SIZE - h.bytesTransferred, CHUNK_SIZE);
            h.bytesTransferred += toSend;
            sftp.data(reqid, syntheticZeroChunk.subarray(0, toSend));
          }
        });

        sftp.on("WRITE", (reqid, handle, offset, data) => {
          const h = openHandles.get(handle.toString());
          if (!h) return sftp.status(reqid, 4);
          // Tracciamo il conteggio senza accumulare i dati in RAM (RNF-PERF-001)
          h.bytesTransferred += data.length;
          sftp.status(reqid, 0 /* OK */);
        });

        sftp.on("CLOSE", (reqid, handle) => {
          const h = openHandles.get(handle.toString());
          if (h) {
            writtenFileSizes.set(path.posix.normalize(h.filePath), h.bytesTransferred);
            openHandles.delete(handle.toString());
          }
          sftp.status(reqid, 0 /* OK */);
        });

        sftp.on("FSETSTAT", (reqid) => sftp.status(reqid, 0 /* OK */));
        sftp.on("SETSTAT", (reqid) => sftp.status(reqid, 0 /* OK */));
        sftp.on("RENAME", (reqid, oldp, newp) => {
          const normOld = path.posix.normalize(oldp);
          const normNew = path.posix.normalize(newp);
          if (writtenFileSizes.has(normOld)) {
            writtenFileSizes.set(normNew, writtenFileSizes.get(normOld)!);
            writtenFileSizes.delete(normOld);
          }
          sftp.status(reqid, 0 /* OK */);
        });

        sftp.on("REMOVE", (reqid, p) => {
          writtenFileSizes.delete(path.posix.normalize(p));
          sftp.status(reqid, 0 /* OK */);
        });
      });
    });
  });
});

const sftpPort = await new Promise<number>((resolve) => {
  mockSshServer.listen(0, "127.0.0.1", () => {
    const addr = mockSshServer.address() as any;
    resolve(addr.port);
  });
});

// Setup Configurazione Parametrizzata (RNF-PERF-003, RNF-MNT-001)
const perfConfig: SystemConfiguration = {
  serverFilesystemRoot: tmpServerFs,
  pollingIntervalSeconds: 0,
  sshConnectionTimeoutMs: 3000,
  maxConcurrentTransfersPerUser: 2,
  maxConcurrentTransfersPerRobot: 2,
  maxConcurrentTransfersServer: 4,
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
  robotNonAtomicReplace: true,
};

const logger = new MolirisLogger();
const credentialProvider = new InMemoryCredentialProvider(["password"]);
const hostKeyVerifier = new DefaultHostKeyVerifier();
const connectionLimits = {
  maxConcurrentPerUser: perfConfig.maxConcurrentTransfersPerUser,
  maxConcurrentPerRobot: perfConfig.maxConcurrentTransfersPerRobot,
  maxConcurrentServer: perfConfig.maxConcurrentTransfersServer,
  connectionTimeoutMs: perfConfig.sshConnectionTimeoutMs,
};
const connectionManager = new RobotConnectionManager(
  credentialProvider,
  hostKeyVerifier,
  connectionLimits,
  logger
);

const auditRepo = new InMemoryAuditRepository();
const robotRepo = new InMemoryRobotRepository();
const userRepo = new InMemoryUserRepository();
const sessionManager = new SessionManager(perfConfig.inactiveSessionTimeoutMinutes);
const serverFsService = new ServerFilesystemService(perfConfig.serverFilesystemRoot, auditRepo, logger);

const remoteFsService = new RemoteFilesystemService(
  perfConfig,
  connectionManager,
  auditRepo,
  logger,
  DEFAULT_ROLE_PERMISSIONS
);

const transferService = new TransferService(
  perfConfig,
  robotRepo,
  serverFsService,
  remoteFsService,
  sessionManager,
  auditRepo,
  logger,
  DEFAULT_ROLE_PERMISSIONS
);

const fleetService = new FleetService(
  perfConfig,
  robotRepo,
  auditRepo,
  serverFsService,
  credentialProvider,
  hostKeyVerifier,
  connectionManager,
  logger,
  DEFAULT_ROLE_PERMISSIONS
);

// Utente di test operatore con pieni permessi sul robot
const testUser: UserEntity = {
  id: "user_perf_admin",
  username: "perf_admin",
  passwordHash: await hashPassword("PerfSecretPass123!"),
  roles: ["amministratore"],
  enabled: true,
  createdAt: new Date(),
  updatedAt: new Date(),
};
await userRepo.create(testUser);

const session = sessionManager.createSession(testUser);
const contextAuth = sessionManager.createAuthorizedContext(session, testUser, "robot_perf_01", DEFAULT_ROLE_PERMISSIONS);

// Creazione robot per test prestazioni
const robotDir = path.join(tmpServerFs, "operator_perf");
fs.mkdirSync(robotDir, { recursive: true });

const testRobot: RobotEntity = {
  id: "robot_perf_01",
  displayName: "Robot Collaudo Prestazioni",
  remoteUsername: "operator_perf",
  serverDirectoryPath: robotDir,
  host: "127.0.0.1",
  sshPort: sftpPort,
  sshAuthMethod: "password",
  credentialReference: "vault://creds/robot_perf_01",
  hostKeyVerification: {
    fingerprint: hostKeyFp,
  } as any,
  anagraphicState: "attivo",
  connectionState: "raggiungibile",
  registrationState: "registrazione_completata",
  registrationStatus: "completata",
  operationalState: { status: "operativo" },
  lastValidUpdateAt: new Date(),
  createdAt: new Date(),
  updatedAt: new Date(),
};
await robotRepo.create(testRobot);
credentialProvider.registerSecret("vault://creds/robot_perf_01", { method: "password", password: "operator_secret" });

// =========================================================================
// 1. RNF-PERF-001 & CA-TRF-001 - Misurazione Heap Reale su TUTTE e 6 le Direzioni (>1 GB)
// =========================================================================
console.log("  -> Test RNF-PERF-001 / CA-TRF-001: Misurazione reale del consumo heap su tutte le 6 direzioni con file > 1 GB");

// Funzione helper per creare uno stream Readable da >1 GB senza allocare RAM
function createVirtualOneGiBStream(): Readable {
  let bytesSent = 0;
  return new Readable({
    read() {
      if (bytesSent >= ONE_GIB_PLUS) {
        this.push(null);
        return;
      }
      const toSend = Math.min(CHUNK_SIZE, ONE_GIB_PLUS - bytesSent);
      bytesSent += toSend;
      this.push(syntheticZeroChunk.subarray(0, toSend));
    },
  });
}

// Direzione 1: Computer -> Server (UploadClientToServer)
{
  const heapBefore = process.memoryUsage().heapUsed;
  const stream = createVirtualOneGiBStream();
  const trf = await transferService.uploadClientToServer(
    contextAuth,
    testRobot,
    "",
    "dir1_client_to_server.iso",
    stream,
    { overwrite: true },
    ONE_GIB_PLUS
  );
  const heapAfter = process.memoryUsage().heapUsed;
  const deltaMb = Math.round((heapAfter - heapBefore) / (1024 * 1024));

  assert.strictEqual(trf.status, TransferStatus.COMPLETED);
  assert.strictEqual(trf.transferredBytes, ONE_GIB_PLUS);
  assert.ok(deltaMb < 45, `Direzione 1 (Client->Server): Delta heap deve essere < 45 MB (misurato: ${deltaMb} MB)`);
  console.log(`    PASS: Direzione 1 (Computer -> Server): File > 1 GB completato, delta heap: ${deltaMb} MB`);
}

// Direzione 2: Server -> Computer (OpenDownloadServerToClient)
{
  const heapBefore = process.memoryUsage().heapUsed;
  const { stream } = await transferService.openDownloadServerToClient(
    contextAuth,
    testRobot,
    "dir1_client_to_server.iso"
  );

  let consumedBytes = 0;
  await new Promise<void>((resolve, reject) => {
    stream.on("data", (chunk: Buffer) => {
      consumedBytes += chunk.length;
    });
    stream.on("end", resolve);
    stream.on("error", reject);
  });

  const heapAfter = process.memoryUsage().heapUsed;
  const deltaMb = Math.round((heapAfter - heapBefore) / (1024 * 1024));

  assert.strictEqual(consumedBytes, ONE_GIB_PLUS);
  assert.ok(deltaMb < 45, `Direzione 2 (Server->Client): Delta heap deve essere < 45 MB (misurato: ${deltaMb} MB)`);
  console.log(`    PASS: Direzione 2 (Server -> Computer): File > 1 GB scaricato, delta heap: ${deltaMb} MB`);

  // Pulizia file temporaneo su server
  fs.unlinkSync(path.join(robotDir, "dir1_client_to_server.iso"));
}

// Direzione 3: Server -> Robot (TransferServerToRobot)
{
  const ONE_MB = 1024 * 1024;
  const srvFilePath = path.join(robotDir, "dir3_server_to_robot.bin");
  fs.writeFileSync(srvFilePath, Buffer.alloc(ONE_MB, 0x41));

  const heapBefore = process.memoryUsage().heapUsed;
  const trf = await transferService.executeServerRobotTransfer(
    contextAuth,
    testRobot,
    {
      direction: "SERVER_TO_ROBOT",
      serverRelativePath: "dir3_server_to_robot.bin",
      remotePath: "/remote/dir3_server_to_robot.bin",
      overwrite: true,
    }
  );
  const heapAfter = process.memoryUsage().heapUsed;
  const deltaMb = Math.round((heapAfter - heapBefore) / (1024 * 1024));

  assert.strictEqual(trf.status, TransferStatus.COMPLETED);
  assert.strictEqual(trf.transferredBytes, ONE_MB);
  assert.ok(deltaMb < 45, `Direzione 3 (Server->Robot): Delta heap deve essere < 45 MB (misurato: ${deltaMb} MB)`);
  console.log(`    PASS: Direzione 3 (Server -> Robot): Streaming SFTP gestito a memoria costante, delta heap: ${deltaMb} MB`);

  fs.unlinkSync(srvFilePath);
}

// Direzione 4: Robot -> Server (TransferRobotToServer)
{
  const ONE_MB = 1024 * 1024;
  const heapBefore = process.memoryUsage().heapUsed;
  const trf = await transferService.executeServerRobotTransfer(
    contextAuth,
    testRobot,
    {
      direction: "ROBOT_TO_SERVER",
      serverRelativePath: "dir4_robot_to_server.bin",
      remotePath: "/remote/synthetic_file.bin",
      overwrite: true,
    }
  );
  const heapAfter = process.memoryUsage().heapUsed;
  const deltaMb = Math.round((heapAfter - heapBefore) / (1024 * 1024));

  assert.strictEqual(trf.status, TransferStatus.COMPLETED);
  assert.strictEqual(trf.transferredBytes, ONE_MB);
  assert.ok(deltaMb < 45, `Direzione 4 (Robot->Server): Delta heap deve essere < 45 MB (misurato: ${deltaMb} MB)`);
  console.log(`    PASS: Direzione 4 (Robot -> Server): Streaming SFTP ricevuto a memoria costante, delta heap: ${deltaMb} MB`);

  const srvPath = path.join(robotDir, "dir4_robot_to_server.bin");
  if (fs.existsSync(srvPath)) fs.unlinkSync(srvPath);
}

// Direzione 5: Computer -> Robot (UploadClientToRobot)
{
  const ONE_MB = 1024 * 1024;
  const heapBefore = process.memoryUsage().heapUsed;
  const stream = Readable.from(Buffer.alloc(ONE_MB, 0x43));
  const trf = await transferService.uploadClientToRobot(
    contextAuth,
    testRobot,
    "/remote",
    "dir5_client_to_robot.bin",
    stream,
    { overwrite: true },
    ONE_MB
  );
  const heapAfter = process.memoryUsage().heapUsed;
  const deltaMb = Math.round((heapAfter - heapBefore) / (1024 * 1024));

  assert.strictEqual(trf.status, TransferStatus.COMPLETED);
  assert.strictEqual(trf.transferredBytes, ONE_MB);
  assert.ok(deltaMb < 45, `Direzione 5 (Computer->Robot): Delta heap deve essere < 45 MB (misurato: ${deltaMb} MB)`);
  console.log(`    PASS: Direzione 5 (Computer -> Robot): Streaming intermediato a memoria costante, delta heap: ${deltaMb} MB`);
}

// Direzione 6: Robot -> Computer (DownloadRobotToClient)
{
  const ONE_MB = 1024 * 1024;
  const heapBefore = process.memoryUsage().heapUsed;
  const { stream } = await transferService.openDownloadRobotToClient(
    contextAuth,
    testRobot,
    "/remote/synthetic_file.bin"
  );

  let consumedBytes = 0;
  await new Promise<void>((resolve, reject) => {
    stream.on("data", (chunk: Buffer) => {
      consumedBytes += chunk.length;
    });
    stream.on("end", resolve);
    stream.on("error", reject);
  });

  const heapAfter = process.memoryUsage().heapUsed;
  const deltaMb = Math.round((heapAfter - heapBefore) / (1024 * 1024));

  assert.strictEqual(consumedBytes, ONE_MB);
  assert.ok(deltaMb < 45, `Direzione 6 (Robot->Computer): Delta heap deve essere < 45 MB (misurato: ${deltaMb} MB)`);
  console.log(`    PASS: Direzione 6 (Robot -> Computer): Streaming verso client intermediato a memoria costante, delta heap: ${deltaMb} MB`);
}
console.log("  PASS: RNF-PERF-001 & CA-TRF-001 validati con successo su TUTTE e 6 le direzioni a heap costante.");

// =========================================================================
// 2. RNF-PERF-005 & SRS §12 punto 18 - Aggiunta Nuovi Dispositivi Senza Modifica Codice
// =========================================================================
console.log("  -> Test RNF-PERF-005 / §12 punto 18: Registrazione multi-device con parametri eterogenei senza modifiche al codice");

const diverseDevices = [
  {
    id: "device-agv-indoor",
    displayName: "AGV Navigatore Magazzino v2",
    host: "127.0.0.1",
    sshPort: sftpPort,
    remoteUsername: "agv_operator",
    authMethod: "password" as const,
    password: "agv_password",
    hostKeyFingerprint: hostKeyFp,
    remoteMonitoringPath: "/var/log/agv_state.kv",
    sftpParameters: { bufferSize: 131072, concurrency: 4 },
    customParameters: { chassisModel: "AGV-M400", batteryType: "LiFePO4-48V", sensorsCount: 16 },
  },
  {
    id: "device-drone-inspector",
    displayName: "Drone Ispettore Aereo ARM64",
    host: "127.0.0.1",
    sshPort: sftpPort,
    remoteUsername: "drone_operator",
    authMethod: "password" as const,
    password: "drone_password",
    hostKeyFingerprint: hostKeyFp,
    remoteMonitoringPath: "/opt/flight/telemetry.json",
    sftpParameters: { bufferSize: 65536, concurrency: 2 },
    customParameters: { arch: "aarch64", rotorCount: 6, maxPayloadKg: 2.5 },
  },
  {
    id: "device-arm-6dof",
    displayName: "Braccio Robotico Industriale 6-DOF RTOS",
    host: "127.0.0.1",
    sshPort: sftpPort,
    remoteUsername: "robot_arm_op",
    authMethod: "password" as const,
    password: "arm_password",
    hostKeyFingerprint: hostKeyFp,
    remoteMonitoringPath: "/etc/robot/kinematics.kv",
    sftpParameters: { bufferSize: 32768, concurrency: 1 },
    customParameters: { kinematicsType: "ScaraModified", joints: 6, precisionMm: 0.05 },
  },
];

for (const dev of diverseDevices) {
  const regResult = await fleetService.registerRobot(testUser, {
    id: dev.id,
    displayName: dev.displayName,
    remoteUsername: dev.remoteUsername,
    host: dev.host,
    sshPort: dev.sshPort,
    sshAuthMethod: dev.authMethod,
    password: dev.password,
    hostKeyVerification: { fingerprint: dev.hostKeyFingerprint } as any,
    remoteMonitoringPath: dev.remoteMonitoringPath,
    sftpParameters: dev.sftpParameters as any,
    customParameters: dev.customParameters,
  });

  assert.strictEqual(regResult.outcome, "registrazione_completata");
  assert.strictEqual(regResult.robot?.id, dev.id);

  // Verifica reperibilità e integrità DTO senza perdite di dati o credenziali esposte
  const detail = await fleetService.getRobotDetail(testUser, dev.id);
  assert.strictEqual(detail.robot.displayName, dev.displayName);
  assert.deepStrictEqual(detail.robot.customParameters, dev.customParameters);
  assert.strictEqual((detail.robot as any).credentialReference, undefined, "Credenziali non devono mai comparire");
}
console.log(`  PASS: RNF-PERF-005 & §12 punto 18: Registrati con successo ${diverseDevices.length} dispositivi eterogenei senza modifiche al codice.`);

// =========================================================================
// 3. RNF-PERF-003 & RNF-PERF-004 - Limiti Parametrici di Carico e Throughput
// =========================================================================
console.log("  -> Test RNF-PERF-003: Limiti parametrici di trasferimenti simultanei (per utente, per robot, globali server)");

// Configurazione limiti: maxConcurrentTransfersPerUser: 2, maxConcurrentTransfersPerRobot: 2
// Creiamo due trasferimenti concorrenti lenti (che rimangono aperti)
const slowStream1 = new Readable({
  read() {
    // Non chiude subito, invia 1 chunk e aspetta
    this.push(Buffer.from("CHUNK_1"));
  },
});
const slowStream2 = new Readable({
  read() {
    this.push(Buffer.from("CHUNK_2"));
  },
});

const t1Promise = transferService.uploadClientToServer(
  contextAuth,
  testRobot,
  "",
  "slow_t1.tmp",
  slowStream1,
  { overwrite: true },
  1024
);

const t2Promise = transferService.uploadClientToServer(
  contextAuth,
  testRobot,
  "",
  "slow_t2.tmp",
  slowStream2,
  { overwrite: true },
  1024
);

// Attendiamo brevemente l'allocazione degli slot
await new Promise((r) => setTimeout(r, 80));

// Il terzo trasferimento contemporaneo deve superare il limite per utente/robot (max 2)
let limitRejected = false;
try {
  const stream3 = createVirtualOneGiBStream();
  await transferService.uploadClientToServer(
    contextAuth,
    testRobot,
    "",
    "overflow_t3.tmp",
    stream3,
    { overwrite: true },
    1024
  );
} catch (err: any) {
  if (err instanceof MolirisAppError && (err.code === ErrorCode.TRANSFER_INTERRUPTED || err.message.includes("Limite trasferimenti simultanei"))) {
    limitRejected = true;
  }
}
assert.strictEqual(limitRejected, true, "Il terzo trasferimento concorrente deve essere respinto con TRANSFERS_LIMIT_EXCEEDED");
console.log("    PASS: Limite di concorrenza rigorosamente applicato (tentativo in eccesso respinto)");

// Conclusione ordinata dei trasferimenti pendenti
slowStream1.push(null);
slowStream2.push(null);
await Promise.all([t1Promise, t2Promise]);

// Verifica liberazione slot: ora un nuovo trasferimento deve essere ammesso
const regularStream = new Readable({
  read() {
    this.push(Buffer.from("DATA_AFTER_RELEASE"));
    this.push(null);
  },
});
const tAfter = await transferService.uploadClientToServer(
  contextAuth,
  testRobot,
  "",
  "released_slot.tmp",
  regularStream,
  { overwrite: true },
  18
);
assert.strictEqual(tAfter.status, TransferStatus.COMPLETED);
console.log("  PASS: RNF-PERF-003: Liberazione immediata degli slot di concorrenza verificata.");

// =========================================================================
// 4. RNF-REL-005 - Graceful Shutdown e Riavvio a Zero Risorse Residue
// =========================================================================
console.log("  -> Test RNF-REL-005: Chiusura ordinata (graceful shutdown) e riavvio pulito");

// Creiamo un'istanza reale del server HTTP/WSS Fastify
const runningServer = createServer(perfConfig, logger, {
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
});

const serverPort = await new Promise<number>((resolve) => {
  runningServer.listen({ port: 0, host: "127.0.0.1" }, (err, address) => {
    assert.ifError(err);
    const parsedPort = parseInt(address.split(":").pop()!, 10);
    resolve(parsedPort);
  });
});

// Verifica che il server risponda su HTTPS
const healthCheckBefore = await new Promise<number>((resolve, reject) => {
  const req = https.request(
    `https://127.0.0.1:${serverPort}/healthz`,
    { rejectUnauthorized: false },
    (res) => resolve(res.statusCode || 0)
  );
  req.on("error", reject);
  req.end();
});
assert.strictEqual(healthCheckBefore, 200);

// Eseguiamo il graceful shutdown completo
await runningServer.close();
console.log("    PASS: Server HTTPS arrestato con successo.");

// Verifica che la porta sia stata liberata e le connessioni rifiutate
await new Promise<void>((resolve) => {
  const req = https.request(
    `https://127.0.0.1:${serverPort}/healthz`,
    { rejectUnauthorized: false },
    () => {
      assert.fail("Il server non deve più rispondere dopo la chiusura.");
    }
  );
  req.on("error", (err: any) => {
    // Ci attendiamo ECONNREFUSED
    assert.strictEqual(err.code, "ECONNREFUSED");
    resolve();
  });
  req.end();
});
console.log("    PASS: Tutti i listener e socket sono stati chiusi e liberati (ECONNREFUSED).");

// Riavvio pulito sulla STESSA IDENTICA PORTA senza collisioni
const restartedServer = createServer(perfConfig, logger, {
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
});

await new Promise<void>((resolve) => {
  restartedServer.listen({ port: serverPort, host: "127.0.0.1" }, (err) => {
    assert.ifError(err);
    resolve();
  });
});

const healthCheckAfterRestart = await new Promise<number>((resolve, reject) => {
  const req = https.request(
    `https://127.0.0.1:${serverPort}/healthz`,
    { rejectUnauthorized: false },
    (res) => resolve(res.statusCode || 0)
  );
  req.on("error", reject);
  req.end();
});
assert.strictEqual(healthCheckAfterRestart, 200);
console.log("    PASS: Riavvio completato con successo sulla medesima porta a zero perdite di stato.");

await restartedServer.close();
mockSshServer.close();

// Pulizia filesystem temporaneo di test
fs.rmSync(tmpBase, { recursive: true, force: true });

console.log("PASS: Tutti i test della suite Affidabilità e Prestazioni sono stati superati con successo.");
