// Test di validazione E2E: Logout reale, invalidazione server-side, cancellazione cookie e persistenza dopo reload (F5)

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { once } from "node:events";
import { PassThrough, Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import https from "node:https";
import WebSocket from "ws";
import { createServer } from "../../backend/server.ts";
import { SessionManager } from "../../backend/auth/session-manager.ts";
import { InMemoryUserRepository } from "../../backend/auth/user-repository.ts";
import { InMemoryAuditRepository } from "../../storage/audit-repository.ts";
import { AuditOperation } from "../../storage/audit-models.ts";
import { hashPassword } from "../../backend/auth/user-models.ts";
import { MolirisLogger } from "../../logging/logger.ts";
import { loadAndValidateConfig } from "../../config/configuration.ts";
import { loadConfig } from "../../src/config/index.ts";
import { ServerFilesystemService } from "../../storage/server-fs.ts";
import { type TransferService } from "../../backend/transfer/transfer-service.ts";
import { TransferStatus } from "../../backend/transfer/transfer-models.ts";
import { ErrorCode } from "../../errors/app-errors.ts";

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
  MOLIRIS_SESSION_ABSOLUTE_MAX_MIN: "2",
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
const sessionMgr = new SessionManager(config.inactiveSessionTimeoutMinutes, config.sessionAbsoluteMaxMinutes);
const previousGeneralRoot = process.env.MOLIRIS_GENERAL_FS_ROOT;
const generalRoot = path.join(tmpFsRoot, "test-general");
process.env.MOLIRIS_GENERAL_FS_ROOT = generalRoot;
const serverFsService = new ServerFilesystemService(tmpFsRoot, auditRepo, logger);
if (previousGeneralRoot === undefined) delete process.env.MOLIRIS_GENERAL_FS_ROOT;
else process.env.MOLIRIS_GENERAL_FS_ROOT = previousGeneralRoot;

await userRepo.create({
  id: "user-logout-test",
  username: "test_logout_user",
  passwordHash: await hashPassword("ValidPassword123!"),
  roles: ["admin"],
  enabled: true,
  createdAt: new Date(),
  updatedAt: new Date(),
});

const app = createServer(config, logger, {
  userRepository: userRepo,
  auditRepository: auditRepo,
  sessionManager: sessionMgr,
  serverFsService,
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

// Apri uno stream con una sessione valida e verifica che il logout lo chiuda.
const address = await app.listen({ host: "127.0.0.1", port: 0 });
async function openTestStream(cookie: string) {
  let streamEnded!: (status: string) => void;
  let messages = "";
  const streamEnd = new Promise<string>((resolve) => { streamEnded = resolve; });
  await new Promise<void>((resolve, reject) => {
    const request = https.get(`${address}/api/transfers/stream`, {
      headers: { cookie },
      rejectUnauthorized: false,
      signal: AbortSignal.timeout(6000),
    }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`Stream SSE HTTP ${response.statusCode}`));
        return;
      }
      response.on("data", (chunk) => {
        messages += chunk.toString();
        resolve();
      });
      response.once("end", () => streamEnded("end"));
      response.once("error", () => streamEnded("error"));
      response.resume();
    });
    request.once("error", (error) => {
      reject(error);
      streamEnded("error");
    });
  });
  return { ended: streamEnd, snapshotCount: () => messages.match(/event: snapshot/g)?.length ?? 0 };
}
const { ended: streamEnd, snapshotCount } = await openTestStream(sessionCookie);
await new Promise<void>((resolve) => setTimeout(resolve, 1250));
assert.equal(snapshotCount(), 1, "Uno storico invariato non deve essere ritrasmesso");

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
assert.equal(await streamEnd, "end", "Il logout deve terminare lo stream SSE");
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

const loginForExpiry = await app.inject({
  method: "POST", url: "/api/auth/login",
  payload: { username: "test_logout_user", password: "ValidPassword123!" },
});
assert.equal(loginForExpiry.statusCode, 200);
const expiryId = String(loginForExpiry.headers["set-cookie"]).match(/__Host-moliris_session=([^;]+)/)?.[1];
assert.ok(expiryId);
const expiredStream = await openTestStream(`__Host-moliris_session=${expiryId}`);
sessionMgr._simulateInactivity(expiryId, config.inactiveSessionTimeoutMinutes + 1);
assert.equal(await expiredStream.ended, "end", "Lo stream deve chiudersi quando la sessione scade");
console.log("PASS: Stream SSE chiuso al logout e alla scadenza della sessione.");

