// Requisiti verificati: SRS §2.5 (Google Chrome), §5.1, RF-AUTH-001..006, RF-ROB-001..014, RNF-UX-001..004
import assert from "assert";
import fs from "fs";
import path from "path";
import os from "os";
import { spawn, execSync, type ChildProcess } from "child_process";
import { generateKeyPairSync } from "node:crypto";
import { fileURLToPath } from "url";
import ssh2 from "ssh2";
import { createServer } from "../backend/server.ts";
import { loadConfig } from "../src/config/index.ts";
import { MolirisLogger } from "../logging/logger.ts";
import { type SystemConfiguration } from "../config/configuration.ts";
import { InMemoryRobotRepository } from "../storage/robot-repository.ts";
import { InMemoryAuditRepository } from "../storage/audit-repository.ts";
import { InMemoryUserRepository } from "../backend/auth/user-repository.ts";
import { hashPassword } from "../backend/auth/user-models.ts";
import { PhysicalFileLogger } from "../backend/logging/physical-file-logger.ts";
import type { TransferService } from "../backend/transfer/transfer-service.ts";
import type { TerminalService } from "../backend/terminal/terminal-service.ts";
import { SessionManager } from "../backend/auth/session-manager.ts";
import { ServerFilesystemService } from "../storage/server-fs.ts";
import { InMemoryCredentialProvider } from "../backend/connection/credential-provider.ts";
import { computeHostKeyFingerprint, DefaultHostKeyVerifier } from "../backend/connection/host-key-verifier.ts";
import { RobotConnectionManager } from "../backend/connection/robot-connection-manager.ts";

import { ErrorPresenter, ERROR_CATALOG } from "./src/services/error-presenter.ts";
import { StateFormatter } from "./src/services/state-formatter.ts";
import { ApiClient } from "./src/services/api-client.ts";
import { filterRobots } from "./src/utils/filterRobots.ts";
import { buildBulkTargets, hasBulkSourceSelection } from "./src/types/transfer.ts";
import type { RobotSummaryDto } from "./src/types/fleet.ts";
import React from "react";
import { renderToString } from "react-dom/server";
import { ErrorModal } from "./src/components/common/ErrorModal.tsx";
import { NotificationBanner } from "./src/components/common/NotificationBanner.tsx";

console.log("--> Esecuzione test E2E React Frontend su Google Chrome CDP...");

// =========================================================================
// TEST UNITARI DEI COMPONENTI E SERVIZI REACT
// =========================================================================

// Test 1: ErrorPresenter copre le 17 categorie §9 e non espone segreti (RNF-SEC-002)
console.log("  -> Test ErrorPresenter React: verifica catalogo §9 e messaggi sicuri");
const allCatalogKeys = Object.keys(ERROR_CATALOG);
assert.strictEqual(allCatalogKeys.length, 17, "Il catalogo React deve contenere tutte le 17 categorie §9");

for (const code of allCatalogKeys) {
  const formatted = ErrorPresenter.formatError({ code });
  assert.ok(formatted.userMessage, `Il codice ${code} deve avere un messaggio sicuro`);
  assert.ok(
    formatted.classification === "recuperabile" || formatted.classification === "richiede_intervento_amministrativo",
    `Il codice ${code} deve avere classificazione corretta`
  );
  assert.ok(!/password|secret|key|sql|mongo|internal/i.test(formatted.userMessage));
}

// Fallback per errori sconosciuti
const fallback = ErrorPresenter.formatError({ code: "UNKNOWN_ERR", message: "Error at Object..." });
assert.strictEqual(fallback.userMessage, "Si è verificato un errore durante l'elaborazione della richiesta.");
assert.strictEqual(fallback.classification, "recuperabile");

// Errore di rete (VPN Moliris)
const netError = ErrorPresenter.formatError(new TypeError("Failed to fetch"));
assert.strictEqual(netError.code, "NETWORK_DISCONNECTED");
assert.ok(netError.userMessage.includes("VPN Moliris"));
console.log("  PASS: ErrorPresenter React verifica tutte le categorie §9 con sanitizzazione totale.");

// Test 1a: Pop-up ATTENZIONE per errori operativi (invece del banner inline)
console.log("  -> Test ErrorModal e NotificationBanner: verifica pop-up ATTENZIONE per errori");
const testError = {
  code: "NETWORK_DISCONNECTED",
  userMessage: "Applicazione non raggiungibile. Verificare la connessione di rete e l'accesso alla VPN Moliris.",
  classification: "recuperabile" as const,
};
const errorModalHtml = renderToString(
  React.createElement(ErrorModal, { isOpen: true, error: testError, onClose: () => {} })
);
assert.ok(errorModalHtml.includes("ATTENZIONE"), "La modale di errore deve mostrare 'ATTENZIONE' come titolo");
assert.ok(errorModalHtml.includes("NETWORK_DISCONNECTED"), "La modale deve mostrare il codice errore NETWORK_DISCONNECTED");
assert.ok(errorModalHtml.includes("modal-error-alert"), "La modale deve avere id 'modal-error-alert'");
assert.ok(errorModalHtml.includes("btn-error-modal-close"), "La modale deve includere il pulsante di chiusura 'btn-error-modal-close'");
assert.ok(errorModalHtml.includes("Ho capito"), "Il pulsante di chiusura deve recitare 'Ho capito'");

const bannerWithErrorHtml = renderToString(
  React.createElement(NotificationBanner, { error: testError, onDismiss: () => {} })
);
assert.ok(bannerWithErrorHtml.includes("ATTENZIONE"), "NotificationBanner deve delegare l'errore alla modale pop-up ATTENZIONE");
assert.ok(bannerWithErrorHtml.includes('style="display:none"'), "NotificationBanner non deve mostrare banner di errore visibile inline");

const bannerWithMsgOnlyHtml = renderToString(
  React.createElement(NotificationBanner, { message: "Operazione completata", onDismiss: () => {} })
);
assert.ok(bannerWithMsgOnlyHtml.includes("Operazione completata"), "NotificationBanner deve mostrare i messaggi informativi nel pop-up");
assert.ok(bannerWithMsgOnlyHtml.includes("modal-notification-info"), "NotificationBanner deve aprire la modale pop-up per i messaggi informativi");
assert.ok(bannerWithMsgOnlyHtml.includes('style="display:none"'), "NotificationBanner non deve mostrare banner inline per le notifiche");
assert.ok(!bannerWithMsgOnlyHtml.includes("modal-error-alert"), "NotificationBanner non deve aprire modale di errore per soli messaggi informativi");
console.log("  PASS: ErrorModal e NotificationBanner verificati: tutte le notifiche appaiono come pop-up a schermo.");

// Test 1b: Wizard Caricamento Massivo - stato sorgente e contratto destinazioni
const bulkTargets = buildBulkTargets({
  server: { robotId: "robot_server", subPath: "upload" },
  robots: [{ robotId: "robot_remote", remotePath: "/data" }],
});
assert.deepStrictEqual(bulkTargets, [
  { type: "server", robotId: "robot_server", directory: "upload" },
  { type: "robot", robotId: "robot_remote", directory: "/data" },
]);
assert.strictEqual(
  hasBulkSourceSelection("computer", [{ name: "report.pdf", size: 42 } as File], []),
  true,
  "Un file selezionato dal computer deve abilitare il passo Destinazione"
);
assert.strictEqual(
  hasBulkSourceSelection("general", [], []),
  false,
  "Una sorgente server senza file selezionati non deve abilitare Avanti"
);
console.log("  PASS: Wizard Caricamento Massivo mantiene il contratto di selezione e destinazione.");

// Test 2: StateFormatter - Tre stati distinti e assenza di dati (RF-MON-005, §10.2)
console.log("  -> Test StateFormatter React: verifica rappresentazione distinta dei 3 stati");
const noDataText = StateFormatter.formatOperationalState(null);
assert.ok(noDataText.includes("dato non disponibile (RF-MON-005)"), "L'assenza di dati deve mostrare 'dato non disponibile'");

const staleDataText = StateFormatter.formatOperationalState({ battery: 85 }, true);
assert.ok(staleDataText.includes("[Non più verificato]"), "Il dato stale deve mostrare il badge [Non più verificato]");

const connLabel = StateFormatter.formatConnectionState("non_raggiungibile");
assert.strictEqual(connLabel, "non raggiungibile");
console.log("  PASS: StateFormatter React garantisce separazione categorica dei 3 stati.");

// Test 3: filterRobots - Ricerca e filtri flotta con accenti e case-insensitivity (SRS §5.1)
console.log("  -> Test filterRobots (SRS §5.1): verifica filtri cliente, impianto, nome, ID, accenti e resilienza");
const mockFleetForFilter: RobotSummaryDto[] = [
  {
    id: "robot_alpha_01",
    displayName: "Robot Ispettivo Alpha",
    remoteUsername: "operator",
    host: "10.0.0.1",
    sshPort: 22,
    anagraphicState: "attivo",
    connectionState: "raggiungibile",
    operationalState: null,
    lastValidUpdateAt: null,
    lastAttemptOutcome: null,
    customerName: "Acme Corporation",
    plantName: "Milano Impianto Nord",
  },
  {
    id: "robot_beta_02",
    displayName: "Robot Trasporto Beta",
    remoteUsername: "operator",
    host: "10.0.0.2",
    sshPort: 22,
    anagraphicState: "attivo",
    connectionState: "raggiungibile",
    operationalState: null,
    lastValidUpdateAt: null,
    lastAttemptOutcome: null,
    customerName: "Barilla Città",
    plantName: "Parma Ovest",
  },
  {
    id: "robot_gamma_03",
    displayName: "Robot Magazzino Gamma",
    remoteUsername: "operator",
    host: "10.0.0.3",
    sshPort: 22,
    anagraphicState: "attivo",
    connectionState: "raggiungibile",
    operationalState: null,
    lastValidUpdateAt: null,
    lastAttemptOutcome: null,
    // customerName e plantName volutamente assenti
  },
];

// a) Query vuota o spazi = lista completa
assert.strictEqual(filterRobots(mockFleetForFilter, "").length, 3, "Query vuota deve restituire tutta la flotta");
assert.strictEqual(filterRobots(mockFleetForFilter, "   ").length, 3, "Query con soli spazi deve restituire tutta la flotta");

// b) Match per cliente
const resCliente = filterRobots(mockFleetForFilter, "acme", "cliente");
assert.strictEqual(resCliente.length, 1);
assert.strictEqual(resCliente[0].id, "robot_alpha_01");

// c) Match per impianto
const resImpianto = filterRobots(mockFleetForFilter, "parma", "impianto");
assert.strictEqual(resImpianto.length, 1);
assert.strictEqual(resImpianto[0].id, "robot_beta_02");

// d) Match per nome robot
const resNome = filterRobots(mockFleetForFilter, "magazzino", "nome_robot");
assert.strictEqual(resNome.length, 1);
assert.strictEqual(resNome[0].id, "robot_gamma_03");

// e) Match per ID robot
const resId = filterRobots(mockFleetForFilter, "beta_02", "id_robot");
assert.strictEqual(resId.length, 1);
assert.strictEqual(resId[0].id, "robot_beta_02");

// f) Case-insensitive e rimozione accenti (citta trova Città)
const resAccenti = filterRobots(mockFleetForFilter, "citta", "tutti");
assert.strictEqual(resAccenti.length, 1, "La ricerca 'citta' deve trovare 'Barilla Città'");
assert.strictEqual(resAccenti[0].customerName, "Barilla Città");

// g) Resilienza a campi mancanti (robot_gamma_03 senza cliente/impianto)
const resMissing = filterRobots(mockFleetForFilter, "gamma", "tutti");
assert.strictEqual(resMissing.length, 1);
assert.strictEqual(resMissing[0].id, "robot_gamma_03");

// h) Nessun risultato = array vuoto
const resNoMatch = filterRobots(mockFleetForFilter, "non_esistente", "tutti");
assert.strictEqual(resNoMatch.length, 0, "Filtro senza riscontri deve restituire array vuoto");
console.log("  PASS: filterRobots supera tutti i controlli (cliente, impianto, accenti, case-insensitive, campi mancanti).");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "moliris-react-test-"));
const certPath = path.join(tmpDir, "cert.pem");
const keyPath = path.join(tmpDir, "key.pem");
const serverFsRoot = path.join(tmpDir, "server_fs_root");
fs.mkdirSync(serverFsRoot, { recursive: true });

execSync(
  `openssl req -x509 -newkey rsa:2048 -keyout "${keyPath}" -out "${certPath}" -days 1 -nodes -subj "/CN=localhost"`,
  { stdio: "pipe" }
);

const testConfig: SystemConfiguration = {
  serverFilesystemRoot: serverFsRoot,
  pollingIntervalSeconds: 0,
  sshConnectionTimeoutMs: 3000,
  maxConcurrentTransfersPerUser: 5,
  maxConcurrentTransfersPerRobot: 5,
  maxConcurrentTransfersServer: 20,
  tempFileRetentionMinutes: 60,
  stateFilePaths: ["/var/log/status.txt"],
  inactiveSessionTimeoutMinutes: 30,
  tlsCertPath: certPath,
  tlsKeyPath: keyPath,
  registrationMode: "rigorosa",
  auditLogRetentionDays: 90,
  defaultSshPort: 22,
};

const duplicateLogReplies: string[] = [];
const logger = new class extends MolirisLogger {
  override error(message: string, detail?: string, meta?: Record<string, unknown>): void {
    if (meta?.code === "ERR_HTTP_HEADERS_SENT" && String(meta.url).startsWith("/api/logs/")) {
      duplicateLogReplies.push(String(meta.url));
    }
    super.error(message, detail, meta);
  }
}();
const robotRepo = new InMemoryRobotRepository();
const auditRepo = new InMemoryAuditRepository();
const userRepo = new InMemoryUserRepository();
const sessionManager = new SessionManager(testConfig.inactiveSessionTimeoutMinutes);
const credentialProvider = new InMemoryCredentialProvider();
const hostKeyVerifier = new DefaultHostKeyVerifier();
const connectionManager = new RobotConnectionManager(credentialProvider, hostKeyVerifier, logger, 3000);
const serverFsService = new ServerFilesystemService(serverFsRoot, {} as any, logger);

const adminHash = await hashPassword("AdminPassword123!");
await userRepo.create({
  id: "user_admin",
  username: "admin",
  passwordHash: adminHash,
  roles: ["admin"],
  enabled: true,
  createdAt: new Date(),
  updatedAt: new Date(),
});

const blockedUserPassword = "BlockedSession123!";
const blockedUserHash = await hashPassword(blockedUserPassword);
const blockedUser = {
  id: "user_blocked_session",
  username: "blocked_session",
  passwordHash: blockedUserHash,
  roles: ["operatore"],
  enabled: true,
  createdAt: new Date(),
  updatedAt: new Date(),
};
await userRepo.create(blockedUser);
sessionManager.createSession(blockedUser);

const robotReact = {
  id: "robot_react_01",
  displayName: "Robot React Alpha",
  remoteUsername: "operator_react",
  serverDirectoryPath: path.join(serverFsRoot, "operator_react"),
  host: "127.0.0.1",
  sshPort: 2222,
  sshAuthMethod: "password",
  credentialReference: "vault://creds/robot_react_01",
  anagraphicState: "attivo",
  connectionState: "raggiungibile",
  registrationState: "registrazione_completata",
  operationalState: { battery: 95, status: "idle" },
  lastValidUpdateAt: new Date(),
  lastAttemptOutcome: { success: true, timestamp: new Date() },
  createdAt: new Date(),
  updatedAt: new Date(),
};
await robotRepo.create(robotReact);
await serverFsService.ensureRobotDirectory(robotReact);

// Fixture file per test trasferimento file
fs.writeFileSync(path.join(serverFsRoot, "operator_react", "sample_file.txt"), "Dati di test");

// TEST SICUREZZA APICLIENT
console.log("  -> Test ApiClient: verifica blocco degli host esterni");

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");

