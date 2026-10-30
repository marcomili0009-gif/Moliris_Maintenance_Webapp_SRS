// Requisiti testati: SRS §5.6, §3.6, §4.2, §8.2, §10.3, §11.1, §11.3, §11.5,
// RF-SRVFS-001..007, RF-ROB-008, RF-ROB-009, RF-ROB-010, RF-FS-002,
// RNF-SEC-005, RNF-SEC-007, RNF-SEC-008, RNF-FS-001..004,
// CA-ROB-004, CA-ROB-005, CA-ROB-007, CA-ROB-008, CA-ROB-009, CA-ROB-011

import assert from "assert";
import fs from "fs";
import path from "path";
import os from "os";
import { ServerFilesystemService } from "./server-fs.ts";
import { InMemoryAuditRepository } from "./audit-repository.ts";
import { MolirisLogger } from "../logging/logger.ts";
import { StandardRobotDirectoryNamingPolicy, type RobotEntity } from "./robot-models.ts";
import { AppPermission } from "../backend/auth/permissions.ts";
import { type AuthorizedContext } from "../backend/auth/session-manager.ts";
import { MolirisAppError, ErrorCode } from "../errors/app-errors.ts";
import { AuditOperation } from "./audit-models.ts";

console.log("--> Esecuzione test modulo Filesystem Server e isolamento robot...");

const testFsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "moliris-fs-test-"));
const auditRepo = new InMemoryAuditRepository();
const logger = new MolirisLogger();
const namingPolicy = new StandardRobotDirectoryNamingPolicy();

const serverFsService = new ServerFilesystemService(testFsRoot, auditRepo, logger);

