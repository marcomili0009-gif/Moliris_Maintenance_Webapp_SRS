// Script di bonifica immediata dei file temporanei orfani sul robot (CA-TRF-005, RF-TRF-009)

import { Client } from "ssh2";
import { MongoClient } from "mongodb";
import { loadAndValidateConfig } from "../config/configuration.ts";
import { loadMasterKeyFromFile } from "../backend/connection/master-key.ts";
import { MongoCredentialProvider } from "../backend/connection/mongo-credential-provider.ts";

async function main() {
  const config = loadAndValidateConfig(process.env);
  const mongoUri = process.env.MONGODB_URI || "mongodb://localhost:27017/moliris";
  const mongo = new MongoClient(mongoUri);
  await mongo.connect();

  const db = mongo.db();
  const robot = await db.collection("robots").findOne({ id: "robot-vm-01" });
  if (!robot) {
    console.error("Robot 'robot-vm-01' non trovato in anagrafica.");
    await mongo.close();
    process.exit(1);
  }

  const masterKey = loadMasterKeyFromFile(config.masterKeyFilePath!);
  const credProvider = new MongoCredentialProvider(db, masterKey, config.allowedSshAuthMethods);
  const credentials = await credProvider.getCredentials(robot.credentialReference, robot.sshAuthMethod);
  if (!credentials) {
    console.error(`Credenziali per '${robot.id}' non trovate.`);
    await mongo.close();
    process.exit(1);
  }

  console.log(`Connessione SFTP verso ${robot.host}:${robot.sshPort} per bonifica file orfani...`);
  const conn = new Client();

  await new Promise<void>((resolve, reject) => {
    conn.on("ready", () => {
      conn.sftp((err, sftp) => {
        if (err) return reject(err);

        sftp.readdir("/home/robot", async (readErr, list) => {
          if (readErr) return reject(readErr);

          const orphanFiles = list.filter((item) =>
            item.filename.startsWith(".tmp_moliris_") && item.filename.endsWith(".tmp")
          );

          if (orphanFiles.length === 0) {
            console.log("Nessun file temporaneo orfano trovato in /home/robot.");
            conn.end();
            return resolve();
          }

          console.log(`Trovati ${orphanFiles.length} file temporanei orfani in /home/robot.`);

          let totalReclaimedBytes = 0;
          for (const item of orphanFiles) {
            const filePath = `/home/robot/${item.filename}`;
            const size = item.attrs.size;
            totalReclaimedBytes += size;

            await new Promise<void>((resUnlink) => {
              sftp.unlink(filePath, (unlinkErr) => {
                if (unlinkErr) {
                  console.error(`Errore eliminazione ${filePath}:`, unlinkErr.message);
                } else {
                  console.log(`[ELIMINATO] ${filePath} (${(size / (1024 * 1024)).toFixed(2)} MB)`);
                }
                resUnlink();
              });
            });
          }

          console.log(`Bonifica completata con successo! Spazio totale liberato: ${(totalReclaimedBytes / (1024 * 1024)).toFixed(2)} MB`);
          conn.end();
          resolve();
        });
      });
    });

    conn.on("error", (err) => {
      reject(err);
    });

    const connectConfig: any = {
      host: robot.host,
      port: robot.sshPort,
      username: robot.remoteUsername,
      readyTimeout: 10000,
    };

    if (credentials.method === "password") {
      connectConfig.password = credentials.password;
    } else if (credentials.method === "key") {
      connectConfig.privateKey = credentials.privateKey;
      if (credentials.passphrase) connectConfig.passphrase = credentials.passphrase;
    }

    conn.connect(connectConfig);
  });

  await mongo.close();
}

main().catch((err) => {
  console.error("Fallimento script di bonifica:", err.message);
  process.exit(1);
});
