// Requisiti: RNF-SEC-001, SRS §2.4 vincolo 3

import assert from "assert";
import fs from "fs";
import path from "path";
import os from "os";
import https from "https";
import { execSync } from "child_process";
import { createServer, resolveFrontendDistDir } from "./server.ts";
import { MolirisLogger } from "../logging/logger.ts";
import { type SystemConfiguration } from "../config/configuration.ts";

console.log("--> Esecuzione test backend HTTPS e endpoint /healthz...");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "moliris-tls-test-"));
const certPath = path.join(tmpDir, "cert.pem");
const keyPath = path.join(tmpDir, "key.pem");
const testServerFs = path.join(tmpDir, "server-fs");
const testGeneralFs = path.join(tmpDir, "general-fs");
fs.mkdirSync(testServerFs, { recursive: true });
fs.mkdirSync(testGeneralFs, { recursive: true });
process.env.MOLIRIS_GENERAL_FS_ROOT = testGeneralFs;

// Generazione certificati autofirmati temporanei per il test HTTPS
execSync(`openssl req -x509 -newkey rsa:2048 -keyout "${keyPath}" -out "${certPath}" -days 1 -nodes -subj "/CN=localhost"`, {
  stdio: "pipe",
});

// Test 1: Fallimento se certificati TLS sono mancanti
const invalidConfig: SystemConfiguration = {
  credentialProviderType: "in-memory",
  serverFilesystemRoot: testServerFs,
  pollingIntervalSeconds: 10,
  sshConnectionTimeoutMs: 5000,
  maxConcurrentTransfersPerUser: 2,
  maxConcurrentTransfersPerRobot: 2,
  maxConcurrentTransfersServer: 10,
  tempFileRetentionMinutes: 60,
  stateFilePaths: ["/tmp/status.txt"],
  inactiveSessionTimeoutMinutes: 30,
  tlsCertPath: "/percorso/inesistente/cert.pem",
  tlsKeyPath: "/percorso/inesistente/key.pem",
  registrationMode: "rigorosa",
  auditLogRetentionDays: 90,
  defaultSshPort: 22,
};

const logger = new MolirisLogger();
try {
  createServer(invalidConfig, logger);
  assert.fail("Avrebbe dovuto fallire per certificati TLS mancanti");
} catch (err: any) {
  assert(err.message.includes("File certificato o chiave TLS mancante"));
}

console.log("PASS: Test verifica certificati TLS mancanti superato.");

// Il bundle Node viene emesso in dist/backend e deve continuare a trovare
// gli asset sibling in dist/frontend, oltre alla modalità tsx da backend/.
const projectRoot = path.resolve(import.meta.dirname, "..");
assert.strictEqual(
  resolveFrontendDistDir(path.join(projectRoot, "dist", "backend")),
  path.join(projectRoot, "dist", "frontend"),
  "Il server compilato deve risolvere la directory dist/frontend"
);

// Test 2: Avvio server HTTPS e verifica endpoint /healthz (RNF-SEC-001)
const validConfig: SystemConfiguration = {
  ...invalidConfig,
  tlsCertPath: certPath,
  tlsKeyPath: keyPath,
};

const server = createServer(validConfig, logger);

// Test BUG-03: Registrazione route per verificare gestione globale errori Fastify (RNF-SEC-002)
server.get("/test-unhandled-error", async () => {
  throw new Error("Errore critico interno con dati riservati: /var/secret/path");
});

assert(server.hasDecorator("appConfig"), "Il server Fastify deve avere il decoratore 'appConfig'");
assert.strictEqual(server.appConfig.sessionInactivityTimeoutMinutes, 30);
assert.strictEqual(server.appConfig.maxFileUploadBytes, 3 * 1024 * 1024 * 1024);
assert.strictEqual(server.appConfig.bulkUploadConfig.chunkSizeBytes, 2 * 1024 * 1024);

const publicConfigResponse = await server.inject({
  method: "GET",
  url: "/api/config/public",
});
assert.strictEqual(publicConfigResponse.statusCode, 200, "La configurazione pubblica deve essere leggibile");
const publicConfig = publicConfigResponse.json();
assert.strictEqual(publicConfig.sessionInactivityTimeoutMinutes, server.appConfig.sessionInactivityTimeoutMinutes);
assert.strictEqual(publicConfig.sshTerminalActiveTimeoutMinutes, 15);
assert.strictEqual(publicConfig.maxConcurrentWebUsers, server.appConfig.maxConcurrentWebUsers);
assert.strictEqual(publicConfig.maxConcurrentTerminalsPerRobot, server.appConfig.maxConcurrentTerminalsPerRobot);
assert.strictEqual(publicConfig.maxSessionsPerAccount, server.appConfig.futureExtensions.maxSessionsPerAccount);
assert.strictEqual(publicConfig.activeConfigFile, undefined, "Il nome del file di configurazione non deve essere pubblico");
assert.strictEqual(publicConfig.activeConfigPath, undefined, "Il path di configurazione non deve essere pubblico");
assert.strictEqual(publicConfig.allowedPaths, undefined, "I path ammessi non devono essere pubblici");
assert.strictEqual(publicConfig.bulkUploadConfig.allowedSubPaths, undefined, "I path bulk non devono essere pubblici");
assert.strictEqual(publicConfig.bulkUploadConfig.maxConcurrentFiles, 20);
assert.strictEqual(publicConfig.customSettings, undefined, "Le impostazioni estese non devono essere esposte pubblicamente");
assert.strictEqual(publicConfig.futureExtensions?.customSettings, undefined, "futureExtensions.customSettings non deve essere esposto pubblicamente");
assert.strictEqual(publicConfig.transferResumeEnabled, true, "transferResumeEnabled deve riflettere config.json");

