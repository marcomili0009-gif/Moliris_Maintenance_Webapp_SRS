// Test di validazione di sicurezza e affidabilità: Sessioni Contemporanee con lo Stesso Account
// Verifica conformità a SRS v1.0 (§2, §6.1, RF-AUTH-001..006, RNF-REL-005) e DECISIONS.md (Decisions 18, 19)

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { createServer } from "../../backend/server.ts";
import { SessionManager } from "../../backend/auth/session-manager.ts";
import { InMemoryUserRepository } from "../../backend/auth/user-repository.ts";
import { InMemoryAuditRepository } from "../../storage/audit-repository.ts";
import { hashPassword } from "../../backend/auth/user-models.ts";
import { MolirisLogger } from "../../logging/logger.ts";
import { loadAndValidateConfig } from "../../config/configuration.ts";
import { loadConfig } from "../../src/config/index.ts";

console.log("--> Esecuzione suite di test completa: Gestione Sessioni Contemporanee Multi-Dispositivo...");

// Setup certificati TLS
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
    tmpCertDir = fs.mkdtempSync(path.join(os.tmpdir(), "moliris-concurrent-cert-"));
    certPath = path.join(tmpCertDir, "cert.pem");
    keyPath = path.join(tmpCertDir, "key.pem");
    execSync(`openssl req -x509 -newkey rsa:2048 -keyout "${keyPath}" -out "${certPath}" -days 1 -nodes -subj "/CN=localhost"`, {
      stdio: "pipe",
    });
  }
}

const tmpFsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "moliris-concurrent-test-fs-"));

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
  MOLIRIS_MAX_SESSIONS_PER_ACCOUNT: "3", // Esplicito valore 3
};

const config = loadAndValidateConfig(env);
const appConfig = loadConfig();
const logger = new MolirisLogger();

// Verifichiamo che appConfig rilevi maxSessionsPerAccount = 3
assert.strictEqual(
  appConfig.maxSessionsPerAccount,
  3,
  "appConfig.maxSessionsPerAccount deve essere configurato a 3"
);
assert.strictEqual(
  appConfig.futureExtensions.maxSessionsPerAccount,
  3,
  "appConfig.futureExtensions.maxSessionsPerAccount deve essere sincronizzato a 3"
);

const userRepo = new InMemoryUserRepository();
const auditRepo = new InMemoryAuditRepository();
const sessionMgr = new SessionManager(config.inactiveSessionTimeoutMinutes);

await userRepo.create({
  id: "user-shared-account",
  username: "shared_operator",
  passwordHash: await hashPassword("SharedPass123!"),
  roles: ["operatore", "admin"],
  enabled: true,
  createdAt: new Date(),
  updatedAt: new Date(),
});

