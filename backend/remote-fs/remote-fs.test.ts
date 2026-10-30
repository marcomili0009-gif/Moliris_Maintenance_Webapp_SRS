// Requisiti verificati: RF-FS-001, RF-FS-002, RF-FS-003, RF-FS-004, RF-FS-005, RF-FS-006, RF-FS-007,
// RNF-SEC-002, RNF-SEC-004, RNF-SEC-005, RNF-SEC-006, RNF-SEC-009, RNF-PERF-001, RNF-PERF-002, RNF-PERF-003,
// RNF-REL-001, RNF-REL-005, SRS §1.2, §5.5, §9, §10.3, §10.4, §11.5, §11.6, §11.7, CA-FS-001, CA-AUTH-003

import assert from "assert";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
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
import { AuthMiddleware } from "../auth/auth-middleware.ts";
import { AppPermission, DEFAULT_ROLE_PERMISSIONS } from "../auth/permissions.ts";
import { type UserEntity } from "../auth/user-models.ts";
import { type RobotEntity } from "../../storage/robot-models.ts";
import { RemoteFilesystemService } from "./remote-fs-service.ts";
import { createServer } from "../server.ts";
import { ErrorCode } from "../../errors/app-errors.ts";

console.log("--> Esecuzione test suite Navigazione Filesystem Remoto Robot (CA-FS-001, RF-FS-001..007)...");

// 1. Setup certificati TLS temporanei per createServer HTTPS
const tmpTlsDir = fs.mkdtempSync(path.join(os.tmpdir(), "moliris-remotefs-test-"));
const certPath = path.join(tmpTlsDir, "test-cert.pem");
const keyPath = path.join(tmpTlsDir, "test-key.pem");

execSync(`openssl req -x509 -newkey rsa:2048 -keyout "${keyPath}" -out "${certPath}" -days 1 -nodes -subj "/CN=localhost"`, {
  stdio: "pipe",
});

// 2. Setup server SSH/SFTP di test con fixture in memoria
const serverHostKey = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "pkcs1", format: "pem" },
});
const parsedKey = (ssh2 as any).utils.parseKey(serverHostKey.privateKey);
const serverHostKeyWireBuffer = parsedKey.getPublicSSH();
const serverFingerprintInfo = computeHostKeyFingerprint(serverHostKeyWireBuffer);

const mutationAttempts: string[] = [];
const activeSshClients = new Set<any>();

// Struttura di directory e file di fixture sul server SFTP
interface MockFileNode {
  type: "file" | "directory" | "link" | "special";
  size?: number;
  mtime?: number;
  content?: string;
  forbidden?: boolean;
}

const mockFilesystem: Record<string, Record<string, MockFileNode>> = {
  "/home/operator": {
    "file1.txt": { type: "file", size: 1024, mtime: 1700000000, content: "Contenuto file1" },
    "file2.log": { type: "file", size: 2048, mtime: 1700001000, content: "Log di manutenzione robot" },
    "subfolder": { type: "directory" },
    "empty_dir": { type: "directory" },
    "symlink_to_file": { type: "link", size: 14, mtime: 1700001500 },
    "special_device": { type: "special", size: 0, mtime: 1700001600 },
    "file_no_date": { type: "file", size: 512, mtime: 0, content: "Dati senza data" },
    "forbidden_dir": { type: "directory", forbidden: true },
  },
  "/home/operator/subfolder": {
    "subfile.txt": { type: "file", size: 256, mtime: 1700002000, content: "Sottofile di configurazione" },
    "nested_dir": { type: "directory" },
  },
  "/home/operator/empty_dir": {},
  "/home/operator/subfolder/nested_dir": {
    "deep_file.conf": { type: "file", size: 64, mtime: 1700003000, content: "deep" },
  },
};

let nextHandleId = 1;
const openHandles: Map<string, { path: string; isDir: boolean; readSent?: boolean; content?: string }> = new Map();

