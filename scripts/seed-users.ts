// Requisiti soddisfatti: RF-AUTH-001, RNF-SEC-002, RNF-SEC-004, SRS §2.2, §10.1, §11.6
//
// PROVISIONING INIZIALE UTENTI - SISTEMA MOLIRIS MAINTENANCE WEBAPP
// ==============================================================================
// Questa utility inizializza nel database gli account necessari ('operatore' e 'admin').
//
// SICUREZZA DELLE CREDENZIALI:
// 1. Lettura sicura da file protetto (0600):
//    Supporta l'opzione CLI --password-file <path> o la variabile SEED_USERS_PASSWORD_FILE.
//    Il file deve essere protetto con permessi restrittivi (0600: solo proprietario).
// 2. Eliminazione fallback hardcoded:
//    Nessuna password di fallback in chiaro è inclusa nel codice sorgente. Se non vengono
//    fornite credenziali via file o variabili, lo script fallisce tempestivamente (fail-closed).
// 3. Avviso sicurezza per variabili d'ambiente:
//    Se si utilizzano le variabili d'ambiente MOLIRIS_INITIAL_OPERATOR_PASSWORD / MOLIRIS_INITIAL_ADMIN_PASSWORD,
//    viene emesso un avviso di sicurezza poiché le variabili d'ambiente sono visibili in /proc/<pid>/environ.
// 4. Nessuna dispersione nei log:
//    Le password in chiaro non vengono MAI stampate a video o scritte nei file di log.
//
// INTEGRAZIONE SYSTEMD CON LoadCredential=:
// ==============================================================================
// Esempio di systemd unit one-shot (moliris-seed.service):
//   [Unit]
//   Description=Moliris Maintenance Webapp - Seeding iniziale utenti
//   After=network.target mongod.service
//
//   [Service]
//   Type=oneshot
//   User=moliris
//   Group=moliris
//   LoadCredential=seed_passwords:/etc/moliris/seed_passwords.env
//   ExecStart=/usr/bin/node --experimental-strip-types /opt/moliris/scripts/seed-users.ts --password-file %d/seed_passwords
//   ExecStartPost=/usr/bin/rm -f /etc/moliris/seed_passwords.env
//
//   [Install]
//   WantedBy=multi-user.target
//
// NOTA ARCHITETTURALE SULLA VARIABILE MONGO URI:
// Si segnala che questo script usa MOLIRIS_MONGO_URI mentre il server usa MOLIRIS_MONGODB_URI.
// Per conformità alle baseline e ai vincoli di non alterazione non autorizzata, la variabile
// MOLIRIS_MONGO_URI è mantenuta (con fallback su MOLIRIS_MONGODB_URI se definita).

import fs from "fs";
import { MongoClient } from "mongodb";
import { hashPassword, type UserEntity } from "../backend/auth/user-models.ts";
import { MongoUserRepository } from "../backend/auth/user-repository.ts";

export interface SeedPasswords {
  operatorPassword: string;
  adminPassword: string;
}

/**
 * Carica le password per il provisioning da file con permessi 0600 o da variabili d'ambiente.
 */
