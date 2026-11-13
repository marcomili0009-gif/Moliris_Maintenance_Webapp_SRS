// Script di migrazione controllata e ripetibile per Moliris Maintenance Webapp (SRS v1.0)
// 1. Allineamento e sincronizzazione customerName -> clientName (retrocompatibile, non distruttivo)
// 2. Inizializzazione della collection separata robot_telemetry_history a partire dai dati di monitoraggio esistenti
// 3. Creazione sicura degli indici composti (audit_events, robots, robot_telemetry_history)

import { MongoClient } from "mongodb";
import { resolveMongoConfig } from "../config/mongodb.ts";
import { MongoRobotRepository } from "../storage/robot-repository.ts";
import { MongoAuditRepository } from "../storage/audit-repository.ts";
import { MongoTelemetryRepository } from "../storage/telemetry-repository.ts";

export async function runDatabaseImprovementsMigration(customUri?: string): Promise<{
  robotsUpdated: number;
  telemetryRecordsCreated: number;
  indexesCreated: boolean;
}> {
  const mongoConfig = resolveMongoConfig();
  const uri = customUri || mongoConfig.uri;
  const client = new MongoClient(uri);

  try {
    await client.connect();
    const db = client.db(mongoConfig.dbName);

    console.log(`[MIGRAZIONE] Connessione riuscita a MongoDB: ${mongoConfig.dbName}`);

    // Inizializzazione indici composti
    const robotRepo = new MongoRobotRepository(db);
    const auditRepo = new MongoAuditRepository(db);
    const telemetryRepo = new MongoTelemetryRepository(db);

    console.log("[MIGRAZIONE] Creazione indici composti ed evoluzione schema...");
    await robotRepo.initIndexes();
    await auditRepo.initIndexes();
    await telemetryRepo.initIndexes(90);

    // 1. Sincronizzazione customerName -> clientName su collection robots
    const robotsCollection = db.collection("robots");
    const robotsCursor = robotsCollection.find({
      $or: [
        { customerName: { $exists: true, $ne: null } },
        { clientName: { $exists: true, $ne: null } },
      ],
    });

    let robotsUpdated = 0;
    while (await robotsCursor.hasNext()) {
      const robot = await robotsCursor.next();
      if (!robot) continue;

      const clientName = robot.clientName || robot.customerName;
      const customerName = robot.customerName || robot.clientName;

      if (robot.clientName !== clientName || robot.customerName !== customerName) {
        await robotsCollection.updateOne(
          { _id: robot._id },
          {
            $set: {
              clientName,
              customerName,
              updatedAt: new Date(),
            },
          }
        );
        robotsUpdated++;
      }
    }
    console.log(`[MIGRAZIONE] Documenti robots sincronizzati (clientName/customerName): ${robotsUpdated}`);

    // 2. Popolamento iniziale robot_telemetry_history dai record robot con dati di monitoraggio
    const robotsWithTelemetry = await robotsCollection
      .find({
        $or: [
          { operationalState: { $ne: null } },
          { lastAttemptOutcome: { $ne: null } },
        ],
      })
      .toArray();

    let telemetryRecordsCreated = 0;
    for (const r of robotsWithTelemetry) {
      if (r.lastAttemptOutcome || r.operationalState) {
        await telemetryRepo.record({
          robotId: r.id,
          timestamp: r.lastAttemptOutcome?.timestamp || r.lastValidUpdateAt || new Date(),
          connectionState: r.connectionState || "non_verificato",
          operationalState: r.operationalState || null,
          lastAttemptOutcome: r.lastAttemptOutcome || null,
        });
        telemetryRecordsCreated++;
      }
    }
    console.log(`[MIGRAZIONE] Record telemetria storicizzati in robot_telemetry_history: ${telemetryRecordsCreated}`);

    return {
      robotsUpdated,
      telemetryRecordsCreated,
      indexesCreated: true,
    };
  } finally {
    await client.close();
  }
}

// Esecuzione autonoma CLI
if (process.argv[1] && process.argv[1].endsWith("migrate-database-improvements.ts")) {
  runDatabaseImprovementsMigration()
    .then((res) => {
      console.log("[MIGRAZIONE COMPLETATA CON SUCCESSO]:", JSON.stringify(res, null, 2));
      process.exit(0);
    })
    .catch((err) => {
      console.error("[ERRORE MIGRAZIONE]:", err);
      process.exit(1);
    });
}
