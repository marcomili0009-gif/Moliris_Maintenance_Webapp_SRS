// Requisiti: SRS §2.5 (Google Chrome), §5.1, §6.1 punti 1–5, RF-AUTH-001..006, RNF-SEC-004

document.addEventListener("DOMContentLoaded", () => {
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
  const fleetStatusText = document.getElementById("fleet-status-text");

  let sessionToken = sessionStorage.getItem("moliris_token") || null;

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
  }

  function showDashboardView(user) {
    loginSection.classList.add("hidden");
    dashboardSection.classList.remove("hidden");
    hideNotification();

    currentUsername.textContent = user.username;
    currentRoles.textContent = user.roles.join(", ");

    // Adattamento interfaccia in base ai permessi autorizzati (RNF-SEC-004)
    // Nota: la sicurezza vera è applicata dal backend; la UI nasconde solo i controlli non pertinenti.
    const hasAdminPerms = user.roles.includes("amministratore") || (user.permissions && user.permissions.includes("ROBOT_REGISTER"));
    if (hasAdminPerms) {
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
    headers["Content-Type"] = "application/json";

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

  // Gestione invio credenziali Login (RF-AUTH-001, RF-AUTH-002, §6.1)
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
        // Messaggio sicuro senza leak informativi (SRS §9)
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
    } catch {
      // Ignora errori di rete sul logout
    }
    showLoginView();
    showNotification("Disconnessione effettuata con successo.", "warning");
  });

  // Caricamento flotta (placeholder SRS §6.1 punto 5)
  async function loadFleetData() {
    fleetStatusText.textContent = "Caricamento stato flotta...";
    try {
      const res = await apiRequest("/api/fleet/summary");
      if (res && res.ok) {
        const data = await res.json();
        fleetStatusText.textContent = `Connessione stabilita. ${data.description}`;
      }
    } catch {
      fleetStatusText.textContent = "Impossibile recuperare lo stato della flotta.";
    }
  }

  btnRefreshFleet.addEventListener("click", () => {
    loadFleetData();
  });

  initSession();
});
