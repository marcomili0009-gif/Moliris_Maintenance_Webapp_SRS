// Test di collaudo per le 3 Migliorie del Database (Indici Composti, clientName e Separazione Telemetria)

import assert from "assert";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { MongoClient, type CommandStartedEvent, type Db } from "mongodb";
import { AppPermission } from "../../backend/auth/permissions.ts";
import { SessionManager } from "../../backend/auth/session-manager.ts";
import { MongoUserRepository } from "../../backend/auth/user-repository.ts";
import { type UserEntity } from "../../backend/auth/user-models.ts";
import { InMemoryCredentialProvider } from "../../backend/connection/credential-provider.ts";
import { DefaultHostKeyVerifier } from "../../backend/connection/host-key-verifier.ts";
import { MongoCredentialProvider } from "../../backend/connection/mongo-credential-provider.ts";
import { RobotConnectionManager } from "../../backend/connection/robot-connection-manager.ts";
import { FleetService } from "../../backend/fleet/fleet-service.ts";
import { createServer } from "../../backend/server.ts";
import { loadAndValidateConfig } from "../../config/configuration.ts";
import { MolirisLogger } from "../../logging/logger.ts";
import { AuditOperation } from "../../storage/audit-models.ts";
import { MongoRobotRepository } from "../../storage/robot-repository.ts";
import { MongoAuditRepository } from "../../storage/audit-repository.ts";
import { ServerFilesystemService } from "../../storage/server-fs.ts";
import { MongoTelemetryRepository } from "../../storage/telemetry-repository.ts";
import { type RobotEntity } from "../../storage/robot-models.ts";

console.log("--> Esecuzione test suite Migliorie Database (Indici, Naming, Telemetria)...");

const mongoUri = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/moliris_test_improvements";
let client: MongoClient | null = null;

function createTestConfig(root: string) {
  const cert = path.join(root, "fixture-cert.pem");
  const tlsKey = path.join(root, "fixture-tls.key");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-subj", "/CN=localhost", "-out", cert, "-keyout", tlsKey], { stdio: "ignore", timeout: 8_000 });
  return loadAndValidateConfig({
    MOLIRIS_FS_ROOT: root,
    MOLIRIS_POLLING_INTERVAL_SEC: "10",
    MOLIRIS_SSH_TIMEOUT_MS: "3000",
    MOLIRIS_MAX_TRF_PER_USER: "1",
    MOLIRIS_MAX_TRF_PER_ROBOT: "1",
    MOLIRIS_MAX_TRF_SERVER: "1",
    MOLIRIS_TEMP_RETENTION_MIN: "60",
    MOLIRIS_STATE_FILE_PATHS: "/tmp/status.txt",
    MOLIRIS_SESSION_TIMEOUT_MIN: "30",
    MOLIRIS_TLS_CERT_PATH: cert,
    MOLIRIS_TLS_KEY_PATH: tlsKey,
    MOLIRIS_AUDIT_RETENTION_DAYS: "30",
    MOLIRIS_REGISTRATION_MODE: "rigorosa",
    MOLIRIS_CREDENTIAL_PROVIDER: "in-memory",
  });
}