const testSshServer = new ssh2.Server({ hostKeys: [serverHostKey.privateKey] }, (client) => {
  activeSshClients.add(client);
  client.on("close", () => activeSshClients.delete(client));
  client.on("error", () => {});

  client.on("authentication", (ctx) => {
    if (ctx.method === "password" && ctx.password === "ValidRobotPass123!") {
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

        sftp.on("REALPATH", (reqid: number, p: string) => {
          if (!p || p === "." || p === "") {
            sftp.name(reqid, [{ filename:   "/home/operator" }] as any);
          } else {
            sftp.name(reqid, [{ filename:   path.posix.normalize(p) }] as any);
          }
        });

        sftp.on("OPENDIR", (reqid: number, dirPath: string) => {
          const norm = path.posix.normalize(dirPath);
          if (norm.includes("forbidden_dir")) {
            return sftp.status(reqid, 3 /* SSH_FX_PERMISSION_DENIED */);
          }
          if (!mockFilesystem[norm]) {
            return sftp.status(reqid, 2 /* SSH_FX_NO_SUCH_FILE */);
          }
          const handle = Buffer.from(`dir_h_${nextHandleId++}`);
          openHandles.set(handle.toString(), { path: norm, isDir: true, readSent: false });
          sftp.handle(reqid, handle);
        });

        sftp.on("READDIR", (reqid: number, handle: Buffer) => {
          const h = openHandles.get(handle.toString());
          if (!h) {
            return sftp.status(reqid, 4 /* SSH_FX_FAILURE */);
          }
          if (h.readSent) {
            return sftp.status(reqid, 1 /* SSH_FX_EOF */);
          }

          h.readSent = true;
          const entries = mockFilesystem[h.path];
          if (!entries) {
            return sftp.status(reqid, 1 /* SSH_FX_EOF */);
          }

          const fileEntries = Object.entries(entries).map(([filename, node]) => {
            let mode = 0o100644;
            if (node.type === "directory") mode = 0o040755;
            else if (node.type === "link") mode = 0o120777;
            else if (node.type === "special") mode = 0o020666;

            return {
              filename,
              longname: `${node.type === "directory" ? "d" : "-"}rwxr-xr-x 1 op op ${node.size || 0} Nov 14 ${filename}`,
              attrs: {
                size: node.size,
                mtime: node.mtime ?? 0,
                atime: node.mtime ?? 0,
                mode,
              } as any as any as any,
            };
          });

          sftp.name(reqid, fileEntries as any);
        });

        sftp.on("STAT", (reqid: number, targetPath: string) => {
          const norm = path.posix.normalize(targetPath);
          if (norm.includes("forbidden")) {
            return sftp.status(reqid, 3 /* PERMISSION_DENIED */);
          }
          if (mockFilesystem[norm]) {
            return sftp.attrs(reqid, {
              mode: 0o040755,
              uid: 1000,
              gid: 1000,
              size: 4096,
              mtime: 1700000000,
              atime: 1700000000,
            });
          }

          const dirName = path.posix.dirname(norm);
          const baseName = path.posix.basename(norm);
          const dir = mockFilesystem[dirName];
          if (dir && dir[baseName]) {
            const node = dir[baseName];
            return sftp.attrs(reqid, {
              mode: node.type === "directory" ? 0o040755 : 0o100644,
              uid: 1000,
              gid: 1000,
              size: node.size || 0,
              mtime: node.mtime ?? 0,
              atime: node.mtime ?? 0,
            });
          }

          sftp.status(reqid, 2 /* NO_SUCH_FILE */);
        });

        sftp.on("LSTAT", (reqid: number, targetPath: string) => {
          const norm = path.posix.normalize(targetPath);
          const dirName = path.posix.dirname(norm);
          const baseName = path.posix.basename(norm);
          const dir = mockFilesystem[dirName];
          if (dir && dir[baseName]) {
            const node = dir[baseName];
            return sftp.attrs(reqid, {
              mode: node.type === "link" ? 0o120777 : (node.type === "directory" ? 0o040755 : 0o100644),
              uid: 1000,
              gid: 1000,
              size: node.size || 0,
              mtime: node.mtime ?? 0,
              atime: node.mtime ?? 0,
            });
          }
          sftp.status(reqid, 2 /* NO_SUCH_FILE */);
        });

        sftp.on("OPEN", (reqid: number, filename: string, flags: number) => {
          const norm = path.posix.normalize(filename);
          const dirName = path.posix.dirname(norm);
          const baseName = path.posix.basename(norm);

          // Verifica se è lettura o scrittura (SFTP: SSH_FXF_READ = 0x01, SSH_FXF_WRITE = 0x02)
          const isWrite = (flags & 0x0002) !== 0;
          if (isWrite) {
            mutationAttempts.push(`WRITE:${norm}`);
            const handle = Buffer.from(`file_w_${nextHandleId++}`);
            openHandles.set(handle.toString(), { path: norm, isDir: false });
            return sftp.handle(reqid, handle);
          }

          const dir = mockFilesystem[dirName];
          if (dir && dir[baseName]) {
            const handle = Buffer.from(`file_r_${nextHandleId++}`);
            openHandles.set(handle.toString(), { path: norm, isDir: false, content: dir[baseName].content || "test data" });
            return sftp.handle(reqid, handle);
          }

          sftp.status(reqid, 2 /* NO_SUCH_FILE */);
        });

        sftp.on("READ", (reqid: number, handle: Buffer, offset: number, len: number) => {
          const h = openHandles.get(handle.toString());
          if (!h || !h.content) {
            return sftp.status(reqid, 1 /* EOF */);
          }
          const buf = Buffer.from(h.content, "utf-8");
          if (offset >= buf.length) {
            return sftp.status(reqid, 1 /* EOF */);
          }
          const chunk = buf.subarray(offset, Math.min(offset + len, buf.length));
          sftp.data(reqid, chunk);
        });

        sftp.on("WRITE", (reqid: number, handle: Buffer, offset: number, data: Buffer) => {
          mutationAttempts.push(`DATA_WRITE:len=${data.length}`);
          sftp.status(reqid, 0 /* OK */);
        });

        sftp.on("CLOSE", (reqid: number, handle: Buffer) => {
          openHandles.delete(handle.toString());
          sftp.status(reqid, 0 /* OK */);
        });

        // Eventuali tentativi di scrittura/cancellazione non previsti
        sftp.on("REMOVE", (reqid: number, p: string) => {
          mutationAttempts.push(`REMOVE:${p}`);
          sftp.status(reqid, 3 /* PERMISSION_DENIED */);
        });
        sftp.on("RMDIR", (reqid: number, p: string) => {
          mutationAttempts.push(`RMDIR:${p}`);
          sftp.status(reqid, 3 /* PERMISSION_DENIED */);
        });
        sftp.on("MKDIR", (reqid: number, p: string) => {
          mutationAttempts.push(`MKDIR:${p}`);
          sftp.status(reqid, 3 /* PERMISSION_DENIED */);
        });
        sftp.on("RENAME", (reqid: number, o: string, n: string) => {
          mutationAttempts.push(`RENAME:${o}->${n}`);
          sftp.status(reqid, 3 /* PERMISSION_DENIED */);
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
  serverFilesystemRoot: "/tmp/moliris-remotefs-test",
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
  terminalSessionTimeoutMinutes: 1,
  maxConcurrentTerminalSessionsServer: 5,
  maxConcurrentTerminalSessionsPerUser: 2,
  maxConcurrentTerminalSessionsPerRobot: 2,
  terminalDisconnectPolicy: "chiudi_immediatamente",
  remoteFsInitialPath: "/home/operator",
  remoteFsOverwritePolicy: "rifiuta",
};

const logger = new MolirisLogger();
const credentialProvider = new InMemoryCredentialProvider(["password"]);
credentialProvider.registerSecret("vault://creds/robot_valid", {
  method: "password",
  password: "ValidRobotPass123!",
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

function createTestRobot(id: string, overrides: Partial<RobotEntity> = {}): RobotEntity {
  return {
    id,
    displayName: `Robot Remote FS ${id}`,
    remoteUsername: "operator",
    host: "127.0.0.1",
    sshPort: overrides.sshPort !== undefined ? overrides.sshPort : testSshPort,
    sshAuthMethod: "password",
    credentialReference: "vault://creds/robot_valid",
    hostKeyVerification: {
      fingerprint: serverFingerprintInfo.sha256Hex,
      strictHostKeyChecking: true,
    },
    stateFilePaths: ["/opt/moliris/status/robot.txt"],
    serverDirectoryPath: `/tmp/moliris-remotefs-test/${id}`,
    anagraphicState: overrides.anagraphicState || "attivo",
    connectionState: overrides.connectionState || "raggiungibile",
    operationalState: null,
    lastValidUpdateAt: null,
    lastAttemptOutcome: null,
    registrationState: overrides.registrationState || "registrazione_completata",
    lastConnectionVerification: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

const userAuthorized: UserEntity = {
  id: "user_op_01",
  username: "operatore_fs",
  roles: ["operatore"],
  enabled: true,
    updatedAt: new Date(),
    passwordHash: "mock_hash",
  createdAt: new Date(),
};

const userNoNavigate: UserEntity = {
  id: "user_ro_01",
  username: "operatore_senza_permesso",
  roles: [],
  permissions: [AppPermission.FLEET_VIEW, AppPermission.STATUS_VIEW],
  enabled: true,
    updatedAt: new Date(),
    passwordHash: "mock_hash",
  createdAt: new Date(),
};

// =========================================================================
// TEST 1: CA-FS-001 - Utente autorizzato elenca e naviga le directory remote
// =========================================================================
{
  const robotRepo = new InMemoryRobotRepository();
  const auditRepo = new InMemoryAuditRepository();
  const sessionManager = new SessionManager(30);

  const remoteFsService = new RemoteFilesystemService(
    testConfig,
    connectionManager,
    auditRepo,
    logger,
    DEFAULT_ROLE_PERMISSIONS
  );

  const robot = createTestRobot("robot_fs_01");
  await robotRepo.create(robot);

  const context = sessionManager.createAuthorizedContext(
    sessionManager.createSession(userAuthorized),
    userAuthorized,
    robot.id,
    DEFAULT_ROLE_PERMISSIONS
  );

  // 1. Lettura percorso iniziale naturale / configurato (/home/operator)
  const listing = await remoteFsService.listDirectory(context, robot);
  assert.strictEqual(listing.robotId, "robot_fs_01");
  assert.strictEqual(listing.currentPath, "/home/operator");
  assert.strictEqual(listing.parentPath, "/home");
  assert.ok(listing.items.length >= 7, "Tutti gli elementi di fixture devono essere elencati");

  // Verifica ordinamento: directory per prime, poi alfabetico
  assert.strictEqual(listing.items[0].type, "directory");
  assert.strictEqual(listing.items[0].name, "empty_dir");
  assert.strictEqual(listing.items[1].type, "directory");
  assert.strictEqual(listing.items[1].name, "forbidden_dir");
  assert.strictEqual(listing.items[2].type, "directory");
  assert.strictEqual(listing.items[2].name, "subfolder");

  // 2. Verifica metadati (RF-FS-002)
  const file1 = listing.items.find((i) => i.name === "file1.txt");
  assert.ok(file1);
  assert.strictEqual(file1.type, "file");
  assert.strictEqual(file1.size, 1024);
  assert.ok(file1.modifiedAt?.startsWith("2023-"), "Data ISO di modifica presente");

  // Verifica dimensione null per directory (RF-FS-002)
  const subfolderItem = listing.items.find((i) => i.name === "subfolder");
  assert.strictEqual(subfolderItem?.size, null, "La dimensione di una directory deve essere null (non applicabile)");

  // Verifica data non disponibile (RF-FS-002: file_no_date)
  const fileNoDate = listing.items.find((i) => i.name === "file_no_date");
  assert.strictEqual(fileNoDate?.modifiedAt, null, "Data assente deve risultare null");

  // Verifica tipi nativi: symlink e special
  const symlinkItem = listing.items.find((i) => i.name === "symlink_to_file");
  assert.strictEqual(symlinkItem?.type, "link");
  const specialItem = listing.items.find((i) => i.name === "special_device");
  assert.strictEqual(specialItem?.type, "special");

  // 3. Navigazione sottodirectory: apertura di subfolder (RF-FS-003, CA-FS-001)
  const subListing = await remoteFsService.listDirectory(context, robot, "/home/operator/subfolder");
  assert.strictEqual(subListing.currentPath, "/home/operator/subfolder");
  assert.strictEqual(subListing.parentPath, "/home/operator");
  assert.strictEqual(subListing.items.length, 2);
  assert.strictEqual(subListing.items[0].name, "nested_dir");
  assert.strictEqual(subListing.items[1].name, "subfile.txt");

  // 4. Ritorno al livello precedente (RF-FS-003): uso di subListing.parentPath
  const backListing = await remoteFsService.listDirectory(context, robot, subListing.parentPath!);
  assert.strictEqual(backListing.currentPath, "/home/operator");

  assert.strictEqual(connectionManager.getActiveConnectionCount(), 0, "Nessuna connessione SSH residua");
  console.log("  PASS: CA-FS-001 - Utente autorizzato elenca e naviga le directory remote del robot.");
}

// =========================================================================
// TEST 2: RF-FS-002, RNF-PERF-002 - Troncamento/limite directory con molti file
// =========================================================================
{
  const auditRepo = new InMemoryAuditRepository();
  const sessionManager = new SessionManager(30);

  const limitedConfig: SystemConfiguration = {
    ...testConfig,
    remoteFsMaxDirectoryEntries: 3, // Limite a 3 elementi per test
  };

  const limitedService = new RemoteFilesystemService(
    limitedConfig,
    connectionManager,
    auditRepo,
    logger,
    DEFAULT_ROLE_PERMISSIONS
  );

  const robot = createTestRobot("robot_fs_limits");
  const context = sessionManager.createAuthorizedContext(
    sessionManager.createSession(userAuthorized),
    userAuthorized,
    robot.id,
    DEFAULT_ROLE_PERMISSIONS
  );

  const listing = await limitedService.listDirectory(context, robot, "/home/operator");
  assert.strictEqual(listing.items.length, 3, "Il numero di elementi deve essere troncato al limite configurato");
  assert.strictEqual(listing.truncated, true, "Il flag truncated deve essere true");
  assert.strictEqual(listing.totalCount, 8, "totalCount deve riportare il totale reale degli elementi rilevati");

  console.log("  PASS: RNF-PERF-002 - Troncamento di sicurezza e limite configurabile per directory affollate.");
}

// =========================================================================
// TEST 3: RF-FS-006, §9 - Gestione e distinzione errori del filesystem remoto
// =========================================================================
{
  const auditRepo = new InMemoryAuditRepository();
  const sessionManager = new SessionManager(30);

  const remoteFsService = new RemoteFilesystemService(
    testConfig,
    connectionManager,
    auditRepo,
    logger,
    DEFAULT_ROLE_PERMISSIONS
  );

  const robot = createTestRobot("robot_fs_errors");
  const context = sessionManager.createAuthorizedContext(
    sessionManager.createSession(userAuthorized),
    userAuthorized,
    robot.id,
    DEFAULT_ROLE_PERMISSIONS
  );

  // 1. Percorso inesistente (ENOENT)
  let errNotFound: any = null;
  try {
    await remoteFsService.listDirectory(context, robot, "/home/operator/non_existent_dir");
  } catch (err: any) {
    errNotFound = err;
  }
  assert.ok(errNotFound);
  assert.strictEqual(errNotFound.code, ErrorCode.REMOTE_FS_ERROR);
  assert.ok(errNotFound.userMessage.includes("non presente"), "Messaggio per percorso inesistente sicuro e chiaro");

  // 2. Permessi insufficienti (EACCES / PERMISSION_DENIED)
  let errPerm: any = null;
  try {
    await remoteFsService.listDirectory(context, robot, "/home/operator/forbidden_dir");
  } catch (err: any) {
    errPerm = err;
  }
  assert.ok(errPerm);
  assert.strictEqual(errPerm.code, ErrorCode.INSUFFICIENT_PERMISSIONS);
  assert.ok(errPerm.userMessage.includes("Permessi insufficienti"), "Messaggio permessi insufficienti sicuro e chiaro");

  // 3. Robot non raggiungibile sulla porta SSH
  const unreachableRobot = createTestRobot("robot_unreachable", { sshPort: 54321 });
  const contextUnreachable = sessionManager.createAuthorizedContext(
    sessionManager.createSession(userAuthorized),
    userAuthorized,
    unreachableRobot.id,
    DEFAULT_ROLE_PERMISSIONS
  );
  let errUnreachable: any = null;
  try {
    await remoteFsService.listDirectory(contextUnreachable, unreachableRobot, "/home/operator");
  } catch (err: any) {
    errUnreachable = err;
  }
  assert.ok(errUnreachable);
  assert.ok(
    errUnreachable.code === ErrorCode.HOST_UNREACHABLE || errUnreachable.code === ErrorCode.SSH_PORT_UNAVAILABLE,
    "Errore deve essere di raggiungibilità o porta non disponibile"
  );

  assert.strictEqual(connectionManager.getActiveConnectionCount(), 0, "Risorse sempre rilasciate anche su errore");
  console.log("  PASS: RF-FS-006 - Gestione e distinzione errori (inesistente, permessi negati, host irraggiungibile).");
}

// =========================================================================
// TEST 4: RF-FS-007, RF-AUTH-005 - Autorizzazioni, isolamento robot e separazione permessi
// =========================================================================
{
  const auditRepo = new InMemoryAuditRepository();
  const sessionManager = new SessionManager(30);

  const remoteFsService = new RemoteFilesystemService(
    testConfig,
    connectionManager,
    auditRepo,
    logger,
    DEFAULT_ROLE_PERMISSIONS
  );

  const robotA = createTestRobot("robot_A");
  const robotB = createTestRobot("robot_B");

  // Utente senza permesso di navigazione
  const contextNoPerm = sessionManager.createAuthorizedContext(
    sessionManager.createSession(userNoNavigate),
    userNoNavigate,
    robotA.id,
    DEFAULT_ROLE_PERMISSIONS
  );

  let denied = false;
  try {
    await remoteFsService.listDirectory(contextNoPerm, robotA);
  } catch (err: any) {
    denied = err.code === ErrorCode.INSUFFICIENT_PERMISSIONS;
  }
  assert.strictEqual(denied, true, "Utente senza permesso FS_REMOTE_NAVIGATE deve essere respinto");

  // Utente con permesso per robot A tenta accesso al robot B (CA-AUTH-003, RNF-SEC-004)
  const userRobotAOnly: UserEntity = {
    id: "user_a_only",
    username: "op_robot_a",
    roles: [],
    robotPermissions: {
      robot_A: [AppPermission.FS_REMOTE_NAVIGATE],
    },
    enabled: true,
    updatedAt: new Date(),
    passwordHash: "mock_hash",
    createdAt: new Date(),
  };

  const contextA = sessionManager.createAuthorizedContext(
    sessionManager.createSession(userRobotAOnly),
    userRobotAOnly,
    robotA.id,
    DEFAULT_ROLE_PERMISSIONS
  );
  const contextB = sessionManager.createAuthorizedContext(
    sessionManager.createSession(userRobotAOnly),
    userRobotAOnly,
    robotB.id,
    DEFAULT_ROLE_PERMISSIONS
  );

  // Navigazione su robot A: consentita
  const listA = await remoteFsService.listDirectory(contextA, robotA);
  assert.ok(listA);

  // Navigazione su robot B: respinta (CA-SSH-005, CA-AUTH-003)
  let deniedB = false;
  try {
    await remoteFsService.listDirectory(contextB, robotB);
  } catch (err: any) {
    deniedB = err.code === ErrorCode.INSUFFICIENT_PERMISSIONS;
  }
  assert.strictEqual(deniedB, true, "Permesso per robot A non consente di navigare robot B");

  // Verifica audit tentativi non autorizzati (RNF-SEC-009, Step 8)
  const auditEntries = await auditRepo.query({ operation: "SECURITY_AUTHORIZATION_ERROR" });
  assert.ok(auditEntries.length >= 2, "I tentativi non autorizzati devono essere registrati in audit");

  console.log("  PASS: RF-FS-007 - Rispetto delle autorizzazioni applicative e isolamento tra robot.");
}

// =========================================================================
// TEST 5: RNF-SEC-005, §10.3 - Validazione percorsi e restrizioni di configurazione
// =========================================================================
{
  const auditRepo = new InMemoryAuditRepository();
  const sessionManager = new SessionManager(30);

  const restrictedConfig: SystemConfiguration = {
    ...testConfig,
    remoteFsAllowedPaths: ["/home/operator"], // Solo /home/operator consentito
  };

  const restrictedService = new RemoteFilesystemService(
    restrictedConfig,
    connectionManager,
    auditRepo,
    logger,
    DEFAULT_ROLE_PERMISSIONS
  );

  const robot = createTestRobot("robot_restricted");
  const context = sessionManager.createAuthorizedContext(
    sessionManager.createSession(userAuthorized),
    userAuthorized,
    robot.id,
    DEFAULT_ROLE_PERMISSIONS
  );

  // 1. Percorso malformato con byte nulli (RNF-SEC-005)
  let nullByteErr = false;
  try {
    await restrictedService.listDirectory(context, robot, "/home/operator/foo\0bar");
  } catch (err: any) {
    nullByteErr = err.code === ErrorCode.REMOTE_FS_ERROR;
  }
  assert.strictEqual(nullByteErr, true, "Percorso con byte nulli deve essere categoricamente rifiutato");

  // 2. Percorso esterno alle restrizioni consentite (/etc)
  let outsideErr = false;
  try {
    await restrictedService.listDirectory(context, robot, "/etc");
  } catch (err: any) {
    outsideErr = err.code === ErrorCode.INSUFFICIENT_PERMISSIONS;
  }
  assert.strictEqual(outsideErr, true, "Percorso esterno alle restrizioni deve essere respinto (403)");

  // 3. Path traversal che tenta di evadere le restrizioni (/home/operator/../../etc)
  let traversalOutside = false;
  try {
    await restrictedService.listDirectory(context, robot, "/home/operator/../../etc");
  } catch (err: any) {
    traversalOutside = err.code === ErrorCode.INSUFFICIENT_PERMISSIONS;
  }
  assert.strictEqual(traversalOutside, true, "Path traversal verso percorsi vietati deve essere bloccato");

  // 4. Percorso valido all'interno delle restrizioni
  const validList = await restrictedService.listDirectory(context, robot, "/home/operator/subfolder");
  assert.strictEqual(validList.currentPath, "/home/operator/subfolder");

  console.log("  PASS: RNF-SEC-005 - Validazione dei percorsi, blocco byte nulli e applicazione restrizioni.");
}

// =========================================================================
// TEST 6: RF-FS-001, §8.1, §8.4 - Blocco accesso su robot disabilitato o non verificato
// =========================================================================
{
  const auditRepo = new InMemoryAuditRepository();
  const sessionManager = new SessionManager(30);

  const remoteFsService = new RemoteFilesystemService(
    testConfig,
    connectionManager,
    auditRepo,
    logger,
    DEFAULT_ROLE_PERMISSIONS
  );

  // 1. Robot disabilitato
  const disabledRobot = createTestRobot("robot_disabled", { anagraphicState: "disabilitato" });
  const contextDisabled = sessionManager.createAuthorizedContext(
    sessionManager.createSession(userAuthorized),
    userAuthorized,
    disabledRobot.id,
    DEFAULT_ROLE_PERMISSIONS
  );
  let errDisabled = false;
  try {
    await remoteFsService.listDirectory(contextDisabled, disabledRobot);
  } catch (err: any) {
    errDisabled = err.code === ErrorCode.INSUFFICIENT_PERMISSIONS;
  }
  assert.strictEqual(errDisabled, true, "Robot disabilitato deve rifiutare l'accesso al filesystem");

  // 2. Robot con registrazione differita non verificata (§8.1)
  const unverifiedRobot = createTestRobot("robot_unverified", { registrationState: "ssh_non_verificata" });
  const contextUnverified = sessionManager.createAuthorizedContext(
    sessionManager.createSession(userAuthorized),
    userAuthorized,
    unverifiedRobot.id,
    DEFAULT_ROLE_PERMISSIONS
  );
  let errUnverified = false;
  try {
    await remoteFsService.listDirectory(contextUnverified, unverifiedRobot);
  } catch (err: any) {
    errUnverified = err.code === ErrorCode.HOST_UNREACHABLE;
  }
  assert.strictEqual(errUnverified, true, "Robot non verificato deve rifiutare l'accesso al filesystem");

  console.log("  PASS: RF-FS-001 - Blocco accesso su robot disabilitati o con connessione differita non verificata.");
}

// =========================================================================
// TEST 7: Garanzia di sola lettura della navigazione
// =========================================================================
{
  mutationAttempts.length = 0;
  const auditRepo = new InMemoryAuditRepository();
  const sessionManager = new SessionManager(30);

  const remoteFsService = new RemoteFilesystemService(
    testConfig,
    connectionManager,
    auditRepo,
    logger,
    DEFAULT_ROLE_PERMISSIONS
  );

  const robot = createTestRobot("robot_ro");
  const context = sessionManager.createAuthorizedContext(
    sessionManager.createSession(userAuthorized),
    userAuthorized,
    robot.id,
    DEFAULT_ROLE_PERMISSIONS
  );

  await remoteFsService.listDirectory(context, robot, "/home/operator");
  await remoteFsService.listDirectory(context, robot, "/home/operator/subfolder");

  // Nessuna operazione di mutazione (WRITE, REMOVE, RMDIR, MKDIR, RENAME) deve essere stata chiamata
  assert.strictEqual(
    mutationAttempts.length,
    0,
    `Nessuna mutazione consentita durante la navigazione: rilevati [${mutationAttempts.join(", ")}]`
  );
  console.log("  PASS: RF-FS-007 - Livello di navigazione rigorosamente di sola lettura (nessuna mutazione remota).");
}

// =========================================================================
// TEST 8: STEP 5 - Punti di accesso per il servizio di trasferimento (Prompt 10)
// =========================================================================
{
  const auditRepo = new InMemoryAuditRepository();
  const sessionManager = new SessionManager(30);

  const remoteFsService = new RemoteFilesystemService(
    testConfig,
    connectionManager,
    auditRepo,
    logger,
    DEFAULT_ROLE_PERMISSIONS
  );

  const robot = createTestRobot("robot_stream");
  const context = sessionManager.createAuthorizedContext(
    sessionManager.createSession(userAuthorized),
    userAuthorized,
    robot.id,
    DEFAULT_ROLE_PERMISSIONS
  );

  // 1. openRemoteReadStream (RF-FS-004, RNF-PERF-001)
  const readHandle = await remoteFsService.openRemoteReadStream(context, robot, "/home/operator/file1.txt");
  assert.ok(readHandle.stream, "Deve restituire un Readable stream");

  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    readHandle.stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    readHandle.stream.on("end", () => resolve());
    readHandle.stream.on("error", reject);
  });
  assert.strictEqual(Buffer.concat(chunks).toString(), "Contenuto file1");
  await readHandle.cleanup();
  assert.strictEqual(connectionManager.getActiveConnectionCount(), 0, "Connessione rilasciata dopo lettura stream");

  // 2. openRemoteWriteStream: rifiuto sovrascrittura se file esiste già (Step 5, §11.5)
  let overwriteRefused = false;
  try {
    await remoteFsService.openRemoteWriteStream(context, robot, "/home/operator/file1.txt", { overwrite: false });
  } catch (err: any) {
    overwriteRefused = err.code === ErrorCode.REMOTE_FS_ERROR;
  }
  assert.strictEqual(overwriteRefused, true, "Sovrascrittura di default deve essere rifiutata");

  // 3. openRemoteWriteStream con autorizzazione esplicita di sovrascrittura o nuovo file
  mutationAttempts.length = 0;
  const writeHandle = await remoteFsService.openRemoteWriteStream(context, robot, "/home/operator/new_file.txt", { overwrite: true });
  assert.ok(writeHandle.stream, "Deve restituire un Writable stream");
  writeHandle.stream.write(Buffer.from("Nuovi dati da inviare al robot"));
  writeHandle.stream.end();
  await new Promise((r) => setTimeout(r, 50));
  await writeHandle.cleanup();
  assert.ok(mutationAttempts.some((a) => a.includes("WRITE")), "Tentativo di scrittura registrato solo su punto di accesso Prompt 10");
  assert.strictEqual(connectionManager.getActiveConnectionCount(), 0, "Connessione rilasciata dopo scrittura stream");

  // 4. getRemoteFileStats (RF-TRF-006, RF-TRF-014)
  const stats = await remoteFsService.getRemoteFileStats(context, robot, "/home/operator/file2.log");
  assert.strictEqual(stats.name, "file2.log");
  assert.strictEqual(stats.type, "file");
  assert.strictEqual(stats.size, 2048);
  assert.ok(stats.modifiedAt);
  assert.strictEqual(connectionManager.getActiveConnectionCount(), 0);

  console.log("  PASS: RF-FS-004/005 - Punti di accesso in streaming per download/upload pronti per il Prompt 10.");
}

// =========================================================================
// TEST 9: Endpoint REST /api/robots/:robotId/fs/remote/list (RF-FS-001..003)
// =========================================================================
{
  const robotRepo = new InMemoryRobotRepository();
  const auditRepo = new InMemoryAuditRepository();
  const userRepo = new InMemoryUserRepository();
  const sessionManager = new SessionManager(30);

  await userRepo.create({ ...userAuthorized, passwordHash: "h" });
  await userRepo.create({ ...userNoNavigate, passwordHash: "h" });

  const remoteFsService = new RemoteFilesystemService(
    testConfig,
    connectionManager,
    auditRepo,
    logger,
    DEFAULT_ROLE_PERMISSIONS
  );

  const robot = createTestRobot("robot_api_fs");
  await robotRepo.create(robot);

  const server = createServer(testConfig, logger, {
    robotRepository: robotRepo,
    auditRepository: auditRepo,
    userRepository: userRepo,
    sessionManager,
    roleMapping: DEFAULT_ROLE_PERMISSIONS,
    remoteFsService,
    connectionManager,
  });

  await server.listen({ port: 0, host: "127.0.0.1" });

  // 1. Chiamata senza autenticazione -> 401
  const unauthRes = await server.inject({
    method: "GET",
    url: "/api/robots/robot_api_fs/fs/remote/list",
  });
  assert.strictEqual(unauthRes.statusCode, 401);

  // 2. Chiamata con utente autorizzato -> 200
  const authSession = sessionManager.createSession(userAuthorized);
  const okRes = await server.inject({
    method: "GET",
    url: "/api/robots/robot_api_fs/fs/remote/list",
    headers: {
      cookie: `moliris_session=${authSession.sessionId}`,
    },
  });
  assert.strictEqual(okRes.statusCode, 200);
  const okBody = JSON.parse(okRes.body);
  assert.strictEqual(okBody.robotId, "robot_api_fs");
  assert.strictEqual(okBody.currentPath, "/home/operator");
  assert.ok(Array.isArray(okBody.items));

  // 3. Navigazione a sottocartella via query param path
  const subRes = await server.inject({
    method: "GET",
    url: "/api/robots/robot_api_fs/fs/remote/list?path=/home/operator/subfolder",
    headers: {
      cookie: `moliris_session=${authSession.sessionId}`,
    },
  });
  assert.strictEqual(subRes.statusCode, 200);
  const subBody = JSON.parse(subRes.body);
  assert.strictEqual(subBody.currentPath, "/home/operator/subfolder");
  assert.strictEqual(subBody.parentPath, "/home/operator");

  // 4. Chiamata con utente privo di permesso -> 403
  const noPermSession = sessionManager.createSession(userNoNavigate);
  const noPermRes = await server.inject({
    method: "GET",
    url: "/api/robots/robot_api_fs/fs/remote/list",
    headers: {
      cookie: `moliris_session=${noPermSession.sessionId}`,
    },
  });
  assert.strictEqual(noPermRes.statusCode, 403);

  // 5. Chiamata su robot inesistente -> 404
  const notFoundRes = await server.inject({
    method: "GET",
    url: "/api/robots/robot_ghost/fs/remote/list",
    headers: {
      cookie: `moliris_session=${authSession.sessionId}`,
    },
  });
  assert.strictEqual(notFoundRes.statusCode, 404);

  await server.close();
  console.log("  PASS: Endpoint REST /api/robots/:robotId/fs/remote/list con RBAC e gestione parametri.");
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

console.log("PASS: Tutti i test del modulo Filesystem Remoto completati con successo.");
process.exit(0);
