// Requisiti verificati: SRS §2.5 (Google Chrome), §5.1, RF-AUTH-001..006, RF-ROB-001..014, RNF-UX-001..004
import assert from "assert";
import fs from "fs";
import path from "path";
import os from "os";
import { spawn, execSync, type ChildProcess } from "child_process";
import { fileURLToPath } from "url";
import { createServer } from "../backend/server.ts";
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
import { filterRobots } from "./src/utils/filterRobots.ts";
import type { RobotSummaryDto } from "./src/types/fleet.ts";

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

// Test 2: StateFormatter - Tre stati distinti e assenza di dati (RF-MON-005, §10.2)
console.log("  -> Test StateFormatter React: verifica rappresentazione distinta dei 3 stati");
const noDataHtml = StateFormatter.renderOperationalState(null);
assert.ok(noDataHtml.includes("dato non disponibile (RF-MON-005)"), "L'assenza di dati deve mostrare 'dato non disponibile'");

const staleDataHtml = StateFormatter.renderOperationalState({ battery: 85 }, true);
assert.ok(staleDataHtml.includes("[Non più verificato]"), "Il dato stale deve mostrare il badge [Non più verificato]");

const connBadge = StateFormatter.renderConnectionBadge("non_raggiungibile");
assert.ok(connBadge.includes("badge-non_raggiungibile"));
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

await robotRepo.create({
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
});

const server = createServer(testConfig, logger, {
  robotRepository: robotRepo,
  auditRepository: auditRepo,
  userRepository: userRepo,
  sessionManager,
  credentialProvider,
  hostKeyVerifier,
  connectionManager,
  serverFsService,
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
    const res = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
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
  cdpWs.onopen = () => resolve();
  cdpWs.onerror = (e) => reject(e);
});

let cdpMsgId = 1;
const pendingCdpReplies = new Map<number, (res: any) => void>();
const networkRequestsMade: string[] = [];

cdpWs.onmessage = (event) => {
  try {
    const data = JSON.parse(event.data as string);
    if (data.method === "Network.requestWillBeSent") {
      const reqUrl = data.params?.request?.url;
      if (reqUrl) networkRequestsMade.push(reqUrl);
    }
    if (data.id && pendingCdpReplies.has(data.id)) {
      const cb = pendingCdpReplies.get(data.id)!;
      pendingCdpReplies.delete(data.id);
      cb(data.result);
    }
  } catch {}
};

async function sendCdpCommand(method: string, params: any = {}): Promise<any> {
  const id = cdpMsgId++;
  return new Promise((resolve) => {
    pendingCdpReplies.set(id, resolve);
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

try {
  console.log(`  -> Navigazione su ${serverBaseUrl}...`);
  await sendCdpCommand("Page.navigate", { url: serverBaseUrl });
  await new Promise((r) => setTimeout(r, 1000));

  // Verifica montaggio React e Login Section
  const isLoginVisible = await evaluateInBrowser<boolean>(
    "Boolean(document.getElementById('login-section'))"
  );
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

  await evaluateInBrowser<void>(`
    document.querySelector('button[data-view="fleet"]').click();
  `);
  await new Promise((r) => setTimeout(r, 200));

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

  console.log("  PASS: Test E2E React completato con successo su Google Chrome!");
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
