// Test E2E browser reale (Chrome Headless via CDP) per il Caricamento Massivo Multi-Target.
// Verifica TUTTI i flussi del wizard BulkUploadModal:
// 1. Computer -> Directory Server Associate ai Robot (con default /upload)
// 2. Computer -> Robot Remoti SFTP (3 file con maxConcurrentTransfersPerRobot=2 -> verifica zero leak connessioni SSH)
// 3. Computer -> Multi-target combinato (Robot Remoto + Server Robot + Archivio Generale Server)
// 4. Rilevamento conflitti -> BulkConflictsModal -> Sovrascrivi Confermati
// 5. Sorgente Archivio Generale Server e Archivio Server Robot con navigazione sottocartelle al Passo 1
// 6. Sorgente Robot Remoto (Robot -> Robot) con navigazione sottocartelle al Passo 1
// 7. FolderPickerModal al Passo 4 con fallback sicuro se initialPath non esiste

import assert from "node:assert";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { execSync, spawn } from "node:child_process";
import ssh2 from "ssh2";
import { type SystemConfiguration } from "../../config/configuration.ts";
import { MolirisLogger } from "../../logging/logger.ts";
import { InMemoryCredentialProvider } from "../../backend/connection/credential-provider.ts";
import { DefaultHostKeyVerifier, computeHostKeyFingerprint } from "../../backend/connection/host-key-verifier.ts";
import { RobotConnectionManager } from "../../backend/connection/robot-connection-manager.ts";
import { InMemoryRobotRepository } from "../../storage/robot-repository.ts";
import { InMemoryAuditRepository } from "../../storage/audit-repository.ts";
import { InMemoryUserRepository } from "../../backend/auth/user-repository.ts";
import { SessionManager } from "../../backend/auth/session-manager.ts";
import { ServerFilesystemService } from "../../storage/server-fs.ts";
import { type RobotEntity } from "../../storage/robot-models.ts";
import { hashPassword } from "../../backend/auth/user-models.ts";
import { createServer } from "../../backend/server.ts";
import { PhysicalFileLogger } from "../../backend/logging/physical-file-logger.ts";
import { loadConfig } from "../../src/config/index.ts";

console.log("--> Avvio test E2E Browser Chrome per Caricamento Massivo...");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "moliris-bulk-e2e-"));
const serverFsRoot = path.join(tmpDir, "server-fs");
const generalFsRoot = path.join(serverFsRoot, "general");
const chromeUserDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "moliris-bulk-chrome-"));
const certPath = path.join(tmpDir, "cert.pem");
const keyPath = path.join(tmpDir, "key.pem");
fs.mkdirSync(generalFsRoot, { recursive: true });
process.env.MOLIRIS_GENERAL_FS_ROOT = generalFsRoot;

execSync(
  `openssl req -x509 -newkey rsa:2048 -keyout "${keyPath}" -out "${certPath}" -days 1 -nodes -subj "/CN=127.0.0.1"`,
  { stdio: "pipe" }
);

// Mock SFTP server con filesystem realistico (/home/robot come home, /upload NON esistente su robot2 ma /home/robot sì!)
const serverHostKey = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "pkcs1", format: "pem" },
});
const parsedKey = (ssh2 as any).utils.parseKey(serverHostKey.privateKey);
const serverFingerprint = computeHostKeyFingerprint(parsedKey.getPublicSSH());

const mockRemoteFs: Record<string, Buffer> = {
  "/": Buffer.from("DIR"),
  "/home": Buffer.from("DIR"),
  "/home/robot": Buffer.from("DIR"),
  "/home/robot/remote_folder": Buffer.from("DIR"),
  "/home/robot/remote_folder/from_robot.txt": Buffer.from("Contenuto remoto dal robot"),
  "/upload": Buffer.from("DIR"),
};

let nextHandleId = 1;
const openHandles = new Map<string, { path: string; isDir: boolean; readSent?: boolean }>();

