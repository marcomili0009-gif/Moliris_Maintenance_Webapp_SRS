import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { MongoClient } from "mongodb";
import { PhysicalFileLogger, type TransferLogEntry } from "../../backend/logging/physical-file-logger.ts";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "moliris-outcomes-"));
const client = new MongoClient(process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017", {
  serverSelectionTimeoutMS: 3_000,
});
const db = client.db(`moliris_outcomes_test_${process.pid}_${Date.now()}`);
const journal = db.collection<{ _id: string; projectedAt: Date | null }>("transfer_log_outcomes");
const entries: TransferLogEntry[] = [
  { transferId: "single", filename: "single.bin", username: "admin", direction: "CLIENT_TO_SERVER", outcome: "SUCCESSO" },
  { transferId: "batch1_0_0", batchId: "batch1", filename: "failed.bin", username: "admin", direction: "CLIENT_TO_ROBOT", outcome: "FALLIMENTO" },
  { transferId: "batch1_0_1", batchId: "batch1", filename: "cancelled.bin", username: "admin", direction: "CLIENT_TO_SERVER", outcome: "ANNULLATO" },
];

let recovered: PhysicalFileLogger | undefined;
try {
  const interrupted = new PhysicalFileLogger(root, { db });
  // An actual I/O fault in the temporary directory while MongoDB remains healthy.
  await fs.mkdir(interrupted.getTransferLogFilePath());
  await interrupted.logBulkStart("batch1", "admin", 2);
  for (const entry of entries) await interrupted.logTransfer(entry);
  await interrupted.logBulkEnd("batch1", { totalFiles: 2, completed: 0, failed: 1, cancelled: 1 });
  assert.equal(await journal.countDocuments({ projectedAt: null }), 5);
  assert.equal(await journal.countDocuments({}), 5);
  await fs.rmdir(interrupted.getTransferLogFilePath());

  recovered = new PhysicalFileLogger(root, { db, maxFileSizeBytes: 192 });
  await recovered.startRecovery();
  for (let attempts = 0; attempts < 15 && await journal.countDocuments({ projectedAt: null }); attempts++) {
    await delay(100);
  }
  await recovered.flush();
  assert.equal(await journal.countDocuments({ projectedAt: null }), 0);

  // Model a process exit between fsync and Mongo acknowledging the projection.
  await journal.updateOne({ _id: "transfer:single" }, { $set: { projectedAt: null } });
  recovered.stopRecovery();
  recovered = new PhysicalFileLogger(root, { db, maxFileSizeBytes: 192 });
  await recovered.startRecovery();
  await recovered.flush();
  await Promise.all(entries.map((entry) => recovered!.logTransfer(entry)));
  assert.equal(await journal.countDocuments({ projectedAt: null }), 0);
  assert.equal(await journal.countDocuments({}), 5);
  const stream = await recovered.openTransferLogDownload();
  const fragments: string[] = [];
  for await (const chunk of stream) fragments.push(String(chunk));
  const lines = fragments.join("").trim().split("\n");
  assert.equal(lines.length, 5, "Gli esiti e delimitatori devono comparire una sola volta");
  for (const entry of entries) {
    assert.equal(lines.filter((line) => line.includes(` | Esito: ${entry.outcome}`) && line.includes(` | ID: ${entry.transferId} |`)).length, 1);
  }
  assert.match(lines[0], /^=== INIZIO CARICAMENTO MASSIVO/);
  assert.match(lines[4], /^=== CARICAMENTO MASSIVO TERMINATO/);
  assert.ok((await fs.readdir(root)).some((name) => name.startsWith("transfers.log.archive.")));
  const offlineClient = new MongoClient("mongodb://127.0.0.1:1", { serverSelectionTimeoutMS: 250 });
  try {
    const offline = new PhysicalFileLogger(root, { db: offlineClient.db(db.databaseName) });
    const queued = await offline.logTransfer({ ...entries[0], transferId: "spooled", filename: "spooled.bin" });
    assert.match(queued, /Esito: SUCCESSO/);
    assert.equal(await journal.countDocuments({ _id: "transfer:spooled" }), 0);
    assert.equal((await fs.readdir(path.join(root, ".transfer-log-pending"))).length, 1);

    recovered.stopRecovery();
    recovered = new PhysicalFileLogger(root, { db });
    await recovered.startRecovery();
    await recovered.flush();
    assert.equal(await journal.countDocuments({ _id: "transfer:spooled", projectedAt: { $ne: null } }), 1);
    assert.equal((await fs.readdir(path.join(root, ".transfer-log-pending"))).length, 0);
  } finally {
    await offlineClient.close();
  }
  console.log("PASS: esiti e delimitatori Mongo durevoli su guasto fisico, rotazione senza perdita, replay dopo riavvio senza duplicati.");
} finally {
  recovered?.stopRecovery();
  await recovered?.flush();
  await db.dropDatabase();
  await client.close();
  await fs.rm(root, { recursive: true, force: true });
}
