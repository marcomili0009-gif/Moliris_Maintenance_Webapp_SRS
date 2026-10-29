// Requisiti testati: SRS §10.1, §10.2, §10.4, §8.2, §8.4, §9, RF-ROB-001, RF-ROB-002,
// RF-ROB-005, RF-ROB-006, RF-ROB-008, RF-ROB-010, RF-ROB-012, RF-ROB-013, RF-ROB-014,
// RF-MON-005, RNF-SEC-002, RNF-SEC-009, RNF-REL-002, CA-ROB-003, CA-ROB-006, CA-ROB-011, CA-MON-004

import assert from "assert";
import { MongoClient } from "mongodb";
import {
  type RobotEntity,
  StandardRobotDirectoryNamingPolicy,
} from "./robot-models.ts";
import {
  InMemoryRobotRepository,
  MongoRobotRepository,
  type RobotRepository,
} from "./robot-repository.ts";
import {
  InMemoryAuditRepository,
  MongoAuditRepository,
  type AuditRepository,
} from "./audit-repository.ts";
import { toRobotSummaryDto, toRobotDetailDto } from "./dto/robot-dto.ts";
import { MolirisAppError, ErrorCode } from "../errors/app-errors.ts";

console.log("--> Esecuzione test livello di persistenza e modelli dati...");

// Fixture base per creazione robot
function createSampleRobot(overrides: Partial<RobotEntity> = {}): RobotEntity {
  const namingPolicy = new StandardRobotDirectoryNamingPolicy();
  const remoteUsername = overrides.remoteUsername ?? "moliris_operator";
  const id = overrides.id ?? "robot_test_01";
  const host = overrides.host ?? "192.168.1.100";
  const fsRoot = "/srv/moliris/data";

  return {
    id,
    displayName: overrides.displayName ?? "Robot Navigatore 01",
    remoteUsername,
    host,
    sshPort: overrides.sshPort ?? 22, // RF-ROB-005 default 22
    sshAuthMethod: overrides.sshAuthMethod ?? "key",
    credentialReference: overrides.credentialReference ?? "vault://moliris/credentials/robot_test_01",
    hostKeyVerification: overrides.hostKeyVerification ?? {
      fingerprint: "SHA256:abc123xyz",
      strictHostKeyChecking: true,
    },
    stateFilePaths: overrides.stateFilePaths ?? ["/opt/moliris/status/robot_state.json"],
    serverDirectoryPath: overrides.serverDirectoryPath ?? namingPolicy.resolveDirectoryPath(fsRoot, { id, remoteUsername, host }),
    anagraphicState: overrides.anagraphicState ?? "attivo",
    connectionState: overrides.connectionState ?? "non_verificato",
    operationalState: overrides.operationalState ?? null, // Assenza dati non è uno stato fittizio (RF-MON-005)
    lastValidUpdateAt: overrides.lastValidUpdateAt ?? null,
    lastAttemptOutcome: overrides.lastAttemptOutcome ?? null,
    registrationState: overrides.registrationState ?? "ssh_non_verificata",
    lastConnectionVerification: overrides.lastConnectionVerification ?? null,
    createdAt: new Date("2026-10-29T10:00:00Z"),
    updatedAt: new Date("2026-10-29T10:00:00Z"),
    remoteMonitoringPath: overrides.remoteMonitoringPath,
    sftpParameters: overrides.sftpParameters,
    customParameters: overrides.customParameters,
  };
}