const sftpServer = new ssh2.Server({ hostKeys: [serverHostKey.privateKey] }, (client) => {
  client.on("authentication", (ctx) => ctx.accept());
  client.on("ready", () => {
    client.on("session", (accept) => {
      const session = accept();
      session.on("sftp", (acceptSftp) => {
        const sftp = acceptSftp();
        sftp.on("REALPATH", (reqid: number, p: string) => {
          const resolved = !p || p === "." ? "/home/robot" : path.posix.normalize(p);
          sftp.name(reqid, [{ filename: resolved }] as any);
        });
        sftp.on("STAT", (reqid: number, p: string) => {
          const norm = path.posix.normalize(p);
          if (mockRemoteFs[norm] !== undefined) {
            const isDir = mockRemoteFs[norm].toString() === "DIR";
            return sftp.attrs(reqid, {
              mode: isDir ? 0o040755 : 0o100644,
              size: isDir ? 4096 : mockRemoteFs[norm].length,
              mtime: Math.floor(Date.now() / 1000),
              atime: Math.floor(Date.now() / 1000),
            } as any);
          }
          return sftp.status(reqid, 2);
        });
        sftp.on("LSTAT", (reqid: number, p: string) => {
          const norm = path.posix.normalize(p);
          if (mockRemoteFs[norm] !== undefined) {
            const isDir = mockRemoteFs[norm].toString() === "DIR";
            return sftp.attrs(reqid, {
              mode: isDir ? 0o040755 : 0o100644,
              size: isDir ? 4096 : mockRemoteFs[norm].length,
              mtime: Math.floor(Date.now() / 1000),
              atime: Math.floor(Date.now() / 1000),
            } as any);
          }
          return sftp.status(reqid, 2);
        });
        sftp.on("OPENDIR", (reqid: number, dirPath: string) => {
          const norm = path.posix.normalize(dirPath);
          if (mockRemoteFs[norm]?.toString() !== "DIR") {
            return sftp.status(reqid, 2);
          }
          const handle = Buffer.from(`dir_${nextHandleId++}`);
          openHandles.set(handle.toString(), { path: norm, isDir: true, readSent: false });
          sftp.handle(reqid, handle);
        });
        sftp.on("READDIR", (reqid: number, handle: Buffer) => {
          const h = openHandles.get(handle.toString());
          if (!h || h.readSent) return sftp.status(reqid, 1);
          h.readSent = true;
          const entries: Array<{ filename: string; attrs: any }> = [];
          const prefix = h.path === "/" ? "/" : `${h.path}/`;
          for (const key of Object.keys(mockRemoteFs)) {
            if (key !== h.path && key.startsWith(prefix)) {
              const sub = key.slice(prefix.length);
              if (sub && !sub.includes("/")) {
                const isDir = mockRemoteFs[key].toString() === "DIR";
                entries.push({
                  filename: sub,
                  attrs: {
                    mode: isDir ? 0o040755 : 0o100644,
                    size: isDir ? 4096 : mockRemoteFs[key].length,
                    mtime: Math.floor(Date.now() / 1000),
                  },
                });
              }
            }
          }
          sftp.name(reqid, entries as any);
        });
        sftp.on("OPEN", (reqid: number, filename: string) => {
          const norm = path.posix.normalize(filename);
          const parent = path.posix.dirname(norm);
          if (mockRemoteFs[parent]?.toString() !== "DIR") {
            return sftp.status(reqid, 2);
          }
          const handle = Buffer.from(`file_${nextHandleId++}`);
          openHandles.set(handle.toString(), { path: norm, isDir: false });
          if (!mockRemoteFs[norm]) mockRemoteFs[norm] = Buffer.alloc(0);
          sftp.handle(reqid, handle);
        });
        sftp.on("READ", (reqid: number, handle: Buffer, offset: number, length: number) => {
          const h = openHandles.get(handle.toString());
          if (!h || !mockRemoteFs[h.path]) return sftp.status(reqid, 4);
          const buf = mockRemoteFs[h.path];
          if (offset >= buf.length) return sftp.status(reqid, 1);
          sftp.data(reqid, buf.subarray(offset, offset + length));
        });
        sftp.on("WRITE", (reqid: number, handle: Buffer, offset: number, data: Buffer) => {
          const h = openHandles.get(handle.toString());
          if (!h) return sftp.status(reqid, 4);
          const cur = mockRemoteFs[h.path] || Buffer.alloc(0);
          const needed = offset + data.length;
          let nextBuf = cur;
          if (cur.length < needed) {
            nextBuf = Buffer.alloc(needed);
            cur.copy(nextBuf, 0, 0, cur.length);
          }
          data.copy(nextBuf, offset);
          mockRemoteFs[h.path] = nextBuf;
          sftp.status(reqid, 0);
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
          delete mockRemoteFs[path.posix.normalize(p)];
          sftp.status(reqid, 0);
        });
      });
    });
  });
});

