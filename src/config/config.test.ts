// Requisiti verificati: SRS v1.0 §2 "File di Configurazione (config)",
// RNF-MNT-001, RNF-SEC-004, RNF-PERF-001, RNF-REL-004, RF-TRF-001..005, RF-SSH-001..008

import assert from "assert";
import fs from "fs";
import os from "os";
import path from "path";
import Fastify from "fastify";
import {
  loadConfig,
  ConfigError,
  ConfigValidationError,
  configPlugin,
  registerAppConfig,
} from "./index.ts";

console.log("--> Esecuzione test unitari Modulo di Configurazione (SRS §2)...");

// =========================================================================
// TEST 1: Caricamento corretto dei valori di default se omessi
// =========================================================================
{
  const config = loadConfig({ env: {}, overrides: {} });

  assert.strictEqual(config.sessionInactivityTimeoutMinutes, 30, "Default sessionInactivityTimeoutMinutes deve essere 30");
  assert.strictEqual(config.sshTerminalActiveTimeoutMinutes, 60, "Default sshTerminalActiveTimeoutMinutes deve essere 60");
  assert.strictEqual(config.maxConcurrentWebUsers, 10, "Default maxConcurrentWebUsers deve essere 10");
  assert.strictEqual(config.maxConcurrentTerminalsPerRobot, 1, "Default maxConcurrentTerminalsPerRobot deve essere 1");

  assert.strictEqual(config.bulkUploadConfig.maxConcurrentFiles, 20, "Default maxConcurrentFiles deve essere 20");
  assert.strictEqual(config.bulkUploadConfig.chunkSizeBytes, 2 * 1024 * 1024, "Default chunkSizeBytes deve essere 2MB");
  assert.deepStrictEqual(
    config.bulkUploadConfig.allowedSubPaths,
    ["upload", "shared", "logs", "backups", "configs"],
    "Default allowedSubPaths deve contenere i percorsi standard"
  );

  assert.strictEqual(config.maxFileUploadBytes, 3 * 1024 * 1024 * 1024, "Default maxFileUploadBytes deve essere 3 GB");
  assert.strictEqual(config.futureExtensions.maxFleetRobots, 100, "Default maxFleetRobots deve essere 100");
  assert.strictEqual(config.futureExtensions.maxSessionsPerAccount, 3, "Default maxSessionsPerAccount deve essere 3");
  assert.deepStrictEqual(config.futureExtensions.customSettings, {}, "Default customSettings deve essere un oggetto vuoto");

  assert(Object.isFrozen(config), "L'oggetto configurazione deve essere immutabile (frozen)");

  console.log("  PASS: Test 1 - Caricamento corretto dei valori di default se omessi.");
}

// =========================================================================
// TEST 2: Fallimento immediato se parametri numerici sono fuori range
// =========================================================================
{
  // 2a. Concurrency < 1 (es. 0 o negativo)
  assert.throws(
    () => loadConfig({ env: {}, overrides: { maxConcurrentWebUsers: 0 } }),
    (err: any) => {
      assert(err instanceof ConfigValidationError);
      assert(err.issues.some((i: any) => i.path.includes("maxConcurrentWebUsers")));
      return true;
    },
    "maxConcurrentWebUsers < 1 deve fallire immediatamente all'avvio"
  );

  assert.throws(
    () => loadConfig({ env: {}, overrides: { maxConcurrentWebUsers: -5 } }),
    (err: any) => {
      assert(err instanceof ConfigValidationError);
      return true;
    },
    "maxConcurrentWebUsers negativo deve fallire"
  );

  // 2b. Timeout inattività sessione negativo o zero
  assert.throws(
    () => loadConfig({ env: {}, overrides: { sessionInactivityTimeoutMinutes: 0 } }),
    (err: any) => {
      assert(err instanceof ConfigValidationError);
      assert(err.issues.some((i: any) => i.path.includes("sessionInactivityTimeoutMinutes")));
      return true;
    },
    "sessionInactivityTimeoutMinutes < 1 deve fallire all'avvio"
  );

  assert.throws(
    () => loadConfig({ env: {}, overrides: { sessionInactivityTimeoutMinutes: -30 } }),
    (err: any) => {
      assert(err instanceof ConfigValidationError);
      return true;
    },
    "sessionInactivityTimeoutMinutes negativo deve fallire"
  );

  // 2c. Timeout terminale SSH watchdog negativo o zero
  assert.throws(
    () => loadConfig({ env: {}, overrides: { sshTerminalActiveTimeoutMinutes: -1 } }),
    (err: any) => {
      assert(err instanceof ConfigValidationError);
      assert(err.issues.some((i: any) => i.path.includes("sshTerminalActiveTimeoutMinutes")));
      return true;
    },
    "sshTerminalActiveTimeoutMinutes negativo deve fallire"
  );

  // 2d. Concorrenza terminali per robot fuori range (< 1 o > 10)
  assert.throws(
    () => loadConfig({ env: {}, overrides: { maxConcurrentTerminalsPerRobot: 0 } }),
    (err: any) => {
      assert(err instanceof ConfigValidationError);
      assert(err.issues.some((i: any) => i.path.includes("maxConcurrentTerminalsPerRobot")));
      return true;
    },
    "maxConcurrentTerminalsPerRobot < 1 deve fallire"
  );

  assert.throws(
    () => loadConfig({ env: {}, overrides: { maxConcurrentTerminalsPerRobot: 99 } }),
    (err: any) => {
      assert(err instanceof ConfigValidationError);
      assert(err.issues.some((i: any) => i.path.includes("maxConcurrentTerminalsPerRobot")));
      return true;
    },
    "maxConcurrentTerminalsPerRobot > 10 deve fallire"
  );

  // 2e. bulkUploadConfig fuori range (chunk size < 64KB o maxConcurrentFiles < 1)
  assert.throws(
    () =>
      loadConfig({
        env: {},
        overrides: {
          bulkUploadConfig: {
            maxConcurrentFiles: 0,
            chunkSizeBytes: 2 * 1024 * 1024,
            allowedSubPaths: ["upload"],
          },
        },
      }),
    (err: any) => {
      assert(err instanceof ConfigValidationError);
      assert(err.issues.some((i: any) => i.path.includes("maxConcurrentFiles")));
      return true;
    },
    "maxConcurrentFiles < 1 deve fallire"
  );

  assert.throws(
    () =>
      loadConfig({
        env: {},
        overrides: {
          bulkUploadConfig: {
            maxConcurrentFiles: 10,
            chunkSizeBytes: 1024, // 1KB < 64KB
            allowedSubPaths: ["upload"],
          },
        },
      }),
    (err: any) => {
      assert(err instanceof ConfigValidationError);
      assert(err.issues.some((i: any) => i.path.includes("chunkSizeBytes")));
      return true;
    },
    "chunkSizeBytes < 64KB deve fallire"
  );

  // 2f. maxFileUploadBytes < 1MB
  assert.throws(
    () => loadConfig({ env: {}, overrides: { maxFileUploadBytes: 500 } }),
    (err: any) => {
      assert(err instanceof ConfigValidationError);
      assert(err.issues.some((i: any) => i.path.includes("maxFileUploadBytes")));
      return true;
    },
    "maxFileUploadBytes < 1MB deve fallire"
  );

  // 2g. Numeri non interi
  assert.throws(
    () => loadConfig({ env: {}, overrides: { maxConcurrentWebUsers: 10.5 as any } }),
    (err: any) => {
      assert(err instanceof ConfigValidationError);
      return true;
    },
    "Parametri non interi devono fallire"
  );

  console.log("  PASS: Test 2 - Fallimento immediato se parametri sono fuori range o negativi.");
}

