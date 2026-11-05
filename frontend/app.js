// Requisiti: SRS §2.5 (Google Chrome), §5.1, §6.1 punti 1-5, §6.2, §6.3, §6.4, §6.5..6.7, §8.1..8.4, §9, §10.2, §10.3, §10.4,
// RF-AUTH-001..006, RF-ROB-001..014, RF-MON-001..006, RF-SSH-001..008, RF-FS-001..007, RF-TRF-001..014,
// RNF-UX-001..004, RNF-SEC-001..009, RNF-PERF-001..003, RNF-REL-001..005, RNF-MNT-001..003

import { apiClient } from "./api-client.js";
import { ErrorPresenter } from "./error-presenter.js";
import { StateFormatter } from "./state-formatter.js";
import { DoubleSubmitGuard } from "./double-submit.js";

document.addEventListener("DOMContentLoaded", () => {
  // =========================================================================
  // RIFERIMENTI DOM PRINCIPALI
  // =========================================================================
  const loginSection = document.getElementById("login-section");
  const dashboardSection = document.getElementById("dashboard-section");
  const loginForm = document.getElementById("login-form");
  const btnLogin = document.getElementById("btn-login");
  const loginError = document.getElementById("login-error");
  const notificationBanner = document.getElementById("notification-banner");

  const currentUsername = document.getElementById("current-username");
  const currentRoles = document.getElementById("current-roles");
  const btnLogout = document.getElementById("btn-logout");
  const btnRegisterRobot = document.getElementById("btn-register-robot");
  const btnRefreshFleet = document.getElementById("btn-refresh-fleet");
  const fleetTableBody = document.getElementById("fleet-table-body");

  // Modali
  const modalDetail = document.getElementById("modal-robot-detail");
  const detailTitle = document.getElementById("detail-title");
  const detailBody = document.getElementById("detail-body");
  const btnCloseDetail = document.getElementById("btn-close-detail");

  const modalRegister = document.getElementById("modal-robot-register");
  const formRegister = document.getElementById("form-register-robot");
  const btnSubmitRegister = document.getElementById("btn-submit-register");
  const btnCloseRegister = document.getElementById("btn-close-register");
  const btnCancelRegister = document.getElementById("btn-cancel-register");
  const selectAuthMethod = document.getElementById("reg-sshAuthMethod");
  const groupPassword = document.getElementById("group-password");
  const groupKey = document.getElementById("group-key");

  const modalOutcome = document.getElementById("modal-registration-outcome");
  const outcomeTitle = document.getElementById("outcome-modal-title");
  const outcomeBody = document.getElementById("outcome-modal-body");
  const btnCloseOutcome = document.getElementById("btn-close-outcome");
  const btnDismissOutcome = document.getElementById("btn-dismiss-outcome");

  const modalEdit = document.getElementById("modal-robot-edit");
  const formEdit = document.getElementById("form-edit-robot");
  const btnSubmitEdit = document.getElementById("btn-submit-edit");
  const btnCloseEdit = document.getElementById("btn-close-edit");
  const btnCancelEdit = document.getElementById("btn-cancel-edit");
  const editSelectAuthMethod = document.getElementById("edit-sshAuthMethod");
  const editGroupPassword = document.getElementById("edit-group-password");
  const editGroupKey = document.getElementById("edit-group-key");

  const modalRemoveConfirm = document.getElementById("modal-confirm-remove");
  const removeRobotNameEl = document.getElementById("remove-robot-name");
  const btnCancelRemove = document.getElementById("btn-cancel-remove");
  const btnConfirmRemove = document.getElementById("btn-confirm-remove");
  let pendingRemoveRobotId = null;

  // Terminale Remoto Interattivo
  const modalTerminal = document.getElementById("modal-terminal");
  const terminalRobotTitle = document.getElementById("terminal-robot-title");
  const terminalSessionStatus = document.getElementById("terminal-session-status");
  const terminalContainer = document.getElementById("terminal-container");
  const terminalFooterDims = document.getElementById("terminal-footer-dims");
  const btnTerminalDisconnect = document.getElementById("btn-terminal-disconnect");
  const btnCloseTerminal = document.getElementById("btn-close-terminal");

  let activeTerminalSessionId = null;
  let activeXterm = null;
  let activeFitAddon = null;
  let terminalWebSocket = null;

  // Navigazione Filesystem Server
  const fsRobotIdInput = document.getElementById("fs-robot-id");
  const btnFsLoad = document.getElementById("btn-fs-load");
  const btnFsUp = document.getElementById("btn-fs-up");
  const fsCurrentPathEl = document.getElementById("fs-current-path");
  const fsTableBody = document.getElementById("fs-table-body");
  const fsError = document.getElementById("fs-error");
  const fsServerFileInput = document.getElementById("fs-server-file-input");
  const btnFsServerUpload = document.getElementById("btn-fs-server-upload");
  let currentFsPath = "";

  // Navigazione Filesystem Remoto Robot SFTP
  const fsRemoteRobotIdInput = document.getElementById("fs-remote-robot-id");
  const btnFsRemoteLoad = document.getElementById("btn-fs-remote-load");
  const btnFsRemoteUp = document.getElementById("btn-fs-remote-up");
  const fsRemoteCurrentPathEl = document.getElementById("fs-remote-current-path");
  const fsRemoteTableBody = document.getElementById("fs-remote-table-body");
  const fsRemoteError = document.getElementById("fs-remote-error");
  const fsRemoteFileInput = document.getElementById("fs-remote-file-input");
  const btnFsRemoteUpload = document.getElementById("btn-fs-remote-upload");
  const btnFsRemotePurge = document.getElementById("btn-fs-remote-purge");
  let currentRemoteFsPath = "";
  let currentRemoteParentPath = null;

  // Tab Filesystem: Server vs Remoto vs Trasferimenti
  const btnTabFsServer = document.getElementById("btn-tab-fs-server");
  const btnTabFsRemote = document.getElementById("btn-tab-fs-remote");
  const btnTabTransfers = document.getElementById("btn-tab-transfers");
  const fsPanelServer = document.getElementById("fs-panel-server");
  const fsPanelRemote = document.getElementById("fs-panel-remote");
  const fsPanelTransfers = document.getElementById("fs-panel-transfers");

  // Trasferimenti e Avanzamento Streaming
  const transfersList = document.getElementById("transfers-list");
  const transfersEmptyMsg = document.getElementById("transfers-empty-msg");
  const transfersActiveCount = document.getElementById("transfers-active-count");
  const btnRefreshTransfers = document.getElementById("btn-refresh-transfers");
  const btnPurgeTransfersTemp = document.getElementById("btn-purge-transfers-temp");
  let transfersPollingInterval = null;

  // Modal Conferma Sovrascrittura
  const modalConfirmOverwrite = document.getElementById("modal-confirm-overwrite");
  const overwriteFileTarget = document.getElementById("overwrite-file-target");
  const btnCloseOverwrite = document.getElementById("btn-close-overwrite");
  const btnCancelOverwrite = document.getElementById("btn-cancel-overwrite");
  const btnConfirmOverwrite = document.getElementById("btn-confirm-overwrite");
  let pendingOverwriteCallback = null;

  // Modal Conferma Eliminazione File (RNF-FS-003, RF-ROB-013)
  const modalConfirmDelete = document.getElementById("modal-confirm-delete");
  const deleteFileTarget = document.getElementById("delete-file-target");
  const btnCloseDelete = document.getElementById("btn-close-delete");
  const btnCancelDelete = document.getElementById("btn-cancel-delete");
  const btnConfirmDelete = document.getElementById("btn-confirm-delete");
  let pendingDeleteCallback = null;

  let currentUser = null;

  // =========================================================================
  // GESTIONE NOTIFICHE ED ERRORI GLOBALI
  // =========================================================================
  function showNotification(messageOrError, type = "warning") {
    if (typeof messageOrError === "object" && messageOrError !== null) {
      notificationBanner.innerHTML = ErrorPresenter.renderAlert(messageOrError);
      notificationBanner.className = "banner-container";
    } else {
      notificationBanner.textContent = String(messageOrError);
      notificationBanner.className = `banner banner-${type}`;
    }
    notificationBanner.classList.remove("hidden");
  }

  function hideNotification() {
    notificationBanner.classList.add("hidden");
    notificationBanner.innerHTML = "";
  }

  // =========================================================================
  // GESTIONE SESSIONE, LOGIN E LOGOUT (RF-AUTH-001..006, CA-AUTH-001..003)
  // =========================================================================
  function closeAllModals() {
    modalDetail?.classList.add("hidden");
    modalRegister?.classList.add("hidden");
    modalOutcome?.classList.add("hidden");
    modalEdit?.classList.add("hidden");
    modalRemoveConfirm?.classList.add("hidden");
    modalConfirmOverwrite?.classList.add("hidden");
    modalConfirmDelete?.classList.add("hidden");
    closeTerminal();
  }

  function showLoginView(expiredMessage = null) {
    closeAllModals();
    dashboardSection.classList.add("hidden");
    loginSection.classList.remove("hidden");
    loginError.classList.add("hidden");
    currentUser = null;
    apiClient.clearToken();

    if (expiredMessage) {
      showNotification(expiredMessage, "warning");
    }
  }

  function showDashboardView(user) {
    currentUser = user;
    loginSection.classList.add("hidden");
    dashboardSection.classList.remove("hidden");
    hideNotification();

    currentUsername.textContent = user.username;
    currentRoles.textContent = user.roles.join(", ");

    // Adattamento interfaccia in base ai permessi autorizzati (RNF-SEC-004)
    const hasRegisterPerm =
      user.roles.includes("amministratore") ||
      (user.permissions && user.permissions.includes("ROBOT_REGISTER"));

    if (hasRegisterPerm) {
      btnRegisterRobot.classList.remove("hidden");
    } else {
      btnRegisterRobot.classList.add("hidden");
    }

    loadFleetData();
  }

  // Registrazione hook scadenza sessione centralizzato (Step 5)
  apiClient.onSessionExpired(() => {
    showLoginView("La sessione è scaduta o non valida. Effettuare nuovamente il login.");
  });

  // Verifica sessione attiva all'avvio
  async function initSession() {
    if (!apiClient.getToken()) {
      showLoginView();
      return;
    }

    try {
      const res = await apiClient.get("/api/auth/me");
      if (res && res.ok) {
        const data = await res.json();
        showDashboardView(data.user);
      } else {
        showLoginView();
      }
    } catch {
      showLoginView();
    }
  }

  // Gestione Login (RF-AUTH-001, CA-AUTH-001/002)
  loginForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    hideNotification();
    loginError.classList.add("hidden");

    const username = document.getElementById("username").value.trim();
    const password = document.getElementById("password").value;

    await DoubleSubmitGuard.execute(btnLogin, "Accesso in corso...", async () => {
      try {
        const res = await fetch("/api/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username, password }),
        });
        const data = await res.json();

        if (!res.ok) {
          const formatted = ErrorPresenter.formatError(data);
          loginError.textContent = formatted.userMessage;
          loginError.classList.remove("hidden");
          return;
        }

        apiClient.setToken(data.sessionToken);
        showDashboardView(data.user);
        document.getElementById("password").value = "";
      } catch (err) {
        const formatted = ErrorPresenter.formatError(err);
        loginError.textContent = formatted.userMessage;
        loginError.classList.remove("hidden");
      }
    });
  });

  // Gestione Logout (RF-AUTH-004)
  btnLogout.addEventListener("click", async () => {
    await DoubleSubmitGuard.execute(btnLogout, "Disconnessione...", async () => {
      try {
        await apiClient.post("/api/auth/logout", {});
      } catch {}
      showLoginView("Disconnessione effettuata con successo.");
    });
  });

  // =========================================================================
  // STEP 1 & 2 – LISTA DELLA FLOTTA E STATI DISTINTI (RF-ROB-001, RF-ROB-014, CA-ROB-012)
  // =========================================================================
  async function loadFleetData() {
    fleetTableBody.innerHTML = '<tr><td colspan="10" class="empty-cell">Caricamento flotta in corso...</td></tr>';
    try {
      const res = await apiClient.get("/api/robots");
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        const errObj = ErrorPresenter.formatError(data);
        fleetTableBody.innerHTML = `<tr><td colspan="10" class="empty-cell" style="color: #c5221f;">${StateFormatter.escapeHtml(errObj.userMessage)}</td></tr>`;
        return;
      }

      const data = await res.json();
      const robots = data.robots || [];

      if (robots.length === 0) {
        fleetTableBody.innerHTML = '<tr><td colspan="10" class="empty-cell">Nessun robot registrato o visibile per questo account.</td></tr>';
        return;
      }

      fleetTableBody.innerHTML = "";
      for (const robot of robots) {
        const tr = document.createElement("tr");

        // 1. Nome Visualizzato
        const tdName = document.createElement("td");
        tdName.innerHTML = `<strong>${StateFormatter.escapeHtml(robot.displayName)}</strong>`;
        tr.appendChild(tdName);

        // 2. ID
        const tdId = document.createElement("td");
        tdId.textContent = robot.id;
        tr.appendChild(tdId);

        // 3. Host : Porta
        const tdHost = document.createElement("td");
        tdHost.textContent = `${robot.host}:${robot.sshPort}`;
        tr.appendChild(tdHost);

        // 4. Username Remoto
        const tdUser = document.createElement("td");
        tdUser.textContent = robot.remoteUsername;
        tr.appendChild(tdUser);

        // 5. Stato Anagrafico (§10.2, RF-ROB-014)
        const tdAnagr = document.createElement("td");
        tdAnagr.innerHTML = StateFormatter.renderAnagraphicBadge(robot.anagraphicState);
        tr.appendChild(tdAnagr);

        // 6. Stato Connessione (§10.2, RF-ROB-014, CA-ROB-012)
        const tdConn = document.createElement("td");
        tdConn.innerHTML = StateFormatter.renderConnectionBadge(robot.connectionState);
        tr.appendChild(tdConn);

        // 7. Stato Operativo (§10.2, RF-MON-005, RF-MON-006)
        const tdOp = document.createElement("td");
        tdOp.innerHTML = StateFormatter.renderOperationalState(robot.operationalState, robot.isStale);
        tr.appendChild(tdOp);

        // 8. Data Ultimo Aggiornamento Stato
        const tdUpdate = document.createElement("td");
        tdUpdate.textContent = StateFormatter.formatDate(robot.lastValidUpdateAt);
        tr.appendChild(tdUpdate);

        // 9. Avvisi / Errori di connessione ed esito ultimo tentativo
        const tdWarnings = document.createElement("td");
        if (robot.hasWarningsOrErrors && robot.lastAttemptOutcome) {
          const diagMsg = robot.lastAttemptOutcome.diagnosticMessage || "Errore ultimo tentativo";
          tdWarnings.innerHTML = `<span style="color: #c5221f; font-size: 0.82rem;">⚠️ ${StateFormatter.escapeHtml(diagMsg)}</span>`;
        } else {
          tdWarnings.textContent = "Nessuno";
        }
        tr.appendChild(tdWarnings);

        // 10. Azioni
        const tdActions = document.createElement("td");
        const btnDetail = document.createElement("button");
        btnDetail.className = "btn btn-secondary btn-sm";
        btnDetail.textContent = "Dettaglio";
        btnDetail.addEventListener("click", () => openRobotDetail(robot.id));
        tdActions.appendChild(btnDetail);
        tr.appendChild(tdActions);

        fleetTableBody.appendChild(tr);
      }
    } catch (err) {
      const formatted = ErrorPresenter.formatError(err);
      fleetTableBody.innerHTML = `<tr><td colspan="10" class="empty-cell" style="color: #c5221f;">${StateFormatter.escapeHtml(formatted.userMessage)}</td></tr>`;
    }
  }

  btnRefreshFleet.addEventListener("click", async () => {
    await DoubleSubmitGuard.execute(btnRefreshFleet, "Aggiornamento...", loadFleetData);
  });

  // =========================================================================
  // STEP 1 & 2 – SCHEDA DETTAGLIO ROBOT E FUNZIONALITÀ AUTORIZZATE (RF-ROB-002, 003, 011)
  // =========================================================================
  async function openRobotDetail(robotId) {
    detailTitle.textContent = `Dettaglio Robot: ${robotId}`;
    detailBody.innerHTML = "<p>Caricamento informazioni in corso...</p>";
    modalDetail.classList.remove("hidden");

    try {
      const res = await apiClient.get(`/api/robots/${encodeURIComponent(robotId)}`);
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        detailBody.innerHTML = ErrorPresenter.renderAlert(data);
        return;
      }

      const data = await res.json();
      const robot = data.robot;
      const feat = data.availableFeatures || {
        monitoring: false,
        terminal: false,
        remoteFs: false,
        serverFs: false,
        transfers: false,
        reasons: {},
      };

      const hasUpdatePerm =
        currentUser?.roles.includes("amministratore") ||
        (currentUser?.permissions && currentUser?.permissions.includes("ROBOT_CONFIG_UPDATE"));
      const hasDisablePerm =
        currentUser?.roles.includes("amministratore") ||
        (currentUser?.permissions && currentUser?.permissions.includes("ROBOT_DISABLE"));
      const hasRemovePerm =
        currentUser?.roles.includes("amministratore") ||
        (currentUser?.permissions && currentUser?.permissions.includes("ROBOT_REMOVE"));

      let html = `
        <!-- Scheda Unificata dei 3 Stati Distinti (§10.2, RF-MON-005/006, RF-ROB-014) -->
        ${StateFormatter.renderRobotStateCard(robot)}

        <div class="details-grid">
          <div class="detail-item">
            <strong>Nome Visualizzato</strong>
            <span>${StateFormatter.escapeHtml(robot.displayName)}</span>
          </div>
          <div class="detail-item">
            <strong>Identificativo Univoco</strong>
            <span>${StateFormatter.escapeHtml(robot.id)}</span>
          </div>
          <div class="detail-item">
            <strong>Username Remoto</strong>
            <span>${StateFormatter.escapeHtml(robot.remoteUsername)}</span>
          </div>
          <div class="detail-item">
            <strong>Host e Porta SSH</strong>
            <span>${StateFormatter.escapeHtml(robot.host)} : ${robot.sshPort}</span>
          </div>
          <div class="detail-item">
            <strong>Metodo Autenticazione SSH</strong>
            <span>${StateFormatter.escapeHtml(robot.sshAuthMethod)}</span>
          </div>
          <div class="detail-item">
            <strong>Directory Associata sul Server</strong>
            <span><code>${StateFormatter.escapeHtml(robot.serverDirectoryPath)}</code></span>
          </div>
          <div class="detail-item">
            <strong>Stato Registrazione (§10.2)</strong>
            <span><code>${StateFormatter.escapeHtml(robot.registrationState)}</code></span>
          </div>
          <div class="detail-item">
            <strong>Verifica Chiave Host SSH (RNF-SEC-003)</strong>
            <span>${robot.hostKeyVerification?.fingerprint ? 'Fingerprint: ' + StateFormatter.escapeHtml(robot.hostKeyVerification.fingerprint) : (robot.hostKeyVerification?.knownHostsPath ? 'File: ' + StateFormatter.escapeHtml(robot.hostKeyVerification.knownHostsPath) : 'StrictHostKey attivo')}</span>
          </div>
          <div class="detail-item" style="grid-column: span 2;">
            <strong>Ultima Verifica Connessione</strong>
            <span>${robot.lastConnectionVerification ? StateFormatter.formatDate(robot.lastConnectionVerification.timestamp) + ' (' + (robot.lastConnectionVerification.success ? 'Riuscita' : 'Fallita: ' + StateFormatter.escapeHtml(robot.lastConnectionVerification.message || '')) + ')' : '-'}</span>
          </div>
        </div>

        <!-- Barra Pulsanti Azione Robot (con guardie di doppio invio) -->
        <div style="display: flex; gap: 0.5rem; flex-wrap: wrap; margin-bottom: 1.5rem; padding-bottom: 1rem; border-bottom: 1px solid #e0e0e0;">
          <button class="btn btn-primary btn-sm" id="btn-detail-refresh-status">🔄 Aggiorna Stato (Refresh)</button>
          ${feat.terminal ? '<button class="btn btn-primary btn-sm" id="btn-detail-open-terminal">💻 Apri Terminale</button>' : ''}
          <button class="btn btn-secondary btn-sm" id="btn-detail-reverify">🔍 Ripeti Verifica Connessione</button>
          ${hasUpdatePerm ? '<button class="btn btn-secondary btn-sm" id="btn-detail-edit">✏️ Modifica Configurazione</button>' : ''}
          ${hasDisablePerm ? (robot.anagraphicState === "attivo"
              ? '<button class="btn btn-warning btn-sm" id="btn-detail-disable">⏸ Disabilita Robot</button>'
              : '<button class="btn btn-accent btn-sm" id="btn-detail-enable">▶ Riabilita Robot</button>')
            : ''}
          ${hasRemovePerm ? '<button class="btn btn-danger btn-sm" id="btn-detail-remove">🗑 Rimuovi Robot</button>' : ''}
          ${robot.registrationState === "registrazione_incompleta" || robot.registrationState === "creazione_directory_fallita"
              ? '<button class="btn btn-accent btn-sm" id="btn-detail-repair">🛠 Ripara Registrazione</button>'
              : ''}
          <button class="btn btn-secondary btn-sm" id="btn-detail-open-fs">📁 Esplora Server FS</button>
          ${feat.remoteFs ? '<button class="btn btn-primary btn-sm" id="btn-detail-open-remote-fs">🌐 Esplora Remoto</button>' : ''}
          <button class="btn btn-secondary btn-sm" id="btn-detail-open-transfers">🔄 Gestione Trasferimenti</button>
        </div>

        <!-- Funzionalità Autorizzate per Utente/Robot (RF-ROB-011, CA-ROB-010) con MOTIVAZIONI TRASPARENTI -->
        <div class="features-container">
          <h4>Funzionalità del Robot (Disponibilità effettiva RF-ROB-011)</h4>
          <p style="font-size: 0.85rem; color: #666;">La disponibilità dipende da autorizzazioni utente, stato anagrafico e stato di raggiungibilità del robot.</p>
          <div class="features-grid">
            <!-- Monitoraggio -->
            <div class="feature-card ${feat.monitoring ? 'feature-enabled' : 'feature-disabled'}">
              <div>
                <div class="feature-title">
                  <span>📊 Monitoraggio Flotta</span>
                  <span class="feature-status ${feat.monitoring ? 'badge-attivo' : 'badge-disabilitato'}">${feat.monitoring ? 'Disponibile' : 'Disabilitato'}</span>
                </div>
                <div class="feature-reason">${feat.monitoring ? 'Servizio di monitoraggio remoto attivo.' : StateFormatter.escapeHtml(feat.reasons.monitoring || 'Non disponibile')}</div>
              </div>
              <button class="btn btn-primary btn-sm" id="btn-feature-refresh-status" style="margin-top: 0.5rem;" ${feat.monitoring ? '' : 'disabled'}>🔄 Aggiorna Stato Remoto</button>
            </div>

            <!-- Terminale Remoto -->
            <div class="feature-card ${feat.terminal ? 'feature-enabled' : 'feature-disabled'}">
              <div>
                <div class="feature-title">
                  <span>💻 Terminale Remoto</span>
                  <span class="feature-status ${feat.terminal ? 'badge-attivo' : 'badge-disabilitato'}">${feat.terminal ? 'Disponibile' : 'Disabilitato'}</span>
                </div>
                <div class="feature-reason">${feat.terminal ? 'Sessione PTY interattiva bidirezionale pronta (RF-SSH-001..004).' : StateFormatter.escapeHtml(feat.reasons.terminal || 'Non disponibile')}</div>
              </div>
              <button class="btn btn-primary btn-sm" id="btn-feature-open-terminal" style="margin-top: 0.5rem;" ${feat.terminal ? '' : 'disabled'}>💻 Apri Terminale Remoto</button>
            </div>

            <!-- Filesystem Remoto -->
            <div class="feature-card ${feat.remoteFs ? 'feature-enabled' : 'feature-disabled'}">
              <div>
                <div class="feature-title">
                  <span>🌐 Filesystem Remoto</span>
                  <span class="feature-status ${feat.remoteFs ? 'badge-attivo' : 'badge-disabilitato'}">${feat.remoteFs ? 'Disponibile' : 'Disabilitato'}</span>
                </div>
                <div class="feature-reason">${feat.remoteFs ? 'Navigazione SFTP attiva nel filesystem del robot.' : StateFormatter.escapeHtml(feat.reasons.remoteFs || 'Non disponibile')}</div>
              </div>
              <button class="btn btn-primary btn-sm" id="btn-card-remote-fs" style="margin-top: 0.5rem;" ${feat.remoteFs ? '' : 'disabled'}>🌐 Esplora Filesystem Remoto</button>
            </div>

            <!-- Filesystem Server -->
            <div class="feature-card ${feat.serverFs ? 'feature-enabled' : 'feature-disabled'}">
              <div>
                <div class="feature-title">
                  <span>🗄️ Filesystem Server</span>
                  <span class="feature-status ${feat.serverFs ? 'badge-attivo' : 'badge-disabilitato'}">${feat.serverFs ? 'Disponibile' : 'Disabilitato'}</span>
                </div>
                <div class="feature-reason">${feat.serverFs ? 'Accesso attivo alla directory dedicata sul server.' : StateFormatter.escapeHtml(feat.reasons.serverFs || 'Non disponibile')}</div>
              </div>
              <button class="btn btn-primary btn-sm" id="btn-card-server-fs" style="margin-top: 0.5rem;" ${feat.serverFs ? '' : 'disabled'}>Carica Directory Server</button>
            </div>

            <!-- Trasferimenti -->
            <div class="feature-card ${feat.transfers ? 'feature-enabled' : 'feature-disabled'}">
              <div>
                <div class="feature-title">
                  <span>⇄ Trasferimenti File</span>
                  <span class="feature-status ${feat.transfers ? 'badge-attivo' : 'badge-disabilitato'}">${feat.transfers ? 'Disponibile' : 'Disabilitato'}</span>
                </div>
                <div class="feature-reason">${feat.transfers ? 'Servizio di trasferimento file streaming attivo (RF-TRF-001..006).' : StateFormatter.escapeHtml(feat.reasons.transfers || 'Non disponibile')}</div>
              </div>
              <button class="btn btn-primary btn-sm" id="btn-card-transfers" style="margin-top: 0.5rem;" ${feat.transfers ? '' : 'disabled'}>Gestione Trasferimenti</button>
            </div>
          </div>
        </div>
      `;

      detailBody.innerHTML = html;

      // Event Listeners con Double Submit Guard
      const triggerTerminal = () => {
        modalDetail.classList.add("hidden");
        openTerminalForRobot(robot.id, robot.displayName);
      };
      document.getElementById("btn-detail-open-terminal")?.addEventListener("click", triggerTerminal);
      document.getElementById("btn-feature-open-terminal")?.addEventListener("click", triggerTerminal);

      const btnRefreshSt = document.getElementById("btn-detail-refresh-status");
      const btnFeatureRefreshSt = document.getElementById("btn-feature-refresh-status");
      const refreshStatusAction = async (btn) => {
        await DoubleSubmitGuard.execute(btn, "Aggiornamento...", () => refreshRobotStatus(robot.id));
      };
      if (btnRefreshSt) btnRefreshSt.addEventListener("click", () => refreshStatusAction(btnRefreshSt));
      if (btnFeatureRefreshSt) btnFeatureRefreshSt.addEventListener("click", () => refreshStatusAction(btnFeatureRefreshSt));

      const btnReverify = document.getElementById("btn-detail-reverify");
      if (btnReverify) {
        btnReverify.addEventListener("click", async () => {
          await DoubleSubmitGuard.execute(btnReverify, "Verifica in corso...", () => reverifyConnection(robot.id));
        });
      }

      document.getElementById("btn-detail-edit")?.addEventListener("click", () => {
        modalDetail.classList.add("hidden");
        openEditModal(robot);
      });

      const btnDisable = document.getElementById("btn-detail-disable");
      if (btnDisable) {
        btnDisable.addEventListener("click", async () => {
          await DoubleSubmitGuard.execute(btnDisable, "Disabilitazione...", () => toggleDisableRobot(robot.id, true));
        });
      }

      const btnEnable = document.getElementById("btn-detail-enable");
      if (btnEnable) {
        btnEnable.addEventListener("click", async () => {
          await DoubleSubmitGuard.execute(btnEnable, "Riabilitazione...", () => toggleDisableRobot(robot.id, false));
        });
      }

      document.getElementById("btn-detail-remove")?.addEventListener("click", () => {
        modalDetail.classList.add("hidden");
        promptRemoveRobot(robot.id, robot.displayName);
      });

      const btnRepair = document.getElementById("btn-detail-repair");
      if (btnRepair) {
        btnRepair.addEventListener("click", async () => {
          await DoubleSubmitGuard.execute(btnRepair, "Riparazione...", () => repairRobotRegistration(robot.id));
        });
      }

      const loadFsAction = () => {
        modalDetail.classList.add("hidden");
        btnTabFsServer?.click();
        fsRobotIdInput.value = robot.id;
        loadServerFilesystem(robot.id, "");
        document.getElementById("fs-browser-section")?.scrollIntoView({ behavior: "smooth" });
      };
      document.getElementById("btn-detail-open-fs")?.addEventListener("click", loadFsAction);
      document.getElementById("btn-card-server-fs")?.addEventListener("click", loadFsAction);

      const loadRemoteFsAction = () => {
        modalDetail.classList.add("hidden");
        btnTabFsRemote?.click();
        if (fsRemoteRobotIdInput) fsRemoteRobotIdInput.value = robot.id;
        loadRemoteFilesystem(robot.id, "");
        document.getElementById("fs-browser-section")?.scrollIntoView({ behavior: "smooth" });
      };
      document.getElementById("btn-detail-open-remote-fs")?.addEventListener("click", loadRemoteFsAction);
      document.getElementById("btn-card-remote-fs")?.addEventListener("click", loadRemoteFsAction);

      const openTransfersAction = () => {
        modalDetail.classList.add("hidden");
        btnTabTransfers?.click();
        if (fsRobotIdInput) fsRobotIdInput.value = robot.id;
        if (fsRemoteRobotIdInput) fsRemoteRobotIdInput.value = robot.id;
        loadTransfersList();
        document.getElementById("fs-browser-section")?.scrollIntoView({ behavior: "smooth" });
      };
      document.getElementById("btn-detail-open-transfers")?.addEventListener("click", openTransfersAction);
      document.getElementById("btn-card-transfers")?.addEventListener("click", openTransfersAction);

    } catch (err) {
      detailBody.innerHTML = ErrorPresenter.renderAlert(err);
    }
  }

  btnCloseDetail.addEventListener("click", () => modalDetail.classList.add("hidden"));

  // =========================================================================
  // STEP 3 & 4 – FORM DI REGISTRAZIONE ROBOT CON FEEDBACK E 6 ESITI (RF-ROB-004..006, RF-ROB-012)
  // =========================================================================
  btnRegisterRobot.addEventListener("click", () => {
    formRegister.reset();
    ErrorPresenter.clearValidationErrors(formRegister);
    groupPassword.classList.remove("hidden");
    groupKey.classList.add("hidden");
    modalRegister.classList.remove("hidden");
  });

  btnCloseRegister.addEventListener("click", () => modalRegister.classList.add("hidden"));
  btnCancelRegister.addEventListener("click", () => modalRegister.classList.add("hidden"));

  selectAuthMethod.addEventListener("change", (e) => {
    if (e.target.value === "key") {
      groupPassword.classList.add("hidden");
      groupKey.classList.remove("hidden");
    } else {
      groupPassword.classList.remove("hidden");
      groupKey.classList.add("hidden");
    }
  });

  formRegister.addEventListener("submit", async (e) => {
    e.preventDefault();
    ErrorPresenter.clearValidationErrors(formRegister);

    const authMethod = selectAuthMethod.value;
    const payload = {
      id: document.getElementById("reg-id").value.trim(),
      displayName: document.getElementById("reg-displayName").value.trim(),
      remoteUsername: document.getElementById("reg-remoteUsername").value.trim(),
      host: document.getElementById("reg-host").value.trim(),
      sshPort: Number(document.getElementById("reg-sshPort").value) || 22,
      sshAuthMethod: authMethod,
      hostKeyVerification: {
        fingerprint: document.getElementById("reg-fingerprint").value.trim() || undefined,
        knownHostsPath: document.getElementById("reg-knownHosts").value.trim() || undefined,
        strictHostKeyChecking: true,
      },
    };

    if (authMethod === "password") {
      payload.password = document.getElementById("reg-password").value;
    } else {
      payload.privateKey = document.getElementById("reg-privateKey").value;
      const pass = document.getElementById("reg-passphrase").value;
      if (pass) payload.passphrase = pass;
    }

    const monPath = document.getElementById("reg-remoteMonitoringPath").value.trim();
    if (monPath) payload.remoteMonitoringPath = monPath;

    const sftpHost = document.getElementById("reg-sftpHost").value.trim();
    const sftpPort = document.getElementById("reg-sftpPort").value.trim();
    const sftpUser = document.getElementById("reg-sftpUser").value.trim();
    if (sftpHost || sftpPort || sftpUser) {
      payload.sftpParameters = {
        host: sftpHost || undefined,
        port: sftpPort ? Number(sftpPort) : undefined,
        username: sftpUser || undefined,
      };
    }

    await DoubleSubmitGuard.execute(btnSubmitRegister, "Registrazione in corso...", async () => {
      try {
        const res = await apiClient.post("/api/robots", payload);
        const data = await res.json();

        // 1. Rifiuto per campi non validi o mancanti (RF-ROB-006)
        if (res.status === 400 && data.validationErrors) {
          ErrorPresenter.renderValidationErrors(formRegister, data.validationErrors);
          showNotification("Registrazione rifiutata: correggere i campi non validi evidenziati.", "danger");
          return;
        }

        // 2. Pulizia immediata credenziali sensibili dal client (§11.2, RNF-SEC-002)
        document.getElementById("reg-password").value = "";
        document.getElementById("reg-privateKey").value = "";
        document.getElementById("reg-passphrase").value = "";

        modalRegister.classList.add("hidden");
        formRegister.reset();

        // Mostra riepilogo dettagliato con uno dei 6 esiti di RF-ROB-012
        showRegistrationOutcome(data);
        loadFleetData();

      } catch (err) {
        showNotification(err, "danger");
      }
    });
  });

  // Schermata esito registrazione con i 6 casi previsti da RF-ROB-012 (Step 4)
  function showRegistrationOutcome(data) {
    outcomeTitle.textContent = `Esito Registrazione: ${data.outcome || 'Riepilogo'}`;

    let outcomeClass = "alert-info";
    if (data.outcome === "registrazione_completata") outcomeClass = "alert-success";
    else if (data.outcome === "registrazione_rifiutata" || data.outcome === "creazione_directory_fallita") outcomeClass = "alert-danger";
    else if (data.outcome === "ssh_non_verificata" || data.outcome === "registrazione_incompleta" || data.outcome === "completata_con_funzionalita_non_verificate") outcomeClass = "alert-warning";

    let html = `
      <div class="alert-box ${outcomeClass}">
        <strong>Esito ottenuto:</strong> <code>${StateFormatter.escapeHtml(data.outcome)}</code><br>
        <p style="margin-top: 0.5rem;">${StateFormatter.escapeHtml(data.message)}</p>
        ${data.diagnosticDetail ? `
          <div style="margin-top: 0.6rem; padding: 0.5rem 0.75rem; background: rgba(0, 0, 0, 0.05); border-left: 3px solid var(--error-text, #c5221f); border-radius: 4px; font-size: 0.9rem;">
            <strong>Dettaglio Diagnostico:</strong> ${StateFormatter.escapeHtml(data.diagnosticDetail)}
          </div>
        ` : ''}
      </div>

      <div style="margin-top: 1rem;">
        <h5>Azioni eseguite con successo:</h5>
        <ul>
          ${(data.performedActions || []).length > 0
            ? (data.performedActions || []).map((a) => `<li>✔️ ${StateFormatter.escapeHtml(a)}</li>`).join("")
            : '<li style="color: var(--text-muted); font-style: italic;">Nessuna azione completata</li>'}
        </ul>
      </div>

      ${data.failedAction ? `
        <div style="margin-top: 0.75rem;">
          <h5>Azione fallita:</h5>
          <ul>
            <li style="color: var(--error-text, #c5221f); font-weight: 500;">❌ ${StateFormatter.escapeHtml(data.failedAction)}</li>
          </ul>
        </div>
      ` : ''}

      ${data.verificationSteps && data.verificationSteps.length > 0 ? `
        <div style="margin-top: 0.75rem;">
          <h5>Dettaglio Controlli di Verifica SSH:</h5>
          <ul style="font-size: 0.88rem; list-style: none; padding-left: 0;">
            ${data.verificationSteps.map((s) => {
              const icon = s.status === "SUCCESS" ? "✔️" : s.status === "FAILED" ? "❌" : "⏭️";
              const color = s.status === "SUCCESS" ? "var(--success-text, #137333)" : s.status === "FAILED" ? "var(--error-text, #c5221f)" : "var(--text-muted, #575757)";
              const detail = s.diagnosticDetail || s.message || s.status;
              return `<li style="margin-bottom: 0.25rem;">
                ${icon} <strong style="color: ${color};">${StateFormatter.escapeHtml(s.step)}:</strong>
                ${StateFormatter.escapeHtml(detail)}
              </li>`;
            }).join("")}
          </ul>
        </div>
      ` : ''}

      ${data.skippedActions && data.skippedActions.length > 0 ? `
        <div style="margin-top: 0.75rem;">
          <h5>Azioni non eseguite o interrotte:</h5>
          <ul>
            ${data.skippedActions.map((a) => `<li>⏭️ ${StateFormatter.escapeHtml(a)}</li>`).join("")}
          </ul>
        </div>
      ` : ''}

      ${data.recoveryPath ? `
        <div class="alert-box alert-info" style="margin-top: 1rem;">
          <strong>Via di recupero consigliata:</strong><br>
          ${StateFormatter.escapeHtml(data.recoveryPath)}
        </div>
      ` : ''}
    `;

    outcomeBody.innerHTML = html;
    modalOutcome.classList.remove("hidden");
  }

  btnCloseOutcome.addEventListener("click", () => modalOutcome.classList.add("hidden"));
  btnDismissOutcome.addEventListener("click", () => modalOutcome.classList.add("hidden"));

  // =========================================================================
  // MONITORAGGIO DELLO STATO (RF-MON-004, CA-MON-003, CA-MON-004)
  // =========================================================================
  async function refreshRobotStatus(robotId) {
    showNotification("Aggiornamento dello stato operativo in corso...", "warning");
    try {
      const res = await apiClient.post(`/api/robots/${encodeURIComponent(robotId)}/status/refresh`, {});
      const data = await res.json();
      if (res.ok && data.success) {
        showNotification("Stato operativo aggiornato con successo!", "success");
      } else {
        const formatted = ErrorPresenter.formatError(data);
        const msg = formatted.userMessage && formatted.userMessage.toLowerCase().startsWith("aggiornamento")
          ? formatted.userMessage
          : `Aggiornamento stato non riuscito: ${formatted.userMessage}`;
        showNotification(msg, "danger");
      }
      openRobotDetail(robotId);
      loadFleetData();
    } catch (err) {
      showNotification(err, "danger");
    }
  }

  // =========================================================================
  // TERMINALE REMOTO INTERATTIVO (RF-SSH-001..008, §5.4, §6.4, RNF-UX-004)
  // =========================================================================
  async function openTerminalForRobot(robotId, displayName) {
    if (activeTerminalSessionId) {
      closeTerminal();
    }

    modalTerminal.classList.remove("hidden");
    terminalRobotTitle.textContent = `💻 Terminale Remoto: ${StateFormatter.escapeHtml(displayName)} (${StateFormatter.escapeHtml(robotId)})`;
    terminalSessionStatus.className = "badge-status badge-non_verificato";
    terminalSessionStatus.textContent = "Allocazione PTY in corso...";
    terminalContainer.innerHTML = "";

    try {
      const res = await apiClient.post(`/api/robots/${encodeURIComponent(robotId)}/terminal/sessions`, {
        cols: 80,
        rows: 24,
      });

      const data = await res.json();
      if (!res.ok || !data.success) {
        const formatted = ErrorPresenter.formatError(data);
        terminalSessionStatus.className = "badge-status badge-errore";
        terminalSessionStatus.textContent = "Errore Connessione";
        terminalContainer.innerHTML = ErrorPresenter.renderAlert(formatted);
        return;
      }

      activeTerminalSessionId = data.sessionId;
      terminalSessionStatus.className = "badge-status badge-non_verificato";
      terminalSessionStatus.textContent = "Connessione WebSocket...";

      // Inizializzazione xterm.js (RF-SSH-003, RNF-UX-004)
      if (typeof Terminal === "undefined") {
        terminalContainer.innerHTML = '<div class="alert-box alert-danger">Libreria xterm.js non disponibile nel browser.</div>';
        return;
      }

      activeXterm = new Terminal({
        cursorBlink: true,
        cursorStyle: "block",
        fontSize: 14,
        fontFamily: '"DejaVu Sans Mono", "Ubuntu Mono", "Liberation Mono", Menlo, Monaco, Consolas, "Courier New", monospace',
        letterSpacing: 0,
        lineHeight: 1.1,
        theme: {
          background: "#1e1e1e",
          foreground: "#f1f1f1",
          cursor: "#ffffff",
        },
        cols: data.cols || 80,
        rows: data.rows || 24,
      });

      if (typeof FitAddon !== "undefined" && FitAddon.FitAddon) {
        activeFitAddon = new FitAddon.FitAddon();
        activeXterm.loadAddon(activeFitAddon);
      }

      activeXterm.open(terminalContainer);
      const helperTa = terminalContainer.querySelector(".xterm-helper-textarea");
      if (helperTa) {
        helperTa.id = "terminal-input-textarea";
        helperTa.name = "terminal-input-textarea";
      }

      if (activeFitAddon) {
        try {
          activeFitAddon.fit();
        } catch {}
      }

      // Canale WebSocket WSS/WS (RF-SSH-004)
      terminalWebSocket = apiClient.createTerminalWebSocket(data.sessionId);
      terminalWebSocket.binaryType = "arraybuffer";

      terminalWebSocket.onopen = () => {
        terminalSessionStatus.className = "badge-status badge-attivo";
        terminalSessionStatus.textContent = "Attivo";
        if (activeFitAddon) {
          const dims = activeFitAddon.proposeDimensions();
          if (dims && dims.cols && dims.rows) {
            activeXterm.resize(dims.cols, dims.rows);
            terminalFooterDims.textContent = `${dims.cols} x ${dims.rows}`;
            terminalWebSocket.send(JSON.stringify({ type: "resize", cols: dims.cols, rows: dims.rows }));
          }
        }
        activeXterm.focus();
      };

      terminalContainer.onclick = () => {
        if (activeXterm) activeXterm.focus();
      };

      terminalWebSocket.onmessage = async (event) => {
        let msg = event.data;
        if (msg instanceof Blob) {
          msg = await msg.arrayBuffer();
        }
        if (msg instanceof ArrayBuffer) {
          activeXterm.write(new Uint8Array(msg));
          return;
        }
        if (typeof msg === "string") {
          if (msg.startsWith("{") && msg.endsWith("}")) {
            try {
              const parsed = JSON.parse(msg);
              if (parsed.type === "session_closed") {
                terminalSessionStatus.className = "badge-status badge-disabilitato";
                terminalSessionStatus.textContent = `Chiuso (${parsed.reason || "terminato"})`;
                activeXterm.writeln(`\r\n\x1b[33m[Connessione terminale chiusa dal server: ${StateFormatter.escapeHtml(parsed.message || parsed.reason)}]\x1b[0m\r\n`);
                return;
              }
              if (parsed.type === "error") {
                terminalSessionStatus.className = "badge-status badge-errore";
                terminalSessionStatus.textContent = "Errore";
                activeXterm.writeln(`\r\n\x1b[31m[Errore: ${StateFormatter.escapeHtml(parsed.message)}]\x1b[0m\r\n`);
                return;
              }
            } catch {}
          }
          activeXterm.write(msg);
        }
      };

      terminalWebSocket.onclose = () => {
        terminalSessionStatus.className = "badge-status badge-disabilitato";
        terminalSessionStatus.textContent = "Connessione Chiusa";
        if (activeXterm) {
          activeXterm.writeln("\r\n\x1b[90m[Canale terminale disconnesso. Cliccare su 'Disconnetti' o riaprire la finestra per una nuova sessione.]\x1b[0m\r\n");
        }
      };

      terminalWebSocket.onerror = () => {
        terminalSessionStatus.className = "badge-status badge-errore";
        terminalSessionStatus.textContent = "Errore Canale";
      };

      activeXterm.onData((inputData) => {
        if (terminalWebSocket && terminalWebSocket.readyState === WebSocket.OPEN) {
          terminalWebSocket.send(inputData);
        }
      });

      activeXterm.onResize(({ cols, rows }) => {
        terminalFooterDims.textContent = `${cols} x ${rows}`;
        if (terminalWebSocket && terminalWebSocket.readyState === WebSocket.OPEN) {
          terminalWebSocket.send(JSON.stringify({ type: "resize", cols, rows }));
        }
      });

    } catch (err) {
      terminalSessionStatus.className = "badge-status badge-errore";
      terminalSessionStatus.textContent = "Errore";
      terminalContainer.innerHTML = ErrorPresenter.renderAlert(err);
    }
  }

  function closeTerminal() {
    if (activeTerminalSessionId && terminalWebSocket && terminalWebSocket.readyState === WebSocket.OPEN) {
      try {
        terminalWebSocket.send(JSON.stringify({ type: "close" }));
      } catch {}
    }

    if (terminalWebSocket) {
      try {
        terminalWebSocket.close();
      } catch {}
      terminalWebSocket = null;
    }

    if (activeXterm) {
      try {
        activeXterm.dispose();
      } catch {}
      activeXterm = null;
      activeFitAddon = null;
    }

    activeTerminalSessionId = null;
    modalTerminal.classList.add("hidden");
    terminalContainer.innerHTML = "";
  }

  btnTerminalDisconnect.addEventListener("click", closeTerminal);
  btnCloseTerminal.addEventListener("click", closeTerminal);

  window.addEventListener("resize", () => {
    if (activeFitAddon && activeXterm && !modalTerminal.classList.contains("hidden")) {
      try {
        activeFitAddon.fit();
      } catch {}
    }
  });

  // =========================================================================
  // OPERAZIONI AGGIUNTIVE DI GESTIONE ROBOT (§8.1..8.4)
  // =========================================================================
  async function reverifyConnection(robotId) {
    showNotification("Verifica connessione SSH in corso verso il robot...", "warning");
    try {
      const res = await apiClient.post(`/api/robots/${encodeURIComponent(robotId)}/verify-connection`, {});
      const data = await res.json();
      if (res.ok && data.success) {
        showNotification("Verifica di connessione SSH completata con successo!", "success");
      } else {
        const formatted = ErrorPresenter.formatError(data);
        showNotification(`Verifica connessione fallita: ${formatted.userMessage}`, "danger");
      }
      openRobotDetail(robotId);
      loadFleetData();
    } catch (err) {
      showNotification(err, "danger");
    }
  }

  async function repairRobotRegistration(robotId) {
    showNotification("Riparazione registrazione in corso...", "warning");
    try {
      const res = await apiClient.post(`/api/robots/${encodeURIComponent(robotId)}/repair`, {});
      const data = await res.json();
      showNotification(`Esito riparazione: ${data.message}`, data.outcome === "registrazione_completata" ? "success" : "warning");
      openRobotDetail(robotId);
      loadFleetData();
    } catch (err) {
      showNotification(err, "danger");
    }
  }

  function openEditModal(robot) {
    document.getElementById("edit-robotId").value = robot.id;
    document.getElementById("edit-displayName").value = robot.displayName;
    document.getElementById("edit-remoteUsername").value = robot.remoteUsername;
    document.getElementById("edit-host").value = robot.host;
    document.getElementById("edit-sshPort").value = robot.sshPort;
    editSelectAuthMethod.value = robot.sshAuthMethod || "password";
    document.getElementById("edit-fingerprint").value = robot.hostKeyVerification?.fingerprint || "";
    document.getElementById("edit-monitoringPath").value = robot.remoteMonitoringPath || "";

    document.getElementById("edit-password").value = "";
    document.getElementById("edit-privateKey").value = "";

    if (robot.sshAuthMethod === "key") {
      editGroupPassword.classList.add("hidden");
      editGroupKey.classList.remove("hidden");
    } else {
      editGroupPassword.classList.remove("hidden");
      editGroupKey.classList.add("hidden");
    }

    modalEdit.classList.remove("hidden");
  }

  editSelectAuthMethod.addEventListener("change", (e) => {
    if (e.target.value === "key") {
      editGroupPassword.classList.add("hidden");
      editGroupKey.classList.remove("hidden");
    } else {
      editGroupPassword.classList.remove("hidden");
      editGroupKey.classList.add("hidden");
    }
  });

  btnCloseEdit.addEventListener("click", () => modalEdit.classList.add("hidden"));
  btnCancelEdit.addEventListener("click", () => modalEdit.classList.add("hidden"));

  formEdit.addEventListener("submit", async (e) => {
    e.preventDefault();
    const robotId = document.getElementById("edit-robotId").value;
    const authMethod = editSelectAuthMethod.value;

    const payload = {
      displayName: document.getElementById("edit-displayName").value.trim(),
      host: document.getElementById("edit-host").value.trim(),
      sshPort: Number(document.getElementById("edit-sshPort").value) || 22,
      sshAuthMethod: authMethod,
      hostKeyVerification: {
        fingerprint: document.getElementById("edit-fingerprint").value.trim() || undefined,
        strictHostKeyChecking: true,
      },
    };

    const pwd = document.getElementById("edit-password").value;
    if (pwd) payload.password = pwd;

    const privKey = document.getElementById("edit-privateKey").value;
    if (privKey) payload.privateKey = privKey;

    const monPath = document.getElementById("edit-monitoringPath").value.trim();
    if (monPath) payload.remoteMonitoringPath = monPath;

    await DoubleSubmitGuard.execute(btnSubmitEdit, "Salvataggio...", async () => {
      try {
        const res = await apiClient.put(`/api/robots/${encodeURIComponent(robotId)}/configuration`, payload);
        const data = await res.json();
        if (!res.ok) {
          const formatted = ErrorPresenter.formatError(data);
          showNotification(`Modifica configurazione fallita: ${formatted.userMessage}`, "danger");
          return;
        }

        document.getElementById("edit-password").value = "";
        document.getElementById("edit-privateKey").value = "";

        modalEdit.classList.add("hidden");
        showNotification("Configurazione aggiornata. Stato di connessione reimpostato su 'non verificato' (§8.3).", "success");
        loadFleetData();
        openRobotDetail(robotId);
      } catch (err) {
        showNotification(err, "danger");
      }
    });
  });

  async function toggleDisableRobot(robotId, disable) {
    const endpoint = disable ? "disable" : "enable";
    try {
      const res = await apiClient.post(`/api/robots/${encodeURIComponent(robotId)}/${endpoint}`, {});
      const data = await res.json();
      if (res.ok) {
        showNotification(data.message, disable ? "warning" : "success");
        openRobotDetail(robotId);
        loadFleetData();
      } else {
        const formatted = ErrorPresenter.formatError(data);
        showNotification(`Operazione fallita: ${formatted.userMessage}`, "danger");
      }
    } catch (err) {
      showNotification(err, "danger");
    }
  }

  function promptRemoveRobot(robotId, displayName) {
    pendingRemoveRobotId = robotId;
    removeRobotNameEl.textContent = `${displayName} (${robotId})`;
    modalRemoveConfirm.classList.remove("hidden");
  }

  btnCancelRemove.addEventListener("click", () => {
    modalRemoveConfirm.classList.add("hidden");
    pendingRemoveRobotId = null;
  });

  btnConfirmRemove.addEventListener("click", async () => {
    if (!pendingRemoveRobotId) return;
    const robotId = pendingRemoveRobotId;
    await DoubleSubmitGuard.execute(btnConfirmRemove, "Rimozione...", async () => {
      try {
        const res = await apiClient.post(`/api/robots/${encodeURIComponent(robotId)}/remove`, { confirmation: true });
        const data = await res.json();
        modalRemoveConfirm.classList.add("hidden");
        pendingRemoveRobotId = null;

        if (res.ok) {
          showNotification("Robot rimosso dall'anagrafica attiva con successo. File e cartelle preservati.", "success");
          loadFleetData();
        } else {
          const formatted = ErrorPresenter.formatError(data);
          showNotification(`Rimozione fallita: ${formatted.userMessage}`, "danger");
        }
      } catch (err) {
        showNotification(err, "danger");
      }
    });
  });

  // =========================================================================
  // NAVIGAZIONE FILESYSTEM SERVER (RF-SRVFS-002, RF-TRF-001, RF-TRF-002)
  // =========================================================================
  async function loadServerFilesystem(robotId, relativePath = "") {
    fsError.classList.add("hidden");
    fsTableBody.innerHTML = '<tr><td colspan="5" class="fs-empty-msg">Caricamento in corso...</td></tr>';

    try {
      const url = `/api/robots/${encodeURIComponent(robotId)}/fs/server/list?path=${encodeURIComponent(relativePath)}`;
      const res = await apiClient.get(url);
      const data = await res.json();

      if (!res.ok) {
        const formatted = ErrorPresenter.formatError(data);
        fsError.innerHTML = ErrorPresenter.renderAlert(formatted);
        fsError.classList.remove("hidden");
        fsTableBody.innerHTML = '<tr><td colspan="5" class="fs-empty-msg">Errore durante la lettura della directory server.</td></tr>';
        return;
      }

      currentFsPath = data.currentPath || "";
      fsCurrentPathEl.textContent = `/${currentFsPath}`;

      if (!data.items || data.items.length === 0) {
        fsTableBody.innerHTML = '<tr><td colspan="5" class="fs-empty-msg">Directory vuota.</td></tr>';
        return;
      }

      fsTableBody.innerHTML = "";
      for (const item of data.items) {
        const tr = document.createElement("tr");

        const typeTd = document.createElement("td");
        typeTd.textContent = item.type === "directory" ? "📁 [DIR]" : "📄 [FILE]";
        tr.appendChild(typeTd);

        const nameTd = document.createElement("td");
        if (item.type === "directory") {
          const a = document.createElement("span");
          a.className = "fs-item-dir";
          a.textContent = item.name;
          a.addEventListener("click", () => {
            const nextPath = currentFsPath ? `${currentFsPath}/${item.name}` : item.name;
            loadServerFilesystem(robotId, nextPath);
          });
          nameTd.appendChild(a);
        } else {
          nameTd.textContent = item.name;
        }
        tr.appendChild(nameTd);

        const sizeTd = document.createElement("td");
        sizeTd.textContent = StateFormatter.formatBytes(item.size);
        tr.appendChild(sizeTd);

        const dateTd = document.createElement("td");
        dateTd.textContent = StateFormatter.formatDate(item.modifiedAt);
        tr.appendChild(dateTd);

        // Azioni Trasferimento
        const actionsTd = document.createElement("td");
        actionsTd.className = "fs-actions-cell";
        if (item.type === "file") {
          const btnGroup = document.createElement("div");
          btnGroup.className = "fs-action-btn-group";

          const btnDownload = document.createElement("button");
          btnDownload.className = "btn btn-secondary btn-sm transfer-action-btn";
          btnDownload.textContent = "⬇️ Scarica";
          btnDownload.title = "Scarica file sul computer locale (RF-TRF-001)";
          btnDownload.addEventListener("click", () => {
            const relPath = currentFsPath ? `${currentFsPath}/${item.name}` : item.name;
            downloadServerFile(robotId, relPath);
          });
          btnGroup.appendChild(btnDownload);

          const btnSendToRobot = document.createElement("button");
          btnSendToRobot.className = "btn btn-secondary btn-sm transfer-action-btn";
          btnSendToRobot.textContent = "➡️ Invia al Robot";
          btnSendToRobot.title = "Trasferisci file dal server al filesystem remoto del robot (RF-TRF-002)";
          btnSendToRobot.addEventListener("click", async () => {
            const relPath = currentFsPath ? `${currentFsPath}/${item.name}` : item.name;
            await DoubleSubmitGuard.execute(btnSendToRobot, "Avvio...", () => transferServerToRobot(robotId, relPath, item.name));
          });
          btnGroup.appendChild(btnSendToRobot);

          const btnDelete = document.createElement("button");
          btnDelete.className = "btn btn-danger btn-sm transfer-action-btn";
          btnDelete.textContent = "🗑️ Elimina";
          btnDelete.title = "Elimina file definitivamente dal server (RNF-FS-003, RF-ROB-013)";
          btnDelete.addEventListener("click", () => {
            const relPath = currentFsPath ? `${currentFsPath}/${item.name}` : item.name;
            requestDeleteServerFile(robotId, relPath, item.name);
          });
          btnGroup.appendChild(btnDelete);

          actionsTd.appendChild(btnGroup);
        }
        tr.appendChild(actionsTd);

        fsTableBody.appendChild(tr);
      }
    } catch (err) {
      fsError.innerHTML = ErrorPresenter.renderAlert(err);
      fsError.classList.remove("hidden");
      fsTableBody.innerHTML = '<tr><td colspan="5" class="fs-empty-msg">Errore di connessione.</td></tr>';
    }
  }

  btnFsLoad.addEventListener("click", async () => {
    const robotId = fsRobotIdInput.value.trim();
    if (robotId) {
      await DoubleSubmitGuard.execute(btnFsLoad, "Caricamento...", () => loadServerFilesystem(robotId, ""));
    }
  });

  btnFsUp.addEventListener("click", () => {
    const robotId = fsRobotIdInput.value.trim();
    if (!robotId || !currentFsPath) return;
    const segments = currentFsPath.split("/").filter(Boolean);
    segments.pop();
    const parentPath = segments.join("/");
    loadServerFilesystem(robotId, parentPath);
  });

  btnFsServerUpload?.addEventListener("click", () => {
    const robotId = fsRobotIdInput.value.trim();
    if (!robotId) {
      showNotification("Selezionare o specificare prima l'ID del robot per il filesystem server.", "warning");
      return;
    }
    fsServerFileInput.click();
  });

  fsServerFileInput?.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const robotId = fsRobotIdInput.value.trim();
    uploadClientToServer(robotId, currentFsPath, file);
    fsServerFileInput.value = "";
  });

  // =========================================================================
  // TAB CONTROLS FILESYSTEM (SERVER VS REMOTO VS TRASFERIMENTI)
  // =========================================================================
  btnTabFsServer?.addEventListener("click", () => {
    btnTabFsServer.classList.add("active");
    btnTabFsRemote.classList.remove("active");
    btnTabTransfers.classList.remove("active");
    fsPanelServer?.classList.remove("hidden");
    fsPanelRemote?.classList.add("hidden");
    fsPanelTransfers?.classList.add("hidden");
  });

  btnTabFsRemote?.addEventListener("click", () => {
    btnTabFsRemote.classList.add("active");
    btnTabFsServer.classList.remove("active");
    btnTabTransfers.classList.remove("active");
    fsPanelRemote?.classList.remove("hidden");
    fsPanelServer?.classList.add("hidden");
    fsPanelTransfers?.classList.add("hidden");
  });

  btnTabTransfers?.addEventListener("click", () => {
    btnTabTransfers.classList.add("active");
    btnTabFsServer.classList.remove("active");
    btnTabFsRemote.classList.remove("active");
    fsPanelTransfers?.classList.remove("hidden");
    fsPanelServer?.classList.add("hidden");
    fsPanelRemote?.classList.add("hidden");
    loadTransfersList();
  });

  // =========================================================================
  // NAVIGAZIONE FILESYSTEM REMOTO ROBOT VIA SFTP (RF-FS-001..007, CA-FS-001)
  // =========================================================================
  async function loadRemoteFilesystem(robotId, targetPath = "") {
    fsRemoteError.classList.add("hidden");
    fsRemoteTableBody.innerHTML = '<tr><td colspan="5" class="fs-empty-msg">Caricamento directory remota via SFTP in corso...</td></tr>';

    try {
      const url = `/api/robots/${encodeURIComponent(robotId)}/fs/remote/list?path=${encodeURIComponent(targetPath)}`;
      const res = await apiClient.get(url);
      const data = await res.json();

      if (!res.ok) {
        const formatted = ErrorPresenter.formatError(data);
        fsRemoteError.innerHTML = ErrorPresenter.renderAlert(formatted);
        fsRemoteError.classList.remove("hidden");
        fsRemoteTableBody.innerHTML = '<tr><td colspan="5" class="fs-empty-msg">Errore durante la lettura della directory remota.</td></tr>';
        return;
      }

      currentRemoteFsPath = data.currentPath || "/";
      currentRemoteParentPath = data.parentPath;
      fsRemoteCurrentPathEl.textContent = currentRemoteFsPath;

      if (!data.items || data.items.length === 0) {
        fsRemoteTableBody.innerHTML = '<tr><td colspan="5" class="fs-empty-msg">Directory remota vuota.</td></tr>';
        return;
      }

      fsRemoteTableBody.innerHTML = "";
      for (const item of data.items) {
        const tr = document.createElement("tr");

        // Tipo (RF-FS-002)
        const typeTd = document.createElement("td");
        if (item.type === "directory") {
          typeTd.innerHTML = '<span class="badge-status badge-attivo">📁 [DIR]</span>';
        } else if (item.type === "link") {
          typeTd.innerHTML = '<span class="badge-status badge-avviso fs-item-link">🔗 [LINK]</span>';
        } else if (item.type === "special") {
          typeTd.innerHTML = '<span class="badge-status badge-avviso fs-item-special">⚙️ [SPECIAL]</span>';
        } else {
          typeTd.innerHTML = '<span class="badge-status badge-raggiungibile">📄 [FILE]</span>';
        }
        tr.appendChild(typeTd);

        // Nome
        const nameTd = document.createElement("td");
        if (item.type === "directory") {
          const a = document.createElement("span");
          a.className = "fs-item-dir";
          a.textContent = item.name;
          a.title = "Apri directory";
          a.addEventListener("click", () => {
            const nextPath = currentRemoteFsPath.endsWith("/")
              ? `${currentRemoteFsPath}${item.name}`
              : `${currentRemoteFsPath}/${item.name}`;
            loadRemoteFilesystem(robotId, nextPath);
          });
          nameTd.appendChild(a);
        } else {
          nameTd.textContent = item.name;
        }
        tr.appendChild(nameTd);

        // Dimensione
        const sizeTd = document.createElement("td");
        sizeTd.textContent = item.size !== null ? StateFormatter.formatBytes(item.size) : "-";
        tr.appendChild(sizeTd);

        // Data Modifica
        const dateTd = document.createElement("td");
        dateTd.textContent = item.modifiedAt ? StateFormatter.formatDate(item.modifiedAt) : "non disponibile";
        tr.appendChild(dateTd);

        // Azioni Trasferimento
        const actionsTd = document.createElement("td");
        actionsTd.className = "fs-actions-cell";
        if (item.type === "file") {
          const btnGroup = document.createElement("div");
          btnGroup.className = "fs-action-btn-group";

          const btnDownload = document.createElement("button");
          btnDownload.className = "btn btn-secondary btn-sm transfer-action-btn";
          btnDownload.textContent = "⬇️ Scarica";
          btnDownload.title = "Scarica file direttamente dal robot al computer (RF-TRF-003)";
          btnDownload.addEventListener("click", () => {
            const remotePath = currentRemoteFsPath.endsWith("/")
              ? `${currentRemoteFsPath}${item.name}`
              : `${currentRemoteFsPath}/${item.name}`;
            downloadRobotFile(robotId, remotePath);
          });
          btnGroup.appendChild(btnDownload);

          const btnCopyToSrv = document.createElement("button");
          btnCopyToSrv.className = "btn btn-secondary btn-sm transfer-action-btn";
          btnCopyToSrv.textContent = "⬅️ Copia su Server";
          btnCopyToSrv.title = "Trasferisci file dal robot al filesystem locale del server (RF-TRF-002)";
          btnCopyToSrv.addEventListener("click", async () => {
            const remotePath = currentRemoteFsPath.endsWith("/")
              ? `${currentRemoteFsPath}${item.name}`
              : `${currentRemoteFsPath}/${item.name}`;
            await DoubleSubmitGuard.execute(btnCopyToSrv, "Avvio...", () => transferRobotToServer(robotId, remotePath, item.name));
          });
          btnGroup.appendChild(btnCopyToSrv);

          const btnDelete = document.createElement("button");
          btnDelete.className = "btn btn-danger btn-sm transfer-action-btn";
          btnDelete.textContent = "🗑️ Elimina";
          btnDelete.title = "Elimina file definitivamente dal robot (RF-FS-007, RNF-FS-003, RF-ROB-013)";
          btnDelete.addEventListener("click", () => {
            const remotePath = currentRemoteFsPath.endsWith("/")
              ? `${currentRemoteFsPath}${item.name}`
              : `${currentRemoteFsPath}/${item.name}`;
            requestDeleteRemoteFile(robotId, remotePath, item.name);
          });
          btnGroup.appendChild(btnDelete);

          actionsTd.appendChild(btnGroup);
        }
        tr.appendChild(actionsTd);

        fsRemoteTableBody.appendChild(tr);
      }

      if (data.truncated || data.isTruncated) {
        const count = data.items ? data.items.length : 0;
        const truncTr = document.createElement("tr");
        truncTr.innerHTML = `<td colspan="5" style="text-align: center; color: #b06000; font-size: 0.85rem; font-weight: bold; background-color: #fff9e6;">⚠️ elenco incompleto: ${count} elementi mostrati</td>`;
        fsRemoteTableBody.appendChild(truncTr);
      }
    } catch (err) {
      fsRemoteError.innerHTML = ErrorPresenter.renderAlert(err);
      fsRemoteError.classList.remove("hidden");
      fsRemoteTableBody.innerHTML = '<tr><td colspan="5" class="fs-empty-msg">Errore di comunicazione.</td></tr>';
    }
  }

  btnFsRemoteLoad?.addEventListener("click", async () => {
    const robotId = fsRemoteRobotIdInput.value.trim();
    if (robotId) {
      await DoubleSubmitGuard.execute(btnFsRemoteLoad, "Caricamento...", () => loadRemoteFilesystem(robotId, ""));
    }
  });

  btnFsRemoteUp?.addEventListener("click", () => {
    const robotId = fsRemoteRobotIdInput.value.trim();
    if (!robotId || !currentRemoteParentPath) return;
    loadRemoteFilesystem(robotId, currentRemoteParentPath);
  });

  btnFsRemoteUpload?.addEventListener("click", () => {
    const robotId = fsRemoteRobotIdInput.value.trim();
    if (!robotId) {
      showNotification("Selezionare o specificare prima l'ID del robot per il filesystem remoto.", "warning");
      return;
    }
    fsRemoteFileInput.click();
  });

  fsRemoteFileInput?.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const robotId = fsRemoteRobotIdInput.value.trim();
    fsRemoteFileInput.value = "";
    uploadClientToRobot(robotId, currentRemoteFsPath, file);
  });

  // =========================================================================
  // SERVIZIO TRASFERIMENTO FILE E MONITORAGGIO STREAMING (RF-TRF-001..014)
  // =========================================================================
  function promptOverwriteConfirmation(targetDescription, onConfirm) {
    overwriteFileTarget.textContent = targetDescription;
    pendingOverwriteCallback = onConfirm;
    modalConfirmOverwrite.classList.remove("hidden");
  }

  function closeOverwriteModal() {
    modalConfirmOverwrite.classList.add("hidden");
    pendingOverwriteCallback = null;
  }

  btnCloseOverwrite?.addEventListener("click", closeOverwriteModal);
  btnCancelOverwrite?.addEventListener("click", closeOverwriteModal);
  btnConfirmOverwrite?.addEventListener("click", () => {
    if (pendingOverwriteCallback) {
      const cb = pendingOverwriteCallback;
      closeOverwriteModal();
      cb();
    }
  });

  // Eliminazione File dal Server (RNF-FS-003, RF-ROB-013)
  function requestDeleteServerFile(robotId, relPath, filename) {
    deleteFileTarget.textContent = `${filename} (${relPath})`;
    pendingDeleteCallback = async () => {
      showNotification(`Eliminazione di '${filename}' in corso...`, "info");
      try {
        const res = await apiClient.delete(
          `/api/robots/${encodeURIComponent(robotId)}/fs/server/file?path=${encodeURIComponent(relPath)}`
        );
        const data = await res.json();
        if (!res.ok) {
          showNotification(data, "danger");
        } else {
          showNotification(data.message || `File '${filename}' eliminato con successo.`, "success");
          loadServerFilesystem(robotId, currentFsPath);
        }
      } catch (err) {
        showNotification(err, "danger");
      }
    };
    modalConfirmDelete.classList.remove("hidden");
  }

  // Eliminazione File dal Robot (RF-FS-007, RNF-FS-003, RF-ROB-013)
  function requestDeleteRemoteFile(robotId, remotePath, filename) {
    deleteFileTarget.textContent = `${filename} (${remotePath}) [ROBOT: ${robotId}]`;
    pendingDeleteCallback = async () => {
      showNotification(`Eliminazione di '${filename}' dal robot in corso...`, "info");
      try {
        const res = await apiClient.delete(
          `/api/robots/${encodeURIComponent(robotId)}/fs/remote/file?path=${encodeURIComponent(remotePath)}`
        );
        const data = await res.json();
        if (!res.ok) {
          showNotification(data, "danger");
        } else {
          showNotification(data.message || `File '${filename}' eliminato con successo dal robot.`, "success");
          loadRemoteFilesystem(robotId, currentRemoteFsPath);
        }
      } catch (err) {
        showNotification(err, "danger");
      }
    };
    modalConfirmDelete.classList.remove("hidden");
  }

  function closeDeleteModal() {
    modalConfirmDelete.classList.add("hidden");
    pendingDeleteCallback = null;
  }

  btnCloseDelete?.addEventListener("click", closeDeleteModal);
  btnCancelDelete?.addEventListener("click", closeDeleteModal);
  btnConfirmDelete?.addEventListener("click", () => {
    if (pendingDeleteCallback) {
      const cb = pendingDeleteCallback;
      closeDeleteModal();
      cb();
    }
  });

  // Download Server -> Client (RF-TRF-001)
  function downloadServerFile(robotId, relativePath) {
    const filename = relativePath.split("/").pop() || "download";
    showNotification(`Avvio download di '${filename}' in streaming...`, "info");
    const downloadUrl = `/api/robots/${encodeURIComponent(robotId)}/transfers/client-server/download?path=${encodeURIComponent(relativePath)}`;
    const a = document.createElement("a");
    a.href = downloadUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(loadTransfersList, 1000);
  }

  // Download Robot -> Client (RF-TRF-003)
  function downloadRobotFile(robotId, remotePath) {
    const filename = remotePath.split("/").pop() || "download";
    showNotification(`Avvio download dal robot per '${filename}' in streaming...`, "info");
    const downloadUrl = `/api/robots/${encodeURIComponent(robotId)}/transfers/client-robot/download?path=${encodeURIComponent(remotePath)}`;
    const a = document.createElement("a");
    a.href = downloadUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(loadTransfersList, 1000);
  }

  // Upload Client -> Server (RF-TRF-001)
  async function uploadClientToServer(robotId, subPath, file, overwrite = false) {
    showNotification(`Caricamento sul server di '${file.name}' in corso...`, "info");
    try {
      const res = await apiClient.post(
        `/api/robots/${encodeURIComponent(robotId)}/transfers/client-server/upload`,
        file,
        {
          headers: {
            "Content-Type": "application/octet-stream",
            "X-Filename": file.name,
            "X-Subpath": subPath || "",
            "X-Overwrite": overwrite ? "true" : "false",
          },
        }
      );

      const data = await res.json();
      if (!res.ok) {
        if (!overwrite && data.message && (data.message.includes("conferma esplicita") || (data.message.includes("già esistente") && !data.message.includes("categoricamente")))) {
          promptOverwriteConfirmation(`Server: ${subPath ? subPath + '/' : ''}${file.name}`, () => {
            uploadClientToServer(robotId, subPath, file, true);
          });
          return;
        }
        showNotification(data, "danger");
        return;
      }

      showNotification(`Upload completato con successo: ${file.name}`, "success");
      loadServerFilesystem(robotId, subPath);
      loadTransfersList();
    } catch (err) {
      showNotification(err, "danger");
    }
  }

  let activeUploadController = null;
  let activeUploadCancelled = false;
  let activeUploadRetryTimeout = null;
  const cancelledTransferIds = new Set();

  function cancelActiveUpload() {
    activeUploadCancelled = true;
    if (activeUploadRetryTimeout) {
      clearTimeout(activeUploadRetryTimeout);
      activeUploadRetryTimeout = null;
    }
    if (activeUploadController) {
      try { activeUploadController.abort(); } catch {}
      activeUploadController = null;
    }
  }

  window.addEventListener("beforeunload", () => {
    cancelActiveUpload();
  });

  // Upload Client -> Robot (RF-TRF-003)
  async function uploadClientToRobot(robotId, remoteDir, file, overwrite = false, retryCount = 0) {
    if (activeUploadRetryTimeout) {
      clearTimeout(activeUploadRetryTimeout);
      activeUploadRetryTimeout = null;
    }
    activeUploadCancelled = false;
    activeUploadController = new AbortController();
    showNotification(`Caricamento verso il robot di '${file.name}' in corso...`, "info");
    try {
      const res = await apiClient.post(
        `/api/robots/${encodeURIComponent(robotId)}/transfers/client-robot/upload`,
        file,
        {
          signal: activeUploadController.signal,
          headers: {
            "Content-Type": "application/octet-stream",
            "X-Filename": file.name,
            "X-Remote-Dir": remoteDir || "",
            "X-Overwrite": overwrite ? "true" : "false",
          },
        }
      );

      const data = await res.json();
      if (!res.ok) {
        if (!overwrite && data.message && (data.message.includes("conferma esplicita") || (data.message.includes("già esistente") && !data.message.includes("categoricamente")))) {
          promptOverwriteConfirmation(`Robot: ${remoteDir ? remoteDir + '/' : ''}${file.name}`, () => {
            uploadClientToRobot(robotId, remoteDir, file, true);
          });
          return;
        }
        showNotification(data, "danger");
        return;
      }

      showNotification(`Upload verso il robot completato: ${file.name}`, "success");
      loadRemoteFilesystem(robotId, remoteDir);
      loadTransfersList();
    } catch (err) {
      if (activeUploadCancelled || err.name === "AbortError" || String(err.message || "").toLowerCase().includes("annullato")) {
        showNotification(`Trasferimento di '${file.name}' annullato dall'utente.`, "warning");
        loadTransfersList();
        loadRemoteFilesystem(robotId, remoteDir);
        return;
      }

      // Riscaricamento / ritentativo automatico SOLO su fallimento non intenzionale (MAI se annullato!)
      if (!activeUploadCancelled && retryCount < 1) {
        showNotification(`Trasferimento non riuscito per errore di connessione. Tentativo di riscaricamento automatico in corso (tentativo 1 di 1)...`, "warning");
        activeUploadRetryTimeout = setTimeout(() => {
          activeUploadRetryTimeout = null;
          if (!activeUploadCancelled) {
            uploadClientToRobot(robotId, remoteDir, file, overwrite, retryCount + 1);
          }
        }, 2000);
        return;
      }

      showNotification(err, "danger");
      loadTransfersList();
      loadRemoteFilesystem(robotId, remoteDir);
    } finally {
      activeUploadController = null;
    }
  }

  // Trasferimento Server -> Robot (RF-TRF-002)
  async function transferServerToRobot(robotId, serverRelativePath, filename, overwrite = false) {
    showNotification(`Avvio trasferimento da server a robot per '${filename}'...`, "info");
    try {
      const res = await apiClient.post(
        `/api/robots/${encodeURIComponent(robotId)}/transfers/server-robot`,
        {
          direction: "SERVER_TO_ROBOT",
          serverRelativePath,
          remotePath: filename,
          overwrite,
        }
      );

      const data = await res.json();
      if (!res.ok) {
        if (!overwrite && data.message && (data.message.includes("conferma esplicita") || (data.message.includes("già esistente") && !data.message.includes("categoricamente")))) {
          promptOverwriteConfirmation(`Robot: ${filename}`, () => {
            transferServerToRobot(robotId, serverRelativePath, filename, true);
          });
          return;
        }
        showNotification(data, "danger");
        return;
      }

      showNotification(`Trasferimento avviato con successo: ${filename}`, "success");
      loadTransfersList();
    } catch (err) {
      showNotification(err, "danger");
    }
  }

  // Trasferimento Robot -> Server (RF-TRF-002)
  async function transferRobotToServer(robotId, remotePath, filename, overwrite = false) {
    showNotification(`Avvio trasferimento da robot a server per '${filename}'...`, "info");
    try {
      const res = await apiClient.post(
        `/api/robots/${encodeURIComponent(robotId)}/transfers/server-robot`,
        {
          direction: "ROBOT_TO_SERVER",
          serverRelativePath: filename,
          remotePath,
          overwrite,
        }
      );

      const data = await res.json();
      if (!res.ok) {
        if (!overwrite && data.message && (data.message.includes("conferma esplicita") || (data.message.includes("già esistente") && !data.message.includes("categoricamente")))) {
          promptOverwriteConfirmation(`Server: ${filename}`, () => {
            transferRobotToServer(robotId, remotePath, filename, true);
          });
          return;
        }
        showNotification(data, "danger");
        return;
      }

      showNotification(`Trasferimento da robot a server completato: ${filename}`, "success");
      loadTransfersList();
    } catch (err) {
      showNotification(err, "danger");
    }
  }

  // Polling e avanzamento trasferimenti (RF-TRF-006, CA-TRF-002)
  async function loadTransfersList() {
    const robotId = fsRobotIdInput.value.trim() || fsRemoteRobotIdInput.value.trim();
    if (!robotId) return;

    try {
      const res = await apiClient.get(`/api/robots/${encodeURIComponent(robotId)}/transfers`);
      if (!res.ok) return;
      const list = await res.json();

      let activeCount = 0;
      if (!list || list.length === 0) {
        transfersEmptyMsg.classList.remove("hidden");
        transfersList.innerHTML = "";
      } else {
        transfersEmptyMsg.classList.add("hidden");
        transfersList.innerHTML = "";

        for (const trf of list) {
          if (trf.status === "IN_PROGRESS" || trf.status === "QUEUED" || trf.status === "INTEGRITY_CHECKING") {
            activeCount++;
          }

          const card = document.createElement("div");
          card.className = "transfer-card";

          const dirLabels = {
            CLIENT_TO_SERVER: "💻 Computer ➔ 🗄️ Server",
            SERVER_TO_CLIENT: "🗄️ Server ➔ 💻 Computer",
            SERVER_TO_ROBOT: "🗄️ Server ➔ 🌐 Robot",
            ROBOT_TO_SERVER: "🌐 Robot ➔ 🗄️ Server",
            CLIENT_TO_ROBOT: "💻 Computer ➔ 🌐 Robot",
            ROBOT_TO_CLIENT: "🌐 Robot ➔ 💻 Computer",
          };

          const statusLabels = {
            IN_PROGRESS: "In corso",
            COMPLETED: "Completato",
            FAILED: "Fallito",
            CANCELLED: "Annullato",
            QUEUED: "In attesa",
            INTEGRITY_CHECKING: "Verifica integrità",
            INTEGRITY_FAILED: "Verifica fallita",
          };

          const percent = trf.percent !== null ? `${trf.percent}%` : "-";
          const speed = trf.speedBytesPerSec ? `${StateFormatter.formatBytes(trf.speedBytesPerSec)}/s` : "";
          const eta = trf.etaSeconds !== null ? `ETA: ${trf.etaSeconds}s` : "";

          card.innerHTML = `
            <div class="transfer-card-header">
              <div class="transfer-card-title">
                <span class="transfer-direction-badge">${dirLabels[trf.direction] || trf.direction}</span>
                <span>${StateFormatter.escapeHtml(trf.filename)}</span>
              </div>
              <div style="display: flex; align-items: center; gap: 0.5rem;">
                <span class="transfer-status-badge transfer-status-${trf.status}">${statusLabels[trf.status] || trf.status}</span>
                ${(trf.status === "IN_PROGRESS" || trf.status === "QUEUED") ? `<button class="btn btn-danger btn-sm transfer-action-btn btn-cancel-trf" data-id="${trf.transferId}">Annulla</button>` : ''}
              </div>
            </div>
            <div class="transfer-progress-bar-bg">
              <div class="transfer-progress-bar-fill ${trf.status.toLowerCase()}" style="width: ${trf.percent || (trf.status === 'COMPLETED' ? 100 : 0)}%;"></div>
            </div>
            <div class="transfer-card-stats">
              <span>${StateFormatter.formatBytes(trf.transferredBytes)} / ${trf.totalBytes ? StateFormatter.formatBytes(trf.totalBytes) : 'dim. sconosciuta'} (${percent})</span>
              <span>${speed} ${eta ? '| ' + eta : ''}</span>
              ${trf.integrityLabel ? `<span class="transfer-integrity-badge" style="font-weight: 500; color: #1e40af;">🛡️ ${StateFormatter.escapeHtml(trf.integrityLabel)}</span>` : ''}
              ${trf.checksum ? `<span title="Checksum ${trf.checksumAlgorithm || ''}">Digest: ${trf.checksum.substring(0, 10)}...</span>` : ''}
              ${trf.error ? `<span style="color: #dc2626; width: 100%; margin-top: 0.25rem;">Errore: ${StateFormatter.escapeHtml(trf.error)}</span>` : ''}
            </div>
          `;

          const cancelBtn = card.querySelector(".btn-cancel-trf");
          if (cancelBtn) {
            cancelBtn.addEventListener("click", async () => {
              if (confirm("Vuoi davvero annullare questo trasferimento?")) {
                await DoubleSubmitGuard.execute(cancelBtn, "Annullamento...", async () => {
                  cancelledTransferIds.add(trf.transferId);
                  cancelActiveUpload();
                  await apiClient.post(`/api/transfers/${encodeURIComponent(trf.transferId)}/cancel`, {});
                  loadTransfersList();
                  const currentRobotId = fsRobotIdInput.value.trim() || fsRemoteRobotIdInput.value.trim();
                  if (currentRobotId) {
                    loadRemoteFilesystem(currentRobotId, currentRemoteFsPath);
                  }
                });
              }
            });
          }

          transfersList.appendChild(card);
        }
      }

      transfersActiveCount.textContent = activeCount;

      // Gestione dinamica dell'intervallo di polling configurabile (PROPOSTA DA CONFERMARE, default 1000ms)
      const pollMs = window.MOLIRIS_TRANSFER_POLL_INTERVAL_MS || 1000;
      if (activeCount > 0 && !transfersPollingInterval) {
        transfersPollingInterval = setInterval(loadTransfersList, pollMs);
      } else if (activeCount === 0 && transfersPollingInterval) {
        clearInterval(transfersPollingInterval);
        transfersPollingInterval = null;
      }
    } catch {}
  }

  btnRefreshTransfers?.addEventListener("click", async () => {
    await DoubleSubmitGuard.execute(btnRefreshTransfers, "Aggiornamento...", loadTransfersList);
  });

  // Bonifica file temporanei dal robot e server selezionato (RF-TRF-009, CA-TRF-005)
  btnFsRemotePurge?.addEventListener("click", async () => {
    const robotId = fsRemoteRobotIdInput.value.trim();
    if (!robotId) {
      showNotification("Specificare prima l'ID del robot per la bonifica.", "warning");
      return;
    }
    if (confirm(`Confermi l'eliminazione definitiva di tutti i file temporanei orfani (.tmp_moliris_*) dal robot '${robotId}' e dal server?`)) {
      await DoubleSubmitGuard.execute(btnFsRemotePurge, "Bonifica in corso...", async () => {
        try {
          const res = await apiClient.post(`/api/robots/${encodeURIComponent(robotId)}/fs/cleanup-temp`, {});
          const data = await res.json();
          if (res.ok) {
            showNotification(data.message || `Bonifica completata: eliminati ${data.purgedCount} file temporanei (${StateFormatter.formatBytes(data.freedBytes)} liberati).`, "success");
            loadRemoteFilesystem(robotId, currentRemoteFsPath);
            loadServerFilesystem(robotId, currentFsPath);
          } else {
            showNotification(data, "danger");
          }
        } catch (err) {
          showNotification(err, "danger");
        }
      });
    }
  });

  // Bonifica file temporanei globale da TUTTI i robot e server (Amministratore)
  btnPurgeTransfersTemp?.addEventListener("click", async () => {
    if (confirm("Confermi l'eliminazione definitiva di tutti i file temporanei (.tmp_moliris_*) da TUTTI i robot della flotta e dal server?")) {
      await DoubleSubmitGuard.execute(btnPurgeTransfersTemp, "Bonifica in corso...", async () => {
        try {
          const res = await apiClient.post("/api/fs/cleanup-temp-all", {});
          const data = await res.json();
          if (res.ok) {
            showNotification(data.message || `Bonifica globale completata: eliminati ${data.totalPurged} file temporanei (${StateFormatter.formatBytes(data.totalFreedBytes)} liberati).`, "success");
            const currentRobotId = fsRobotIdInput.value.trim() || fsRemoteRobotIdInput.value.trim();
            if (currentRobotId) {
              loadRemoteFilesystem(currentRobotId, currentRemoteFsPath);
              loadServerFilesystem(currentRobotId, currentFsPath);
            }
            loadTransfersList();
          } else {
            showNotification(data, "danger");
          }
        } catch (err) {
          showNotification(err, "danger");
        }
      });
    }
  });

  // Avvio controllo sessione iniziale
  initSession();
});
