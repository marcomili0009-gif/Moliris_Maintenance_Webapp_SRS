// Requisito: RNF-MNT-001, RF-ROB-005, §8.1

import assert from "assert";
import { loadAndValidateConfig } from "./configuration.ts";

console.log("--> Esecuzione test validazione configurazione...");

// Test 1: Fallimento se mancano parametri obbligatori
try {
  loadAndValidateConfig({});
  assert.fail("Avrebbe dovuto fallire per parametri mancanti");
} catch (err: any) {
  assert(err.message.includes("Inizializzazione fallita. Parametri di configurazione obbligatori mancanti"));
  assert(err.message.includes("MOLIRIS_FS_ROOT"));
  assert(err.message.includes("MOLIRIS_POLLING_INTERVAL_SEC"));
  assert(err.message.includes("MOLIRIS_SSH_TIMEOUT_MS"));
  assert(err.message.includes("MOLIRIS_REGISTRATION_MODE"));
}

// Test 2: Fallimento per modalità di registrazione non valida
try {
  loadAndValidateConfig({
    MOLIRIS_FS_ROOT: "/home/robots",
    MOLIRIS_POLLING_INTERVAL_SEC: "10",
    MOLIRIS_SSH_TIMEOUT_MS: "5000",
    MOLIRIS_MAX_TRF_PER_USER: "2",
    MOLIRIS_MAX_TRF_PER_ROBOT: "2",
    MOLIRIS_MAX_TRF_SERVER: "10",
    MOLIRIS_TEMP_RETENTION_MIN: "60",
    MOLIRIS_STATE_FILE_PATHS: "/tmp/status.txt",
    MOLIRIS_SESSION_TIMEOUT_MIN: "30",
    MOLIRIS_TLS_CERT_PATH: "/certs/cert.pem",
    MOLIRIS_TLS_KEY_PATH: "/certs/key.pem",
    MOLIRIS_REGISTRATION_MODE: "non_valida",
    MOLIRIS_AUDIT_RETENTION_DAYS: "90",
  });
  assert.fail("Avrebbe dovuto fallire per modalità registrazione non valida");
} catch (err: any) {
  assert(err.message.includes("Valore non valido per MOLIRIS_REGISTRATION_MODE"));
}

// Test 3: Successo con tutti i parametri validi e verifica default porta SSH 22 (RF-ROB-005)
const validEnv: Record<string, string> = {
  MOLIRIS_FS_ROOT: "/home/robots",
  MOLIRIS_POLLING_INTERVAL_SEC: "10",
  MOLIRIS_SSH_TIMEOUT_MS: "5000",
  MOLIRIS_MAX_TRF_PER_USER: "2",
  MOLIRIS_MAX_TRF_PER_ROBOT: "2",
  MOLIRIS_MAX_TRF_SERVER: "10",
  MOLIRIS_TEMP_RETENTION_MIN: "60",
  MOLIRIS_STATE_FILE_PATHS: "/tmp/status1.txt, /tmp/status2.txt",
  MOLIRIS_SESSION_TIMEOUT_MIN: "30",
  MOLIRIS_TLS_CERT_PATH: "/certs/cert.pem",
  MOLIRIS_TLS_KEY_PATH: "/certs/key.pem",
  MOLIRIS_REGISTRATION_MODE: "rigorosa",
  MOLIRIS_AUDIT_RETENTION_DAYS: "180",
  MOLIRIS_MASTER_KEY_FILE: "/certs/master.key",
};

