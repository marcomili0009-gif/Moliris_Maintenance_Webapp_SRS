// Requisiti soddisfatti: RF-ROB-006, RF-ROB-008, §8.2, §10.1, RNF-FS-001, RNF-FS-004, RNF-MNT-002
//
// SCRIPT DI AUDIT DELLE DIRECTORY DEI ROBOT (SOLA LETTURA / DRY-RUN)
// ==============================================================================
// Questo script analizza l'anagrafica dei robot registrati nel database MongoDB
// e verifica la conformità dei percorsi serverDirectoryPath rispetto alla nuova
// regola di denominazione (<username>_<id>) introdotta per evitare collisioni.
//
// GARANZIE OPERATIVE:
// 1. Sola lettura (Dry-Run): Nessuna scrittura o alterazione viene effettuata su
//    database o filesystem. Nessuna rinomina automatica di directory esistenti.
// 2. Isolamento ed evidenziazione collisioni: Segnala percorsi duplicati o
//    potenziali conflitti senza effettuare modifiche.
// 3. Rispetto dei record storici: In conformità al vincolo baseline di non-regressione,
//    il sistema a runtime utilizza sempre il percorso memorizzato nel record
//    (robot.serverDirectoryPath) e non ricalcola il percorso al volo.
// 4. Dichiarazione d'ambito: Il DB attuale è da considerarsi di sviluppo/collaudo.

import fs from "fs";
import path from "path";
import { MongoClient } from "mongodb";
import { StandardRobotDirectoryNamingPolicy } from "../storage/robot-models.ts";

interface AuditReportItem {
  id: string;
  displayName: string;
  remoteUsername: string;
  host: string;
  sshPort: number;
  anagraphicState: string;
  storedDirectoryPath: string;
  expectedDirectoryPath: string;
  isCompliant: boolean;
  fsExists: boolean;
  notes: string[];
}

export async function runDirectoryAudit(options?: {
  mongoUri?: string;
  fsRoot?: string;
  silent?: boolean;
}): Promise<{
  totalRobots: number;
  compliantCount: number;
  legacyCount: number;
  collisionCount: number;
  items: AuditReportItem[];
}> {
  const mongoUri =
    options?.mongoUri ||
    process.env.MOLIRIS_MONGODB_URI ||
    process.env.MOLIRIS_MONGO_URI ||
    "mongodb://127.0.0.1:27017/moliris_maintenance";

  const fsRoot =
    options?.fsRoot ||
    process.env.MOLIRIS_FS_ROOT ||
    "/var/lib/moliris/server-fs";

  const namingPolicy = new StandardRobotDirectoryNamingPolicy();
  const client = new MongoClient(mongoUri);

  try {
    await client.connect();
    const db = client.db();
    const robotsCollection = db.collection("robots");

    const robots = await robotsCollection.find({}).toArray();

    const items: AuditReportItem[] = [];
    const dirMap = new Map<string, string[]>();

    for (const r of robots) {
      const stored = (r.serverDirectoryPath as string) || "";
      const expected = namingPolicy.resolveDirectoryPath(fsRoot, {
        id: r.id as string,
        remoteUsername: (r.remoteUsername as string) || "",
      });

      const isCompliant = path.resolve(stored) === path.resolve(expected);
      const fsExists = stored ? fs.existsSync(stored) : false;
      const notes: string[] = [];

      if (!isCompliant) {
        notes.push("Regola legacy (non segue <username>_<id>)");
      }
      if (!stored) {
        notes.push("serverDirectoryPath mancante nel record");
      }

      // Tracciamento per collisioni
      if (stored) {
        const norm = path.resolve(stored);
        const list = dirMap.get(norm) || [];
        list.push(r.id as string);
        dirMap.set(norm, list);
      }

      items.push({
        id: r.id as string,
        displayName: (r.displayName as string) || "",
        remoteUsername: (r.remoteUsername as string) || "",
        host: (r.host as string) || "",
        sshPort: (r.sshPort as number) || 22,
        anagraphicState: (r.anagraphicState as string) || "sconosciuto",
        storedDirectoryPath: stored,
        expectedDirectoryPath: expected,
        isCompliant,
        fsExists,
        notes,
      });
    }

    // Identificazione collisioni
    let collisionCount = 0;
    for (const item of items) {
      if (item.storedDirectoryPath) {
        const norm = path.resolve(item.storedDirectoryPath);
        const shared = dirMap.get(norm) || [];
        if (shared.length > 1) {
          collisionCount++;
          item.notes.push(`COLLISIONE ATTIVA: directory condivisa con robot [${shared.filter(id => id !== item.id).join(", ")}]`);
        }
      }
    }

    const compliantCount = items.filter(i => i.isCompliant).length;
    const legacyCount = items.length - compliantCount;

    if (!options?.silent) {
      console.log("\n==============================================================================");
      console.log("   MOLIRIS MAINTENANCE WEBAPP - REPORT AUDIT DIRECTORY ROBOT (DRY-RUN)");
      console.log("==============================================================================");
      console.log(`Database MongoDB: ${mongoUri}`);
      console.log(`Root Filesystem : ${fsRoot}`);
      console.log(`Data e Ora      : ${new Date().toISOString()}`);
      console.log(`Modalità        : SOLA LETTURA (Nessuna scrittura su DB o disco)`);
      console.log("------------------------------------------------------------------------------");
      console.log(`Totale robot esaminati    : ${items.length}`);
      console.log(`Conformi (<username>_<id>): ${compliantCount}`);
      console.log(`Legacy (vecchia regola)   : ${legacyCount}`);
      console.log(`Collisioni rilevate       : ${collisionCount}`);
      console.log("------------------------------------------------------------------------------");

      if (items.length === 0) {
        console.log("Nessun robot presente nel database.");
      } else {
        console.log("\nDETTAGLIO DEI ROBOT ESAMINATI:");
        console.log("------------------------------------------------------------------------------");
        for (const item of items) {
          console.log(`Robot ID      : ${item.id} (${item.displayName})`);
          console.log(`Stato         : ${item.anagraphicState} | Device: ${item.remoteUsername}@${item.host}:${item.sshPort}`);
          console.log(`Path Stored   : ${item.storedDirectoryPath}`);
          console.log(`Path Atteso   : ${item.expectedDirectoryPath}`);
          console.log(`Conforme      : ${item.isCompliant ? "SÌ (Nuova Regola)" : "NO (Legacy/Anomala)"}`);
          console.log(`Esiste su FS  : ${item.fsExists ? "SÌ" : "NO"}`);
          if (item.notes.length > 0) {
            console.log(`Note/Allarmi  : ${item.notes.join("; ")}`);
          }
          console.log("------------------------------------------------------------------------------");
        }
      }

      console.log("\nAVVISO ARCHITETTURALE:");
      console.log("- Il database attuale è di sviluppo/collaudo.");
      console.log("- La nuova regola di naming <username>_<id> viene applicata solo alle NUOVE registrazioni.");
      console.log("- I robot esistenti continuano a operare sul percorso registrato (robot.serverDirectoryPath).");
      console.log("- Nessuna migrazione o rinomina automatica di directory viene eseguita.\n");
    }

    return {
      totalRobots: items.length,
      compliantCount,
      legacyCount,
      collisionCount,
      items,
    };
  } finally {
    await client.close();
  }
}

// Esecuzione diretta se invocato da riga di comando
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename || "")) {
  runDirectoryAudit()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("Errore durante l'audit delle directory:", err);
      process.exit(1);
    });
}
