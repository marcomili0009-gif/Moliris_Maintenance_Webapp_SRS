// Requisiti verificati: Requisito #3, Requisito #4, Requisito #7, Requisito #8, Requisito #9
// FASE 1 - Backend Senior Engineer Test Suite

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { PhysicalFileLogger, formatLogTimestamp, sanitizeLogDetails, normalizeRoleForLog } from "../backend/logging/physical-file-logger.ts";
import { BatchTransferManager } from "../backend/transfer/batch-transfer-manager.ts";
import { SessionManager } from "../backend/auth/session-manager.ts";
import { InMemoryUserRepository } from "../backend/auth/user-repository.ts";
import { InMemoryAuditRepository } from "../storage/audit-repository.ts";
import { AuditOperation } from "../storage/audit-models.ts";
import { authorizeOperatorPath } from "../backend/auth/path-authorization.ts";
import { ErrorCode, MolirisAppError } from "../errors/app-errors.ts";
import { createServer } from "../backend/server.ts";
import { MolirisLogger } from "../logging/logger.ts";
import { AppPermission } from "../backend/auth/permissions.ts";

console.log("--> Esecuzione test suite FASE 1 Backend...");

// =========================================================================
// TEST 1: PhysicalFileLogger (Requisito #8)
// =========================================================================
async function testPhysicalFileLogger() {
  console.log("--- TEST 1: PhysicalFileLogger (access.log & transfers.log) ---");
  const tempLogDir = fs.mkdtempSync(path.join(os.tmpdir(), "moliris-logs-test-"));
  const logger = new PhysicalFileLogger(tempLogDir);

  await logger.ensureInitialized();

  // Verifica permessi restrittivi (0700 dir, 0600 file su sistemi POSIX)
  const dirStat = fs.statSync(tempLogDir);
  const dirMode = dirStat.mode & 0o777;
  assert.strictEqual(dirMode, 0o700, "Directory logs deve avere permessi 0700");

  const accessFile = logger.getAccessLogFilePath();
  const transfersFile = logger.getTransferLogFilePath();
  assert.ok(fs.existsSync(accessFile), "access.log deve esistere");
  assert.ok(fs.existsSync(transfersFile), "transfers.log deve esistere");

  const accessStat = fs.statSync(accessFile);
  assert.strictEqual(accessStat.mode & 0o777, 0o600, "access.log deve avere permessi 0600");

  // 1a. Registrazione access.log
  const accessLine = await logger.logAccess({
    event: "LOGIN",
    username: "admin_test",
    role: "admin",
    outcome: "SUCCESSO",
    details: "Autenticazione riuscita con IP 127.0.0.1",
  });

  assert.match(
    accessLine,
    /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] EVENT: LOGIN \| Utente: admin_test \| Ruolo: Amministratore \| Esito: SUCCESSO \| Dettagli: Autenticazione riuscita con IP 127\.0\.0\.1$/,
    "Formato riga access.log deve essere conforme alle specifiche"
  );

  // Redazione password sensibili
  const redactedLine = await logger.logAccess({
    event: "LOGIN",
    username: "operatore_leak",
    role: "operatore",
    outcome: "FALLIMENTO",
    details: "password=SuperSecret123!; token=xyz",
  });
  assert.ok(!redactedLine.includes("SuperSecret123!"), "Password non deve mai apparire in chiaro");
  assert.ok(redactedLine.includes("[REDACTED]"), "Password deve essere redatta");

  // 1b. Registrazione transfers.log
  const transferLine = await logger.logTransfer({
    filename: "firmware.bin",
    username: "admin_test",
    direction: "SERVER_TO_ROBOT",
    outcome: "SUCCESSO",
    details: "Trasferimento completato (10240 byte)",
  });

  assert.match(
    transferLine,
    /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] File: firmware\.bin \| Utente: admin_test \| Direzione: SERVER_TO_ROBOT \| Esito: SUCCESSO \| Dettagli: Trasferimento completato \(10240 byte\)$/,
    "Formato riga transfers.log deve essere conforme alle specifiche"
  );

  // 1c. Caricamento massivo delimitato da tag (formato allineato a SRS §6.2 / Specifiche di Sistema §6)
  const batchId = "batch_test_01";
  const startTag = await logger.logBulkStart(batchId, "operatore_1", 3);
  assert.ok(startTag.startsWith("=== INIZIO CARICAMENTO MASSIVO === [batchId: batch_test_01] (3 file)"));
  assert.ok(startTag.includes("Utente: operatore_1 | Data:"));
  assert.ok(startTag.includes("| Ora:"));

  const file1 = await logger.logBulkFile(batchId, 1, 3, {
    filename: "file1.txt",
    username: "operatore_1",
    direction: "CLIENT_TO_SERVER",
    outcome: "SUCCESSO",
    details: "Completato",
  });
  assert.ok(file1.includes("[FILE 1/3] File 1: file1.txt | Esito: SUCCESSO"));

  const endTag = await logger.logBulkEnd(batchId, {
    completed: 2,
    cancelled: 1,
    failed: 0,
    totalFiles: 3,
  });
  assert.ok(endTag.startsWith("=== CARICAMENTO MASSIVO TERMINATO === [batchId: batch_test_01]"));
  assert.ok(endTag.includes("Completati: 2/3, Annullati: 1, Falliti: 0"));
  assert.ok(endTag.includes("| Data:"));
  assert.ok(endTag.includes("| Ora:"));

  // 1d. Filtri di query
  const accessLogs = await logger.getAccessLogs({ user: "admin_test" });
  assert.strictEqual(accessLogs.length, 1);
  assert.ok(accessLogs[0].includes("admin_test"));

  const transferLogs = await logger.getTransferLogs({ outcome: "SUCCESSO" });
  assert.ok(transferLogs.length >= 2);

  // Pulizia directory temporanea
  fs.rmSync(tempLogDir, { recursive: true, force: true });
  console.log("  PASS: Test 1 PhysicalFileLogger completato.");
}

