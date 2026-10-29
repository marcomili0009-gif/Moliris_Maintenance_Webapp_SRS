// Strumento di provisioning iniziale utenti (Sviluppo e Collaudo)
// Requisiti: RF-AUTH-001, RNF-SEC-002, SRS §2.2
// NOTA: La SRS non descrive interfacce né API di gestione utenti. Questo script fornisce
// un meccanismo iniziale minimo per inserire gli account operatore e amministratore nel database.

import { MongoClient } from "mongodb";
import { hashPassword, type UserEntity } from "../backend/auth/user-models.ts";
import { MongoUserRepository } from "../backend/auth/user-repository.ts";

export async function seedInitialUsers(repo: { create(user: UserEntity): Promise<UserEntity>, findByUsername(username: string): Promise<UserEntity | null> }): Promise<void> {
  console.log("--> Provisioning utenti iniziali di test...");

  // 1. Utente Operatore (§2.2: "Utente autorizzato")
  const existingOperator = await repo.findByUsername("operatore");
  if (!existingOperator) {
    const operatorPasswordHash = await hashPassword("OperatorePass123!");
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
    const adminPasswordHash = await hashPassword("AdminPass123!");
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
  const mongoUri = process.env["MOLIRIS_MONGO_URI"] || "mongodb://127.0.0.1:27017";
  const dbName = process.env["MOLIRIS_DB_NAME"] || "moliris_db";

  const client = new MongoClient(mongoUri);
  try {
    await client.connect();
    const db = client.db(dbName);
    const repo = new MongoUserRepository(db);
    await repo.initIndexes();
    await seedInitialUsers(repo);
    console.log("Provisioning completato.");
  } catch (err: any) {
    console.error("Errore durante il provisioning utenti:", err.message);
    process.exit(1);
  } finally {
    await client.close();
  }
}
