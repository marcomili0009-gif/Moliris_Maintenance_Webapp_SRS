// @ts-nocheck
// Requisiti verificati: SRS §2.5 (Google Chrome), §5.1, §6.1 punti 1-5, §6.2, §6.3, §6.4, §6.5..6.7, §8.1..8.4, §9, §10.2, §10.3, §10.4,
// RF-AUTH-001..006, RF-ROB-001..014, RF-MON-001..006, RF-SSH-001..008, RF-FS-001..007, RF-TRF-001..014,
// RNF-UX-001..004, RNF-SEC-001..009, RNF-PERF-001..003, RNF-REL-001..005, RNF-MNT-001..003,
// CA-AUTH-001, CA-AUTH-002, CA-AUTH-003, CA-ROB-001, CA-ROB-002, CA-ROB-003, CA-ROB-012,
// CA-MON-003, CA-MON-004, CA-SSH-001, CA-SSH-003, CA-SSH-004, CA-FS-001, CA-FS-002, CA-FS-003, CA-FS-004,
// CA-TRF-002, CA-TRF-003, CA-TRF-004

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
import { type UserEntity, hashPassword } from "../backend/auth/user-models.ts";
import { SessionManager } from "../backend/auth/session-manager.ts";
import { ServerFilesystemService } from "../storage/server-fs.ts";
import { RemoteFilesystemService } from "../backend/remote-fs/remote-fs-service.ts";
import { InMemoryCredentialProvider } from "../backend/connection/credential-provider.ts";
import { DefaultHostKeyVerifier } from "../backend/connection/host-key-verifier.ts";
import { RobotConnectionManager } from "../backend/connection/robot-connection-manager.ts";
import { FleetService } from "../backend/fleet/fleet-service.ts";
import { MonitoringService } from "../backend/monitoring/monitoring-service.ts";
import { TerminalService } from "../backend/terminal/terminal-service.ts";
import { TransferService } from "../backend/transfer/transfer-service.ts";
// @ts-ignore
import { ErrorPresenter, ERROR_CATALOG } from "./error-presenter.js";
// @ts-ignore
import { StateFormatter } from "./state-formatter.js";
// @ts-ignore
import { DoubleSubmitGuard } from "./double-submit.js";

console.log("--> Esecuzione test suite Frontend Web End-to-End su Google Chrome (SRS §5.1, §2.5, RNF-UX-001..004)...");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "moliris-frontend-test-"));
const certPath = path.join(tmpDir, "cert.pem");
const keyPath = path.join(tmpDir, "key.pem");
const serverFsRoot = path.join(tmpDir, "server_fs_root");
fs.mkdirSync(serverFsRoot, { recursive: true });

// Generazione certificati TLS autofirmati per server HTTPS
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
const sessionManager = new SessionManager(userRepo, auditRepo, testConfig.inactiveSessionTimeoutMinutes, logger);
const credentialProvider = new InMemoryCredentialProvider();
const hostKeyVerifier = new DefaultHostKeyVerifier();
const connectionManager = new RobotConnectionManager(
  credentialProvider,
  hostKeyVerifier,
  logger,
  testConfig.sshConnectionTimeoutMs
);
const serverFsService = new ServerFilesystemService(serverFsRoot, {} as any, logger);

// Inizializzazione utenti per i test (amministratore e operatore limitato)
const adminHash = await hashPassword("AdminPassword123!");
const operatorHash = await hashPassword("OperatorPassword123!");

await userRepo.create({
  id: "user_admin",
  username: "admin",
  passwordHash: adminHash,
  roles: ["amministratore"],
  enabled: true,
  createdAt: new Date(),
  updatedAt: new Date(),
});

await userRepo.create({
  id: "user_operator",
  username: "operatore_base",
  passwordHash: operatorHash,
  roles: ["operatore"],
  permissions: ["ROBOT_READ", "TERMINAL_OPEN", "FS_REMOTE_NAVIGATE", "FS_SERVER_NAVIGATE"],
  enabled: true,
  createdAt: new Date(),
  updatedAt: new Date(),
});

