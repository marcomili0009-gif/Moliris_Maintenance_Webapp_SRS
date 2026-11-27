import assert from "node:assert";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "../../backend/server.ts";
import { type SystemConfiguration } from "../../config/configuration.ts";
import { InMemoryUserRepository } from "../../backend/auth/user-repository.ts";
import { InMemoryRobotRepository } from "../../storage/robot-repository.ts";
import { InMemoryAuditRepository } from "../../storage/audit-repository.ts";
import { hashPassword } from "../../backend/auth/user-models.ts";
import { AppPermission } from "../../backend/auth/permissions.ts";
import {
  authorizeOperatorPath,
  assertPathAuthorized,
  resolveEffectiveOperatorAllowedPaths,
  setPathAuthorizationDefaultOperatorAllowedPaths,
  setPathAuthorizationAuditRepository,
} from "../../backend/auth/path-authorization.ts";
import { ServerFilesystemService } from "../../storage/server-fs.ts";
import { MolirisLogger } from "../../logging/logger.ts";
import { ErrorCode } from "../../errors/app-errors.ts";
import {
  isPathAllowedForOperator,
  isPathOrAncestorAllowedForOperator,
  canPerformOperatorPathAction,
} from "../../client/src/utils/path-authorization.ts";

async function runTests() {
  console.log("--> Esecuzione suite regressione autorizzazioni operatore (default vs [] vs frontend)...");

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "moliris-op-auth-"));
  const fsRoot = path.join(tmpRoot, "fs_root");
  const generalRoot = path.join(fsRoot, "general");
  fs.mkdirSync(generalRoot, { recursive: true });

  const defaults = ["/upload", "/shared", "/logs", "/backups"];
  const auditRepo = new InMemoryAuditRepository();
  setPathAuthorizationAuditRepository(auditRepo);
  setPathAuthorizationDefaultOperatorAllowedPaths(defaults);

  // =========================================================================
  // 1. Unit: distinzione allowedPaths assente vs []
  // =========================================================================
  assert.deepStrictEqual(resolveEffectiveOperatorAllowedPaths({ allowedPaths: undefined }), defaults);
  assert.deepStrictEqual(resolveEffectiveOperatorAllowedPaths({ allowedPaths: null }), defaults);
  assert.deepStrictEqual(resolveEffectiveOperatorAllowedPaths({ allowedPaths: [] }), []);
  assert.deepStrictEqual(resolveEffectiveOperatorAllowedPaths({ allowedPaths: ["/custom"] }), ["/custom"]);

  // Operatore senza allowedPaths (assente) -> usa defaults
  const opAbsent = {
    sessionId: "s1",
    userId: "u1",
    username: "op_absent",
    roles: ["operatore"],
    permissions: new Set<AppPermission>(),
  };
  await authorizeOperatorPath(opAbsent, "server", "r1", "/upload/test.txt");
  await assertPathAuthorized(opAbsent, "/shared/cfg.json", { auditRepo });
  await assert.rejects(
    () => authorizeOperatorPath(opAbsent, "server", "r1", "/Moliris_audit.zip"),
    (err: any) => err.code === ErrorCode.INSUFFICIENT_PERMISSIONS
  );
  await assert.rejects(
    () => authorizeOperatorPath(opAbsent, "server", "r1", "/"),
    (err: any) => err.code === ErrorCode.INSUFFICIENT_PERMISSIONS
  );
  // Traversal & null byte bloccati
  await assert.rejects(() => authorizeOperatorPath(opAbsent, "server", "r1", "/upload/../etc/passwd"));
  await assert.rejects(() => authorizeOperatorPath(opAbsent, "server", "r1", "/upload/%2e%2e/etc/passwd"));

  // Operatore con allowedPaths esplicitamente vuoto [] -> NON usa defaults (fail-closed totale)
  const opEmpty = {
    sessionId: "s2",
    userId: "u2",
    username: "op_empty",
    roles: ["operatore"],
    permissions: new Set<AppPermission>(),
    allowedPaths: [] as string[],
  };
  await assert.rejects(
    () => authorizeOperatorPath(opEmpty, "server", "r1", "/upload/test.txt"),
    (err: any) => err.code === ErrorCode.INSUFFICIENT_PERMISSIONS
  );
  await assert.rejects(
    () => authorizeOperatorPath(opEmpty, "server", "r1", "/", undefined, { isListingRootAllowed: true }),
    (err: any) => err.code === ErrorCode.INSUFFICIENT_PERMISSIONS
  );
  await assert.rejects(
    () => assertPathAuthorized(opEmpty, "/upload", { auditRepo }),
    (err: any) => err.code === ErrorCode.INSUFFICIENT_PERMISSIONS
  );

  // =========================================================================
  // 2. Unit: ServerFilesystemService distingue undefined vs []
  // =========================================================================
  const serverFs = new ServerFilesystemService(fsRoot, auditRepo, new MolirisLogger(), defaults);
  assert.strictEqual(serverFs.isPathAllowedForOperator("upload/f.txt", []), false);
  assert.strictEqual(serverFs.isPathAllowedForOperator("upload/f.txt", undefined), true);
  assert.strictEqual(serverFs.isPathAllowedForOperator("Moliris_audit.zip", undefined), false);
  assert.strictEqual(serverFs.isPathAllowedForOperator("/", undefined), false);

  // =========================================================================
  // 3. Integrazione HTTP: /api/auth/login, /api/auth/me, FS & Transfer routes
  // =========================================================================
  const userRepo = new InMemoryUserRepository();
  const robotRepo = new InMemoryRobotRepository();
  const opPassHash = await hashPassword("OpSecret123!");
  const adminPassHash = await hashPassword("AdminSecret123!");

  const opPerms = [
    AppPermission.FLEET_VIEW,
    AppPermission.FS_SERVER_NAVIGATE,
    AppPermission.FS_SERVER_UPLOAD,
    AppPermission.FS_SERVER_DOWNLOAD,
    AppPermission.FS_SERVER_DELETE,
    AppPermission.FS_REMOTE_NAVIGATE,
    AppPermission.FS_REMOTE_UPLOAD,
    AppPermission.FS_REMOTE_DOWNLOAD,
    AppPermission.FS_REMOTE_DELETE,
    AppPermission.TRANSFER_SERVER_ROBOT,
    AppPermission.TRANSFER_CLIENT_ROBOT,
  ];

  await userRepo.create({
    id: "op_absent_id",
    username: "op_absent",
    passwordHash: opPassHash,
    roles: ["operatore"],
    enabled: true,
    permissions: opPerms,
    createdAt: new Date(),
    updatedAt: new Date(),
    // allowedPaths intenzionalmente assente (come su NEANTE)
  });

  await userRepo.create({
    id: "op_empty_id",
    username: "op_empty",
    passwordHash: opPassHash,
    roles: ["operatore"],
    enabled: true,
    permissions: opPerms,
    allowedPaths: [], // esplicitamente vuoto
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  await userRepo.create({
    id: "adm_id",
    username: "adm_user",
    passwordHash: adminPassHash,
    roles: ["admin"],
    enabled: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const robotDir = path.join(fsRoot, "op_robot1");
  fs.mkdirSync(path.join(robotDir, "upload"), { recursive: true });
  fs.mkdirSync(path.join(robotDir, "forbidden"), { recursive: true });
  fs.writeFileSync(path.join(robotDir, "Moliris_audit.zip"), "secret-root");
  fs.writeFileSync(path.join(robotDir, "upload", "allowed.txt"), "allowed-data");
  fs.writeFileSync(path.join(robotDir, "forbidden", "secret.txt"), "forbidden-data");

  fs.mkdirSync(path.join(generalRoot, "upload"), { recursive: true });
  fs.mkdirSync(path.join(generalRoot, "private"), { recursive: true });
  fs.writeFileSync(path.join(generalRoot, "Moliris_audit.zip"), "root-general");
  fs.writeFileSync(path.join(generalRoot, "upload", "gen.txt"), "gen-data");

  await robotRepo.create({
    id: "robot1",
    displayName: "Robot 1",
    host: "127.0.0.1",
    sshPort: 22,
    remoteUsername: "op",
    serverDirectoryPath: robotDir,
    sshAuthMethod: "password",
    credentialReference: "cred-robot1",
    anagraphicState: "attivo",
    connectionState: "non_verificato",
    operationalState: null,
    lastValidUpdateAt: null,
    registrationState: "registrazione_completata",
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const certPath = path.join(tmpRoot, "cert.pem");
  const keyPath = path.join(tmpRoot, "key.pem");
  execSync(`openssl req -x509 -newkey rsa:2048 -keyout "${keyPath}" -out "${certPath}" -days 1 -nodes -subj "/CN=localhost"`, {
    stdio: "pipe",
  });
  process.env.MOLIRIS_GENERAL_FS_ROOT = generalRoot;

  const config: SystemConfiguration = {
    credentialProviderType: "in-memory",
    serverFilesystemRoot: fsRoot,
    pollingIntervalSeconds: 10,
    sshConnectionTimeoutMs: 5000,
    maxConcurrentTransfersPerUser: 2,
    maxConcurrentTransfersPerRobot: 2,
    maxConcurrentTransfersServer: 4,
    tempFileRetentionMinutes: 15,
    stateFilePaths: ["/tmp/moliris-state.txt"],
    inactiveSessionTimeoutMinutes: 30,
    tlsCertPath: certPath,
    tlsKeyPath: keyPath,
    auditLogRetentionDays: 30,
    registrationMode: "differita",
    defaultSshPort: 22,
    defaultOperatorAllowedPaths: ["/upload", "/shared", "/logs", "/backups"],
  };

  const app = createServer(config, new MolirisLogger(), {
    userRepository: userRepo,
    robotRepository: robotRepo,
    auditRepository: auditRepo,
  });

  const loginAs = async (username: string, password: string) => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username, password },
    });
    assert.strictEqual(res.statusCode, 200, `Login fallito per ${username}: ${res.body}`);
    const setCookie = res.headers["set-cookie"];
    const cookieStr = Array.isArray(setCookie) ? setCookie[0] : String(setCookie || "");
    const match = /__Host-moliris_session=([^;]+)/.exec(cookieStr);
    assert.ok(match, "Cookie di sessione mancante");
    return {
      cookie: `__Host-moliris_session=${match[1]}`,
      body: JSON.parse(res.body),
    };
  };

  // 3a. Login e /api/auth/me per op_absent e op_empty
  const sessAbsent = await loginAs("op_absent", "OpSecret123!");
  assert.deepStrictEqual(sessAbsent.body.user.allowedPaths, defaults);

  const meAbsent = await app.inject({
    method: "GET",
    url: "/api/auth/me",
    headers: { cookie: sessAbsent.cookie },
  });
  assert.strictEqual(meAbsent.statusCode, 200);
  assert.deepStrictEqual(JSON.parse(meAbsent.body).allowedPaths, defaults);

  const sessEmpty = await loginAs("op_empty", "OpSecret123!");
  assert.deepStrictEqual(sessEmpty.body.user.allowedPaths, []);

  const meEmpty = await app.inject({
    method: "GET",
    url: "/api/auth/me",
    headers: { cookie: sessEmpty.cookie },
  });
  assert.strictEqual(meEmpty.statusCode, 200);
  assert.deepStrictEqual(JSON.parse(meEmpty.body).allowedPaths, []);

  const csrfHeaders = (cookie: string) => ({ cookie, host: "localhost", origin: "https://localhost" });

  // 3b. Operazioni consentite per op_absent dentro /upload
  const listRootRes = await app.inject({
    method: "GET",
    url: "/api/robots/robot1/fs/server/list?path=/",
    headers: { cookie: sessAbsent.cookie },
  });
  assert.strictEqual(listRootRes.statusCode, 200);
  const rootEntries = JSON.parse(listRootRes.body).entries;
  assert.ok(rootEntries.some((e: any) => e.name === "upload"), "La cartella /upload deve essere visibile");
  assert.ok(!rootEntries.some((e: any) => e.name === "Moliris_audit.zip"), "File in / non autorizzato deve essere nascosto");
  assert.ok(!rootEntries.some((e: any) => e.name === "forbidden"), "Cartella /forbidden non autorizzata deve essere nascosta");

  const mkdirAllowed = await app.inject({
    method: "POST",
    url: "/api/robots/robot1/fs/server/mkdir",
    headers: csrfHeaders(sessAbsent.cookie),
    payload: { path: "/upload", folderName: "sub_ok" },
  });
  assert.strictEqual(mkdirAllowed.statusCode, 201, `mkdirAllowed failed: ${mkdirAllowed.statusCode} ${mkdirAllowed.body}`);

  const dlAllowed = await app.inject({
    method: "GET",
    url: "/api/robots/robot1/fs/server/download?path=/upload/allowed.txt",
    headers: { cookie: sessAbsent.cookie },
  });
  assert.strictEqual(dlAllowed.statusCode, 200);

  // 3c. Operazioni negate su / e su percorsi non autorizzati per op_absent
  const dlRootFile = await app.inject({
    method: "GET",
    url: "/api/robots/robot1/fs/server/download?path=/Moliris_audit.zip",
    headers: { cookie: sessAbsent.cookie },
  });
  assert.strictEqual(dlRootFile.statusCode, 403);
  assert.strictEqual(JSON.parse(dlRootFile.body).code, ErrorCode.INSUFFICIENT_PERMISSIONS);

  const mkdirRoot = await app.inject({
    method: "POST",
    url: "/api/robots/robot1/fs/server/mkdir",
    headers: csrfHeaders(sessAbsent.cookie),
    payload: { path: "/", folderName: "bad_root_dir" },
  });
  assert.strictEqual(mkdirRoot.statusCode, 403);
  assert.strictEqual(JSON.parse(mkdirRoot.body).code, ErrorCode.INSUFFICIENT_PERMISSIONS);

  const delForbidden = await app.inject({
    method: "DELETE",
    url: "/api/robots/robot1/fs/server/file?path=/forbidden/secret.txt",
    headers: csrfHeaders(sessAbsent.cookie),
  });
  assert.strictEqual(delForbidden.statusCode, 403);
  assert.strictEqual(JSON.parse(delForbidden.body).code, ErrorCode.INSUFFICIENT_PERMISSIONS);

  // Archivio Generale: lista su /private negata, su /upload consentita
  const genListForbidden = await app.inject({
    method: "GET",
    url: "/api/fs/general/list?path=/private",
    headers: { cookie: sessAbsent.cookie },
  });
  assert.strictEqual(genListForbidden.statusCode, 403);
  assert.strictEqual(JSON.parse(genListForbidden.body).code, ErrorCode.INSUFFICIENT_PERMISSIONS);

  const genListAllowed = await app.inject({
    method: "GET",
    url: "/api/fs/general/list?path=/upload",
    headers: { cookie: sessAbsent.cookie },
  });
  assert.strictEqual(genListAllowed.statusCode, 200);

  // Trasferimenti / Bulk: verifica sia sorgente che destinazione
  const bulkDeniedDest = await app.inject({
    method: "POST",
    url: "/api/transfers/bulk/server-source",
    headers: csrfHeaders(sessAbsent.cookie),
    payload: {
      sourceScope: "server",
      sourceRobotId: "robot1",
      sourcePaths: ["/upload/allowed.txt"],
      targets: [{ type: "general", directory: "/private" }],
    },
  });
  assert.strictEqual(bulkDeniedDest.statusCode, 403);
  assert.strictEqual(JSON.parse(bulkDeniedDest.body).code, ErrorCode.INSUFFICIENT_PERMISSIONS);

  const bulkDeniedSource = await app.inject({
    method: "POST",
    url: "/api/transfers/bulk/server-source",
    headers: csrfHeaders(sessAbsent.cookie),
    payload: {
      sourceScope: "server",
      sourceRobotId: "robot1",
      sourcePaths: ["/forbidden/secret.txt"],
      targets: [{ type: "general", directory: "/upload" }],
    },
  });
  assert.strictEqual(bulkDeniedSource.statusCode, 403);
  assert.strictEqual(JSON.parse(bulkDeniedSource.body).code, ErrorCode.INSUFFICIENT_PERMISSIONS);

  // 3d. op_empty (allowedPaths: []) negato anche su /upload e su list root
  const emptyListRoot = await app.inject({
    method: "GET",
    url: "/api/robots/robot1/fs/server/list?path=/",
    headers: { cookie: sessEmpty.cookie },
  });
  assert.strictEqual(emptyListRoot.statusCode, 403);

  const emptyDl = await app.inject({
    method: "GET",
    url: "/api/robots/robot1/fs/server/download?path=/upload/allowed.txt",
    headers: { cookie: sessEmpty.cookie },
  });
  assert.strictEqual(emptyDl.statusCode, 403);

  // 3e. Admin mantiene accesso completo anche alla radice /
  const sessAdmin = await loginAs("adm_user", "AdminSecret123!");
  const adminDlRoot = await app.inject({
    method: "GET",
    url: "/api/robots/robot1/fs/server/download?path=/Moliris_audit.zip",
    headers: { cookie: sessAdmin.cookie },
  });
  assert.strictEqual(adminDlRoot.statusCode, 200);

  // =========================================================================
  // 4. Frontend path-authorization helper
  // =========================================================================
  assert.strictEqual(isPathAllowedForOperator("/upload/a.txt", defaults), true);
  assert.strictEqual(isPathAllowedForOperator("/upload_other/a.txt", defaults), false);
  assert.strictEqual(isPathAllowedForOperator("/", defaults), false);
  assert.strictEqual(isPathAllowedForOperator("/upload", []), false);
  assert.strictEqual(isPathAllowedForOperator("/upload", undefined), false);
  assert.strictEqual(isPathOrAncestorAllowedForOperator("/data", ["/data/logs"]), true);
  assert.strictEqual(canPerformOperatorPathAction("/", true, defaults), false);
  assert.strictEqual(canPerformOperatorPathAction("/upload", true, defaults), true);
  assert.strictEqual(canPerformOperatorPathAction("/", false, []), true);

  await app.close();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log("PASS: Tutti i test di regressione autorizzazioni operatore superati!");
}

runTests().catch((err) => {
  console.error("FATAL in operator-default-paths-regression.test.ts:", err);
  process.exit(1);
});