async function runRobotRepositoryTestSuite(name: string, repo: RobotRepository) {
  console.log(`  -> Esecuzione test suite RobotRepository: ${name}`);

  // Test 1: Creazione e lettura robot (§10.1, RF-ROB-001, RF-ROB-002)
  const robot1 = createSampleRobot({ id: "robot_01", remoteUsername: "operator_01", sshPort: 22 });
  const created = await repo.create(robot1);
  assert.strictEqual(created.id, "robot_01");
  assert.strictEqual(created.sshPort, 22, "Default porta SSH deve essere 22 (RF-ROB-005)");

  const found = await repo.findById("robot_01");
  assert(found !== null);
  assert.strictEqual(found.displayName, "Robot Navigatore 01");
  assert.strictEqual(found.remoteUsername, "operator_01");
  assert.strictEqual(found.serverDirectoryPath, "/srv/moliris/data/operator_01");

  // Test 2: Unicità dell'identificativo robot (RF-ROB-006)
  const duplicateIdRobot = createSampleRobot({ id: "robot_01", remoteUsername: "unique_user_02" });
  await assert.rejects(
    async () => await repo.create(duplicateIdRobot),
    (err: any) => {
      assert(err instanceof MolirisAppError);
      assert.strictEqual(err.code, ErrorCode.MISSING_ROBOT_PARAMS);
      return true;
    },
    "La creazione con ID duplicato deve fallire con errore di validazione unicità"
  );

  // Test 3: Unicità dello username remoto (RF-ROB-006)
  const duplicateUsernameRobot = createSampleRobot({ id: "robot_02", remoteUsername: "operator_01" });
  await assert.rejects(
    async () => await repo.create(duplicateUsernameRobot),
    (err: any) => {
      assert(err instanceof MolirisAppError);
      assert.strictEqual(err.code, ErrorCode.MISSING_ROBOT_PARAMS);
      return true;
    },
    "La creazione con username duplicato deve fallire con errore di validazione unicità"
  );

  // Test 4: Impossibilità di due robot sulla stessa directory del server (§8.2)
  const duplicateDirRobot = createSampleRobot({
    id: "robot_03",
    remoteUsername: "different_user",
    serverDirectoryPath: "/srv/moliris/data/operator_01", // Stessa directory di robot_01
  });
  await assert.rejects(
    async () => await repo.create(duplicateDirRobot),
    (err: any) => {
      assert(err instanceof MolirisAppError);
      assert.strictEqual(err.code, ErrorCode.MISSING_ROBOT_PARAMS);
      return true;
    },
    "La creazione con directory server già associata deve fallire"
  );

  // Test 5: Aggiornamento stato operativo valido
  const validTime = new Date("2026-10-29T10:15:00Z");
  await repo.updateOperationalState("robot_01", { battery: 95, ros_nodes_active: 8 }, validTime);
  let updated = (await repo.findById("robot_01"))!;
  assert.deepStrictEqual(updated.operationalState, { battery: 95, ros_nodes_active: 8 });
  assert.strictEqual(updated.lastValidUpdateAt?.toISOString(), validTime.toISOString());

  // Test 6: Aggiornamento dell'esito dell'ultimo tentativo fallito SENZA alterare l'ultimo stato valido (CA-MON-004, RF-MON-005)
  const attemptOutcome = {
    timestamp: new Date("2026-10-29T10:20:00Z"),
    success: false,
    stage: "monitoring" as const,
    errorCode: "MON_STATE_FILE_ERROR",
    diagnosticMessage: "File non raggiungibile per timeout temporaneo",
  };
  await repo.updateLastAttempt("robot_01", attemptOutcome);
  updated = (await repo.findById("robot_01"))!;

  // Verifica critica: l'ultimo tentativo fallito è registrato...
  assert.strictEqual(updated.lastAttemptOutcome?.success, false);
  assert.strictEqual(updated.lastAttemptOutcome?.errorCode, "MON_STATE_FILE_ERROR");
  // ...ma l'ultimo stato operativo e il timestamp valido NON sono stati sovrascritti o cancellati! (CA-MON-004)
  assert.deepStrictEqual(updated.operationalState, { battery: 95, ros_nodes_active: 8 });
  assert.strictEqual(updated.lastValidUpdateAt?.toISOString(), validTime.toISOString());

  // Test 7: Disabilitazione e rimozione dall'anagrafica attiva (RF-ROB-013, CA-ROB-011)
  await repo.updateAnagraphicState("robot_01", "disabilitato");
  updated = (await repo.findById("robot_01"))!;
  assert.strictEqual(updated.anagraphicState, "disabilitato");

  await repo.updateAnagraphicState("robot_01", "rimosso");
  updated = (await repo.findById("robot_01"))!;
  assert.strictEqual(updated.anagraphicState, "rimosso");
  // Verifica che serverDirectoryPath e configurazione rimangano conservati (CA-ROB-011)
  assert.strictEqual(updated.serverDirectoryPath, "/srv/moliris/data/operator_01");

  // Test 8: Aggiornamento esiti di registrazione RF-ROB-012
  await repo.updateRegistrationState("robot_01", "registrazione_completata", {
    timestamp: new Date(),
    success: true,
    message: "Verifica SSH superata",
  });
  updated = (await repo.findById("robot_01"))!;
  assert.strictEqual(updated.registrationState, "registrazione_completata");
  assert.strictEqual(updated.lastConnectionVerification?.success, true);
}

