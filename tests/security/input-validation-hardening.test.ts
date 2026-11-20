// Requisiti verificati: RNF-SEC-002, RNF-SEC-004, RNF-SEC-005, SEC-01, SEC-02, SEC-03

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { createServer } from "../../backend/server.ts";
import { MolirisLogger } from "../../logging/logger.ts";
import { loadConfig } from "../../src/config/index.ts";
import { type SystemConfiguration } from "../../config/configuration.ts";
import { InMemoryUserRepository } from "../../backend/auth/user-repository.ts";
import { InMemoryRobotRepository } from "../../storage/robot-repository.ts";
import { InMemoryAuditRepository } from "../../storage/audit-repository.ts";
import { SessionManager } from "../../backend/auth/session-manager.ts";
import {
  PhysicalFileLogger,
  sanitizeLogDetails,
} from "../../backend/logging/physical-file-logger.ts";

const tmpDir = fs.mkdtempSync(path.join(process.cwd(), ".tmp-input-validation-"));
const certPath = path.join(tmpDir, "cert.pem");
const keyPath = path.join(tmpDir, "key.pem");
const serverFilesystemRoot = path.join(tmpDir, "server-files");
const logDir = path.join(tmpDir, "logs");
fs.mkdirSync(serverFilesystemRoot, { recursive: true });
execSync(
  `openssl req -x509 -newkey rsa:2048 -keyout "${keyPath}" -out "${certPath}" -days 1 -nodes -subj "/CN=localhost"`,
  { stdio: "pipe" }
);

const config: SystemConfiguration = {
  credentialProviderType: "in-memory",
  serverFilesystemRoot,
  pollingIntervalSeconds: 10,
  sshConnectionTimeoutMs: 3000,
  maxConcurrentTransfersPerUser: 2,
  maxConcurrentTransfersPerRobot: 2,
  maxConcurrentTransfersServer: 5,
  tempFileRetentionMinutes: 60,
  stateFilePaths: ["/tmp/status.txt"],
  inactiveSessionTimeoutMinutes: 30,
  tlsCertPath: certPath,
  tlsKeyPath: keyPath,
  registrationMode: "differita",
  auditLogRetentionDays: 30,
  defaultSshPort: 22,
};

const appConfig = loadConfig();

const logger = new MolirisLogger();
const physicalFileLogger = new PhysicalFileLogger(logDir);
const userRepository = new InMemoryUserRepository();
const robotRepository = new InMemoryRobotRepository();
const auditRepository = new InMemoryAuditRepository();
const sessionManager = new SessionManager(30, 1440);
const now = new Date();
const adminUser = {
  id: "security-admin-id",
  username: "security_admin",
  passwordHash: "not-used-by-this-suite",
  roles: ["amministratore"],
  enabled: true,
  createdAt: now,
  updatedAt: now,
};
await userRepository.create(adminUser);

const robotDirectory = path.join(serverFilesystemRoot, "robot-security");
fs.mkdirSync(robotDirectory, { recursive: true });
await robotRepository.create({
  id: "robot-security",
  displayName: "Robot Security",
  remoteUsername: "robot_operator",
  serverDirectoryPath: robotDirectory,
  host: "127.0.0.1",
  sshPort: 22,
  sshAuthMethod: "password",
  credentialReference: "vault://robots/robot-security",
  anagraphicState: "attivo",
  connectionState: "non_verificato",
  registrationState: "registrazione_incompleta",
  operationalState: null,
  lastValidUpdateAt: null,
  createdAt: now,
  updatedAt: now,
});

const app = createServer(config, logger, {
  appConfig,
  userRepository,
  robotRepository,
  auditRepository,
  sessionManager,
  physicalFileLogger,
});
await app.ready();

const session = sessionManager.createSession(adminUser);
const authHeaders = {
  cookie: `__Host-moliris_session=${session.sessionId}`,
  origin: "http://localhost",
  host: "localhost",
};
const failures: string[] = [];

async function check(name: string, test: () => Promise<void> | void): Promise<void> {
  try {
    await test();
    console.log(`PASS: ${name}`);
  } catch (error: any) {
    failures.push(`${name}: ${error.message}`);
    console.error(`FAIL: ${name}: ${error.message}`);
  }
}

