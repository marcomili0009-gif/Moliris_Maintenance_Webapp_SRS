// Requisiti soddisfatti: SRS §1.2, §2.4 (vincoli 3-5), §2.5, RNF-SEC-001, RNF-SEC-002, RNF-SEC-004, RF-AUTH-003, RF-AUTH-006

/**
 * Client API HTTP/WebSocket centralizzato e sicuro per il browser Google Chrome.
 *
 * Vincoli e Invarianti di Sicurezza:
 * - Tutte le comunicazioni usano HTTPS o WSS (§2.4 vincolo 3, RNF-SEC-001).
 * - Il browser NON apre MAI connessioni dirette verso i robot (§1.2, §2.4 vincolo 2 e 4).
 * - Nessuna chiave privata o credenziale persistente viene mai conservata dal client (§11.2, RNF-SEC-002).
 * - Gestione uniforme della scadenza sessione (401) e dell'irraggiungibilità dell'applicazione / VPN (RF-AUTH-006, §2.5).
 */
export class ApiClient {
  constructor() {
    this.tokenKey = "moliris_token";
    this.sessionExpiredListeners = [];
  }

  getToken() {
    try {
      return sessionStorage.getItem(this.tokenKey);
    } catch {
      return null;
    }
  }

  setToken(token) {
    try {
      if (token) {
        sessionStorage.setItem(this.tokenKey, token);
      } else {
        sessionStorage.removeItem(this.tokenKey);
      }
    } catch {}
  }

  clearToken() {
    try {
      sessionStorage.removeItem(this.tokenKey);
    } catch {}
  }

  onSessionExpired(listener) {
    if (typeof listener === "function") {
      this.sessionExpiredListeners.push(listener);
    }
  }

  notifySessionExpired() {
    this.clearToken();
    for (const listener of this.sessionExpiredListeners) {
      try {
        listener();
      } catch {}
    }
  }

  /**
   * Verifica preventiva di sicurezza: vieta categoricamente qualsiasi richiesta
   * diretta a host esterni o IP di robot mobili dal browser (§2.4 vincolo 2 e 4).
   */
  assertLocalBackendEndpoint(endpoint) {
    if (typeof endpoint !== "string") {
      throw new Error("Endpoint non valido");
    }
    if (endpoint.startsWith("http://") || endpoint.startsWith("https://")) {
      const url = new URL(endpoint);
      if (url.origin !== window.location.origin) {
        throw new Error(
          `Violazione di sicurezza (§2.4 vincolo 4): richiesta diretta bloccata verso host '${url.hostname}'. Tutte le chiamate devono essere intermediate dal server Moliris.`
        );
      }
    }
  }

  /**
   * Esegue una richiesta HTTP sicura verso il backend Fastify.
   */
  async request(endpoint, options = {}) {
    this.assertLocalBackendEndpoint(endpoint);

    const headers = { ...(options.headers || {}) };
    const token = this.getToken();

    if (token && !headers["Authorization"]) {
      headers["Authorization"] = `Bearer ${token}`;
    }

    if (options.body !== undefined && !headers["Content-Type"] && !(options.body instanceof FormData) && !(options.body instanceof Blob)) {
      headers["Content-Type"] = "application/json";
    }

    try {
      const response = await fetch(endpoint, {
        ...options,
        headers,
      });

      if (response.status === 401) {
        this.notifySessionExpired();
        const err = new Error("La sessione è scaduta o non valida. Effettuare nuovamente il login.");
        err.code = "AUTH_INVALID_CREDENTIALS";
        err.status = 401;
        throw err;
      }

      return response;
    } catch (err) {
      if (err.status === 401 || err.code === "AUTH_INVALID_CREDENTIALS") {
        throw err;
      }
      // Se si verifica un fallimento di rete / browser (es. assenza connessione o VPN disconnessa)
      if (err instanceof TypeError && err.message && err.message.includes("fetch")) {
        const netErr = new Error("Applicazione non raggiungibile. Verificare la connessione di rete e l'accesso alla VPN Moliris.");
        netErr.code = "NETWORK_DISCONNECTED";
        throw netErr;
      }
      throw err;
    }
  }

  async get(endpoint) {
    return this.request(endpoint, { method: "GET" });
  }

  async post(endpoint, body, options = {}) {
    return this.request(endpoint, {
      method: "POST",
      body: body instanceof Blob || body instanceof FormData || typeof body === "string" ? body : JSON.stringify(body),
      ...options,
    });
  }

  async put(endpoint, body, options = {}) {
    return this.request(endpoint, {
      method: "PUT",
      body: typeof body === "string" ? body : JSON.stringify(body),
      ...options,
    });
  }

  async delete(endpoint, options = {}) {
    return this.request(endpoint, {
      method: "DELETE",
      ...options,
    });
  }

  /**
   * Crea la connessione WebSocket sicura per il terminale PTY remoto (RF-SSH-004, §5.4).
   */
  createTerminalWebSocket(sessionId) {
    const wsProto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${wsProto}//${window.location.host}/api/terminal/ws/${encodeURIComponent(sessionId)}`;
    return new WebSocket(wsUrl);
  }
}

export const apiClient = new ApiClient();
