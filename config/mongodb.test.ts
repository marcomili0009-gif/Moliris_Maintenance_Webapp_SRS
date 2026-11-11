import assert from "node:assert/strict";
import { resolveMongoConfig } from "./mongodb.ts";

console.log("--> Test configurazione MongoDB...");

// Test 1: URI predefinito
assert.deepEqual(resolveMongoConfig({}), {
  uri: "mongodb://127.0.0.1:27017/moliris",
  dbName: "moliris",
});

// Test 2: URI principale
assert.deepEqual(
  resolveMongoConfig({
    MOLIRIS_MONGODB_URI: "mongodb://localhost:27017/moliris_maintenance",
  }),
  {
    uri: "mongodb://localhost:27017/moliris_maintenance",
    dbName: "moliris_maintenance",
  },
);

// Test 3: Alias compatibile
assert.deepEqual(
  resolveMongoConfig({
    MOLIRIS_MONGO_URI: "mongodb://localhost:27017/alias_db",
  }),
  {
    uri: "mongodb://localhost:27017/alias_db",
    dbName: "alias_db",
  },
);

// Test 4: La variabile principale ha precedenza sull'alias
assert.equal(
  resolveMongoConfig({
    MOLIRIS_MONGODB_URI: "mongodb://localhost:27017/primary_db",
    MOLIRIS_MONGO_URI: "mongodb://localhost:27017/alias_db",
  }).dbName,
  "primary_db",
);

// Test 5: MOLIRIS_DB_NAME prevale sul database nell'URI
assert.equal(
  resolveMongoConfig({
    MOLIRIS_MONGODB_URI: "mongodb://localhost:27017/uri_db",
    MOLIRIS_DB_NAME: "explicit_db",
  }).dbName,
  "explicit_db",
);

// Test 6: URI senza nome database
assert.equal(
  resolveMongoConfig({
    MOLIRIS_MONGODB_URI: "mongodb://localhost:27017",
  }).dbName,
  "moliris",
);

// Test 7: Opzioni esplicite prevalgono sulle variabili d'ambiente
assert.deepEqual(
  resolveMongoConfig(
    {
      MOLIRIS_MONGODB_URI: "mongodb://localhost:27017/env_db",
      MOLIRIS_DB_NAME: "env_name",
    },
    {
      uri: "mongodb://localhost:27017/override_db",
      dbName: "override_name",
    },
  ),
  {
    uri: "mongodb://localhost:27017/override_db",
    dbName: "override_name",
  },
);

// Test 8: URI con credenziali e parametri di connessione
assert.equal(
  resolveMongoConfig({
    MOLIRIS_MONGODB_URI: "mongodb://user:password@localhost:27017/my%2Ddb?authSource=admin",
  }).dbName,
  "my-db",
);

// Test 9: URI MongoDB SRV con parametri
assert.equal(
  resolveMongoConfig({
    MOLIRIS_MONGODB_URI: "mongodb+srv://cluster.example.com/srv_db?retryWrites=true",
  }).dbName,
  "srv_db",
);

console.log("PASS: tutti i 9 test della configurazione MongoDB.");
