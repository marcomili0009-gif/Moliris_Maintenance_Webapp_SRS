// Requisiti: SRS §2.5 (Google Chrome), §5.1, §6.1 punti 1–5, §6.2, §6.3, §8.1..8.4, §9,
// RF-AUTH-001..006, RF-ROB-001..014, RNF-UX-001..003

document.addEventListener("DOMContentLoaded", () => {
  // Elementi Login e Dashboard
  const loginSection = document.getElementById("login-section");
  const dashboardSection = document.getElementById("dashboard-section");
  const loginForm = document.getElementById("login-form");
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

  let sessionToken = sessionStorage.getItem("moliris_token") || null;
  let currentUser = null;

  function showNotification(message, type = "warning") {
    notificationBanner.textContent = message;
    notificationBanner.className = `banner banner-${type}`;
    notificationBanner.classList.remove("hidden");
  }

  function hideNotification() {
    notificationBanner.classList.add("hidden");
  }

  function showLoginView() {
    dashboardSection.classList.add("hidden");
    loginSection.classList.remove("hidden");
    loginError.classList.add("hidden");
    sessionStorage.removeItem("moliris_token");
    sessionToken = null;
    currentUser = null;
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

  async function apiRequest(endpoint, options = {}) {
    const headers = options.headers || {};
    if (sessionToken) {
      headers["Authorization"] = `Bearer ${sessionToken}`;
    }
    if (!headers["Content-Type"] && !(options.body instanceof FormData)) {
      headers["Content-Type"] = "application/json";
    }

    try {
      const response = await fetch(endpoint, {
        ...options,
        headers,
      });

      if (response.status === 401) {
        showLoginView();
        showNotification("La sessione è scaduta o non valida. Effettuare nuovamente il login.");
        throw new Error("UNAUTHORIZED");
      }

      return response;
    } catch (err) {
      if (err.message !== "UNAUTHORIZED") {
        console.error("Errore di rete o connessione:", err);
      }
      throw err;
    }
  }

  // Verifica sessione all'avvio
  async function initSession() {
    if (!sessionToken) {
      showLoginView();
      return;
    }

    try {
      const res = await apiRequest("/api/auth/me");
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

  // Gestione Login (RF-AUTH-001, §6.1)
  loginForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    hideNotification();
    loginError.classList.add("hidden");

    const username = document.getElementById("username").value.trim();
    const password = document.getElementById("password").value;

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();

      if (!res.ok) {
        loginError.textContent = data.message || "Credenziali di accesso non valide.";
        loginError.classList.remove("hidden");
        return;
      }

      sessionToken = data.sessionToken;
      sessionStorage.setItem("moliris_token", sessionToken);
      showDashboardView(data.user);
      document.getElementById("password").value = "";
    } catch (err) {
      loginError.textContent = "Errore di connessione verso il server sicuro HTTPS.";
      loginError.classList.remove("hidden");
    }
  });

  // Gestione Logout (RF-AUTH-004)
  btnLogout.addEventListener("click", async () => {
    try {
      await apiRequest("/api/auth/logout", { method: "POST" });
    } catch {}
    showLoginView();
    showNotification("Disconnessione effettuata con successo.", "warning");
  });

  function formatDate(isoDate) {
    if (!isoDate) return "-";
    const d = new Date(isoDate);
    return d.toLocaleString("it-IT");
  }

  function formatBytes(bytes) {
    if (bytes === null || bytes === undefined) return "-";
    if (bytes < 1024) return `${bytes} B`;
    const kb = bytes / 1024;
    if (kb < 1024) return `${kb.toFixed(1)} KB`;
    const mb = kb / 1024;
    return `${mb.toFixed(1)} MB`;
  }

  // =========================================================================
  // STEP 1 – CARICAMENTO E RENDERING LISTA FLOTTA (RF-ROB-001, RF-ROB-014, CA-ROB-012)
  // =========================================================================
  async function loadFleetData() {
    fleetTableBody.innerHTML = '<tr><td colspan="10" class="empty-cell">Caricamento flotta in corso...</td></tr>';
    try {
      const res = await apiRequest("/api/robots");
      if (!res.ok) {
        fleetTableBody.innerHTML = '<tr><td colspan="10" class="empty-cell">Impossibile recuperare i dati della flotta.</td></tr>';
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

        // Nome Visualizzato
        const tdName = document.createElement("td");
        tdName.innerHTML = `<strong>${escapeHtml(robot.displayName)}</strong>`;
        tr.appendChild(tdName);

        // ID
        const tdId = document.createElement("td");
        tdId.textContent = robot.id;
        tr.appendChild(tdId);

        // Host : Porta
        const tdHost = document.createElement("td");
        tdHost.textContent = `${robot.host}:${robot.sshPort}`;
        tr.appendChild(tdHost);

        // Username Remoto
        const tdUser = document.createElement("td");
        tdUser.textContent = robot.remoteUsername;
        tr.appendChild(tdUser);

        // Stato Anagrafico (§10.2, RF-ROB-014)
        const tdAnagr = document.createElement("td");
        const anagrClass = robot.anagraphicState === "attivo" ? "badge-attivo" : "badge-disabilitato";
        tdAnagr.innerHTML = `<span class="badge-status ${anagrClass}">${escapeHtml(robot.anagraphicState)}</span>`;
        tr.appendChild(tdAnagr);

        // Stato Connessione (§10.2, RF-ROB-014, CA-ROB-012)
        const tdConn = document.createElement("td");
        let connClass = "badge-non_verificato";
        if (robot.connectionState === "raggiungibile") connClass = "badge-raggiungibile";
        else if (robot.connectionState === "non_raggiungibile") connClass = "badge-non_raggiungibile";
        else if (robot.connectionState === "errore") connClass = "badge-errore";
        else if (robot.connectionState === "avviso") connClass = "badge-avviso";
        tdConn.innerHTML = `<span class="badge-status ${connClass}">${escapeHtml(robot.connectionState.replace(/_/g, " "))}</span>`;
        tr.appendChild(tdConn);

        // Stato Operativo (§10.2, RF-MON-005, RF-MON-006: non inventare valori se non disponibile)
        const tdOp = document.createElement("td");
        if (robot.operationalState) {
          let opHtml = `<code>${escapeHtml(JSON.stringify(robot.operationalState))}</code>`;
          if (robot.isStale) {
            opHtml += ` <span class="badge-status badge-avviso" title="Dato non aggiornato o non più verificato">[Non più verificato]</span>`;
          }
          tdOp.innerHTML = opHtml;
        } else {
          tdOp.innerHTML = `<span class="badge-status badge-nodata">dato non disponibile (RF-MON-005)</span>`;
        }
        tr.appendChild(tdOp);

        // Data Ultimo Aggiornamento Stato
        const tdUpdate = document.createElement("td");
        tdUpdate.textContent = formatDate(robot.lastValidUpdateAt);
        tr.appendChild(tdUpdate);

        // Avvisi / Errori di connessione
        const tdWarnings = document.createElement("td");
        if (robot.hasWarningsOrErrors && robot.lastAttemptOutcome) {
          tdWarnings.innerHTML = `<span style="color: #c5221f; font-size: 0.82rem;">⚠️ ${escapeHtml(robot.lastAttemptOutcome.diagnosticMessage || "Errore ultimo tentativo")}</span>`;
        } else {
          tdWarnings.textContent = "Nessuno";
        }
        tr.appendChild(tdWarnings);

        // Azioni
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
      fleetTableBody.innerHTML = '<tr><td colspan="10" class="empty-cell">Errore durante il caricamento della flotta.</td></tr>';
    }
  }

  btnRefreshFleet.addEventListener("click", () => loadFleetData());

  function escapeHtml(str) {
    if (!str) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  // =========================================================================
  // STEP 2 – SCHEDA DETTAGLIO ROBOT E FUNZIONALITÀ AUTORIZZATE (RF-ROB-002, 003, 011)
  // =========================================================================
  async function openRobotDetail(robotId) {
    detailTitle.textContent = `Dettaglio Robot: ${robotId}`;
    detailBody.innerHTML = "<p>Caricamento informazioni in corso...</p>";
    modalDetail.classList.remove("hidden");

    try {
      const res = await apiRequest(`/api/robots/${encodeURIComponent(robotId)}`);
      if (!res.ok) {
        detailBody.innerHTML = `<div class="alert-box alert-danger">Impossibile recuperare il dettaglio del robot '${escapeHtml(robotId)}'.</div>`;
        return;
      }

      const data = await res.json();
      const robot = data.robot;
      const feat = data.availableFeatures;

      const hasUpdatePerm = currentUser?.roles.includes("amministratore") || (currentUser?.permissions && currentUser?.permissions.includes("ROBOT_CONFIG_UPDATE"));
      const hasDisablePerm = currentUser?.roles.includes("amministratore") || (currentUser?.permissions && currentUser?.permissions.includes("ROBOT_DISABLE"));
      const hasRemovePerm = currentUser?.roles.includes("amministratore") || (currentUser?.permissions && currentUser?.permissions.includes("ROBOT_REMOVE"));

      let html = `
        <div class="details-grid">
          <div class="detail-item">
            <strong>Nome Visualizzato</strong>
            <span>${escapeHtml(robot.displayName)}</span>
          </div>
          <div class="detail-item">
            <strong>Identificativo Univoco</strong>
            <span>${escapeHtml(robot.id)}</span>
          </div>
          <div class="detail-item">
            <strong>Username Remoto</strong>
            <span>${escapeHtml(robot.remoteUsername)}</span>
          </div>
          <div class="detail-item">
            <strong>Host e Porta SSH</strong>
            <span>${escapeHtml(robot.host)} : ${robot.sshPort}</span>
          </div>
          <div class="detail-item">
            <strong>Metodo Autenticazione SSH</strong>
            <span>${escapeHtml(robot.sshAuthMethod)}</span>
          </div>
          <div class="detail-item">
            <strong>Directory Associata sul Server</strong>
            <span><code>${escapeHtml(robot.serverDirectoryPath)}</code></span>
          </div>
          <div class="detail-item">
            <strong>Stato Anagrafico (§10.2)</strong>
            <span><span class="badge-status ${robot.anagraphicState === "attivo" ? "badge-attivo" : "badge-disabilitato"}">${escapeHtml(robot.anagraphicState)}</span></span>
          </div>
          <div class="detail-item">
            <strong>Stato Connessione (§10.2)</strong>
            <span><span class="badge-status ${robot.connectionState === "raggiungibile" ? "badge-raggiungibile" : "badge-non_raggiungibile"}">${escapeHtml(robot.connectionState.replace(/_/g, " "))}</span></span>
          </div>
          <div class="detail-item">
            <strong>Stato Registrazione (§10.2)</strong>
            <span><code>${escapeHtml(robot.registrationState)}</code></span>
          </div>
          <div class="detail-item" style="grid-column: span 2;">
            <strong>Stato Operativo File Remoti (§10.2, RF-MON-005)</strong>
            <span>
              ${robot.operationalState ? `<code>${escapeHtml(JSON.stringify(robot.operationalState))}</code>` : '<span class="badge-status badge-nodata">dato non disponibile (RF-MON-005)</span>'}
              ${robot.isStale ? '<span class="badge-status badge-avviso" style="margin-left: 0.5rem;" title="Dato non aggiornato o non più verificato">[Non più verificato]</span>' : ''}
            </span>
          </div>
          <div class="detail-item">
            <strong>Ultimo Aggiornamento Valido</strong>
            <span>${formatDate(robot.lastValidUpdateAt)}</span>
          </div>
          <div class="detail-item">
            <strong>Esito Ultimo Tentativo Monitoraggio</strong>
            <span>
              ${robot.lastAttemptOutcome ? (
                robot.lastAttemptOutcome.success
                  ? `<span class="badge-status badge-attivo">Riuscito (${formatDate(robot.lastAttemptOutcome.timestamp)})</span>`
                  : `<span class="badge-status badge-errore">Fallito: ${escapeHtml(robot.lastAttemptOutcome.diagnosticMessage || robot.lastAttemptOutcome.errorCode || '')} (${robot.lastAttemptOutcome.subType || ''})</span>`
              ) : '-'}
            </span>
          </div>
          <div class="detail-item">
            <strong>Ultima Verifica Connessione</strong>
            <span>${robot.lastConnectionVerification ? formatDate(robot.lastConnectionVerification.timestamp) + ' (' + (robot.lastConnectionVerification.success ? 'Riuscita' : 'Fallita: ' + escapeHtml(robot.lastConnectionVerification.message || '')) + ')' : '-'}</span>
          </div>
          <div class="detail-item">
            <strong>Verifica Chiave Host SSH</strong>
            <span>${robot.hostKeyVerification?.fingerprint ? 'Fingerprint: ' + escapeHtml(robot.hostKeyVerification.fingerprint) : (robot.hostKeyVerification?.knownHostsPath ? 'File: ' + escapeHtml(robot.hostKeyVerification.knownHostsPath) : 'StrictHostKey attivo')}</span>
          </div>
        </div>

        <!-- Barra Pulsanti Azione Robot -->
        <div style="display: flex; gap: 0.5rem; flex-wrap: wrap; margin-bottom: 1.5rem; padding-bottom: 1rem; border-bottom: 1px solid #e0e0e0;">
          <button class="btn btn-primary btn-sm" id="btn-detail-refresh-status">🔄 Aggiorna Stato (Refresh)</button>
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
        </div>

        <!-- Funzionalità Autorizzate per Utente/Robot (RF-ROB-011, CA-ROB-010) -->
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
                <div class="feature-reason">${feat.monitoring ? 'Servizio di monitoraggio remoto attivo.' : (feat.reasons.monitoring || 'Non disponibile')}</div>
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
                <div class="feature-reason">${feat.terminal ? 'Segnaposto: disponibile nel Prompt 8.' : (feat.reasons.terminal || 'Non disponibile')}</div>
              </div>
              <button class="btn btn-secondary btn-sm" style="margin-top: 0.5rem;" ${feat.terminal ? '' : 'disabled'}>Apri Terminale (P8)</button>
            </div>

            <!-- Filesystem Remoto -->
            <div class="feature-card ${feat.remoteFs ? 'feature-enabled' : 'feature-disabled'}">
              <div>
                <div class="feature-title">
                  <span>🌐 Filesystem Remoto</span>
                  <span class="feature-status ${feat.remoteFs ? 'badge-attivo' : 'badge-disabilitato'}">${feat.remoteFs ? 'Disponibile' : 'Disabilitato'}</span>
                </div>
                <div class="feature-reason">${feat.remoteFs ? 'Segnaposto: disponibile nel Prompt 9.' : (feat.reasons.remoteFs || 'Non disponibile')}</div>
              </div>
              <button class="btn btn-secondary btn-sm" style="margin-top: 0.5rem;" ${feat.remoteFs ? '' : 'disabled'}>Esplora Remoto (P9)</button>
            </div>

            <!-- Filesystem Server -->
            <div class="feature-card ${feat.serverFs ? 'feature-enabled' : 'feature-disabled'}">
              <div>
                <div class="feature-title">
                  <span>🗄️ Filesystem Server</span>
                  <span class="feature-status ${feat.serverFs ? 'badge-attivo' : 'badge-disabilitato'}">${feat.serverFs ? 'Disponibile' : 'Disabilitato'}</span>
                </div>
                <div class="feature-reason">${feat.serverFs ? 'Accesso attivo alla directory dedicata sul server.' : (feat.reasons.serverFs || 'Non disponibile')}</div>
              </div>
              <button class="btn btn-primary btn-sm" style="margin-top: 0.5rem;" id="btn-card-server-fs" ${feat.serverFs ? '' : 'disabled'}>Carica Directory Server</button>
            </div>

            <!-- Trasferimenti -->
            <div class="feature-card ${feat.transfers ? 'feature-enabled' : 'feature-disabled'}">
              <div>
                <div class="feature-title">
                  <span>⇄ Trasferimenti File</span>
                  <span class="feature-status ${feat.transfers ? 'badge-attivo' : 'badge-disabilitato'}">${feat.transfers ? 'Disponibile' : 'Disabilitato'}</span>
                </div>
                <div class="feature-reason">${feat.transfers ? 'Segnaposto: disponibile nel Prompt 10.' : (feat.reasons.transfers || 'Non disponibile')}</div>
              </div>
              <button class="btn btn-secondary btn-sm" style="margin-top: 0.5rem;" ${feat.transfers ? '' : 'disabled'}>Gestione Trasferimenti (P10)</button>
            </div>
          </div>
        </div>
      `;

      detailBody.innerHTML = html;

      // Aggancio eventi ai pulsanti del dettaglio
      document.getElementById("btn-detail-refresh-status")?.addEventListener("click", () => refreshRobotStatus(robot.id));
      document.getElementById("btn-feature-refresh-status")?.addEventListener("click", () => refreshRobotStatus(robot.id));
      document.getElementById("btn-detail-reverify")?.addEventListener("click", () => reverifyConnection(robot.id));
      document.getElementById("btn-detail-edit")?.addEventListener("click", () => {
        modalDetail.classList.add("hidden");
        openEditModal(robot);
      });
      document.getElementById("btn-detail-disable")?.addEventListener("click", () => toggleDisableRobot(robot.id, true));
      document.getElementById("btn-detail-enable")?.addEventListener("click", () => toggleDisableRobot(robot.id, false));
      document.getElementById("btn-detail-remove")?.addEventListener("click", () => {
        modalDetail.classList.add("hidden");
        promptRemoveRobot(robot.id, robot.displayName);
      });
      document.getElementById("btn-detail-repair")?.addEventListener("click", () => repairRobotRegistration(robot.id));

      const loadFsAction = () => {
        modalDetail.classList.add("hidden");
        document.getElementById("fs-robot-id").value = robot.id;
        loadServerFilesystem(robot.id, "");
        document.getElementById("fs-browser-section").scrollIntoView({ behavior: "smooth" });
      };

      document.getElementById("btn-detail-open-fs")?.addEventListener("click", loadFsAction);
      document.getElementById("btn-card-server-fs")?.addEventListener("click", loadFsAction);

    } catch (err) {
      detailBody.innerHTML = `<div class="alert-box alert-danger">Errore di comunicazione: ${escapeHtml(err.message)}</div>`;
    }
  }

  btnCloseDetail.addEventListener("click", () => modalDetail.classList.add("hidden"));

  // =========================================================================
  // STEP 3 & 4 – REGISTRAZIONE ROBOT (RF-ROB-004..006, §6.2)
  // =========================================================================
  btnRegisterRobot.addEventListener("click", () => {
    formRegister.reset();
    clearValidationErrors();
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

  function clearValidationErrors() {
    const errorEls = document.querySelectorAll(".field-error");
    errorEls.forEach(el => el.textContent = "");
  }

  formRegister.addEventListener("submit", async (e) => {
    e.preventDefault();
    clearValidationErrors();

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

    try {
      const res = await apiRequest("/api/robots", {
        method: "POST",
        body: JSON.stringify(payload),
      });

      const data = await res.json();

      if (res.status === 400 && data.validationErrors) {
        // Mostra errori associati a ciascun campo non valido (RF-ROB-006)
        for (const [field, errMsg] of Object.entries(data.validationErrors)) {
          const errDiv = document.getElementById(`err-${field}`);
          if (errDiv) errDiv.textContent = errMsg;
        }
        showNotification("Registrazione rifiutata: correggere i campi non validi evidenziati.", "danger");
        return;
      }

      modalRegister.classList.add("hidden");
      formRegister.reset();

      // Mostra riepilogo dettagliato con uno dei 6 esiti di RF-ROB-012 (Step 7)
      showRegistrationOutcome(data);
      loadFleetData();

    } catch (err) {
      showNotification("Errore di rete durante la registrazione del robot.", "danger");
    }
  });

  // =========================================================================
  // STEP 7 – SCHERMATA ESITO REGISTRAZIONE (RF-ROB-012)
  // =========================================================================
  function showRegistrationOutcome(data) {
    outcomeTitle.textContent = `Esito Registrazione: ${data.outcome}`;

    let outcomeClass = "alert-info";
    if (data.outcome === "registrazione_completata") outcomeClass = "alert-success";
    else if (data.outcome === "registrazione_rifiutata" || data.outcome === "creazione_directory_fallita") outcomeClass = "alert-danger";
    else if (data.outcome === "ssh_non_verificata" || data.outcome === "registrazione_incompleta") outcomeClass = "alert-warning";

    let html = `
      <div class="alert-box ${outcomeClass}">
        <strong>Esito ottenuto:</strong> <code>${escapeHtml(data.outcome)}</code><br>
        <p style="margin-top: 0.5rem;">${escapeHtml(data.message)}</p>
      </div>

      <div style="margin-top: 1rem;">
        <h5>Azioni eseguite con successo:</h5>
        <ul>
          ${(data.performedActions || []).map(a => `<li>✔️ ${escapeHtml(a)}</li>`).join("")}
        </ul>
      </div>

      ${data.skippedActions && data.skippedActions.length > 0 ? `
        <div style="margin-top: 0.75rem;">
          <h5>Azioni non eseguite o interrotte:</h5>
          <ul>
            ${data.skippedActions.map(a => `<li>⏭️ ${escapeHtml(a)}</li>`).join("")}
          </ul>
        </div>
      ` : ''}

      ${data.recoveryPath ? `
        <div class="alert-box alert-info" style="margin-top: 1rem;">
          <strong>Via di recupero consigliata:</strong><br>
          ${escapeHtml(data.recoveryPath)}
        </div>
      ` : ''}
    `;

    outcomeBody.innerHTML = html;
    modalOutcome.classList.remove("hidden");
  }

  btnCloseOutcome.addEventListener("click", () => modalOutcome.classList.add("hidden"));
  btnDismissOutcome.addEventListener("click", () => modalOutcome.classList.add("hidden"));

  // =========================================================================
  // PROMPT 7 – AGGIORNAMENTO MANUALE DELLO STATO (RF-MON-004, CA-MON-003)
  // =========================================================================
  async function refreshRobotStatus(robotId) {
    showNotification("Aggiornamento dello stato operativo in corso...", "warning");
    try {
      const res = await apiRequest(`/api/robots/${encodeURIComponent(robotId)}/status/refresh`, {
        method: "POST",
      });
      const data = await res.json();
      if (res.ok && data.success) {
        showNotification("Stato operativo aggiornato con successo!", "success");
      } else {
        const errorMsg = data.message || "Impossibile aggiornare lo stato operativo.";
        showNotification(`Aggiornamento stato non riuscito: ${errorMsg}`, "danger");
      }
      openRobotDetail(robotId);
      loadFleetData();
    } catch (err) {
      showNotification(`Errore durante l'aggiornamento dello stato: ${err.message}`, "danger");
    }
  }

  // =========================================================================
  // STEP 5 & 6 – RIPETI VERIFICA E RIPARA REGISTRAZIONE (§8.1, §6.3, CA-ROB-008)
  // =========================================================================
  async function reverifyConnection(robotId) {
    showNotification("Verifica connessione SSH in corso verso il robot...", "warning");
    try {
      const res = await apiRequest(`/api/robots/${encodeURIComponent(robotId)}/verify-connection`, {
        method: "POST",
      });
      const data = await res.json();
      if (res.ok && data.success) {
        showNotification("Verifica di connessione SSH completata con successo!", "success");
      } else {
        showNotification(`Verifica connessione fallita: ${data.message || 'Host non raggiungibile'}`, "danger");
      }
      openRobotDetail(robotId);
      loadFleetData();
    } catch {
      showNotification("Errore durante la verifica di connessione.", "danger");
    }
  }

  async function repairRobotRegistration(robotId) {
    showNotification("Riparazione registrazione in corso...", "warning");
    try {
      const res = await apiRequest(`/api/robots/${encodeURIComponent(robotId)}/repair`, {
        method: "POST",
      });
      const data = await res.json();
      showNotification(`Esito riparazione: ${data.message}`, data.outcome === "registrazione_completata" ? "success" : "warning");
      openRobotDetail(robotId);
      loadFleetData();
    } catch {
      showNotification("Errore durante la riparazione della registrazione.", "danger");
    }
  }

  // =========================================================================
  // STEP 9 – MODIFICA CONFIGURAZIONE ROBOT (§8.3)
  // =========================================================================
  function openEditModal(robot) {
    document.getElementById("edit-robotId").value = robot.id;
    document.getElementById("edit-displayName").value = robot.displayName;
    document.getElementById("edit-remoteUsername").value = robot.remoteUsername;
    document.getElementById("edit-host").value = robot.host;
    document.getElementById("edit-sshPort").value = robot.sshPort;
    editSelectAuthMethod.value = robot.sshAuthMethod || "password";
    document.getElementById("edit-fingerprint").value = robot.hostKeyVerification?.fingerprint || "";
    document.getElementById("edit-monitoringPath").value = robot.remoteMonitoringPath || "";

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

    try {
      const res = await apiRequest(`/api/robots/${encodeURIComponent(robotId)}/configuration`, {
        method: "PUT",
        body: JSON.stringify(payload),
      });

      const data = await res.json();
      if (!res.ok) {
        showNotification(`Modifica configurazione fallita: ${data.message}`, "danger");
        return;
      }

      modalEdit.classList.add("hidden");
      showNotification("Configurazione aggiornata. Stato di connessione reimpostato su 'non verificato' (§8.3).", "success");
      loadFleetData();
      openRobotDetail(robotId);
    } catch {
      showNotification("Errore durante l'aggiornamento della configurazione.", "danger");
    }
  });

  // =========================================================================
  // STEP 10 – DISABILITAZIONE E RIMOZIONE DALL'ANAGRAFICA (RF-ROB-013, §8.4)
  // =========================================================================
  async function toggleDisableRobot(robotId, disable) {
    const endpoint = disable ? "disable" : "enable";
    try {
      const res = await apiRequest(`/api/robots/${encodeURIComponent(robotId)}/${endpoint}`, {
        method: "POST",
      });
      const data = await res.json();
      if (res.ok) {
        showNotification(data.message, disable ? "warning" : "success");
        openRobotDetail(robotId);
        loadFleetData();
      } else {
        showNotification(`Operazione fallita: ${data.message}`, "danger");
      }
    } catch {
      showNotification("Errore di rete durante il cambio di stato anagrafico.", "danger");
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
    try {
      const res = await apiRequest(`/api/robots/${encodeURIComponent(robotId)}/remove`, {
        method: "POST",
        body: JSON.stringify({ confirmation: true }),
      });
      const data = await res.json();
      modalRemoveConfirm.classList.add("hidden");
      pendingRemoveRobotId = null;

      if (res.ok) {
        showNotification("Robot rimosso dall'anagrafica attiva con successo. File e cartelle preservati.", "success");
        loadFleetData();
      } else {
        showNotification(`Rimozione fallita: ${data.message}`, "danger");
      }
    } catch {
      showNotification("Errore di rete durante la rimozione del robot.", "danger");
    }
  });

  // =========================================================================
  // MODULO FILESYSTEM SERVER (RF-SRVFS-002, RNF-UX-002/003)
  // =========================================================================
  const fsRobotIdInput = document.getElementById("fs-robot-id");
  const btnFsLoad = document.getElementById("btn-fs-load");
  const btnFsUp = document.getElementById("btn-fs-up");
  const fsCurrentPathEl = document.getElementById("fs-current-path");
  const fsTableBody = document.getElementById("fs-table-body");
  const fsError = document.getElementById("fs-error");
  let currentFsPath = "";

  async function loadServerFilesystem(robotId, relativePath = "") {
    fsError.classList.add("hidden");
    fsTableBody.innerHTML = '<tr><td colspan="4" class="fs-empty-msg">Caricamento in corso...</td></tr>';

    try {
      const url = `/api/robots/${encodeURIComponent(robotId)}/fs/server/list?path=${encodeURIComponent(relativePath)}`;
      const res = await apiRequest(url);
      const data = await res.json();

      if (!res.ok) {
        fsError.textContent = data.message || "Impossibile accedere alla directory del robot.";
        fsError.classList.remove("hidden");
        fsTableBody.innerHTML = '<tr><td colspan="4" class="fs-empty-msg">Errore durante la lettura della directory.</td></tr>';
        return;
      }

      currentFsPath = data.currentPath || "";
      fsCurrentPathEl.textContent = `/${currentFsPath}`;

      if (!data.items || data.items.length === 0) {
        fsTableBody.innerHTML = '<tr><td colspan="4" class="fs-empty-msg">Directory vuota.</td></tr>';
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
        sizeTd.textContent = formatBytes(item.size);
        tr.appendChild(sizeTd);

        const dateTd = document.createElement("td");
        dateTd.textContent = formatDate(item.modifiedAt);
        tr.appendChild(dateTd);

        fsTableBody.appendChild(tr);
      }
    } catch {
      fsError.textContent = "Errore durante la comunicazione con il server per la lettura directory.";
      fsError.classList.remove("hidden");
      fsTableBody.innerHTML = '<tr><td colspan="4" class="fs-empty-msg">Errore di connessione.</td></tr>';
    }
  }

  btnFsLoad.addEventListener("click", () => {
    const robotId = fsRobotIdInput.value.trim();
    if (robotId) loadServerFilesystem(robotId, "");
  });

  btnFsUp.addEventListener("click", () => {
    const robotId = fsRobotIdInput.value.trim();
    if (!robotId || !currentFsPath) return;
    const segments = currentFsPath.split("/").filter(Boolean);
    segments.pop();
    const parentPath = segments.join("/");
    loadServerFilesystem(robotId, parentPath);
  });

  initSession();
});