const config = loadAndValidateConfig(validEnv);
assert.strictEqual(config.serverFilesystemRoot, "/home/robots");
assert.strictEqual(config.pollingIntervalSeconds, 10);
assert.strictEqual(config.sshConnectionTimeoutMs, 5000);
assert.strictEqual(config.auditLogRetentionDays, 180);
assert.strictEqual(config.maxConcurrentTransfersPerUser, 2);
assert.strictEqual(config.maxConcurrentTransfersPerRobot, 2);
assert.strictEqual(config.maxConcurrentTransfersServer, 10);
assert.strictEqual(config.tempFileRetentionMinutes, 60);
assert.deepStrictEqual(config.stateFilePaths, ["/tmp/status1.txt", "/tmp/status2.txt"]);
assert.strictEqual(config.inactiveSessionTimeoutMinutes, 30);
assert.strictEqual(config.tlsCertPath, "/certs/cert.pem");
assert.strictEqual(config.tlsKeyPath, "/certs/key.pem");
// Verifica che l'unico default applicato sia 22
assert.strictEqual(config.defaultSshPort, 22, "La porta SSH di default deve essere 22");
assert.strictEqual(config.registrationMode, "rigorosa");
// Opzionali rimangono undefined (non inventati)
assert.strictEqual(config.maxFileSizeBytes, undefined);
assert.strictEqual(config.quotaPerRobotBytes, undefined);
assert.strictEqual(config.standardSubdirectories, undefined);

// Test 4: Supporto modalità differita
const configDifferita = loadAndValidateConfig({
  ...validEnv,
  MOLIRIS_REGISTRATION_MODE: "differita",
  MOLIRIS_DEFAULT_SSH_PORT: "2222",
  MOLIRIS_MAX_FILE_SIZE_BYTES: "10737418240",
  MOLIRIS_STANDARD_SUBDIRS: "upload, download, shared",
});
assert.strictEqual(configDifferita.registrationMode, "differita");
assert.strictEqual(configDifferita.defaultSshPort, 2222);
assert.strictEqual(configDifferita.maxFileSizeBytes, 10737418240);
assert.deepStrictEqual(configDifferita.standardSubdirectories, ["upload", "download", "shared"]);

// Test 5: Rifiuto provider in-memory in ambiente di produzione (NODE_ENV=production)
try {
  loadAndValidateConfig({
    ...validEnv,
    NODE_ENV: "production",
    MOLIRIS_CREDENTIAL_PROVIDER: "in-memory",
  });
  assert.fail("Avrebbe dovuto fallire per in-memory in produzione");
} catch (err: any) {
  assert(err.message.includes("il provider di credenziali 'in-memory' non è consentito in ambiente di produzione"));
}

// Test 6: Fallimento se manca MOLIRIS_MASTER_KEY_FILE con provider mongo
try {
  const envNoKey = { ...validEnv };
  delete (envNoKey as any).MOLIRIS_MASTER_KEY_FILE;
  loadAndValidateConfig(envNoKey);
  assert.fail("Avrebbe dovuto fallire per master key mancante con provider mongo");
} catch (err: any) {
  assert(err.message.includes("MOLIRIS_MASTER_KEY_FILE"));
}

// Test 7: Rifiuto categorico di mantieni_in_background per politica disconnessione terminale
try {
  loadAndValidateConfig({
    ...validEnv,
    MOLIRIS_TERMINAL_DISCONNECT_POLICY: "mantieni_in_background",
  });
  assert.fail("Avrebbe dovuto fallire per mantieni_in_background");
} catch (err: any) {
  assert(err.message.includes("il valore 'mantieni_in_background' per MOLIRIS_TERMINAL_DISCONNECT_POLICY è stato rimosso"));
}

// Test 8: Validazione tetto massimo assoluto sessione MOLIRIS_SESSION_ABSOLUTE_MAX_MIN
try {
  loadAndValidateConfig({
    ...validEnv,
    MOLIRIS_SESSION_ABSOLUTE_MAX_MIN: "-5",
  });
  assert.fail("Avrebbe dovuto fallire per timeout assoluto negativo");
} catch (err: any) {
  assert(err.message.includes("Valore non valido per MOLIRIS_SESSION_ABSOLUTE_MAX_MIN"));
}

const configAbsMax = loadAndValidateConfig({
  ...validEnv,
  MOLIRIS_SESSION_ABSOLUTE_MAX_MIN: "480",
});
assert.strictEqual(configAbsMax.sessionAbsoluteMaxMinutes, 480);

console.log("PASS: Test configurazione completato con successo.");