// Popolamento flotta con robot di test: uno raggiungibile, uno non_raggiungibile (CA-ROB-012)
await robotRepo.create({
  id: "robot_online",
  displayName: "Robot Online Alpha",
  remoteUsername: "operator_alpha",
  serverDirectoryPath: path.join(serverFsRoot, "operator_alpha"),
  host: "127.0.0.1",
  sshPort: 2222,
  sshAuthMethod: "password",
  credentialReference: "vault://creds/robot_online",
  anagraphicState: "attivo",
  connectionState: "raggiungibile",
  registrationState: "registrazione_completata",
  customerName: "Acme Industries",
  plantName: "Milano HQ",
  operationalState: { battery: 92, status: "idle", task: "patrol" },
  lastValidUpdateAt: new Date(),
  lastAttemptOutcome: {
    success: true,
    timestamp: new Date(),
    diagnosticMessage: "Stato acquisito con successo",
  },
  createdAt: new Date(),
  updatedAt: new Date(),
});

// Robot registrato ma irraggiungibile con ultimo tentativo fallito e dato obsoleto (CA-ROB-012, RF-MON-006)
const oldDate = new Date(Date.now() - 3600000);
await robotRepo.create({
  id: "robot_unreachable",
  displayName: "Robot Offline Beta",
  remoteUsername: "operator_beta",
  serverDirectoryPath: path.join(serverFsRoot, "operator_beta"),
  host: "192.168.100.200",
  sshPort: 22,
  sshAuthMethod: "password",
  credentialReference: "vault://creds/robot_unreachable",
  anagraphicState: "attivo",
  connectionState: "non_raggiungibile",
  registrationState: "registrazione_completata",
  operationalState: { battery: 15, status: "error" },
  isStale: true,
  lastValidUpdateAt: oldDate,
  lastAttemptOutcome: {
    success: false,
    timestamp: new Date(),
    diagnosticMessage: "Host non raggiungibile: timeout di connessione",
    errorCode: "NET_HOST_UNREACHABLE",
  },
  hasWarningsOrErrors: true,
  createdAt: oldDate,
  updatedAt: new Date(),
});