async function verifyRemovalRecovery(db: Db, fixture: RobotEntity): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "moliris-removal-recovery-"));
  const reconnect = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 2000 });
  try {
    const config = createTestConfig(root);
    const archive = path.join(root, "archivio.txt");
    await fs.writeFile(archive, "contenuto di prova");
    const key = randomBytes(32);
    const material = { method: "password" as const, password: "password-di-prova" };
    const actor: UserEntity = {
      id: "first-admin", username: "first_admin", enabled: true, roles: ["admin"],
      passwordHash: "fixture", createdAt: new Date(), updatedAt: new Date(),
    };
    const retryActor = { ...actor, id: "retry-admin", username: "retry_admin" };
    const instantiate = (database: Db) => {
      const robots = new MongoRobotRepository(database);
      const audit = new MongoAuditRepository(database);
      const vault = new MongoCredentialProvider(database, key);
      const logger = new MolirisLogger();
      const verifier = new DefaultHostKeyVerifier();
      const connections = new RobotConnectionManager(vault, verifier, {
        maxConcurrentPerUser: 1, maxConcurrentPerRobot: 1, maxConcurrentServer: 1, connectionTimeoutMs: 3000,
      }, logger);
      const fleet = new FleetService(
        config, robots, audit, new ServerFilesystemService(root, audit, logger), vault, verifier, connections, logger
      );
      return { robots, audit, vault, fleet };
    };
    const first = instantiate(db);
    const robotId = "restart-removal-test";
    const credentialReference = await first.vault.store(robotId, material);
    const robot = {
      ...fixture, id: robotId, remoteUsername: "restart_removal", credentialReference, serverDirectoryPath: root,
    };
    await first.robots.create(robot);
    first.vault.purgeMarked = async () => { throw new Error("vault interrotto"); };
    await assert.rejects(first.fleet.removeRobot(actor, robotId, true), /vault interrotto/);
    assert.equal(await first.robots.findById(robotId), null);
    assert.deepEqual(await first.vault.getCredentials(credentialReference, "password"), material);

    await reconnect.connect();
    const restarted = instantiate(reconnect.db(db.databaseName));
    const eventFilter = { robotId, operation: AuditOperation.ROBOT_REMOVAL, outcome: "SUCCESS" as const };
    const storedIntent = await restarted.audit.findRobotRemoval(robotId);
    assert.ok(storedIntent);
    assert.deepEqual(await restarted.audit.query(eventFilter), []);
    const clear = restarted.audit.clearRobotRemoval.bind(restarted.audit);
    restarted.audit.clearRobotRemoval = async () => { throw new Error("conferma journal interrotta"); };
    await restarted.fleet.recoverPendingRobotRemovals();
    const [recorded] = await restarted.audit.query(eventFilter);
    assert.equal(recorded?.id, `audit_${storedIntent.eventId}`);
    await assert.rejects(restarted.vault.getCredentials(credentialReference, "password"));
    assert.deepEqual(await restarted.audit.findRobotRemoval(robotId), storedIntent);

    restarted.audit.clearRobotRemoval = clear;
    const app = createServer(config, new MolirisLogger(), {
      fleetService: restarted.fleet,
      robotRepository: restarted.robots,
      auditRepository: restarted.audit,
      credentialProvider: restarted.vault,
    });
    try {
      await app.ready();
      assert.equal((await app.inject({ method: "GET", url: "/healthz" })).statusCode, 200);
      const deadline = Date.now() + 4_000;
      while (Date.now() < deadline && await restarted.audit.findRobotRemoval(robotId)) {
        await delay(25);
      }
    } finally {
      await app.close();
    }
    assert.equal(await restarted.audit.findRobotRemoval(robotId), null);
    await restarted.fleet.removeRobot(retryActor, robotId, true);
    const events = await restarted.audit.query(eventFilter);
    assert.deepEqual(events, [recorded]);
    assert.equal(events[0].userId, actor.username);
    assert.equal(events[0].details?.serverDirectoryPreserved, root);
    assert.equal(await fs.readFile(archive, "utf8"), "contenuto di prova");

    await restarted.vault.store(robotId, material);
    await restarted.robots.create({ ...robot, createdAt: new Date() });
    await restarted.fleet.removeRobot(retryActor, robotId, true);
    const later = await restarted.audit.query(eventFilter);
    assert.equal(later.length, 2);
    assert.equal(new Set(later.map(event => event.id)).size, 2);
    assert.deepEqual(new Set(later.map(event => event.userId)), new Set([actor.username, retryActor.username]));
    console.log("  ✓ Rimozione MongoDB recuperata con una nuova connessione e all'avvio Fastify, audit univoco e riuso ID verificati");
  } finally {
    await reconnect.close();
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function verifyReadinessAndFleetPage(fixture: RobotEntity): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "moliris-post-audit-"));
  const mongo = new MongoClient(mongoUri, { monitorCommands: true, serverSelectionTimeoutMS: 2_000 });
  const cleanup = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 2_000 });
  const db = mongo.db(`moliris_post_audit_${randomBytes(6).toString("hex")}`);
  const commands: CommandStartedEvent[] = [];
  mongo.on("commandStarted", event => {
    if (event.commandName === "find" && event.command.find === "robots") commands.push(event);
  });
  const config = createTestConfig(root);
  const logger = new MolirisLogger();
  const robots = new MongoRobotRepository(db);
  const users = new MongoUserRepository(db);
  const audit = new MongoAuditRepository(db);
  const credentials = new InMemoryCredentialProvider();
  const verifier = new DefaultHostKeyVerifier();
  const connections = new RobotConnectionManager(credentials, verifier, {
    maxConcurrentPerUser: 1, maxConcurrentPerRobot: 1, maxConcurrentServer: 1, connectionTimeoutMs: 3_000,
  }, logger);
  const fleet = new FleetService(
    config, robots, audit, new ServerFilesystemService(root, audit, logger), credentials, verifier, connections, logger
  );
  const sessions = new SessionManager(30);
  const app = createServer(config, logger, {
    db, robotRepository: robots, auditRepository: audit, userRepository: users, fleetService: fleet,
    sessionManager: sessions, credentialProvider: credentials, connectionManager: connections,
  });
  try {
    await robots.initIndexes();
    await users.initIndexes();
    const admin: UserEntity = {
      id: "page-admin", username: "page-admin", roles: ["admin"], enabled: true,
      passwordHash: "fixture", createdAt: new Date(), updatedAt: new Date(),
    };
    const restricted: UserEntity = {
      ...admin, id: "page-scoped", username: "page-scoped", roles: [],
      robotPermissions: {
        "first-visible": [AppPermission.FLEET_VIEW],
        "earlier-removed": [AppPermission.FLEET_VIEW],
        "disabled-visible": [AppPermission.FLEET_VIEW],
        "denied-by-permission": [AppPermission.STATUS_VIEW],
        "legacy-visible": [AppPermission.FLEET_VIEW],
      },
    };
    const cookie = (user: UserEntity) => ({
      cookie: `__Host-moliris_session=${sessions.createSession(user).sessionId}`,
    });
    await users.create(admin);
    await users.create(restricted);
    const adminHeaders = cookie(admin);
    const restrictedHeaders = cookie(restricted);
    const makeRobot = (id: string, anagraphicState: RobotEntity["anagraphicState"] = "attivo") => ({
      ...fixture, id, anagraphicState, remoteUsername: id, serverDirectoryPath: path.join(root, id),
    });
    const collection = db.collection<RobotEntity>("robots");
    await collection.insertMany([
      makeRobot("earlier-removed", "rimosso"),
      makeRobot("first-visible"),
      makeRobot("denied-by-permission"),
      makeRobot("disabled-visible", "disabilitato"),
      makeRobot("legacy-visible"),
      ...Array.from({ length: 995 }, (_, i) => makeRobot(`extra-${i}`)),
    ]);
    await collection.updateOne({ id: "legacy-visible" }, { $unset: { anagraphicState: "" } });

    const healthy = await app.inject("/healthz");
    assert.equal(healthy.statusCode, 200);
    assert.equal(healthy.headers["cache-control"], "no-store");
    assert.equal(healthy.json().status, "OK");
    const page = await app.inject({ url: "/api/robots?offset=1&limit=1", headers: adminHeaders });
    assert.equal(page.statusCode, 200);
    assert.deepEqual(page.json().robots.map((robot: RobotEntity) => robot.id), ["denied-by-permission"]);
    const pageCommand = commands.at(-1)?.command;
    assert.ok(pageCommand, "L'endpoint deve eseguire una query Mongo della flotta");
    assert.deepEqual(pageCommand.filter, { anagraphicState: { $ne: "rimosso" } });
    assert.equal(pageCommand.skip, 1);
    assert.equal(pageCommand.limit, 1);
    const commandSort = pageCommand.sort instanceof Map ? Object.fromEntries(pageCommand.sort) : pageCommand.sort;
    assert.deepEqual(commandSort, { _id: 1 });
    const explain = await db.command({
      explain: { find: "robots", filter: pageCommand.filter, sort: commandSort, skip: 1, limit: 1 },
      verbosity: "executionStats",
    });
    assert.ok(explain.executionStats.totalDocsExamined <= 5, "La pagina non deve leggere la collezione intera");
    console.log(`  ✓ Pagina MongoDB: ${explain.executionStats.totalDocsExamined}/1000 documenti esaminati per limit=1, offset=1`);

    const scopedPage = await fleet.listFleet(restricted, { offset: 1, limit: 1 });
    assert.deepEqual(scopedPage.map(robot => robot.id), ["disabled-visible"]);
    assert.equal(scopedPage[0].anagraphicState, "disabilitato");
    const scopedFilter = commands.at(-1)?.command.filter;
    assert.deepEqual(scopedFilter.id.$in, ["first-visible", "earlier-removed", "disabled-visible", "legacy-visible"]);
    assert.deepEqual((await fleet.listFleet(restricted, { offset: 2 })).map(robot => robot.id), ["legacy-visible"]);
    assert.deepEqual((await fleet.listFleet(restricted)).map(robot => robot.id), ["first-visible", "disabled-visible", "legacy-visible"]);
    const commandCount = commands.length;
    assert.deepEqual(await fleet.listFleet({ ...restricted, enabled: false }), []);
    assert.deepEqual(await fleet.listFleet({ ...restricted, robotPermissions: {} }), []);
    const denied = await app.inject({ url: "/api/robots?limit=1", headers: restrictedHeaders });
    assert.equal(denied.statusCode, 403, "La guardia HTTP continua a richiedere il permesso globale preesistente");
    assert.equal(commands.length, commandCount);
    console.log("  ✓ Filtri, ordine, pagine scoped, retrocompatibilità record e guardia RBAC verificati");

    await mongo.close();
    const degraded = await app.inject("/healthz");
    assert.equal(degraded.statusCode, 503);
    assert.equal(degraded.headers["cache-control"], "no-store");
    assert.deepEqual(Object.keys(degraded.json()).sort(), ["status", "timestamp"]);
    assert.equal(degraded.json().status, "UNAVAILABLE");
    assert.equal((await app.inject("/livez")).statusCode, 200);
    const apiError = await app.inject({ url: "/api/robots", headers: adminHeaders });
    assert.equal(apiError.statusCode, 500);
    assert.equal(apiError.json().code, "DB_PERSISTENCE_ERROR");
    console.log("  ✓ Mongo indisponibile: readiness 503, liveness 200 e API protetta 500");

    // Un socket che accetta connessioni senza completare l'handshake Mongo.
    const sockets = new Set<net.Socket>();
    const stalled = net.createServer(socket => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve, reject) => {
      stalled.once("error", reject);
      stalled.listen(0, "127.0.0.1", resolve);
    });
    const address = stalled.address() as net.AddressInfo;
    const unavailable = new MongoClient(`mongodb://127.0.0.1:${address.port}`);
    const stalledApp = createServer(config, logger, { db: unavailable.db() });
    try {
      const started = Date.now();
      assert.equal((await stalledApp.inject("/healthz")).statusCode, 503);
      const elapsed = Date.now() - started;
      assert.ok(elapsed < 3_000, `Readiness deve avere un timeout breve: ${elapsed} ms`);
      assert.equal((await stalledApp.inject("/livez")).statusCode, 200);
      console.log(`  ✓ Timeout readiness con handshake Mongo bloccato: ${elapsed} ms`);
    } finally {
      await stalledApp.close();
      for (const socket of sockets) socket.destroy();
      await unavailable.close();
      await new Promise<void>((resolve, reject) => stalled.close(error => error ? reject(error) : resolve()));
    }
  } finally {
    await app.close();
    await mongo.close();
    try {
      await cleanup.db(db.databaseName).dropDatabase();
    } finally {
      await cleanup.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  }
}

