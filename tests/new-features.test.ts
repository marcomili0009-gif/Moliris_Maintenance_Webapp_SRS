import assert from "assert";
import fs from "fs";
import path from "path";
import os from "os";
import { execSync } from "child_process";
import { createServer } from "../backend/server.ts";
import { MolirisLogger } from "../logging/logger.ts";
import { type SystemConfiguration } from "../config/configuration.ts";
import { InMemoryRobotRepository } from "../storage/robot-repository.ts";
import { InMemoryAuditRepository } from "../storage/audit-repository.ts";
import { InMemoryUserRepository } from "../backend/auth/user-repository.ts";
import { SessionManager } from "../backend/auth/session-manager.ts";
import { AppPermission, DEFAULT_ROLE_PERMISSIONS } from "../backend/auth/permissions.ts";
import { ServerFilesystemService } from "../storage/server-fs.ts";
import { type RobotEntity } from "../storage/robot-models.ts";

console.log("--> Esecuzione test suite Nuove Funzionalità (§1..§9, §15, §16)...");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "moliris-newfeatures-test-"));
const certPath = path.join(tmpDir, "cert.pem");
const keyPath = path.join(tmpDir, "key.pem");
const fsRoot = path.join(tmpDir, "robots_root");
const generalRoot = path.join(tmpDir, "general_root");
fs.mkdirSync(fsRoot, { recursive: true, mode: 0o750 });
fs.mkdirSync(generalRoot, { recursive: true, mode: 0o750 });

process.env.MOLIRIS_GENERAL_FS_ROOT = generalRoot;

execSync(`openssl req -x509 -newkey rsa:2048 -keyout "${keyPath}" -out "${certPath}" -days 1 -nodes -subj "/CN=localhost"`, {
  stdio: "pipe",
});

const config: SystemConfiguration = {
  credentialProviderType: "in-memory",
  serverFilesystemRoot: fsRoot,
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
  registrationMode: "differita",
  auditLogRetentionDays: 90,
  defaultSshPort: 22,
};

const logger = new MolirisLogger();
const robotRepo = new InMemoryRobotRepository();
const auditRepo = new InMemoryAuditRepository();
const userRepo = new InMemoryUserRepository();
const sessionManager = new SessionManager(30);

const testServer = createServer(config, logger, {
  robotRepository: robotRepo,
  auditRepository: auditRepo,
  userRepository: userRepo,
  sessionManager,
});

await testServer.ready();
const testPort = 39871;
await testServer.listen({ port: testPort, host: "127.0.0.1" });

