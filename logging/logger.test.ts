// Requisito: RNF-SEC-002, RNF-SEC-009, RNF-MNT-003, §10.4

import assert from "assert";
import { redactSensitiveData, MolirisLogger, type AuditEvent } from "./logger.ts";

console.log("--> Esecuzione test redazione segreti nei log...");

// Test 1: Redazione password
const logWithPassword = 'Tentativo autenticazione con password="SuperSecretPassword123" per user admin';
const redactedPassword = redactSensitiveData(logWithPassword);
assert(!redactedPassword.includes("SuperSecretPassword123"), "La password deve essere redatta");
assert(redactedPassword.includes("[REDACTED]"), "La password deve contenere [REDACTED]");

// Test 2: Redazione token bearer
const logWithToken = 'Header inviato: Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.xyz';
const redactedToken = redactSensitiveData(logWithToken);
assert(!redactedToken.includes("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.xyz"), "Il token Bearer deve essere redatto");
assert(redactedToken.includes("[REDACTED]"));

// Test 3: Redazione chiave privata SSH RSA/ED25519
const logWithKey = `Caricamento chiave:
-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEA0Y1+abcdefgh1234567890
-----END RSA PRIVATE KEY-----`;
const redactedKey = redactSensitiveData(logWithKey);
assert(!redactedKey.includes("MIIEowIBAAKCAQEA0Y1+abcdefgh1234567890"), "La chiave privata deve essere redatta");
assert(redactedKey.includes("[REDACTED]"));

// Test 4: Redazione session ID e segreti generici
const logWithSession = 'Session cookie: session_id="abc123xyz456" secret="api_secret_key"';
const redactedSession = redactSensitiveData(logWithSession);
assert(!redactedSession.includes("abc123xyz456"));
assert(!redactedSession.includes("api_secret_key"));

// Test 5: Verifica metodo audit
const logger = new MolirisLogger();
const auditEvent: AuditEvent = {
  timestamp: new Date().toISOString(),
  userId: "user_test",
  operation: "REGISTRATION_ROBOT",
  robotId: "robot_01",
  outcome: "SUCCESS",
  details: {
    password: "sensitivePassword",
  },
};

// Non deve sollevare eccezioni
logger.audit(auditEvent);

console.log("PASS: Test redazione segreti e audit completato con successo.");
