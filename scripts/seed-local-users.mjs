import { MongoClient } from "mongodb";
import { MongoUserRepository } from "../dist/backend/auth/user-repository.js";
import { loadSeedPasswords, seedInitialUsers } from "../dist/scripts/seed-users.js";
import { resolveMongoConfig } from "../dist/config/mongodb.js";

const passwordFile = process.argv[2];
if (!passwordFile) throw new Error("Percorso file password mancante.");
const passwords = loadSeedPasswords({ passwordFile });
const mongo = resolveMongoConfig();
const client = new MongoClient(mongo.uri);
try {
  await client.connect();
  const users = new MongoUserRepository(client.db(mongo.dbName));
  await users.initIndexes();
  await seedInitialUsers(users, passwords.operatorPassword, passwords.adminPassword);
} finally {
  await client.close();
}
