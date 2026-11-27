// Test E2E completo (Backend + Persistenza + Restart + Chrome Headless UI) per Gestione File / Trasferimenti.
// Copre tutti i 14 scenari obbligatori + regressione Batch ID 540f0b21 / 203e6760:
//  1. Upload di un file piccolo (incluso bulk staging <200ms -> 100%, mai 0%)
//  2. Upload di un file grande (multi-MB streaming)
//  3. Download di un file piccolo
//  4. Download di un file grande
//  5. Completamento riuscito (100%, bytes, durata, velocità media reale)
//  6. Fallimento durante upload (singolo + bulk target fallito -> registrato con batchId, transferId, errore)
//  7. Fallimento durante download (errore stream / interruzione)
//  8. Trasferimento interrotto / annullato + recovery al riavvio
//  9. Pausa e ripresa (tempo di pausa escluso dal calcolo velocità media)
// 10. Refresh pagina durante trasferimento attivo (Chrome reale)
// 11. Consultazione storico dopo completamento (anche dopo rimozione dalla lista recenti)
// 12. Visualizzazione dei trasferimenti falliti nella sezione LOG (API + Chrome reale)
// 13. Mantenimento velocità medie (↑ / ↓) dopo refresh pagina e dopo riavvio backend
// 14. Avanzamento al 100% per tutti i trasferimenti completati (API + Chrome reale)
// + Regressione Batch 540f0b21 / 203e6760: auto-creazione cartella remota mancante su robot secondario

import assert from "node:assert";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { Readable } from "node:stream";
import { execSync, spawn } from "node:child_process";
import ssh2 from "ssh2";
import { type SystemConfiguration } from "../../config/configuration.ts";
import { MolirisLogger } from "../../logging/logger.ts";
import { InMemoryCredentialProvider } from "../../backend/connection/credential-provider.ts";
import { DefaultHostKeyVerifier, computeHostKeyFingerprint } from "../../backend/connection/host-key-verifier.ts";
import { RobotConnectionManager } from "../../backend/connection/robot-connection-manager.ts";
import { InMemoryRobotRepository } from "../../storage/robot-repository.ts";
import { InMemoryAuditRepository } from "../../storage/audit-repository.ts";
import { InMemoryTransferRepository } from "../../storage/transfer-repository.ts";
import { InMemoryUserRepository } from "../../backend/auth/user-repository.ts";
import { SessionManager } from "../../backend/auth/session-manager.ts";
import { ServerFilesystemService } from "../../storage/server-fs.ts";
import { RemoteFilesystemService } from "../../backend/remote-fs/remote-fs-service.ts";
import { TransferService } from "../../backend/transfer/transfer-service.ts";
import { TransferStatus } from "../../backend/transfer/transfer-models.ts";
import { type RobotEntity } from "../../storage/robot-models.ts";
import { hashPassword } from "../../backend/auth/user-models.ts";
import { createServer } from "../../backend/server.ts";
import { PhysicalFileLogger } from "../../backend/logging/physical-file-logger.ts";
import { loadConfig } from "../../src/config/index.ts";

console.log("--> Avvio suite E2E Gestione File / Trasferimenti (14 scenari + Chrome reale)...");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "moliris-trf-e2e-"));
const serverFsRoot = path.join(tmpDir, "server-fs");
const generalFsRoot = path.join(serverFsRoot, "general");
const logsDir = path.join(tmpDir, "logs");
const chromeUserDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "moliris-trf-chrome-"));
const certPath = path.join(tmpDir, "cert.pem");
const keyPath = path.join(tmpDir, "key.pem");
fs.mkdirSync(generalFsRoot, { recursive: true });
fs.mkdirSync(logsDir, { recursive: true });
process.env.MOLIRIS_GENERAL_FS_ROOT = generalFsRoot;
process.env.MOLIRIS_LOGS_DIR = logsDir;

execSync(
  `openssl req -x509 -newkey rsa:2048 -keyout "${keyPath}" -out "${certPath}" -days 1 -nodes -subj "/CN=127.0.0.1"`,
  { stdio: "pipe" }
);

// Helper per server SFTP mock realistico con supporto MKDIR, STAT, LSTAT, OPEN, READ, WRITE, RENAME, UNLINK
function createMockSftpServer(initialEntries: Record<string, Buffer>, options?: { readErrorPath?: string; readDelayMs?: number; homeDir?: string }) {
  const serverHostKey = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "pkcs1", format: "pem" },
  });
  const parsedKey = (ssh2 as any).utils.parseKey(serverHostKey.privateKey);
  const fingerprint = computeHostKeyFingerprint(parsedKey.getPublicSSH());
  const files: Record<string, Buffer> = { ...initialEntries };
  const homeDir = options?.homeDir || "/home/robot";
  let nextHandleId = 1;
  const openHandles = new Map<string, { path: string; isDir: boolean; readSent?: boolean }>();

  const server = new ssh2.Server({ hostKeys: [serverHostKey.privateKey] }, (client) => {
    client.on("authentication", (ctx) => ctx.accept());
    client.on("ready", () => {
      client.on("session", (accept) => {
        const session = accept();
        session.on("sftp", (acceptSftp) => {
          const sftp = acceptSftp();
          sftp.on("REALPATH", (reqid: number, p: string) => {
            const resolved = !p || p === "." ? homeDir : path.posix.normalize(p);
            sftp.name(reqid, [{ filename: resolved }] as any);
          });
          const handleStat = (reqid: number, p: string) => {
            const norm = path.posix.normalize(p);
            if (files[norm] !== undefined) {
              const isDir = files[norm].toString() === "DIR";
              return sftp.attrs(reqid, {
                mode: isDir ? 0o040755 : 0o100644,
                size: isDir ? 4096 : files[norm].length,
                mtime: Math.floor(Date.now() / 1000),
                atime: Math.floor(Date.now() / 1000),
              } as any);
            }
            return sftp.status(reqid, 2);
          };
          sftp.on("STAT", handleStat);
          sftp.on("LSTAT", handleStat);
          sftp.on("MKDIR", (reqid: number, p: string) => {
            const norm = path.posix.normalize(p);
            const parent = path.posix.dirname(norm);
            if (parent !== norm && files[parent]?.toString() !== "DIR") {
              return sftp.status(reqid, 2);
            }
            if (norm.startsWith("/readonly")) {
              return sftp.status(reqid, 3); // Permission denied
            }
            files[norm] = Buffer.from("DIR");
            return sftp.status(reqid, 0);
          });
          sftp.on("OPEN", (reqid: number, filename: string) => {
            const norm = path.posix.normalize(filename);
            const parent = path.posix.dirname(norm);
            if (files[parent]?.toString() !== "DIR") {
              return sftp.status(reqid, 2);
            }
            const handle = Buffer.from(`f_${nextHandleId++}`);
            openHandles.set(handle.toString(), { path: norm, isDir: false });
            if (!files[norm]) files[norm] = Buffer.alloc(0);
            sftp.handle(reqid, handle);
          });
          sftp.on("READ", (reqid: number, handle: Buffer, offset: number, length: number) => {
            const h = openHandles.get(handle.toString());
            if (!h || !files[h.path]) return sftp.status(reqid, 4);
            if (options?.readErrorPath && h.path === options.readErrorPath && offset > 0) {
              return sftp.status(reqid, 4); // Simula errore lettura a metà download
            }
            const buf = files[h.path];
            if (offset >= buf.length) return sftp.status(reqid, 1);
            const respond = () => sftp.data(reqid, buf.subarray(offset, offset + length));
            if (options?.readDelayMs) setTimeout(respond, options.readDelayMs);
            else respond();
          });
          sftp.on("WRITE", (reqid: number, handle: Buffer, offset: number, data: Buffer) => {
            const h = openHandles.get(handle.toString());
            if (!h) return sftp.status(reqid, 4);
            const prev = files[h.path] || Buffer.alloc(0);
            const needed = offset + data.length;
            const next = needed > prev.length ? Buffer.concat([prev, Buffer.alloc(needed - prev.length)]) : Buffer.from(prev);
            data.copy(next, offset);
            files[h.path] = next;
            sftp.status(reqid, 0);
          });
          sftp.on("RENAME", (reqid: number, oldPath: string, newPath: string) => {
            const o = path.posix.normalize(oldPath);
            const n = path.posix.normalize(newPath);
            if (files[o] === undefined) return sftp.status(reqid, 2);
            files[n] = files[o];
            delete files[o];
            sftp.status(reqid, 0);
          });
          sftp.on("REMOVE", (reqid: number, p: string) => {
            const norm = path.posix.normalize(p);
            delete files[norm];
            sftp.status(reqid, 0);
          });
          sftp.on("UNLINK", (reqid: number, p: string) => {
            const norm = path.posix.normalize(p);
            delete files[norm];
            sftp.status(reqid, 0);
          });
          sftp.on("CLOSE", (reqid: number, handle: Buffer) => {
            openHandles.delete(handle.toString());
            sftp.status(reqid, 0);
          });
        });
      });
    });
  });

  return { server, fingerprint, files };
}

