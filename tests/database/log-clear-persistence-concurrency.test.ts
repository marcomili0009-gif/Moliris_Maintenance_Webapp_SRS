import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { MongoClient } from "mongodb";
import { PhysicalFileLogger } from "../../backend/logging/physical-file-logger.ts";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "moliris-log-clear-"));
const client = new MongoClient(process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017", {
  serverSelectionTimeoutMS: 3_000,
});
const db = client.db(`moliris_log_clear_test_${process.pid}_${Date.now()}`);
const journal = db.collection<{ _id: string; projectedAt: Date | null }>("transfer_log_outcomes");

let logger: PhysicalFileLogger | undefined;
let restarted: PhysicalFileLogger | undefined;

try {
  // 1. Popola access.log e transfers.log con rotazione (.archive.* e legacy .1) + pending journal + spool locale
  logger = new PhysicalFileLogger(root, { db, maxFileSizeBytes: 180 });
  await logger.ensureInitialized();

  const accessLine1 = await logger.logAccess({
    event: "LOGIN",
    username: "admin",
    role: "admin",
    outcome: "SUCCESSO",
    details: "Primo accesso prima della rotazione",
  });
  const accessLine2 = await logger.logAccess({
    event: "LOGOUT",
    username: "admin",
    role: "admin",
    outcome: "SUCCESSO",
    details: "Secondo accesso per forzare rotazione archive",
  });
  assert.ok(accessLine1 && accessLine2);

  await logger.logTransfer({
    transferId: "t-archived-1",
    filename: "archived1.bin",
    username: "admin",
    direction: "CLIENT_TO_SERVER",
    outcome: "SUCCESSO",
    details: "Primo trasferimento per archivio",
  });
  await logger.logTransfer({
    transferId: "t-archived-2",
    filename: "archived2.bin",
    username: "admin",
    direction: "CLIENT_TO_ROBOT",
    outcome: "SUCCESSO",
    details: "Secondo trasferimento per archivio",
  });

  // Legacy rotated files
  await fs.writeFile(path.join(root, "access.log.1"), "legacy access line\n", { mode: 0o600 });
  await fs.writeFile(path.join(root, "transfers.log.1"), "legacy transfer line\n", { mode: 0o600 });

  // Pending MongoDB journal entry (projectedAt: null) e spool locale (.transfer-log-pending)
  await journal.insertOne({
    _id: "transfer:pending-before-clear",
    line: "[2026-11-27 10:00:00] File: pending.bin | Utente: admin | Direzione: CLIENT_TO_SERVER | Esito: SUCCESSO | ID: pending-before-clear | Dettagli: Pending",
    createdAt: new Date(),
    projectedAt: null,
  } as any);

  const offlineClient = new MongoClient("mongodb://127.0.0.1:1", { serverSelectionTimeoutMS: 200 });
  try {
    const offlineLogger = new PhysicalFileLogger(root, { db: offlineClient.db(db.databaseName) });
    await offlineLogger.logTransfer({
      transferId: "spooled-before-clear",
      filename: "spooled-before-clear.bin",
      username: "admin",
      direction: "CLIENT_TO_SERVER",
      outcome: "SUCCESSO",
    });
    await offlineLogger.flush();

    // Verifica che clearTransferLogs fallisca senza falso successo se MongoDB è irraggiungibile
    await assert.rejects(() => offlineLogger.clearTransferLogs());
  } finally {
    await offlineClient.close();
  }

  // Verifica che esistano archivi .archive.* prima dell'eliminazione
  const filesBefore = await fs.readdir(root);
  assert.ok(filesBefore.some((f) => f.startsWith("access.log.archive.")), "Atteso archivio access.log.archive.*");
  assert.ok(filesBefore.some((f) => f.startsWith("transfers.log.archive.")), "Atteso archivio transfers.log.archive.*");

  // 2. Svuota solo transfers.log e verifica isolamento + permessi 0600 + rimozione archivi e spool
  await logger.clearTransferLogs();
  assert.equal(await fs.readFile(logger.getTransferLogFilePath(), "utf-8"), "");
  assert.equal((await fs.stat(logger.getTransferLogFilePath())).mode & 0o777, 0o600);

  const filesAfterTransferClear = await fs.readdir(root);
  assert.ok(!filesAfterTransferClear.some((f) => f.startsWith("transfers.log.")), "Archivi transfers.log.* devono essere rimossi");
  assert.ok(filesAfterTransferClear.some((f) => f.startsWith("access.log.archive.")), "Archivi access.log.* devono restare intatti");
  assert.equal(await journal.countDocuments({ projectedAt: null }), 0, "I pending journal devono risultare chiusi dopo clearTransferLogs");
  assert.equal((await fs.readdir(path.join(root, ".transfer-log-pending"))).length, 0, "Lo spool locale deve essere svuotato");

  // 3. Simula riavvio backend con startRecovery(): i log eliminati NON devono ricomparire
  restarted = new PhysicalFileLogger(root, { db, maxFileSizeBytes: 180 });
  await restarted.startRecovery();
  await delay(200);
  await restarted.flush();

  assert.equal(await fs.readFile(restarted.getTransferLogFilePath(), "utf-8"), "", "transfers.log deve restare vuoto dopo il riavvio");
  assert.deepEqual(await restarted.getTransferLogs({ limit: 50 }), [], "getTransferLogs deve restituire [] dopo il riavvio");

  // Nuovi eventi dopo l'eliminazione devono essere conservati
  await restarted.logTransfer({
    transferId: "after-clear-1",
    filename: "after-clear.bin",
    username: "admin",
    direction: "CLIENT_TO_SERVER",
    outcome: "SUCCESSO",
  });
  const afterClearLogs = await restarted.getTransferLogs({ limit: 50 });
  assert.equal(afterClearLogs.length, 1);
  assert.ok(afterClearLogs[0].includes("after-clear.bin"));

  // 4. Svuota access.log e verifica isolamento + permessi 0600 + conservazione nuovi eventi
  await restarted.clearAccessLogs();
  assert.equal(await fs.readFile(restarted.getAccessLogFilePath(), "utf-8"), "");
  assert.equal((await fs.stat(restarted.getAccessLogFilePath())).mode & 0o777, 0o600);
  const filesAfterAccessClear = await fs.readdir(root);
  assert.ok(!filesAfterAccessClear.some((f) => f.startsWith("access.log.")), "Archivi access.log.* devono essere rimossi");
  assert.equal((await restarted.getTransferLogs({ limit: 50 })).length, 1, "clearAccessLogs non deve toccare transfers.log");

  await restarted.logAccess({
    event: "LOGIN",
    username: "admin",
    role: "admin",
    outcome: "SUCCESSO",
    details: "Nuovo evento dopo svuotamento",
  });
  const accessAfterClear = await restarted.getAccessLogs({ limit: 50 });
  assert.equal(accessAfterClear.length, 1);
  assert.ok(accessAfterClear[0].includes("Nuovo evento dopo svuotamento"));

  // 5. Test concorrenza tra scrittura, rotazione, download ed eliminazione
  const concurrentOps: Promise<unknown>[] = [];
  for (let i = 0; i < 15; i++) {
    concurrentOps.push(
      restarted.logTransfer({
        transferId: `concurrent-${i}`,
        filename: `concurrent-${i}.bin`,
        username: "admin",
        direction: "CLIENT_TO_SERVER",
        outcome: "SUCCESSO",
        details: `Scrittura concorrente numero ${i}`,
      })
    );
    concurrentOps.push(
      restarted.logAccess({
        event: "LOGIN",
        username: `user${i}`,
        role: "operatore",
        outcome: "SUCCESSO",
      })
    );
    if (i === 5) {
      concurrentOps.push(restarted.clearTransferLogs());
      concurrentOps.push(restarted.clearAccessLogs());
    }
    if (i === 10) {
      concurrentOps.push(
        restarted.openTransferLogDownload().then(async (stream) => {
          for await (const _chunk of stream) {
            // drain
          }
        })
      );
    }
  }
  await Promise.all(concurrentOps);
  await restarted.flush();

  assert.equal((await fs.stat(restarted.getTransferLogFilePath())).mode & 0o777, 0o600);
  assert.equal((await fs.stat(restarted.getAccessLogFilePath())).mode & 0o777, 0o600);

  // Verifica integrità delle righe residue dopo la raffica concorrente
  const residualTransfers = await restarted.getTransferLogs({ limit: 100 });
  for (const line of residualTransfers) {
    assert.ok(!/[\r\n]/.test(line), "Nessuna riga deve contenere newline interni");
    assert.match(line, /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] File:/);
  }

  console.log("PASS: eliminazione log, persistenza post-riavvio, gestione errori, permessi 0600 e concorrenza verificati.");
} finally {
  restarted?.stopRecovery();
  await restarted?.flush();
  logger?.stopRecovery();
  await logger?.flush();
  await db.dropDatabase().catch(() => {});
  await client.close().catch(() => {});
  await fs.rm(root, { recursive: true, force: true });
}
