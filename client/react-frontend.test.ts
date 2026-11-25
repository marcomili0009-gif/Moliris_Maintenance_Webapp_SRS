// Requisiti verificati: SRS §2.5 (Google Chrome), §5.1, RF-AUTH-001..006, RF-ROB-001..014, RNF-UX-001..004
import assert from "assert";
import fs from "fs";
import path from "path";
import os from "os";
import { spawn, execSync, type ChildProcess } from "child_process";
import { fileURLToPath } from "url";
import { createServer } from "../backend/server.ts";
import { loadConfig } from "../src/config/index.ts";
import { MolirisLogger } from "../logging/logger.ts";
import { type SystemConfiguration } from "../config/configuration.ts";
import { InMemoryRobotRepository } from "../storage/robot-repository.ts";
import { InMemoryAuditRepository } from "../storage/audit-repository.ts";
import { InMemoryUserRepository } from "../backend/auth/user-repository.ts";
import { hashPassword } from "../backend/auth/user-models.ts";
import { SessionManager } from "../backend/auth/session-manager.ts";
import { ServerFilesystemService } from "../storage/server-fs.ts";
import { InMemoryCredentialProvider } from "../backend/connection/credential-provider.ts";
import { DefaultHostKeyVerifier } from "../backend/connection/host-key-verifier.ts";
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
  React.createElement(NotificationBanner, { message: "Operazione completata" })
);
assert.ok(bannerWithMsgOnlyHtml.includes("Operazione completata"), "NotificationBanner deve mostrare i messaggi informativi inline");
assert.ok(!bannerWithMsgOnlyHtml.includes("modal-error-alert"), "NotificationBanner non deve aprire modale per soli messaggi informativi");
console.log("  PASS: ErrorModal e NotificationBanner verificati: pop-up ATTENZIONE attivo per errori operativi.");

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

const logger = new MolirisLogger();
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
  roles: ["amministratore"],
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

const server = createServer(testConfig, logger, {
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
    "--ignore-certificate-errors",
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

cdpWs.onmessage = (event) => {
  try {
    const data = JSON.parse(event.data as string);
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

async function setBrowserNetwork(latency: number, offline = false): Promise<void> {
  await sendCdpCommand("Network.emulateNetworkConditions", {
    offline,
    latency,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });
}

async function testLogout(): Promise<void> {
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
    await waitForBrowser("!document.querySelector('#logout-status')");
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

async function testLogoutCycles(): Promise<void> {
  const pageTimeOrigin = await evaluateInBrowser<number>("performance.timeOrigin");
  const countLogoutRequests = () => networkRequestsWithMethod.filter(
    ({ method, url }) => method === "POST" && url.endsWith("/api/auth/logout")
  ).length;
  for (let cycle = 1; cycle <= 20; cycle++) {
    if (cycle > 1) await loginAgain();
    const beforeLogout = countLogoutRequests();
    const { feedbackMs, confirmedMs } = await evaluateInBrowser<{ feedbackMs: number; confirmedMs: number }>(
      `new Promise((resolve, reject) => {
        const start = performance.now();
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
          reject(new Error('Logout ciclo ${cycle} senza conferma entro 4 s'));
        }, 4000);
        observer.observe(document.body, { childList: true, subtree: true, attributes: true });
        const button = document.getElementById('btn-logout');
        button.click();
        button.click();
      })`
    );
    console.log(`LOGOUT_CYCLE ${cycle} ${feedbackMs.toFixed(1)} ${confirmedMs.toFixed(1)}`);
    assert.ok(feedbackMs < 100, `Ciclo ${cycle}: feedback entro 100 ms`);
    assert.ok(confirmedMs < 1_000, `Ciclo ${cycle}: conferma entro 1 secondo`);
    assert.equal(countLogoutRequests() - beforeLogout, 1, `Ciclo ${cycle}: un solo POST`);
    assert.equal(sessionManager.getActiveSessionsCount("user_admin"), 0, `Ciclo ${cycle}: sessione revocata`);
    const { cookies } = await sendCdpCommand("Network.getCookies", { urls: [serverBaseUrl] });
    assert.ok(!cookies.some(({ name }: { name: string }) => name === "__Host-moliris_session"),
      `Ciclo ${cycle}: cookie di sessione rimosso`);
    assert.equal(await evaluateInBrowser<number>(
      "fetch('/api/auth/me', {cache:'no-store', signal:AbortSignal.timeout(2000)}).then(response => response.status)"
    ), 401, `Ciclo ${cycle}: sessione precedente inutilizzabile`);
  }
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
  await sendCdpCommand("Page.navigate", { url: serverBaseUrl });

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
    await testLogoutCycles();
    await testStalledLogout();
    throw logoutCyclesOnlyComplete;
  }
  if (logoutOnly) {
    await testLogout();
    throw logoutOnlyComplete;
  }

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
  console.log("  -> Test Terminale Server: formato ridotto, espansione senza perdita sessione, newline e chiusura atomica");

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

  // Chiusura con la "X": stessa routine atomica del pulsante Disconnetti.
  await evaluateInBrowser<void>(`
    document.getElementById('btn-close-terminal').click();
  `);
  await new Promise((r) => setTimeout(r, 500));
  const terminalClosed = await evaluateInBrowser<boolean>(
    "!Boolean(document.getElementById('modal-terminal'))"
  );
  assert.strictEqual(terminalClosed, true, "Il click sulla X deve chiudere il pannello del terminale");

  const issuedDisconnect = networkRequestsWithMethod.some(
    (req) => req.method === "DELETE" && req.url.includes(`/api/terminal/sessions/${ptySessionId}`)
  );
  assert.strictEqual(
    issuedDisconnect,
    true,
    "La X deve inviare la richiesta formale di chiusura sessione PTY (DELETE)"
  );

  const deleteAfterClose = await evaluateInBrowser<number>(`(async () => {
    const res = await fetch('/api/terminal/sessions/${ptySessionId}', { method: 'DELETE' });
    return res.status;
  })()`);
  assert.strictEqual(
    deleteAfterClose,
    404,
    "Dopo la X la sessione PTY non deve più esistere sul backend (nessuna sessione orfana)"
  );
  console.log("  PASS: Terminale server ridotto/espanso senza perdita sessione, newline a colonna 0, X con chiusura PTY verificata.");

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
  await new Promise((r) => setTimeout(r, 600));

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

  await testLogoutCycles();
  await testStalledLogout();
  await testLogout();
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