await new Promise<void>((resolve) => sftpServer.listen(0, "127.0.0.1", () => resolve()));
const sshPort = (sftpServer.address() as net.AddressInfo).port;

const logger = new MolirisLogger();
const testConfig: SystemConfiguration = {
  credentialProviderType: "in-memory",
  serverFilesystemRoot: serverFsRoot,
  pollingIntervalSeconds: 60,
  sshConnectionTimeoutMs: 3000,
  maxConcurrentTransfersPerUser: 3,
  maxConcurrentTransfersPerRobot: 2, // realistico come in .env!
  maxConcurrentTransfersServer: 10,
  tempFileRetentionMinutes: 60,
  stateFilePaths: ["/etc/moliris-state.json"],
  inactiveSessionTimeoutMinutes: 30,
  tlsCertPath: certPath,
  tlsKeyPath: keyPath,
  registrationMode: "rigorosa",
  auditLogRetentionDays: 30,
  defaultSshPort: sshPort,
  allowedDestinations: ["127.0.0.1"],
  robotNonAtomicReplace: true,
};

const robotRepo = new InMemoryRobotRepository();
const auditRepo = new InMemoryAuditRepository();
const userRepo = new InMemoryUserRepository();
const sessionManager = new SessionManager(30);
const credentialProvider = new InMemoryCredentialProvider(["password"]);
credentialProvider.registerSecret("vault://creds/robot-bulk-1", { method: "password", password: "pw" });
credentialProvider.registerSecret("vault://creds/robot-bulk-2", { method: "password", password: "pw" });

const hostKeyVerifier = new DefaultHostKeyVerifier();
const connectionManager = new RobotConnectionManager(
  credentialProvider,
  hostKeyVerifier,
  {
    maxConcurrentPerUser: 3,
    maxConcurrentPerRobot: 2,
    maxConcurrentServer: 10,
    connectionTimeoutMs: 3000,
  },
  logger,
  auditRepo
);
const serverFsService = new ServerFilesystemService(serverFsRoot, auditRepo, logger);

const adminHash = await hashPassword("AdminPassword123!");
await userRepo.create({
  id: "u-admin",
  username: "admin",
  passwordHash: adminHash,
  roles: ["admin"],
  enabled: true,
  createdAt: new Date(),
  updatedAt: new Date(),
});

const robot1: RobotEntity = {
  id: "robot-bulk-1",
  displayName: "Robot Bulk Uno",
  remoteUsername: "robot",
  host: "127.0.0.1",
  sshPort,
  sshAuthMethod: "password",
  credentialReference: "vault://creds/robot-bulk-1",
  hostKeyVerification: { fingerprint: serverFingerprint.sha256Hex, strictHostKeyChecking: true },
  serverDirectoryPath: path.join(serverFsRoot, "robot_robot-bulk-1"),
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
  id: "robot-bulk-2",
  displayName: "Robot Bulk Due",
  remoteUsername: "robot2",
  credentialReference: "vault://creds/robot-bulk-2",
  serverDirectoryPath: path.join(serverFsRoot, "robot_robot-bulk-2"),
};