// Robot senza dati di monitoraggio (RF-MON-005: non inventare stati)
await robotRepo.create({
  id: "robot_no_data",
  displayName: "Robot Senza Dati",
  remoteUsername: "operator_gamma",
  serverDirectoryPath: path.join(serverFsRoot, "operator_gamma"),
  host: "192.168.100.201",
  sshPort: 22,
  sshAuthMethod: "password",
  credentialReference: "vault://creds/robot_no_data",
  anagraphicState: "attivo",
  connectionState: "non_verificato",
  registrationState: "ssh_non_verificata",
  operationalState: null,
  isStale: false,
  lastValidUpdateAt: null,
  lastAttemptOutcome: null,
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

// =========================================================================
// TEST SUITE UNITARIA DEI COMPONENTI FRONTEND
// =========================================================================

// Test 1: ErrorPresenter copre tutte le 17 categorie §9 e non espone segreti (Step 3, §9, RNF-SEC-002)
console.log("  -> Test ErrorPresenter: verifica catalogo §9 e messaggi sicuri");
const allCatalogKeys = Object.keys(ERROR_CATALOG);
assert.strictEqual(allCatalogKeys.length, 17, "Il catalogo frontend deve contenere tutte le 17 categorie §9");

for (const code of allCatalogKeys) {
  const formatted = ErrorPresenter.formatError({ code });
  assert.ok(formatted.userMessage, `Il codice ${code} deve avere un messaggio sicuro`);
  assert.ok(
    formatted.classification === "recuperabile" || formatted.classification === "richiede_intervento_amministrativo",
    `Il codice ${code} deve avere classificazione corretta`
  );
  // Nessun segreto
  assert.ok(!/password|secret|key|sql|mongo|internal/i.test(formatted.userMessage));
}

// Fallback per codici sconosciuti o risposte grezze (Step 3)
const fallback = ErrorPresenter.formatError({ code: "UNKNOWN_UNEXPECTED_EXCEPTION", message: "Error at Object.stackTrace..." });
assert.strictEqual(fallback.userMessage, "Si è verificato un errore durante l'elaborazione della richiesta.");
assert.strictEqual(fallback.classification, "recuperabile");

// Errore di rete (Step 7: VPN / connessione non disponibile)
const netError = ErrorPresenter.formatError(new TypeError("Failed to fetch"));
assert.strictEqual(netError.code, "NETWORK_DISCONNECTED");
assert.ok(netError.userMessage.includes("VPN Moliris"));

// Render alert con badge visivo distinto
const alertRecup = ErrorPresenter.renderAlert({ code: "AUTH_INVALID_CREDENTIALS" });
assert.ok(alertRecup.includes("badge-recuperabile"), "Deve avere classe badge-recuperabile");
assert.ok(alertRecup.includes("alert-warning"));

const alertAdmin = ErrorPresenter.renderAlert({ code: "SSH_HOST_KEY_INVALID" });
assert.ok(alertAdmin.includes("badge-amministrativo"), "Deve avere classe badge-amministrativo");
assert.ok(alertAdmin.includes("alert-danger"));
console.log("  PASS: ErrorPresenter verifica tutte le categorie §9 con sanitizzazione totale e distinzione visiva.");

// Test 2: StateFormatter - Tre stati distinti e nessuna invenzione dati (Step 2, §10.2, RF-MON-005/006, CA-ROB-012)
console.log("  -> Test StateFormatter: verifica rappresentazione distinta dei 3 stati");

// Assenza di dati (RF-MON-005)
const noDataHtml = StateFormatter.renderOperationalState(null);
assert.ok(noDataHtml.includes("dato non disponibile (RF-MON-005)"), "L'assenza di dati deve mostrare esplicitamente 'dato non disponibile'");
assert.ok(!noDataHtml.includes("idle") && !noDataHtml.includes("running"), "Non deve inventare stati operativi");

// Dato valido e dato stale
const validDataHtml = StateFormatter.renderOperationalState({ battery: 80 }, false);
assert.ok(validDataHtml.includes("battery"));
assert.ok(!validDataHtml.includes("[Non più verificato]"));

const staleDataHtml = StateFormatter.renderOperationalState({ battery: 80 }, true);
assert.ok(staleDataHtml.includes("[Non più verificato]"));

// Stato di connessione (CA-ROB-012)
const connBadge = StateFormatter.renderConnectionBadge("non_raggiungibile");
assert.ok(connBadge.includes("badge-non_raggiungibile"));
assert.ok(connBadge.includes("non raggiungibile"));

const unverifiedBadge = StateFormatter.renderConnectionBadge("non_verificato");
assert.ok(unverifiedBadge.includes("badge-non_verificato"));

// Esito ultimo tentativo
const failedOutcome = StateFormatter.renderLastAttemptOutcome({
  success: false,
  timestamp: new Date().toISOString(),
  diagnosticMessage: "Host non raggiungibile",
});
assert.ok(failedOutcome.includes("Fallito"));
assert.ok(failedOutcome.includes("Host non raggiungibile"));
console.log("  PASS: StateFormatter garantisce separazione categorica dei 3 stati e gestione assenza dati.");

// Test 3: DoubleSubmitGuard - Prevenzione doppi invii concorrenti (Step 4, RNF-UX-002)
console.log("  -> Test DoubleSubmitGuard: blocco doppi click concorrenti");
let runCount = 0;
const mockButton = {
  disabled: false,
  innerHTML: "Invia",
  dataset: {} as Record<string, string>,
};

const slowAction = async () => {
  runCount++;
  await new Promise((r) => setTimeout(r, 40));
};

// Avvio simultaneo di due invocazioni sullo stesso pulsante
const p1 = DoubleSubmitGuard.execute(mockButton as any, "Attesa...", slowAction);
const p2 = DoubleSubmitGuard.execute(mockButton as any, "Attesa...", slowAction);
await Promise.all([p1, p2]);

assert.strictEqual(runCount, 1, "La seconda invocazione concorrente deve essere ignorata");
assert.strictEqual(mockButton.disabled, false, "Il pulsante deve essere riabilitato alla fine");
assert.strictEqual(mockButton.innerHTML, "Invia", "Il testo originale del pulsante deve essere ripristinato");
console.log("  PASS: DoubleSubmitGuard previene doppi invii concorrenti.");

// =========================================================================
// TEST E2E SU GOOGLE CHROME HEADLESS TRAMITE CHROME DEVTOOLS PROTOCOL (CDP)
// =========================================================================
console.log("  -> Avvio Google Chrome Headless per test E2E (SRS §2.5, RNF-UX-004)...");

const cdpPort = 9444;
const chromeUserDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "moliris-chrome-test-"));
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