async function readLogWhenReady(filePath: string): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (fs.existsSync(filePath)) return fs.readFileSync(filePath, "utf8");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Log non disponibile entro il tempo previsto: ${filePath}`);
}

function assertSingleNeutralizedLine(line: string): void {
  assert.ok(!/[\r\n\u0000-\u0009\u000B\u000C\u000E-\u001F\u007F\u2028\u2029]/.test(line), "Il log non deve contenere caratteri di controllo grezzi");
  assert.ok(!line.includes("attacker |"), "Il delimitatore del campo username deve essere neutralizzato");
  assert.ok(!line.includes("firmware.bin | Utente: forged"), "Il filename non deve potere creare campi forged");
  assert.ok(!line.includes("batch-1] (1 file) - Utente: forged\r\n"), "Il batchId non deve potere chiudere il proprio delimitatore");
}

try {
  await check("SEC-01: la configurazione pubblica non espone metadati di path", async () => {
    const response = await app.inject({ method: "GET", url: "/api/config/public" });
    assert.strictEqual(response.statusCode, 200);
    const body = response.json();
    assert.strictEqual(body.activeConfigPath, undefined);
    assert.strictEqual(body.activeConfigFile, undefined);
    assert.strictEqual(body.allowedPaths, undefined);
    assert.strictEqual(body.bulkUploadConfig?.allowedSubPaths, undefined);
    assert.ok(!response.body.includes((appConfig as any).loadedConfigPath));
    assert.strictEqual(body.sessionInactivityTimeoutMinutes, 30);
    assert.strictEqual(typeof body.bulkUploadConfig?.maxConcurrentFiles, "number");
  });

  await check("SEC-02: il logger neutralizza campi, delimitatori e segreti", async () => {
    const directLogDir = path.join(tmpDir, "direct-logs");
    const directLogger = new PhysicalFileLogger(directLogDir);
    const accessLine = await directLogger.logAccess({
      event: "LOGIN",
      username: "attacker | Ruolo: Amministratore\r\n[2099-01-01 00:00:00] EVENT: LOGIN",
      role: "operatore",
      outcome: "FALLIMENTO",
      details: "Riga\u0001\u2028=== con delimitatore | non sicuro",
    });
    assertSingleNeutralizedLine(accessLine);

    const transferLine = await directLogger.logTransfer({
      filename: "firmware.bin | Utente: forged\r\n=== CARICAMENTO MASSIVO TERMINATO",
      username: "attacker\nadmin",
      direction: "SERVER_TO_ROBOT",
      outcome: "FALLIMENTO",
      details: { password: "NonPersistire123!", token: "token-segreto", text: "abc|def\r\n=== forged" },
    });
    assertSingleNeutralizedLine(transferLine);
    assert.ok(!transferLine.includes("NonPersistire123!"));
    assert.ok(!transferLine.includes("token-segreto"));

    const bulkLine = await directLogger.logBulkStart(
      "batch-1] (1 file) - Utente: forged\r\n=== INIZIO CARICAMENTO MASSIVO",
      "attacker|admin",
      1
    );
    assertSingleNeutralizedLine(bulkLine);

    const details = sanitizeLogDetails({
      username: "attacker|admin\r\nsecond-line",
      nested: { authorization: "Bearer segreto", passphrase: "passphrase-segreta" },
    });
    assert.ok(!details.includes("Bearer segreto"));
    assert.ok(!details.includes("passphrase-segreta"));
    assert.ok(!/[\r\n]/.test(details));
    assert.ok(!details.includes("attacker|admin"));
  });

  await check("SEC-02: il login non consente log injection tramite username", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: {
        username: "attacker | Ruolo: Amministratore\r\n[2099-01-01 00:00:00] EVENT: LOGIN | Utente: admin",
        password: "password-non-valida",
      },
    });
    assert.strictEqual(response.statusCode, 401);
    const content = await readLogWhenReady(physicalFileLogger.getAccessLogFilePath());
    const lines = content.trimEnd().split("\n");
    assert.strictEqual(lines.length, 1, "Un tentativo di login deve produrre una sola riga fisica");
    assertSingleNeutralizedLine(lines[0]);
    assert.ok(!content.includes("\r"));
  });

  const malformedBodies: Array<{
    name: string;
    method: "POST" | "PUT";
    url: string;
    payload: any;
  }> = [
    {
      name: "registrazione robot con id non testuale",
      method: "POST",
      url: "/api/robots",
      payload: { id: { malformed: true } },
    },
    {
      name: "aggiornamento robot con body null",
      method: "PUT",
      url: "/api/robots/robot-security/configuration",
      payload: null,
    },
    {
      name: "rimozione robot con body null",
      method: "POST",
      url: "/api/robots/robot-security/remove",
      payload: null,
    },
    {
      name: "trasferimento server-robot con body null",
      method: "POST",
      url: "/api/robots/robot-security/transfers/server-robot",
      payload: null,
    },
    {
      name: "bulk pre-check con target null",
      method: "POST",
      url: "/api/transfers/bulk/pre-check",
      payload: { filenames: ["file.txt"], targets: [null] },
    },
    {
      name: "bulk pre-check con filename non testuale",
      method: "POST",
      url: "/api/transfers/bulk/pre-check",
      payload: { filenames: [{ malformed: true }], targets: [] },
    },
    {
      name: "bulk server-source con target null",
      method: "POST",
      url: "/api/transfers/bulk/server-source",
      payload: { sourcePaths: [], targets: [null] },
    },
  ];

  for (const testCase of malformedBodies) {
    await check(`SEC-03: ${testCase.name} restituisce 400`, async () => {
      const response = await app.inject({
        method: testCase.method,
        url: testCase.url,
        headers: { ...authHeaders, "content-type": "application/json" },
        payload: testCase.payload === null ? "null" : testCase.payload,
      });
      assert.strictEqual(response.statusCode, 400, response.body);
      assert.strictEqual(response.json().code, "INVALID_REQUEST_BODY");
    });
  }

  const malformedQueries = [
    {
      name: "query filename malformata su upload Server",
      method: "POST" as const,
      url: "/api/robots/robot-security/transfers/client-server/upload?subPath=upload&filename[x]=bad",
      headers: { "content-type": "application/octet-stream" },
      payload: "x",
    },
    {
      name: "query filename malformata su upload Robot",
      method: "POST" as const,
      url: "/api/robots/robot-security/transfers/client-robot/upload?filename[x]=bad",
      headers: { "content-type": "application/octet-stream" },
      payload: "x",
    },
    {
      name: "query paginazione flotta malformata",
      method: "GET" as const,
      url: "/api/robots?limit[x]=20",
      headers: {},
      payload: undefined,
    },
    {
      name: "query elenco trasferimenti malformata",
      method: "GET" as const,
      url: "/api/transfers?envelope[x]=true",
      headers: {},
      payload: undefined,
    },
  ];

  for (const testCase of malformedQueries) {
    await check(`SEC-03: ${testCase.name} restituisce 400`, async () => {
      const response = await app.inject({
        method: testCase.method,
        url: testCase.url,
        headers: { ...authHeaders, ...testCase.headers },
        payload: testCase.payload,
      });
      assert.strictEqual(response.statusCode, 400, response.body);
      assert.strictEqual(response.json().code, "INVALID_REQUEST_QUERY");
    });
  }

  await check("SEC-03: query valide restano compatibili", async () => {
    const fleetResponse = await app.inject({
      method: "GET",
      url: "/api/robots?limit=20&offset=0",
      headers: authHeaders,
    });
    assert.strictEqual(fleetResponse.statusCode, 200, fleetResponse.body);
    const transferResponse = await app.inject({
      method: "GET",
      url: "/api/transfers?envelope=true",
      headers: authHeaders,
    });
    assert.strictEqual(transferResponse.statusCode, 200, transferResponse.body);
    assert.ok(Array.isArray(transferResponse.json().transfers));
  });
} finally {
  await app.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

if (failures.length > 0) {
  throw new Error(`Verifiche di sicurezza non superate (${failures.length}):\n- ${failures.join("\n- ")}`);
}

console.log("PASS: SEC-01, SEC-02 e SEC-03 verificati.");
