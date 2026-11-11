// Ripristino locale password admin tramite file protetto (0600).
import fs from "fs";
import { MongoClient } from "mongodb";
import { hashPassword } from "../backend/auth/user-models.ts";
import { MongoUserRepository } from "../backend/auth/user-repository.ts";
import { resolveMongoConfig } from "../config/mongodb.ts";

const argIndex = process.argv.indexOf("--password-file");
const passwordFile = argIndex >= 0 ? process.argv[argIndex + 1] : undefined;
if (!passwordFile) throw new Error("Uso: reset-admin-password.ts --password-file <file-0600>");
const stat = fs.statSync(passwordFile);
if (!stat.isFile() || (process.platform !== "win32" && (stat.mode & 0o077) !== 0)) {
  throw new Error("Il file password deve essere regolare e avere permessi 0600.");
}
const password = fs.readFileSync(passwordFile, "utf8").replace(/[\r\n]+$/, "");
if (password.length < 8) throw new Error("La nuova password deve contenere almeno 8 caratteri.");

const mongoConfig = resolveMongoConfig();
const client = new MongoClient(mongoConfig.uri);
try {
  await client.connect();
  const repo = new MongoUserRepository(client.db(mongoConfig.dbName));
  const admin = await repo.findByUsername("admin");
  if (!admin) throw new Error(`Utente admin non trovato nel database '${mongoConfig.dbName}'.`);
  await repo.update(admin.id, { passwordHash: await hashPassword(password), enabled: true });
  console.log(`Password aggiornata per admin nel database '${mongoConfig.dbName}'.`);
} finally {
  await client.close();
}