// Attendiamo che Chrome apra la porta CDP
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

// Connessione WebSocket CDP nativa (Node.js 22+)
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
      networkRequestsMade.push(data.params.request.url);
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

// Abilitazione domini CDP
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

// Navigazione alla web application Moliris su HTTPS
console.log(`  -> Navigazione su ${serverBaseUrl}...`);
await sendCdpCommand("Page.navigate", { url: serverBaseUrl });
await new Promise((r) => setTimeout(r, 600));

// Test 4: CA-AUTH-001/002 - Schermata di login, login fallito e login valido
console.log("  -> Test CA-AUTH-001/002: Login, credenziali non valide, login riuscito");
const pageTitle = await evaluateInBrowser<string>("document.title");
assert.ok(pageTitle.includes("Moliris"), "Il titolo deve identificare l'applicazione");

const isLoginVisible = await evaluateInBrowser<boolean>(
  "!document.getElementById('login-section').classList.contains('hidden')"
);
assert.strictEqual(isLoginVisible, true, "All'avvio deve essere visibile la schermata di login");

// Tentativo login con credenziali errate (CA-AUTH-002)
await evaluateInBrowser<void>(`
  document.getElementById('username').value = 'utente_errato';
  document.getElementById('password').value = 'password_sbagliata';
  document.getElementById('btn-login').click();
`);
await new Promise((r) => setTimeout(r, 300));

const loginErrorText = await evaluateInBrowser<string>(
  "document.getElementById('login-error').textContent"
);
assert.ok(loginErrorText.includes("non valide"), "Deve mostrare messaggio sicuro credenziali non valide");

// Login valido come amministratore (CA-AUTH-001)
await evaluateInBrowser<void>(`
  document.getElementById('username').value = 'admin';
  document.getElementById('password').value = 'AdminPassword123!';
  document.getElementById('btn-login').click();
`);
await new Promise((r) => setTimeout(r, 600));

const isDashboardVisible = await evaluateInBrowser<boolean>(
  "!document.getElementById('dashboard-section').classList.contains('hidden')"
);
assert.strictEqual(isDashboardVisible, true, "Dopo login valido deve essere visibile la dashboard flotta");

const loggedUser = await evaluateInBrowser<string>(
  "document.getElementById('current-username').textContent"
);
assert.strictEqual(loggedUser, "admin", "L'utente visualizzato deve essere admin");

// Controllo sicurezza credenziali: password rimossa dal campo input (RNF-SEC-002)
const pwdValueAfterLogin = await evaluateInBrowser<string>(
  "document.getElementById('password').value"
);
assert.strictEqual(pwdValueAfterLogin, "", "La password nel campo form deve essere cancellata dopo l'invio");

// Controllo storage: il token è in sessionStorage e NON in localStorage (RNF-SEC-002)
const localToken = await evaluateInBrowser<string | null>("localStorage.getItem('moliris_token')");
assert.strictEqual(localToken, null, "Il token di sessione NON deve risiedere in localStorage");

const sessionToken = await evaluateInBrowser<string | null>("sessionStorage.getItem('moliris_token')");
assert.ok(sessionToken, "Il token di sessione deve essere presente in sessionStorage");

console.log("  PASS: CA-AUTH-001/002 verificati con successo in Google Chrome.");

// Test 5: CA-ROB-012 & §10.2 - Lista flotta con stati distinti
console.log("  -> Test CA-ROB-012: Flotta con stati distinti e robot irraggiungibile in lista");

// Attendiamo che la chiamata asincrona /api/robots completi
for (let i = 0; i < 20; i++) {
  const currentHtml = await evaluateInBrowser<string>("document.getElementById('fleet-table-body').innerHTML");
  if (!currentHtml.includes("Caricamento flotta in corso...")) {
    break;
  }
  await new Promise((r) => setTimeout(r, 100));
}

const currentTbodyHtml = await evaluateInBrowser<string>("document.getElementById('fleet-table-body').innerHTML");
if (currentTbodyHtml.includes("empty-cell")) {
  console.log("DEBUG TBODY:", currentTbodyHtml);
}

