#!/usr/bin/env tsx
/**
 * Script di Bonifica Globale File Temporanei (Server + Tutti i Robot)
 * Riferimenti: RF-TRF-009, CA-TRF-005, RNF-FS-003, RNF-REL-005
 * 
 * Questo script individua ed elimina DEFINITIVAMENTE tutti i file temporanei
 * parziali orfani (.tmp_moliris_*.tmp, .tmp_*) sia sul filesystem locale del Server
 * che su tutti i Robot registrati nella flotta.
 */

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { Client } from "ssh2";
import { MongoClient } from "mongodb";
import { loadMasterKeyFromFile } from "../backend/connection/master-key.ts";
import { MongoCredentialProvider } from "../backend/connection/mongo-credential-provider.ts";

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

async function main() {
  console.log("\n=======================================================");
  console.log("🧹 MOLIRIS - BONIFICA GLOBALE FILE TEMPORANEI ORFANI");
  console.log("=======================================================\n");

  const serverRoot = process.env.MOLIRIS_FS_ROOT || path.resolve(process.cwd(), "server-fs");
  const mongoUri = process.env.MONGODB_URI || "mongodb://localhost:27017/moliris";
  const masterKeyFile =
    process.env.MOLIRIS_MASTER_KEY_FILE ||
    (fs.existsSync("/etc/moliris/master.key") ? "/etc/moliris/master.key" : path.resolve(process.cwd(), "master.key"));

  const allowedAuthMethods = (process.env.MOLIRIS_ALLOWED_SSH_AUTH_METHODS || "password,key")
    .split(",")
    .map((m) => m.trim() as "password" | "key");

  let totalServerFiles = 0;
  let totalServerBytes = 0;
  let totalRobotFiles = 0;
  let totalRobotBytes = 0;

  // -------------------------------------------------------------------------
  // FASE 1: BONIFICA FILESYSTEM LOCALE SERVER
  // -------------------------------------------------------------------------
  console.log(`▶ [1/2] Scansione e bonifica filesystem Server (${serverRoot})...`);

  if (fs.existsSync(serverRoot)) {
    const scanServerDir = async (dir: string) => {
      let entries: fs.Dirent[] = [];
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await scanServerDir(fullPath);
        } else if (
          entry.isFile() &&
          (entry.name.startsWith(".tmp_moliris_") ||
           (entry.name.startsWith(".tmp_") && entry.name.endsWith(".tmp")) ||
           entry.name.endsWith(".moliris_tmp"))
        ) {
          try {
            const st = await fs.promises.stat(fullPath);
            await fs.promises.unlink(fullPath);
            totalServerFiles++;
            totalServerBytes += st.size;
            console.log(`  [SERVER ELIMINATO] ${fullPath} (${formatBytes(st.size)})`);
          } catch (unlinkErr: any) {
            console.error(`  [SERVER ERRORE] Impossibile eliminare ${fullPath}: ${unlinkErr.message}`);
          }
        }
      }
    };

    await scanServerDir(serverRoot);
  } else {
    console.log(`  Cartella server root non trovata o vuota: ${serverRoot}`);
  }

  if (totalServerFiles === 0) {
    console.log("  Nessun file temporaneo orfano trovato sul Server.");
  } else {
    console.log(`  ✔ Bonifica Server completata: ${totalServerFiles} file eliminati (${formatBytes(totalServerBytes)} liberati).`);
  }

  // -------------------------------------------------------------------------
  // FASE 2: BONIFICA FILESYSTEM REMOTO DI TUTTI I ROBOT
  // -------------------------------------------------------------------------
  console.log("\n▶ [2/2] Scansione e bonifica filesystem remoto su TUTTI i Robot...");
  const mongo = new MongoClient(mongoUri);

  try {
    await mongo.connect();
    const db = mongo.db();

    let credProvider: MongoCredentialProvider | null = null;
    if (fs.existsSync(masterKeyFile)) {
      try {
        const masterKey = loadMasterKeyFromFile(masterKeyFile);
        credProvider = new MongoCredentialProvider(db, masterKey, allowedAuthMethods);
      } catch (keyErr: any) {
        console.warn(`  [AVVISO] Impossibile caricare master key da ${masterKeyFile}: ${keyErr.message}`);
      }
    } else {
      console.warn(`  [AVVISO] Master key non trovata in ${masterKeyFile}. I robot con credenziali cifrate non potranno essere contattati.`);
    }

    const robots = await db.collection("robots").find({}).toArray();

    if (robots.length === 0) {
      console.log("  Nessun robot registrato in anagrafica.");
    } else {
      console.log(`  Trovati ${robots.length} robot registrati. Connessione in corso...`);

      for (const robot of robots) {
        console.log(`\n  --- Robot: ${robot.id} (${robot.host}:${robot.sshPort}) ---`);
        let credentials: any = null;

        if (credProvider) {
          try {
            credentials = await credProvider.getCredentials(robot.credentialReference, robot.sshAuthMethod);
          } catch (credErr: any) {
            console.error(`  [ERRORE CREDENZIALI] ${credErr.message}`);
            continue;
          }
        }

        if (!credentials) {
          console.warn(`  [AVVISO] Credenziali non disponibili per '${robot.id}', salto.`);
          continue;
        }

        const conn = new Client();
        let robotFilesCount = 0;
        let robotBytesCount = 0;

        try {
          await new Promise<void>((resolve, reject) => {
            conn.on("ready", () => {
              conn.sftp(async (sftpErr, sftp) => {
                if (sftpErr) {
                  conn.end();
                  return reject(sftpErr);
                }

                const dirsToScan = [
                  `/home/${robot.remoteUsername}`,
                  "/tmp",
                ];

                for (const targetDir of dirsToScan) {
                  try {
                    const list: any[] = await new Promise((resDir) => {
                      sftp.readdir(targetDir, (readErr, files) => {
                        if (readErr) resDir([]);
                        else resDir(files || []);
                      });
                    });

                    const tempFiles = list.filter((item) =>
                      item.filename &&
                      (item.filename.startsWith(".tmp_moliris_") ||
                       (item.filename.startsWith(".tmp_") && item.filename.endsWith(".tmp")) ||
                       item.filename.endsWith(".moliris_tmp"))
                    );

                    for (const item of tempFiles) {
                      const remotePath = `${targetDir.endsWith("/") ? targetDir : targetDir + "/"}${item.filename}`;
                      const size = item.attrs?.size || 0;
                      await new Promise<void>((resUnlink) => {
                        sftp.unlink(remotePath, (err) => {
                          if (err) {
                            console.error(`    [ROBOT ERRORE] Impossibile eliminare ${remotePath}: ${err.message}`);
                          } else {
                            robotFilesCount++;
                            robotBytesCount += size;
                            console.log(`    [ROBOT ELIMINATO] ${remotePath} (${formatBytes(size)})`);
                          }
                          resUnlink();
                        });
                      });
                    }
                  } catch (dirErr: any) {
                    console.warn(`    Directory ${targetDir} non accessibile: ${dirErr.message}`);
                  }
                }

                conn.end();
                resolve();
              });
            });

            conn.on("error", (connErr) => {
              reject(connErr);
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

          totalRobotFiles += robotFilesCount;
          totalRobotBytes += robotBytesCount;

          if (robotFilesCount === 0) {
            console.log(`  ✔ Nessun file temporaneo orfano su '${robot.id}'.`);
          } else {
            console.log(`  ✔ Bonifica '${robot.id}' completata: ${robotFilesCount} file eliminati (${formatBytes(robotBytesCount)} liberati).`);
          }
        } catch (sshErr: any) {
          console.warn(`  [AVVISO] Connessione a '${robot.id}' fallita: ${sshErr.message}`);
        }
      }
    }
  } catch (mongoErr: any) {
    console.warn(`  [AVVISO MONGODB] Impossibile connettersi a MongoDB (${mongoUri}): ${mongoErr.message}`);
  } finally {
    await mongo.close().catch(() => {});
  }

  // ---------------------------------------------------------------------------
  // RIEPILOGO FINALE
  // ---------------------------------------------------------------------------
  const grandTotalFiles = totalServerFiles + totalRobotFiles;
  const grandTotalBytes = totalServerBytes + totalRobotBytes;

  console.log("\n=======================================================");
  console.log("📊 RIEPILOGO BONIFICA GLOBALE COMPLETATA");
  console.log("=======================================================");
  console.log(`• File rimossi dal Server:  ${totalServerFiles} (${formatBytes(totalServerBytes)})`);
  console.log(`• File rimossi dai Robot:   ${totalRobotFiles} (${formatBytes(totalRobotBytes)})`);
  console.log(`• TOTALE FILE ELIMINATI:    ${grandTotalFiles}`);
  console.log(`• SPAZIO TOTALE RECUPERATO: ${formatBytes(grandTotalBytes)}`);
  console.log("=======================================================\n");
}

main().catch((err) => {
  console.error("\n❌ Errore irreversibile durante la bonifica:", err.message);
  process.exit(1);
});
