// Requisiti verificati su fixture: RNF-PERF-001, RNF-PERF-003, RNF-REL-005, SRS §10.3, §11.2, §11.5.
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import ssh2, { type Connection } from "ssh2";
import { DEFAULT_ROLE_PERMISSIONS } from "../backend/auth/permissions.ts";
import { SessionManager, type AuthorizedContext } from "../backend/auth/session-manager.ts";
import type { UserEntity } from "../backend/auth/user-models.ts";
import { InMemoryCredentialProvider } from "../backend/connection/credential-provider.ts";
import { computeHostKeyFingerprint, DefaultHostKeyVerifier } from "../backend/connection/host-key-verifier.ts";
import { RobotConnectionManager } from "../backend/connection/robot-connection-manager.ts";
import { RemoteFilesystemService } from "../backend/remote-fs/remote-fs-service.ts";
import { TerminalService } from "../backend/terminal/terminal-service.ts";
import { TransferStatus } from "../backend/transfer/transfer-models.ts";
import { TransferService } from "../backend/transfer/transfer-service.ts";
import type { SystemConfiguration } from "../config/configuration.ts";
import { ErrorCode, MolirisAppError } from "../errors/app-errors.ts";
import { MolirisLogger } from "../logging/logger.ts";
import { AuditOperation } from "../storage/audit-models.ts";
import { InMemoryAuditRepository } from "../storage/audit-repository.ts";
import type { RobotEntity } from "../storage/robot-models.ts";
import { InMemoryRobotRepository } from "../storage/robot-repository.ts";
import { ServerFilesystemService } from "../storage/server-fs.ts";

// Avvio: node --import tsx scripts/load-test.ts [--users=25] [--robots=10] [--terminals=20] [--transfers=10]
const STEP_TIMEOUT_MS = 5_000;
const FILE_BYTES = 256 * 1024;
const FIRST_CHUNK_BYTES = 4 * 1024;
const FIXTURE_HOST = "127.0.0.1";

type Terminal = Awaited<ReturnType<TerminalService["openTerminalSession"]>>;
type Transfer = Awaited<ReturnType<TransferService["uploadClientToServer"]>>;
type LoadUser = { user: UserEntity; context: AuthorizedContext; robot: RobotEntity };
type Upload = {
  user: LoadUser;
  filename: string;
  data: Buffer;
  checksum: string;
  stream: PassThrough;
  task: Promise<void>;
  outcome?: PromiseSettledResult<Transfer>;
  completedElapsedMs?: number;
};

function parseArgs() {
  const params = { users: 25, robots: 10, terminals: 20, transfers: 10 };
  for (const arg of process.argv.slice(2)) {
    const match = /^--(users|robots|terminals|transfers)=(\d+)$/.exec(arg);
    if (!match) throw new Error(`Argomento non valido: ${arg}`);
    const value = Number(match[2]);
    if (!Number.isInteger(value) || value < 1 || value > 100) {
      throw new Error(`--${match[1]} deve essere compreso tra 1 e 100`);
    }
    params[match[1] as keyof typeof params] = value;
  }
  return params;
}

function stages(users: number, cap: number): number[] {
  const saturation = Math.min(users, cap);
  return [...new Set([1, Math.ceil(saturation / 3), Math.ceil(2 * saturation / 3), saturation, users])];
}

async function waitUntil(condition: () => boolean, description: string): Promise<void> {
  const deadline = performance.now() + STEP_TIMEOUT_MS;
  while (!condition()) {
    if (performance.now() >= deadline) throw new Error(`Timeout: ${description}`);
    await delay(20);
  }
}

function latencyMs(values: number[]) {
  const ordered = [...values].sort((a, b) => a - b);
  const percentile = (fraction: number) => Number(ordered[Math.ceil(ordered.length * fraction) - 1].toFixed(1));
  return { samples: ordered.length, p50: percentile(0.5), p95: percentile(0.95), max: percentile(1) };
}