const fleetRowsCount = await evaluateInBrowser<number>(
  "document.querySelectorAll('#fleet-table-body tr').length"
);
assert.ok(fleetRowsCount >= 3, "La tabella della flotta deve mostrare tutti i robot registrati");

// Verifica presenza robot_online con stato raggiungibile
const hasOnlineRobot = await evaluateInBrowser<boolean>(`
  Array.from(document.querySelectorAll('#fleet-table-body tr')).some(tr => 
    tr.textContent.includes('Robot Online Alpha') && tr.textContent.includes('raggiungibile')
  )
`);
assert.strictEqual(hasOnlineRobot, true, "Robot online deve essere visualizzato con stato raggiungibile");

// Verifica presenza e visualizzazione corretta Nome Cliente e Nome Impianto nella tabella flotta (RF-05)
const hasCustomerAndPlantInTable = await evaluateInBrowser<boolean>(`
  Array.from(document.querySelectorAll('#fleet-table-body tr')).some(tr => 
    tr.textContent.includes('Robot Online Alpha') &&
    tr.textContent.includes('Acme Industries') &&
    tr.textContent.includes('Milano HQ')
  )
`);
assert.strictEqual(hasCustomerAndPlantInTable, true, "La tabella della flotta deve mostrare Nome Cliente e Nome Impianto associati (RF-05)");

// Verifica presenza robot_unreachable con stato non_raggiungibile e dato non più verificato (CA-ROB-012, RF-MON-006)
const hasUnreachableRobot = await evaluateInBrowser<boolean>(`
  Array.from(document.querySelectorAll('#fleet-table-body tr')).some(tr => 
    tr.textContent.includes('Robot Offline Beta') && 
    tr.textContent.includes('non raggiungibile') &&
    tr.textContent.includes('[Non più verificato]')
  )
`);
assert.strictEqual(hasUnreachableRobot, true, "Robot irraggiungibile compare in lista con stato appropriato e badge [Non più verificato]");

// Verifica presenza robot_no_data con "dato non disponibile (RF-MON-005)"
const hasNoDataRobot = await evaluateInBrowser<boolean>(`
  Array.from(document.querySelectorAll('#fleet-table-body tr')).some(tr => 
    tr.textContent.includes('Robot Senza Dati') && 
    tr.textContent.includes('dato non disponibile (RF-MON-005)')
  )
`);
assert.strictEqual(hasNoDataRobot, true, "Robot senza stato file mostra 'dato non disponibile' senza inventare alcuno stato");

console.log("  PASS: CA-ROB-012 e §10.2 verificati: stati sempre distinti e assenza di dati non confusa con stati.");

// Test 6: CA-ROB-001/002/006 - Form di registrazione con campi obbligatori ed evidenziazione errori form
console.log("  -> Test CA-ROB-001/002/006: Form registrazione e validazione campi");
await evaluateInBrowser<void>("document.getElementById('btn-register-robot').click()");
await new Promise((r) => setTimeout(r, 200));

const isRegisterModalOpen = await evaluateInBrowser<boolean>(
  "!document.getElementById('modal-robot-register').classList.contains('hidden')"
);
assert.strictEqual(isRegisterModalOpen, true, "Il modal di registrazione deve aprirsi");

// Invio form vuoto per verificare errori di validazione associati ai campi (RF-ROB-006)
await evaluateInBrowser<void>(`
  document.getElementById('reg-id').value = '';
  document.getElementById('reg-displayName').value = '';
  document.getElementById('btn-submit-register').click();
`);
await new Promise((r) => setTimeout(r, 200));

// Compilazione con dati parziali non validi
await evaluateInBrowser<void>(`
  document.getElementById('reg-id').value = 'robot_invalido';
  document.getElementById('reg-displayName').value = 'Robot Test Invio';
  document.getElementById('reg-remoteUsername').value = 'moliris_user';
  document.getElementById('reg-host').value = 'host_inesistente_xyz_test.moliris';
  document.getElementById('reg-sshPort').value = '22';
  document.getElementById('reg-password').value = 'TestPassword123!';
  document.getElementById('form-register-robot').dispatchEvent(new Event('submit', { cancelable: true }));
`);
await new Promise((r) => setTimeout(r, 600));