await robotRepo.create(robot1);
await robotRepo.create(robot2);
await serverFsService.ensureRobotDirectory(robot1);
await serverFsService.ensureRobotDirectory(robot2);

// File sorgenti di test nelle sottocartelle server (per verificare la navigazione al Passo 1)
fs.mkdirSync(path.join(generalFsRoot, "packages"), { recursive: true });
fs.writeFileSync(path.join(generalFsRoot, "packages", "general_pkg.txt"), "Dati da archivio generale");
fs.writeFileSync(path.join(robot1.serverDirectoryPath, "logs", "robot_srv.log"), "Log da server robot 1");

const physicalFileLogger = new PhysicalFileLogger(path.join(tmpDir, "logs"));
const server = createServer(testConfig, logger, {
  physicalFileLogger,
  robotRepository: robotRepo,
  auditRepository: auditRepo,
  userRepository: userRepo,
  sessionManager,
  credentialProvider,
  hostKeyVerifier,
  connectionManager,
  serverFsService,
  appConfig: loadConfig({
    overrides: {
      futureExtensions: { maxSessionsPerAccount: 1, maxFleetRobots: 100, customSettings: {} },
    },
  }),
});

await server.listen({ port: 0, host: "127.0.0.1" });
const serverPort = (server.server.address() as net.AddressInfo).port;
const baseUrl = `https://127.0.0.1:${serverPort}`;

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const p = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(p));
    });
    srv.on("error", reject);
  });
}

const cdpPort = await findFreePort();
const chromePath = fs.existsSync("/usr/bin/google-chrome")
  ? "/usr/bin/google-chrome"
  : "/usr/bin/chromium-browser";

const chromeProcess = spawn(
  chromePath,
  [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--ignore-certificate-errors",
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${chromeUserDataDir}`,
    "about:blank",
  ],
  { detached: true, stdio: "ignore" }
);

let wsDebuggerUrl = "";
for (let i = 0; i < 40; i++) {
  try {
    const res = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
    const list = (await res.json()) as any[];
    const target = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
    if (target) {
      wsDebuggerUrl = target.webSocketDebuggerUrl;
      break;
    }
  } catch {}
  await new Promise((r) => setTimeout(r, 150));
}
assert.ok(wsDebuggerUrl, "Chrome CDP deve essere raggiungibile");

const cdpWs = new WebSocket(wsDebuggerUrl);
await new Promise<void>((resolve, reject) => {
  const t = setTimeout(() => reject(new Error("Timeout CDP")), 5000);
  cdpWs.onopen = () => { clearTimeout(t); resolve(); };
  cdpWs.onerror = (e) => { clearTimeout(t); reject(e); };
});

let msgId = 1;
const pending = new Map<number, (r: any) => void>();
const jsErrors: string[] = [];

cdpWs.onmessage = (ev) => {
  try {
    const data = JSON.parse(ev.data as string);
    if (data.method === "Runtime.exceptionThrown") {
      jsErrors.push(data.params.exceptionDetails.exception?.description || data.params.exceptionDetails.text);
    }
    if (data.id && pending.has(data.id)) {
      const cb = pending.get(data.id)!;
      pending.delete(data.id);
      cb(data);
    }
  } catch {}
};

function cdp(method: string, params: any = {}): Promise<any> {
  const id = msgId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timeout CDP ${method}`));
    }, 10000);
    pending.set(id, (reply) => {
      clearTimeout(timer);
      if (reply.error) reject(new Error(`${method}: ${reply.error.message}`));
      else resolve(reply.result);
    });
    cdpWs.send(JSON.stringify({ id, method, params }));
  });
}

