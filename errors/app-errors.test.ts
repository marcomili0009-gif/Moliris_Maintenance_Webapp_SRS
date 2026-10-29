// Requisito: SRS §9, RNF-MNT-003, RNF-SEC-002

import assert from "assert";
import { MolirisAppError, ErrorCode, ERROR_CATALOG } from "./app-errors.ts";

console.log("--> Esecuzione test modello errori e messaggi sicuri...");

// Test 1: Verifica che tutte le 17 categorie §9 siano definite nel catalogo
const expectedCodes: ErrorCode[] = [
  ErrorCode.INVALID_CREDENTIALS,
  ErrorCode.INSUFFICIENT_PERMISSIONS,
  ErrorCode.MISSING_ROBOT_PARAMS,
  ErrorCode.HOST_UNREACHABLE,
  ErrorCode.SSH_PORT_UNAVAILABLE,
  ErrorCode.SSH_AUTH_FAILED,
  ErrorCode.HOST_KEY_INVALID,
  ErrorCode.STATE_FILE_UNREADABLE,
  ErrorCode.TERMINAL_SESSION_ERROR,
  ErrorCode.REMOTE_FS_ERROR,
  ErrorCode.SERVER_DIR_INACCESSIBLE,
  ErrorCode.INSUFFICIENT_STORAGE,
  ErrorCode.TRANSFER_INTERRUPTED,
  ErrorCode.TIMEOUT_ERROR,
  ErrorCode.INTEGRITY_CHECK_FAILED,
  ErrorCode.DB_PERSISTENCE_ERROR,
  ErrorCode.DB_FS_SYNC_ERROR,
];

assert.strictEqual(expectedCodes.length, 17, "Devono essere presenti esattamente le 17 categorie della SRS §9");
for (const code of expectedCodes) {
  const entry = ERROR_CATALOG[code];
  assert(entry, `Il codice errore ${code} deve essere presente nel catalogo`);
  assert(entry.userMessage && entry.userMessage.length > 0, `Il messaggio utente per ${code} deve essere valorizzato`);
  assert(
    entry.classification === "recuperabile" || entry.classification === "richiede_intervento_amministrativo",
    `Classificazione non valida per ${code}`
  );
}

// Test 2: Verifica separazione messaggio utente vs dettaglio diagnostico per i log
const err = new MolirisAppError(
  ErrorCode.HOST_KEY_INVALID,
  "Detailed internal error: Host key mismatch on robot IP 192.168.10.45 port 2222: fingerprint SHA256:SecretFingerprint"
);

// Il messaggio utente è sicuro e generico
assert.strictEqual(err.userMessage, "Verifica di sicurezza dell'host fallita: chiave non riconosciuta o non valida.");
assert.strictEqual(err.classification, "richiede_intervento_amministrativo");
assert(!err.userMessage.includes("192.168.10.45"), "Il messaggio utente non deve esporre indirizzi IP o host interni");
assert(!err.userMessage.includes("SecretFingerprint"), "Il messaggio utente non deve esporre impronte o dettagli tecnici sensibili");

// Il dettaglio diagnostico interno è invece preservato per il log
assert(err.diagnosticDetail.includes("192.168.10.45"));
assert(err.diagnosticDetail.includes("SecretFingerprint"));

// Test 3: Verifica errore recuperabile (es. TIMEOUT_ERROR)
const timeoutErr = new MolirisAppError(ErrorCode.TIMEOUT_ERROR, "SSH handshake timeout after 5000ms");
assert.strictEqual(timeoutErr.classification, "recuperabile");
assert.strictEqual(timeoutErr.userMessage, "L'operazione richiesta ha superato il tempo massimo di attesa consentito.");

console.log("PASS: Test modello errori e messaggi sicuri completato con successo.");
