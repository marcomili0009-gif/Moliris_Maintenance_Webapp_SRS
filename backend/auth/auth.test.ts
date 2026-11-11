// Requisiti testati: RF-AUTH-001..006, RNF-SEC-002, RNF-SEC-004, RNF-SEC-009,
// SRS §2.2, §5.1, §6.1, §9, CA-AUTH-001, CA-AUTH-002, CA-AUTH-003, CA-SSH-005

import assert from "assert";
import fs from "fs";
import path from "path";
import os from "os";
import https from "https";
import { execSync } from "child_process";
import { hashPassword, verifyPassword, toUserProfileDto, type UserEntity } from "./user-models.ts";
import { InMemoryUserRepository } from "./user-repository.ts";
import { SessionManager, type SessionTerminationReason } from "./session-manager.ts";
import { AppPermission, hasPermission, type RolePermissionMapping, DEFAULT_ROLE_PERMISSIONS } from "./permissions.ts";
import { InMemoryAuditRepository } from "../../storage/audit-repository.ts";
import { AuditOperation } from "../../storage/audit-models.ts";
import { createServer } from "../server.ts";
import { MolirisLogger } from "../../logging/logger.ts";
import { type SystemConfiguration } from "../../config/configuration.ts";
import { ErrorCode, ERROR_CATALOG } from "../../errors/app-errors.ts";

console.log("--> Esecuzione test modulo autenticazione, sessioni, RBAC e audit...");

// Generazione certificati temporanei per il server HTTPS di test
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "moliris-auth-test-"));
const certPath = path.join(tmpDir, "cert.pem");
const keyPath = path.join(tmpDir, "key.pem");
execSync(`openssl req -x509 -newkey rsa:2048 -keyout "${keyPath}" -out "${certPath}" -days 1 -nodes -subj "/CN=localhost"`, {
  stdio: "pipe",
});

const config: SystemConfiguration = {
  credentialProviderType: "in-memory",
  serverFilesystemRoot: "/home/robots",
  pollingIntervalSeconds: 10,
  sshConnectionTimeoutMs: 5000,
  maxConcurrentTransfersPerUser: 2,
  maxConcurrentTransfersPerRobot: 2,
  maxConcurrentTransfersServer: 10,
  tempFileRetentionMinutes: 60,
  stateFilePaths: ["/tmp/status.txt"],
  inactiveSessionTimeoutMinutes: 30, // RF-AUTH-006: 30 minuti
  tlsCertPath: certPath,
  tlsKeyPath: keyPath,
  registrationMode: "rigorosa",
  auditLogRetentionDays: 90,
  defaultSshPort: 22,
};

const logger = new MolirisLogger();
const userRepo = new InMemoryUserRepository();
const auditRepo = new InMemoryAuditRepository();
const sessionManager = new SessionManager(config.inactiveSessionTimeoutMinutes);

// Tracciamento eventi di terminazione sessione
const terminatedSessions: Array<{ sessionId: string; userId: string; reason: SessionTerminationReason }> = [];
sessionManager.onSessionTerminated((sessionId, userId, reason) => {
  terminatedSessions.push({ sessionId, userId, reason });
});

// Setup utenti di test
const operatorHash = await hashPassword("Operatore123!");
const adminHash = await hashPassword("Admin123!");