function makeTestRobot(id: string, username: string): RobotEntity {
  const serverDirectoryPath = namingPolicy.resolveDirectoryPath(testFsRoot, { id, remoteUsername: username, host: "192.168.1.50" });
  return {
    id,
    displayName: `Robot ${id}`,
    remoteUsername: username,
    host: "192.168.1.50",
    sshPort: 22,
    sshAuthMethod: "key",
    credentialReference: "vault://test/creds",
    hostKeyVerification: { strictHostKeyChecking: true },
    stateFilePaths: ["/tmp/status.txt"],
    serverDirectoryPath,
    anagraphicState: "attivo",
    connectionState: "non_verificato",
    operationalState: null,
    lastValidUpdateAt: null,
    lastAttemptOutcome: null,
    registrationState: "ssh_non_verificata",
    lastConnectionVerification: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

const robotA = makeTestRobot("robot_A", "operator_a");
const robotB = makeTestRobot("robot_B", "operator_b");

// 1. Test CA-ROB-004: Creazione directory con nome = username dentro la root configurata
const resCreateA = await serverFsService.ensureRobotDirectory(robotA, {
  standardSubdirectories: ["logs", "telemetry"],
  directoryPermissions: "0750",
});
assert.strictEqual(resCreateA.created, true);
assert.strictEqual(resCreateA.alreadyExisted, false);
assert(fs.existsSync(robotA.serverDirectoryPath), "La directory del robot deve esistere");
assert.strictEqual(path.basename(robotA.serverDirectoryPath), "operator_a_robot_A", "Il nome deve corrispondere alla regola baseline <username>_<id>");
assert(fs.existsSync(path.join(robotA.serverDirectoryPath, "logs")), "Sottodirectory logs deve esistere");
assert(fs.existsSync(path.join(robotA.serverDirectoryPath, "telemetry")), "Sottodirectory telemetry deve esistere");
console.log("  PASS: Creazione directory con nome = username e sottodirectory standard (CA-ROB-004).");

// 2. Test RNF-FS-004 e CA-ROB-005: Idempotenza e rispetto directory preesistente
// Creiamo un file dentro robotA
const existingFilePath = path.join(robotA.serverDirectoryPath, "existing_data.log");
fs.writeFileSync(existingFilePath, "PRE_EXISTING_CONTENT");

// Seconda chiamata: deve riconoscere che esiste già e non toccare nulla
const resCreateA2 = await serverFsService.ensureRobotDirectory(robotA, {
  standardSubdirectories: ["logs", "telemetry"],
});
assert.strictEqual(resCreateA2.created, false);
assert.strictEqual(resCreateA2.alreadyExisted, true);
assert.strictEqual(fs.readFileSync(existingFilePath, "utf8"), "PRE_EXISTING_CONTENT", "I file esistenti non devono essere toccati");
console.log("  PASS: Idempotenza e non-sovrascrittura directory preesistente (CA-ROB-005, RNF-FS-004).");

// 3. Test CA-ROB-008 e CA-ROB-011: Rollback operazione reversibile
// Se la directory era preesistente, il rollback NON deve cancellarla
const rbExisting = await serverFsService.rollbackRobotDirectory(resCreateA2);
assert.strictEqual(rbExisting.rolledBack, false);
assert(fs.existsSync(robotA.serverDirectoryPath), "La directory preesistente non deve essere toccata dal rollback");

// Creazione robot C ex-novo per testare rollback su creazione riuscita
const robotC = makeTestRobot("robot_C", "operator_c");
const resCreateC = await serverFsService.ensureRobotDirectory(robotC, {
  standardSubdirectories: ["sub1"],
});
assert.strictEqual(resCreateC.created, true);
assert(fs.existsSync(robotC.serverDirectoryPath));

// Rollback di robot C: rimuove solo perché vuota
const rbC = await serverFsService.rollbackRobotDirectory(resCreateC);
assert.strictEqual(rbC.rolledBack, true);
assert(!fs.existsSync(robotC.serverDirectoryPath), "Directory vuota creata ex-novo deve essere rimossa");

// Se ci fosse un file creato nel frattempo, rollback non deve cancellarla (CA-ROB-011)
const robotD = makeTestRobot("robot_D", "operator_d");
const resCreateD = await serverFsService.ensureRobotDirectory(robotD);
fs.writeFileSync(path.join(robotD.serverDirectoryPath, "important.dat"), "IMPORTANT");
const rbD = await serverFsService.rollbackRobotDirectory(resCreateD);
assert.strictEqual(fs.existsSync(robotD.serverDirectoryPath), true, "Se contiene file, non deve essere cancellata");
console.log("  PASS: Rollback selettivo sicuro a zero perdite dati (CA-ROB-008, CA-ROB-011).");

// 4. Test CA-ROB-007: Root non scrivibile produce errore sicuro
const unwritableRoot = path.join(testFsRoot, "unwritable_root");
fs.mkdirSync(unwritableRoot, { mode: 0o400 }); // Sola lettura
const brokenFsService = new ServerFilesystemService(unwritableRoot, auditRepo, logger);
await assert.rejects(
  async () => await brokenFsService.ensureRobotDirectory(robotA),
  (err: any) => {
    assert(err instanceof MolirisAppError);
    assert.strictEqual(err.code, ErrorCode.SERVER_DIR_INACCESSIBLE);
    assert(!err.userMessage.includes(unwritableRoot), "Il messaggio utente non deve esporre percorsi interni");
    return true;
  },
  "Root non scrivibile deve lanciare errore SERVER_DIR_INACCESSIBLE"
);
console.log("  PASS: Root non accessibile/scrivibile gestita con errore sicuro (CA-ROB-007).");

// 5. Test CA-ROB-009: Sicurezza percorsi e anti Path-Traversal
await assert.rejects(
  async () => await serverFsService.resolveRobotPath(robotA, "../other_dir"),
  (err: any) => {
    assert(err instanceof MolirisAppError);
    assert.strictEqual(err.code, ErrorCode.SERVER_DIR_INACCESSIBLE);
    return true;
  },
  "Path traversal con .. deve essere respinto"
);

await assert.rejects(
  async () => await serverFsService.resolveRobotPath(robotA, "/etc/passwd"),
  (err: any) => {
    assert(err instanceof MolirisAppError);
    assert.strictEqual(err.code, ErrorCode.SERVER_DIR_INACCESSIBLE);
    return true;
  },
  "Percorso assoluto deve essere respinto"
);

await assert.rejects(
  async () => await serverFsService.resolveRobotPath(robotA, "file\0.txt"),
  (err: any) => {
    assert(err instanceof MolirisAppError);
    return true;
  },
  "Null byte injection deve essere respinto"
);

// Test symlink che esce dalla root del robot
const outsideTarget = path.join(testFsRoot, "outside_target.txt");
fs.writeFileSync(outsideTarget, "CONFIDENTIAL_SERVER_DATA");
const symlinkPath = path.join(robotA.serverDirectoryPath, "leak_symlink");
try {
  fs.symlinkSync(outsideTarget, symlinkPath);
  await assert.rejects(
    async () => await serverFsService.resolveRobotPath(robotA, "leak_symlink"),
    (err: any) => {
      assert(err instanceof MolirisAppError);
      return true;
    },
    "Symlink esterno deve essere respinto"
  );
} catch (e: any) {
  if (e.code !== "EPERM") throw e;
}
console.log("  PASS: Rifiuto path-traversal, percorsi assoluti e symlink esterni (CA-ROB-009).");

// 6. Test RF-SRVFS-005 e RNF-FS-002: Isolamento tra robot
// Contesto autorizzato solo per robotA
const contextRobotA: AuthorizedContext = {
  sessionId: "sess_a",
  userId: "user_a",
  username: "user_a",
  roles: ["operatore"],
  targetRobotId: "robot_A",
  permissions: new Set([AppPermission.FS_SERVER_NAVIGATE, AppPermission.FS_SERVER_DOWNLOAD, AppPermission.FS_SERVER_UPLOAD]),
};

// Contesto per robotA tenta di accedere a robotB: deve essere categoricamente bloccato
await assert.rejects(
  async () => await serverFsService.listDirectory(contextRobotA, robotB),
  (err: any) => {
    assert(err instanceof MolirisAppError);
    assert.strictEqual(err.code, ErrorCode.INSUFFICIENT_PERMISSIONS);
    return true;
  },
  "Un contesto autorizzato per robotA non può accedere al filesystem di robotB (RNF-FS-002)"
);
console.log("  PASS: Isolamento tra robot verificato (RF-SRVFS-005, RNF-FS-002).");

// 7. Test RF-SRVFS-002: Navigazione dei file sul server
// Creiamo una gerarchia dentro robotA:
// /operator_a/
//   file1.txt
//   subdir/
//     subfile.txt
fs.writeFileSync(path.join(robotA.serverDirectoryPath, "file1.txt"), "Contenuto 1");
const subDirPath = path.join(robotA.serverDirectoryPath, "subdir");
if (!fs.existsSync(subDirPath)) fs.mkdirSync(subDirPath);
fs.writeFileSync(path.join(subDirPath, "subfile.txt"), "Contenuto sub");

const rootItems = await serverFsService.listDirectory(contextRobotA, robotA);
assert(rootItems.some(i => i.name === "subdir" && i.type === "directory"));
assert(rootItems.some(i => i.name === "file1.txt" && i.type === "file" && i.size === 11));

const subItems = await serverFsService.listDirectory(contextRobotA, robotA, "subdir");
assert(subItems.some(i => i.name === "subfile.txt" && i.type === "file"));
console.log("  PASS: Navigazione e lettura elementi directory server (RF-SRVFS-002).");

// 8. Test RF-SRVFS-003, RF-TRF-011, RNF-FS-003: Predisposizione scrittura e blocco sovrascrittura
// Scrittura nuovo file riuscita
const writeStream = await serverFsService.openFileWriteStream(contextRobotA, robotA, "new_file.txt");
writeStream.write("Nuovo file stream");
writeStream.end();
await new Promise(r => setTimeout(r, 50));

// Tentativo di sovrascrittura senza 'overwrite: true': deve essere rifiutato
await assert.rejects(
  async () => await serverFsService.openFileWriteStream(contextRobotA, robotA, "new_file.txt"),
  (err: any) => {
    assert(err instanceof MolirisAppError);
    assert.strictEqual(err.code, ErrorCode.REMOTE_FS_ERROR);
    return true;
  },
  "Sovrascrittura accidentale deve essere bloccata di default (RF-TRF-011)"
);

// Sovrascrittura con overwrite: true
const overwriteStream = await serverFsService.openFileWriteStream(contextRobotA, robotA, "new_file.txt", { overwrite: true });
overwriteStream.write("Contenuto sovrascritto");
overwriteStream.end();
await new Promise(r => setTimeout(r, 50));
console.log("  PASS: Predisposizione stream di trasferimento e protezione sovrascrittura (RNF-FS-003).");

// 9. Test Eventi di Audit registrati per violazioni di sicurezza (RNF-SEC-009)
const auditEvents = await auditRepo.query({ operation: AuditOperation.SECURITY_AUTHORIZATION_ERROR });
assert(auditEvents.length >= 2, "Devono essere registrati eventi audit per violazioni di path traversal");
console.log("  PASS: Tracciamento audit per violazioni di sicurezza (RNF-SEC-009).");

// 10. Test API HTTPS: Navigazione filesystem server tramite endpoint REST (RF-SRVFS-002, RF-SRVFS-005)
import { createServer } from "../backend/server.ts";
import { InMemoryRobotRepository } from "./robot-repository.ts";
import { InMemoryUserRepository } from "../backend/auth/user-repository.ts";
import { SessionManager } from "../backend/auth/session-manager.ts";
import { type SystemConfiguration } from "../config/configuration.ts";
import https from "https";
import { execSync } from "child_process";

const tlsDir = fs.mkdtempSync(path.join(os.tmpdir(), "moliris-tls-fs-"));
const certP = path.join(tlsDir, "cert.pem");
const keyP = path.join(tlsDir, "key.pem");
execSync(`openssl req -x509 -newkey rsa:2048 -keyout "${keyP}" -out "${certP}" -days 1 -nodes -subj "/CN=localhost"`, {
  stdio: "pipe",
});

const testConfig: SystemConfiguration = {
  serverFilesystemRoot: testFsRoot,
  pollingIntervalSeconds: 10,
  sshConnectionTimeoutMs: 5000,
  maxConcurrentTransfersPerUser: 2,
  maxConcurrentTransfersPerRobot: 2,
  maxConcurrentTransfersServer: 10,
  tempFileRetentionMinutes: 60,
  stateFilePaths: ["/tmp/status.txt"],
  inactiveSessionTimeoutMinutes: 30,
  tlsCertPath: certP,
  tlsKeyPath: keyP,
  registrationMode: "rigorosa",
  auditLogRetentionDays: 90,
  defaultSshPort: 22,
};

const robotRepo = new InMemoryRobotRepository();
await robotRepo.create(robotA);
await robotRepo.create(robotB);

const userRepo = new InMemoryUserRepository();
const sessionMgr = new SessionManager(30);

// Utente autorizzato per robotA
const userAuthA = await userRepo.create({
  id: "user_a_fs",
  username: "operatore_a",
  passwordHash: "dummy",
  roles: [],
  permissions: [],
  robotPermissions: {
    robot_A: [AppPermission.FS_SERVER_NAVIGATE],
  },
  enabled: true,
  createdAt: new Date(),
  updatedAt: new Date(),
});
const sessionA = sessionMgr.createSession(userAuthA);

const testApp = createServer(testConfig, logger, {
  sessionManager: sessionMgr,
  userRepository: userRepo,
  auditRepository: auditRepo,
  robotRepository: robotRepo,
  serverFsService,
});

await testApp.listen({ port: 0, host: "127.0.0.1" });
const testPort = (testApp.server.address() as any).port;

async function apiGet(pathUrl: string, token?: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      `https://127.0.0.1:${testPort}${pathUrl}`,
      {
        method: "GET",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        rejectUnauthorized: false,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode || 0, body: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode || 0, body: data });
          }
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
}