const frontendResponse = await server.inject({ method: "GET", url: "/" });
assert.strictEqual(frontendResponse.statusCode, 200, "La route root deve servire la build React");
assert.match(frontendResponse.body, /assets\/index-[^"]+\.js/);

const address = await server.listen({ port: 0, host: "127.0.0.1" });
const port = (server.server.address() as any).port;

assert(address.startsWith("https://"), `Il server deve essere raggiungibile solo via HTTPS: ${address}`);

// Richiesta client HTTPS all'endpoint /healthz
await new Promise<void>((resolve, reject) => {
  const req = https.get(
    `https://127.0.0.1:${port}/healthz`,
    { rejectUnauthorized: false }, // Certificato autofirmato locale per il test
    (res) => {
      assert.strictEqual(res.statusCode, 200, "L'endpoint /healthz deve restituire status 200");
      assert.strictEqual(res.headers["x-content-type-options"], "nosniff");
      assert.strictEqual(res.headers["x-frame-options"], "DENY");
      assert.strictEqual(res.headers["referrer-policy"], "no-referrer");
      assert(String(res.headers["content-security-policy"]).includes("frame-ancestors 'none'"));
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        const payload = JSON.parse(data);
        assert.strictEqual(payload.status, "OK");
        assert(payload.timestamp, "Deve essere presente il timestamp");
        // Verifica che non contenga dati sensibili
        assert(!payload.config, "Non devono essere esposte configurazioni");
        assert(!payload.robot, "Non devono essere esposti dettagli robot");
        resolve();
      });
    }
  );
  req.on("error", reject);
});

// Test 3: Verifica rotta asset statici /assets/:filename con Content-Type per immagini PNG
const distAssetsDir = path.join(import.meta.dirname, "..", "dist", "frontend", "assets");
fs.mkdirSync(distAssetsDir, { recursive: true });
const testPngPath = path.join(distAssetsDir, "test-asset-route.png");
fs.writeFileSync(testPngPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

try {
  const assetResponse = await server.inject({
    method: "GET",
    url: "/assets/test-asset-route.png",
  });
  assert.strictEqual(assetResponse.statusCode, 200, "La rotta /assets deve restituire 200 per file PNG esistenti");
  assert.strictEqual(assetResponse.headers["content-type"], "image/png", "Il Content-Type deve essere image/png");

  // Test BUG-02: Rifiuto path traversal su /assets/:filename
  const traversalDot = await server.inject({ method: "GET", url: "/assets/." });
  assert.strictEqual(traversalDot.statusCode, 404, "Accesso a '.' deve restituire 404");

  const traversalDots = await server.inject({ method: "GET", url: "/assets/..something" });
  assert.strictEqual(traversalDots.statusCode, 404, "Accesso traversal con '..' deve restituire 404");

  const traversalEncoded = await server.inject({ method: "GET", url: "/assets/%2e%2e%2fpackage.json" });
  assert.strictEqual(traversalEncoded.statusCode, 404, "Accesso traversal encoded deve restituire 404");

  // Test BUG-02: Accesso a directory non deve causare EISDIR o 500
  const subDir = path.join(distAssetsDir, "test-subdir");
  fs.mkdirSync(subDir, { recursive: true });
  try {
    const dirResponse = await server.inject({ method: "GET", url: "/assets/test-subdir" });
    assert.strictEqual(dirResponse.statusCode, 404, "Accesso a directory su /assets deve restituire 404");
  } finally {
    if (fs.existsSync(subDir)) fs.rmdirSync(subDir);
  }

  // Test BUG-02: Symlink esterno deve essere respinto
  const symlinkPath = path.join(distAssetsDir, "test-symlink.png");
  try {
    fs.symlinkSync(keyPath, symlinkPath);
    const symlinkResponse = await server.inject({ method: "GET", url: "/assets/test-symlink.png" });
    assert.strictEqual(symlinkResponse.statusCode, 404, "Symlink verso file esterno deve essere respinto con 404");
  } catch (err: any) {
    // Alcuni ambienti non permettono symlink; se fallisce la creazione del link proseguiamo
  } finally {
    if (fs.existsSync(symlinkPath)) fs.unlinkSync(symlinkPath);
  }
} finally {
  if (fs.existsSync(testPngPath)) {
    fs.unlinkSync(testPngPath);
  }
}

// Test BUG-03: Verifica gestione globale errori Fastify (RNF-SEC-002: nessun leak di stack trace o info interne)
const errorResponse = await server.inject({
  method: "GET",
  url: "/test-unhandled-error",
});
assert.strictEqual(errorResponse.statusCode, 500, "Errore non gestito deve produrre 500");
const errorJson = errorResponse.json();
assert.strictEqual(errorJson.code, "INTERNAL_SERVER_ERROR", "Codice errore standardizzato");
assert.ok(!JSON.stringify(errorJson).includes("secret"), "Nessun dato riservato deve essere presente nel payload di risposta");
assert.ok(!("stack" in errorJson), "Nessuno stack trace deve essere presente nella risposta");

// Chiusura del server
await server.close();

// Cleanup
fs.rmSync(tmpDir, { recursive: true, force: true });

console.log("PASS: Test server HTTPS e /healthz completato con successo.");
