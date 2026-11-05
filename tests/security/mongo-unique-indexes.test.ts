// Requisiti soddisfatti: RF-ROB-006, §8.2, Problema 1b, 1d, RNF-SEC-002, RNF-REL-004
// Test di verifica indici univoci MongoDB anti-TOCTOU e concorrenza

import assert from "assert";
import { MongoClient } from "mongodb";
import { MongoRobotRepository } from "../../storage/robot-repository.ts";
import { type RobotEntity } from "../../storage/robot-models.ts";

console.log("--> Esecuzione test suite Indici Univoci MongoDB Anti-TOCTOU (RF-ROB-006, §8.2)...");

const mongoUri = process.env.MONGODB_URI || "mongodb://localhost:27017/moliris_test_indexes";
let client: MongoClient | null = null;

try {
  client = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 2000 });
  await client.connect();
  const db = client.db();
  await db.dropDatabase();

  const repo = new MongoRobotRepository(db, "per_host");
  await repo.initIndexes();

  const r1: RobotEntity = {
    id: "test-idx-1",
    displayName: "Test 1",
    remoteUsername: "user1",
    host: "10.0.0.1",
    sshPort: 22,
    sshAuthMethod: "password",
    credentialReference: "vault://robots/test-idx-1",
    hostKeyVerification: { fingerprint: "0".repeat(64) },
    stateFilePaths: ["/tmp/status.txt"],
    serverDirectoryPath: "/tmp/robots/user1_test-idx-1",
    anagraphicState: "attivo",
    connectionState: "raggiungibile",
    operationalState: null,
    lastValidUpdateAt: null,
    registrationState: "registrazione_completata",
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  await repo.create(r1);

  // 1. Rifiuto ID duplicato
  let dupIdFailed = false;
  try {
    await repo.create({ ...r1, serverDirectoryPath: "/tmp/robots/user1_diff" });
  } catch {
    dupIdFailed = true;
  }
  assert.strictEqual(dupIdFailed, true, "ID duplicato deve essere respinto dall'indice univoco MongoDB");

  // 2. Rifiuto serverDirectoryPath duplicato
  let dupDirFailed = false;
  try {
    await repo.create({ ...r1, id: "test-idx-2" });
  } catch {
    dupDirFailed = true;
  }
  assert.strictEqual(dupDirFailed, true, "serverDirectoryPath duplicato deve essere respinto dall'indice univoco MongoDB");

  // 3. Rifiuto tripletta (host, sshPort, remoteUsername) duplicata per robot attivo
  let dupTripletFailed = false;
  try {
    await repo.create({
      ...r1,
      id: "test-idx-3",
      serverDirectoryPath: "/tmp/robots/user1_test-idx-3",
    });
  } catch {
    dupTripletFailed = true;
  }
  assert.strictEqual(dupTripletFailed, true, "Tripletta (host, port, username) duplicata deve essere respinta dall'indice univoco MongoDB");

  await db.dropDatabase();
  console.log("PASS: Tutti i controlli indici univoci MongoDB superati con successo.");
} catch (err: any) {
  if (err.message?.includes("connect ECONNREFUSED") || err.name === "MongoServerSelectionError") {
    console.log("  [SKIP] Istanza MongoDB non raggiungibile in questo ambiente; test saltato senza errore.");
  } else {
    throw err;
  }
} finally {
  if (client) {
    await client.close().catch(() => {});
  }
}
