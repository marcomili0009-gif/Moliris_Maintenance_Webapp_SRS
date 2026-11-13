// Test di collaudo per le 3 Migliorie del Database (Indici Composti, clientName e Separazione Telemetria)

import assert from "assert";
import { MongoClient } from "mongodb";
import { MongoRobotRepository } from "../../storage/robot-repository.ts";
import { MongoAuditRepository } from "../../storage/audit-repository.ts";
import { MongoTelemetryRepository } from "../../storage/telemetry-repository.ts";
import { type RobotEntity } from "../../storage/robot-models.ts";

console.log("--> Esecuzione test suite Migliorie Database (Indici, Naming, Telemetria)...");

const mongoUri = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/moliris_test_improvements";
let client: MongoClient | null = null;

try {
  client = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 2000 });
  await client.connect();
  const db = client.db();
  await db.dropDatabase();

  // 1. Verifica Indici Composti Audit Repository
  const auditRepo = new MongoAuditRepository(db);
  await auditRepo.initIndexes(30);
  const auditIndexes = await db.collection("audit_events").indexes();
  const hasUserTimeIdx = auditIndexes.some((idx) => idx.key?.userId === 1 && idx.key?.timestamp === -1);
  const hasRobotTimeIdx = auditIndexes.some((idx) => idx.key?.robotId === 1 && idx.key?.timestamp === -1);
  assert.strictEqual(hasUserTimeIdx, true, "Indice composto { userId: 1, timestamp: -1 } deve esistere");
  assert.strictEqual(hasRobotTimeIdx, true, "Indice composto { robotId: 1, timestamp: -1 } deve esistere");
  console.log("  ✓ Indici composti audit_events verificati con successo");

  // 2. Verifica Indici Composti e Naming clientName/customerName su Robot Repository
  const robotRepo = new MongoRobotRepository(db, "per_host");
  await robotRepo.initIndexes();
  const robotIndexes = await db.collection("robots").indexes();
  const hasClientPlantIdx = robotIndexes.some((idx) => idx.key?.clientId === 1 && idx.key?.plantId === 1);
  assert.strictEqual(hasClientPlantIdx, true, "Indice composto { clientId: 1, plantId: 1 } deve esistere");
  console.log("  ✓ Indice composto robots ({ clientId: 1, plantId: 1 }) verificato con successo");

  // Inserimento robot con solo clientName -> verifica che customerName venga valorizzato
  const r1: RobotEntity = {
    id: "r-test-client-1",
    displayName: "Robot Test Client",
    remoteUsername: "bot1",
    host: "192.168.1.50",
    sshPort: 22,
    sshAuthMethod: "password",
    credentialReference: "vault://r-test-client-1",
    serverDirectoryPath: "/tmp/server-fs/bot1_r-test-client-1",
    anagraphicState: "attivo",
    connectionState: "raggiungibile",
    operationalState: { battery: 95 },
    lastValidUpdateAt: new Date(),
    registrationState: "registrazione_completata",
    clientId: "cli_100",
    clientName: "Cliente Alfa SpA",
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const createdR1 = await robotRepo.create(r1);
  assert.strictEqual(createdR1.clientName, "Cliente Alfa SpA");
  assert.strictEqual(createdR1.customerName, "Cliente Alfa SpA", "customerName deve essere popolato per retrocompatibilità");

  // Inserimento robot con legacy customerName -> verifica che clientName venga valorizzato
  const r2: RobotEntity = {
    id: "r-test-client-2",
    displayName: "Robot Test Legacy",
    remoteUsername: "bot2",
    host: "192.168.1.51",
    sshPort: 22,
    sshAuthMethod: "password",
    credentialReference: "vault://r-test-client-2",
    serverDirectoryPath: "/tmp/server-fs/bot2_r-test-client-2",
    anagraphicState: "attivo",
    connectionState: "raggiungibile",
    operationalState: null,
    lastValidUpdateAt: null,
    registrationState: "registrazione_completata",
    clientId: "cli_200",
    customerName: "Cliente Beta Srl",
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const createdR2 = await robotRepo.create(r2);
  assert.strictEqual(createdR2.clientName, "Cliente Beta Srl", "clientName deve essere popolato a partire da customerName");
  console.log("  ✓ Sincronizzazione bidirezionale clientName <-> customerName verificata");

  // 3. Verifica Repository e Collection Separata di Telemetria
  const telemetryRepo = new MongoTelemetryRepository(db, "robot_telemetry_history");
  await telemetryRepo.initIndexes(90);
  const telIndexes = await db.collection("robot_telemetry_history").indexes();
  const hasTelRobotTimeIdx = telIndexes.some((idx) => idx.key?.robotId === 1 && idx.key?.timestamp === -1);
  const hasTelTtlIdx = telIndexes.some((idx) => idx.key?.timestamp === 1 && idx.expireAfterSeconds === 90 * 86400);
  assert.strictEqual(hasTelRobotTimeIdx, true, "Indice { robotId: 1, timestamp: -1 } su telemetria deve esistere");
  assert.strictEqual(hasTelTtlIdx, true, "Indice TTL su telemetria deve esistere");

  // Salvataggio campioni di telemetria
  await telemetryRepo.record({
    robotId: "r-test-client-1",
    timestamp: new Date(Date.now() - 60000),
    connectionState: "raggiungibile",
    operationalState: { battery: 94 },
    lastAttemptOutcome: { timestamp: new Date(), success: true, stage: "monitoring" },
  });
  await telemetryRepo.record({
    robotId: "r-test-client-1",
    timestamp: new Date(),
    connectionState: "raggiungibile",
    operationalState: { battery: 95 },
    lastAttemptOutcome: { timestamp: new Date(), success: true, stage: "monitoring" },
  });

  const latest = await telemetryRepo.getLatestByRobot("r-test-client-1");
  assert.ok(latest);
  assert.strictEqual((latest.operationalState as any)?.battery, 95, "Deve recuperare l'ultimo record più recente");

  const history = await telemetryRepo.queryHistory("r-test-client-1", 10);
  assert.strictEqual(history.length, 2, "Lo storico deve restituire esattamente 2 record");
  console.log("  ✓ Collection robot_telemetry_history e query storico verificate con successo");

  console.log("--> TUTTI I TEST DELLE MIGLIORIE DEL DATABASE SONO STATI SUPERATI CON SUCCESSO! ✓");
} catch (err: any) {
  console.error("Test fallito:", err);
  process.exit(1);
} finally {
  if (client) {
    await client.close();
  }
}