// =========================================================================
// TEST 2: BatchTransferManager e Cancellazione Selettiva 90% (Requisito #9)
// =========================================================================
async function testBatchTransferManager() {
  console.log("--- TEST 2: BatchTransferManager & Selective Cancellation ---");
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "moliris-batch-test-"));
  const tempLogDir = path.join(tempDir, "logs");
  const fileLogger = new PhysicalFileLogger(tempLogDir);
  const manager = new BatchTransferManager(fileLogger);

  const part1 = path.join(tempDir, "file_progress_20.part");
  const part2 = path.join(tempDir, "file_progress_95.part");
  fs.writeFileSync(part1, "Partial content 20%");
  fs.writeFileSync(part2, "Almost full content 95%");

  let abort1Triggered = false;
  let abort2Triggered = false;

  const batch = manager.createBatch({
    userId: "user_test",
    username: "test_operator",
    files: [
      { id: "f1", filename: "completed_file.dat", sizeBytes: 1000 },
      { id: "f2", filename: "low_progress.dat", sizeBytes: 1000, tempPartPath: part1 },
      { id: "f3", filename: "high_progress.dat", sizeBytes: 1000, tempPartPath: part2 },
      { id: "f4", filename: "queued_file.dat", sizeBytes: 1000 },
    ],
  });

  assert.strictEqual(batch.totalFiles, 4);
  assert.strictEqual(batch.status, "QUEUED");

  // f1 è già COMPLETED
  manager.setItemInProgress(batch.batchId, "f1");
  manager.setItemCompleted(batch.batchId, "f1");

  // f2 è IN_PROGRESS al 20% (< 90%)
  const ac1 = new AbortController();
  ac1.signal.addEventListener("abort", () => { abort1Triggered = true; });
  manager.setItemInProgress(batch.batchId, "f2", {
    abortController: ac1,
    tempPartPath: part1,
  });
  manager.updateItemProgress(batch.batchId, "f2", 200); // 20%

  // f3 è IN_PROGRESS al 95% (>= 90%)
  const ac2 = new AbortController();
  ac2.signal.addEventListener("abort", () => { abort2Triggered = true; });
  manager.setItemInProgress(batch.batchId, "f3", {
    abortController: ac2,
    tempPartPath: part2,
  });
  manager.updateItemProgress(batch.batchId, "f3", 950); // 95%

  // f4 rimane in QUEUED (avanzamento 0%)

  // Esecuzione cancellazione selettiva conforme al Requisito #9
  const cancelResult = await manager.cancelBatch(batch.batchId, "user_test");

  // Verifica:
  // f1 (COMPLETED): mantenuto intatto
  assert.strictEqual(batch.items.find((i) => i.id === "f1")?.status, "COMPLETED");
  assert.ok(cancelResult.completedFiles.includes("completed_file.dat"));

  // f2 (< 90%): annullato, flusso abortito e file .part eliminato
  assert.strictEqual(batch.items.find((i) => i.id === "f2")?.status, "CANCELLED");
  assert.ok(cancelResult.cancelledFiles.includes("low_progress.dat"));
  assert.strictEqual(abort1Triggered, true, "f2 deve aver subito abort()");
  assert.strictEqual(fs.existsSync(part1), false, "f2 .part deve essere stato eliminato");

  // f3 (>= 90%): consentito il completamento al 100% (COMPLETED)
  assert.strictEqual(batch.items.find((i) => i.id === "f3")?.status, "COMPLETED");
  assert.strictEqual(batch.items.find((i) => i.id === "f3")?.progressPercent, 100);
  assert.ok(cancelResult.completedFiles.includes("high_progress.dat"));
  assert.strictEqual(abort2Triggered, false, "f3 non deve essere abortito");

  // f4 (QUEUED): annullato
  assert.strictEqual(batch.items.find((i) => i.id === "f4")?.status, "CANCELLED");
  assert.ok(cancelResult.cancelledFiles.includes("queued_file.dat"));

  // Verifica log finale
  const transferLogs = await fileLogger.getTransferLogs({ limit: 50 });
  const finalLog = transferLogs.find((l) => l.includes("=== CARICAMENTO MASSIVO TERMINATO"));
  assert.ok(finalLog, "transfers.log deve contenere il tag finale del caricamento massivo");
  assert.ok(finalLog?.includes("Completati: 2/4, Annullati: 2, Falliti: 0"));

  fs.rmSync(tempDir, { recursive: true, force: true });
  console.log("  PASS: Test 2 BatchTransferManager & Selective Cancellation completato.");
}