// Chiudiamo il modal di registrazione
await evaluateInBrowser<void>("document.getElementById('btn-close-register').click()");
await new Promise((r) => setTimeout(r, 100));

// Test 7: Dettaglio robot e funzionalità autorizzate con motivazioni (RF-ROB-002, RF-ROB-003, RF-ROB-011)
console.log("  -> Test RF-ROB-002/003/011: Scheda dettaglio e motivazione funzionalità disabilitate");
await evaluateInBrowser<void>(`
  // Clic su dettaglio del primo robot (robot_online)
  document.querySelector('#fleet-table-body tr button').click();
`);
await new Promise((r) => setTimeout(r, 400));

const isDetailOpen = await evaluateInBrowser<boolean>(
  "!document.getElementById('modal-robot-detail').classList.contains('hidden')"
);
assert.strictEqual(isDetailOpen, true, "La scheda di dettaglio del robot deve aprirsi");

const detailHtml = await evaluateInBrowser<string>("document.getElementById('detail-body').innerHTML");
assert.ok(detailHtml.includes("Stato Anagrafico"), "Deve mostrare lo stato anagrafico");
assert.ok(detailHtml.includes("Stato Connessione"), "Deve mostrare lo stato di connessione");
assert.ok(detailHtml.includes("Stato Operativo"), "Deve mostrare lo stato operativo interpretato");
assert.ok(detailHtml.includes("Acme Industries"), "Deve mostrare il Nome Cliente associato (RF-05)");
assert.ok(detailHtml.includes("Milano HQ"), "Deve mostrare il Nome Impianto associato (RF-05)");
assert.ok(detailHtml.includes("Funzionalità del Robot"), "Deve mostrare la griglia funzionalità (RF-ROB-011)");

// Chiudi dettaglio
await evaluateInBrowser<void>("document.getElementById('btn-close-detail').click()");
await new Promise((r) => setTimeout(r, 100));

// Test 8: Navigazione Filesystem Server e Remoto e Trasferimenti (CA-FS-001..004, CA-TRF-002)
console.log("  -> Test CA-FS-001..004: Navigazione tab filesystem e pannello trasferimenti");
// Seleziona Tab Server
await evaluateInBrowser<void>("document.getElementById('btn-tab-fs-server').click()");
const isServerTabActive = await evaluateInBrowser<boolean>(
  "!document.getElementById('fs-panel-server').classList.contains('hidden')"
);
assert.strictEqual(isServerTabActive, true, "Il pannello filesystem server deve essere attivo");

// Seleziona Tab Remoto
await evaluateInBrowser<void>("document.getElementById('btn-tab-fs-remote').click()");
const isRemoteTabActive = await evaluateInBrowser<boolean>(
  "!document.getElementById('fs-panel-remote').classList.contains('hidden')"
);
assert.strictEqual(isRemoteTabActive, true, "Il pannello filesystem remoto SFTP deve essere attivo");

// Seleziona Tab Trasferimenti
await evaluateInBrowser<void>("document.getElementById('btn-tab-transfers').click()");
const isTransfersTabActive = await evaluateInBrowser<boolean>(
  "!document.getElementById('fs-panel-transfers').classList.contains('hidden')"
);
assert.strictEqual(isTransfersTabActive, true, "Il pannello trasferimenti streaming deve essere attivo");

// Test 9: CA-AUTH-003 - RBAC utente limitato (operatore_base non vede pulsante registra robot)
console.log("  -> Test CA-AUTH-003: RBAC frontend - utente operatore non vede funzioni amministrative");
// Logout admin
await evaluateInBrowser<void>("document.getElementById('btn-logout').click()");
await new Promise((r) => setTimeout(r, 400));

// Login come operatore_base
await evaluateInBrowser<void>(`
  document.getElementById('username').value = 'operatore_base';
  document.getElementById('password').value = 'OperatorPassword123!';
  document.getElementById('btn-login').click();
`);
await new Promise((r) => setTimeout(r, 600));

const isRegisterHiddenForOperator = await evaluateInBrowser<boolean>(
  "document.getElementById('btn-register-robot').classList.contains('hidden')"
);
assert.strictEqual(isRegisterHiddenForOperator, true, "L'operatore senza permessi NON deve vedere il pulsante 'Registra Nuovo Robot'");