await userRepo.create({
  id: "user-race-account",
  username: "race_operator",
  passwordHash: await hashPassword("RacePass123!"),
  roles: ["operatore"],
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

function extractSessionCookie(res: any): string {
  const setCookieHeader = String(res.headers["set-cookie"] || "");
  const match = setCookieHeader.match(/__Host-moliris_session=([^;]+)/);
  if (!match) {
    throw new Error("Cookie __Host-moliris_session non trovato nella risposta");
  }
  return `__Host-moliris_session=${match[1]}`;
}

function extractSessionId(cookieStr: string): string {
  return cookieStr.replace("__Host-moliris_session=", "");
}

// -------------------------------------------------------------
// SCENARIO 1: Primo login con lo stesso account (Dispositivo A)
// -------------------------------------------------------------
console.log("1. Test primo login (Dispositivo A)...");
const loginDevA = await app.inject({
  method: "POST",
  url: "/api/auth/login",
  headers: { host: "127.0.0.1:3000", origin: "https://127.0.0.1:3000" },
  payload: { username: "shared_operator", password: "SharedPass123!" },
});
assert.strictEqual(loginDevA.statusCode, 200, "Dispositivo A deve loggarsi con successo (200)");
const cookieDevA = extractSessionCookie(loginDevA);
const idDevA = extractSessionId(cookieDevA);
assert.strictEqual(sessionMgr.getActiveSessionsCount("user-shared-account"), 1, "Sessioni attive per l'account devono essere 1");

// -------------------------------------------------------------
// SCENARIO 2: Secondo login con lo stesso account (Dispositivo B)
// -------------------------------------------------------------
console.log("2. Test secondo login (Dispositivo B)...");
const loginDevB = await app.inject({
  method: "POST",
  url: "/api/auth/login",
  headers: { host: "127.0.0.1:3000", origin: "https://127.0.0.1:3000" },
  payload: { username: "shared_operator", password: "SharedPass123!" },
});
assert.strictEqual(loginDevB.statusCode, 200, "Dispositivo B deve loggarsi con successo (200)");
const cookieDevB = extractSessionCookie(loginDevB);
const idDevB = extractSessionId(cookieDevB);
assert.notStrictEqual(idDevA, idDevB, "Dispositivo B deve ricevere un Session ID distinto da Dispositivo A");
assert.strictEqual(sessionMgr.getActiveSessionsCount("user-shared-account"), 2, "Sessioni attive per l'account devono essere 2");

// -------------------------------------------------------------
// SCENARIO 3: Terzo login con lo stesso account (Dispositivo C)
// -------------------------------------------------------------
console.log("3. Test terzo login (Dispositivo C)...");
const loginDevC = await app.inject({
  method: "POST",
  url: "/api/auth/login",
  headers: { host: "127.0.0.1:3000", origin: "https://127.0.0.1:3000" },
  payload: { username: "shared_operator", password: "SharedPass123!" },
});
assert.strictEqual(loginDevC.statusCode, 200, "Dispositivo C deve loggarsi con successo (200)");
const cookieDevC = extractSessionCookie(loginDevC);
const idDevC = extractSessionId(cookieDevC);
assert.notStrictEqual(idDevC, idDevA, "Dispositivo C deve avere un Session ID distinto da A");
assert.notStrictEqual(idDevC, idDevB, "Dispositivo C deve avere un Session ID distinto da B");
assert.strictEqual(sessionMgr.getActiveSessionsCount("user-shared-account"), 3, "Sessioni attive per l'account devono essere 3");

// -------------------------------------------------------------
// SCENARIO 4: Quarto login rifiutato (Dispositivo D)
// -------------------------------------------------------------
console.log("4. Test quarto login oltre limite (Dispositivo D)...");
const loginDevD = await app.inject({
  method: "POST",
  url: "/api/auth/login",
  headers: { host: "127.0.0.1:3000", origin: "https://127.0.0.1:3000" },
  payload: { username: "shared_operator", password: "SharedPass123!" },
});
assert.strictEqual(loginDevD.statusCode, 409, "Quarto login deve essere rifiutato con HTTP 409 Conflict");
const bodyDevD = JSON.parse(loginDevD.body);
assert.strictEqual(bodyDevD.code, "SESSION_ALREADY_ACTIVE", "Codice errore deve essere SESSION_ALREADY_ACTIVE");
assert.strictEqual(sessionMgr.getActiveSessionsCount("user-shared-account"), 3, "Il conteggio sessioni deve rimanere a 3");

// -------------------------------------------------------------
// SCENARIO 5: Logout del dispositivo A senza disconnettere B e C
// -------------------------------------------------------------
console.log("5. Test logout dispositivo A e verifica indipendenza dispositivi B e C...");
const logoutDevA = await app.inject({
  method: "POST",
  url: "/api/auth/logout",
  headers: { host: "127.0.0.1:3000", origin: "https://127.0.0.1:3000", cookie: cookieDevA },
  payload: { context: "sessione", reason: "MANUAL_LOGOUT" },
});
assert.strictEqual(logoutDevA.statusCode, 200, "Logout dispositivo A deve restituire 200");
assert.strictEqual(sessionMgr.getSession(idDevA), null, "Sessione A deve essere rimossa lato server");

// Verifica che il dispositivo A non possa più accedere con la vecchia sessione
const meDevAAfterLogout = await app.inject({
  method: "GET",
  url: "/api/auth/me",
  headers: { cookie: cookieDevA },
});
assert.strictEqual(meDevAAfterLogout.statusCode, 401, "Dispositivo A disconnesso deve ricevere 401");

// Verifica che i dispositivi B e C continuino a funzionare normalmente
const meDevB = await app.inject({
  method: "GET",
  url: "/api/auth/me",
  headers: { cookie: cookieDevB },
});
assert.strictEqual(meDevB.statusCode, 200, "Dispositivo B deve rimanere autenticato (200)");
assert.strictEqual(JSON.parse(meDevB.body).user.username, "shared_operator");

const meDevC = await app.inject({
  method: "GET",
  url: "/api/auth/me",
  headers: { cookie: cookieDevC },
});
assert.strictEqual(meDevC.statusCode, 200, "Dispositivo C deve rimanere autenticato (200)");
assert.strictEqual(JSON.parse(meDevC.body).user.username, "shared_operator");
assert.strictEqual(sessionMgr.getActiveSessionsCount("user-shared-account"), 2, "Sessioni attive residue devono essere 2");

// -------------------------------------------------------------
// SCENARIO 6: Logout del dispositivo B senza disconnettere C
// -------------------------------------------------------------
console.log("6. Test logout dispositivo B e verifica persistenza dispositivo C...");
const logoutDevB = await app.inject({
  method: "POST",
  url: "/api/auth/logout",
  headers: { host: "127.0.0.1:3000", origin: "https://127.0.0.1:3000", cookie: cookieDevB },
  payload: { context: "sessione", reason: "MANUAL_LOGOUT" },
});
assert.strictEqual(logoutDevB.statusCode, 200, "Logout dispositivo B deve restituire 200");
assert.strictEqual(sessionMgr.getSession(idDevB), null, "Sessione B deve essere rimossa lato server");

const meDevCAgain = await app.inject({
  method: "GET",
  url: "/api/auth/me",
  headers: { cookie: cookieDevC },
});
assert.strictEqual(meDevCAgain.statusCode, 200, "Dispositivo C deve continuare a funzionare regolarmente dopo il logout di B");
assert.strictEqual(sessionMgr.getActiveSessionsCount("user-shared-account"), 1, "Sessioni attive residue devono essere 1 (solo C)");

// -------------------------------------------------------------
// SCENARIO 7: Nuovo login dopo aver liberato una sessione
// -------------------------------------------------------------
console.log("7. Test nuovo login dopo aver liberato posti sessione...");
const reLoginDevA = await app.inject({
  method: "POST",
  url: "/api/auth/login",
  headers: { host: "127.0.0.1:3000", origin: "https://127.0.0.1:3000" },
  payload: { username: "shared_operator", password: "SharedPass123!" },
});
assert.strictEqual(reLoginDevA.statusCode, 200, "Nuovo login deve avere successo dopo liberazione sessioni");
const newCookieDevA = extractSessionCookie(reLoginDevA);
const newIdDevA = extractSessionId(newCookieDevA);
assert.notStrictEqual(newIdDevA, idDevA, "Il nuovo login di A deve generare un nuovo Session ID crittograficamente sicuro");
assert.strictEqual(sessionMgr.getActiveSessionsCount("user-shared-account"), 2, "Sessioni attive ora devono essere 2 (C e nuova A)");

// -------------------------------------------------------------
// SCENARIO 8: Validità dei token/cookie degli altri dispositivi dopo il logout
// -------------------------------------------------------------
console.log("8. Test validità chiamate protette per gli altri dispositivi...");
const fleetResC = await app.inject({
  method: "GET",
  url: "/api/fleet/summary",
  headers: { cookie: cookieDevC },
});
assert.strictEqual(fleetResC.statusCode, 200, "Dispositivo C deve poter accedere a /api/fleet/summary senza problemi");

const fleetResA = await app.inject({
  method: "GET",
  url: "/api/fleet/summary",
  headers: { cookie: newCookieDevA },
});
assert.strictEqual(fleetResA.statusCode, 200, "Nuova sessione di Dispositivo A deve poter accedere a /api/fleet/summary");

// -------------------------------------------------------------
// SCENARIO 9: Accessi simultanei senza superare il limite (Race Conditions)
// -------------------------------------------------------------
console.log("9. Test tentativi di login concorrenti simultanei (Promise.all)...");
// Effettuiamo 6 richieste simultanee di login per 'race_operator' che ha limite 3
const concurrentPromises = Array.from({ length: 6 }).map(() =>
  app.inject({
    method: "POST",
    url: "/api/auth/login",
    headers: { host: "127.0.0.1:3000", origin: "https://127.0.0.1:3000" },
    payload: { username: "race_operator", password: "RacePass123!" },
  })
);

const concurrentResults = await Promise.all(concurrentPromises);
const successfulLogins = concurrentResults.filter((r) => r.statusCode === 200);
const rejectedLogins = concurrentResults.filter((r) => r.statusCode === 409);

assert.strictEqual(
  successfulLogins.length,
  3,
  `Esattamente 3 login simultanei devono avere successo (ottenuto: ${successfulLogins.length})`
);
assert.strictEqual(
  rejectedLogins.length,
  3,
  `Esattamente 3 login simultanei devono essere rifiutati con 409 (ottenuto: ${rejectedLogins.length})`
);
assert.strictEqual(
  sessionMgr.getActiveSessionsCount("user-race-account"),
  3,
  "Il conteggio delle sessioni registrate in memoria deve essere esattamente 3"
);

// -------------------------------------------------------------
// SCENARIO 10: Logout ripetuti senza errori (Idempotenza)
// -------------------------------------------------------------
console.log("10. Test logout ripetuti della stessa sessione (Idempotenza)...");
const firstLogout = await app.inject({
  method: "POST",
  url: "/api/auth/logout",
  headers: { host: "127.0.0.1:3000", origin: "https://127.0.0.1:3000", cookie: cookieDevC },
  payload: { context: "sessione", reason: "MANUAL_LOGOUT" },
});
assert.strictEqual(firstLogout.statusCode, 200, "Primo logout deve restituire 200");

const secondLogout = await app.inject({
  method: "POST",
  url: "/api/auth/logout",
  headers: { host: "127.0.0.1:3000", origin: "https://127.0.0.1:3000", cookie: cookieDevC },
  payload: { context: "sessione", reason: "MANUAL_LOGOUT" },
});
assert.strictEqual(secondLogout.statusCode, 200, "Secondo logout ripetuto non deve lanciare errori e restituire 200");
const thirdLogout = await app.inject({
  method: "POST",
  url: "/api/auth/logout",
  headers: { host: "127.0.0.1:3000", origin: "https://127.0.0.1:3000" },
  payload: { context: "sessione", reason: "MANUAL_LOGOUT" },
});
assert.strictEqual(thirdLogout.statusCode, 200, "Logout senza cookie/token deve restituire 200 in modo pulito");

// -------------------------------------------------------------
// SCENARIO 11: Sessioni scadute o non più valide pulite senza impattare le sessioni attive
// -------------------------------------------------------------
console.log("11. Test pruning sessioni scadute ed isolamento da sessioni valide...");
const userObj = {
  id: "user-shared-account",
  username: "shared_operator",
  passwordHash: "dummyHash",
  roles: ["operatore", "admin"],
  enabled: true,
  createdAt: new Date(),
  updatedAt: new Date(),
};
// Creiamo una sessione manualmente e ne simuliamo l'inattività oltre timeout
const expiredSession = sessionMgr.createSession(userObj, 5, 10);
sessionMgr._simulateInactivity(expiredSession.sessionId, 35);

// newCookieDevA è invece attiva e recente
const validSession = sessionMgr.getSession(newIdDevA);
assert(validSession !== null, "La sessione valida newIdDevA deve esistere");

// Eseguiamo la pulizia delle sessioni inattive
const prunedCount = sessionMgr.pruneExpiredSessions();
assert(prunedCount >= 1, "Almeno una sessione scaduta deve essere stata rimossa dal pruning");
assert.strictEqual(sessionMgr.getSession(expiredSession.sessionId), null, "La sessione scaduta deve essere null");
assert(sessionMgr.getSession(newIdDevA) !== null, "La sessione valida attiva non deve essere influenzata");

// -------------------------------------------------------------
// SCENARIO 12: Comportamento dopo il riavvio del backend
// -------------------------------------------------------------
console.log("12. Test riavvio del backend (RAM volatile e ripristino fail-closed)...");
// Chiudiamo l'app corrente per simulare lo stop del server
await app.close();

// Creiamo una nuova istanza server con un nuovo SessionManager (memoria volatile pulita)
const rebootedSessionMgr = new SessionManager(config.inactiveSessionTimeoutMinutes);
const rebootedApp = createServer(config, logger, {
  userRepository: userRepo,
  auditRepository: auditRepo,
  sessionManager: rebootedSessionMgr,
  appConfig,
});
await rebootedApp.ready();

// 12a: I vecchi cookie pre-riavvio devono essere respinti con 401 Fail-Closed
const postRebootCheck = await rebootedApp.inject({
  method: "GET",
  url: "/api/auth/me",
  headers: { cookie: newCookieDevA },
});
assert.strictEqual(
  postRebootCheck.statusCode,
  401,
  "Dopo il riavvio, i vecchi identificatori di sessione in RAM devono essere invalidi (401)"
);

// 12b: Nuovi tentativi di login post-riavvio devono funzionare regolarmente fino a maxSessionsPerAccount (3)
const postRebootLogin1 = await rebootedApp.inject({
  method: "POST",
  url: "/api/auth/login",
  headers: { host: "127.0.0.1:3000", origin: "https://127.0.0.1:3000" },
  payload: { username: "shared_operator", password: "SharedPass123!" },
});
assert.strictEqual(postRebootLogin1.statusCode, 200, "Post-riavvio: login 1 deve avere successo (200)");

const postRebootLogin2 = await rebootedApp.inject({
  method: "POST",
  url: "/api/auth/login",
  headers: { host: "127.0.0.1:3000", origin: "https://127.0.0.1:3000" },
  payload: { username: "shared_operator", password: "SharedPass123!" },
});
assert.strictEqual(postRebootLogin2.statusCode, 200, "Post-riavvio: login 2 deve avere successo (200)");

const postRebootLogin3 = await rebootedApp.inject({
  method: "POST",
  url: "/api/auth/login",
  headers: { host: "127.0.0.1:3000", origin: "https://127.0.0.1:3000" },
  payload: { username: "shared_operator", password: "SharedPass123!" },
});
assert.strictEqual(postRebootLogin3.statusCode, 200, "Post-riavvio: login 3 deve avere successo (200)");

const postRebootLogin4 = await rebootedApp.inject({
  method: "POST",
  url: "/api/auth/login",
  headers: { host: "127.0.0.1:3000", origin: "https://127.0.0.1:3000" },
  payload: { username: "shared_operator", password: "SharedPass123!" },
});
assert.strictEqual(postRebootLogin4.statusCode, 409, "Post-riavvio: login 4 deve essere respinto con 409");

await rebootedApp.close();

// Cleanup cartelle temporanee
try {
  fs.rmSync(tmpFsRoot, { recursive: true, force: true });
  if (tmpCertDir) {
    fs.rmSync(tmpCertDir, { recursive: true, force: true });
  }
} catch {}

console.log("PASS: Tutti i 12 scenari obbligatori per le sessioni contemporanee sono stati verificati con successo!");