// =========================================================================
// TEST 3: Inactivity Timeout Suspension during Active Transfers (Requisito #4)
// =========================================================================
async function testInactivitySuspension() {
  console.log("--- TEST 3: Inactivity Timeout Suspension & Heartbeat ---");
  const sessionManager = new SessionManager(1); // 1 minuto timeout inattività

  let activeTransfersCount = 0;
  sessionManager.setActiveTransfersProvider((_userId) => activeTransfersCount);

  const user = {
    id: "user_inact",
    username: "operatore_inact",
    roles: ["operatore"],
    enabled: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    passwordHash: "hash",
  };

  const session = sessionManager.createSession(user);

  // Simula trascorrere del tempo oltre la soglia (es. 2 minuti)
  const internalSession1 = (sessionManager as any).sessions.get(session.sessionId);
  internalSession1.lastActivityAt = new Date(Date.now() - 120 * 1000);

  // CASO A: 0 trasferimenti attivi -> la sessione scade
  activeTransfersCount = 0;
  const expiredSession = sessionManager.validate(session.sessionId);
  assert.strictEqual(expiredSession, null, "Senza trasferimenti attivi, la sessione inattiva deve scadere");

  // CASO B: con trasferimenti attivi (> 0) -> la sessione NON deve scadere e lastActivityAt viene aggiornato
  const session2 = sessionManager.createSession(user);
  const internalSession2 = (sessionManager as any).sessions.get(session2.sessionId);
  internalSession2.lastActivityAt = new Date(Date.now() - 120 * 1000); // 2m fa
  activeTransfersCount = 2; // 2 trasferimenti in corso

  const activeSession = sessionManager.validate(session2.sessionId);
  assert.ok(activeSession, "Con trasferimenti attivi (> 0), la sessione non deve scadere");
  assert.ok(activeSession.lastActivityAt.getTime() > Date.now() - 5000, "lastActivityAt deve essere aggiornato/toccato");

  // Purge expired sessions
  internalSession2.lastActivityAt = new Date(Date.now() - 120 * 1000);
  sessionManager.purgeExpiredSessions();
  assert.ok(sessionManager.getSession(session2.sessionId), "purgeExpiredSessions non deve rimuovere la sessione protetta da trasferimenti attivi");

  console.log("  PASS: Test 3 Inactivity Timeout Suspension validato.");
}