async function checkEcho(terminal: Terminal, marker: string): Promise<number> {
  const started = performance.now();
  const returned = once(terminal.ptyChannel, "data", { signal: AbortSignal.timeout(STEP_TIMEOUT_MS) });
  terminal.ptyChannel.write(marker);
  const [echo] = await returned;
  assert.equal(String(echo), marker, "Il round trip PTY deve restituire i byte inviati");
  return performance.now() - started;
}

function fixtureUser(index: number, role: "amministratore" | "operatore"): UserEntity {
  return {
    id: `load-user-${index}`, username: `load-user-${index}`, roles: [role], enabled: true,
    passwordHash: "fixture-no-login", createdAt: new Date(), updatedAt: new Date(),
  };
}

async function runLoadTest(): Promise<void> {
  const params = parseArgs();
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "moliris-load-"));
  const fsRoot = path.join(tmpDir, "server-fs");
  const password = randomBytes(24).toString("hex");
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "pkcs1", format: "pem" },
  });
  const parsedKey = ssh2.utils.parseKey(privateKey);
  assert.ok(!Array.isArray(parsedKey) && !(parsedKey instanceof Error));
  const fingerprint = computeHostKeyFingerprint(parsedKey.getPublicSSH()).sha256Hex;
  const sshClients = new Set<Connection>();
  const sshErrors: string[] = [];
  const sshServer = new ssh2.Server({ hostKeys: [privateKey] }, (client) => {
    sshClients.add(client);
    client.once("close", () => sshClients.delete(client));
    client.on("error", (error) => sshErrors.push(error.message));
    client.on("authentication", (ctx) => {
      if (ctx.method === "password" && /^loadrobot\d+$/.test(ctx.username) && ctx.password === password) ctx.accept();
      else ctx.reject();
    });
    client.on("ready", () => client.on("session", (accept) => {
      const session = accept();
      session.on("pty", (acceptPty) => acceptPty());
      session.on("shell", (acceptShell) => {
        const shell = acceptShell();
        shell.on("data", (data: Buffer) => shell.write(data));
        shell.on("error", (error: Error) => sshErrors.push(error.message));
      });
    }));
  });
  // Il limite per robot lascia misurare quello globale, anche con una sola fixture.
  const perRobot = Math.ceil(params.users / params.robots);
  const config: SystemConfiguration = {
    serverFilesystemRoot: fsRoot, pollingIntervalSeconds: 1, sshConnectionTimeoutMs: 3_000,
    maxConcurrentTransfersPerUser: 1, maxConcurrentTransfersPerRobot: perRobot,
    maxConcurrentTransfersServer: params.transfers, maxConcurrentTerminalSessionsPerUser: 1,
    maxConcurrentTerminalSessionsPerRobot: perRobot, maxConcurrentTerminalSessionsServer: params.terminals,
    transferConcurrencyQueuePolicy: "rifiuta", transferVerifyMode: "readback",
    transferIdleTimeoutMs: 10_000, tempFileRetentionMinutes: 60,
    stateFilePaths: ["/fixture/status"], inactiveSessionTimeoutMinutes: 30, sessionAbsoluteMaxMinutes: 480,
    tlsCertPath: path.join(tmpDir, "unused.pem"), tlsKeyPath: path.join(tmpDir, "unused.key"),
    registrationMode: "rigorosa", credentialProviderType: "in-memory", auditLogRetentionDays: 1, defaultSshPort: 22,
  };
  const logger = new MolirisLogger();
  const audit = new InMemoryAuditRepository();
  const robotRepo = new InMemoryRobotRepository();
  const credentials = new InMemoryCredentialProvider(["password"]);
  const connections = new RobotConnectionManager(credentials, new DefaultHostKeyVerifier(), {
    maxConcurrentPerUser: 1, maxConcurrentPerRobot: perRobot, maxConcurrentServer: params.users,
    connectionTimeoutMs: config.sshConnectionTimeoutMs,
  }, logger);
  const sessions = new SessionManager(config.inactiveSessionTimeoutMinutes, config.sessionAbsoluteMaxMinutes);
  const serverFs = new ServerFilesystemService(fsRoot, audit, logger);
  const remoteFs = new RemoteFilesystemService(config, connections, audit, logger);
  const terminals = new TerminalService(config, robotRepo, audit, connections, sessions, DEFAULT_ROLE_PERMISSIONS, logger);
  const transfers = new TransferService(config, robotRepo, serverFs, remoteFs, sessions, audit, logger);
  const opened: Terminal[] = [];
  const uploads: Upload[] = [];
  let overflowTerminals = 0;
  let overflowTransfers = 0;
  const openLatency: number[] = [];
  const echoLatency: number[] = [];
  const transferLatency: number[] = [];
  let peakConnections = 0;
  let peakRss = process.memoryUsage().rss;
  const startingRss = peakRss;
  const sampleResources = () => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
    peakConnections = Math.max(peakConnections, sshClients.size);
  };
  const sampler = setInterval(sampleResources, 20);
  const cpuStart = process.cpuUsage();
  const runStarted = performance.now();

  try {
    const listening = once(sshServer, "listening", { signal: AbortSignal.timeout(STEP_TIMEOUT_MS) });
    sshServer.listen(0, FIXTURE_HOST);
    await listening;
    const sshPort = (sshServer.address() as AddressInfo).port;
    const robots: RobotEntity[] = [];
    for (let i = 0; i < params.robots; i++) {
      const id = `load-robot-${i}`;
      const remoteUsername = `loadrobot${i}`;
      const robot: RobotEntity = {
        id, remoteUsername, host: FIXTURE_HOST, sshPort, displayName: `Robot fixture ${i}`,
        sshAuthMethod: "password", credentialReference: await credentials.store(id, { method: "password", password }),
        hostKeyVerification: { fingerprint, strictHostKeyChecking: true },
        serverDirectoryPath: path.join(fsRoot, `${remoteUsername}_${id}`), anagraphicState: "attivo",
        registrationState: "registrazione_completata", connectionState: "raggiungibile",
        operationalState: null, lastValidUpdateAt: null, stateFilePaths: config.stateFilePaths,
        lastAttemptOutcome: { timestamp: new Date(), success: true, stage: "connection" },
        lastConnectionVerification: { timestamp: new Date(), success: true },
        createdAt: new Date(), updatedAt: new Date(),
      };
      await mkdir(robot.serverDirectoryPath);
      await robotRepo.create(robot);
      robots.push(robot);
    }
    const users: LoadUser[] = Array.from({ length: params.users }, (_, i) => {
      const user = fixtureUser(i, "amministratore");
      const robot = robots[i % robots.length];
      return {
        user, robot,
        context: sessions.createAuthorizedContext(sessions.createSession(user), user, robot.id, DEFAULT_ROLE_PERMISSIONS),
      };
    });
    console.log(JSON.stringify({ event: "LOAD_PROFILE", ...params, uploadBytesPerUser: FILE_BYTES, ssh: "strict-loopback" }));

    const deniedUser = fixtureUser(params.users, "operatore");
    const deniedSession = sessions.createSession(deniedUser);
    await assert.rejects(
      terminals.openTerminalSession(deniedUser, robots[0].id, {}, deniedSession.sessionId),
      (error) => error instanceof MolirisAppError && error.code === ErrorCode.INSUFFICIENT_PERMISSIONS,
      "Il controllo RBAC deve continuare a negare il terminale all'operatore",
    );
    assert.equal(connections.getActiveConnectionCount(), 0);

    let attempted = 0;
    for (const target of stages(users.length, params.terminals)) {
      const results = await Promise.allSettled(users.slice(attempted, target).map(async ({ user, robot, context }) => {
        const started = performance.now();
        const terminal = await terminals.openTerminalSession(user, robot.id, { cols: 80, rows: 24 }, context.sessionId);
        openLatency.push(performance.now() - started);
        return terminal;
      }));
      for (const result of results) {
        if (result.status === "fulfilled") opened.push(result.value);
        else {
          const error: unknown = result.reason;
          const expected = error instanceof MolirisAppError && error.code === ErrorCode.INSUFFICIENT_STORAGE &&
            error.diagnosticDetail.startsWith("Numero massimo di sessioni terminale contemporanee sul server raggiunto");
          if (!expected) throw error;
          overflowTerminals++;
        }
      }
      assert.equal(opened.length, Math.min(target, params.terminals), "Aperture PTY confermate");
      assert.equal(overflowTerminals, Math.max(0, target - params.terminals), "Rifiuti PTY dovuti al solo limite globale");
      assert.equal(terminals.getActiveSessionCount(), opened.length);
      assert.equal(connections.getActiveConnectionCount(), opened.length);
      assert.equal(sshClients.size, opened.length);
      echoLatency.push(...await Promise.all(opened.map((terminal, i) => checkEcho(terminal, `stage-${target}-${i}`))));
      sampleResources();
      console.log(JSON.stringify({ event: "TERMINAL_STAGE", attempted: target, active: opened.length, overflow: overflowTerminals }));
      attempted = target;
    }
    await delay(500);
    echoLatency.push(...await Promise.all(opened.map((terminal, i) => checkEcho(terminal, `still-open-${i}`))));
    assert.deepEqual(sshErrors, [], "Nessun errore dal server SSH durante i round trip");
    await terminals.closeAll();
    await waitUntil(() => sshClients.size === 0, "chiusura socket SSH lato fixture");
    assert.equal(terminals.getActiveSessionCount(), 0);
    assert.equal(connections.getActiveConnectionCount(), 0);

    attempted = 0;
    for (const target of stages(users.length, params.transfers)) {
      for (let i = attempted; i < target; i++) {
        const user = users[i];
        const filename = `load-${i}.bin`;
        const data = Buffer.alloc(FILE_BYTES, i);
        const checksum = createHash("sha256").update(data).digest("hex");
        const stream = new PassThrough();
        stream.write(data.subarray(0, FIRST_CHUNK_BYTES));
        const started = performance.now();
        const operation = transfers.uploadClientToServer(
          user.context, user.robot, "", filename, stream, { expectedChecksum: checksum }, data.length,
        );
        const upload: Upload = { user, filename, data, checksum, stream, task: Promise.resolve() };
        upload.task = operation.then(
          (value) => {
            upload.completedElapsedMs = performance.now() - started;
            upload.outcome = { status: "fulfilled", value };
          },
          (reason: unknown) => { upload.outcome = { status: "rejected", reason }; },
        );
        uploads.push(upload);
      }
      const activeUploads = () => transfers.listTransfers(users[0].context)
        .filter((record) => record.status === TransferStatus.IN_PROGRESS);
      await waitUntil(
        () => activeUploads().length + uploads.filter((item) => item.outcome).length >= target &&
          uploads.every((item) => item.outcome || item.stream.readableLength === 0),
        `avvio o rifiuto verificabile di ${target} upload`,
      );
      const active = activeUploads();
      overflowTransfers = 0;
      for (const upload of uploads) {
        if (!upload.outcome) continue;
        assert.equal(upload.outcome.status, "rejected", "Un upload con stream aperto non può essere già completato");
        const error: unknown = upload.outcome.reason;
        const expected = error instanceof MolirisAppError && error.code === ErrorCode.TRANSFER_INTERRUPTED &&
          error.diagnosticDetail.startsWith(`Limite trasferimenti simultanei raggiunto (server: ${params.transfers}/${params.transfers},`);
        if (!expected) throw error;
        overflowTransfers++;
      }
      assert.equal(active.length, Math.min(target, params.transfers), "Upload realmente attivi");
      assert.equal(overflowTransfers, Math.max(0, target - params.transfers), "Rifiuti upload dovuti al solo limite globale");
      sampleResources();
      console.log(JSON.stringify({ event: "UPLOAD_STAGE", attempted: target, active: active.length, overflow: overflowTransfers }));
      attempted = target;
    }

    const admitted = uploads.filter((item) => !item.outcome);
    for (const upload of admitted) upload.stream.end(upload.data.subarray(FIRST_CHUNK_BYTES));
    await waitUntil(() => admitted.every((upload) => upload.outcome !== undefined), "completamento upload");
    for (const upload of admitted) {
      assert.equal(upload.outcome?.status, "fulfilled", `Upload fallito: ${upload.filename}`);
      const completed = upload.outcome.value;
      assert.equal(completed.status, TransferStatus.COMPLETED);
      assert.equal(completed.transferredBytes, upload.data.length);
      assert.equal(completed.checksum, upload.checksum);
      assert.equal(completed.integrityVerification?.verified, true);
      assert.deepEqual(await readFile(path.join(upload.user.robot.serverDirectoryPath, upload.filename)), upload.data);
      assert.ok(upload.completedElapsedMs !== undefined);
      transferLatency.push(upload.completedElapsedMs);
    }
    for (const user of users) assert.equal(transfers.getActiveTransfersCountForSession(user.context.sessionId), 0);
    const entries = await audit.query();
    assert.equal(entries.filter((e) => e.operation === AuditOperation.TERMINAL_OPEN && e.outcome === "SUCCESS").length, opened.length);
    assert.equal(entries.filter((e) => e.operation === AuditOperation.TRANSFER_COMPLETE && e.outcome === "SUCCESS").length, admitted.length);
    const tempEntries = await Promise.all(robots.map((robot) => readdir(path.join(robot.serverDirectoryPath, ".tmp")).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    })));
    assert.ok(tempEntries.every((names) => names.length === 0), "Nessun file temporaneo residuo");
    assert.deepEqual(sshErrors, [], "Nessun errore durante la chiusura SSH");
  } finally {
    clearInterval(sampler);
    for (const upload of uploads) upload.stream.destroy();
    for (const user of uploads.map((upload) => upload.user)) {
      transfers.cancelTransfersForSession(user.context.sessionId, user.context.userId, "LOAD_TEST_CLEANUP");
    }
    await Promise.all(uploads.map((upload) => upload.task));
    await terminals.closeAll();
    await connections.closeAll();
    for (const client of sshClients) client.end();
    sshServer.close();
    transfers.stopCleanupTask();
    sessions.dispose();
    await rm(tmpDir, { recursive: true, force: true });
  }

  const durationMs = performance.now() - runStarted;
  const cpu = process.cpuUsage(cpuStart);
  const endRss = process.memoryUsage().rss;
  const toMiB = (bytes: number) => Number((bytes / 1024 ** 2).toFixed(1));
  console.log(JSON.stringify({
    event: "LOAD_PASS",
    durationMs: Number(durationMs.toFixed(1)),
    terminalOpened: opened.length, terminalOverflow: overflowTerminals, terminalRbacDenied: 1,
    uploadsCompleted: transferLatency.length, uploadOverflow: overflowTransfers,
    bytesVerified: transferLatency.length * FILE_BYTES, unexpectedErrors: 0,
    terminalOpenMs: latencyMs(openLatency), terminalEchoMs: latencyMs(echoLatency),
    uploadCompletionIncludingStagingMs: latencyMs(transferLatency),
    cpuUserMs: cpu.user / 1_000, cpuSystemMs: cpu.system / 1_000,
    cpuPercentOfOneCore: Number(((cpu.user + cpu.system) / durationMs / 10).toFixed(1)),
    rssStartMiB: toMiB(startingRss), sampledRssPeakMiB: toMiB(Math.max(peakRss, endRss)), rssEndMiB: toMiB(endRss),
    sshConnectionsPeak: peakConnections,
    terminalsRemaining: terminals.getActiveSessionCount(), sshConnectionsRemaining: sshClients.size,
  }));
}

const watchdog = setTimeout(() => {
  console.error("LOAD_FAIL: tempo complessivo massimo superato (45 s)");
  process.exit(1);
}, 45_000);
runLoadTest().catch((error: unknown) => {
  console.error("LOAD_FAIL:", error);
  process.exitCode = 1;
}).finally(() => clearTimeout(watchdog));