const sessionConflictOnly = process.env["SESSION_CONFLICT_ONLY"] === "1";
// Segnale dedicato per saltare il resto dell'E2E mantenendo attivo il cleanup nel finally.
const sessionConflictOnlyComplete = new Error("Session-conflict-only frontend test complete.");
const logoutOnly = process.env["LOGOUT_ONLY"] === "1";
const logoutOnlyComplete = new Error("Logout-only frontend test complete.");
const logoutCyclesOnly = process.env["LOGOUT_CYCLES_ONLY"] === "1";
const logoutCyclesOnlyComplete = new Error("Logout cycles frontend test complete.");

try {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { location: { origin: "https://moliris.test" } },
  });

  const apiClient = new ApiClient();

  apiClient.assertLocalBackendEndpoint("/api/robots");
  apiClient.assertLocalBackendEndpoint("https://moliris.test/api/robots");

  for (const endpoint of [
    "https://attacker.example/path",
    "http://attacker.example/path",
    "//attacker.example/path",
  ]) {
    assert.throws(
      () => apiClient.assertLocalBackendEndpoint(endpoint),
      `L'endpoint esterno deve essere bloccato: ${endpoint}`
    );
  }

  console.log("  PASS: ApiClient accetta endpoint locali e blocca quelli esterni.");
} finally {
  if (originalWindow) {
    Object.defineProperty(globalThis, "window", originalWindow);
  } else {
    delete (globalThis as any).window;
  }
}

const physicalFileLogger = new PhysicalFileLogger(path.join(tmpDir, "logs"));
const server = createServer(testConfig, logger, {
  physicalFileLogger,
  robotRepository: robotRepo,
  auditRepository: auditRepo,
  userRepository: userRepo,
  sessionManager,
  credentialProvider,
  hostKeyVerifier,
  connectionManager,
  serverFsService,
  appConfig: loadConfig({
    overrides: {
      futureExtensions: {
        maxSessionsPerAccount: 1,
        maxFleetRobots: 100,
        customSettings: {},
      },
    },
  }),
});

let holdNextLogoutResponse = false;
let releaseLogoutResponse: (() => void) | undefined;
let holdNextTransferPoll = false;
let releaseTransferPoll: (() => void) | undefined;
let transferPollAborted = false;
server.addHook("onSend", async (request, reply, payload) => {
  if (holdNextLogoutResponse && request.method === "POST" && request.url === "/api/auth/logout") {
    holdNextLogoutResponse = false;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 9_000);
      releaseLogoutResponse = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }
  if (holdNextTransferPoll && request.method === "GET" && request.url === "/api/transfers/recent") {
    holdNextTransferPoll = false;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 9_000);
      releaseTransferPoll = () => {
        clearTimeout(timer);
        resolve();
      };
      reply.raw.once("close", () => {
        transferPollAborted = !reply.raw.writableFinished;
        releaseTransferPoll?.();
      });
    });
  }
  return payload;
});

const address = await server.listen({ port: 0, host: "127.0.0.1" });
const serverPort = (server.server.address() as any).port;
const serverBaseUrl = `https://127.0.0.1:${serverPort}`;

console.log("  -> Avvio Google Chrome Headless per test E2E React...");
const cdpPort = 9445;
const chromeUserDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "moliris-react-chrome-"));
const chromeProcess: ChildProcess = spawn(
  "/usr/bin/google-chrome",
  [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${chromeUserDataDir}`,
    "about:blank",
  ],
  { stdio: "ignore", detached: true }
);

let wsDebuggerUrl = "";
for (let attempt = 0; attempt < 30; attempt++) {
  try {
    const res = await fetch(`http://127.0.0.1:${cdpPort}/json/list`, { signal: AbortSignal.timeout(1000) });
    if (res.ok) {
      const pages = await res.json();
      const pageTarget = pages.find((p: any) => p.type === "page") || pages[0];
      if (pageTarget && pageTarget.webSocketDebuggerUrl) {
        wsDebuggerUrl = pageTarget.webSocketDebuggerUrl;
        break;
      }
    }
  } catch {}
  await new Promise((r) => setTimeout(r, 150));
}

assert.ok(wsDebuggerUrl, "Chrome Headless deve essere raggiungibile tramite porta CDP");

const cdpWs = new WebSocket(wsDebuggerUrl);
await new Promise<void>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("Timeout connessione CDP")), 4_000);
  cdpWs.onopen = () => { clearTimeout(timer); resolve(); };
  cdpWs.onerror = (e) => { clearTimeout(timer); reject(e); };
});

let cdpMsgId = 1;
const pendingCdpReplies = new Map<number, (reply: any) => void>();
const networkRequestsMade: string[] = [];
const networkRequestsWithMethod: Array<{ method: string; url: string }> = [];
const browserJavaScriptErrors: string[] = [];
const terminalSocketIds = new Map<string, string>();
const liveTerminalSockets = new Set<string>();
const terminalService = (server as typeof server & { terminalService: TerminalService }).terminalService;
const terminalInputs: string[] = [];

cdpWs.onmessage = (event) => {
  try {
    const data = JSON.parse(event.data as string);
    if (data.method === "Runtime.exceptionThrown") {
      const details = data.params.exceptionDetails;
      browserJavaScriptErrors.push(details.exception?.description || details.text);
    } else if (data.method === "Runtime.consoleAPICalled" && data.params.type === "error") {
      browserJavaScriptErrors.push(data.params.args.map((arg: any) => arg.value ?? arg.description).join(" "));
    }
    if (data.method === "Network.requestWillBeSent") {
      const reqUrl = data.params?.request?.url;
      if (reqUrl) {
        networkRequestsMade.push(reqUrl);
        networkRequestsWithMethod.push({
          method: String(data.params?.request?.method || "GET").toUpperCase(),
          url: reqUrl,
        });
      }
    }
    if (data.method === "Network.webSocketCreated" && new URL(data.params.url).pathname.startsWith("/api/terminal/ws/")) {
      terminalSocketIds.set(data.params.requestId, new URL(data.params.url).pathname.split("/").at(-1)!);
      liveTerminalSockets.add(data.params.requestId);
    }
    if (data.method === "Network.webSocketFrameSent" && terminalSocketIds.has(data.params.requestId)) {
      const payload = data.params.response.payloadData;
      try {
        const message = JSON.parse(payload);
        if (message.type === "input") terminalInputs.push(message.data);
      } catch {
        terminalInputs.push(payload);
      }
    }
    if (data.method === "Network.webSocketClosed") {
      liveTerminalSockets.delete(data.params.requestId);
      terminalSocketIds.delete(data.params.requestId);
    }
    if (data.id && pendingCdpReplies.has(data.id)) {
      const cb = pendingCdpReplies.get(data.id)!;
      pendingCdpReplies.delete(data.id);
      cb(data);
    }
  } catch {}
};

async function sendCdpCommand(method: string, params: any = {}): Promise<any> {
  const id = cdpMsgId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingCdpReplies.delete(id);
      reject(new Error(`Timeout CDP: ${method}`));
    }, 10_000);
    pendingCdpReplies.set(id, (reply) => {
      clearTimeout(timer);
      if (reply.error) reject(new Error(`${method}: ${reply.error.message}`));
      else resolve(reply.result);
    });
    cdpWs.send(JSON.stringify({ id, method, params }));
  });
}

await sendCdpCommand("Page.enable");
await sendCdpCommand("Network.enable");
await sendCdpCommand("Runtime.enable");
await sendCdpCommand("Page.addScriptToEvaluateOnNewDocument", {
  source: "window.__ENABLE_INACTIVITY_TEST_HOOKS__ = true;",
});

async function evaluateInBrowser<T>(expression: string): Promise<T> {
  const res = await sendCdpCommand("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (res.exceptionDetails) {
    throw new Error(`Errore valutazione browser: ${JSON.stringify(res.exceptionDetails)}`);
  }
  return res.result?.value as T;
}

