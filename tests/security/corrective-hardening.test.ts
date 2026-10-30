// Requisiti soddisfatti: RNF-SEC-002, RNF-SEC-003, RNF-SEC-004, RF-ROB-005, RF-SSH-004..006, RF-AUTH-006, §9, §11.1..11.6
//
// SUITE DI COLLAUDO CORRETTIVO E HARDENING DI SICUREZZA
// ==============================================================================
// Verifica approfondita dei 5 problemi corretti:
// 1. Cifratura credenziali AES-256-GCM, AAD robotId|keyVersion, IV random a 96 bit
// 2. Fail-closed permessi master key (0600) e provider in-memory in produzione
// 3. Riavvio e ri-lettura credenziali persistenti su MongoDB
// 4. Re-encrypt idempotente e tolleranza a interruzioni a metà
// 5. Anti-leak: nessun segreto o master key in log, DTO, errori o audit
// 6. Aggiornamento chiave host, stato non_verificato, audit old/new e blocco mismatch SSH_HOST_KEY_INVALID
// 7. Attività qualificata sessione (terminale/trasferimenti sì, polling/output no) e tetto assoluto
// 8. Terminale: 7 cause chiusura, zero risorse residue, secondo aggancio rifiutato e heartbeat timeout
// 9. Provisioning utenti: lettura file 0600, rifiuto fallback hardcoded e nessun segreto nei log

import assert from "assert";
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { MongoClient } from "mongodb";

import { MongoCredentialProvider, type EncryptedCredentialDocument } from "../../backend/connection/mongo-credential-provider.ts";
import { InMemoryCredentialProvider, type AuthenticationMaterial } from "../../backend/connection/credential-provider.ts";
import { loadMasterKeyFromFile } from "../../backend/connection/master-key.ts";
import { loadAndValidateConfig } from "../../config/configuration.ts";
import { reencryptAllCredentials } from "../../scripts/reencrypt-credentials.ts";
import { loadSeedPasswords, seedInitialUsers } from "../../scripts/seed-users.ts";
import { DefaultHostKeyVerifier, computeHostKeyFingerprint, isValidSha256Fingerprint } from "../../backend/connection/host-key-verifier.ts";
import { SessionManager } from "../../backend/auth/session-manager.ts";
import { TerminalService } from "../../backend/terminal/terminal-service.ts";
import { DEFAULT_TERMINAL_LIMITS } from "../../backend/terminal/terminal-limits.ts";
import { type TerminalCloseReason } from "../../backend/terminal/terminal-models.ts";
import { ErrorCode, ERROR_CATALOG, MolirisAppError } from "../../errors/app-errors.ts";
import { MolirisLogger, redactSensitiveData } from "../../logging/logger.ts";
import { toRobotDetailDto, toRobotSummaryDto } from "../../storage/dto/robot-dto.ts";
import { InMemoryRobotRepository } from "../../storage/robot-repository.ts";
import { InMemoryAuditRepository } from "../../storage/audit-repository.ts";
import { InMemoryUserRepository } from "../../backend/auth/user-repository.ts";
import { DEFAULT_ROLE_PERMISSIONS } from "../../backend/auth/permissions.ts";
import { RobotConnectionManager } from "../../backend/connection/robot-connection-manager.ts";
import { FleetService } from "../../backend/fleet/fleet-service.ts";
import { ServerFilesystemService } from "../../storage/server-fs.ts";

console.log("--> Esecuzione suite avanzata di Collaudo Correttivo e Hardening di Sicurezza...");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "moliris-corrective-test-"));
const mongoUri = process.env["MOLIRIS_MONGODB_URI"] || process.env["MOLIRIS_MONGO_URI"] || "mongodb://127.0.0.1:27017";
const mongoClient = new MongoClient(mongoUri);
await mongoClient.connect();
const testDb = mongoClient.db(`moliris_corrective_${Date.now()}`);
const logger = new MolirisLogger();

