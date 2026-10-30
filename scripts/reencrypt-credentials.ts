// Requisiti soddisfatti: RNF-SEC-002, RNF-SEC-004, SRS §11.2
//
// SCRIPT CLI DI RE-ENCRYPTION IDEMPOTENTE DELLE CREDENZIALI
// ==============================================================================
// Permette la rotazione sicura della master key AES-256 a riposo.
// Algoritmo:
// 1. Carica la vecchia e la nuova chiave dai percorsi specificati (con controllo permessi 0600).
// 2. Per ciascun record in 'robot_credentials':
//    - Verifica se il record è già decifrabile con la nuova chiave (idempotenza). In tal caso salta.
//    - Decifra con la vecchia chiave e AAD 'robotId|oldKeyVersion'.
//    - Cifra con la nuova chiave, nuovo IV casuale a 96 bit e AAD 'robotId|newKeyVersion' (con newKeyVersion = oldKeyVersion + 1).
//    - Verifica immediatamente la decifratura in memoria con la nuova chiave prima di toccare il DB.
//    - Aggiorna il record su MongoDB.
// In caso di interruzione a metà, nessun record è reso illeggibile e lo script può essere rieseguito in sicurezza.

import { MongoClient } from "mongodb";
import { loadMasterKeyFromFile } from "../backend/connection/master-key.ts";
import { MongoCredentialProvider, type EncryptedCredentialDocument } from "../backend/connection/mongo-credential-provider.ts";

export interface ReencryptOptions {
  oldKeyFile: string;
  newKeyFile: string;
  mongoUri?: string;
  dbName?: string;
}

export async function reencryptAllCredentials(options: ReencryptOptions): Promise<{
  total: number;
  reencrypted: number;
  alreadyUpdated: number;
}> {
  const oldKey = loadMasterKeyFromFile(options.oldKeyFile);
  const newKey = loadMasterKeyFromFile(options.newKeyFile);

  const mongoUri = options.mongoUri || process.env["MOLIRIS_MONGODB_URI"] || process.env["MOLIRIS_MONGO_URI"] || "mongodb://127.0.0.1:27017";
  const dbName = options.dbName || process.env["MOLIRIS_DB_NAME"] || "moliris_db";

  const client = new MongoClient(mongoUri);
  await client.connect();

  try {
    const db = client.db(dbName);
    const collection = db.collection<EncryptedCredentialDocument>("robot_credentials");
    const providerHelper = new MongoCredentialProvider(db, oldKey);

    const cursor = collection.find({});
    let total = 0;
    let reencrypted = 0;
    let alreadyUpdated = 0;

    for await (const doc of cursor) {
      total++;

      // 1. Verifica se il record è già cifrato con la nuova chiave (idempotenza)
      let alreadyNew = false;
      try {
        providerHelper.decryptMaterial(doc, newKey);
        alreadyNew = true;
      } catch {
        alreadyNew = false;
      }

      if (alreadyNew) {
        alreadyUpdated++;
        continue;
      }

      // 2. Decifratura con la vecchia chiave e vecchio AAD
      const material = providerHelper.decryptMaterial(doc, oldKey);

      // 3. Nuova versione chiave e cifratura con nuova chiave e nuovo AAD
      const nextKeyVersion = (doc.keyVersion || 1) + 1;
      const newEncrypted = providerHelper.encryptMaterial(
        doc.robotId,
        material,
        nextKeyVersion,
        newKey
      );

      // 4. Verifica immediata in memoria prima di persistere su DB
      const candidateDoc: EncryptedCredentialDocument = {
        robotId: doc.robotId,
        credentialReference: doc.credentialReference,
        encryptedSecret: newEncrypted.encryptedSecret,
        iv: newEncrypted.iv,
        authTag: newEncrypted.authTag,
        keyVersion: nextKeyVersion,
        updatedAt: new Date(),
      };

      // Test di decifratura
      providerHelper.decryptMaterial(candidateDoc, newKey);

      // 5. Scrittura atomica del record aggiornato su MongoDB
      await collection.updateOne(
        { _id: (doc as any)._id },
        {
          $set: {
            encryptedSecret: newEncrypted.encryptedSecret,
            iv: newEncrypted.iv,
            authTag: newEncrypted.authTag,
            keyVersion: nextKeyVersion,
            updatedAt: new Date(),
          },
        }
      );

      reencrypted++;
    }

    return { total, reencrypted, alreadyUpdated };
  } finally {
    await client.close();
  }
}

// Esecuzione autonoma CLI
if (process.argv[1] && process.argv[1].endsWith("reencrypt-credentials.ts")) {
  let oldKeyFile: string | undefined;
  let newKeyFile: string | undefined;

  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === "--old-key-file" && i + 1 < process.argv.length) {
      oldKeyFile = process.argv[i + 1];
      i++;
    } else if (process.argv[i] === "--new-key-file" && i + 1 < process.argv.length) {
      newKeyFile = process.argv[i + 1];
      i++;
    }
  }

  if (!oldKeyFile || !newKeyFile) {
    console.error("Uso: node reencrypt-credentials.ts --old-key-file <path> --new-key-file <path>");
    process.exit(1);
  }

  try {
    console.log("--> Avvio re-encryption delle credenziali dei robot...");
    const result = await reencryptAllCredentials({ oldKeyFile, newKeyFile });
    console.log(`Re-encryption completata con successo: ${result.reencrypted} aggiornati, ${result.alreadyUpdated} già aggiornati (totale: ${result.total}).`);
  } catch (err: any) {
    console.error("Errore durante la re-encryption:", err.message);
    process.exit(1);
  }
}