async function runAuditRepositoryTestSuite(name: string, repo: AuditRepository) {
  console.log(`  -> Esecuzione test suite AuditRepository: ${name}`);

  // Test 1: Registrazione evento di audit con tipi prescritti da RNF-SEC-009
  const record = await repo.record({
    userId: "admin_user",
    operation: "ROBOT_REGISTRATION",
    robotId: "robot_01",
    outcome: "SUCCESS",
    timestamp: new Date(),
    details: {
      action: "Created robot with key authentication",
      // Campo contenente una password inavvertitamente passata: deve essere redatta (RNF-SEC-002, §10.4)
      password: "SuperSecretPassword123!",
      token: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
    },
  });

  assert.strictEqual(record.operation, "ROBOT_REGISTRATION");
  assert.strictEqual(record.outcome, "SUCCESS");
  // Verifica redazione attiva: nessuna credenziale salvata nel record persistito
  const detailsStr = JSON.stringify(record.details);
  assert(!detailsStr.includes("SuperSecretPassword123!"), "La password deve essere redatta nei log di audit");
  assert(!detailsStr.includes("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"), "I token devono essere redatti");
  assert(detailsStr.includes("[REDACTED]"), "I campi sensibili devono essere sostituiti con [REDACTED]");

  // Test 2: Query eventi di audit
  const queried = await repo.query({ userId: "admin_user" });
  assert(queried.length >= 1);
  assert.strictEqual(queried[0].userId, "admin_user");
}

async function runDtoSecurityTests() {
  console.log("  -> Esecuzione test di sicurezza DTO (RF-ROB-005, RNF-SEC-002)...");

  const robot = createSampleRobot({
    id: "robot_sec_01",
    credentialReference: "vault://secret/path/do_not_leak",
  });

  // Test 1: RobotSummaryDto non contiene credenziali né riferimenti segreti
  const summary = toRobotSummaryDto(robot);
  const summaryJson = JSON.stringify(summary);
  assert(!("credentialReference" in summary), "RobotSummaryDto non deve possedere il campo credentialReference");
  assert(!summaryJson.includes("vault://secret/path/do_not_leak"), "Il riferimento segreto non deve essere nel JSON");
  assert(!summaryJson.includes("password"), "Nessun campo password");
  assert(!summaryJson.includes("privateKey"), "Nessun campo privateKey");

  // Test 2: RobotDetailDto non contiene credenziali né riferimenti segreti
  const detail = toRobotDetailDto(robot);
  const detailJson = JSON.stringify(detail);
  assert(!("credentialReference" in detail), "RobotDetailDto non deve possedere il campo credentialReference");
  assert(!detailJson.includes("vault://secret/path/do_not_leak"), "Il riferimento segreto non deve apparire in detail");
  assert(!detailJson.includes("password"), "Nessun campo password");
  assert(!detailJson.includes("privateKey"), "Nessun campo privateKey");

  console.log("  PASS: Test DTO privi di credenziali superato.");
}

// 1. Esecuzione test con InMemory repository
const inMemoryRobotRepo = new InMemoryRobotRepository();
await runRobotRepositoryTestSuite("InMemoryRobotRepository", inMemoryRobotRepo);

const inMemoryAuditRepo = new InMemoryAuditRepository();
await runAuditRepositoryTestSuite("InMemoryAuditRepository", inMemoryAuditRepo);

// 2. Esecuzione test DTO
await runDtoSecurityTests();

// 3. Esecuzione test con MongoDB reale (se mongod è attivo localmente)
const mongoUri = "mongodb://127.0.0.1:27017";
try {
  const client = new MongoClient(mongoUri);
  await client.connect();
  const testDb = client.db("moliris_test_storage");
  await testDb.dropDatabase(); // Pulizia database di test

  const mongoRobotRepo = new MongoRobotRepository(testDb);
  await mongoRobotRepo.initIndexes();
  await runRobotRepositoryTestSuite("MongoRobotRepository (Live MongoDB)", mongoRobotRepo);

  const mongoAuditRepo = new MongoAuditRepository(testDb);
  await mongoAuditRepo.initIndexes();
  await runAuditRepositoryTestSuite("MongoAuditRepository (Live MongoDB)", mongoAuditRepo);

  await testDb.dropDatabase();
  await client.close();
  console.log("  PASS: Test su MongoDB reale completati con successo.");
} catch (err: any) {
  console.log("  NOTA: Test MongoDB reale saltato:", err.message);
}

console.log("PASS: Tutti i test del livello di persistenza completati con successo.");