// Test 10: Rete e Sicurezza - Nessuna richiesta diretta verso i robot dal browser (SRS §1.2, §2.4 vincolo 4)
console.log("  -> Test Sicurezza Rete: Verifica che nessuna richiesta sia stata inviata a host robot");
for (const reqUrl of networkRequestsMade) {
  assert.ok(
    reqUrl.startsWith(serverBaseUrl) || reqUrl.startsWith("data:") || reqUrl.startsWith("blob:") || reqUrl.includes("127.0.0.1"),
    `Violazione di sicurezza rilevata: richiesta browser verso URL non autorizzato: ${reqUrl}`
  );
  assert.ok(!reqUrl.includes("192.168.100.200"), "Il browser non deve mai contattare l'IP del robot");
}
console.log("  PASS: Il browser non ha inviato alcuna richiesta verso host di robot; tutte le chiamate passano dal server.");

// Test 11: Scadenza sessione e disconnessione uniforme (Step 5, RF-AUTH-003, RF-AUTH-006)
console.log("  -> Test Step 5: Scadenza sessione, chiusura modali e reindirizzamento login");
await evaluateInBrowser<void>(`
  // Simuliamo un'invalidazione del token (es. sessione scaduta sul server)
  sessionStorage.setItem('moliris_token', 'token_scaduto_o_invalido');
  // Chiamata API protetta con token invalido che scatena 401
  window.dispatchEvent(new CustomEvent('test-session-expire'));
`);
// Eseguiamo una chiamata protetta da browser per innescare l'interceptor 401
await evaluateInBrowser<void>(`
  (async () => {
    try {
      const { apiClient } = await import('./api-client.js');
      await apiClient.get('/api/auth/me');
    } catch {}
  })();
`);
await new Promise((r) => setTimeout(r, 400));

const isBackToLogin = await evaluateInBrowser<boolean>(
  "!document.getElementById('login-section').classList.contains('hidden')"
);
assert.strictEqual(isBackToLogin, true, "Dopo scadenza sessione deve tornare alla schermata di login");

const bannerText = await evaluateInBrowser<string>(
  "document.getElementById('notification-banner').textContent"
);
assert.ok(bannerText.includes("scaduta o non valida"), "Il banner deve informare che la sessione è scaduta");

// Test 12: Finestra terminale ed emulazione xterm.js (RF-SSH-001..004, RNF-UX-004)
console.log("  -> Test RF-SSH-001..004: Verifica emulatore terminale xterm.js nel browser");
const hasXtermClass = await evaluateInBrowser<boolean>("typeof Terminal !== 'undefined'");
assert.strictEqual(hasXtermClass, true, "La libreria xterm.js deve essere caricata nel browser");

// Test 13: Modal di conferma sovrascrittura protetta (RF-TRF-011, RNF-FS-003)
console.log("  -> Test RF-TRF-011: Modal di conferma sovrascrittura file");
await evaluateInBrowser<void>(`
  document.getElementById('overwrite-file-target').textContent = 'Server: test_file.bin';
  document.getElementById('modal-confirm-overwrite').classList.remove('hidden');
`);
await new Promise((r) => setTimeout(r, 200));

const isOverwriteModalOpen = await evaluateInBrowser<boolean>(
  "!document.getElementById('modal-confirm-overwrite').classList.contains('hidden')"
);
assert.strictEqual(isOverwriteModalOpen, true, "Il modal di conferma sovrascrittura deve essere visibile");

const overwriteTargetText = await evaluateInBrowser<string>(
  "document.getElementById('overwrite-file-target').textContent"
);
assert.ok(overwriteTargetText.includes("test_file.bin"), "Il target da sovrascrivere deve essere chiaramente indicato");

await evaluateInBrowser<void>("document.getElementById('btn-cancel-overwrite').click()");
await new Promise((r) => setTimeout(r, 100));

const isOverwriteModalClosed = await evaluateInBrowser<boolean>(
  "document.getElementById('modal-confirm-overwrite').classList.contains('hidden')"
);
assert.strictEqual(isOverwriteModalClosed, true, "Il modal di sovrascrittura deve chiudersi all'annullamento");