// Robot 1: ha già /home/robot/TEST + un file grande e un file difettoso per test download failure
const robot1LargeDownloadBuf = crypto.randomBytes(2 * 1024 * 1024); // 2 MB
const robot1BrokenDownloadBuf = crypto.randomBytes(256 * 1024); // 256 KB (errore dopo il primo chunk)
const sftp1 = createMockSftpServer(
  {
    "/": Buffer.from("DIR"),
    "/home": Buffer.from("DIR"),
    "/home/robot": Buffer.from("DIR"),
    "/home/robot/TEST": Buffer.from("DIR"),
    "/home/robot/large_remote.bin": robot1LargeDownloadBuf,
    "/home/robot/broken_remote.bin": robot1BrokenDownloadBuf,
  },
  { readErrorPath: "/home/robot/broken_remote.bin" }
);

// Robot 2: utente SSH 'robot01' con home /home/robot01 (NON ha /home/robot/TEST né /home/robot01/TEST!)
const sftp2 = createMockSftpServer(
  {
    "/": Buffer.from("DIR"),
    "/home": Buffer.from("DIR"),
    "/home/robot01": Buffer.from("DIR"),
    "/readonly": Buffer.from("DIR"),
  },
  { homeDir: "/home/robot01" }
);

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address() as net.AddressInfo;
      srv.close(() => resolve(addr.port));
    });
    srv.on("error", reject);
  });
}

