// Requisiti: RNF-SEC-001, SRS §2.4 vincolo 3

import assert from "assert";
import fs from "fs";
import path from "path";
import os from "os";
import https from "https";
import { execSync } from "child_process";
import { createServer } from "./server.ts";
import { MolirisLogger } from "../logging/logger.ts";
import { type SystemConfiguration } from "../config/configuration.ts";

console.log("--> Esecuzione test backend HTTPS e endpoint /healthz...");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "moliris-tls-test-"));
const certPath = path.join(tmpDir, "cert.pem");
const keyPath = path.join(tmpDir, "key.pem");

// Generazione certificati autofirmati temporanei per il test HTTPS
execSync(`openssl req -x509 -newkey rsa:2048 -keyout "${keyPath}" -out "${certPath}" -days 1 -nodes -subj "/CN=localhost"`, {
  stdio: "pipe",
});

// Test 1: Fallimento se certificati TLS sono mancanti
const invalidConfig: SystemConfiguration = {
  serverFilesystemRoot: "/home/robots",
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

// Test 2: Avvio server HTTPS e verifica endpoint /healthz (RNF-SEC-001)
const validConfig: SystemConfiguration = {
  ...invalidConfig,
  tlsCertPath: certPath,
  tlsKeyPath: keyPath,
};

const server = createServer(validConfig, logger);
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

// Chiusura del server
await server.close();

// Cleanup
fs.rmSync(tmpDir, { recursive: true, force: true });

console.log("PASS: Test server HTTPS e /healthz completato con successo.");
