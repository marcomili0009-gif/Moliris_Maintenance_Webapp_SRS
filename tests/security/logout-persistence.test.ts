// Test di validazione E2E: Logout reale, invalidazione server-side, cancellazione cookie e persistenza dopo reload (F5)

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import Fastify from "fastify";
import { createServer } from "../../backend/server.ts";
import { SessionManager } from "../../backend/auth/session-manager.ts";
import { InMemoryUserRepository } from "../../backend/auth/user-repository.ts";
import { InMemoryAuditRepository } from "../../storage/audit-repository.ts";
import { AuditOperation } from "../../storage/audit-models.ts";
import { hashPassword } from "../../backend/auth/user-models.ts";
import { MolirisLogger } from "../../logging/logger.ts";
import { loadAndValidateConfig } from "../../config/configuration.ts";
import { loadConfig } from "../../src/config/index.ts";

console.log("--> Esecuzione test di validazione Logout e Non-Persistenza al Reload (F5)...");

const projectCertPath = path.resolve(process.cwd(), "certs/server.crt");
const projectKeyPath = path.resolve(process.cwd(), "certs/server.key");
let certPath = process.env.MOLIRIS_TLS_CERT_PATH;
let keyPath = process.env.MOLIRIS_TLS_KEY_PATH;
let tmpCertDir: string | null = null;

if (!certPath || !keyPath || !fs.existsSync(certPath) || !fs.existsSync(keyPath)) {
  if (fs.existsSync(projectCertPath) && fs.existsSync(projectKeyPath)) {
    certPath = projectCertPath;
    keyPath = projectKeyPath;
  } else {
    tmpCertDir = fs.mkdtempSync(path.join(os.tmpdir(), "moliris-logout-cert-"));
    certPath = path.join(tmpCertDir, "cert.pem");
    keyPath = path.join(tmpCertDir, "key.pem");
    execSync(`openssl req -x509 -newkey rsa:2048 -keyout "${keyPath}" -out "${certPath}" -days 1 -nodes -subj "/CN=localhost"`, {
      stdio: "pipe",
    });
  }
}

const tmpFsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "moliris-logout-test-fs-"));

const env = {
  ...process.env,
  MOLIRIS_FS_ROOT: tmpFsRoot,
  MOLIRIS_POLLING_INTERVAL_SEC: "60",
  MOLIRIS_SSH_TIMEOUT_MS: "5000",
  MOLIRIS_MAX_TRF_PER_USER: "2",
  MOLIRIS_MAX_TRF_PER_ROBOT: "2",
  MOLIRIS_MAX_TRF_SERVER: "5",
  MOLIRIS_TEMP_RETENTION_MIN: "60",
  MOLIRIS_STATE_FILE_PATHS: "/tmp/state.json",
  MOLIRIS_SESSION_TIMEOUT_MIN: "30",
  MOLIRIS_TLS_CERT_PATH: certPath,
  MOLIRIS_TLS_KEY_PATH: keyPath,
  MOLIRIS_REGISTRATION_MODE: "rigorosa",
  MOLIRIS_AUDIT_RETENTION_DAYS: "365",
  MOLIRIS_CREDENTIAL_PROVIDER: "in-memory",
};

const config = loadAndValidateConfig(env);
const appConfig = loadConfig();
const logger = new MolirisLogger();

const userRepo = new InMemoryUserRepository();
const auditRepo = new InMemoryAuditRepository();
const sessionMgr = new SessionManager(config.inactiveSessionTimeoutMinutes);

await userRepo.create({
  id: "user-logout-test",
  username: "test_logout_user",
  passwordHash: await hashPassword("ValidPassword123!"),
  roles: ["amministratore"],
  enabled: true,
  createdAt: new Date(),
  updatedAt: new Date(),
});

const app = createServer(config, logger, {
  userRepository: userRepo,
  auditRepository: auditRepo,
  sessionManager: sessionMgr,
  appConfig,
});

await app.ready();

// 1. Login con credenziali valide
const loginRes = await app.inject({
  method: "POST",
  url: "/api/auth/login",
  headers: {
    host: "127.0.0.1:3000",
    origin: "https://127.0.0.1:3000",
  },
  payload: {
    username: "test_logout_user",
    password: "ValidPassword123!",
  },
});

assert.strictEqual(loginRes.statusCode, 200, "Login deve avere successo con codice 200");
const setCookieHeader = String(loginRes.headers["set-cookie"]);
assert(setCookieHeader.includes("__Host-moliris_session="), "Set-Cookie deve essere presente");
assert(setCookieHeader.includes("SameSite=Strict"), "Cookie deve essere SameSite=Strict");
assert(setCookieHeader.includes("HttpOnly"), "Cookie deve essere HttpOnly");
assert(setCookieHeader.includes("Secure"), "Cookie deve essere Secure");

const sessionCookieMatch = setCookieHeader.match(/__Host-moliris_session=([^;]+)/);
assert(sessionCookieMatch, "Cookie __Host-moliris_session deve essere estratto");
const sessionCookie = `__Host-moliris_session=${sessionCookieMatch[1]}`;

// 2. Chiamata a /api/auth/me prima del logout -> deve restituire 200 OK
const meBeforeRes = await app.inject({
  method: "GET",
  url: "/api/auth/me",
  headers: {
    cookie: sessionCookie,
  },
});
assert.strictEqual(meBeforeRes.statusCode, 200, "Prima del logout /api/auth/me deve restituire 200");
const meBeforeData = JSON.parse(meBeforeRes.body);
assert.strictEqual(meBeforeData.user.username, "test_logout_user", "Username deve coincidere");