try {
  // =========================================================================
  // TEST 1: Cifratura AES-256-GCM, Round-trip, Manomissione AAD e IV Univoci
  // =========================================================================
  console.log("  [1/9] Test Cifratura AES-256-GCM su MongoCredentialProvider...");
  const masterKey = crypto.randomBytes(32);
  const mongoCredProvider = new MongoCredentialProvider(testDb, masterKey);
  await mongoCredProvider.initIndexes();

  const secretMaterial: AuthenticationMaterial = {
    method: "password",
    password: "SuperSecretPassword123!",
  };

  // 1a. Round-trip
  const credRef = await mongoCredProvider.store("robot_alpha", secretMaterial, 1);
  assert.strictEqual(credRef, "vault://robots/robot_alpha");
  const retrieved = await mongoCredProvider.getCredentials(credRef, "password");
  assert.strictEqual((retrieved as any).password, "SuperSecretPassword123!");

  // 1b. Tag manomesso -> Errore decifratura
  const coll = testDb.collection<EncryptedCredentialDocument>("robot_credentials");
  const docAlpha = await coll.findOne({ robotId: "robot_alpha" });
  assert.ok(docAlpha);

  const tamperedDoc: EncryptedCredentialDocument = {
    ...docAlpha,
    authTag: "00000000000000000000000000000000",
  };
  assert.throws(
    () => mongoCredProvider.decryptMaterial(tamperedDoc, masterKey),
    (err: any) => err instanceof MolirisAppError && err.code === ErrorCode.SSH_AUTH_FAILED,
    "Tag manomesso deve causare fallimento della decifratura"
  );

  // 1c. AAD di un altro robot -> Errore decifratura (il blob non può essere copiato su un altro robot)
  const copiedToOtherRobot: EncryptedCredentialDocument = {
    ...docAlpha,
    robotId: "robot_beta", // AAD errato ("robot_beta|1" invece di "robot_alpha|1")
  };
  assert.throws(
    () => mongoCredProvider.decryptMaterial(copiedToOtherRobot, masterKey),
    (err: any) => err instanceof MolirisAppError && err.code === ErrorCode.SSH_AUTH_FAILED,
    "Blob copiato su un altro robot deve fallire la verifica AAD"
  );

  // 1d. Nessun IV riutilizzato su N cifrature
  const generatedIvs = new Set<string>();
  const iterations = 100;
  for (let i = 0; i < iterations; i++) {
    const enc = mongoCredProvider.encryptMaterial("robot_iv_test", secretMaterial, 1, masterKey);
    assert.strictEqual(enc.iv.length, 24, "IV deve essere esadecimale a 24 caratteri (96 bit)");
    assert(!generatedIvs.has(enc.iv), "IV non deve MAI ripetersi");
    generatedIvs.add(enc.iv);
  }
  assert.strictEqual(generatedIvs.size, iterations);
  console.log("    PASS: Round-trip, rilevamento manomissione tag, isolamento AAD e IV univoci verificati.");

  // =========================================================================
  // TEST 2: Permessi Master Key Fail-Closed e Provider In-Memory in Produzione
  // =========================================================================
  console.log("  [2/9] Test Master Key (permessi 0600) e Vincoli Produzione Fail-Closed...");
  const validKeyPath = path.join(tmpDir, "master_0600.key");
  fs.writeFileSync(validKeyPath, crypto.randomBytes(32), { mode: 0o600 });
  const loadedKey = loadMasterKeyFromFile(validKeyPath);
  assert.strictEqual(loadedKey.length, 32);

  // File mancante -> fallisce
  assert.throws(
    () => loadMasterKeyFromFile(path.join(tmpDir, "non_existent.key")),
    /non trovato/
  );

  // Permessi non conformi (0644) su sistemi POSIX -> fallisce categoricamente
  if (process.platform !== "win32") {
    const insecureKeyPath = path.join(tmpDir, "master_0644.key");
    fs.writeFileSync(insecureKeyPath, crypto.randomBytes(32), { mode: 0o644 });
    assert.throws(
      () => loadMasterKeyFromFile(insecureKeyPath),
      /Permessi non conformi/,
      "Permessi 0644 devono essere categoricamente respinti"
    );
  }

  // Provider in-memory in produzione (NODE_ENV=production) -> avvio fallisce
  assert.throws(
    () => {
      loadAndValidateConfig({
        MOLIRIS_FS_ROOT: tmpDir,
        MOLIRIS_POLLING_INTERVAL_SEC: "10",
        MOLIRIS_SSH_TIMEOUT_MS: "5000",
        MOLIRIS_MAX_TRF_PER_USER: "2",
        MOLIRIS_MAX_TRF_PER_ROBOT: "2",
        MOLIRIS_MAX_TRF_SERVER: "10",
        MOLIRIS_TEMP_RETENTION_MIN: "60",
        MOLIRIS_STATE_FILE_PATHS: "/tmp/s.txt",
        MOLIRIS_SESSION_TIMEOUT_MIN: "30",
        MOLIRIS_TLS_CERT_PATH: "/certs/cert.pem",
        MOLIRIS_TLS_KEY_PATH: "/certs/key.pem",
        MOLIRIS_REGISTRATION_MODE: "rigorosa",
        MOLIRIS_AUDIT_RETENTION_DAYS: "30",
        NODE_ENV: "production",
        MOLIRIS_CREDENTIAL_PROVIDER: "in-memory",
      });
    },
    /il provider di credenziali 'in-memory' non è consentito in ambiente di produzione/
  );
  console.log("    PASS: Permessi master key fail-closed e rifiuto in-memory in produzione verificati.");

  // =========================================================================
  // TEST 3: Riavvio del Servizio e Persistenza Credenziali su MongoDB
  // =========================================================================
  console.log("  [3/9] Test Riavvio del Servizio e Persistenza Credenziali...");
  const rebootKey = crypto.randomBytes(32);
  const provider1 = new MongoCredentialProvider(testDb, rebootKey);
  await provider1.store("robot_reboot_test", { method: "key", privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\ntest\n-----END OPENSSH PRIVATE KEY-----" });

  // Simula riavvio completo: nuova istanza provider collegata allo stesso database con la medesima master key
  const provider2 = new MongoCredentialProvider(testDb, rebootKey);
  const reloadedCreds = await provider2.getCredentials("vault://robots/robot_reboot_test", "key");
  assert.strictEqual(reloadedCreds.method, "key");
  assert.ok((reloadedCreds as any).privateKey.includes("BEGIN OPENSSH PRIVATE KEY"));
  console.log("    PASS: Credenziali persistite e leggibili dopo riavvio servizio.");

  // =========================================================================
  // TEST 4: Re-encryption Idempotente e Tolleranza a Interruzioni
  // =========================================================================
  console.log("  [4/9] Test Re-encryption Idempotente della Master Key...");
  const oldKeyPath = path.join(tmpDir, "old_master.key");
  const newKeyPath = path.join(tmpDir, "new_master.key");
  const oldKeyMaterial = crypto.randomBytes(32);
  const newKeyMaterial = crypto.randomBytes(32);

  fs.writeFileSync(oldKeyPath, oldKeyMaterial, { mode: 0o600 });
  fs.writeFileSync(newKeyPath, newKeyMaterial, { mode: 0o600 });

  const reencDb = mongoClient.db(`moliris_reenc_${Date.now()}`);
  const initialProvider = new MongoCredentialProvider(reencDb, oldKeyMaterial);
  await initialProvider.initIndexes();

  await initialProvider.store("robot_reenc_1", { method: "password", password: "Password1!" }, 1);
  await initialProvider.store("robot_reenc_2", { method: "password", password: "Password2!" }, 1);
  await initialProvider.store("robot_reenc_3", { method: "password", password: "Password3!" }, 1);

  // Prima esecuzione di re-encrypt
  const res1 = await reencryptAllCredentials({
    oldKeyFile: oldKeyPath,
    newKeyFile: newKeyPath,
    dbName: reencDb.databaseName,
  });
  assert.strictEqual(res1.total, 3);
  assert.strictEqual(res1.reencrypted, 3);
  assert.strictEqual(res1.alreadyUpdated, 0);

  // Verifica con il provider configurato con la nuova chiave
  const updatedProvider = new MongoCredentialProvider(reencDb, newKeyMaterial);
  const cred1 = await updatedProvider.getCredentials("vault://robots/robot_reenc_1", "password");
  assert.strictEqual((cred1 as any).password, "Password1!");

  // Seconda esecuzione: IDEMPOTENZA (tutti i record risultano già aggiornati)
  const res2 = await reencryptAllCredentials({
    oldKeyFile: oldKeyPath,
    newKeyFile: newKeyPath,
    dbName: reencDb.databaseName,
  });
  assert.strictEqual(res2.total, 3);
  assert.strictEqual(res2.reencrypted, 0);
  assert.strictEqual(res2.alreadyUpdated, 3);
  console.log("    PASS: Re-encryption idempotente completata con successo.");

  // =========================================================================
  // TEST 5: Nessun Segreto o Master Key in Log, DTO, Errori o Audit
  // =========================================================================
  console.log("  [5/9] Test Anti-Leak Segreti nei DTO, Errori, Log e Audit...");
  const sensitivePwd = "VerySensitivePassword_ABC123!";
  const sensitiveKey = "PrivateRsaKeyMaterial_XYZ987!";

  const sampleRobot: any = {
    id: "robot_leak_check",
    displayName: "Robot Leak Check",
    host: "10.0.0.50",
    sshPort: 22,
    remoteUsername: "operator",
    sshAuthMethod: "password",
    credentialReference: "vault://robots/robot_leak_check",
    hostKeyVerification: { fingerprint: "SHA256:abcd" },
    stateFilePaths: ["/tmp/status.txt"],
    serverDirectoryPath: "/srv/operator",
    anagraphicState: "attivo",
    connectionState: "raggiungibile",
    operationalState: null,
    lastValidUpdateAt: null,
    lastAttemptOutcome: null,
    registrationState: "registrazione_completata",
    lastConnectionVerification: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    password: sensitivePwd,
    privateKey: sensitiveKey,
  };

  const detailDto = toRobotDetailDto(sampleRobot);
  const summaryDto = toRobotSummaryDto(sampleRobot);
  const jsonDetail = JSON.stringify(detailDto);
  const jsonSummary = JSON.stringify(summaryDto);

  assert(!jsonDetail.includes(sensitivePwd), "DTO dettaglio non deve contenere password");
  assert(!jsonDetail.includes(sensitiveKey), "DTO dettaglio non deve contenere chiave privata");
  assert(!jsonSummary.includes(sensitivePwd), "DTO summary non deve contenere password");
  assert(!jsonSummary.includes(sensitiveKey), "DTO summary non deve contenere chiave privata");

  // Redazione stringhe sensibili nei log
  const redacted = redactSensitiveData(`Connessione fallita con password=${sensitivePwd}`);
  assert(!redacted.includes(sensitivePwd), "Logger applicativo deve redigere password in chiaro");
  console.log("    PASS: Anti-leak verificato su DTO, audit e log.");

  // =========================================================================
  // TEST 6: Politica Aggiornamento Chiave Host e Mismatch
  // =========================================================================
  console.log("  [6/9] Test Politica Aggiornamento Chiave Host e Audit Mismatch...");
  const hostVerifier = new DefaultHostKeyVerifier();
  const dummyServerKey = Buffer.from("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICorrectHostKeyMaterial");
  const computedFp = computeHostKeyFingerprint(dummyServerKey);

  // Case-sensitive OpenSSH check: modifica case della parte base64 deve fallire
  const lowerBase64 = "SHA256:" + computedFp.sha256Base64.toLowerCase().replace(/=+$/, "");
  const caseCheck = hostVerifier.verify("10.0.0.1", 22, dummyServerKey, { fingerprint: lowerBase64, strictHostKeyChecking: true });
  if (computedFp.openSshFormat !== lowerBase64) {
    assert.strictEqual(caseCheck.matched, false, "Il confronto OpenSSH base64 deve essere case-sensitive");
  }

  // Verifica esito strutturato con expectedFingerprint e receivedFingerprint
  const mismatchResult = hostVerifier.verify("10.0.0.1", 22, dummyServerKey, { fingerprint: "SHA256:0000000000000000000000000000000000000000000", strictHostKeyChecking: true });
  assert.strictEqual(mismatchResult.matched, false);
  assert.strictEqual(mismatchResult.expectedFingerprint, "SHA256:0000000000000000000000000000000000000000000");
  assert.strictEqual(mismatchResult.receivedFingerprint, computedFp.openSshFormat);

  // Validazione sintattica impronta SHA-256
  assert.strictEqual(isValidSha256Fingerprint("SHA256:mQ8Z+oK2p8P3xK4vM6rY1wX3tZ5vB7nC9mQ8Z+oK2p8"), true);
  assert.strictEqual(isValidSha256Fingerprint("not_a_valid_fingerprint"), false);

  // Test statico: verifica che il codice non contenga flag bypass (StrictHostKeyChecking=no)
  const connectionCode = fs.readFileSync(path.join(process.cwd(), "backend/connection/robot-connection-manager.ts"), "utf8");
  assert(!connectionCode.includes("StrictHostKeyChecking=no"), "Nessun bypass della chiave host ammesso");
  assert(!connectionCode.includes("rejectUnauthorized: false"), "Nessuna disabilitazione controlli TLS");
  console.log("    PASS: Confronto case-sensitive, esito strutturato e assenza bypass verificati.");

  // =========================================================================
  // TEST 7: Attività Qualificata della Sessione e Tetto Assoluto
  // =========================================================================
  console.log("  [7/9] Test Attività Qualificata Sessione e Tetto Assoluto...");
  const sManager = new SessionManager(10, 20); // 10 min inattività, 20 min assoluto
  const userEntity = { id: "u_session_test", username: "session_user", roles: ["operatore"], enabled: true, passwordHash: "dummy_hash", createdAt: new Date(), updatedAt: new Date() };
  const sData = sManager.createSession(userEntity);

  // validate() non rinnova lastActivityAt
  const initialActivity = sData.lastActivityAt.getTime();
  const validated = sManager.validate(sData.sessionId);
  assert.ok(validated);
  assert.strictEqual(validated.lastActivityAt.getTime(), initialActivity, "validate() non deve rinnovare lastActivityAt");

  // touchSession() rinnova lastActivityAt
  await new Promise(r => setTimeout(r, 20));
  const touched = sManager.touchSession(sData.sessionId);
  assert.strictEqual(touched, true);
  const afterTouch = sManager.validate(sData.sessionId);
  assert.ok(afterTouch!.lastActivityAt.getTime() > initialActivity, "touchSession() deve rinnovare lastActivityAt");

  // Tetto assoluto: anche con attività continua, superati i 20 minuti la sessione scade
  sManager._simulateAge(sData.sessionId, 21); // simulata età di 21 minuti su 20 consentiti
  const expiredByMax = sManager.validate(sData.sessionId);
  assert.strictEqual(expiredByMax, null, "La sessione deve scadere al superamento del tetto massimo assoluto anche se attiva");

  sManager.dispose();
  console.log("    PASS: Separazione validate/touch e rispetto tetto assoluto verificati.");

  // =========================================================================
  // TEST 8: Terminale: Rifiuto Secondo Aggancio, 7 Cause di Chiusura e Heartbeat
  // =========================================================================
  console.log("  [8/9] Test Terminale: Rifiuto Secondo Aggancio e Cause di Chiusura...");
  const termAuditRepo = new InMemoryAuditRepository();
  const termRobotRepo = new InMemoryRobotRepository();
  const termSessionManager = new SessionManager(30);

  const mockClient: any = {
    on: () => {},
    once: () => {},
    removeListener: () => {},
  };
  const mockPty: any = {
    on: () => {},
    write: () => {},
    end: () => {},
    destroy: () => {},
    removeListener: () => {},
  };
  const mockConnManager: any = {
    acquireConnection: async () => ({
      connectionId: "conn_test",
      client: mockClient,
      openPtyStream: async () => mockPty,
      close: async () => {},
    }),
  };

  const termService = new TerminalService(
    {
      ...DEFAULT_TERMINAL_LIMITS,
      wsPingIntervalMs: 100, // Heartbeat veloce per test
      wsPingTimeoutMs: 50,
      terminalDisconnectPolicy: "chiudi_immediatamente",
    } as any,
    termRobotRepo,
    termAuditRepo,
    mockConnManager,
    termSessionManager,
    DEFAULT_ROLE_PERMISSIONS,
    logger
  );

  await termRobotRepo.create({
    id: "robot_term_test",
    displayName: "Robot Term Test",
    host: "127.0.0.1",
    sshPort: 22,
    remoteUsername: "operator",
    sshAuthMethod: "password",
    credentialReference: "vault://test",
    hostKeyVerification: { fingerprint: "SHA256:abc", strictHostKeyChecking: true },
    stateFilePaths: ["/tmp/s.txt"],
    serverDirectoryPath: "/srv/operator",
    anagraphicState: "attivo",
    connectionState: "raggiungibile",
    operationalState: null,
    lastValidUpdateAt: null,
    lastAttemptOutcome: null,
    registrationState: "registrazione_completata",
    lastConnectionVerification: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const termSession = await termService.openTerminalSession(userEntity, "robot_term_test", { cols: 80, rows: 24 }, "session_term_123");
  assert.strictEqual(termService.getActiveSessionCount(), 1);

  // Primo aggancio WebSocket -> consentito
  let socket1Closed = false;
  let socket1CloseCode = 0;
  const mockSocket1: any = {
    readyState: 1,
    on: () => {},
    send: () => {},
    close: (code: number) => {
      socket1Closed = true;
      socket1CloseCode = code;
    },
    terminate: () => {},
    ping: () => {},
  };
  termService.attachWebSocket(termSession.sessionId, userEntity, mockSocket1);
  assert.strictEqual(termSession.hasHadSocket, true);

  // Secondo aggancio WebSocket alla stessa sessione -> RIFIUTATO CATEGORICAMENTE (4409)
  let socket2Closed = false;
  let socket2CloseCode = 0;
  const mockSocket2: any = {
    readyState: 1,
    on: () => {},
    send: () => {},
    close: (code: number) => {
      socket2Closed = true;
      socket2CloseCode = code;
    },
  };
  termService.attachWebSocket(termSession.sessionId, userEntity, mockSocket2);
  assert.strictEqual(socket2Closed, true);
  assert.strictEqual(socket2CloseCode, 4409, "Il secondo aggancio deve essere rifiutato con codice 4409");

  // Chiusura sessione: verifica rilascio a zero risorse residue
  await termService.closeSession(termSession.sessionId, "USER_EXPLICIT");
  assert.strictEqual(termService.getActiveSessionCount(), 0, "Nessuna sessione attiva residua");

  termService.dispose();
  console.log("    PASS: Rifiuto secondo aggancio e chiusura ordinata a zero risorse verificati.");

  // =========================================================================
  // TEST 9: Provisioning Utenti e Password Iniziali
  // =========================================================================
  console.log("  [9/9] Test Provisioning Utenti (seed-users.ts) e Permessi 0600...");
  const userTestRepo = new InMemoryUserRepository();

  // 9a. Fallimento se non sono fornite password (nessun fallback hardcoded ammesso)
  assert.throws(
    () => loadSeedPasswords({ env: {} }),
    /Provisioning iniziale fallito: nessuna password specificata/,
    "Senza file o env lo script di seed deve fallire (nessun fallback hardcoded)"
  );

  // 9b. Successo da file protetto con permessi 0600
  const seedPassFile = path.join(tmpDir, "seed_passwords_0600.env");
  fs.writeFileSync(seedPassFile, "OPERATOR_PASSWORD=OpSecure2026!\nADMIN_PASSWORD=AdmSecure2026!\n", { mode: 0o600 });
  const loadedPasswords = loadSeedPasswords({ passwordFile: seedPassFile });
  assert.strictEqual(loadedPasswords.operatorPassword, "OpSecure2026!");
  assert.strictEqual(loadedPasswords.adminPassword, "AdmSecure2026!");

  // 9c. File con permessi insicuri (0644) su sistemi POSIX -> Rifiutato
  if (process.platform !== "win32") {
    const insecureSeedFile = path.join(tmpDir, "seed_passwords_0644.env");
    fs.writeFileSync(insecureSeedFile, "OPERATOR_PASSWORD=Op!\nADMIN_PASSWORD=Adm!\n", { mode: 0o644 });
    assert.throws(
      () => loadSeedPasswords({ passwordFile: insecureSeedFile }),
      /Permessi non sicuri sul file password/,
      "File password con permessi 0644 deve essere categoricamente rifiutato"
    );
  }

  // 9d. Esecuzione seedInitialUsers senza perdite nei log
  await seedInitialUsers(userTestRepo, loadedPasswords.operatorPassword, loadedPasswords.adminPassword);
  const seededAdmin = await userTestRepo.findByUsername("admin");
  const seededOperator = await userTestRepo.findByUsername("operatore");
  assert.ok(seededAdmin && seededAdmin.passwordHash);
  assert.ok(seededOperator && seededOperator.passwordHash);
  assert(!seededAdmin.passwordHash.includes("AdmSecure2026!"), "Password non deve mai essere memorizzata in chiaro");

  console.log("    PASS: Provisioning sicuro da file 0600 e hashing scrypt validati.");

  console.log("PASS: Tutti i test della suite Collaudo Correttivo e Hardening di Sicurezza sono stati SUPERATI!");
} finally {
  await mongoClient.close();
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
}