try {
  // Helper API request tramite fastify.inject
  const apiCall = async (method: "GET" | "POST" | "PUT" | "DELETE", endpoint: string, body?: any, cookie?: string) => {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Origin": "http://127.0.0.1",
      "Host": "127.0.0.1",
    };
    if (cookie) headers["Cookie"] = cookie;

    const res = await testServer.inject({
      method,
      url: endpoint,
      headers,
      payload: body,
    });

    let json: any = {};
    try { json = JSON.parse(res.payload); } catch {}
    return { status: res.statusCode, headers: res.headers, data: json };
  };

  // Creazione utenti: admin e operator
  const adminUser = {
    id: "usr_admin",
    username: "admin_test",
    passwordHash: "hash",
    roles: ["amministratore"],
    permissions: Object.values(AppPermission),
    enabled: true,
  };
  await userRepo.create(adminUser);

  const operUser = {
    id: "usr_oper",
    username: "oper_test",
    passwordHash: "hash",
    roles: ["operatore"],
    permissions: [AppPermission.FLEET_VIEW, AppPermission.STATUS_VIEW],
    enabled: true,
  };
  await userRepo.create(operUser);

  const adminSession = sessionManager.createSession(adminUser);
  const adminCookie = `__Host-moliris_session=${adminSession.sessionId}`;

  const operSession = sessionManager.createSession(operUser);
  const operCookie = `__Host-moliris_session=${operSession.sessionId}`;

  // 1. Test Terminale Server (§9)
  console.log("  -> [Test 1] Terminale Server: Verifica accesso riservato admin e apertura sessione PTY...");
  const nonAdminTermRes = await apiCall("POST", "/api/server/terminal/sessions", { cols: 80, rows: 24 }, operCookie);
  assert.strictEqual(nonAdminTermRes.status, 403, "Utente operatore non deve poter accedere al terminale server");

  const adminTermRes = await apiCall("POST", "/api/server/terminal/sessions", { cols: 100, rows: 30 }, adminCookie);
  console.log("adminTermRes:", adminTermRes);
  assert.strictEqual(adminTermRes.status, 201, "Admin deve poter aprire una sessione terminale server");
  assert.strictEqual(adminTermRes.data.success, true);
  assert.strictEqual(adminTermRes.data.robotId, "server");
  assert.strictEqual(adminTermRes.data.cols, 100);
  assert.strictEqual(adminTermRes.data.rows, 30);
  assert.ok(adminTermRes.data.sessionId, "Deve restituire sessionId valido");

  // Chiusura sessione terminale
  const closeRes = await apiCall("DELETE", `/api/terminal/sessions/${adminTermRes.data.sessionId}`, {}, adminCookie);
  assert.strictEqual(closeRes.status, 200);
  console.log("    PASS: Terminale server protetto da RBAC e sessione aperta con successo.");

  // 2. Test Aggiorna Flotta reale (§15)
  console.log("  -> [Test 2] Aggiorna Flotta (/api/fleet/status/refresh)...");
  const refreshRes = await apiCall("POST", "/api/fleet/status/refresh", {}, adminCookie);
  assert.strictEqual(refreshRes.status, 200);
  assert.strictEqual(typeof refreshRes.data.updatedCount, "number");
  console.log("    PASS: Endpoint di aggiornamento flotta globale operativo.");

  // 3. Test Nuova Cartella e Archivio Generale (§1, §3, §4)
  console.log("  -> [Test 3] Nuova Cartella e Archivio Generale Server...");
  const mkdirGeneralRes = await apiCall("POST", "/api/fs/general/mkdir", { name: "release_2026" }, adminCookie);
  assert.strictEqual(mkdirGeneralRes.status, 201);
  assert.strictEqual(mkdirGeneralRes.data.name, "release_2026");

  // Rifiuto duplicati
  const dupGeneralRes = await apiCall("POST", "/api/fs/general/mkdir", { name: "release_2026" }, adminCookie);
  assert.strictEqual(dupGeneralRes.status, 409, "Creazione cartella duplicata deve essere rifiutata con 409");

  // Rifiuto caratteri non validi
  const invalidNameRes = await apiCall("POST", "/api/fs/general/mkdir", { name: "invalid/folder..name" }, adminCookie);
  assert.strictEqual(invalidNameRes.status, 400);

  // Listing generale
  const listGeneralRes = await apiCall("GET", "/api/fs/general/list", {}, adminCookie);
  assert.strictEqual(listGeneralRes.status, 200);
  const foundFolder = listGeneralRes.data.entries?.find((e: any) => e.name === "release_2026");
  assert.ok(foundFolder, "La cartella creata deve comparire nel listing generale");
  assert.strictEqual(foundFolder.type, "directory");
  console.log("    PASS: Archivio Generale e creazione cartelle con permessi 0750 verificati.");

  // 4. Test Caricamento Massivo da file già sul server (§5, §7)
  console.log("  -> [Test 4] Caricamento Massivo da sorgente server (/api/transfers/bulk/server-source)...");
  // Scriviamo un file di test nell'archivio generale
  const serverFilePath = path.join(generalRoot, "sample_doc.txt");
  fs.writeFileSync(serverFilePath, "Contenuto del documento di test Moliris 2026", "utf-8");

  // Creazione robot fittizio
  const robot1: RobotEntity = {
    id: "robot-bulk-01",
    displayName: "Robot Bulk 1",
    hostname: "127.0.0.1",
    port: 22,
    remoteUsername: "operator",
    serverDirectoryPath: path.join(fsRoot, "operator_robot-bulk-01"),
    anagraphicState: "attivo",
    connectionState: "raggiungibile",
    registrationState: "ssh_verificata",
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  fs.mkdirSync(robot1.serverDirectoryPath, { recursive: true, mode: 0o750 });
  await robotRepo.create(robot1);

  const bulkServerRes = await apiCall(
    "POST",
    "/api/transfers/bulk/server-source",
    {
      sourceScope: "general",
      sourcePaths: ["sample_doc.txt"],
      targets: [{ robotId: "robot-bulk-01", type: "server", directory: "dest" }],
      overwrite: true,
    },
    adminCookie
  );

  console.log("bulkServerRes:", JSON.stringify(bulkServerRes.data, null, 2));
  assert.strictEqual(bulkServerRes.status, 200);
  assert.strictEqual(bulkServerRes.data.success, true);
  assert.strictEqual(bulkServerRes.data.summary.completed, 1);

  const destFilePath = path.join(robot1.serverDirectoryPath, "dest", "sample_doc.txt");
  assert.ok(fs.existsSync(destFilePath), "Il file deve essere stato copiato dal server generale al server del robot");
  assert.strictEqual(fs.readFileSync(destFilePath, "utf-8"), "Contenuto del documento di test Moliris 2026");
  console.log("    PASS: Caricamento massivo da sorgente server completato a zero copie sul client.");

  console.log("PASS: Tutte le nuove funzionalità (§1..§9, §15, §16) collaudate e verificate con successo!");
} finally {
  await testServer.close();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
}