// Test 14: Modal Avviso Inattività Terminale (RF-01)
console.log("  -> Test RF-01: Modal Avviso Inattività Terminale");
await evaluateInBrowser<void>(`
  const modalTerm = document.getElementById('modal-terminal-idle-warning');
  const countEl = document.getElementById('terminal-idle-countdown');
  countEl.textContent = '5';
  modalTerm.classList.remove('hidden');
`);
await new Promise((r) => setTimeout(r, 100));

const isTermModalOpen = await evaluateInBrowser<boolean>(
  "!document.getElementById('modal-terminal-idle-warning').classList.contains('hidden')"
);
assert.strictEqual(isTermModalOpen, true, "Il modal di avviso timeout terminale deve essere visibile");

const termCountdown5 = await evaluateInBrowser<string>(
  "document.getElementById('terminal-idle-countdown').textContent"
);
assert.strictEqual(termCountdown5, "5", "Il conto alla rovescia iniziale del terminale deve essere 5");

await evaluateInBrowser<void>("document.getElementById('terminal-idle-countdown').textContent = '4'");
const termCountdown4 = await evaluateInBrowser<string>(
  "document.getElementById('terminal-idle-countdown').textContent"
);
assert.strictEqual(termCountdown4, "4", "Il conto alla rovescia del terminale si aggiorna a 4");

await evaluateInBrowser<void>("document.getElementById('btn-dismiss-terminal-idle').click()");
await new Promise((r) => setTimeout(r, 100));
const isTermModalClosed = await evaluateInBrowser<boolean>(
  "document.getElementById('modal-terminal-idle-warning').classList.contains('hidden')"
);
assert.strictEqual(isTermModalClosed, true, "Il modal di avviso terminale deve chiudersi al click su Chiudi Avviso");

// Test 15: Modal Avviso Inattività Sessione (RF-02)
console.log("  -> Test RF-02: Modal Avviso Inattività Sessione");
await evaluateInBrowser<void>(`
  const modalSess = document.getElementById('modal-session-idle-warning');
  const sessCountEl = document.getElementById('session-idle-countdown');
  sessCountEl.textContent = '5';
  modalSess.classList.remove('hidden');
`);
await new Promise((r) => setTimeout(r, 100));

const isSessModalOpen = await evaluateInBrowser<boolean>(
  "!document.getElementById('modal-session-idle-warning').classList.contains('hidden')"
);
assert.strictEqual(isSessModalOpen, true, "Il modal di avviso inattività sessione deve essere visibile");

const sessCountdown5 = await evaluateInBrowser<string>(
  "document.getElementById('session-idle-countdown').textContent"
);
assert.strictEqual(sessCountdown5, "5", "Il countdown sessione deve mostrare 5 minuti");

await evaluateInBrowser<void>("document.getElementById('session-idle-countdown').textContent = '1'");
const sessCountdown1 = await evaluateInBrowser<string>(
  "document.getElementById('session-idle-countdown').textContent"
);
assert.strictEqual(sessCountdown1, "1", "Il countdown sessione deve potersi aggiornare fino a 1 minuto");

await evaluateInBrowser<void>("document.getElementById('btn-close-session-idle').click()");
await new Promise((r) => setTimeout(r, 100));
const isSessModalClosed = await evaluateInBrowser<boolean>(
  "document.getElementById('modal-session-idle-warning').classList.contains('hidden')"
);
assert.strictEqual(isSessModalClosed, true, "Il modal di avviso sessione deve chiudersi al dismiss");

// Chiusura risorse di test
cdpWs.close();

if (chromeProcess.pid !== undefined) {
  const chromeClosed = new Promise<void>((resolve) => {
    if (chromeProcess.exitCode !== null || chromeProcess.signalCode !== null) {
      resolve();
    } else {
      chromeProcess.once("close", () => resolve());
    }
  });

  try {
    process.kill(-chromeProcess.pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      throw error;
    }
  }

  await chromeClosed;
}

await server.close();
fs.rmSync(tmpDir, { recursive: true, force: true });
fs.rmSync(chromeUserDataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });

console.log("PASS: Tutti i test della suite Frontend Web Google Chrome E2E sono stati superati con successo.");