try {
  client = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 2000 });
  await client.connect();
  const db = client.db();
  await db.dropDatabase();

  // 1. Verifica Indici Composti Audit Repository
  const auditRepo = new MongoAuditRepository(db);
  await auditRepo.initIndexes(30);
  const auditIndexes = await db.collection("audit_events").indexes();
  const hasUserTimeIdx = auditIndexes.some((idx) => idx.key?.userId === 1 && idx.key?.timestamp === -1);
  const hasRobotTimeIdx = auditIndexes.some((idx) => idx.key?.robotId === 1 && idx.key?.timestamp === -1);
  assert.strictEqual(hasUserTimeIdx, true, "Indice composto { userId: 1, timestamp: -1 } deve esistere");
  assert.strictEqual(hasRobotTimeIdx, true, "Indice composto { robotId: 1, timestamp: -1 } deve esistere");
  console.log("  ✓ Indici composti audit_events verificati con successo");

  // 2. Verifica Indici Composti e Naming clientName/customerName su Robot Repository
  const robotRepo = new MongoRobotRepository(db, "per_host");
  await robotRepo.initIndexes();
  const robotIndexes = await db.collection("robots").indexes();
  const hasClientPlantIdx = robotIndexes.some((idx) => idx.key?.clientId === 1 && idx.key?.plantId === 1);
  assert.strictEqual(hasClientPlantIdx, true, "Indice composto { clientId: 1, plantId: 1 } deve esistere");
  console.log("  ✓ Indice composto robots ({ clientId: 1, plantId: 1 }) verificato con successo");

  // Inserimento robot con solo clientName -> verifica che customerName venga valorizzato
  const r1: RobotEntity = {
    id: "r-test-client-1",
    displayName: "Robot Test Client",
    remoteUsername: "bot1",
    host: "192.168.1.50",
    sshPort: 22,
    sshAuthMethod: "password",
    credentialReference: "vault://r-test-client-1",
    serverDirectoryPath: "/tmp/server-fs/bot1_r-test-client-1",
    anagraphicState: "attivo",
    connectionState: "raggiungibile",
    operationalState: { battery: 95 },
    lastValidUpdateAt: new Date(),
    registrationState: "registrazione_completata",
    clientId: "cli_100",
    clientName: "Cliente Alfa SpA",
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const createdR1 = await robotRepo.create(r1);
  assert.strictEqual(createdR1.clientName, "Cliente Alfa SpA");
  assert.strictEqual(createdR1.customerName, "Cliente Alfa SpA", "customerName deve essere popolato per retrocompatibilità");

  // Inserimento robot con legacy customerName -> verifica che clientName venga valorizzato
  const r2: RobotEntity = {
    id: "r-test-client-2",
    displayName: "Robot Test Legacy",
    remoteUsername: "bot2",
    host: "192.168.1.51",
    sshPort: 22,
    sshAuthMethod: "password",
    credentialReference: "vault://r-test-client-2",
    serverDirectoryPath: "/tmp/server-fs/bot2_r-test-client-2",
    anagraphicState: "attivo",
    connectionState: "raggiungibile",
    operationalState: null,
    lastValidUpdateAt: null,
    registrationState: "registrazione_completata",
    clientId: "cli_200",
    customerName: "Cliente Beta Srl",
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const createdR2 = await robotRepo.create(r2);
  assert.strictEqual(createdR2.clientName, "Cliente Beta Srl", "clientName deve essere popolato a partire da customerName");
  console.log("  ✓ Sincronizzazione bidirezionale clientName <-> customerName verificata");

  // 3. Verifica Repository e Collection Separata di Telemetria
  const telemetryRepo = new MongoTelemetryRepository(db, "robot_telemetry_history");
  await telemetryRepo.initIndexes(90);
  const telIndexes = await db.collection("robot_telemetry_history").indexes();
  const hasTelRobotTimeIdx = telIndexes.some((idx) => idx.key?.robotId === 1 && idx.key?.timestamp === -1);
  const hasTelTtlIdx = telIndexes.some((idx) => idx.key?.timestamp === 1 && idx.expireAfterSeconds === 90 * 86400);
  assert.strictEqual(hasTelRobotTimeIdx, true, "Indice { robotId: 1, timestamp: -1 } su telemetria deve esistere");
  assert.strictEqual(hasTelTtlIdx, true, "Indice TTL su telemetria deve esistere");

  // Salvataggio campioni di telemetria
  await telemetryRepo.record({
    robotId: "r-test-client-1",
    timestamp: new Date(Date.now() - 60000),
    connectionState: "raggiungibile",
    operationalState: { battery: 94 },
    lastAttemptOutcome: { timestamp: new Date(), success: true, stage: "monitoring" },
  });
  await telemetryRepo.record({
    robotId: "r-test-client-1",
    timestamp: new Date(),
    connectionState: "raggiungibile",
    operationalState: { battery: 95 },
    lastAttemptOutcome: { timestamp: new Date(), success: true, stage: "monitoring" },
  });

  const latest = await telemetryRepo.getLatestByRobot("r-test-client-1");
  assert.ok(latest);
  assert.strictEqual((latest.operationalState as any)?.battery, 95, "Deve recuperare l'ultimo record più recente");

  const history = await telemetryRepo.queryHistory("r-test-client-1", 10);
  assert.strictEqual(history.length, 2, "Lo storico deve restituire esattamente 2 record");
  console.log("  ✓ Collection robot_telemetry_history e query storico verificate con successo");

  await verifyRemovalRecovery(db, r1);
  await verifyReadinessAndFleetPage(r1);

  console.log("--> TUTTI I TEST DELLE MIGLIORIE DEL DATABASE SONO STATI SUPERATI CON SUCCESSO! ✓");
} catch (err: any) {
  console.error("Test fallito:", err);
  process.exit(1);
} finally {
  if (client) {
    await client.close();
  }
}