async function evalJs<T = any>(expression: string): Promise<T> {
  const res = await cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (res.exceptionDetails) {
    throw new Error(`Browser eval error: ${JSON.stringify(res.exceptionDetails)}`);
  }
  return res.result?.value as T;
}

async function waitFor(expr: string, timeoutMs = 8000, label = expr): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await evalJs<boolean>(`Boolean(${expr})`)) return;
    await new Promise((r) => setTimeout(r, 60));
  }
  const modalErr = await evalJs<string>("document.querySelector('#modal-bulk-upload .alert-danger')?.textContent?.trim() || ''");
  throw new Error(`Timeout attesa: ${label}${modalErr ? ` | Errore visibile nel modale: ${modalErr}` : ""}`);
}

async function setFileInput(selector: string, filePaths: string[]): Promise<void> {
  const { root } = await cdp("DOM.getDocument");
  const { nodeId } = await cdp("DOM.querySelector", { nodeId: root.nodeId, selector });
  assert.ok(nodeId, `Input file '${selector}' non trovato nel DOM`);
  await cdp("DOM.setFileInputFiles", { nodeId, files: filePaths });
}

try {
  await cdp("Page.enable");
  await cdp("Runtime.enable");
  await cdp("DOM.enable");
  await cdp("Page.navigate", { url: baseUrl });
  await waitFor("document.querySelector('#username')", 10000, "login form");

  // Login
  await evalJs(`(() => {
    const u = document.querySelector('#username');
    const p = document.querySelector('#password');
    const setVal = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setVal.call(u, 'admin'); u.dispatchEvent(new Event('input', { bubbles: true }));
    setVal.call(p, 'AdminPassword123!'); p.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#btn-login').click();
  })()`);
  await waitFor("document.querySelector('#dashboard-section')", 10000, "dashboard");

  // Vai alla vista Gestione file/trasferimenti
  await evalJs(`(() => {
    const btn = Array.from(document.querySelectorAll('nav button, header button')).find(b => /Gestione file/i.test(b.textContent || ''));
    btn?.click();
  })()`);
  await waitFor("document.querySelector('#btn-bulk-upload-open')", 5000, "pulsante Caricamento Massivo");

  // Prepara 3 file locali temporanei
  const localFile1 = path.join(tmpDir, "bulk_one.txt");
  const localFile2 = path.join(tmpDir, "bulk_two.txt");
  const localFile3 = path.join(tmpDir, "bulk_three.txt");
  fs.writeFileSync(localFile1, "CONTENUTO_FILE_1");
  fs.writeFileSync(localFile2, "CONTENUTO_FILE_2");
  fs.writeFileSync(localFile3, "CONTENUTO_FILE_3");

  // =========================================================================
  // TEST 1: Computer -> Directory Server Associate ai Robot (default /upload)
  // =========================================================================
  await evalJs("document.querySelector('#btn-bulk-upload-open').click()");
  await waitFor("document.querySelector('#modal-bulk-upload')");
  await setFileInput("#bulk-files-input", [localFile1, localFile2]);
  await waitFor("!document.querySelector('#btn-bulk-next').disabled");
  await evalJs("document.querySelector('#btn-bulk-next').click()"); // -> Step 2
  // Deseleziona Robot Remoti, seleziona Directory Server Associate ai Robot
  await evalJs(`(() => {
    const labels = Array.from(document.querySelectorAll('#modal-bulk-upload .list-group-item'));
    const remoteLbl = labels.find(l => l.textContent.includes('Robot Remoti'));
    const srvLbl = labels.find(l => l.textContent.includes('Directory Server Associate'));
    remoteLbl.querySelector('input').click();
    srvLbl.querySelector('input').click();
  })()`);
  await evalJs("document.querySelector('#btn-bulk-next').click()"); // -> Step 3
  await evalJs(`(() => {
    const btn = Array.from(document.querySelectorAll('#modal-bulk-upload button')).find(b => b.textContent.trim() === 'Seleziona tutti');
    btn.click();
  })()`);
  await evalJs("document.querySelector('#btn-bulk-next').click()"); // -> Step 4 (default /upload!)
  await evalJs("document.querySelector('#btn-bulk-next').click()"); // -> Step 5
  await evalJs("document.querySelector('#btn-start-bulk-upload').click()");

  await waitFor(
    "document.querySelectorAll('#modal-bulk-upload .badge.bg-success').length >= 4",
    8000,
    "Test 1: 4 trasferimenti riusciti verso Directory Server Robot (2 file x 2 robot)"
  );
  assert.strictEqual(
    fs.readFileSync(path.join(robot1.serverDirectoryPath, "upload", "bulk_one.txt"), "utf8"),
    "CONTENUTO_FILE_1"
  );
  assert.strictEqual(
    fs.readFileSync(path.join(robot2.serverDirectoryPath, "upload", "bulk_two.txt"), "utf8"),
    "CONTENUTO_FILE_2"
  );
  await evalJs("document.querySelector('#btn-close-bulk-upload').click()");
  await waitFor("!document.querySelector('#modal-bulk-upload')");
  console.log("  PASS Browser 1: Computer -> Directory Server Robot (default /upload).");

  // =========================================================================
  // TEST 2: Computer -> Robot Remoti SFTP con 3 file e maxConcurrentPerRobot=2 (zero leak SSH!)
  // =========================================================================
  await evalJs("document.querySelector('#btn-bulk-upload-open').click()");
  await waitFor("document.querySelector('#modal-bulk-upload')");
  await setFileInput("#bulk-files-input", [localFile1, localFile2, localFile3]);
  await waitFor("!document.querySelector('#btn-bulk-next').disabled");
  await evalJs("document.querySelector('#btn-bulk-next').click()"); // -> Step 2 (default remote_robots)
  await evalJs("document.querySelector('#btn-bulk-next').click()"); // -> Step 3
  await evalJs(`(() => {
    const chk = document.querySelector('#modal-bulk-upload input[type="checkbox"]');
    chk.click();
  })()`);
  await evalJs("document.querySelector('#btn-bulk-next').click()"); // -> Step 4
  await evalJs("document.querySelector('#btn-bulk-next').click()"); // -> Step 5
  await evalJs("document.querySelector('#btn-start-bulk-upload').click()");

  await waitFor(
    "document.querySelectorAll('#modal-bulk-upload .badge.bg-success').length >= 3",
    8000,
    "Test 2: 3 file SFTP verso robot con limite 2 connessioni/robot"
  );
  assert.strictEqual(mockRemoteFs["/upload/bulk_one.txt"]?.toString("utf8"), "CONTENUTO_FILE_1");
  assert.strictEqual(mockRemoteFs["/upload/bulk_two.txt"]?.toString("utf8"), "CONTENUTO_FILE_2");
  assert.strictEqual(mockRemoteFs["/upload/bulk_three.txt"]?.toString("utf8"), "CONTENUTO_FILE_3");
  assert.strictEqual(
    connectionManager.getActiveConnectionCount(),
    0,
    "Nessuna connessione SSH deve restare aperta/leaked dopo il caricamento massivo"
  );
  await evalJs("document.querySelector('#btn-close-bulk-upload').click()");
  await waitFor("!document.querySelector('#modal-bulk-upload')");
  console.log("  PASS Browser 2: Computer -> Robot Remoti SFTP (3 file, zero leak connessioni SSH).");

  // =========================================================================
  // TEST 3: Conflitto -> BulkConflictsModal -> Sovrascrivi Confermati
  // =========================================================================
  fs.writeFileSync(localFile1, "CONTENUTO_FILE_1_AGGIORNATO");
  await evalJs("document.querySelector('#btn-bulk-upload-open').click()");
  await waitFor("document.querySelector('#modal-bulk-upload')");
  await setFileInput("#bulk-files-input", [localFile1]);
  await waitFor("!document.querySelector('#btn-bulk-next').disabled");
  await evalJs("document.querySelector('#btn-bulk-next').click()"); // -> Step 2
  await evalJs("document.querySelector('#btn-bulk-next').click()"); // -> Step 3
  await evalJs("document.querySelector('#modal-bulk-upload input[type=\"checkbox\"]').click()");
  await evalJs("document.querySelector('#btn-bulk-next').click()"); // -> Step 4
  await evalJs("document.querySelector('#btn-bulk-next').click()"); // -> Step 5
  await evalJs("document.querySelector('#btn-start-bulk-upload').click()");

  await waitFor("document.querySelector('#modal-bulk-conflicts')", 8000, "BulkConflictsModal aperto");
  await evalJs("document.querySelector('#btn-bulk-confirm-overwrite').click()");
  await waitFor("!document.querySelector('#modal-bulk-conflicts') && !document.querySelector('#modal-bulk-upload')", 8000, "chiusura dopo overwrite");
  assert.strictEqual(
    mockRemoteFs["/upload/bulk_one.txt"]?.toString("utf8"),
    "CONTENUTO_FILE_1_AGGIORNATO",
    "Il file sul robot deve essere sovrascritto atomicamente dopo conferma conflitti"
  );
  console.log("  PASS Browser 3: Conflitto -> BulkConflictsModal -> Sovrascrittura confermata.");

  // =========================================================================
  // TEST 4: Sorgente Archivio Generale Server (navigazione sottocartella /packages al Passo 1) -> Server Robot
  // =========================================================================
  await evalJs("document.querySelector('#btn-bulk-upload-open').click()");
  await waitFor("document.querySelector('#modal-bulk-upload')");
  await evalJs(`(() => {
    const btn = Array.from(document.querySelectorAll('#modal-bulk-upload button')).find(b => b.textContent.trim() === 'Archivio Generale Server');
    btn.click();
  })()`);
  await waitFor(
    "Array.from(document.querySelectorAll('#modal-bulk-upload button')).some(b => b.textContent.includes('packages'))",
    6000,
    "cartella 'packages' navigabile al Passo 1"
  );
  await evalJs(`(() => {
    const dirBtn = Array.from(document.querySelectorAll('#modal-bulk-upload button')).find(b => b.textContent.includes('packages'));
    dirBtn.click();
  })()`);
  await waitFor(
    "Array.from(document.querySelectorAll('#modal-bulk-upload label')).some(l => l.textContent.includes('general_pkg.txt'))",
    6000,
    "file 'general_pkg.txt' visibile dentro /packages"
  );
  await evalJs(`(() => {
    const lbl = Array.from(document.querySelectorAll('#modal-bulk-upload label')).find(l => l.textContent.includes('general_pkg.txt'));
    lbl.querySelector('input').click();
  })()`);
  await evalJs("document.querySelector('#btn-bulk-next').click()"); // -> Step 2
  await evalJs(`(() => {
    const labels = Array.from(document.querySelectorAll('#modal-bulk-upload .list-group-item'));
    labels.find(l => l.textContent.includes('Robot Remoti')).querySelector('input').click();
    labels.find(l => l.textContent.includes('Directory Server Associate')).querySelector('input').click();
  })()`);
  await evalJs("document.querySelector('#btn-bulk-next').click()"); // -> Step 3
  await evalJs("document.querySelector('#modal-bulk-upload input[type=\"checkbox\"]').click()");
  await evalJs("document.querySelector('#btn-bulk-next').click()"); // -> Step 4
  await evalJs("document.querySelector('#btn-bulk-next').click()"); // -> Step 5
  await evalJs("document.querySelector('#btn-start-bulk-upload').click()");

  await waitFor(
    "document.querySelectorAll('#modal-bulk-upload .badge.bg-success').length >= 1",
    8000,
    "Test 4: trasferimento da Archivio Generale Server -> Server Robot"
  );
  assert.strictEqual(
    fs.readFileSync(path.join(robot1.serverDirectoryPath, "upload", "general_pkg.txt"), "utf8"),
    "Dati da archivio generale"
  );
  await evalJs("document.querySelector('#btn-close-bulk-upload').click()");
  await waitFor("!document.querySelector('#modal-bulk-upload')");
  console.log("  PASS Browser 4: Sorgente Archivio Generale Server con navigazione cartelle -> Server Robot.");

  // =========================================================================
  // TEST 5: Sorgente Robot Remoto (navigazione in /home/robot/remote_folder al Passo 1) -> Robot Remoto 2
  // =========================================================================
  await evalJs("document.querySelector('#btn-bulk-upload-open').click()");
  await waitFor("document.querySelector('#modal-bulk-upload')");
  await evalJs(`(() => {
    const btn = Array.from(document.querySelectorAll('#modal-bulk-upload button')).find(b => b.textContent.includes('Robot Remoto'));
    btn.click();
  })()`);
  await waitFor(
    "Array.from(document.querySelectorAll('#modal-bulk-upload button')).some(b => b.textContent.includes('remote_folder'))",
    6000,
    "cartella 'remote_folder' visibile nella home del robot remoto"
  );
  await evalJs(`(() => {
    const dirBtn = Array.from(document.querySelectorAll('#modal-bulk-upload button')).find(b => b.textContent.includes('remote_folder'));
    dirBtn.click();
  })()`);
  await waitFor(
    "Array.from(document.querySelectorAll('#modal-bulk-upload label')).some(l => l.textContent.includes('from_robot.txt'))",
    6000,
    "file 'from_robot.txt' visibile in remote_folder"
  );
  await evalJs(`(() => {
    const lbl = Array.from(document.querySelectorAll('#modal-bulk-upload label')).find(l => l.textContent.includes('from_robot.txt'));
    lbl.querySelector('input').click();
  })()`);
  await evalJs("document.querySelector('#btn-bulk-next').click()"); // -> Step 2
  await evalJs("document.querySelector('#btn-bulk-next').click()"); // -> Step 3
  await evalJs(`(() => {
    const checks = document.querySelectorAll('#modal-bulk-upload input[type="checkbox"]');
    checks[1].click(); // robot-bulk-2
  })()`);
  await evalJs("document.querySelector('#btn-bulk-next').click()"); // -> Step 4
  await evalJs("document.querySelector('#btn-bulk-next').click()"); // -> Step 5
  await evalJs("document.querySelector('#btn-start-bulk-upload').click()");

  await waitFor(
    "document.querySelector('#modal-bulk-upload')?.textContent?.includes('Completato con successo')",
    8000,
    "Test 5: Robot -> Robot completato con successo"
  );
  assert.strictEqual(mockRemoteFs["/upload/from_robot.txt"]?.toString("utf8"), "Contenuto remoto dal robot");
  console.log("  PASS Browser 5: Sorgente Robot Remoto (navigazione cartelle) -> Robot Remoto.");

  assert.strictEqual(jsErrors.length, 0, `Nessuna eccezione JS nel browser attesa, trovate: ${jsErrors.join("; ")}`);
  console.log("PASS: Tutti i 5 test E2E Browser Chrome sul Caricamento Massivo completati con successo!");
} finally {
  cdpWs.close();
  try {
    if (chromeProcess.pid) process.kill(-chromeProcess.pid, "SIGKILL");
  } catch {
    try { chromeProcess.kill("SIGKILL"); } catch {}
  }
  await server.close();
  await new Promise<void>((resolve) => sftpServer.close(() => resolve()));
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(chromeUserDataDir, { recursive: true, force: true });
}