// Chiamata autorizzata su robotA
const resApiA = await apiGet("/api/robots/robot_A/fs/server/list", sessionA.sessionId);
assert.strictEqual(resApiA.status, 200);
assert(Array.isArray(resApiA.body.items));
assert(resApiA.body.items.some((i: any) => i.name === "file1.txt"));

// Chiamata su robotB con credenziali autorizzate solo per robotA: deve restituire 403 (RF-SRVFS-005)
const resApiB = await apiGet("/api/robots/robot_B/fs/server/list", sessionA.sessionId);
assert.strictEqual(resApiB.status, 403, "Accesso a robotB deve essere rifiutato con 403");

// Chiamata con tentativo di path traversal nell'endpoint REST
const resApiTraversal = await apiGet("/api/robots/robot_A/fs/server/list?path=../../etc", sessionA.sessionId);
assert.strictEqual(resApiTraversal.status, 400, "Tentativo di path traversal deve restituire 400");
assert(!JSON.stringify(resApiTraversal.body).includes(testFsRoot), "Nessun percorso interno esposto all'utente");

await testApp.close();
fs.rmSync(tlsDir, { recursive: true, force: true });
console.log("  PASS: Endpoint REST /api/robots/:robotId/fs/server/list verificato con RBAC e sicurezza.");

// Cleanup
fs.rmSync(testFsRoot, { recursive: true, force: true });
console.log("PASS: Tutti i test del modulo Filesystem Server completati con successo.");