async function runTests() {
  const sftpPort1 = await getFreePort();
  const sftpPort2 = await getFreePort();
  const appPort = await getFreePort();
  const cdpPort = await getFreePort();

  await new Promise<void>((res) => sftp1.server.listen(sftpPort1, "127.0.0.1", res));
  await new Promise<void>((res) => sftp2.server.listen(sftpPort2, "127.0.0.1", res));

  const logger = new MolirisLogger();
  const auditRepo = new InMemoryAuditRepository();
  const transferRepo = new InMemoryTransferRepository();
  const userRepo = new InMemoryUserRepository();
  const robotRepo = new InMemoryRobotRepository();
  const credProvider = new InMemoryCredentialProvider(["password"]);
  const hostKeyVerifier = new DefaultHostKeyVerifier();
  const sessionManager = new SessionManager(30, 480);
  const physicalFileLogger = new PhysicalFileLogger(logsDir);

  const adminUser = {
    id: "admin-1",
    username: "admin",
    passwordHash: await hashPassword("AdminPass123!"),
    roles: ["admin"],
    enabled: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  await userRepo.create(adminUser);

  const r1Dir = path.join(serverFsRoot, "robot_robot-vm-01");
  const r2Dir = path.join(serverFsRoot, "robot_robot-vm-02");
  const r3Dir = path.join(serverFsRoot, "robot_robot-vm-03");
  for (const d of [r1Dir, r2Dir, r3Dir]) {
    fs.mkdirSync(path.join(d, "upload"), { recursive: true });
    fs.mkdirSync(path.join(d, "download"), { recursive: true });
  }

  // File sorgenti sul server per test download piccolo, download grande e pausa/ripresa
  const smallServerBuf = crypto.randomBytes(12 * 1024); // 12 KB
  const largeServerBuf = crypto.randomBytes(4 * 1024 * 1024); // 4 MB
  fs.writeFileSync(path.join(r1Dir, "download", "small_dl.txt"), smallServerBuf);
  fs.writeFileSync(path.join(r1Dir, "download", "large_dl.bin"), largeServerBuf);

  const robot1: RobotEntity = {
    id: "robot-vm-01",
    displayName: "Robot VM 01",
    remoteUsername: "robot",
    host: "127.0.0.1",
    sshPort: sftpPort1,
    sshAuthMethod: "password",
    credentialReference: "vault://creds/robot-vm-01",
    hostKeyVerification: { fingerprint: sftp1.fingerprint.sha256Hex, strictHostKeyChecking: true },
    serverDirectoryPath: r1Dir,
    anagraphicState: "attivo",
    connectionState: "raggiungibile",
    operationalState: { status: "ok" },
    lastValidUpdateAt: new Date(),
    registrationState: "registrazione_completata",
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const robot2: RobotEntity = {
    ...robot1,
    id: "robot-vm-02",
    displayName: "Robot VM 02",
    remoteUsername: "robot01",
    sshPort: sftpPort2,
    credentialReference: "vault://creds/robot-vm-02",
    hostKeyVerification: { fingerprint: sftp2.fingerprint.sha256Hex, strictHostKeyChecking: true },
    serverDirectoryPath: r2Dir,
  };
  const robotDisabled: RobotEntity = {
    ...robot2,
    id: "robot-disabled",
    displayName: "Robot Disabilitato",
    remoteUsername: "robot_disabled",
    credentialReference: "vault://creds/robot-disabled",
    serverDirectoryPath: r3Dir,
    anagraphicState: "disabilitato",
  };

  await robotRepo.create(robot1);
  await robotRepo.create(robot2);
  await robotRepo.create(robotDisabled);
  credProvider.registerSecret("vault://creds/robot-vm-01", { method: "password", password: "pass1" });
  credProvider.registerSecret("vault://creds/robot-vm-02", { method: "password", password: "pass2" });
  credProvider.registerSecret("vault://creds/robot-disabled", { method: "password", password: "pass3" });

  const config: SystemConfiguration = {
    credentialProviderType: "in-memory",
    serverFilesystemRoot: serverFsRoot,
    pollingIntervalSeconds: 60,
    sshConnectionTimeoutMs: 5000,
    maxConcurrentTransfersPerUser: 10,
    maxConcurrentTransfersPerRobot: 10,
    maxConcurrentTransfersServer: 20,
    tempFileRetentionMinutes: 60,
    stateFilePaths: ["/etc/moliris/state.json"],
    inactiveSessionTimeoutMinutes: 30,
    sessionAbsoluteMaxMinutes: 480,
    tlsCertPath: certPath,
    tlsKeyPath: keyPath,
    registrationMode: "rigorosa",
    auditLogRetentionDays: 30,
    defaultSshPort: sftpPort1,
    allowedSshAuthMethods: ["password"],
    allowedDestinations: ["127.0.0.1"],
    maxConcurrentRegistrationVerifications: 4,
    defaultOperatorAllowedPaths: ["/upload", "/download"],
    transferChunkSizeBytes: 64 * 1024,
    transferIdleTimeoutMs: 60_000,
    maxFileSizeBytes: 100 * 1024 * 1024,
    transferOverwritePolicy: "sovrascrivi",
    transferVerifyMode: "stream",
    transferConcurrencyQueuePolicy: "coda",
    transferResumeEnabled: true,
    maxBulkUploadFiles: 20,
    robotNonAtomicReplace: true,
  };

  const serverFsService = new ServerFilesystemService(serverFsRoot, auditRepo, logger, ["/upload", "/download"]);
  const connectionManager = new RobotConnectionManager(
    credProvider,
    hostKeyVerifier,
    {
      maxConcurrentPerUser: 10,
      maxConcurrentPerRobot: 10,
      maxConcurrentServer: 20,
      connectionTimeoutMs: 5000,
    },
    logger,
    auditRepo
  );
  const remoteFsService = new RemoteFilesystemService(config, connectionManager, auditRepo, logger);
  const transferService = new TransferService(
    config,
    robotRepo,
    serverFsService,
    remoteFsService,
    sessionManager,
    auditRepo,
    logger,
    undefined,
    undefined,
    connectionManager
  );

  const appConfig = loadConfig({
    overrides: {
      futureExtensions: { maxSessionsPerAccount: 5, maxFleetRobots: 100, customSettings: {} },
    },
  });
  const app = createServer(config, logger, {
    sessionManager,
    userRepository: userRepo,
    auditRepository: auditRepo,
    robotRepository: robotRepo,
    serverFsService,
    credentialProvider: credProvider,
    hostKeyVerifier,
    connectionManager,
    remoteFsService,
    transferService,
    transferRepository: transferRepo,
    physicalFileLogger,
    appConfig,
  });

  await app.listen({ host: "127.0.0.1", port: appPort });
  const baseUrl = `https://127.0.0.1:${appPort}`;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

  let chromeProc: ReturnType<typeof spawn> | null = null;
  try {
    // Login API per ottenere cookie di sessione
    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "AdminPass123!" }),
    });
    assert.strictEqual(loginRes.status, 200, "Login admin fallito");
    const setCookies = loginRes.headers.getSetCookie?.() || [loginRes.headers.get("set-cookie") || ""];
    const cookieHeader = setCookies.map((c) => c.split(";")[0]).filter(Boolean).join("; ");
    const authHeaders = {
      Cookie: cookieHeader,
      Origin: baseUrl,
    };

    // =========================================================================
    // SCENARIO 1 & 5 & 14: Upload file piccolo (<200ms) -> 100% + velocità media reale
    // =========================================================================
    console.log("  [1/14] Upload file piccolo (CLIENT_TO_SERVER)...");
    const smallUpBuf = crypto.randomBytes(150 * 1024); // 150 KB (come nello screenshot!)
    const smallUpRes = await fetch(
      `${baseUrl}/api/robots/${robot1.id}/transfers/client-server/upload?subPath=upload&filename=small_up.png&overwrite=true`,
      {
        method: "POST",
        headers: {
          ...authHeaders,
          "Content-Type": "application/octet-stream",
          "Content-Length": String(smallUpBuf.length),
        },
        body: smallUpBuf,
      }
    );
    assert.strictEqual(smallUpRes.status, 200, "Upload file piccolo fallito");
    const smallUpDto = (await smallUpRes.json()) as any;
    assert.strictEqual(smallUpDto.status, "COMPLETED");
    assert.strictEqual(smallUpDto.transferredBytes, smallUpBuf.length);
    assert.strictEqual(smallUpDto.totalBytes, smallUpBuf.length);
    assert.strictEqual(smallUpDto.percent, 100, "Upload piccolo completato deve essere 100%");
    assert.ok(
      typeof smallUpDto.averageSpeedBytesPerSec === "number" && smallUpDto.averageSpeedBytesPerSec > 0,
      `Attesa averageSpeedBytesPerSec > 0, ottenuto: ${smallUpDto.averageSpeedBytesPerSec}`
    );
    assert.ok(typeof smallUpDto.durationMs === "number" && smallUpDto.durationMs > 0, "durationMs deve essere > 0");

    // =========================================================================
    // SCENARIO 2: Upload file grande (3 MB streaming) -> 100% + velocità media reale
    // =========================================================================
    console.log("  [2/14] Upload file grande (3 MB CLIENT_TO_SERVER)...");
    const largeUpBuf = crypto.randomBytes(3 * 1024 * 1024);
    const largeUpRes = await fetch(
      `${baseUrl}/api/robots/${robot1.id}/transfers/client-server/upload?subPath=upload&filename=large_up.bin&overwrite=true`,
      {
        method: "POST",
        headers: {
          ...authHeaders,
          "Content-Type": "application/octet-stream",
          "Content-Length": String(largeUpBuf.length),
        },
        body: largeUpBuf,
      }
    );
    assert.strictEqual(largeUpRes.status, 200);
    const largeUpDto = (await largeUpRes.json()) as any;
    assert.strictEqual(largeUpDto.status, "COMPLETED");
    assert.strictEqual(largeUpDto.transferredBytes, largeUpBuf.length);
    assert.strictEqual(largeUpDto.percent, 100);
    assert.ok(largeUpDto.averageSpeedBytesPerSec > 0, "Upload grande deve avere averageSpeedBytesPerSec > 0");

    // =========================================================================
    // SCENARIO 3: Download file piccolo (SERVER_TO_CLIENT)
    // =========================================================================
    console.log("  [3/14] Download file piccolo (SERVER_TO_CLIENT)...");
    const smallDlRes = await fetch(
      `${baseUrl}/api/robots/${robot1.id}/transfers/client-server/download?path=download/small_dl.txt`,
      { headers: authHeaders }
    );
    assert.strictEqual(smallDlRes.status, 200);
    const smallDlDownloaded = Buffer.from(await smallDlRes.arrayBuffer());
    assert.strictEqual(smallDlDownloaded.length, smallServerBuf.length);

    // =========================================================================
    // SCENARIO 4: Download file grande (4 MB SERVER_TO_CLIENT + 2 MB ROBOT_TO_CLIENT)
    // =========================================================================
    console.log("  [4/14] Download file grande (4 MB Server + 2 MB Robot)...");
    const largeDlRes = await fetch(
      `${baseUrl}/api/robots/${robot1.id}/transfers/client-server/download?path=download/large_dl.bin`,
      { headers: authHeaders }
    );
    assert.strictEqual(largeDlRes.status, 200);
    const largeDlDownloaded = Buffer.from(await largeDlRes.arrayBuffer());
    assert.strictEqual(largeDlDownloaded.length, largeServerBuf.length);

    const robotLargeDlRes = await fetch(
      `${baseUrl}/api/robots/${robot1.id}/transfers/client-robot/download?path=/home/robot/large_remote.bin`,
      { headers: authHeaders }
    );
    assert.strictEqual(robotLargeDlRes.status, 200);
    const robotLargeDlBuf = Buffer.from(await robotLargeDlRes.arrayBuffer());
    assert.strictEqual(robotLargeDlBuf.length, robot1LargeDownloadBuf.length);

    // Attendi un breve tick per il flush asincrono di finishSuccess sui download
    await new Promise((r) => setTimeout(r, 150));

    // Verifica Scenario 5 & 14 sui download completati
    const recentAfterDl = (await (await fetch(`${baseUrl}/api/transfers/recent`, { headers: authHeaders })).json()) as any;
    const dlRecords = recentAfterDl.transfers.filter(
      (t: any) => t.filename === "small_dl.txt" || t.filename === "large_dl.bin" || t.filename === "large_remote.bin"
    );
    assert.strictEqual(dlRecords.length, 3, "Tutti e 3 i download devono essere presenti");
    for (const dl of dlRecords) {
      assert.strictEqual(dl.status, "COMPLETED", `Download ${dl.filename} deve essere COMPLETED`);
      assert.strictEqual(dl.percent, 100, `Download ${dl.filename} deve essere al 100%`);
      assert.strictEqual(dl.transferredBytes, dl.totalBytes, `Download ${dl.filename} bytes mismatch`);
      assert.ok(dl.averageSpeedBytesPerSec > 0, `Download ${dl.filename} deve avere averageSpeedBytesPerSec > 0`);
    }

    // =========================================================================
    // REGRESSIONE BATCH 540f0b21 / 203e6760 + SCENARIO 14 (Bulk staging <200ms -> 100%)
    // + SCENARIO 6 (Fallimento durante upload in batch con robot disabilitato)
    // =========================================================================
    console.log("  [5-6/14] Bulk upload multi-robot con percorsi relativi/home (TEST e ~/TEST_HOME su robot + robot01) + target fallito...");
    const pngPayload = crypto.randomBytes(167_800); // ~167.8 KB esatto come nello screenshot!
    const form = new FormData();
    form.append(
      "targets",
      JSON.stringify([
        { type: "robot", robotId: robot1.id, directory: "TEST" }, // -> /home/robot/TEST
        { type: "robot", robotId: robot2.id, directory: "TEST" }, // -> /home/robot01/TEST (auto-creata nella home di robot01!)
        { type: "robot", robotId: robot2.id, directory: "~/TEST_HOME" }, // -> /home/robot01/TEST_HOME
        { type: "robot", robotId: robotDisabled.id, directory: "TEST" }, // Fallimento controllato!
        { type: "general", directory: "test_bulk" },
      ])
    );
    form.append("overwrite", "true");
    form.append("fileSizes", JSON.stringify([pngPayload.length]));
    form.append("files", new Blob([pngPayload], { type: "image/png" }), "Schermata_167kb.png");

    const bulkRes = await fetch(`${baseUrl}/api/transfers/bulk/upload`, {
      method: "POST",
      headers: authHeaders,
      body: form,
    });
    assert.strictEqual(bulkRes.status, 200);
    const bulkBody = (await bulkRes.json()) as any;
    const failedBatchId = bulkBody.batchId;
    assert.ok(failedBatchId, "batchId deve essere valorizzato");
    assert.strictEqual(bulkBody.summary.completed, 4, "robot1 (TEST) + robot2 (TEST & ~/TEST_HOME) + general devono riuscire");
    assert.strictEqual(bulkBody.summary.failed, 1, "robot-disabled deve fallire");
    assert.ok(
      sftp1.files["/home/robot/TEST/Schermata_167kb.png"]?.length === pngPayload.length,
      "Percorso relativo TEST deve risolversi in /home/robot/TEST su robot-vm-01"
    );
    assert.ok(
      sftp2.files["/home/robot01/TEST/Schermata_167kb.png"]?.length === pngPayload.length,
      "Percorso relativo TEST deve risolversi e auto-crearsi in /home/robot01/TEST su robot-vm-02"
    );
    assert.ok(
      sftp2.files["/home/robot01/TEST_HOME/Schermata_167kb.png"]?.length === pngPayload.length,
      "Percorso ~/TEST_HOME deve risolversi e auto-crearsi in /home/robot01/TEST_HOME su robot-vm-02"
    );

    // Verifica che il record di staging (<200ms!) sia 100% e NON 0%!
    const recentAfterBulk = (await (await fetch(`${baseUrl}/api/transfers/recent`, { headers: authHeaders })).json()) as any;
    const stagingRows = recentAfterBulk.transfers.filter(
      (t: any) => t.filename === "Schermata_167kb.png" && t.isBulkStaging === true
    );
    assert.strictEqual(stagingRows.length, 1, "Record staging Computer->Server presente");
    assert.strictEqual(stagingRows[0].status, "COMPLETED");
    assert.strictEqual(stagingRows[0].transferredBytes, pngPayload.length, "Staging NON deve avere 0 byte!");
    assert.strictEqual(stagingRows[0].totalBytes, pngPayload.length);
    assert.strictEqual(stagingRows[0].percent, 100, "Staging COMPLETATO deve essere 100%, mai 0%!");
    assert.ok(stagingRows[0].averageSpeedBytesPerSec > 0, "Staging completato deve avere averageSpeedBytesPerSec > 0");

    // Verifica che il target fallito del batch sia presente in GET /api/transfers/batches/:batchId e in /api/logs/transfers
    const batchDetailRes = await fetch(`${baseUrl}/api/transfers/batches/${failedBatchId}`, { headers: authHeaders });
    assert.strictEqual(batchDetailRes.status, 200);
    const batchDetail = (await batchDetailRes.json()) as any;
    const failedBatchTransfer = (batchDetail.transfers || []).find((t: any) => t.status === "FAILED");
    assert.ok(failedBatchTransfer, "Il trasferimento fallito del batch deve essere registrato con batchId");
    assert.strictEqual(failedBatchTransfer.robotId, robotDisabled.id);
    assert.ok(failedBatchTransfer.error && failedBatchTransfer.error.length > 0, "Messaggio errore obbligatorio");

    // =========================================================================
    // SCENARIO 7: Fallimento durante download (errore SFTP a metà lettura)
    // =========================================================================
    console.log("  [7/14] Fallimento durante download (ROBOT_TO_CLIENT errore lettura)...");
    const brokenDlRes = await fetch(
      `${baseUrl}/api/robots/${robot1.id}/transfers/client-robot/download?path=/home/robot/broken_remote.bin`,
      { headers: authHeaders }
    );
    try {
      await brokenDlRes.arrayBuffer();
    } catch {
      // Atteso: stream interrotto da errore SFTP lato server
    }
    await new Promise((r) => setTimeout(r, 200));
    const logsAfterBrokenDl = (await (await fetch(`${baseUrl}/api/logs/transfers?limit=200`, { headers: authHeaders })).json()) as any;
    const brokenRecord = logsAfterBrokenDl.records.find((r: any) => r.filename === "broken_remote.bin");
    assert.ok(brokenRecord, "Download fallito broken_remote.bin deve comparire nei log");
    assert.ok(
      brokenRecord.status === "FAILED" || brokenRecord.status === "INTEGRITY_FAILED",
      `Atteso stato FAILED/INTEGRITY_FAILED, ottenuto ${brokenRecord.status}`
    );
    assert.ok(brokenRecord.error, "Il download fallito deve riportare la causa dell'errore");

    // =========================================================================
    // SCENARIO 8 & 9: Pausa/Ripresa (esclusione tempo pausa dalla velocità media) + Annullamento
    // =========================================================================
    console.log("  [8-9/14] Pausa/Ripresa (esclusione pausa da velocità media) e Trasferimento interrotto/annullato...");
    const session = sessionManager.createSession(adminUser);
    const authCtx = sessionManager.createAuthorizedContext(session, adminUser, robot1.id);

    // 9. Pausa e ripresa su uploadClientToServer tramite stream controllato (~200 KB in 10 chunk da 20 KB)
    const pauseTotalBytes = 200 * 1024;
    let chunksSent = 0;
    const controlledStream = new Readable({
      read() {
        if (chunksSent >= 10) {
          this.push(null);
          return;
        }
        chunksSent++;
        setTimeout(() => {
          this.push(Buffer.alloc(20 * 1024, 0x41));
        }, 30);
      },
    });

    const uploadPromise = transferService.uploadClientToServer(
      authCtx,
      robot1,
      "upload",
      "pause_resume_test.bin",
      controlledStream,
      { overwrite: true },
      pauseTotalBytes
    );

    // Attendi che il trasferimento entri IN_PROGRESS
    let pauseTargetId = "";
    for (let i = 0; i < 40; i++) {
      const list = transferService.listTransfers(authCtx);
      const found = list.find((t) => t.filename === "pause_resume_test.bin" && t.status === TransferStatus.IN_PROGRESS);
      if (found) {
        pauseTargetId = found.transferId;
        break;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(pauseTargetId, "Trasferimento pause_resume_test.bin doveva entrare IN_PROGRESS");

    // Metti in PAUSA via endpoint HTTP
    const pauseRes = await fetch(`${baseUrl}/api/transfers/${pauseTargetId}/pause`, {
      method: "POST",
      headers: authHeaders,
    });
    assert.strictEqual(pauseRes.status, 200, "POST /pause deve rispondere 200");
    const pausedDto = (await pauseRes.json()) as any;
    assert.strictEqual(pausedDto.status, "PAUSED");

    // Resta in pausa per 700 ms (questo tempo NON deve abbassare la velocità media!)
    await new Promise((r) => setTimeout(r, 700));

    // Riprendi via endpoint HTTP
    const resumeRes = await fetch(`${baseUrl}/api/transfers/${pauseTargetId}/resume`, {
      method: "POST",
      headers: authHeaders,
    });
    assert.strictEqual(resumeRes.status, 200, "POST /resume deve rispondere 200");
    const resumedDto = (await resumeRes.json()) as any;
    assert.strictEqual(resumedDto.status, "IN_PROGRESS");

    const pauseFinalDto = await uploadPromise;
    assert.strictEqual(pauseFinalDto.status, "COMPLETED");
    assert.strictEqual(pauseFinalDto.percent, 100);
    assert.strictEqual(pauseFinalDto.transferredBytes, pauseTotalBytes);
    assert.ok(
      (pauseFinalDto.durationMs || 0) < 650,
      `La durata attiva (${pauseFinalDto.durationMs}ms) doveva escludere i 700ms di pausa!`
    );
    assert.ok((pauseFinalDto.averageSpeedBytesPerSec || 0) > 250_000, "Velocità media al netto della pausa coerente");

    // 8. Trasferimento interrotto/annullato a metà
    let cancelChunks = 0;
    const cancelStream = new Readable({
      read() {
        if (cancelChunks >= 20) {
          this.push(null);
          return;
        }
        cancelChunks++;
        setTimeout(() => {
          this.push(Buffer.alloc(32 * 1024, 0x42));
        }, 40);
      },
    });
    const cancelUploadPromise = transferService
      .uploadClientToServer(authCtx, robot1, "upload", "cancelled_midway.bin", cancelStream, { overwrite: true }, 640 * 1024)
      .catch((e) => e);

    let cancelId = "";
    for (let i = 0; i < 40; i++) {
      const found = transferService
        .listTransfers(authCtx)
        .find((t) => t.filename === "cancelled_midway.bin" && t.status === TransferStatus.IN_PROGRESS && t.transferredBytes > 0);
      if (found) {
        cancelId = found.transferId;
        break;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.ok(cancelId, "Trasferimento cancelled_midway.bin doveva avviarsi");
    const cancelRes = await fetch(`${baseUrl}/api/transfers/${cancelId}/cancel`, {
      method: "POST",
      headers: authHeaders,
    });
    assert.strictEqual(cancelRes.status, 200);
    await cancelUploadPromise;
    const cancelledRecord = (await transferService.listAllTransferHistory({ limit: 200 })).find(
      (r) => r.transferId === cancelId
    );
    assert.ok(cancelledRecord, "Trasferimento annullato deve esistere nello storico");
    assert.strictEqual(cancelledRecord!.status, "CANCELLED");
    assert.ok(cancelledRecord!.transferredBytes > 0, "I byte trasferiti prima dell'annullamento NON devono azzerarsi");

    // =========================================================================
    // SCENARIO 11: Rimozione dalla lista Recenti NON cancella dai LOG
    // =========================================================================
    console.log("  [11/14] Rimozione da Recenti preserva lo storico nei LOG...");
    const delRes = await fetch(`${baseUrl}/api/transfers/${smallUpDto.transferId}`, {
      method: "DELETE",
      headers: authHeaders,
    });
    assert.strictEqual(delRes.status, 200);
    const logsAfterRemove = (await (await fetch(`${baseUrl}/api/logs/transfers?limit=200`, { headers: authHeaders })).json()) as any;
    assert.ok(
      logsAfterRemove.records.some((r: any) => r.transferId === smallUpDto.transferId),
      "Un trasferimento rimosso dai Recenti deve rimanere visibile in /api/logs/transfers"
    );

    // =========================================================================
    // SCENARIO 13 (Backend Restart): Nuova istanza TransferService idratata dallo stesso repository
    // =========================================================================
    console.log("  [13a/14] Persistenza dopo riavvio backend simulato (hydrateFromRepository)...");
    // Inseriamo anche un record stale IN_PROGRESS per verificare il recovery al riavvio (Scenario 8)
    await transferRepo.upsert({
      transferId: "stale-restart-transfer",
      userId: adminUser.id,
      username: adminUser.username,
      robotId: robot1.id,
      direction: "CLIENT_TO_SERVER",
      filename: "interrupted_by_restart.bin",
      sourcePath: "interrupted_by_restart.bin",
      destinationPath: "upload/interrupted_by_restart.bin",
      totalBytes: 500_000,
      transferredBytes: 250_000,
      percent: 50,
      status: TransferStatus.IN_PROGRESS,
      currentSpeedBytesPerSec: 120_000,
      speedBytesPerSec: 120_000,
      averageSpeedBytesPerSec: null,
      etaSeconds: 2,
      startedAt: new Date(Date.now() - 5000).toISOString(),
      activeStartedAt: new Date(Date.now() - 4000).toISOString(),
      completedAt: null,
      pausedDurationMs: 0,
      durationMs: null,
      error: null,
      errorCode: undefined,
      checksum: null,
      checksumAlgorithm: "sha256",
      integrityLabel: undefined,
      hiddenFromRecent: false,
      updatedAt: new Date().toISOString(),
    });

    const restartedService = new TransferService(
      config,
      robotRepo,
      serverFsService,
      remoteFsService,
      sessionManager,
      auditRepo,
      logger,
      undefined,
      undefined,
      connectionManager
    );
    restartedService.setTransferRepository(transferRepo);
    await restartedService.hydrateFromRepository();

    const restartedRecent = restartedService.listTransfers(authCtx);
    const restoredLargeUp = restartedRecent.find((t) => t.transferId === largeUpDto.transferId);
    assert.ok(restoredLargeUp, "Upload grande deve sopravvivere al riavvio backend");
    assert.strictEqual(restoredLargeUp!.percent, 100);
    assert.strictEqual(
      restoredLargeUp!.averageSpeedBytesPerSec,
      largeUpDto.averageSpeedBytesPerSec,
      "Velocità media deve rimanere identica dopo riavvio backend"
    );

    const restoredInterrupted = restartedRecent.find((t) => t.transferId === "stale-restart-transfer");
    assert.ok(restoredInterrupted, "Trasferimento stale deve essere marcato FAILED al riavvio");
    assert.strictEqual(restoredInterrupted!.status, TransferStatus.FAILED);
    assert.strictEqual(restoredInterrupted!.percent, 50, "Percentuale raggiunta prima del crash preservata");
    assert.ok(restoredInterrupted!.error?.includes("riavvio"), "Errore riavvio chiaro");

    // Verifica anche che transfers.log contenga ESPLICITAMENTE i trasferimenti falliti!
    const transfersLogText = fs.readFileSync(physicalFileLogger.getTransferLogFilePath(), "utf-8");
    assert.ok(transfersLogText.includes("Esito: FALLIMENTO"), "transfers.log deve registrare i trasferimenti falliti");
    assert.ok(transfersLogText.includes(failedBatchId), "transfers.log deve contenere il batchId del batch con fallimenti");

    // =========================================================================
    // SCENARI 10, 12, 13, 14 SU BROWSER CHROME REALE (CDP)
    // =========================================================================
    console.log("  [10,12,13b,14/14] Verifica UI reale su Google Chrome Headless...");
    const chromeCandidates = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"];
    let chromeBin = "";
    for (const c of chromeCandidates) {
      try {
        chromeBin = execSync(`which ${c}`, { stdio: "pipe" }).toString().trim();
        if (chromeBin) break;
      } catch {}
    }
    assert.ok(chromeBin, "Google Chrome / Chromium richiesto per verifica browser E2E");

    chromeProc = spawn(
      chromeBin,
      [
        "--headless=new",
        `--remote-debugging-port=${cdpPort}`,
        `--user-data-dir=${chromeUserDataDir}`,
        "--ignore-certificate-errors",
        "--no-sandbox",
        "--disable-gpu",
        "--window-size=1440,900",
        "about:blank",
      ],
      { stdio: "ignore" }
    );

    // Attendi CDP
    let wsUrl = "";
    for (let i = 0; i < 40; i++) {
      try {
        const listRes = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
        const pages = (await listRes.json()) as any[];
        const page = pages.find((p) => p.type === "page" && p.webSocketDebuggerUrl);
        if (page) {
          wsUrl = page.webSocketDebuggerUrl;
          break;
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 150));
    }
    assert.ok(wsUrl, "Impossibile connettersi a Chrome DevTools Protocol");

    const ws = new WebSocket(wsUrl);
    await new Promise<void>((res, rej) => {
      ws.addEventListener("open", () => res(), { once: true });
      ws.addEventListener("error", (e) => rej(e), { once: true });
    });

    let cdpId = 1;
    const pendingCdp = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];

    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id && pendingCdp.has(msg.id)) {
        const p = pendingCdp.get(msg.id)!;
        pendingCdp.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
      } else if (msg.method === "Runtime.exceptionThrown") {
        pageErrors.push(msg.params?.exceptionDetails?.text || JSON.stringify(msg.params));
      } else if (msg.method === "Runtime.consoleAPICalled" && msg.params?.type === "error") {
        consoleErrors.push(
          (msg.params.args || []).map((a: any) => a.value || a.description || "").join(" ")
        );
      }
    });

    const cdp = (method: string, params: Record<string, any> = {}) =>
      new Promise<any>((resolve, reject) => {
        const id = cdpId++;
        pendingCdp.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });

    await cdp("Page.enable");
    await cdp("Runtime.enable");

    const evalJs = async (expression: string) => {
      const r = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) {
        throw new Error(`JS error: ${r.exceptionDetails.text}`);
      }
      return r.result?.value;
    };

    const waitFor = async (predicateJs: string, timeoutMs = 10000, label = "condition") => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const ok = await evalJs(predicateJs);
        if (ok) return ok;
        await new Promise((r) => setTimeout(r, 120));
      }
      throw new Error(`Timeout attesa: ${label}`);
    };

    // Avvia anche un trasferimento attivo lento così testiamo Scenario 10 (refresh durante trasferimento attivo!)
    let liveChunks = 0;
    const liveStream = new Readable({
      read() {
        if (liveChunks >= 30) {
          this.push(null);
          return;
        }
        liveChunks++;
        setTimeout(() => {
          this.push(Buffer.alloc(16 * 1024, 0x55));
        }, 200);
      },
    });
    const liveUploadPromise = transferService
      .uploadClientToServer(authCtx, robot1, "upload", "live_refresh_test.bin", liveStream, { overwrite: true }, 480 * 1024)
      .catch(() => null);

    // Naviga sulla app ed esegui login reale nel browser
    await cdp("Page.navigate", { url: baseUrl });
    await waitFor(`Boolean(document.querySelector('input[type="password"]'))`, 10000, "login form");
    await evalJs(`(() => {
      const u = document.querySelector('input[name="username"], #login-username, input[type="text"]');
      const p = document.querySelector('input[name="password"], #login-password, input[type="password"]');
      const setVal = (el, val) => {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(el, val);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      };
      setVal(u, 'admin');
      setVal(p, 'AdminPass123!');
      document.querySelector('button[type="submit"]').click();
    })()`);

    await waitFor(`Boolean(document.getElementById('nav-files') || document.querySelector('[data-nav="files"]')) || document.body.innerText.includes('Gestione file/trasferimenti')`, 10000, "dashboard post-login");

    // Apri sezione Gestione file/trasferimenti -> scheda Trasferimenti
    await evalJs(`(() => {
      const btn = Array.from(document.querySelectorAll('button, a')).find((el) => el.textContent && el.textContent.includes('Gestione file/trasferimenti'));
      if (btn) btn.click();
    })()`);
    await waitFor(`document.body.innerText.includes('Trasferimenti')`, 10000, "tab Gestione file");
    await evalJs(`(() => {
      const btn = Array.from(document.querySelectorAll('button[role="tab"], .fs-tab-btn, button')).find((el) => el.textContent && el.textContent.trim().startsWith('Trasferimenti'));
      if (btn) btn.click();
    })()`);

    await waitFor(`document.querySelectorAll('tr[data-transfer-id]').length >= 4`, 10000, "righe trasferimenti in DOM");

    // Scenario 10: verifica trasferimento attivo visibile PRIMA e DOPO reload completo della pagina
    const beforeReloadState = await evalJs(`(() => {
      const rows = Array.from(document.querySelectorAll('tr[data-transfer-id]'));
      return rows.map((r) => ({
        id: r.getAttribute('data-transfer-id'),
        status: r.getAttribute('data-status'),
        text: r.innerText.replace(/\\s+/g, ' ').trim(),
      }));
    })()`);
    assert.ok(
      beforeReloadState.some((r: any) => r.text.includes("live_refresh_test.bin")),
      "Trasferimento attivo live_refresh_test.bin visibile in UI prima del refresh"
    );

    // Reload pagina durante trasferimento attivo (Scenario 10 & Scenario 13)
    await cdp("Page.reload", { ignoreCache: true });
    await waitFor(`document.body.innerText.includes('Gestione file/trasferimenti')`, 10000, "reload dashboard");
    await evalJs(`(() => {
      const btn = Array.from(document.querySelectorAll('button, a')).find((el) => el.textContent && el.textContent.includes('Gestione file/trasferimenti'));
      if (btn) btn.click();
    })()`);
    await waitFor(`document.body.innerText.includes('Trasferimenti')`, 10000, "tab Gestione file post-reload");
    await evalJs(`(() => {
      const btn = Array.from(document.querySelectorAll('button[role="tab"], .fs-tab-btn, button')).find((el) => el.textContent && el.textContent.trim().startsWith('Trasferimenti'));
      if (btn) btn.click();
    })()`);
    await waitFor(`document.querySelectorAll('tr[data-transfer-id]').length >= 4`, 10000, "righe trasferimenti post-reload");

    const afterReloadRows = await evalJs(`(() => {
      return Array.from(document.querySelectorAll('tr[data-transfer-id]')).map((r) => ({
        status: r.getAttribute('data-status'),
        speed: r.querySelector('.transfers-cell-speed')?.textContent?.trim() || '',
        text: r.innerText.replace(/\\s+/g, ' ').trim(),
      }));
    })()`);

    // Scenario 14: OGNI trasferimento COMPLETED in DOM deve avere 100% e velocità media con ↑ o ↓ (Scenario 13)!
    const completedDomRows = afterReloadRows.filter((r: any) => r.status === "COMPLETED");
    assert.ok(completedDomRows.length >= 4, `Attesi almeno 4 trasferimenti completati in DOM, trovati ${completedDomRows.length}`);
    for (const row of completedDomRows) {
      assert.ok(row.text.includes("100%"), `Riga completata senza 100% nel DOM: ${row.text}`);
      assert.ok(!row.text.includes(" 0%"), `Riga completata mostra erroneamente 0% nel DOM: ${row.text}`);
      assert.ok(
        /^[↑↓]\s+\d/.test(row.speed),
        `Riga completata deve mostrare velocità media con freccia ↑/↓ dopo refresh, ottenuto '${row.speed}' (${row.text})`
      );
    }
    // Verifica frecce distinte: ↑ per upload, ↓ per download
    const completedUploadRow = completedDomRows.find((r: any) => r.text.includes("large_up.bin"));
    const completedDownloadRow = completedDomRows.find((r: any) => r.text.includes("large_dl.bin"));
    assert.ok(completedUploadRow?.speed.startsWith("↑ "), `Upload deve mostrare freccia ↑: ${completedUploadRow?.speed}`);
    assert.ok(completedDownloadRow?.speed.startsWith("↓ "), `Download deve mostrare freccia ↓: ${completedDownloadRow?.speed}`);

    // Verifica Miglioramenti #2 e #3: zero path nelle righe endpoint, robotId visibili e contenimento totale nella card batch
    const endpointAudit = await evalJs(`(() => {
      const batchCard = document.getElementById('batch-card-${failedBatchId}');
      const batchRows = batchCard ? Array.from(batchCard.querySelectorAll('.batch-transfer-table-wrap tbody tr[data-transfer-id]')) : [];
      const endpoints = Array.from(document.querySelectorAll('.batch-transfer-endpoint, .transfers-route')).map((el) => el.textContent?.trim() || '');
      return {
        batchRowCount: batchRows.length,
        hasBatchScrollWrap: Boolean(batchCard?.querySelector('.batch-transfer-table-wrap')),
        endpoints,
      };
    })()`);
    assert.strictEqual(endpointAudit.batchRowCount, 5, `Tutti i 5 elementi del batch devono essere contenuti dentro #batch-card-${failedBatchId}`);
    assert.ok(endpointAudit.hasBatchScrollWrap, "La card batch deve avere il contenitore scorrevole .batch-transfer-table-wrap");
    for (const ep of endpointAudit.endpoints) {
      assert.ok(!ep.includes("/home/"), `La riga descrittiva non deve contenere path grezzi: '${ep}'`);
    }
    assert.ok(
      endpointAudit.endpoints.some((e: string) => e === "Computer → Robot (robot-vm-01)"),
      `Atteso endpoint 'Computer → Robot (robot-vm-01)', trovati: ${endpointAudit.endpoints.join(" | ")}`
    );
    assert.ok(
      endpointAudit.endpoints.some((e: string) => e === "Computer → Robot (robot-vm-02)"),
      `Atteso endpoint 'Computer → Robot (robot-vm-02)', trovati: ${endpointAudit.endpoints.join(" | ")}`
    );
    assert.ok(
      endpointAudit.endpoints.some((e: string) => e === "Computer → Archivio Generale Server"),
      `Atteso endpoint 'Computer → Archivio Generale Server', trovati: ${endpointAudit.endpoints.join(" | ")}`
    );

    // Scenario 12: Apri sezione Logs -> scheda Log Trasferimenti File e verifica visibilità trasferimenti falliti/annullati!
    await evalJs(`(() => {
      const btn = Array.from(document.querySelectorAll('button, a')).find((el) => el.textContent && el.textContent.trim() === 'Logs');
      if (btn) btn.click();
    })()`);
    await waitFor(`Boolean(document.getElementById('tab-transfer-logs'))`, 10000, "LogsView");
    await evalJs(`document.getElementById('tab-transfer-logs').click()`);
    await waitFor(`document.querySelectorAll('#table-transfer-logs tbody tr').length >= 5`, 10000, "tabella log trasferimenti");

    const hasDeprecatedHistoryTable = await evalJs(`Boolean(document.getElementById('table-transfer-history-records'))`);
    assert.strictEqual(hasDeprecatedHistoryTable, false, "La tabella 'Storico Completo Trasferimenti' non deve essere presente nei Log");

    const physicalLogRows = await evalJs(`(() => {
      return Array.from(document.querySelectorAll('#table-transfer-logs tbody tr')).map((r) => {
        const tds = Array.from(r.querySelectorAll('td'));
        return {
          file: tds[1]?.innerText?.trim() || '',
          direction: tds[3]?.innerText?.trim() || '',
          outcome: tds[4]?.innerText?.trim() || '',
          details: tds[tds.length - 1]?.innerText?.trim() || '',
          text: r.innerText.replace(/\\s+/g, ' ').trim(),
        };
      });
    })()`);

    const failedLogRow = physicalLogRows.find(
      (r: any) => r.details.includes(failedBatchId) && r.outcome === "FALLIMENTO"
    );
    assert.ok(failedLogRow, `Trasferimento fallito del batch ${failedBatchId} NON visibile nei LOG!`);
    assert.ok(failedLogRow.file.includes("Schermata_167kb.png"), "Nome file presente nei log");
    assert.strictEqual(
      failedLogRow.direction,
      `Computer → Robot (${robotDisabled.id})`,
      `Direzione nei log deve usare formato leggibile con robotId, ottenuto '${failedLogRow.direction}'`
    );
    assert.ok(
      physicalLogRows.some((r: any) => r.direction === "Computer → Robot (robot-vm-02)"),
      "Direzione nei log deve mostrare 'Computer → Robot (robot-vm-02)'"
    );
    assert.ok(
      physicalLogRows.every((r: any) => !/^(?:CLIENT|SERVER|ROBOT)_TO_(?:CLIENT|SERVER|ROBOT)$/.test(r.direction)),
      `La colonna Direzione nei log non deve mostrare codici grezzi tipo CLIENT_TO_ROBOT: ${physicalLogRows.map((r: any) => r.direction).join(" | ")}`
    );

    const brokenDlLogRow = physicalLogRows.find((r: any) => r.file.includes("broken_remote.bin"));
    assert.ok(brokenDlLogRow, "Download fallito broken_remote.bin deve essere visibile nei LOG");
    assert.strictEqual(brokenDlLogRow.outcome, "FALLIMENTO", "Esito FALLIMENTO visibile nei LOG");

    const cancelledLogRow = physicalLogRows.find((r: any) => r.file.includes("cancelled_midway.bin"));
    assert.ok(cancelledLogRow && cancelledLogRow.outcome === "ANNULLATO", "Trasferimento annullato visibile nei LOG");

    // Verifica Miglioramento #4: colonna Dettagli in #table-transfer-logs compatta (zero UUID/checksum hex nella cella principale)
    assert.ok(physicalLogRows.length > 0, "Righe transfers.log visibili in tabella");
    for (const row of physicalLogRows) {
      assert.ok(!row.details.includes("transferId:"), `Dettagli visibili non devono mostrare 'transferId:': ${row.details}`);
      assert.ok(!/[0-9a-f]{64}/i.test(row.details), `Dettagli visibili non devono mostrare checksum SHA-256 integrale: ${row.details}`);
    }
    assert.ok(
      physicalLogRows.some((r: any) => r.details.includes("Checksum verificato")),
      "I trasferimenti completati nei log devono mostrare 'Checksum verificato' in forma compatta"
    );

    // Verifica filtro FALLIMENTO nei LOG
    await evalJs(`(() => {
      const sel = document.getElementById('filter-transfer-outcome');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
      setter.call(sel, 'FALLIMENTO');
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await waitFor(
      `(() => {
        const rows = Array.from(document.querySelectorAll('#table-transfer-logs tbody tr'));
        return rows.length >= 2 && rows.every((r) => (r.querySelectorAll('td')[4]?.innerText?.trim() || '') === 'FALLIMENTO');
      })()`,
      10000,
      "filtro FALLIMENTO su #table-transfer-logs"
    );

    // Verifica rimozione intestazione "Registro Fisico Su Disco (transfers.log — ...)" in Log trasferimenti
    const transferPanelText = await evalJs(`document.getElementById('panel-transfer-logs')?.innerText || ''`);
    assert.ok(
      !transferPanelText.includes("Registro Fisico Su Disco"),
      "L'intestazione 'Registro Fisico Su Disco' non deve essere presente in Log trasferimenti"
    );

    // Verifica ordine barra pulsanti in Log trasferimenti: Aggiorna -> Scarica -> Elimina log (stile distruttivo)
    const transferToolbar = await evalJs(`(() => {
      const clearBtn = document.getElementById('btn-clear-transfer-logs');
      const parent = clearBtn?.parentElement;
      const children = parent ? Array.from(parent.children).map((el) => ({
        id: el.id,
        text: el.textContent?.trim() || '',
        className: el.className,
      })) : [];
      return children;
    })()`);
    assert.deepStrictEqual(
      transferToolbar.map((b: any) => b.id),
      ["btn-refresh-transfer-logs", "btn-download-transfer-logs", "btn-clear-transfer-logs"],
      "Ordine pulsanti Log trasferimenti deve essere Aggiorna -> Scarica -> Elimina log"
    );
    assert.strictEqual(transferToolbar[2].text, "Elimina log");
    assert.ok(transferToolbar[2].className.includes("danger"), "Pulsante Elimina log deve usare stile distruttivo");

    // Attendi il termine del trasferimento live così transfers.log non riceve nuove scritture durante il test di svuotamento
    await liveUploadPromise;

    // Reset filtro esito a ALL prima di verificare la finestra di conferma e lo svuotamento
    await evalJs(`(() => {
      const sel = document.getElementById('filter-transfer-outcome');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
      setter.call(sel, 'ALL');
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await waitFor(`document.querySelectorAll('#table-transfer-logs tbody tr').length >= 5`, 10000, "ripristino filtro ALL log trasferimenti");

    // Verifica RBAC: utente non admin (operatore) riceve 403 su DELETE /api/logs/access e /api/logs/transfers
    const operatorUser = {
      ...adminUser,
      id: "user-operator-logs-rbac",
      username: "operatore-logs",
      roles: ["operatore"],
    };
    await userRepo.create(operatorUser);
    const opSession = sessionManager.createSession(operatorUser);
    const accessContentBeforeDenied = fs.readFileSync(physicalFileLogger.getAccessLogFilePath(), "utf-8");
    const transferContentBeforeDenied = fs.readFileSync(physicalFileLogger.getTransferLogFilePath(), "utf-8");
    for (const logType of ["access", "transfers"] as const) {
      const deniedRes = await fetch(`${baseUrl}/api/logs/${logType}`, {
        method: "DELETE",
        headers: {
          cookie: `__Host-moliris_session=${opSession.sessionId}`,
          origin: baseUrl,
        },
      });
      assert.strictEqual(deniedRes.status, 403, `DELETE /api/logs/${logType} deve essere 403 per non-admin`);
    }
    assert.strictEqual(
      fs.readFileSync(physicalFileLogger.getAccessLogFilePath(), "utf-8"),
      accessContentBeforeDenied,
      "DELETE 403 da operatore non deve modificare access.log"
    );
    assert.strictEqual(
      fs.readFileSync(physicalFileLogger.getTransferLogFilePath(), "utf-8"),
      transferContentBeforeDenied,
      "DELETE 403 da operatore non deve modificare transfers.log"
    );

    // Assicura almeno una voce in access.log per verificare l'isolamento tra i due registri
    await physicalFileLogger.logAccess({
      event: "LOGIN",
      username: "admin",
      role: "admin",
      outcome: "SUCCESSO",
      details: "Fixture accesso per test eliminazione log",
    });
    const rotatedTransferLogPath = `${physicalFileLogger.getTransferLogFilePath()}.1`;
    fs.writeFileSync(
      rotatedTransferLogPath,
      "[2026-01-01 10:00:00] File: archivio_ruotato.bin | Utente: admin | Direzione: CLIENT_TO_SERVER | Esito: SUCCESSO | Dettagli: storico\n",
      { mode: 0o600 }
    );

    // Verifica finestra di conferma e pulsante Annulla (nessuna eliminazione)
    await evalJs(`document.getElementById('btn-clear-transfer-logs').click()`);
    await waitFor(`Boolean(document.getElementById('clear-logs-modal'))`, 5000, "modale conferma eliminazione log trasferimenti");
    const transferConfirmText = await evalJs(`document.getElementById('clear-logs-modal')?.innerText || ''`);
    assert.ok(transferConfirmText.includes("Log trasferimenti"), `La finestra di conferma deve indicare il registro: ${transferConfirmText}`);
    assert.ok(transferConfirmText.includes("Annulla") && transferConfirmText.includes("Elimina"));
    await evalJs(`document.getElementById('btn-cancel-clear-logs').click()`);
    await waitFor(`!document.getElementById('clear-logs-modal')`, 5000, "chiusura modale su Annulla");
    assert.ok(fs.readFileSync(physicalFileLogger.getTransferLogFilePath(), "utf-8").trim().length > 0, "Annulla non deve svuotare transfers.log");

    // Verifica gestione errore lato server: se l'eliminazione fallisce, mostra errore SENZA svuotare la vista
    const rowsBeforeError = await evalJs(`document.querySelectorAll('#table-transfer-logs tbody tr').length`);
    if (typeof process.getuid === "function" && process.getuid() !== 0) {
      fs.chmodSync(physicalFileLogger.getTransferLogFilePath(), 0o400);
      try {
        await evalJs(`document.getElementById('btn-clear-transfer-logs').click()`);
        await waitFor(`Boolean(document.getElementById('clear-logs-modal'))`, 5000, "modale conferma errore eliminazione");
        await evalJs(`document.getElementById('btn-confirm-clear-logs').click()`);
        await waitFor(`Boolean(document.querySelector('#panel-transfer-logs .alert-danger'))`, 5000, "alert errore eliminazione log trasferimenti");
        const rowsAfterError = await evalJs(`document.querySelectorAll('#table-transfer-logs tbody tr').length`);
        assert.strictEqual(rowsAfterError, rowsBeforeError, "In caso di errore la vista log non deve essere svuotata");
      } finally {
        fs.chmodSync(physicalFileLogger.getTransferLogFilePath(), 0o600);
      }
    }

    // Conferma eliminazione Log trasferimenti -> svuota lato server (incluso ruotato), vista mostra "Nessun log disponibile", access.log intatto
    const accessBeforeTransferClear = fs.readFileSync(physicalFileLogger.getAccessLogFilePath(), "utf-8");
    await evalJs(`document.getElementById('btn-clear-transfer-logs').click()`);
    await waitFor(`Boolean(document.getElementById('clear-logs-modal'))`, 5000, "modale conferma svuotamento trasferimenti");
    await evalJs(`document.getElementById('btn-confirm-clear-logs').click()`);
    await waitFor(
      `!document.getElementById('clear-logs-modal') && (document.querySelector('#table-transfer-logs tbody')?.innerText || '').includes('Nessun log disponibile')`,
      10000,
      "stato vuoto 'Nessun log disponibile' dopo eliminazione log trasferimenti"
    );
    assert.strictEqual(fs.readFileSync(physicalFileLogger.getTransferLogFilePath(), "utf-8"), "", "transfers.log deve essere vuoto su disco");
    assert.strictEqual(fs.existsSync(rotatedTransferLogPath), false, "Eventuali archivi ruotati transfers.log.1 devono essere rimossi");
    assert.strictEqual(
      fs.readFileSync(physicalFileLogger.getAccessLogFilePath(), "utf-8"),
      accessBeforeTransferClear,
      "Lo svuotamento di transfers.log non deve modificare access.log"
    );

    // Passa a Log di Accesso: verifica pulsanti, integrità dei log di accesso e svuotamento isolato
    await evalJs(`document.getElementById('tab-access-logs').click()`);
    await waitFor(`document.querySelectorAll('#table-access-logs tbody tr').length >= 1 && !(document.querySelector('#table-access-logs tbody')?.innerText || '').includes('Nessun log disponibile')`, 10000, "righe access.log ancora presenti");
    const accessToolbar = await evalJs(`(() => {
      const clearBtn = document.getElementById('btn-clear-access-logs');
      const parent = clearBtn?.parentElement;
      return parent ? Array.from(parent.children).map((el) => ({
        id: el.id,
        text: el.textContent?.trim() || '',
        className: el.className,
      })) : [];
    })()`);
    assert.deepStrictEqual(
      accessToolbar.map((b: any) => b.id),
      ["btn-refresh-access-logs", "btn-download-access-logs", "btn-clear-access-logs"],
      "Ordine pulsanti Log accessi deve essere Aggiorna -> Scarica -> Elimina log"
    );
    assert.strictEqual(accessToolbar[2].text, "Elimina log");
    assert.ok(accessToolbar[2].className.includes("danger"), "Pulsante Elimina log accessi deve usare stile distruttivo");

    // Scrivi una nuova voce in transfers.log per verificare che svuotare access.log NON tocchi transfers.log
    const transferMarkerAfterClear = await physicalFileLogger.logTransfer({
      filename: "keep_after_access_clear.bin",
      username: "admin",
      direction: "CLIENT_TO_SERVER",
      outcome: "SUCCESSO",
      details: "Deve restare dopo clear access",
    });

    await evalJs(`document.getElementById('btn-clear-access-logs').click()`);
    await waitFor(`Boolean(document.getElementById('clear-logs-modal'))`, 5000, "modale conferma svuotamento accessi");
    const accessConfirmText = await evalJs(`document.getElementById('clear-logs-modal')?.innerText || ''`);
    assert.ok(accessConfirmText.includes("Log accessi"), `La finestra di conferma deve indicare Log accessi: ${accessConfirmText}`);
    await evalJs(`document.getElementById('btn-confirm-clear-logs').click()`);
    await waitFor(
      `!document.getElementById('clear-logs-modal') && (document.querySelector('#table-access-logs tbody')?.innerText || '').includes('Nessun log disponibile')`,
      10000,
      "stato vuoto 'Nessun log disponibile' dopo eliminazione log accessi"
    );
    assert.strictEqual(fs.readFileSync(physicalFileLogger.getAccessLogFilePath(), "utf-8"), "", "access.log deve essere vuoto su disco");
    assert.ok(
      fs.readFileSync(physicalFileLogger.getTransferLogFilePath(), "utf-8").includes(transferMarkerAfterClear),
      "Lo svuotamento di access.log non deve modificare transfers.log"
    );

    // Verifica che i download continuino a rispondere 200 anche con registro vuoto
    const dlAccessRes = await fetch(`${baseUrl}/api/logs/download/access`, { headers: authHeaders });
    const dlTransferRes = await fetch(`${baseUrl}/api/logs/download/transfers`, { headers: authHeaders });
    assert.strictEqual(dlAccessRes.status, 200);
    assert.strictEqual(dlTransferRes.status, 200);

    // Verifica ZERO errori JS / eccezioni non gestite in console Chrome
    assert.strictEqual(pageErrors.length, 0, `Rilevate eccezioni JS in pagina: ${pageErrors.join(" | ")}`);
    assert.strictEqual(
      consoleErrors.filter((e) => !e.includes("Failed to load resource")).length,
      0,
      `Rilevati errori console JS: ${consoleErrors.join(" | ")}`
    );

    ws.close();
    console.log("✔ TUTTI I 14 SCENARI + REGRESSIONE BATCH + ELIMINAZIONE LOG + CHROME E2E SUPERATI CON SUCCESSO!");
  } finally {
    const chrome = chromeProc;
    try {
      if (chrome && chrome.exitCode === null && chrome.signalCode === null) {
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error("Chrome non ha terminato il teardown.")), 5_000);
          chrome.once("exit", () => {
            clearTimeout(timeout);
            resolve();
          });
          chrome.kill("SIGTERM");
        });
      }
    } finally {
      await app.close().catch(() => {});
      sftp1.server.close();
      sftp2.server.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
      await fs.promises.rm(chromeUserDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }
}

runTests().catch((err) => {
  console.error("✘ TEST E2E FALLITO:", err);
  process.exit(1);
});
