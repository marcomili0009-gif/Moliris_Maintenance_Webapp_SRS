// Requisiti verificati: SRS v1.0 §2 "File di Configurazione (config)",
// RNF-MNT-001, §6 "Concorrenza e Controllo delle Sessioni",
// maxConcurrentWebUsers, maxSessionsPerAccount

import assert from "assert";
import fs from "fs";
import path from "path";
import os from "os";
import https from "https";
import { execSync } from "child_process";
import { createServer } from "../../backend/server.ts";
import { loadConfig } from "../../src/config/index.ts";
import { SessionManager } from "../../backend/auth/session-manager.ts";
import { InMemoryUserRepository } from "../../backend/auth/user-repository.ts";
import { InMemoryAuditRepository } from "../../storage/audit-repository.ts";
import { hashPassword } from "../../backend/auth/user-models.ts";
import { MolirisLogger } from "../../logging/logger.ts";
import { type SystemConfiguration } from "../../config/configuration.ts";

console.log("--> Esecuzione test verifica caricamento configurazione e concorrenza sessioni...");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "moliris-config-concurrency-test-"));
const certPath = path.join(tmpDir, "cert.pem");
const keyPath = path.join(tmpDir, "key.pem");
execSync(`openssl req -x509 -newkey rsa:2048 -keyout "${keyPath}" -out "${certPath}" -days 1 -nodes -subj "/CN=localhost"`, {
  stdio: "pipe",
});

const testSysConfig: SystemConfiguration = {
  serverFilesystemRoot: tmpDir,
  pollingIntervalSeconds: 10,
  sshConnectionTimeoutMs: 5000,
  defaultSshPort: 22,
  maxConcurrentTransfersPerUser: 2,
  maxConcurrentTransfersPerRobot: 2,
  maxConcurrentTransfersServer: 10,
  tempFileRetentionMinutes: 60,
  stateFilePaths: ["/tmp/test-status.txt"],
  inactiveSessionTimeoutMinutes: 30,
  sessionInactivityWarningMinutes: 5,
  tlsCertPath: certPath,
  tlsKeyPath: keyPath,
  registrationMode: "rigorosa",
  auditLogRetentionDays: 30,
};

const logger = new MolirisLogger();

// -----------------------------------------------------------------------------
// TEST 1: Verifica caricamento config con maxConcurrentWebUsers: 2 e maxSessionsPerAccount: 2
// -----------------------------------------------------------------------------
{
  const customConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "moliris-custom-json-"));
  const jsonPath = path.join(customConfigDir, "config.json");
  fs.writeFileSync(
    jsonPath,
    JSON.stringify({
      maxConcurrentWebUsers: 2,
      futureExtensions: {
        maxSessionsPerAccount: 2,
      },
    }),
    "utf-8"
  );

  const loaded = loadConfig({ configPath: jsonPath, env: {} });
  assert.strictEqual(loaded.maxConcurrentWebUsers, 2, "maxConcurrentWebUsers deve essere 2");
  assert.strictEqual(loaded.futureExtensions.maxSessionsPerAccount, 2, "maxSessionsPerAccount deve essere 2");
  assert.strictEqual(loaded.loadedConfigPath, jsonPath, "loadedConfigPath deve puntare al file caricato");

  fs.rmSync(customConfigDir, { recursive: true, force: true });
  console.log("  PASS: Test 1 - loadConfig carica correttamente config.json con parametri personalizzati.");
}

// -----------------------------------------------------------------------------
// TEST 2: Verifica applicazione di maxSessionsPerAccount: 2 sul backend (2 sessioni ammesse per lo stesso utente)
// -----------------------------------------------------------------------------
{
  const userRepo = new InMemoryUserRepository();
  const testPassword = "Password123!";
  const pHash = await hashPassword(testPassword);
  await userRepo.create({
    id: "user_multi",
    username: "utente_multiplo",
    passwordHash: pHash,
    roles: ["operatore"],
    enabled: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const sessionManager = new SessionManager(30, 1440);
  const auditRepo = new InMemoryAuditRepository();

  const appConfig = loadConfig({
    overrides: {
      maxConcurrentWebUsers: 10,
      futureExtensions: {
        maxSessionsPerAccount: 2,
        maxFleetRobots: 100,
        customSettings: {},
      },
    },
  });

  const app = createServer(testSysConfig, logger, {
    sessionManager,
    userRepository: userRepo,
    auditRepository: auditRepo,
    appConfig,
  });

  await app.listen({ port: 0, host: "127.0.0.1" });
  const port = (app.server.address() as any).port;

  async function login() {
    return new Promise<{ status: number; body: any }>((resolve, reject) => {
      const payload = JSON.stringify({ username: "utente_multiplo", password: testPassword });
      const req = https.request(
        `https://127.0.0.1:${port}/api/auth/login`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(payload),
          },
          rejectUnauthorized: false,
        },
        (res) => {
          let data = "";
          res.on("data", (c) => (data += c));
          res.on("end", () => {
            try {
              resolve({ status: res.statusCode || 500, body: JSON.parse(data) });
            } catch {
              resolve({ status: res.statusCode || 500, body: data });
            }
          });
        }
      );
      req.on("error", reject);
      req.write(payload);
      req.end();
    });
  }

  // Login 1: deve avere successo
  const login1 = await login();
  assert.strictEqual(login1.status, 200, "Primo login per lo stesso account deve riuscire");

  // Login 2: con maxSessionsPerAccount: 2 DEVE AVERE SUCCESSO
  const login2 = await login();
  assert.strictEqual(login2.status, 200, "Secondo login per lo stesso account deve riuscire con maxSessionsPerAccount: 2");

  // Login 3: deve fallire con HTTP 409 SESSION_ALREADY_ACTIVE
  const login3 = await login();
  assert.strictEqual(login3.status, 409, "Terzo login deve essere respinto con 409");
  assert.strictEqual(login3.body.code, "SESSION_ALREADY_ACTIVE");

  await app.close();
  console.log("  PASS: Test 2 - maxSessionsPerAccount: 2 consente esattamente 2 sessioni per lo stesso utente e blocca la terza.");
}