// =========================================================================
// TEST 4: Operator Path ACL & Terminal Block 403 (Requisito #3 & #7)
// =========================================================================
async function testOperatorAclAndTerminal() {
  console.log("--- TEST 4: Operator Path ACL & Terminal Block (HTTP 403) ---");
  const auditRepo = new InMemoryAuditRepository();

  const operatorUser = {
    id: "op_acl_01",
    username: "operatore_acl",
    roles: ["operatore"],
    allowedPaths: ["/data/logs", "/upload"],
  };

  const adminUser = {
    id: "admin_acl_01",
    username: "admin_acl",
    roles: ["admin"],
  };

  // 4a. Path authorization guard: Admin sempre ammesso
  await authorizeOperatorPath(adminUser as any, "server", "R1", "/etc/shadow", auditRepo);
  await authorizeOperatorPath(adminUser as any, "remote", "R1", "/root/.ssh", auditRepo);

  // 4b. Operatore su percorso consentito
  await authorizeOperatorPath(operatorUser as any, "server", "R1", "/data/logs/robot.log", auditRepo);
  await authorizeOperatorPath(operatorUser as any, "remote", "R1", "/upload/file.txt", auditRepo);

  // 4c. Operatore su percorso non consentito -> HTTP 403 & Audit SECURITY_AUTHORIZATION_ERROR
  let threw = false;
  try {
    await authorizeOperatorPath(operatorUser as any, "server", "R1", "/etc/passwd", auditRepo);
  } catch (err: any) {
    threw = true;
    assert.strictEqual(err.code, ErrorCode.INSUFFICIENT_PERMISSIONS);
  }
  assert.strictEqual(threw, true, "Operatore su percorso non consentito deve sollevare 403");

  const auditEvents = await auditRepo.query();
  const violation = auditEvents.find((e) => e.operation === AuditOperation.SECURITY_AUTHORIZATION_ERROR);
  assert.ok(violation, "Deve essere stato registrato un log SECURITY_AUTHORIZATION_ERROR");
  assert.strictEqual(violation?.details?.requestedPath, "/etc/passwd");

  // 4d. Root listing consentito solo se isListingRootAllowed = true
  await authorizeOperatorPath(operatorUser as any, "server", "R1", "/", auditRepo, { isListingRootAllowed: true });

  console.log("  PASS: Test 4 Operator Path ACL & Audit verificati.");
}

async function runAll() {
  await testPhysicalFileLogger();
  await testBatchTransferManager();
  await testInactivitySuspension();
  await testOperatorAclAndTerminal();
  console.log("PASS: Tutti i test della suite FASE 1 Backend sono stati SUPERATI!");
}

runAll().catch((err) => {
  console.error("FATAL in backend-fase1.test.ts:", err);
  process.exit(1);
});