// Tetto assoluto con SSE, terminale WebSocket e upload realmente aperti.
const loginForAbsoluteTimeout = await app.inject({
  method: "POST", url: "/api/auth/login",
  payload: { username: "test_logout_user", password: "ValidPassword123!" },
});
assert.equal(loginForAbsoluteTimeout.statusCode, 200);
const absoluteId = String(loginForAbsoluteTimeout.headers["set-cookie"]).match(/__Host-moliris_session=([^;]+)/)?.[1];
assert.ok(absoluteId);
const absoluteCookie = `__Host-moliris_session=${absoluteId}`;
const user = await userRepo.findById("user-logout-test");
const absoluteSession = sessionMgr.validate(absoluteId);
assert.ok(user && absoluteSession);
const context = sessionMgr.createAuthorizedContext(absoluteSession, user);
const transferService = app.getDecorator<TransferService>("transferService");
const terminal = await app.inject({
  method: "POST", url: "/api/server/terminal/sessions",
  headers: { cookie: absoluteCookie, host: new URL(address).host, origin: address },
});
assert.equal(terminal.statusCode, 201, terminal.body);
const terminalId = terminal.json<{ sessionId: string }>().sessionId;
const socket = new WebSocket(`${address.replace(/^https:/, "wss:")}/api/terminal/ws/${terminalId}`, {
  rejectUnauthorized: false,
  headers: { Origin: address, cookie: absoluteCookie },
});
try {
  const [initialFrame] = await once(socket, "message", { signal: AbortSignal.timeout(4000) });
  assert.doesNotMatch(initialFrame.toString(), /"type":"error"/);
  const terminalClosed = once(socket, "close", { signal: AbortSignal.timeout(6000) });
  // Attacca subito la gestione del rigetto per i fallimenti di altre asserzioni.
  void terminalClosed.catch(() => {});

  const destinationName = "preserve-on-expiry.txt";
  const destination = path.join(generalRoot, destinationName);
  await fs.promises.writeFile(destination, "originale integro");
  const input = new PassThrough();
  const upload = transferService.executeGeneralUpload(context, destinationName, input, { overwrite: true })
    .then(() => "completed", () => "interrupted");
  input.write(Buffer.alloc(64 * 1024, 42));
  const waitFor = async (condition: () => boolean) => {
    const limit = performance.now() + 3500;
    while (!condition()) {
      assert.ok(performance.now() < limit, "Condizione di collaudo non raggiunta");
      await delay(15);
    }
  };
  try {
    await waitFor(() => fs.readdirSync(generalRoot).some((file) => file.startsWith(".tmp_moliris_")));
    assert.equal(transferService.getActiveTransfersCountForSession(absoluteId), 1);
    const stream = await openTestStream(absoluteCookie);
    const heartbeatBefore = await app.inject({
      method: "POST", url: "/api/auth/heartbeat",
      headers: { cookie: absoluteCookie, host: new URL(address).host, origin: address },
    });
    assert.equal(heartbeatBefore.statusCode, 200);
    sessionMgr._simulateAge(absoluteId, 2);
    assert.equal(await stream.ended, "end", "Lo SSE deve chiudersi al limite assoluto durante l'upload");
    const [closeCode, closeReason] = await terminalClosed;
    assert.equal(closeCode, 1000);
    assert.equal(closeReason.toString(), "USER_SESSION_TERMINATED");
    assert.equal(await Promise.race([upload, delay(3500, "timeout", { ref: false })]), "interrupted");
    assert.equal(transferService.listTransfers(context).find((item) => item.filename === destinationName)?.status, TransferStatus.CANCELLED);
    await waitFor(() => !fs.readdirSync(generalRoot).some((file) => file.startsWith(".tmp_moliris_")));
    assert.equal(await fs.promises.readFile(destination, "utf8"), "originale integro");
    for (const [method, url] of [["POST", "/api/auth/heartbeat"], ["GET", "/api/fleet/summary"]] as const) {
      const denied = await app.inject({
        method, url,
        headers: { cookie: absoluteCookie, host: new URL(address).host, origin: address },
      });
      assert.equal(denied.statusCode, 401, url);
    }
    await assert.rejects(
      transferService.executeGeneralUpload(context, "expired-start.txt", Readable.from(["inutile"])),
      { code: ErrorCode.INVALID_CREDENTIALS },
    );
    const events = await auditRepo.query();
    assert.ok(events.some((event) => event.details?.reason === "ABSOLUTE_TIMEOUT"));
  } finally {
    input.destroy();
  }
} finally {
  socket.terminate();
}
console.log("PASS: Scadenza assoluta chiude SSE e WebSocket, blocca nuove operazioni e annulla l'upload senza toccare il file esistente.");

await app.close();
sessionMgr.dispose();
try {
  fs.rmSync(tmpFsRoot, { recursive: true, force: true });
  if (tmpCertDir) {
    fs.rmSync(tmpCertDir, { recursive: true, force: true });
  }
} catch {}
console.log("PASS: Test di validazione Logout e Non-Persistenza al Reload completato con successo al 100%.");
