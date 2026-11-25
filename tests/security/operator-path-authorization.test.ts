// Requisiti verificati: Prompt Correttivo #3 (Parte B), RF-AUTH-005, RF-SRVFS-005, RF-FS-001, RF-FS-007, RNF-SEC-004, RNF-SEC-005, §10.1, §10.4

import assert from "node:assert";
import {
  validateAndNormalizePath,
  toCanonicalPosixPath,
  isPathAllowedByComponents,
  sanitizeAndValidateAllowedRoots,
  assertPathAuthorized,
} from "../../backend/auth/path-authorization.ts";
import { type AuthorizedContext } from "../../backend/auth/session-manager.ts";
import { AppPermission } from "../../backend/auth/permissions.ts";
import { ErrorCode } from "../../errors/app-errors.ts";
import { InMemoryAuditRepository } from "../../storage/audit-repository.ts";
import { AuditOperation } from "../../storage/audit-models.ts";
import { migrateOperatorPaths } from "../../scripts/migrate-operator-paths.ts";

console.log("--> Esecuzione test suite percorsi autorizzati operatore (Prompt Correttivo #3 Parte B)...");

// =========================================================================
// TEST 1: Normalizzazione e rifiuto caratteri vietati / path traversal
// =========================================================================
{
  assert.strictEqual(validateAndNormalizePath("/data/logs"), "/data/logs");
  assert.strictEqual(validateAndNormalizePath("/data//logs/./2026/"), "/data/logs/2026");

  // Rifiuto byte nulli e caratteri di controllo
  assert.throws(
    () => validateAndNormalizePath("/data\0/logs"),
    /caratteri non ammessi/
  );
  assert.throws(
    () => validateAndNormalizePath("/data\x1b/logs"),
    /caratteri non ammessi/
  );

  // Rifiuto path traversal
  assert.throws(
    () => validateAndNormalizePath("../outside"),
    /attraversamento directory/i
  );
  assert.throws(
    () => validateAndNormalizePath("/data/../outside"),
    /attraversamento directory/i
  );

  console.log("  PASS: Test 1 - Normalizzazione e rifiuto caratteri vietati/traversal completato.");
}

// =========================================================================
// TEST 2: Confronto rigoroso per componenti (segmenti) di percorso
// =========================================================================
{
  const allowedRoots = ["/data/a", "/logs"];

  // Segmento esatto -> OK
  assert.strictEqual(isPathAllowedByComponents("/data/a", allowedRoots), true);
  // Sottodirectory / sottofile -> OK
  assert.strictEqual(isPathAllowedByComponents("/data/a/sub", allowedRoots), true);
  assert.strictEqual(isPathAllowedByComponents("/data/a/sub/file.txt", allowedRoots), true);
  assert.strictEqual(isPathAllowedByComponents("/logs/robot.log", allowedRoots), true);

  // PREVENZIONE COLLISIONE PREFISSO PARZIALE: /data/a NON deve autorizzare /data/ab!
  assert.strictEqual(isPathAllowedByComponents("/data/ab", allowedRoots), false);
  assert.strictEqual(isPathAllowedByComponents("/data/abc/sub", allowedRoots), false);
  assert.strictEqual(isPathAllowedByComponents("/data/a_backup", allowedRoots), false);
  assert.strictEqual(isPathAllowedByComponents("/logs_archive/test", allowedRoots), false);

  // Directory genitrice superiore -> NEGATA
  assert.strictEqual(isPathAllowedByComponents("/data", allowedRoots), false);
  assert.strictEqual(isPathAllowedByComponents("/", allowedRoots), false);

  // Radice totale "/" autorizza tutto
  assert.strictEqual(isPathAllowedByComponents("/anywhere/file", ["/"]), true);

  console.log("  PASS: Test 2 - Confronto rigoroso per componenti (nessun falso positivo /data/a -> /data/ab).");
}

// =========================================================================
// TEST 3: Sanificazione, validazione e de-duplicazione radici (CLI / Config)
// =========================================================================
{
  const raw = [
    "/data/logs",
    "/data/logs", // duplicato
    "/data",      // radice genitrice che rende /data/logs ridondante
    "/configs/",  // trailing slash
  ];

  const sanitized = sanitizeAndValidateAllowedRoots(raw);
  assert.deepStrictEqual(sanitized, ["/data", "/configs"]);

  // Se è presente "/", elimina qualsiasi sottocartella ridondante
  assert.deepStrictEqual(sanitizeAndValidateAllowedRoots(["/data", "/", "/var/log"]), ["/"]);

  // Rifiuto percorsi non assoluti
  assert.throws(
    () => sanitizeAndValidateAllowedRoots(["relative/path"]),
    /percorso assoluto/
  );

  console.log("  PASS: Test 3 - Sanificazione e rimozione ridondanze radici autorizzate validata.");
}