// Simula un lookup già in corso e una scrittura audit MongoDB lenta.
const originalFindById = userRepo.findById.bind(userRepo);
const originalRecord = auditRepo.record.bind(auditRepo);
let releaseLookup!: () => void;
let announceLookup!: () => void;
let releaseAudit!: () => void;
let announceAuditWritten!: () => void;
const lookupGate = new Promise<void>((resolve) => { releaseLookup = resolve; });
const lookupStarted = new Promise<void>((resolve) => { announceLookup = resolve; });
const auditGate = new Promise<void>((resolve) => { releaseAudit = resolve; });
const auditWritten = new Promise<void>((resolve) => { announceAuditWritten = resolve; });
userRepo.findById = async (id) => {
  announceLookup();
  await lookupGate;
  return originalFindById(id);
};
auditRepo.record = async (event) => {
  if (event.operation !== AuditOperation.AUTH_LOGOUT) return originalRecord(event);
  await auditGate;
  const persisted = await originalRecord(event);
  announceAuditWritten();
  return persisted;
};
const pendingMe = app.inject({
  method: "GET",
  url: "/api/auth/me",
  headers: { cookie: sessionCookie },
}).then((response) => response);
await lookupStarted;

// 3. Il logout deve rispondere e scadere il cookie mentre l'audit è ancora bloccato.
const pendingLogout = app.inject({
  method: "POST",
  url: "/api/auth/logout",
  headers: {
    host: "127.0.0.1:3000",
    origin: "https://127.0.0.1:3000",
    cookie: sessionCookie,
  },
  payload: {
    context: "sessione",
    reason: "MANUAL_LOGOUT",
  },
}).then((response) => response);
let responseTimeout: ReturnType<typeof setTimeout> | undefined;
const logoutRes = await Promise.race([
  pendingLogout,
  new Promise<never>((_, reject) => {
    responseTimeout = setTimeout(() => reject(new Error("Il logout attende la scrittura audit")), 2000);
  }),
]).finally(() => {
  clearTimeout(responseTimeout);
  releaseLookup();
  releaseAudit();
});
assert.strictEqual((await pendingMe).statusCode, 401, "Anche un controllo avviato prima della revoca deve essere respinto");
await auditWritten;

assert.strictEqual(logoutRes.statusCode, 200, "Logout deve restituire status 200 OK");
const logoutSetCookie = String(logoutRes.headers["set-cookie"]);
assert(logoutSetCookie.includes("Max-Age=0"), "Set-Cookie di logout deve contenere Max-Age=0 per cancellare il cookie");
assert(logoutSetCookie.includes("Expires=Thu, 01 Jan 1970"), "Set-Cookie deve contenere data nel passato");
assert(logoutSetCookie.includes("SameSite=Strict"), "Set-Cookie di logout deve avere gli stessi attributi SameSite=Strict");
assert(logoutSetCookie.includes("HttpOnly"), "Set-Cookie di logout deve avere HttpOnly");
assert(logoutSetCookie.includes("Secure"), "Set-Cookie di logout deve avere Secure");
assert.strictEqual(logoutRes.headers["cache-control"], "no-store, no-cache, must-revalidate, proxy-revalidate");

// 4. Verifica che la sessione sia stata invalidata ed eliminata lato server
const sessionAfter = sessionMgr.getSession(sessionCookieMatch[1]);
assert.strictEqual(sessionAfter, null, "La sessione deve essere stata distrutta in SessionManager");

// 5. Verifica che qualunque richiesta successiva con il vecchio cookie/token restituisca 401 Unauthorized
const meAfterRes = await app.inject({
  method: "GET",
  url: "/api/auth/me",
  headers: {
    cookie: sessionCookie,
  },
});
assert.strictEqual(meAfterRes.statusCode, 401, "Dopo il logout, /api/auth/me con il vecchio cookie DEVE restituire 401");

const fleetAfterRes = await app.inject({
  method: "GET",
  url: "/api/fleet/summary",
  headers: {
    cookie: sessionCookie,
  },
});
assert.strictEqual(fleetAfterRes.statusCode, 401, "Dopo il logout, endpoint protetti con il vecchio cookie DEVONO restituire 401");
assert.strictEqual(fleetAfterRes.headers["cache-control"], "no-store");

// 6. Verifica audit log dell'operazione di logout
const auditEvents = await auditRepo.query({ userId: "test_logout_user" });
const logoutAudit = auditEvents.find((e) => e.operation === "AUTH_LOGOUT" && e.outcome === "SUCCESS");
assert(logoutAudit, "L'evento di logout deve essere registrato nell'audit log con outcome SUCCESS");
assert.strictEqual(logoutAudit.details?.context, "sessione");
assert.strictEqual(logoutAudit.details?.reason, "MANUAL_LOGOUT");

await app.close();
try {
  fs.rmSync(tmpFsRoot, { recursive: true, force: true });
  if (tmpCertDir) {
    fs.rmSync(tmpCertDir, { recursive: true, force: true });
  }
} catch {}
console.log("PASS: Test di validazione Logout e Non-Persistenza al Reload completato con successo al 100%.");