const operatorUser: any = {
  id: "user_op_01",
  username: "operatore_test",
  passwordHash: operatorHash,
  roles: ["operatore"],
  enabled: true,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const restrictedUser: any = {
  id: "user_op_restricted",
  username: "operatore_ristretto",
  passwordHash: operatorHash,
  roles: [], // Nessun ruolo globale con TERMINAL_OPEN
  permissions: [AppPermission.FLEET_VIEW], // Solo visualizzazione flotta
  robotPermissions: {
    // Permesso specifico per robot (CA-SSH-005): autorizzato al terminale ESCLUSIVAMENTE per robot_alpha
    robot_alpha: [AppPermission.TERMINAL_OPEN],
  },
  enabled: true,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const adminUser: any = {
  id: "user_adm_01",
  username: "admin_test",
  passwordHash: adminHash,
  roles: ["amministratore"],
  enabled: true,
  createdAt: new Date(),
  updatedAt: new Date(),
};

await userRepo.create(operatorUser);
await userRepo.create(restrictedUser);
await userRepo.create(adminUser);

// 1. Test unitari Hashing Password Sicuro (RNF-SEC-002)
assert(await verifyPassword("Operatore123!", operatorHash), "Verifica password corretta fallita");
assert(!(await verifyPassword("WrongPassword!", operatorHash)), "Verifica password errata non deve passare");
assert(!(await verifyPassword("", operatorHash)), "Password vuota non deve passare");
console.log("  PASS: Hashing scrypt e verifica timing-safe superati.");

// 2. Test RBAC e valutazione permessi con target robot (CA-SSH-005, RNF-SEC-004)
// Operatore standard ha FLEET_VIEW globalmente
assert.strictEqual(hasPermission(operatorUser, AppPermission.FLEET_VIEW), true);
// Operatore standard NON ha ROBOT_REGISTER globalmente (default per operatore)
assert.strictEqual(hasPermission(operatorUser, AppPermission.ROBOT_REGISTER), false);
// Amministratore HA ROBOT_REGISTER globalmente
assert.strictEqual(hasPermission(adminUser, AppPermission.ROBOT_REGISTER), true);

// Verifica CA-SSH-005: Permesso per robot_alpha non vale per robot_beta
assert.strictEqual(hasPermission(restrictedUser, AppPermission.TERMINAL_OPEN, "robot_alpha"), true, "Utente limitato deve poter accedere a robot_alpha");
assert.strictEqual(hasPermission(restrictedUser, AppPermission.TERMINAL_OPEN, "robot_beta"), false, "Utente limitato NON deve poter accedere a robot_beta (CA-SSH-005)");
console.log("  PASS: Valutazione RBAC per profilo e robot specifico (CA-SSH-005) superata.");

// 3. Test configurabilità ruoli e permessi a runtime (senza toccare il codice)
const customRoleMapping: RolePermissionMapping = {
  ...DEFAULT_ROLE_PERMISSIONS,
  operatore: [
    ...DEFAULT_ROLE_PERMISSIONS.operatore,
    AppPermission.ROBOT_CONFIG_UPDATE, // Concessa modifica configurazione anche a operatore
  ],
};
assert.strictEqual(hasPermission(operatorUser, AppPermission.ROBOT_CONFIG_UPDATE, undefined, DEFAULT_ROLE_PERMISSIONS), false);
assert.strictEqual(hasPermission(operatorUser, AppPermission.ROBOT_CONFIG_UPDATE, undefined, customRoleMapping), true);
console.log("  PASS: Permessi modificabili a runtime da configurazione superati.");

// 4. Test server HTTPS con API di Autenticazione
const app = createServer(config, logger, {
  sessionManager,
  userRepository: userRepo,
  auditRepository: auditRepo,
});

await app.listen({ port: 0, host: "127.0.0.1" });
const port = (app.server.address() as any).port;

async function makeHttpsRequest(
  method: string,
  pathName: string,
  body?: any,
  token?: string
): Promise<{ status: number; headers: Record<string, any>; body: any }> {
  return new Promise((resolve, reject) => {
    const postData = body ? JSON.stringify(body) : undefined;
    const reqHeaders: Record<string, string> = {
      ...(postData ? { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(postData)) } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };

    const req = https.request(
      `https://127.0.0.1:${port}${pathName}`,
      {
        method,
        headers: reqHeaders,
        rejectUnauthorized: false,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          let parsed: any = data;
          try {
            parsed = JSON.parse(data);
          } catch {}
          resolve({ status: res.statusCode || 0, headers: res.headers, body: parsed });
        });
      }
    );
    req.on("error", reject);
    if (postData) req.write(postData);
    req.end();
  });
}

