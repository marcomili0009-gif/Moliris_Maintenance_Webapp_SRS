// Requisiti soddisfatti: Prompt Correttivo #3 (Parte B.1), RNF-MNT-001, RNF-SEC-004, §10.1, §10.4
//
// SCRIPT DI MIGRAZIONE IDEMPOTENTE PERCORSI AUTORIZZATI OPERATORI
// ==============================================================================
// Questo script assegna un elenco di radici consentite predefinite (fail-safe)
// a tutti gli utenti con ruolo 'operatore' che non hanno ancora il campo
// 'allowedPaths' valorizzato in MongoDB.

import { MongoClient } from "mongodb";
import { resolveMongoConfig } from "../config/mongodb.ts";
import { sanitizeAndValidateAllowedRoots } from "../backend/auth/path-authorization.ts";

export const DEFAULT_MIGRATION_OPERATOR_PATHS = [
  "/upload",
  "/shared",
  "/logs",
  "/backups",
  "/configs",
];

export interface MigrationResult {
  totalOperators: number;
  migratedOperators: number;
  skippedOperators: number;
  details: Array<{ username: string; status: "MIGRATED" | "SKIPPED"; allowedPaths: string[] }>;
}

export async function migrateOperatorPaths(
  db: any,
  defaultPaths: string[] = DEFAULT_MIGRATION_OPERATOR_PATHS
): Promise<MigrationResult> {
  const sanitizedDefaults = sanitizeAndValidateAllowedRoots(defaultPaths);
  const usersCollection = db.collection("users");

  const operators = await usersCollection
    .find({ roles: { $in: ["operatore", "operator"] } })
    .toArray();

  let migratedCount = 0;
  let skippedCount = 0;
  const details: MigrationResult["details"] = [];

  for (const user of operators) {
    if (Array.isArray(user.allowedPaths) && user.allowedPaths.length > 0) {
      skippedCount++;
      details.push({
        username: user.username,
        status: "SKIPPED",
        allowedPaths: user.allowedPaths,
      });
    } else {
      await usersCollection.updateOne(
        { id: user.id },
        {
          $set: {
            allowedPaths: sanitizedDefaults,
            updatedAt: new Date(),
          },
        }
      );
      migratedCount++;
      details.push({
        username: user.username,
        status: "MIGRATED",
        allowedPaths: sanitizedDefaults,
      });
    }
  }

  return {
    totalOperators: operators.length,
    migratedOperators: migratedCount,
    skippedOperators: skippedCount,
    details,
  };
}

// Esecuzione autonoma CLI
if (process.argv[1] && process.argv[1].endsWith("migrate-operator-paths.ts")) {
  const mongoConfig = resolveMongoConfig();
  const client = new MongoClient(mongoConfig.uri);

  async function run() {
    console.log("--> Avvio migrazione percorsi autorizzati operatori in MongoDB...");
    try {
      await client.connect();
      const db = client.db(mongoConfig.dbName);
      const res = await migrateOperatorPaths(db);

      console.log(`Migrazione completata con successo:`);
      console.log(`  - Operatori totali: ${res.totalOperators}`);
      console.log(`  - Operatori aggiornati: ${res.migratedOperators}`);
      console.log(`  - Operatori già configurati (ignorati): ${res.skippedOperators}`);
      for (const d of res.details) {
        console.log(`    * [${d.status}] ${d.username}: ${d.allowedPaths.join(", ")}`);
      }
    } catch (err: any) {
      console.error("Errore durante la migrazione dei percorsi operatore:", err.message);
      process.exit(1);
    } finally {
      await client.close();
    }
  }

  run();
}