// -----------------------------------------------------------------------------
// TEST 3: Verifica applicazione di maxConcurrentWebUsers: 2 sul backend (limite globale)
// -----------------------------------------------------------------------------
{
  const userRepo = new InMemoryUserRepository();
  const testPassword = "Password123!";
  const pHash = await hashPassword(testPassword);
  await userRepo.create({
    id: "user_a",
    username: "utente_a",
    passwordHash: pHash,
    roles: ["operatore"],
    enabled: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await userRepo.create({
    id: "user_b",
    username: "utente_b",
    passwordHash: pHash,
    roles: ["operatore"],
    enabled: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await userRepo.create({
    id: "user_c",
    username: "utente_c",
    passwordHash: pHash,
    roles: ["operatore"],
    enabled: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const sessionManager = new SessionManager(30, 1440);
  const auditRepo = new InMemoryAuditRepository();

  const appConfig = loadConfig({
    overrides: {
      maxConcurrentWebUsers: 2, // Limite globale di 2 utenti totali
      futureExtensions: {
        maxSessionsPerAccount: 5,
        maxFleetRobots: 100,
        customSettings: {},
      },
    },
  });

  const app = createServer(testSysConfig, logger, {
    sessionManager,
    userRepository: userRepo,
    auditRepository: auditRepo,
    appConfig,
  });

  await app.listen({ port: 0, host: "127.0.0.1" });
  const port = (app.server.address() as any).port;

  async function loginAs(user: string) {
    return new Promise<{ status: number; body: any }>((resolve, reject) => {
      const payload = JSON.stringify({ username: user, password: testPassword });
      const req = https.request(
        `https://127.0.0.1:${port}/api/auth/login`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(payload),
          },
          rejectUnauthorized: false,
        },
        (res) => {
          let data = "";
          res.on("data", (c) => (data += c));
          res.on("end", () => {
            try {
              resolve({ status: res.statusCode || 500, body: JSON.parse(data) });
            } catch {
              resolve({ status: res.statusCode || 500, body: data });
            }
          });
        }
      );
      req.on("error", reject);
      req.write(payload);
      req.end();
    });
  }

  // Utente A si collega: 1 sessione attiva su 2 massime
  const resA = await loginAs("utente_a");
  assert.strictEqual(resA.status, 200, "Login utente A deve riuscire");

  // Utente B si collega: 2 sessioni attive su 2 massime
  const resB = await loginAs("utente_b");
  assert.strictEqual(resB.status, 200, "Login utente B deve riuscire");

  // Utente C si collega: limite globale raggiunto (maxConcurrentWebUsers: 2) -> HTTP 503
  const resC = await loginAs("utente_c");
  assert.strictEqual(resC.status, 503, "Login utente C deve fallire con 503 per limite utenti web contemporanei");
  assert.strictEqual(resC.body.code, "MAX_CONCURRENT_WEB_USERS_REACHED");

  await app.close();
  console.log("  PASS: Test 3 - maxConcurrentWebUsers limita rigidamente il numero totale di utenti web contemporanei.");
}

// -----------------------------------------------------------------------------
// TEST 4: Verifica endpoint /api/config/public con activeConfigFile e metadati
// -----------------------------------------------------------------------------
{
  const sessionManager = new SessionManager(30, 1440);
  const userRepo = new InMemoryUserRepository();
  const auditRepo = new InMemoryAuditRepository();

  const appConfig = loadConfig({
    overrides: {
      maxConcurrentWebUsers: 15,
      futureExtensions: {
        maxSessionsPerAccount: 3,
        maxFleetRobots: 100,
        customSettings: {},
      },
    },
  });

  const app = createServer(testSysConfig, logger, {
    sessionManager,
    userRepository: userRepo,
    auditRepository: auditRepo,
    appConfig,
  });

  const res = await app.inject({ method: "GET", url: "/api/config/public" });
  assert.strictEqual(res.statusCode, 200);
  const data = res.json();
  assert.strictEqual(data.maxConcurrentWebUsers, 15);
  assert.strictEqual(data.maxSessionsPerAccount, 3);
  assert.strictEqual(typeof data.activeConfigFile, "string");

  await app.close();
  console.log("  PASS: Test 4 - /api/config/public espone correttamente activeConfigFile e parametri attivi.");
}

// Pulizia cartella temporanea
fs.rmSync(tmpDir, { recursive: true, force: true });
console.log("PASS: Tutti i test di verifica configurazione e concorrenza sessioni superati con successo!");