// CA-AUTH-001: Utente con credenziali valide accede
const validLoginRes = await makeHttpsRequest("POST", "/api/auth/login", {
  username: "operatore_test",
  password: "Operatore123!",
});
assert.strictEqual(validLoginRes.status, 200, "Login valido deve restituire 200 (CA-AUTH-001)");
assert(validLoginRes.body.sessionToken, "Deve essere presente sessionToken");
assert.strictEqual(validLoginRes.body.user.username, "operatore_test");
// Verifica che passwordHash non sia esposto (RNF-SEC-002)
assert.strictEqual(validLoginRes.body.user.passwordHash, undefined);
const operatorToken = validLoginRes.body.sessionToken;

// Verifica Cookie sicuro
assert(validLoginRes.headers["set-cookie"], "Deve essere impostato il Set-Cookie");
assert(String(validLoginRes.headers["set-cookie"]).includes("moliris_session="));
assert(String(validLoginRes.headers["set-cookie"]).includes("Secure"));
assert(String(validLoginRes.headers["set-cookie"]).includes("HttpOnly"));
console.log("  PASS: Login con credenziali valide e cookie sicuro (CA-AUTH-001) superato.");

// CA-AUTH-002: Credenziali non valide -> nessun accesso
const badPasswordRes = await makeHttpsRequest("POST", "/api/auth/login", {
  username: "operatore_test",
  password: "WrongPassword!",
});
assert.strictEqual(badPasswordRes.status, 401, "Password errata deve restituire 401 (CA-AUTH-002)");
assert.strictEqual(badPasswordRes.body.code, ErrorCode.INVALID_CREDENTIALS);

const badUserRes = await makeHttpsRequest("POST", "/api/auth/login", {
  username: "utente_inesistente",
  password: "AnyPassword123!",
});
assert.strictEqual(badUserRes.status, 401, "Utente inesistente deve restituire 401 (CA-AUTH-002)");
assert.strictEqual(badUserRes.body.code, ErrorCode.INVALID_CREDENTIALS);

// Verifica messaggio identico senza rivelare se è errato username o password (§9)
assert.strictEqual(badPasswordRes.body.message, badUserRes.body.message, "Il messaggio di errore deve essere identico per utente o password errata");
console.log("  PASS: Rifiuto credenziali non valide con messaggio sicuro opaco (CA-AUTH-002) superato.");

// Verifica accesso a endpoint protetto con token valido
const meRes = await makeHttpsRequest("GET", "/api/auth/me", undefined, operatorToken);
assert.strictEqual(meRes.status, 200);
assert.strictEqual(meRes.body.user.username, "operatore_test");

// Verifica accesso a endpoint flotta autorizzato (FLEET_VIEW)
const fleetRes = await makeHttpsRequest("GET", "/api/fleet/summary", undefined, operatorToken);
assert.strictEqual(fleetRes.status, 200, "Operatore deve poter accedere all'elenco flotta");

// CA-AUTH-003: Chiamata senza sessione o token non valido viene rifiutata
const noAuthRes = await makeHttpsRequest("GET", "/api/fleet/summary");
assert.strictEqual(noAuthRes.status, 401, "Richiesta senza sessione deve restituire 401");

const invalidTokenRes = await makeHttpsRequest("GET", "/api/fleet/summary", undefined, "fake_token_12345");
assert.strictEqual(invalidTokenRes.status, 401, "Token non valido deve restituire 401");
console.log("  PASS: Protezione centrale e rifiuto richieste non autenticate (CA-AUTH-003) superato.");

// Test Scadenza Sessione (RF-AUTH-006)
sessionManager._simulateInactivity(operatorToken, 31); // 31 minuti su 30 consentiti
const expiredRes = await makeHttpsRequest("GET", "/api/fleet/summary", undefined, operatorToken);
assert.strictEqual(expiredRes.status, 401, "Sessione inattiva oltre il timeout deve essere rifiutata");
assert(terminatedSessions.some(s => s.sessionId === operatorToken && s.reason === "EXPIRED"), "Hook terminazione deve registrare EXPIRED");
console.log("  PASS: Scadenza sessione per inattività (RF-AUTH-006) superata.");