// =========================================================================
// TEST 3: Gestione file mancante o JSON malformato
// =========================================================================
{
  // 3a. File esplicitamente indicato ma non esistente
  assert.throws(
    () => loadConfig({ configPath: "/percorso/inesistente/config.json" }),
    (err: any) => {
      assert(err instanceof ConfigError);
      assert.strictEqual(err.code, "CONFIG_FILE_NOT_FOUND");
      return true;
    },
    "File mancante deve sollevare ConfigError con codice CONFIG_FILE_NOT_FOUND"
  );

  // 3b. File con sintassi JSON corrotta
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "moliris-config-test-"));
  const badJsonPath = path.join(tmpDir, "corrupted.json");
  fs.writeFileSync(badJsonPath, "{ sessionInactivityTimeoutMinutes: 30, // missing quotes");

  assert.throws(
    () => loadConfig({ configPath: badJsonPath }),
    (err: any) => {
      assert(err instanceof ConfigError);
      assert.strictEqual(err.code, "CONFIG_SYNTAX_ERROR");
      return true;
    },
    "JSON non valido deve sollevare CONFIG_SYNTAX_ERROR"
  );

  // 3c. File config.example.json esistente e valido
  const examplePath = path.resolve(process.cwd(), "config.example.json");
  assert(fs.existsSync(examplePath), "config.example.json deve esistere nella root");
  const loadedExample = loadConfig({ configPath: examplePath });
  assert.strictEqual(loadedExample.sessionInactivityTimeoutMinutes, 30);
  assert.strictEqual(loadedExample.maxFileUploadBytes, 3 * 1024 * 1024 * 1024);

  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log("  PASS: Test 3 - Gestione file mancante, JSON corrotto ed esempio valido.");
}

// =========================================================================
// TEST 4: Sovrascrittura tramite variabili d'ambiente
// =========================================================================
{
  const fakeEnv: Record<string, string> = {
    MOLIRIS_MAX_CONCURRENT_WEB_USERS: "50",
    MOLIRIS_MAX_FILE_UPLOAD_BYTES: "5368709120", // 5 GB
    MOLIRIS_MAX_BULK_UPLOAD_FILES: "15",
    MOLIRIS_MAX_FLEET_ROBOTS: "250",
  };

  const config = loadConfig({ env: fakeEnv });
  assert.strictEqual(config.maxConcurrentWebUsers, 50);
  assert.strictEqual(config.maxFileUploadBytes, 5368709120);
  assert.strictEqual(config.bulkUploadConfig.maxConcurrentFiles, 15);
  assert.strictEqual(config.futureExtensions.maxFleetRobots, 250);

  console.log("  PASS: Test 4 - Sovrascrittura tramite variabili d'ambiente coerente.");
}

// =========================================================================
// TEST 5: Integrazione Fastify (decoratore appConfig e FastifyInstance)
// =========================================================================
{
  const app = Fastify({ logger: false });

  // Registrazione del plugin di configurazione
  await app.register(configPlugin, {
    overrides: {
      maxConcurrentWebUsers: 25,
      maxFileUploadBytes: 3 * 1024 * 1024 * 1024,
    },
  });

  await app.ready();

  assert(app.hasDecorator("appConfig"), "Fastify deve possedere il decoratore 'appConfig'");
  assert.strictEqual(app.appConfig.maxConcurrentWebUsers, 25);
  assert.strictEqual(app.appConfig.maxFileUploadBytes, 3 * 1024 * 1024 * 1024);
  assert.strictEqual(app.appConfig.sessionInactivityTimeoutMinutes, 30);

  await app.close();
  console.log("  PASS: Test 5 - Integrazione Fastify (decoratore appConfig) verificata.");
}

console.log("PASS: Tutti i test unitari del modulo di Configurazione completati con successo.");