// =========================================================================
// TEST 4: assertPathAuthorized con ruoli, fail-closed e audit logging
// =========================================================================
async function testAuthorization() {
  const auditRepo = new InMemoryAuditRepository();

  const operatorContext: AuthorizedContext = {
    sessionId: "sess_01",
    userId: "op_01",
    username: "operatore",
    roles: ["operatore"],
    permissions: new Set([AppPermission.FS_REMOTE_NAVIGATE]),
    allowedPaths: ["/upload", "/shared"],
  };

  const adminContext: AuthorizedContext = {
    sessionId: "sess_02",
    userId: "admin_01",
    username: "admin",
    roles: ["admin"],
    permissions: new Set([AppPermission.FS_REMOTE_NAVIGATE]),
  };

  // Amministratore può accedere a qualsiasi percorso
  await assertPathAuthorized(adminContext, "/etc/secrets", { robotId: "R1", auditRepo });
  await assertPathAuthorized(adminContext, "/var/log", { robotId: "R1", auditRepo });

  // Operatore su percorso consentito -> successo
  await assertPathAuthorized(operatorContext, "/upload/file.bin", { robotId: "R1", auditRepo });
  await assertPathAuthorized(operatorContext, "/shared/configs/app.json", { robotId: "R1", auditRepo });

  // Operatore su percorso NON consentito -> HTTP 403 e audit log SECURITY_AUTHORIZATION_ERROR
  let threw = false;
  try {
    await assertPathAuthorized(operatorContext, "/etc/passwd", {
      robotId: "R1",
      auditRepo,
      operation: "SFTP_DOWNLOAD",
    });
  } catch (err: any) {
    threw = true;
    assert.strictEqual(err.code, ErrorCode.INSUFFICIENT_PERMISSIONS);
  }
  assert.strictEqual(threw, true, "Operatore su percorso vietato deve sollevare INSUFFICIENT_PERMISSIONS");

  const auditLogs = await auditRepo.query();
  const violation = auditLogs.find((l) => l.operation === AuditOperation.SECURITY_AUTHORIZATION_ERROR);
  assert.ok(violation, "Deve essere stato registrato un log SECURITY_AUTHORIZATION_ERROR");
  assert.strictEqual(violation?.userId, "operatore");
  assert.strictEqual(violation?.robotId, "R1");
  assert.strictEqual(violation?.details?.requestedPath, "/etc/passwd");

  // Operatore senza allowedPaths definiti -> FAIL-CLOSED
  const unconfiguredOperator: AuthorizedContext = {
    sessionId: "sess_03",
    userId: "op_02",
    username: "operatore_nuovo",
    roles: ["operatore"],
    permissions: new Set(),
  };

  assert.rejects(
    () => assertPathAuthorized(unconfiguredOperator, "/upload"),
    /Accesso non consentito/
  );

  console.log("  PASS: Test 4 - assertPathAuthorized fail-closed, admin bypass e audit logging validati.");
}

// =========================================================================
// TEST 5: Migrazione idempotente percorsi operatore
// =========================================================================
async function testMigration() {
  const users = [
    { id: "1", username: "op1", roles: ["operatore"], allowedPaths: undefined },
    { id: "2", username: "op2", roles: ["operatore"], allowedPaths: ["/custom/root"] },
    { id: "3", username: "adm", roles: ["admin"], allowedPaths: undefined },
  ];

  const fakeDb = {
    collection: (_name: string) => ({
      find: (_filter: any) => ({
        toArray: async () => users.filter((u) => u.roles.includes("operatore")),
      }),
      updateOne: async (query: any, update: any) => {
        const u = users.find((user) => user.id === query.id);
        if (u) {
          u.allowedPaths = update.$set.allowedPaths;
        }
      },
    }),
  };

  // Prima esecuzione migrazione
  const res1 = await migrateOperatorPaths(fakeDb as any, ["/upload", "/shared"]);
  assert.strictEqual(res1.totalOperators, 2);
  assert.strictEqual(res1.migratedOperators, 1, "Solo op1 doveva essere migrato");
  assert.strictEqual(res1.skippedOperators, 1, "op2 era già configurato e doveva essere ignorato");

  // Verifica op1 aggiornato con i default, op2 invariato
  assert.deepStrictEqual(users[0].allowedPaths, ["/upload", "/shared"]);
  assert.deepStrictEqual(users[1].allowedPaths, ["/custom/root"]);

  // Seconda esecuzione (idempotenza)
  const res2 = await migrateOperatorPaths(fakeDb as any, ["/upload", "/shared"]);
  assert.strictEqual(res2.migratedOperators, 0, "Idempotenza: nessun utente deve essere rimigrato");
  assert.strictEqual(res2.skippedOperators, 2);

  console.log("  PASS: Test 5 - Migrazione idempotente percorsi operatore validata.");
}

async function runAll() {
  await testAuthorization();
  await testMigration();
  console.log("PASS: Tutti i test della suite percorsi autorizzati operatore sono stati SUPERATI!");
}

runAll().catch((err) => {
  console.error("FATAL in operator-path-authorization.test.ts:", err);
  process.exit(1);
});