// Test Logout esplicito (RF-AUTH-004)
const adminLoginRes = await makeHttpsRequest("POST", "/api/auth/login", {
  username: "admin_test",
  password: "Admin123!",
});
const adminToken = adminLoginRes.body.sessionToken;

const logoutRes = await makeHttpsRequest("POST", "/api/auth/logout", undefined, adminToken);
assert.strictEqual(logoutRes.status, 200);
assert(terminatedSessions.some(s => s.sessionId === adminToken && s.reason === "LOGOUT"), "Hook terminazione deve registrare LOGOUT");

// Tentativo di riuso del token dopo il logout
const afterLogoutRes = await makeHttpsRequest("GET", "/api/fleet/summary", undefined, adminToken);
assert.strictEqual(afterLogoutRes.status, 401, "Token invalidato dopo logout non deve consentire accessi");
console.log("  PASS: Logout esplicito e invalidazione immediata lato server (RF-AUTH-004) superati.");

// Test Verifica Eventi di Audit registrati (RNF-SEC-009, §10.4)
const auditEvents = await auditRepo.query();
assert(auditEvents.length >= 4, "Devono essere presenti eventi di audit per login, logout e errori sicurezza");
const hasLoginSuccess = auditEvents.some(e => e.operation === AuditOperation.AUTH_LOGIN && e.outcome === "SUCCESS");
const hasLoginFailure = auditEvents.some(e => e.operation === AuditOperation.AUTH_LOGIN && e.outcome === "FAILURE");
const hasLogout = auditEvents.some(e => e.operation === AuditOperation.AUTH_LOGOUT && e.outcome === "SUCCESS");
const hasSecurityError = auditEvents.some(e => e.operation === AuditOperation.SECURITY_AUTHORIZATION_ERROR);

assert(hasLoginSuccess, "Manca evento audit login successo");
assert(hasLoginFailure, "Manca evento audit login fallito");
assert(hasLogout, "Manca evento audit logout");
assert(hasSecurityError, "Manca evento audit sicurezza");

// Verifica rigorosa: nessun segreto nei log di audit
for (const event of auditEvents) {
  const jsonStr = JSON.stringify(event);
  assert(!jsonStr.includes("Operatore123!"), "Password operatore presente nell'audit!");
  assert(!jsonStr.includes("Admin123!"), "Password admin presente nell'audit!");
  assert(!jsonStr.includes("WrongPassword!"), "Password errata presente nell'audit!");
}
console.log("  PASS: Eventi di audit verificati ed esenti da segreti (RNF-SEC-009, §10.4).");

// Test File statici Frontend in HTTPS (§2.5, §5.1)
const indexRes = await makeHttpsRequest("GET", "/");
assert.strictEqual(indexRes.status, 200);
assert(String(indexRes.body).includes("Moliris Maintenance Webapp"));

const appJsRes = await makeHttpsRequest("GET", "/app.js");
assert.strictEqual(appJsRes.status, 200);
assert(String(appJsRes.body).includes("addEventListener"));

const cssRes = await makeHttpsRequest("GET", "/styles.css");
assert.strictEqual(cssRes.status, 200);
console.log("  PASS: Frontend client statico servito in HTTPS.");

for (let i = 0; i < 10; i++) {
  const limited = await makeHttpsRequest("POST", "/api/auth/login", {
    username: "admin_test",
    password: `bad-${i}`,
  });
  assert.strictEqual(limited.status, 401);
}
const rateLimitedRes = await makeHttpsRequest("POST", "/api/auth/login", {
  username: "admin_test",
  password: "Admin123!",
});
assert.strictEqual(rateLimitedRes.status, 429);
assert(Number(rateLimitedRes.headers["retry-after"]) > 0);
console.log("  PASS: Limitazione tentativi di login e intestazione Retry-After.");

// Chiusura del server
await app.close();
fs.rmSync(tmpDir, { recursive: true, force: true });

console.log("PASS: Tutti i test di autenticazione, sessione, autorizzazione e sicurezza completati con successo.");