export function loadSeedPasswords(options?: {
  passwordFile?: string;
  env?: Record<string, string | undefined>;
}): SeedPasswords {
  const env = options?.env || process.env;
  const filePath = options?.passwordFile || env["SEED_USERS_PASSWORD_FILE"];

  if (filePath) {
    if (!fs.existsSync(filePath)) {
      throw new Error(`File password non trovato: '${filePath}'`);
    }
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
      throw new Error(`Il percorso specificato non è un file regolare: '${filePath}'`);
    }
    if (process.platform !== "win32") {
      if ((stat.mode & 0o077) !== 0) {
        throw new Error(
          `Permessi non sicuri sul file password '${filePath}' (${(stat.mode & 0o777).toString(8)}). Richiesti permessi restrittivi 0600 (nessun accesso a group o other).`
        );
      }
    }

    const content = fs.readFileSync(filePath, "utf8");
    let operatorPass: string | undefined;
    let adminPass: string | undefined;

    try {
      const parsed = JSON.parse(content);
      operatorPass = parsed.operatorPassword || parsed.OPERATOR_PASSWORD || parsed.MOLIRIS_INITIAL_OPERATOR_PASSWORD;
      adminPass = parsed.adminPassword || parsed.ADMIN_PASSWORD || parsed.MOLIRIS_INITIAL_ADMIN_PASSWORD;
    } catch {
      const lines = content.split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eqIdx = trimmed.indexOf("=");
        if (eqIdx !== -1) {
          const k = trimmed.substring(0, eqIdx).trim();
          let v = trimmed.substring(eqIdx + 1).trim();
          if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
            v = v.slice(1, -1);
          }
          if (k === "operatorPassword" || k === "OPERATOR_PASSWORD" || k === "MOLIRIS_INITIAL_OPERATOR_PASSWORD") {
            operatorPass = v;
          } else if (k === "adminPassword" || k === "ADMIN_PASSWORD" || k === "MOLIRIS_INITIAL_ADMIN_PASSWORD") {
            adminPass = v;
          }
        }
      }
    }

    if (!operatorPass || !adminPass) {
      throw new Error(
        `File password '${filePath}' non valido o incompleto: deve contenere sia la password per 'operatore' che per 'admin'.`
      );
    }

    return { operatorPassword: operatorPass, adminPassword: adminPass };
  }

  // Fallback controllato su variabili d'ambiente con avviso esplicito
  const envOp = env["MOLIRIS_INITIAL_OPERATOR_PASSWORD"];
  const envAdm = env["MOLIRIS_INITIAL_ADMIN_PASSWORD"];

  if (envOp && envAdm) {
    console.warn(
      "[AVVISO DI SICUREZZA]: Password lette da variabili d'ambiente. Le variabili d'ambiente possono essere lette da altri processi dello stesso utente o finire nei log di sistema. Si raccomanda l'uso di un file con permessi 0600 (--password-file o SEED_USERS_PASSWORD_FILE) o systemd LoadCredential=."
    );
    return { operatorPassword: envOp, adminPassword: envAdm };
  }

  throw new Error(
    "Provisioning iniziale fallito: nessuna password specificata. Le password predefinite hardcoded sono state rimosse per motivi di sicurezza (RNF-SEC-002). Specificare un file con permessi 0600 (--password-file o SEED_USERS_PASSWORD_FILE) oppure configurare le variabili d'ambiente."
  );
}

export async function seedInitialUsers(
  repo: { create(user: UserEntity): Promise<UserEntity>; findByUsername(username: string): Promise<UserEntity | null> },
  operatorPassword?: string,
  adminPassword?: string
): Promise<void> {
  console.log("--> Provisioning utenti iniziali...");

  let finalOpPassword = operatorPassword;
  let finalAdmPassword = adminPassword;

  if (!finalOpPassword || !finalAdmPassword) {
    const loaded = loadSeedPasswords();
    finalOpPassword = finalOpPassword || loaded.operatorPassword;
    finalAdmPassword = finalAdmPassword || loaded.adminPassword;
  }

  // 1. Utente Operatore (§2.2: "Utente autorizzato")
  const existingOperator = await repo.findByUsername("operatore");
  if (!existingOperator) {
    const operatorPasswordHash = await hashPassword(finalOpPassword);
    await repo.create({
      id: "user_operator_01",
      username: "operatore",
      passwordHash: operatorPasswordHash,
      roles: ["operatore"],
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    console.log("  Utente 'operatore' creato con successo (Ruolo: operatore).");
  } else {
    console.log("  Utente 'operatore' già presente.");
  }

  // 2. Utente Amministratore (§2.2: "Amministratore o gestore della flotta")
  const existingAdmin = await repo.findByUsername("admin");
  if (!existingAdmin) {
    const adminPasswordHash = await hashPassword(finalAdmPassword);
    await repo.create({
      id: "user_admin_01",
      username: "admin",
      passwordHash: adminPasswordHash,
      roles: ["amministratore"],
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    console.log("  Utente 'admin' creato con successo (Ruolo: amministratore).");
  } else {
    console.log("  Utente 'admin' già presente.");
  }
}

// Esecuzione autonoma CLI su MongoDB reale
if (process.argv[1] && process.argv[1].endsWith("seed-users.ts")) {
  let passwordFileArg: string | undefined;
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === "--password-file" && i + 1 < process.argv.length) {
      passwordFileArg = process.argv[i + 1];
      i++;
    }
  }

  const mongoUri = process.env["MOLIRIS_MONGODB_URI"];

  if (!mongoUri) {
    throw new Error("Variabile MOLIRIS_MONGODB_URI non configurata");
  }

  const client = new MongoClient(mongoUri);
  try {
    const passwords = loadSeedPasswords({ passwordFile: passwordFileArg });
    await client.connect();
<<<<<<< Updated upstream
    const db = client.db();
=======
    const db = process.env["MOLIRIS_DB_NAME"] ? client.db(process.env["MOLIRIS_DB_NAME"]) : client.db();
>>>>>>> Stashed changes
    const repo = new MongoUserRepository(db);
    await repo.initIndexes();
    await seedInitialUsers(repo, passwords.operatorPassword, passwords.adminPassword);
    console.log("Provisioning completato con successo.");
  } catch (err: any) {
    console.error("Errore durante il provisioning utenti:", err.message);
    process.exit(1);
  } finally {
    await client.close();
  }
}