async function waitForBrowser(expression: string, timeoutMs = 4_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  do {
    if (await evaluateInBrowser<boolean>(expression)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (performance.now() < deadline);
  assert.fail(`Condizione browser non soddisfatta: ${expression}`);
}

async function terminalKey(key: string, code: string, windowsVirtualKeyCode: number, modifiers: number) {
  for (const type of ["rawKeyDown", "keyUp"]) {
    await sendCdpCommand("Input.dispatchKeyEvent", { type, key, code, windowsVirtualKeyCode, modifiers });
  }
}

async function testTerminalClipboard() {
  const menu = ".terminal-context-menu:popover-open";
  const input = "#terminal-clipboard-input";
  const origin = serverBaseUrl;
  await sendCdpCommand("Browser.grantPermissions", { origin, permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"] });
  try {
    // Il primo fit può ridisegnare le righe dopo l'arrivo del prompt SSH.
    await evaluateInBrowser("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
    const { x, y, cellWidth } = await evaluateInBrowser<{ x: number; y: number; cellWidth: number }>(`(() => {
      const screen = document.querySelector('#terminal-container .xterm-screen');
      const row = [...screen.querySelectorAll('.xterm-rows > div')]
        .find(row => row.textContent === 'BETA_LINE');
      const { top, height } = row.getBoundingClientRect();
      const { left, width } = screen.getBoundingClientRect();
      const columns = parseInt(document.querySelector('#terminal-footer-dims').textContent, 10);
      return { x: left, y: top + height / 2, cellWidth: width / columns };
    })()`);
    const startX = x + cellWidth * 0.2;
    const endX = x + cellWidth * 9.2;
    await sendCdpCommand("Input.dispatchMouseEvent", { type: "mousePressed", x: startX, y, button: "left", buttons: 1, clickCount: 1 });
    await sendCdpCommand("Input.dispatchMouseEvent", { type: "mouseMoved", x: endX, y, buttons: 1 });
    await waitForBrowser("Boolean(document.querySelector('#terminal-container .xterm-selection > div'))");
    await sendCdpCommand("Input.dispatchMouseEvent", { type: "mouseReleased", x: endX, y, button: "left", clickCount: 1 });

    const beforeCopy = terminalInputs.length;
    await terminalKey("C", "KeyC", 67, 10);
    assert.strictEqual(await evaluateInBrowser("navigator.clipboard.readText()"), "BETA_LINE");
    assert.strictEqual(terminalInputs.length, beforeCopy);

    async function chooseMenu(label: string) {
      await sendCdpCommand("Input.dispatchMouseEvent", { type: "mousePressed", x: endX, y, button: "right", buttons: 2, clickCount: 1 });
      await sendCdpCommand("Input.dispatchMouseEvent", { type: "mouseReleased", x: endX, y, button: "right", clickCount: 1 });
      await waitForBrowser(`Boolean(document.querySelector('${menu}'))`);
      const { x, y: buttonY } = await evaluateInBrowser<{ x: number; y: number }>(`(() => {
        const button = [...document.querySelectorAll('${menu} button')].find(button => button.textContent === ${JSON.stringify(label)});
        const rect = button.getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      })()`);
      await sendCdpCommand("Input.dispatchMouseEvent", { type: "mousePressed", x, y: buttonY, button: "left", buttons: 1, clickCount: 1 });
      await sendCdpCommand("Input.dispatchMouseEvent", { type: "mouseReleased", x, y: buttonY, button: "left", clickCount: 1 });
    }

    await chooseMenu("Seleziona tutto");
    await chooseMenu("Copia");
    assert.match(await evaluateInBrowser<string>("navigator.clipboard.readText()"), /ALPHA_LINE\nBETA_LINE\nGAMMA_LINE/);

    const expectTerminalInput = async (after: number, expected: string) => {
      await waitForCondition(() => terminalInputs.length > after);
      assert.deepEqual(terminalInputs.slice(after), [expected]);
    };

    const shortcuts = [
      ["v", "KeyV", 86, 2, "PASTE_CTRL_V"],
      ["V", "KeyV", 86, 10, "PASTE_CTRL_SHIFT_V"],
      ["Insert", "Insert", 45, 8, "PASTE_SHIFT_INSERT"],
    ] as const;
    for (const [key, code, virtualCode, modifiers, marker] of shortcuts) {
      await evaluateInBrowser(`navigator.clipboard.writeText(${JSON.stringify(marker)})`);
      const before = terminalInputs.length;
      await terminalKey(key, code, virtualCode, modifiers);
      await expectTerminalInput(before, `\x1b[200~${marker}\x1b[201~`);
    }

    await evaluateInBrowser(String.raw`navigator.clipboard.writeText('PASTE_MENU\r\nRIGA_2\nRIGA_3')`);
    const beforeMenu = terminalInputs.length;
    await chooseMenu("Incolla");
    await waitForBrowser(`!document.querySelector('${menu}')`);
    await evaluateInBrowser("navigator.clipboard.readText()");
    await expectTerminalInput(beforeMenu, "\x1b[200~PASTE_MENU\rRIGA_2\rRIGA_3\x1b[201~");

    await evaluateInBrowser("navigator.clipboard.writeText('PASTE_NEGA_PERMESSO')");
    await sendCdpCommand("Browser.setPermission", { origin, permission: { name: "clipboard-read" }, setting: "denied" });
    const beforeFallback = terminalInputs.length;
    await chooseMenu("Incolla");
    await waitForBrowser(`document.activeElement.matches('${input}')`);
    assert.strictEqual(terminalInputs.length, beforeFallback, "Il menu deve attendere un incolla esplicito");
    await terminalKey("v", "KeyV", 86, 2);
    await expectTerminalInput(beforeFallback, "\x1b[200~PASTE_NEGA_PERMESSO\x1b[201~");

    await evaluateInBrowser("Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })");
    try {
      const beforeUnavailable = terminalInputs.length;
      await chooseMenu("Incolla");
      await waitForBrowser(`document.activeElement.matches('${input}')`);
      assert.strictEqual(terminalInputs.length, beforeUnavailable);
      await terminalKey("v", "KeyV", 86, 2);
      await expectTerminalInput(beforeUnavailable, "\x1b[200~PASTE_NEGA_PERMESSO\x1b[201~");
    } finally {
      await evaluateInBrowser("delete navigator.clipboard");
    }

    const beforeInterrupt = terminalInputs.length;
    await terminalKey("c", "KeyC", 67, 2);
    await expectTerminalInput(beforeInterrupt, "\x03");
  } finally {
    await sendCdpCommand("Browser.resetPermissions");
  }
}

async function waitForCondition(condition: () => boolean, timeoutMs = 6_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(condition(), "Condizione backend non verificata entro il timeout");
}

function isLiveProcess(pid: number) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function typeTerminalCommand(command: string): Promise<void> {
  await evaluateInBrowser("document.querySelector('#terminal-container .xterm-helper-textarea').focus()");
  await sendCdpCommand("Input.insertText", { text: command });
  await terminalKey("Enter", "Enter", 13, 0);
}

async function waitForTerminalOutput(expected: string): Promise<void> {
  await waitForBrowser(`document.querySelector('#terminal-container .xterm-rows')?.textContent.includes(${JSON.stringify(expected)})`);
}

async function disconnectTerminalInBrowser(): Promise<void> {
  await evaluateInBrowser("document.querySelector('#btn-terminal-disconnect').click()");
  await waitForBrowser("Boolean(document.querySelector('#btn-confirm-terminal-disconnect'))");
  await evaluateInBrowser("document.querySelector('#btn-confirm-terminal-disconnect').click()");
  await waitForBrowser("!document.querySelector('#modal-terminal')");
}

async function testRemoteTerminalClipboard() {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const parsedKey = ssh2.utils.parseKey(privateKey);
  assert.ok(!(parsedKey instanceof Error) && !Array.isArray(parsedKey));
  const { sha256Hex } = computeHostKeyFingerprint(parsedKey.getPublicSSH());
  const password = "TerminalClipboardFixture";
  const sshClients = new Set<ssh2.Connection>();
  let hiddenRobotOutput = false;
  const sshServer = new ssh2.Server({ hostKeys: [privateKey] }, (client) => {
    sshClients.add(client);
    client.on("close", () => sshClients.delete(client));
    client.on("authentication", (ctx) => {
      if (ctx.method === "password" && ctx.username.startsWith("clipboard_fixture") && ctx.password === password) ctx.accept();
      else ctx.reject();
    });
    client.on("ready", () => client.on("session", (accept) => {
      const session = accept();
      session.on("pty", (acceptPty) => acceptPty?.());
      session.on("window-change", (acceptResize) => acceptResize?.());
      session.on("shell", (acceptShell) => {
        const stream = acceptShell();
        stream.write("ALPHA_LINE\r\nBETA_LINE\r\nGAMMA_LINE\r\n\x1b[?2004h$ ");
        stream.on("data", (data: Buffer) => {
          if (data.includes(3)) stream.write("^C\r\n$ ");
          if (data.includes("RUN_DELAYED_FIXTURE")) {
            const timer = setTimeout(() => {
              stream.write("\x1b[6n"); // Richiede a xterm la posizione del cursore.
            }, 1000);
            stream.once("close", () => clearTimeout(timer));
          }
          if (/\x1b\[\d+;\d+R/.test(data.toString())) {
            hiddenRobotOutput = true;
            stream.write("REMOTE_DELAYED_DONE\r\n$ ");
          }
        });
      });
    }));
  });
  await new Promise<void>((resolve, reject) => {
    sshServer.once("error", reject);
    sshServer.listen(0, "127.0.0.1", resolve);
  });

  const robotIds = ["robot_clipboard_ssh", "robot_clipboard_ssh_two"];
  const activeSessionFor = (target: string) => {
    for (const requestId of liveTerminalSockets) {
      const session = terminalService.getSession(terminalSocketIds.get(requestId)!);
      if (session?.robotId === target) return session;
    }
  };
  const robotButtons = robotIds.map((id) => `#btn-terminal-${id}`);
  const openRobot = async (index: number) => {
    await waitForBrowser(`document.querySelector('${robotButtons[index]}:enabled') !== null`, 8_000);
    await evaluateInBrowser(`document.querySelector('${robotButtons[index]}').click()`);
    await waitForBrowser("document.querySelector('#terminal-session-status')?.textContent === 'Connesso'");
  };
  const hide = () => evaluateInBrowser("document.querySelector('#btn-close-terminal').click()");
  try {
    for (const [index, robotId] of robotIds.entries()) {
      const username = `clipboard_fixture_${index}`;
      await robotRepo.create({
        ...robotReact,
        id: robotId,
        displayName: `Robot Clipboard ${index + 1}`,
        remoteUsername: username,
        serverDirectoryPath: path.join(serverFsRoot, username),
        sshPort: (sshServer.address() as { port: number }).port,
        credentialReference: await credentialProvider.store(robotId, { method: "password", password }),
        hostKeyVerification: { fingerprint: sha256Hex, strictHostKeyChecking: true },
      });
    }
    await openRobot(0);
    await waitForTerminalOutput("BETA_LINE");
    await testTerminalClipboard();
    await waitForTerminalOutput("^C");
    const firstRobotSession = activeSessionFor(robotIds[0]);
    assert.ok(firstRobotSession);

    await typeTerminalCommand("RUN_DELAYED_FIXTURE");
    await hide();
    await waitForBrowser("!document.querySelector('#modal-terminal')");
    assert.ok(!hiddenRobotOutput);

    await openRobot(1);
    const secondRobotSession = activeSessionFor(robotIds[1]);
    assert.ok(secondRobotSession);
    assert.equal(terminalService.getActiveSessionCount(), 2);
    await waitForCondition(() => hiddenRobotOutput && sshClients.size === 2);
    assert.equal(liveTerminalSockets.size, 2);
    assert.equal(await evaluateInBrowser("document.querySelector('#terminal-container .xterm-rows').textContent.includes('REMOTE_DELAYED_DONE')"), false);
    await hide();

    await openRobot(0);
    await waitForTerminalOutput("REMOTE_DELAYED_DONE");
    await waitForTerminalOutput("BETA_LINE");
    assert.strictEqual(terminalService.getSession(firstRobotSession.sessionId), firstRobotSession);
    await disconnectTerminalInBrowser();
    await waitForCondition(() => sshClients.size === 1 && liveTerminalSockets.size === 1);
    assert.equal(terminalService.getActiveSessionCount(), 1);
    assert.ok(terminalService.getSession(secondRobotSession.sessionId));

    await openRobot(0);
    const replacementRobotSession = activeSessionFor(robotIds[0]);
    assert.ok(replacementRobotSession);
    assert.notEqual(replacementRobotSession.sessionId, firstRobotSession.sessionId);
    await hide();

    await evaluateInBrowser("document.querySelector('#btn-server-terminal').click()");
    await waitForBrowser("document.querySelector('#terminal-session-status')?.textContent === 'Connesso'");
    const localSession = activeSessionFor("server");
    assert.ok(localSession?.localProcess?.pid);
    assert.equal(terminalService.getActiveSessionCount(), 3);
    await hide();

    await evaluateInBrowser("document.querySelector('#btn-logout').click()");
    await waitForBrowser("Boolean(document.querySelector('#btn-login:not(:disabled)'))");
    await waitForCondition(() => sshClients.size === 0 && liveTerminalSockets.size === 0 &&
      !isLiveProcess(localSession.localProcess.pid));
    assert.equal(terminalService.getActiveSessionCount(), 0);
    console.log("  PASS: Chrome verifica la persistenza SSH di due robot, il copia-incolla, la disconnessione selettiva e il logout di 3 terminali.");
  } finally {
    for (const id of robotIds) await robotRepo.deleteById(id);
    for (const client of sshClients) client.end();
    await new Promise<void>((resolve) => sshServer.close(() => resolve()));
    for (const button of robotButtons) await waitForBrowser(`!document.querySelector('${button}')`, 8_000);
  }
}

async function setBrowserNetwork(latency: number, offline = false): Promise<void> {
  await sendCdpCommand("Network.emulateNetworkConditions", {
    offline,
    latency,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });
}

async function testLogout(): Promise<void> {
  const initialBrowserErrors = browserJavaScriptErrors.length;
  // Conserva nella cronologia una pagina che ha già mostrato la dashboard.
  await sendCdpCommand("Page.navigate", { url: `${serverBaseUrl}/index.html` });
  await waitForBrowser("location.pathname === '/index.html' && Boolean(document.querySelector('#btn-logout'))");
  await setBrowserNetwork(1_200);
  try {
    const beforeLogout = networkRequestsWithMethod.filter(({ url }) => url.endsWith("/api/auth/logout")).length;
    const feedbackMs = await evaluateInBrowser<number>(`new Promise((resolve, reject) => {
      const start = performance.now();
      const observer = new MutationObserver(() => {
        if (document.querySelector('#login-section') && !document.querySelector('#dashboard-section, #current-username')) {
          observer.disconnect();
          clearTimeout(timeout);
          requestAnimationFrame(() => resolve(performance.now() - start));
        }
      });
      const timeout = setTimeout(() => {
        observer.disconnect();
        reject(new Error('Il login pubblico non è apparso'));
      }, 4000);
      observer.observe(document.body, { childList: true, subtree: true });
      const button = document.getElementById('btn-logout');
      button.click();
      button.click();
    })`);
    console.log(`  -> Logout Chrome, latenza di rete di 1200 ms: feedback in ${feedbackMs.toFixed(1)} ms.`);
    assert.ok(feedbackMs <= 100, "Il login pubblico deve apparire entro 100 ms dal clic");
    const pendingCardHeight = await evaluateInBrowser<number>(
      "document.querySelector('#login-section').getBoundingClientRect().height"
    );
    assert.equal(await evaluateInBrowser("document.querySelector('#logout-status')?.role"), "status");
    await waitForBrowser("!document.querySelector('#logout-status')");
    const confirmedCardHeight = await evaluateInBrowser<number>(
      "document.querySelector('#login-section').getBoundingClientRect().height"
    );
    assert.equal(confirmedCardHeight, pendingCardHeight, "La conferma non deve spostare il layout del login");
    await waitForBrowser("document.activeElement?.id === 'username'");
    const afterLogout = networkRequestsWithMethod.filter(({ url }) => url.endsWith("/api/auth/logout")).length;
    assert.strictEqual(afterLogout - beforeLogout, 1, "Due clic devono produrre un solo POST di logout");
  } finally {
    await setBrowserNetwork(0);
  }

  await evaluateInBrowser<void>("history.back(); void 0");
  await waitForBrowser("location.pathname === '/' && Boolean(document.querySelector('#login-section'))");
  assert.equal(await evaluateInBrowser("Boolean(document.querySelector('#dashboard-section, #current-username'))"), false);

  await evaluateInBrowser<void>(`{
    document.getElementById('username').value = 'admin';
    document.getElementById('password').value = 'AdminPassword123!';
    document.getElementById('btn-login').click();
  }`);
  await waitForBrowser("Boolean(document.querySelector('#btn-logout'))");

  await setBrowserNetwork(0, true);
  try {
    await evaluateInBrowser<void>("document.getElementById('btn-logout').click()");
    await waitForBrowser("Boolean(document.querySelector('#btn-retry-logout'))");
    assert.equal(await evaluateInBrowser("document.querySelector('#btn-login').disabled"), true);
    assert.equal(await evaluateInBrowser("Boolean(document.querySelector('#dashboard-section, #current-username'))"), false);
    await evaluateInBrowser<void>("document.getElementById('btn-retry-logout').click()");
    await waitForBrowser("Boolean(document.querySelector('#btn-retry-logout:not(:disabled)'))");
  } finally {
    await setBrowserNetwork(0);
  }
  await waitForBrowser("!document.querySelector('#logout-status') && !document.querySelector('#btn-login').disabled");
  await sendCdpCommand("Page.reload");
  await waitForBrowser("Boolean(document.querySelector('#login-section'))");
  assert.equal(await evaluateInBrowser("Boolean(document.querySelector('#dashboard-section, #current-username'))"), false);
  assert.deepEqual(browserJavaScriptErrors.slice(initialBrowserErrors), [], "Nessun errore JavaScript con rete lenta e assente");
  console.log("  PASS: Logout Chrome con clic ripetuti, Indietro, rete assente, nuovo tentativo, riconnessione e ricarica.");
}

async function loginAgain(): Promise<void> {
  await evaluateInBrowser<void>(`{
    document.getElementById('username').value = 'admin';
    document.getElementById('password').value = 'AdminPassword123!';
    document.getElementById('btn-login').click();
  }`);
  await waitForBrowser("Boolean(document.querySelector('#btn-logout'))");
  assert.equal(sessionManager.getActiveSessionsCount("user_admin"), 1);
}

async function testNavbarRole(role: "admin" | "operatore", label: string): Promise<void> {
  const readBadge = "document.getElementById('current-roles')?.textContent";
  assert.equal(await evaluateInBrowser(readBadge), label, `Badge di ${role} dopo il login`);

  await evaluateInBrowser("document.getElementById('nav-files').click()");
  await waitForBrowser("document.getElementById('nav-files')?.getAttribute('aria-current') === 'page'");
  assert.equal(await evaluateInBrowser(readBadge), label, `Badge di ${role} in Gestione file`);

  await evaluateInBrowser("document.getElementById('btn-tab-transfers').click()");
  await waitForBrowser("document.getElementById('btn-tab-transfers')?.getAttribute('aria-selected') === 'true'");
  assert.equal(await evaluateInBrowser(readBadge), label, `Badge di ${role} in Trasferimenti`);

  if (role === "admin") {
    await evaluateInBrowser("document.getElementById('nav-logs').click()");
    await waitForBrowser("Boolean(document.getElementById('logs-view-container'))");
    assert.equal(await evaluateInBrowser(readBadge), label, `Badge di ${role} in Logs`);
  } else {
    assert.equal(await evaluateInBrowser("Boolean(document.getElementById('nav-logs'))"), false);
  }

  await evaluateInBrowser("document.getElementById('nav-fleet').click()");
  await sendCdpCommand("Page.reload");
  await waitForBrowser("document.getElementById('nav-fleet')?.getAttribute('aria-current') === 'page'");
  assert.equal(await evaluateInBrowser(readBadge), label, `Badge di ${role} dopo il refresh`);
  assert.deepEqual(
    await evaluateInBrowser("fetch('/api/auth/me').then(response => response.json()).then(data => data.user.roles)"),
    [role],
    "Il profilo API deve mantenere il ruolo tecnico"
  );
  console.log(`  PASS: Badge ${label} in Chrome dopo login, cambio vista e refresh.`);
}

async function testRestrictedLogsNavigation(): Promise<void> {
  const fleet = "document.getElementById('nav-fleet')?.getAttribute('aria-current') === 'page'";
  const logs = "Boolean(document.getElementById('logs-view-container'))";
  const publicLogin = "document.getElementById('btn-login')?.disabled === false";
  const deniedView = "Boolean(document.querySelector('#nav-logs, #logs-view-container')) || document.body.innerText.includes('Accesso Riservato')";
  const logRoutes = ["/api/logs/access", "/api/logs/transfers", "/api/logs/download/access", "/api/logs/download/transfers"];
  const requestLogRoutes = `Promise.all(${JSON.stringify(logRoutes)}.map(async (url) => {
    const response = await fetch(url);
    return [response.status, response.headers.get('Content-Disposition')];
  }))`;

  const click = (id: string) => evaluateInBrowser(`document.getElementById(${JSON.stringify(id)}).click()`);
  const loginAs = async (username: string): Promise<void> => {
    await evaluateInBrowser(`{
      document.getElementById('username').value = ${JSON.stringify(username)};
      document.getElementById('password').value = 'AdminPassword123!';
      document.getElementById('btn-login').click();
    }`);
    await waitForBrowser(`document.getElementById('current-username')?.textContent === ${JSON.stringify(username)}`);
  };
  const refresh = async (ready: string): Promise<void> => {
    const previousTimeOrigin = await evaluateInBrowser<number>("performance.timeOrigin");
    await sendCdpCommand("Page.reload");
    await waitForBrowser(`performance.timeOrigin !== ${previousTimeOrigin} && (${ready})`);
  };

  await click("nav-logs");
  await waitForBrowser(logs);
  await evaluateInBrowser("history.replaceState({ logsHistoryFixture: true }, '')");
  await click("nav-fleet");
  await waitForBrowser(fleet);
  await click("nav-logs");
  await waitForBrowser(logs);
  await click("btn-logout");
  await waitForBrowser(publicLogin);
  await waitForBrowser("fetch('/api/auth/me').then(response => response.status === 401)");
  assert.deepEqual(await evaluateInBrowser(requestLogRoutes), logRoutes.map(() => [401, null]));

  await evaluateInBrowser(`{
    window.sawRestrictedLogs = false;
    new MutationObserver(() => {
      if (${deniedView}) window.sawRestrictedLogs = true;
    }).observe(document.body, { childList: true, subtree: true });
  }`);
  const requestsBeforeOperator = networkRequestsMade.length;
  await loginAs("navbar_operator");
  assert.equal(await evaluateInBrowser(deniedView), false, "L'operatore eredita la vista Logs dall'admin appena disconnesso");
  await waitForBrowser(`(${fleet}) && !location.hash`);

  await evaluateInBrowser("history.go(-2)");
  await waitForBrowser(`history.state?.logsHistoryFixture === true && (${fleet}) && !location.hash`);
  await evaluateInBrowser("history.forward()");
  await waitForBrowser(`!history.state?.logsHistoryFixture && (${fleet}) && !location.hash`);
  assert.equal(await evaluateInBrowser("window.sawRestrictedLogs"), false);

  await sendCdpCommand("Page.navigate", { url: `${serverBaseUrl}/index.html#logs` });
  const operatorFleet = `location.pathname === '/index.html' && !location.hash && (${fleet})`;
  await waitForBrowser(operatorFleet);
  assert.equal(await evaluateInBrowser(deniedView), false);
  await refresh(operatorFleet);
  assert.equal(await evaluateInBrowser(deniedView), false);
  assert.equal(networkRequestsMade.slice(requestsBeforeOperator).some((url) => new URL(url).pathname.startsWith("/api/logs/")), false);
  assert.deepEqual(await evaluateInBrowser(requestLogRoutes), logRoutes.map(() => [403, null]));

  await click("btn-logout");
  await waitForBrowser(publicLogin);
  await sendCdpCommand("Page.navigate", { url: `${serverBaseUrl}/#logs` });
  await waitForBrowser(`location.hash === '#logs' && (${publicLogin})`);
  await loginAs("navbar_operator");
  await waitForBrowser(`(${fleet}) && !location.hash`);
  assert.equal(await evaluateInBrowser(deniedView), false);

  await click("btn-logout");
  await waitForBrowser(publicLogin);
  await sendCdpCommand("Page.navigate", { url: `${serverBaseUrl}/#logs` });
  await waitForBrowser(`location.hash === '#logs' && (${publicLogin})`);
  await loginAs("admin");
  await waitForBrowser(logs);
  assert.deepEqual(await evaluateInBrowser(requestLogRoutes), [
    [200, null], [200, null],
    [200, 'attachment; filename="access.log"'], [200, 'attachment; filename="transfers.log"'],
  ]);
  await refresh(`location.hash === '#logs' && ${logs}`);
  await click("nav-fleet");
  await waitForBrowser(fleet);
  await evaluateInBrowser("history.back()");
  await waitForBrowser(`location.hash === '#logs' && ${logs}`);
  await evaluateInBrowser("history.forward()");
  await waitForBrowser(`(${fleet}) && !location.hash`);
  assert.deepEqual(duplicateLogReplies, [], "Le richieste Logs devono generare una sola risposta");
  console.log("  PASS: Navigazione Logs in Chrome con cambio account, URL, cronologia, refresh e controlli HTTP per entrambi i ruoli.");
}

async function testResponsiveNavigationAndRegistrationFocus(): Promise<void> {
  try {
    for (const width of [320, 360, 390, 414, 768, 1024, 1920]) {
      await sendCdpCommand("Emulation.setDeviceMetricsOverride", {
        width, height: 900, deviceScaleFactor: 1, mobile: false,
      });
      const bounds = await evaluateInBrowser<{ viewport: number; scrollWidth: number; right: number; hit: boolean }>(
        `(() => {
          const button = document.querySelector('#btn-logout');
          const rect = button.getBoundingClientRect();
          return { viewport: innerWidth, scrollWidth: document.documentElement.scrollWidth, right: rect.right,
            hit: button.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)) };
        })()`
      );
      assert.equal(bounds.viewport, width);
      assert.ok(bounds.right <= width && bounds.hit, `Disconnetti interamente cliccabile a ${width}px`);
      assert.equal(bounds.scrollWidth, width, `Pagina senza overflow orizzontale a ${width}px`);
      console.log(`RESPONSIVE ${width} PASS`);
    }
  } finally {
    await sendCdpCommand("Emulation.clearDeviceMetricsOverride");
  }
  const key = async (name: string, code: number, modifiers = 0) => {
    await sendCdpCommand("Input.dispatchKeyEvent", { type: "keyDown", key: name, windowsVirtualKeyCode: code, modifiers });
    await sendCdpCommand("Input.dispatchKeyEvent", { type: "keyUp", key: name, windowsVirtualKeyCode: code, modifiers });
  };
  await evaluateInBrowser("document.querySelector('#btn-register-robot').focus(); document.querySelector('#btn-register-robot').click()");
  await waitForBrowser("document.activeElement?.id === 'reg-displayName'");
  const focusId = () => evaluateInBrowser<string>("document.activeElement?.id");
  await evaluateInBrowser("document.querySelector('#btn-submit-register').focus()");
  await key("Tab", 9, 8);
  const last = await focusId();
  assert.notEqual(last, "btn-submit-register");
  assert.ok(await evaluateInBrowser("document.querySelector('#modal-robot-register').contains(document.activeElement)"));
  await key("Tab", 9);
  assert.equal(await focusId(), "btn-submit-register");
  await key("Escape", 27);
  await waitForBrowser("!document.querySelector('#modal-robot-register')");
  assert.equal(await focusId(), "btn-register-robot");
  console.log("  PASS: Focus iniziale, Tab, Shift+Tab, Escape e ripristino del focus.");

  // Verifica allineamento UI e accessibilità di RobotEditModal con RobotRegisterModal
  const openedEditModal = await evaluateInBrowser<boolean>(`(() => {
    const toggle = document.querySelector('#fleet-table-body .dropdown-toggle, tbody .dropdown-toggle');
    if (!toggle) return false;
    toggle.click();
    return true;
  })()`);
  assert.ok(openedEditModal, "Il menu azioni di un robot deve essere presente per aprire RobotEditModal");
  await waitForBrowser("Array.from(document.querySelectorAll('.dropdown-item')).some(b => b.textContent?.trim() === 'Configura')");
  await evaluateInBrowser(`(() => {
    const btn = Array.from(document.querySelectorAll('.dropdown-item')).find(b => b.textContent?.trim() === 'Configura');
    btn?.click();
  })()`);
  await waitForBrowser("Boolean(document.querySelector('#modal-robot-edit'))");
  await waitForBrowser("document.activeElement?.id === 'edit-displayName'");

  const editModalCheck = await evaluateInBrowser<{
    hasRegisterHeader: boolean;
    title: string | null;
    ariaLabelledBy: string | null;
    submitInHeader: boolean;
    submitFormAttr: string | null;
    submitText: string | null;
    closeInHeader: boolean;
    closeAriaLabel: string | null;
    hasFooter: boolean;
    hasDeleteSection: boolean;
  }>(`(() => {
    const modal = document.querySelector('#modal-robot-edit');
    const header = modal?.querySelector('.modal-header.modal-register-header');
    const actions = header?.querySelector('.modal-register-actions');
    const submitBtn = actions?.querySelector('#btn-submit-edit');
    const closeBtn = actions?.querySelector('#btn-close-edit');
    return {
      hasRegisterHeader: Boolean(header),
      title: header?.querySelector('#edit-robot-title')?.textContent?.trim() ?? null,
      ariaLabelledBy: modal?.getAttribute('aria-labelledby') ?? null,
      submitInHeader: Boolean(submitBtn),
      submitFormAttr: submitBtn?.getAttribute('form') ?? null,
      submitText: submitBtn?.textContent?.trim() ?? null,
      closeInHeader: Boolean(closeBtn),
      closeAriaLabel: closeBtn?.getAttribute('aria-label') ?? null,
      hasFooter: Boolean(modal?.querySelector('.modal-footer')),
      hasDeleteSection: Boolean(modal?.querySelector('#section-delete-server-data')),
    };
  })()`);

  assert.strictEqual(editModalCheck.hasRegisterHeader, true, "RobotEditModal deve usare .modal-header.modal-register-header");
  assert.strictEqual(editModalCheck.title, "Modifica Configurazione Robot");
  assert.strictEqual(editModalCheck.ariaLabelledBy, "edit-robot-title");
  assert.strictEqual(editModalCheck.submitInHeader, true, "Il pulsante Salva Modifiche deve trovarsi nell'header");
  assert.strictEqual(editModalCheck.submitFormAttr, "form-edit-robot");
  assert.strictEqual(editModalCheck.submitText, "Salva Modifiche");
  assert.strictEqual(editModalCheck.closeInHeader, true, "Il pulsante chiudi × deve trovarsi nell'header");
  assert.strictEqual(editModalCheck.closeAriaLabel, "Annulla");
  assert.strictEqual(editModalCheck.hasFooter, false, "RobotEditModal non deve più avere .modal-footer");
  assert.strictEqual(editModalCheck.hasDeleteSection, true, "La sezione rossa Eliminazione Dati Server deve restare intatta nel body");

  // Verifica focus trap Tab / Shift+Tab e chiusura con Escape in RobotEditModal
  await evaluateInBrowser("document.querySelector('#btn-submit-edit').focus()");
  await key("Tab", 9, 8);
  assert.ok(await evaluateInBrowser("document.querySelector('#modal-robot-edit').contains(document.activeElement)"));
  await key("Tab", 9);
  assert.equal(await focusId(), "btn-submit-edit");
  await key("Escape", 27);
  await waitForBrowser("!document.querySelector('#modal-robot-edit')");
  console.log("  PASS: RobotEditModal allineato a RobotRegisterModal (header, pulsanti, assenza footer, sezione delete, focus trap ed Escape).");
}

async function testLogoutCycles(): Promise<void> {
  const pageTimeOrigin = await evaluateInBrowser<number>("performance.timeOrigin");
  const initialBrowserErrors = browserJavaScriptErrors.length;
  const countLogoutRequests = () => networkRequestsWithMethod.filter(
    ({ method, url }) => method === "POST" && url.endsWith("/api/auth/logout")
  ).length;
  for (let cycle = 1; cycle <= 20; cycle++) {
    if (cycle > 1) await loginAgain();
    if (cycle === 2) {
      await evaluateInBrowser("document.getElementById('btn-register-robot').click()");
      await waitForBrowser("Boolean(document.getElementById('modal-robot-register'))");
    }
    if (cycle === 3) {
      // Intento già condiviso, prima che la scheda riceva l'evento storage.
      await evaluateInBrowser("localStorage.setItem('moliris_pending_logout', 'sessione')");
    }
    if (cycle === 4 || cycle === 5) {
      await evaluateInBrowser("window._molirisSimulateInactivity(28)");
      await waitForBrowser("Boolean(document.getElementById('modal-idle-warning'))");
    }
    if (cycle === 6) {
      await evaluateInBrowser("document.getElementById('btn-server-terminal').click()");
      await waitForBrowser("document.getElementById('terminal-session-status')?.textContent === 'Connesso'");
    }
    const expectedTarget = cycle === 5 ? "btn-idle-logout" : "btn-logout";
    const beforeHeartbeat = networkRequestsWithMethod.filter(
      ({ url }) => url.endsWith("/api/auth/heartbeat")
    ).length;
    const beforeLogout = countLogoutRequests();
    const { x, y, hit } = await evaluateInBrowser<{ x: number; y: number; hit: string }>(`(() => {
      const button = document.getElementById('${expectedTarget}');
      const bounds = button.getBoundingClientRect();
      const x = bounds.x + bounds.width / 2;
      const y = bounds.y + bounds.height / 2;
      performance.clearResourceTimings();
      let start = performance.now();
      const startMeasure = () => { start = performance.now(); };
      window.addEventListener('pointerdown', startMeasure, { capture: true, once: true });
      window.molirisLogoutMeasure = new Promise((resolve) => {
        let feedbackMs;
        const observer = new MutationObserver(() => {
          if (!document.querySelector('#login-section') || document.querySelector('#current-username')) return;
          feedbackMs ??= performance.now() - start;
          if (document.querySelector('#btn-login:not(:disabled)') && !document.querySelector('#logout-status')) {
            clearTimeout(timer);
            observer.disconnect();
            resolve({ feedbackMs, confirmedMs: performance.now() - start });
          }
        });
        const timer = setTimeout(() => {
          observer.disconnect();
          window.removeEventListener('pointerdown', startMeasure, true);
          resolve(null);
        }, 4000);
        observer.observe(document.body, { childList: true, subtree: true, attributes: true });
      });
      const target = document.elementFromPoint(x, y);
      return { x, y, hit: target?.id || target?.className || target?.tagName || 'none' };
    })()`);
    const click = (type: string, clickCount: number) =>
      sendCdpCommand("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount });
    const inputs = [click("mousePressed", 1), click("mouseReleased", 1)];
    if (cycle >= 6 && cycle % 2 === 0) inputs.push(click("mousePressed", 2), click("mouseReleased", 2));
    await Promise.all(inputs);
    const measurement = await evaluateInBrowser<{ feedbackMs: number; confirmedMs: number } | null>(
      "window.molirisLogoutMeasure"
    );
    assert.ok(measurement, `Ciclo ${cycle}: nessuna conferma dopo il clic Chrome, elemento colpito: ${hit}`);
    assert.equal(hit, expectedTarget, `Ciclo ${cycle}: il clic deve raggiungere il pulsante di uscita`);
    const { feedbackMs, confirmedMs } = measurement;
    const apiMs = await evaluateInBrowser<number>(
      "performance.getEntriesByType('resource').filter(entry=>entry.name.endsWith('/api/auth/logout')).at(-1)?.duration ?? -1"
    );
    assert.ok(apiMs >= 0, "Durata della richiesta API logout disponibile");
    console.log(`LOGOUT_CYCLE ${cycle} ${feedbackMs.toFixed(1)} ${confirmedMs.toFixed(1)} ${apiMs.toFixed(1)}`);
    assert.ok(feedbackMs < 100, `Ciclo ${cycle}: feedback entro 100 ms`);
    assert.ok(confirmedMs < 1_000, `Ciclo ${cycle}: conferma entro 1 secondo`);
    assert.equal(countLogoutRequests() - beforeLogout, 1, `Ciclo ${cycle}: un solo POST`);
    assert.equal(networkRequestsWithMethod.filter(
      ({ url }) => url.endsWith("/api/auth/heartbeat")
    ).length, beforeHeartbeat, `Ciclo ${cycle}: uscire non deve confermare l'inattività`);
    assert.equal(sessionManager.getActiveSessionsCount("user_admin"), 0, `Ciclo ${cycle}: sessione revocata`);
    const { cookies } = await sendCdpCommand("Network.getCookies", { urls: [serverBaseUrl] });
    assert.ok(!cookies.some(({ name }: { name: string }) => name === "__Host-moliris_session"),
      `Ciclo ${cycle}: cookie di sessione rimosso`);
    assert.equal(await evaluateInBrowser<number>(
      "fetch('/api/auth/me', {cache:'no-store', signal:AbortSignal.timeout(2000)}).then(response => response.status)"
    ), 401, `Ciclo ${cycle}: sessione precedente inutilizzabile`);
  }
  assert.deepEqual(browserJavaScriptErrors.slice(initialBrowserErrors), [], "Nessun errore JavaScript durante il logout");
  assert.equal(await evaluateInBrowser<number>("performance.timeOrigin"), pageTimeOrigin, "Nessun reload tra i cicli");
  console.log("  PASS: 20 cicli consecutivi di login/logout nello stesso documento Chrome.");
}

async function testStalledLogout(): Promise<void> {
  holdNextTransferPoll = true;
  try {
    await loginAgain();
    const pollDeadline = performance.now() + 2_000;
    while (holdNextTransferPoll && performance.now() < pollDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(holdNextTransferPoll, false, "La dashboard deve avere un polling in corso al logout");
    holdNextLogoutResponse = true;
    const start = performance.now();
    await evaluateInBrowser<void>("document.getElementById('btn-logout').click()");
    await waitForBrowser("Boolean(document.querySelector('#login-section'))");
    await waitForBrowser("Boolean(document.querySelector('#btn-retry-logout'))", 7_000);
    console.log(`LOGOUT_STALL_RETRY_MS ${(performance.now() - start).toFixed(1)}`);
    assert.equal(holdNextLogoutResponse, false, "Il POST sospeso deve aver raggiunto il server");
    assert.equal(transferPollAborted, true, "Il logout deve chiudere il polling della sessione precedente");
    assert.equal(sessionManager.getActiveSessionsCount("user_admin"), 0, "Revoca avvenuta a risposta sospesa");
    assert.equal(await evaluateInBrowser("document.querySelector('#btn-login').disabled"), true);
    await evaluateInBrowser<void>("document.getElementById('btn-retry-logout').click()");
    await waitForBrowser("Boolean(document.querySelector('#btn-login:not(:disabled)'))");
    // La risposta vecchia viene rilasciata dopo che il cookie nuovo è in uso.
    await loginAgain();
    releaseLogoutResponse?.();
    assert.equal(await evaluateInBrowser<number>(
      "fetch('/api/auth/me', {cache:'no-store', signal:AbortSignal.timeout(2000)}).then(response => response.status)"
    ), 200);
    console.log("  PASS: Risposta logout sospesa, retry e protezione del cookie della nuova sessione.");
  } finally {
    releaseLogoutResponse?.();
    releaseTransferPoll?.();
  }
}

try {
  console.log(`  -> Navigazione su ${serverBaseUrl}...`);
  const navigation = await sendCdpCommand("Page.navigate", { url: serverBaseUrl });
  assert.strictEqual(navigation.errorText, "net::ERR_CERT_AUTHORITY_INVALID");
  // Accetta l'avviso solo per la fixture TLS locale generata da questo test.
  await waitForBrowser("location.protocol === 'chrome-error:' && Boolean(document.querySelector('#proceed-link'))");
  await evaluateInBrowser("document.querySelector('#details-button').click(); document.querySelector('#proceed-link').click()");

  // Attesa montaggio React e Login Section con retry resiliente
  let isLoginVisible = false;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 150));
    isLoginVisible = await evaluateInBrowser<boolean>(
      "Boolean(document.getElementById('login-section'))"
    );
    if (isLoginVisible) break;
  }
  assert.strictEqual(isLoginVisible, true, "La schermata di login React deve essere montata e visibile");

  // Tentativo di login con credenziali errate (CA-AUTH-002)
  console.log("  -> Test CA-AUTH-002: Login con credenziali non valide su React");
  await evaluateInBrowser<void>(`{
    const userInp = document.getElementById('username');
    const pwdInp = document.getElementById('password');
    userInp.value = 'wrong_admin';
    pwdInp.value = 'WrongPassword!';
    document.getElementById('btn-login').click();
  }`);
  let loginErr = "";
  for (let i = 0; i < 15; i++) {
    await new Promise((r) => setTimeout(r, 100));
    loginErr = await evaluateInBrowser<string>("document.getElementById('login-error')?.textContent || ''");
    if (loginErr.includes("non valide")) break;
  }
  assert.ok(loginErr.includes("non valide"), "Deve mostrare messaggio di errore credenziali non valide");

  // Un account già autenticato deve mostrare il dialogo dedicato e azzerare il form alla chiusura.
  await evaluateInBrowser<void>(`{
    document.getElementById('username').value = 'blocked_session';
    document.getElementById('password').value = 'BlockedSession123!';
    document.getElementById('btn-login').click();
  }`);
  let blockedModalVisible = false;
  for (let i = 0; i < 15; i++) {
    await new Promise((r) => setTimeout(r, 100));
    blockedModalVisible = await evaluateInBrowser<boolean>(
      "Boolean(document.getElementById('modal-session-conflict'))"
    );
    if (blockedModalVisible) break;
  }
  assert.strictEqual(blockedModalVisible, true, "Il conflitto sessione deve aprire una modale dedicata");
  const blockedDialog = await evaluateInBrowser<{ title: string; message: string; role: string }>(`{
    const dialog = document.getElementById('modal-session-conflict');
    ({
      title: dialog?.querySelector('.modal-header h3')?.textContent || '',
      message: dialog?.querySelector('.modal-body')?.textContent || '',
      role: dialog?.getAttribute('role') || '',
    })
  }`);
  assert.strictEqual(blockedDialog.title, "Accesso non consentito");
  assert.ok(blockedDialog.message.includes(
    "È già presente una sessione attiva per questo account su un altro dispositivo o finestra del browser. Disconnetti l'altra sessione prima di accedere."
  ));
  assert.strictEqual(blockedDialog.role, "alertdialog");
  assert.strictEqual(
    await evaluateInBrowser<string>("document.getElementById('login-error')?.textContent || ''"),
    "",
    "Il conflitto sessione non deve mostrare il messaggio generico di errore login"
  );
  await evaluateInBrowser<void>("document.getElementById('btn-close-session-conflict').click()");
  const resetLoginForm = await evaluateInBrowser<{ modalClosed: boolean; username: string; password: string }>(`({
    modalClosed: !Boolean(document.getElementById('modal-session-conflict')),
    username: document.getElementById('username').value,
    password: document.getElementById('password').value,
  })`);
  assert.deepStrictEqual(resetLoginForm, { modalClosed: true, username: "", password: "" });

  if (sessionConflictOnly) {
    console.log("  PASS: Session-conflict modal, generic-error suppression, and form reset verified.");
    throw sessionConflictOnlyComplete;
  }

  if (!logoutOnly && !logoutCyclesOnly) {
    await userRepo.create({
      ...blockedUser,
      id: "user_navbar_operator",
      username: "navbar_operator",
      passwordHash: adminHash,
    });
    await evaluateInBrowser<void>(`{
      document.getElementById('username').value = 'navbar_operator';
      document.getElementById('password').value = 'AdminPassword123!';
      document.getElementById('btn-login').click();
    }`);
    await waitForBrowser("document.getElementById('current-username')?.textContent === 'navbar_operator'");
    await testNavbarRole("operatore", "operatore");
    await evaluateInBrowser("document.getElementById('btn-logout').click()");
    await waitForBrowser("document.getElementById('btn-login')?.disabled === false");
  }

  // Login con credenziali admin (CA-AUTH-001)
  console.log("  -> Test CA-AUTH-001: Login riuscito come amministratore su React");
  await evaluateInBrowser<void>(`{
    const userInp = document.getElementById('username');
    const pwdInp = document.getElementById('password');
    userInp.value = 'admin';
    pwdInp.value = 'AdminPassword123!';
    document.getElementById('btn-login').click();
  }`);
  // Verifica visualizzazione Dashboard Flotta
  let isDashboardVisible = false;
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 100));
    isDashboardVisible = await evaluateInBrowser<boolean>("Boolean(document.getElementById('dashboard-section'))");
    if (isDashboardVisible) break;
  }
  if (!isDashboardVisible) {
    const errText = await evaluateInBrowser<string>("document.getElementById('login-error')?.textContent || ''");
    console.log("LOGIN ERROR TEXT:", errText);
  }
  assert.strictEqual(isDashboardVisible, true, "La dashboard flotta React deve essere visibile dopo il login");

  const usernameText = await evaluateInBrowser<string>(
    "document.getElementById('current-username').textContent"
  );
  assert.strictEqual(usernameText, "admin", "L'username visualizzato deve essere admin");

  if (logoutCyclesOnly) {
    await testResponsiveNavigationAndRegistrationFocus();
    await testLogoutCycles();
    await testStalledLogout();
    await testLogout();
    throw logoutCyclesOnlyComplete;
  }
  if (logoutOnly) {
    await testLogout();
    throw logoutOnlyComplete;
  }
  await testRestrictedLogsNavigation();
  await testNavbarRole("admin", "amministratore");

  // Attesa popolamento flotta
  await new Promise((r) => setTimeout(r, 600));

  const hasAlphaRobot = await evaluateInBrowser<boolean>(`
    document.getElementById('fleet-table-body').textContent.includes('Robot React Alpha')
  `);
  assert.strictEqual(hasAlphaRobot, true, "La tabella deve mostrare 'Robot React Alpha'");

  // Test Navigazione viste React (CA-FS-001..004)
  console.log("  -> Test Navigazione viste React: Filesystem Server, Remoto e Flotta");
  await evaluateInBrowser<void>(`
    document.querySelector('button[data-view="server"]').click();
  `);
  await new Promise((r) => setTimeout(r, 200));
  const isServerPanelMounted = await evaluateInBrowser<boolean>(
    "Boolean(document.getElementById('fs-panel-server'))"
  );
  assert.strictEqual(isServerPanelMounted, true, "Il pannello filesystem server deve essere montato");

  // Test Filesystem: Rimozione barra 'Robot Selezionato' e integrazione RobotCombobox
  console.log("  -> Test Filesystem: Rimozione barra 'Robot Selezionato' e integrazione RobotCombobox");
  const hasTopSelectorBar = await evaluateInBrowser<boolean>(
    "Boolean(document.querySelector('.fs-top-selector-bar'))"
  );
  assert.strictEqual(hasTopSelectorBar, false, "La barra superiore 'fs-top-selector-bar' deve essere stata rimossa");

  // Verifica Combobox Robot
  const comboboxInfo = await evaluateInBrowser<{ hasInput: boolean; role: string; hasPopupList: boolean }>(`{
    const inp = document.getElementById('fs-robot-id');
    ({
      hasInput: Boolean(inp),
      role: inp ? inp.getAttribute('role') || '' : '',
      hasPopupList: Boolean(document.getElementById('fs-robot-id-popup-list')),
    })
  }`);
  assert.strictEqual(comboboxInfo.hasInput, true, "L'input #fs-robot-id deve essere presente");
  assert.strictEqual(comboboxInfo.role, "combobox", "L'input #fs-robot-id deve avere role='combobox'");

  // Focus sul combobox per aprire la tendina
  await evaluateInBrowser<void>(`
    const inp = document.getElementById('fs-robot-id');
    inp.focus();
    inp.click();
  `);
  await new Promise((r) => setTimeout(r, 100));
  const isPopupOpen = await evaluateInBrowser<boolean>(
    "Boolean(document.getElementById('fs-robot-id-popup-list'))"
  );
  assert.strictEqual(isPopupOpen, true, "Il click sul combobox deve aprire la tendina con i robot");

  // Selezione del robot dal combobox
  await evaluateInBrowser<void>(`
    const opt = document.querySelector('#fs-robot-id-popup-list [role="option"]');
    if (opt) opt.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  `);
  await new Promise((r) => setTimeout(r, 100));
  const selectedValue = await evaluateInBrowser<string>(
    "document.getElementById('fs-robot-id').value"
  );
  assert.strictEqual(selectedValue, "robot_react_01", "La selezione dal combobox deve impostare l'ID esatto del robot");
  console.log("  PASS: Rimozione fs-top-selector-bar e funzionamento RobotCombobox verificati.");

  // Test Archivio Generale aggregato e drill-down verso il robot (AC1, AC3, AC4, AC5, AC6)
  console.log("  -> Test Archivio Generale aggregato, indicatore tab e drill-down robot");
  // Azzera l'ID robot impostato dal test precedente per verificare il set automatico nel drill-down.
  await evaluateInBrowser<void>(`
    const input = document.getElementById('fs-robot-id');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, '');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  `);
  await new Promise((r) => setTimeout(r, 100));
  const clearedRobotId = await evaluateInBrowser<string>(
    "document.getElementById('fs-robot-id').value"
  );
  assert.strictEqual(clearedRobotId, "", "L'ID robot deve essere azzerato prima del drill-down");

  await evaluateInBrowser<void>(`
    document.querySelector('button[data-view="general"]').click();
  `);
  await new Promise((r) => setTimeout(r, 500));

  const generalInfo = await evaluateInBrowser<{
    hasIndicator: boolean;
    generalSelected: string;
    hasRobotRow: boolean;
    label: string;
    serverTabLabel: string;
  }>(`{
    const robotRow = document.querySelector('#fs-general-table-body .fs-row-robot');
    const serverTab = document.getElementById('btn-tab-fs-server');
    ({
      hasIndicator: Boolean(document.querySelector('.fs-tab-indicator')),
      generalSelected: document.getElementById('btn-tab-general').getAttribute('aria-selected') || '',
      hasRobotRow: Boolean(robotRow),
      label: robotRow ? robotRow.textContent || '' : '',
      serverTabLabel: serverTab ? serverTab.textContent || '' : '',
    })
  }`);

  assert.strictEqual(generalInfo.hasIndicator, true, "La barra tab deve avere l'indicatore animato");
  assert.strictEqual(generalInfo.generalSelected, "true", "Il tab Archivio Generale deve risultare selezionato");
  assert.strictEqual(generalInfo.hasRobotRow, true, "La root aggregata deve mostrare la directory del robot registrato");
  assert.ok(generalInfo.label.includes("Robot React Alpha"), "La riga robot deve mostrare il display name");
  assert.ok(
    generalInfo.serverTabLabel.includes("File sul Server (Robot)"),
    "Il primo tab deve essere rinominato 'File sul Server (Robot)'"
  );

  // AC2: l'esploratore usa icone SVG, badge/toolbar e definisce hover state coerenti.
  const explorerStyleInfo = await evaluateInBrowser<{
    hasIconSvg: boolean;
    hasChip: boolean;
    hasActionButton: boolean;
    tabIconCount: number;
    hasHoverRule: boolean;
  }>(`{
    const row = document.querySelector('#fs-general-table-body .fs-row-robot');
    const selectors = [];
    const collect = (sheet) => {
      let rules;
      try {
        rules = sheet.cssRules;
      } catch (error) {
        return;
      }
      for (const rule of Array.from(rules)) {
        const selector = rule.selectorText;
        if (selector) selectors.push(selector);
        const nested = rule.cssRules;
        if (nested) {
          for (const child of Array.from(nested)) {
            const childSelector = child.selectorText;
            if (childSelector) selectors.push(childSelector);
          }
        }
      }
    };
    for (const sheet of Array.from(document.styleSheets)) collect(sheet);
    ({
      hasIconSvg: Boolean(row && row.querySelector('.fs-entry-icon svg')),
      hasChip: Boolean(row && row.querySelector('.fs-chip')),
      hasActionButton: Boolean(row && row.querySelector('.fs-action')),
      tabIconCount: document.querySelectorAll('.fs-tab-btn svg').length,
      hasHoverRule: selectors.some(
        (selector) => selector.includes('.fs-row:hover') || selector.includes('.fs-entry-button:hover')
      ),
    })
  }`);

  assert.strictEqual(explorerStyleInfo.hasIconSvg, true, "Le righe dell'esploratore devono usare icone SVG");
  assert.strictEqual(explorerStyleInfo.hasChip, true, "Le righe dell'esploratore devono mostrare badge (chip)");
  assert.strictEqual(explorerStyleInfo.hasActionButton, true, "Le righe dell'esploratore devono esporre azioni in toolbar");
  assert.strictEqual(explorerStyleInfo.tabIconCount, 4, "Ogni tab deve avere la propria icona SVG");
  assert.strictEqual(explorerStyleInfo.hasHoverRule, true, "Il CSS deve definire hover state per righe ed entry");

  // Apertura del robot dall'Archivio Generale: cambio tab + ID + caricamento automatico
  await evaluateInBrowser<void>(`
    const button = document.querySelector('#fs-general-table-body .fs-row-robot .fs-entry-button');
    if (button) button.click();
  `);
  await new Promise((r) => setTimeout(r, 700));

  const drillDownInfo = await evaluateInBrowser<{
    serverSelected: string;
    robotId: string;
    bodyText: string;
    currentPath: string;
  }>(`({
    serverSelected: document.getElementById('btn-tab-fs-server').getAttribute('aria-selected') || '',
    robotId: document.getElementById('fs-robot-id').value,
    bodyText: (document.getElementById('fs-table-body').textContent || ''),
    currentPath: (document.getElementById('fs-current-path') || {}).textContent || '',
  })`);

  assert.strictEqual(drillDownInfo.serverSelected, "true", "Aprire un robot deve selezionare il tab File sul Server (Robot)");
  assert.strictEqual(drillDownInfo.robotId, "robot_react_01", "L'ID robot deve essere impostato automaticamente");
  assert.ok(drillDownInfo.bodyText.includes("upload"), "La directory del robot deve essere caricata senza click aggiuntivi");

  // Torna su dalla root del robot: deve riportare all'Archivio Generale con la lista pronta
  await evaluateInBrowser<void>(`
    document.getElementById('btn-fs-up').click();
  `);
  await new Promise((r) => setTimeout(r, 500));

  const backInfo = await evaluateInBrowser<{ generalSelected: string; generalHasRobotRow: boolean }>(`({
    generalSelected: document.getElementById('btn-tab-general').getAttribute('aria-selected') || '',
    generalHasRobotRow: Boolean(document.querySelector('#fs-general-table-body .fs-row-robot')),
  })`);

  assert.strictEqual(backInfo.generalSelected, "true", "Torna su dalla root del robot deve aprire l'Archivio Generale");
  assert.strictEqual(backInfo.generalHasRobotRow, true, "L'Archivio Generale deve mostrare subito la lista aggregata");
  console.log("  PASS: Archivio Generale aggregato, indicatore tab e drill-down robot verificati.");

  // =======================================================================
  // Terminale PTY (Host Locale): regressioni su resize, newline, chiusura X
  // =======================================================================
  console.log("  -> Test Terminale Server: formato ridotto, espansione, storico, X e disconnessione");

  await evaluateInBrowser<void>(`
    document.querySelector('button[data-view="fleet"]').click();
  `);
  await new Promise((r) => setTimeout(r, 200));

  // Cattura l'ID sessione PTY dal POST di apertura per verificare poi la
  // chiusura formale lato backend.
  await evaluateInBrowser<void>(`{
    window.__termSessions = [];
    const origFetch = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const res = await origFetch(...args);
      try {
        const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
        const method = ((args[1] && args[1].method) || 'GET').toUpperCase();
        if (method === 'POST' && url.includes('/api/server/terminal/sessions')) {
          res.clone().json().then((d) => {
            if (d && d.sessionId) window.__termSessions.push(d.sessionId);
          }).catch(() => {});
          // Lascia alla shell il tempo di scrivere il prompt prima dell'aggancio WSS.
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      } catch (error) {}
      return res;
    };
  }`);

  await evaluateInBrowser<void>(`
    document.getElementById('btn-server-terminal').click();
  `);

  let terminalConnected = false;
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 100));
    terminalConnected = await evaluateInBrowser<boolean>(`
      Boolean(document.getElementById('modal-terminal')) &&
      (document.getElementById('terminal-session-status')?.textContent || '') === 'Connesso'
    `);
    if (terminalConnected) break;
  }
  assert.strictEqual(terminalConnected, true, "Il terminale server deve aprirsi e connettersi al PTY");
  await waitForBrowser(String.raw`
    Array.from(document.querySelectorAll('#terminal-container .xterm-rows > div'))
      .some((row) => /[$#]\s*$/.test(row.textContent || ''))
  `);
  console.log("  PASS: Prompt iniziale del terminale server visibile prima di qualsiasi input.");
  // Attende il primo fit (requestAnimationFrame + ResizeObserver) prima di
  // leggere le coordinate effettive del PTY.
  await new Promise((r) => setTimeout(r, 500));

  const initialTerminalLayout = await evaluateInBrowser<{
    expanded: boolean;
    width: number;
    height: number;
    viewportWidth: number;
    viewportHeight: number;
    fontSize: string;
    cols: number;
    rows: number;
    footerTop: number;
    footerBottom: number;
    bodyBottom: number;
    winBottom: number;
  }>(`{
    const win = document.querySelector('.modal-terminal-window');
    const body = document.getElementById('terminal-container');
    const footer = document.querySelector('.terminal-footer');
    const dims = (document.getElementById('terminal-footer-dims').textContent || '').split('x');
    const rect = win.getBoundingClientRect();
    ({
      expanded: win.classList.contains('terminal-expanded'),
      width: rect.width,
      height: rect.height,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      fontSize: getComputedStyle(document.querySelector('.xterm')).fontSize,
      cols: parseInt(dims[0], 10) || 0,
      rows: parseInt(dims[1], 10) || 0,
      footerTop: footer.getBoundingClientRect().top,
      footerBottom: footer.getBoundingClientRect().bottom,
      bodyBottom: body.getBoundingClientRect().bottom,
      winBottom: rect.bottom,
    })
  }`);

  assert.strictEqual(initialTerminalLayout.expanded, false, "Il terminale deve aprirsi SEMPRE in modalità ridotta");
  assert.ok(
    Math.abs(initialTerminalLayout.width - Math.min(1100, initialTerminalLayout.viewportWidth * 0.74)) <= 3 &&
      Math.abs(initialTerminalLayout.height - Math.min(540, initialTerminalLayout.viewportHeight * 0.79)) <= 3,
    "La finestra ridotta deve rispettare le proporzioni ampie del riferimento"
  );
  assert.strictEqual(initialTerminalLayout.fontSize, "12px", "Il testo del terminale deve usare un carattere ridotto da 12px");
  assert.ok(
    initialTerminalLayout.footerTop >= initialTerminalLayout.bodyBottom - 1,
    "La status bar deve essere sotto l'area del terminale, senza sovrapporsi alle ultime righe"
  );
  assert.ok(initialTerminalLayout.footerBottom <= initialTerminalLayout.winBottom + 1,
    "La status bar deve restare dentro la finestra del terminale");

  await evaluateInBrowser<void>(`
    document.getElementById('btn-terminal-expand').click();
  `);
  await new Promise((r) => setTimeout(r, 800));

  const expandedTerminalLayout = await evaluateInBrowser<{
    expanded: boolean;
    status: string;
    width: number;
    height: number;
    viewportWidth: number;
    viewportHeight: number;
    cols: number;
    rows: number;
    content: string;
    footerTop: number;
    footerBottom: number;
    bodyBottom: number;
  }>(`{
    const win = document.querySelector('.modal-terminal-window');
    const body = document.getElementById('terminal-container');
    const footer = document.querySelector('.terminal-footer');
    const dims = (document.getElementById('terminal-footer-dims').textContent || '').split('x');
    const rect = win.getBoundingClientRect();
    ({
      expanded: win.classList.contains('terminal-expanded'),
      status: document.getElementById('terminal-session-status').textContent || '',
      width: rect.width,
      height: rect.height,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      cols: parseInt(dims[0], 10) || 0,
      rows: parseInt(dims[1], 10) || 0,
      content: body.textContent || '',
      footerTop: footer.getBoundingClientRect().top,
      footerBottom: footer.getBoundingClientRect().bottom,
      bodyBottom: body.getBoundingClientRect().bottom,
    })
  }`);

  assert.strictEqual(expandedTerminalLayout.expanded, true, "Il pulsante Espandi deve massimizzare la finestra");
  assert.ok(
    expandedTerminalLayout.width >= expandedTerminalLayout.viewportWidth - 1 &&
      expandedTerminalLayout.height >= expandedTerminalLayout.viewportHeight - 1,
    "In modalità espansa la finestra deve coprire la viewport"
  );
  assert.strictEqual(
    expandedTerminalLayout.status,
    "Connesso",
    "L'espansione NON deve distruggere la sessione PTY (nessun 'Sessione non trovata')"
  );
  assert.ok(
    !expandedTerminalLayout.content.includes("Sessione terminale non trovata") &&
      !expandedTerminalLayout.content.includes("Sessione terminale terminata dal server"),
    "L'espansione non deve mostrare errori di sessione persa"
  );
  assert.ok(
    expandedTerminalLayout.cols > initialTerminalLayout.cols &&
      expandedTerminalLayout.rows > initialTerminalLayout.rows,
    "Dopo l'espansione il fit deve inviare nuove coordinate cols/rows al PTY"
  );
  assert.ok(
    expandedTerminalLayout.footerTop >= expandedTerminalLayout.bodyBottom - 1,
    "In modalità espansa la status bar non deve tagliare l'output del terminale"
  );
  assert.ok(
    expandedTerminalLayout.footerBottom <= expandedTerminalLayout.viewportHeight + 1,
    "In modalità espansa la status bar deve restare visibile nella viewport"
  );

  // Newline: il bridge PTY locale emette "\n"; xterm con convertEol deve
  // riportare il cursore a colonna 0 a ogni riga (nessun effetto staircase).
  await evaluateInBrowser<void>(`
    const textarea = document.querySelector('#terminal-container .xterm-helper-textarea');
    if (textarea) textarea.focus();
  `);
  await sendCdpCommand("Input.insertText", {
    text: "printf '%s_%s\\n%s_%s\\n%s_%s\\n' ALPHA LINE BETA LINE GAMMA LINE",
  });
  await sendCdpCommand("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
  });
  await sendCdpCommand("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
  });
  await new Promise((r) => setTimeout(r, 1200));

  const newlineRows = await evaluateInBrowser<{
    hasAlpha: boolean;
    hasBeta: boolean;
    hasGamma: boolean;
    hasPrompt: boolean;
    alphaLine: string;
    betaLine: string;
    gammaLine: string;
  }>(`{
    const rows = Array.from(document.querySelectorAll('#terminal-container .xterm-rows > div'))
      .map((row) => row.textContent || '');
    const alpha = rows.filter((row) => row.includes('ALPHA_LINE'));
    const beta = rows.filter((row) => row.includes('BETA_LINE'));
    const gamma = rows.filter((row) => row.includes('GAMMA_LINE'));
    ({
      hasAlpha: alpha.length > 0,
      hasBeta: beta.length > 0,
      hasGamma: gamma.length > 0,
      hasPrompt: rows.some((row) => row.includes('$') || row.includes('#')),
      alphaLine: alpha[0] || '',
      betaLine: beta[0] || '',
      gammaLine: gamma[0] || '',
    })
  }`);

  assert.strictEqual(newlineRows.hasAlpha && newlineRows.hasBeta && newlineRows.hasGamma, true,
    "Il comando di test deve produrre le tre righe ALPHA/BETA/GAMMA nel terminale");
  assert.strictEqual(newlineRows.hasPrompt, true, "Il terminale deve mostrare il prompt bash");
  for (const [marker, line] of [
    ["ALPHA_LINE", newlineRows.alphaLine],
    ["BETA_LINE", newlineRows.betaLine],
    ["GAMMA_LINE", newlineRows.gammaLine],
  ] as const) {
    assert.strictEqual(
      line,
      marker,
      `La riga '${marker}' deve iniziare a colonna 0 (niente staircase): "${line}"`
    );
  }

  await testTerminalClipboard();
  await sendCdpCommand("Input.insertText", { text: "printf 'PTY_%s\\n' READY; sleep 20" });
  await terminalKey("Enter", "Enter", 13, 0);
  await waitForBrowser("[...document.querySelectorAll('.xterm-rows > div')].some(row => row.textContent === 'PTY_READY')");
  await terminalKey("c", "KeyC", 67, 2);
  await sendCdpCommand("Input.insertText", { text: "printf 'PTY_%s\\n' RESUMED" });
  await terminalKey("Enter", "Enter", 13, 0);
  await waitForBrowser("[...document.querySelectorAll('.xterm-rows > div')].some(row => row.textContent === 'PTY_RESUMED')");
  console.log("  PASS: Clipboard Chrome sul Terminale Server e interruzione di un processo PTY con Ctrl+C.");

  // Ripristino dimensioni ridotte: la sessione deve restare viva.
  await evaluateInBrowser<void>(`
    document.getElementById('btn-terminal-expand').click();
  `);
  await new Promise((r) => setTimeout(r, 500));
  const restoredTerminal = await evaluateInBrowser<{ expanded: boolean; status: string; cols: number }>(`{
    const win = document.querySelector('.modal-terminal-window');
    const dims = (document.getElementById('terminal-footer-dims').textContent || '').split('x');
    ({
      expanded: win.classList.contains('terminal-expanded'),
      status: document.getElementById('terminal-session-status').textContent || '',
      cols: parseInt(dims[0], 10) || 0,
    })
  }`);
  assert.strictEqual(restoredTerminal.expanded, false, "Ripristina deve tornare alla finestra ridotta");
  assert.strictEqual(restoredTerminal.status, "Connesso", "Il ripristino non deve interrompere la sessione PTY");
  assert.ok(
    restoredTerminal.cols < expandedTerminalLayout.cols,
    "Il ripristino deve ricalcolare e reinviare le dimensioni ridotte"
  );

  const capturedSessions = await evaluateInBrowser<string[]>("window.__termSessions || []");
  assert.ok(capturedSessions.length >= 1 && capturedSessions[0], "Il test deve catturare l'ID della sessione PTY aperta");
  const ptySessionId = capturedSessions[0];

  const wrapperPid = terminalService.getSession(ptySessionId)?.localProcess?.pid;
  assert.ok(wrapperPid, "Il terminale deve avere un processo PTY locale");
  assert.equal(await evaluateInBrowser("document.querySelector('#btn-close-terminal').title"), "Nascondi terminale");
  assert.equal(await evaluateInBrowser("getComputedStyle(document.querySelector('#btn-close-terminal')).filter"), "invert(1)");

  const hiddenOutputFile = path.join(tmpDir, "terminal-hidden-output");
  const hiddenCommand = `sleep 2; printf '%s_%s' HIDDEN COMPLETE > '${hiddenOutputFile}'; printf '%s_%s\\n' HIDDEN COMPLETE`;
  await typeTerminalCommand(hiddenCommand);
  await evaluateInBrowser("document.getElementById('btn-close-terminal').click()");
  await waitForBrowser("!document.getElementById('modal-terminal')");
  assert.ok(!fs.existsSync(hiddenOutputFile), "Il comando deve essere ancora in corso quando si nasconde il terminale");
  await waitForCondition(() => fs.existsSync(hiddenOutputFile));
  assert.equal(fs.readFileSync(hiddenOutputFile, "utf8"), "HIDDEN_COMPLETE");
  assert.ok(terminalService.getSession(ptySessionId), "La X deve conservare la sessione sul backend");
  assert.equal(liveTerminalSockets.size, 1);
  assert.ok(!networkRequestsWithMethod.some(
    ({ method, url }) => method === "DELETE" && url.endsWith(`/api/terminal/sessions/${ptySessionId}`)
  ), "La X non deve emettere DELETE");

  await evaluateInBrowser("document.getElementById('btn-server-terminal').click()");
  await waitForTerminalOutput("HIDDEN_COMPLETE");
  assert.equal(await evaluateInBrowser("document.querySelector('#terminal-session-status').textContent"), "Connesso");
  assert.deepEqual(await evaluateInBrowser("window.__termSessions"), capturedSessions);
  assert.equal(liveTerminalSockets.size, 1);
  const scrollPoint = await evaluateInBrowser<{ x: number; y: number }>(`(() => {
    const { left, top, width, height } = document.querySelector('#terminal-container .xterm-screen').getBoundingClientRect();
    return { x: left + width / 2, y: top + height / 2 };
  })()`);
  // xterm maps each wheel event to a few rows, irrespective of a large delta.
  // Scroll the real viewport far enough to make the pre-hide output visible.
  for (let step = 0; step < 4; step++) {
    await sendCdpCommand("Input.dispatchMouseEvent", {
      type: "mouseWheel", ...scrollPoint, deltaX: 0, deltaY: -450,
    });
    await evaluateInBrowser("new Promise(resolve => requestAnimationFrame(() => resolve(true)))");
  }
  await waitForTerminalOutput("ALPHA_LINE");

  const jobPidFile = path.join(tmpDir, "terminal-job-pid");
  await typeTerminalCommand(`sleep 30 & printf '%s' "$!" > '${jobPidFile}'`);
  await waitForCondition(() => fs.existsSync(jobPidFile) && fs.statSync(jobPidFile).size > 0);
  const jobPid = Number(fs.readFileSync(jobPidFile, "utf8"));
  assert.ok(isLiveProcess(jobPid), "Il job deve essere vivo prima della disconnessione");

  await evaluateInBrowser("document.getElementById('btn-terminal-disconnect').click()");
  await waitForBrowser("Boolean(document.querySelector('#modal-confirm-terminal-disconnect'))");
  await evaluateInBrowser("document.querySelector('#modal-confirm-terminal-disconnect .btn-secondary').click()");
  await waitForBrowser("!document.querySelector('#modal-confirm-terminal-disconnect')");
  assert.equal(terminalService.getActiveSessionCount(), 1);
  await disconnectTerminalInBrowser();
  await waitForCondition(() => liveTerminalSockets.size === 0 && !isLiveProcess(wrapperPid) && !isLiveProcess(jobPid));
  assert.equal(terminalService.getActiveSessionCount(), 0);
  assert.ok(networkRequestsWithMethod.some(
    ({ method, url }) => method === "DELETE" && url.endsWith(`/api/terminal/sessions/${ptySessionId}`)
  ));
  await evaluateInBrowser(`{
    const button = document.getElementById('btn-server-terminal');
    button.click();
    button.click();
  }`);
  await waitForBrowser("document.querySelector('#terminal-session-status')?.textContent === 'Connesso'");
  assert.equal(await evaluateInBrowser("window.__termSessions.length"), capturedSessions.length + 1);
  const reopenedId = await evaluateInBrowser<string>("window.__termSessions.at(-1)");
  assert.notEqual(reopenedId, ptySessionId);
  assert.ok(terminalService.getSession(reopenedId));
  assert.equal(terminalService.getActiveSessionCount(), 1);
  await disconnectTerminalInBrowser();
  console.log("  PASS: Chrome conserva il PTY server, lo storico e il comando mentre è nascosto. Disconnetti rilascia WSS, PTY e job locale.");

  // Test Prompt Correttivo #2: Modale «Gestione File» alla selezione di «Invia al Robot»
  console.log("  -> Test Prompt Correttivo #2: Apertura e funzionamento modale Gestione File");
  await evaluateInBrowser<void>(`
    document.getElementById('btn-fs-load').click();
  `);
  await new Promise((r) => setTimeout(r, 400));

  // Verifica presenza della riga con sample_file.txt e pulsante «Invia al Robot»
  const hasSampleFile = await evaluateInBrowser<boolean>(`
    document.getElementById('fs-table-body')?.textContent?.includes('sample_file.txt') || false
  `);
  assert.strictEqual(hasSampleFile, true, "La tabella server deve contenere 'sample_file.txt'");

  // Clic su «Invia al Robot»
  await evaluateInBrowser<void>(`{
    const rows = Array.from(document.querySelectorAll('#fs-table-body tr'));
    for (const r of rows) {
      if (r.textContent.includes('sample_file.txt')) {
        const btn = Array.from(r.querySelectorAll('button')).find(b => b.textContent.includes('Invia al Robot'));
        if (btn) btn.click();
        break;
      }
    }
  }`);
  await new Promise((r) => setTimeout(r, 200));

  // Verifica apertura modale Gestione File
  const modalInfo = await evaluateInBrowser<{
    isOpen: boolean;
    title: string;
    sourceName: string;
    hasManualInput: boolean;
    inputVal: string;
    hasConfirmBtn: boolean;
    hasCancelBtn: boolean;
  }>(`{
    const m = document.getElementById('modal-file-management');
    ({
      isOpen: Boolean(m),
      title: document.getElementById('file-management-title')?.textContent || '',
      sourceName: document.getElementById('file-mgmt-source-name')?.textContent || '',
      hasManualInput: Boolean(document.getElementById('input-manual-path')),
      inputVal: (document.getElementById('input-manual-path'))?.value || '',
      hasConfirmBtn: Boolean(document.getElementById('btn-file-management-confirm')),
      hasCancelBtn: Boolean(document.getElementById('btn-file-management-cancel')),
    })
  }`);

  assert.strictEqual(modalInfo.isOpen, true, "La modale 'Gestione File' deve essere aperta");
  assert.ok(modalInfo.title.includes("Gestione File"), "Il titolo deve essere 'Gestione File'");
  assert.strictEqual(modalInfo.sourceName, "sample_file.txt", "Deve mostrare il nome del file selezionato");
  assert.strictEqual(modalInfo.hasManualInput, true, "Il campo percorso manuale deve essere presente");
  assert.strictEqual(modalInfo.inputVal, "/", "Il percorso iniziale deve essere '/'");
  assert.strictEqual(modalInfo.hasConfirmBtn, true, "Il pulsante Conferma deve essere presente");
  assert.strictEqual(modalInfo.hasCancelBtn, true, "Il pulsante Annulla deve essere presente");

  // Test validazione real-time inserimento manuale (percorso non assoluto)
  await evaluateInBrowser<void>(`{
    const inp = document.getElementById('input-manual-path');
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    if (nativeSetter) {
      nativeSetter.call(inp, 'cartella_relativa_non_valida');
    } else {
      inp.value = 'cartella_relativa_non_valida';
    }
    inp.dispatchEvent(new Event('input', { bubbles: true }));
  }`);
  await new Promise((r) => setTimeout(r, 200));

  const validationState = await evaluateInBrowser<{ hasClientErr: boolean; errText: string; isConfirmDisabled: boolean }>(`{
    const errEl = document.getElementById('feedback-client-error');
    const confirmBtn = document.getElementById('btn-file-management-confirm');
    ({
      hasClientErr: Boolean(errEl),
      errText: errEl?.textContent || '',
      isConfirmDisabled: Boolean(confirmBtn?.disabled),
    })
  }`);
  assert.strictEqual(validationState.hasClientErr, true, "Deve mostrare l'errore di validazione per percorso non assoluto");
  assert.ok(validationState.errText.includes("assoluto"), "Il messaggio deve indicare che il percorso deve essere assoluto");
  assert.strictEqual(validationState.isConfirmDisabled, true, "Il pulsante Conferma deve essere disabilitato con percorso non valido");

  // Chiusura tramite pulsante Annulla
  await evaluateInBrowser<void>(`
    document.getElementById('btn-file-management-cancel').click();
  `);
  await new Promise((r) => setTimeout(r, 100));

  const isModalClosed = await evaluateInBrowser<boolean>(
    "!Boolean(document.getElementById('modal-file-management'))"
  );
  assert.strictEqual(isModalClosed, true, "La modale deve chiudersi al click su Annulla");
  console.log("  PASS: Modale Gestione File (apertura, metadati, validazione real-time e chiusura) verificata con successo.");

  await evaluateInBrowser<void>(`
    document.querySelector('button[data-view="fleet"]').click();
  `);
  await new Promise((r) => setTimeout(r, 200));

  // Test FleetTable: Menu 'Altre' con React Portal in document.body e auto-flip/z-index
  console.log("  -> Test FleetTable: Menu 'Altre' con React Portal in document.body e auto-flip/z-index");
  await evaluateInBrowser<void>(`
    document.getElementById('btn-actions-robot_react_01').click();
  `);
  await new Promise((r) => setTimeout(r, 100));
  const menuInfo = await evaluateInBrowser<{ isDirectChildOfBody: boolean; zIndex: string; position: string; text: string }>(`{
    const menu = document.body.querySelector('body > .dropdown-menu.show');
    ({
      isDirectChildOfBody: Boolean(menu),
      zIndex: menu ? window.getComputedStyle(menu).zIndex : '',
      position: menu ? window.getComputedStyle(menu).position : '',
      text: menu ? menu.textContent || '' : '',
    })
  }`);
  assert.strictEqual(menuInfo.isDirectChildOfBody, true, "Il menu Altre deve essere montato direttamente in document.body via Portal");
  assert.strictEqual(menuInfo.position, "fixed", "Il menu Altre deve avere position: fixed");
  assert.strictEqual(menuInfo.zIndex, "1040", "Il menu Altre deve avere zIndex: 1040");
  assert.ok(menuInfo.text.includes("Aggiorna Stato"), "Il menu Altre deve contenere 'Aggiorna Stato'");
  assert.ok(menuInfo.text.includes("Configura"), "Il menu Altre deve contenere 'Configura'");
  assert.ok(menuInfo.text.includes("Ripara Directory"), "Il menu Altre deve contenere 'Ripara Directory'");
  assert.ok(menuInfo.text.includes("Disabilita Robot"), "Il menu Altre deve contenere 'Disabilita Robot'");
  assert.ok(menuInfo.text.includes("Rimuovi Robot"), "Il menu Altre deve contenere 'Rimuovi Robot'");

  // Chiusura menu con tasto Escape
  await evaluateInBrowser<void>(`
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  `);
  await new Promise((r) => setTimeout(r, 100));
  const isMenuClosed = await evaluateInBrowser<boolean>(
    "!Boolean(document.body.querySelector('body > .dropdown-menu.show'))"
  );
  assert.strictEqual(isMenuClosed, true, "Il menu Altre deve chiudersi con il tasto Escape");
  console.log("  PASS: Menu 'Altre' floating in Portal, posizionamento fixed, z-index 1040 e chiusura con Escape verificati.");

  // Test AppNavbar: logo con link href="/", aria-label e click che riporta alla Home (SRS §5.1)
  console.log("  -> Test AppNavbar: verifica logo link href='/', aria-label e navigazione Home");
  const navbarBrandData = await evaluateInBrowser<{ href: string; ariaLabel: string; hasImg: boolean }>(`{
    const brandLink = document.querySelector('nav.navbar a.navbar-brand');
    ({
      href: brandLink ? brandLink.getAttribute('href') : '',
      ariaLabel: brandLink ? brandLink.getAttribute('aria-label') : '',
      hasImg: Boolean(brandLink && brandLink.querySelector('img')),
    })
  }`);
  assert.strictEqual(navbarBrandData.href, "/", "Il link del brand deve avere href='/'");
  assert.ok(navbarBrandData.ariaLabel.includes("Home"), "Il link del brand deve avere aria-label verso la Home");
  assert.strictEqual(navbarBrandData.hasImg, true, "Il logo deve contenere il tag img con l'asset PNG");

  // Naviga a vista File sul robot
  await evaluateInBrowser<void>(`
    document.querySelector('button[data-view="remote"]').click();
  `);
  await new Promise((r) => setTimeout(r, 200));
  const isRemoteActive = await evaluateInBrowser<boolean>(
    "Boolean(document.getElementById('fs-panel-remote'))"
  );
  assert.strictEqual(isRemoteActive, true, "Deve trovarsi sulla vista File sul robot");

  // Click sul logo per tornare alla Home (vista Flotta) senza reload
  await evaluateInBrowser<void>(`
    document.querySelector('nav.navbar a.navbar-brand').click();
  `);
  await new Promise((r) => setTimeout(r, 200));
  const isFleetActiveAfterHome = await evaluateInBrowser<boolean>(
    "Boolean(document.getElementById('fleet-table'))"
  );
  assert.strictEqual(isFleetActiveAfterHome, true, "Il click sul logo deve riportare alla Home (vista Flotta)");
  console.log("  PASS: AppNavbar logo funge da pulsante Home verso Flotta senza ricaricare la pagina.");

  // Test Regressione: Sequenza di navigazione Logo -> Trasferimenti -> Logs
  console.log("  -> Test Regressione Navigazione: Sequenza Logo -> Trasferimenti -> Logs (nessun blocco su Flotta)");

  // 1. Clic sul logo: la vista è Flotta
  await evaluateInBrowser<void>(`
    document.querySelector('nav.navbar a.navbar-brand').click();
  `);
  await new Promise((r) => setTimeout(r, 200));
  const isFleetAfterLogo = await evaluateInBrowser<boolean>(
    "Boolean(document.getElementById('fleet-table')) && document.getElementById('fleet-view-container')?.style.display !== 'none'"
  );
  assert.strictEqual(isFleetAfterLogo, true, "Dopo il clic sul logo, la vista attiva deve essere Flotta");

  // 2. Clic su Gestione file/trasferimenti (nav-files) e selezione tab Trasferimenti
  await evaluateInBrowser<void>(`{
    const filesNavBtn = document.getElementById('nav-files') || document.querySelector('button[data-view="files"]');
    filesNavBtn?.click();
    setTimeout(() => {
      const trfBtn = document.querySelector('button[data-view="transfers"]');
      trfBtn?.click();
    }, 50);
  }`);
  await new Promise((r) => setTimeout(r, 300));

  const isTransfersActive = await evaluateInBrowser<boolean>(`{
    const filesActive = document.getElementById('nav-files')?.classList.contains('active');
    const fsContainerVisible = document.getElementById('fs-view-container')?.style.display !== 'none';
    const trfTabActive = document.querySelector('button[data-view="transfers"]')?.classList.contains('active');
    Boolean(filesActive && fsContainerVisible && trfTabActive)
  }`);
  assert.strictEqual(isTransfersActive, true, "Dopo il logo, il clic su Trasferimenti deve mostrare la vista Trasferimenti e non restare bloccato su Flotta");

  // Esercita login e logout reali senza dedurre il ruolo dal nome utente.
  const logAccounts = [
    { username: "utente_registro_a", role: "admin", label: "Amministratore" },
    { username: "utente_registro_b", role: "operatore", label: "Operatore" },
  ];
  const headers = { host: new URL(serverBaseUrl).host, origin: serverBaseUrl };
  for (const { username, role } of logAccounts) {
    await userRepo.create({
      id: username, username, roles: [role], passwordHash: adminHash, enabled: true,
      createdAt: new Date(), updatedAt: new Date(),
    });
    const login = await server.inject({
      method: "POST", url: "/api/auth/login", headers,
      payload: { username, password: "AdminPassword123!" },
    });
    assert.equal(login.statusCode, 200);
    const cookie = login.cookies.find(({ name }) => name === "__Host-moliris_session");
    assert.ok(cookie);
    const logout = await server.inject({
      method: "POST", url: "/api/auth/logout",
      headers: { ...headers, cookie: `${cookie.name}=${cookie.value}` },
    });
    assert.equal(logout.statusCode, 200);
  }
  const historicalAccess = "[2026-01-15 12:00:00] EVENT: LOGIN | Utente: storico | Esito: SUCCESSO";
  await fs.promises.appendFile(physicalFileLogger.getAccessLogFilePath(), historicalAccess + "\n");
  const oldFailure = await physicalFileLogger.logTransfer({
    filename: "fallimento-oltre-il-limite.bin", username: "storico",
    direction: "CLIENT_TO_ROBOT", outcome: "FALLIMENTO", details: "Errore storico",
  });
  await fs.promises.appendFile(physicalFileLogger.getTransferLogFilePath(),
    Array.from({ length: 501 }, (_, index) =>
      `[2026-01-15 12:00:00] File: filler-${index} | Utente: storico | Direzione: CLIENT_TO_SERVER | Esito: SUCCESSO | Dettagli: fixture`
    ).join("\n") + "\n");
  const winterTransfer = await physicalFileLogger.logTransfer({
    timestamp: new Date("2026-01-15T12:00:00Z"), filename: "inverno.bin",
    username: "storico", direction: "SERVER_TO_ROBOT", outcome: "SUCCESSO",
  });
  const summerTransfer = await physicalFileLogger.logTransfer({
    timestamp: new Date("2026-07-15T22:30:00Z"), filename: "estate.bin",
    username: "storico", direction: "SERVER_TO_ROBOT", outcome: "SUCCESSO",
  });
  await fs.promises.appendFile(physicalFileLogger.getTransferLogFilePath(),
    "=== INIZIO CARICAMENTO MASSIVO === [batchId: inverno] (1 file) Utente: storico | Data: 2026-01-15 | Ora: 12:00:00 ===\n" +
    "=== CARICAMENTO MASSIVO TERMINATO === [batchId: estate] - Esito: SUCCESSO (Completati: 1/1, Annullati: 0, Falliti: 0) | Data: 2026-07-15 | Ora: 22:30:00 ===\n"
  );
  const orangeBadge = "rgb(255, 236, 213)";
  const bulkSummaries = [
    { id: "estate", label: "Completato", color: "rgb(25, 135, 84)", completed: 1, failed: 0, cancelled: 0 },
    { id: "bulk-all-failed", label: "Fallito", color: "rgb(220, 53, 69)", completed: 0, failed: 3, cancelled: 0 },
    { id: "bulk-all-cancelled", label: "Annullato", color: orangeBadge, completed: 0, failed: 0, cancelled: 3 },
    { id: "bulk-mixed", label: "Concluso con errori", color: orangeBadge, completed: 1, failed: 1, cancelled: 1 },
    { id: "bulk-failed-cancelled", label: "Concluso con errori", color: orangeBadge, completed: 0, failed: 1, cancelled: 2 },
    { id: "bulk-mixed-cancelled", label: "Concluso con annullamenti", color: orangeBadge, completed: 2, failed: 0, cancelled: 1 },
  ];
  for (const summary of bulkSummaries.slice(1)) {
    const { id, completed, failed, cancelled } = summary;
    await physicalFileLogger.logBulkEnd(id, { totalFiles: completed + failed + cancelled, completed, failed, cancelled });
  }
  await physicalFileLogger.logBulkFile("bulk-storico", 1, 1, {
    filename: "legacy-bulk.bin", username: "storico", direction: "CLIENT_TO_ROBOT", outcome: "ANNULLATO",
  });
  const structuredLogRows = [];
  for (const outcome of ["FALLIMENTO", "ANNULLATO"] as const) {
    structuredLogRows.push(await physicalFileLogger.logTransfer({
      filename: `fixture-${outcome}.bin`, username: "storico", direction: "CLIENT_TO_ROBOT", outcome,
      source: "Computer", destination: "SFTP robot robot-test · /upload", transferId: `id-${outcome}`,
      batchId: "batch-fixture-log", details: "Motivazione specifica di prova",
    }));
  }
  await sendCdpCommand("Emulation.setTimezoneOverride", { timezoneId: "America/New_York" });

  // 3. Clic su Logs (nav-logs)
  await evaluateInBrowser<void>(`
    const logsNavBtn = document.getElementById('nav-logs') || document.querySelector('button[data-view="logs"]');
    logsNavBtn?.click();
  `);
  await new Promise((r) => setTimeout(r, 300));

  const isLogsActive = await evaluateInBrowser<boolean>(
    "Boolean(document.getElementById('logs-view-container')) && Boolean(document.getElementById('nav-logs')?.classList.contains('active'))"
  );
  assert.strictEqual(isLogsActive, true, "Dopo il logo e Trasferimenti, il clic su Logs deve mostrare la vista Logs");

  const readLogRows = (table: string) => `Array.from(document.querySelectorAll('#${table} tbody tr'), row =>
    Array.from(row.cells, cell => cell.textContent.trim()))`;
  for (const { username, label } of logAccounts) {
    await waitForBrowser(`${readLogRows("table-access-logs")}.filter(row =>
      row[2] === ${JSON.stringify(username)} && row[3] === ${JSON.stringify(label)} &&
      ['LOGIN', 'LOGOUT'].includes(row[1]) && row[4] === 'SUCCESSO'
    ).length === 2`);
  }
  await waitForBrowser(`${readLogRows("table-access-logs")}.some(row =>
    row[0] === '2026-01-15 13:00:00' && row[2] === 'storico' && row[3] === '—'
  )`);
  await evaluateInBrowser("document.getElementById('tab-transfer-logs').click()");
  for (const [timestamp, text] of [
    ["2026-01-15 13:00:00", "inverno.bin"], ["2026-07-16 00:30:00", "estate.bin"],
    ["2026-01-15 13:00:00", "Batch ID: inverno"], ["2026-07-16 00:30:00", "Batch ID: estate"],
  ]) {
    await waitForBrowser(`${readLogRows("table-transfer-logs")}.some(row =>
      row[0] === ${JSON.stringify(timestamp)} && row[1].includes(${JSON.stringify(text)})
    )`);
  }
  const bulkStyle = await evaluateInBrowser<{ badges: [string, string, string][]; bulkItem: string[] }>(`
    const rows = Array.from(document.querySelectorAll('#table-transfer-logs tbody tr'));
    const badges = rows.filter(row => row.cells[1].textContent.includes('Fine Caricamento Massivo')).map(row => {
      const badge = row.cells[2].querySelector('.badge');
      return [row.cells[1].querySelector('code').textContent, badge.textContent, getComputedStyle(badge).backgroundColor];
    });
    const row = rows.find(row => row.cells[1].textContent.includes('legacy-bulk.bin'));
    const cellStyle = getComputedStyle(row.cells[0]);
    const bulkItem = [
      row.cells[1].querySelector('.badge').textContent.trim(), row.cells[5].querySelector('code').textContent,
      getComputedStyle(row).borderLeftWidth, cellStyle.borderBottomWidth, cellStyle.borderBottomColor,
      getComputedStyle(row.cells[4].querySelector('.badge')).backgroundColor,
    ];
    ({ badges, bulkItem })
  `);
  for (const { id, label, color } of bulkSummaries) {
    assert.deepEqual(bulkStyle.badges.find(([batchId]) => batchId === id), [id, label, color]);
  }
  assert.deepEqual(bulkStyle.bulkItem, ["Bulk", "bulk-storico", "0px", "1px", "rgb(222, 226, 230)", orangeBadge]);
  console.log("  PASS: Stati finali dei batch, identificazione Bulk storica e separatori neutri verificati in Chrome.");
  for (const outcome of ["SUCCESSO", "FALLIMENTO", "ANNULLATO"]) {
    await evaluateInBrowser(`(() => {
      const filter = document.getElementById('filter-transfer-outcome');
      filter.value = ${JSON.stringify(outcome)};
      filter.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await waitForBrowser(`${readLogRows("table-transfer-logs")}.length > 0 &&
      ${readLogRows("table-transfer-logs")}.every(row => row[4] === ${JSON.stringify(outcome)})`);
    if (outcome === "FALLIMENTO") {
      await waitForBrowser(`${readLogRows("table-transfer-logs")}.some(row => row[1].includes('fallimento-oltre-il-limite.bin'))`);
    }
    if (outcome !== "SUCCESSO") {
      await waitForBrowser(`${readLogRows("table-transfer-logs")}.some(row =>
        row[5].includes('SFTP robot robot-test') && row[5].includes('batch-fixture-log')
          && row[5].includes('Motivazione specifica di prova'))`);
    }
  }
  const rawLogs = await evaluateInBrowser<string[]>(`Promise.all(['access', 'transfers'].map(async type =>
    (await fetch('/api/logs/download/' + type)).text()))`);
  assert.ok(rawLogs[0].includes(historicalAccess));
  assert.ok(rawLogs[1].includes(winterTransfer) && rawLogs[1].includes(summerTransfer));
  assert.ok(structuredLogRows.every((row) => rawLogs[1].includes(row)) && rawLogs[1].includes(oldFailure));
  console.log("  PASS: Log trasferimenti con tutti gli esiti, filtro, percorso, batch e download.");
  await sendCdpCommand("Emulation.setTimezoneOverride", { timezoneId: "" });
  console.log("  PASS: Ruoli LOGIN/LOGOUT, UTC nei download e Europe/Rome in entrambe le tabelle, in estate e inverno.");

  // 4. Sequenza specifica di smontaggio: Logs -> Logo -> Logs -> Trasferimenti
  console.log("  -> Test Regressione Smontaggio Dashboard: Sequenza Logs -> Logo -> Logs -> Trasferimenti");
  // Logo da Logs
  await evaluateInBrowser<void>(`
    document.querySelector('nav.navbar a.navbar-brand').click();
  `);
  await new Promise((r) => setTimeout(r, 200));

  // Di nuovo a Logs (Dashboard viene smontata)
  await evaluateInBrowser<void>(`
    document.getElementById('nav-logs')?.click();
  `);
  await new Promise((r) => setTimeout(r, 200));

  // A Trasferimenti (Dashboard viene rimontata con goHomeTrigger azzerato in App)
  await evaluateInBrowser<void>(`{
    const filesNavBtn = document.getElementById('nav-files') || document.querySelector('button[data-view="files"]');
    filesNavBtn?.click();
    setTimeout(() => {
      const trfBtn = document.querySelector('button[data-view="transfers"]');
      trfBtn?.click();
    }, 50);
  }`);
  await new Promise((r) => setTimeout(r, 300));

  const isTransfersActiveAfterUnmount = await evaluateInBrowser<boolean>(`{
    const filesActive = document.getElementById('nav-files')?.classList.contains('active');
    const fsContainerVisible = document.getElementById('fs-view-container')?.style.display !== 'none';
    const trfTabActive = document.querySelector('button[data-view="transfers"]')?.classList.contains('active');
    Boolean(filesActive && fsContainerVisible && trfTabActive)
  }`);
  assert.strictEqual(
    isTransfersActiveAfterUnmount,
    true,
    "Dopo smontaggio Dashboard in Logs e clic su Trasferimenti, la vista deve rimanere Trasferimenti e NON forzare Flotta"
  );

  console.log("  PASS: Regressione superata: entrambe le sequenze (Logo -> Trasferimenti -> Logs e Logs -> Logo -> Logs -> Trasferimenti) verificate con successo.");

  // Keep the transfer at a known point while the real client receives an SSE snapshot.
  const { cookies } = await sendCdpCommand("Network.getCookies", { urls: [serverBaseUrl] });
  const browserSession = sessionManager.getSession(cookies.find(
    (cookie: { name: string }) => cookie.name === "__Host-moliris_session",
  )?.value || "");
  assert.ok(browserSession);
  const browserUser = await userRepo.findById(browserSession.userId);
  assert.ok(browserUser);
  const transferContext = sessionManager.createAuthorizedContext(browserSession, browserUser);
  const transferService = (server as typeof server & { transferService: TransferService }).transferService;
  const progressFixture = await transferService.registerBulkStagingTransfer(
    transferContext, "chrome-progress-fixture.bin", 10_000, undefined, "chrome-progress-fixture",
  );
  try {
    transferService.updateBulkStagingTransfer(progressFixture, 3_500, 1_000, 7);
    const selector = `tr[data-transfer-id="${progressFixture.transferId}"] [role="progressbar"]`;
    await waitForBrowser(`document.querySelector(${JSON.stringify(selector)})?.getAttribute('aria-valuenow') === '35'`, 6_000);
    assert.equal(await evaluateInBrowser(`document.querySelector(${JSON.stringify(selector)})?.firstElementChild.style.width`), "35%");
    console.log("  PASS: CA-TRF-002 - Chrome visualizza il 35% nella barra di avanzamento ricevuta dal backend.");
  } finally {
    await transferService.cancelTransfer(progressFixture.transferId, browserUser.id);
  }
  // The next test expects inactivity to resume. Wait until the browser has
  // observed the cancellation, rather than just the backend completing it.
  const progressRow = `tr[data-transfer-id="${progressFixture.transferId}"]`;
  await waitForBrowser(`document.querySelector(${JSON.stringify(progressRow)})?.getAttribute('data-status') === 'CANCELLED'`, 6_000);

  // Torna alla vista Flotta per preservare lo stato dei test successivi
  await evaluateInBrowser<void>(`
    const fleetNavBtn = document.getElementById('nav-fleet') || document.querySelector('button[data-view="fleet"]');
    fleetNavBtn?.click();
  `);
  await new Promise((r) => setTimeout(r, 200));

  // Test Prompt #4: Modale avviso inattività, countdown, azioni Conferma ed Esci, e accessibilità
  console.log("  -> Test Prompt #4: Verifica modale avviso inattività su Chrome (azioni Conferma/Esci, countdown, accessibilità)");
  await evaluateInBrowser<void>(`
    if (typeof window._molirisSimulateInactivity === 'function') {
      window._molirisSimulateInactivity(28); // 28 minuti trascorsi su 30 -> 2 minuti rimanenti
    }
  `);
  await waitForBrowser("Boolean(document.getElementById('modal-idle-warning'))");

  const warningModal = await evaluateInBrowser<{
    exists: boolean;
    role: string | null;
    hasCountdown: boolean;
    hasConfirm: boolean;
    confirmText: string | null;
    hasLogout: boolean;
    logoutText: string | null;
  }>(`
    (() => {
      const modal = document.getElementById('modal-idle-warning');
      const confirmBtn = document.getElementById('btn-idle-confirm');
      const logoutBtn = document.getElementById('btn-idle-logout');
      const countdown = document.getElementById('idle-warning-countdown');
      return {
        exists: Boolean(modal),
        role: modal ? modal.getAttribute('role') : null,
        hasCountdown: Boolean(countdown),
        hasConfirm: Boolean(confirmBtn),
        confirmText: confirmBtn ? confirmBtn.textContent.trim() : null,
        hasLogout: Boolean(logoutBtn),
        logoutText: logoutBtn ? logoutBtn.textContent.trim() : null,
      };
    })()
  `);

  assert.strictEqual(warningModal.exists, true, "Il modale di avviso inattività deve essere presente");
  assert.strictEqual(warningModal.role, "alertdialog", "Il modale deve avere role='alertdialog'");
  assert.strictEqual(warningModal.hasCountdown, true, "Deve essere presente il countdown");
  assert.strictEqual(warningModal.hasConfirm, true, "Deve essere presente il pulsante Conferma");
  assert.strictEqual(warningModal.confirmText, "Conferma");
  assert.strictEqual(warningModal.hasLogout, true, "Deve essere presente il pulsante Esci");
  assert.strictEqual(warningModal.logoutText, "Esci");

  // Click su Conferma: chiude il pop-up e azzera il timer
  await evaluateInBrowser<void>(`
    document.getElementById('btn-idle-confirm').click();
  `);
  await new Promise((r) => setTimeout(r, 200));

  const isIdleModalClosed = await evaluateInBrowser<boolean>(
    "!document.getElementById('modal-idle-warning')"
  );
  assert.strictEqual(isIdleModalClosed, true, "Il click su Conferma deve chiudere il pop-up");
  console.log("  PASS: Modale avviso inattività (countdown, Conferma, Esci, chiusura e accessibilità) verificato su Chrome.");

  // Test Route /assets per file .png con Content-Type image/png
  console.log("  -> Test Route /assets: verifica Content-Type image/png per file .png");
  const distAssetsDir = path.join(import.meta.dirname, "..", "dist", "frontend", "assets");
  fs.mkdirSync(distAssetsDir, { recursive: true });
  const testPngName = "react-test-logo.png";
  const testPngPath = path.join(distAssetsDir, testPngName);
  fs.writeFileSync(testPngPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

  try {
    const pngResponse = await server.inject({
      method: "GET",
      url: `/assets/${testPngName}`,
    });
    assert.strictEqual(pngResponse.statusCode, 200, "La rotta /assets deve restituire 200 per immagini PNG");
    assert.strictEqual(pngResponse.headers["content-type"], "image/png", "Il Content-Type deve essere image/png");
  } finally {
    if (fs.existsSync(testPngPath)) {
      fs.unlinkSync(testPngPath);
    }
  }
  console.log("  PASS: La route /assets serve correttamente file .png con Content-Type image/png.");

  // Test Sicurezza di rete: nessuna richiesta verso host remoti non intermediati (SRS §1.2, §2.4)
  console.log("  -> Test Sicurezza Rete: Verifica che nessuna richiesta sia stata inviata a host robot");
  for (const reqUrl of networkRequestsMade) {
    assert.ok(
      reqUrl.startsWith(serverBaseUrl) || reqUrl.startsWith("data:") || reqUrl.startsWith("blob:") || reqUrl.includes("127.0.0.1"),
      `Violazione sicurezza: URL non autorizzato: ${reqUrl}`
    );
    assert.ok(!reqUrl.includes("192.168.100.200"), "Il browser non deve mai contattare l'IP del robot");
  }
  console.log("  PASS: Il browser non ha inviato alcuna richiesta verso host di robot; tutte le chiamate passano da Fastify.");

  await testResponsiveNavigationAndRegistrationFocus();
  await testLogoutCycles();
  await testStalledLogout();
  await testLogout();
  await loginAgain();
  await evaluateInBrowser("document.querySelector('button[data-view=fleet]').click()");
  await testRemoteTerminalClipboard();
  console.log("  PASS: Test E2E React completato con successo su Google Chrome!");
} catch (error) {
  if (error !== sessionConflictOnlyComplete && error !== logoutOnlyComplete && error !== logoutCyclesOnlyComplete) {
    throw error;
  }
} finally {
  cdpWs.close();
  try {
    if (chromeProcess.pid) {
      process.kill(-chromeProcess.pid, "SIGKILL");
    }
  } catch {
    chromeProcess.kill("SIGKILL");
  }
  await server.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(chromeUserDataDir, { recursive: true, force: true });
}
