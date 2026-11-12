// Requisiti soddisfatti: SRS §1.2, §2.4 (vincoli 3-5), §2.5, RNF-SEC-001, RNF-SEC-002, RNF-SEC-004, RF-AUTH-003, RF-AUTH-006

export class ApiClient {
  private readonly tokenKey = "moliris_token";
  private sessionExpiredListeners: Array<() => void> = [];
  private activityListeners: Array<() => void> = [];

  public getToken(): string | null {
    try {
      return sessionStorage.getItem(this.tokenKey);
    } catch {
      return null;
    }
  }

  public setToken(token: string | null): void {
    try {
      if (token) {
        sessionStorage.setItem(this.tokenKey, token);
      } else {
        sessionStorage.removeItem(this.tokenKey);
      }
    } catch {}
  }

  public clearToken(): void {
    try {
      sessionStorage.removeItem(this.tokenKey);
    } catch {}
  }

  public onSessionExpired(listener: () => void): void {
    this.sessionExpiredListeners.push(listener);
  }

  public onQualifiedActivity(listener: () => void): void {
    this.activityListeners.push(listener);
  }

  public notifyQualifiedActivity(): void {
    for (const listener of this.activityListeners) {
      try {
        listener();
      } catch {}
    }
  }

  public notifySessionExpired(): void {
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
  public assertLocalBackendEndpoint(endpoint: string): void {
    if (typeof endpoint !== "string") {
      throw new Error("Endpoint non valido");
    }

    let url: URL;
    try {
      url = new URL(endpoint, window.location.origin);
    } catch {
      throw new Error("Endpoint non valido");
    }

    if (url.origin !== window.location.origin) {
      throw new Error(
        `Violazione di sicurezza (§2.4 vincolo 4): richiesta diretta bloccata verso host '${url.hostname}'. Tutte le chiamate devono essere intermediate dal server Moliris.`
      );
    }
  }

  /**
   * Esegue una richiesta HTTP sicura verso il backend Fastify.
   */
  public async request(endpoint: string, options: RequestInit = {}): Promise<Response> {
    this.assertLocalBackendEndpoint(endpoint);

    const headers: Record<string, string> = {
      ...((options.headers as Record<string, string>) || {}),
    };
    const token = this.getToken();

    if (token && !headers["Authorization"]) {
      headers["Authorization"] = `Bearer ${token}`;
    }

    if (
      options.body !== undefined &&
      !headers["Content-Type"] &&
      !(options.body instanceof FormData) &&
      !(options.body instanceof Blob)
    ) {
      headers["Content-Type"] = "application/json";
    }

    try {
      const response = await fetch(endpoint, {
        ...options,
        headers,
      });

      const isAutomaticStatusPolling =
        options.method === "GET" && /^\/api\/robots\/[^/]+\/status(?:\?.*)?$/.test(endpoint);
      if (token && !isAutomaticStatusPolling) {
        this.notifyQualifiedActivity();
      }

      if (response.status === 401) {
        this.notifySessionExpired();
        const err: any = new Error("La sessione è scaduta o non valida. Effettuare nuovamente il login.");
        err.code = "AUTH_INVALID_CREDENTIALS";
        err.status = 401;
        throw err;
      }

      return response;
    } catch (err: any) {
      if (err.status === 401 || err.code === "AUTH_INVALID_CREDENTIALS") {
        throw err;
      }
      if (err instanceof TypeError && err.message && err.message.includes("fetch")) {
        const netErr: any = new Error(
          "Applicazione non raggiungibile. Verificare la connessione di rete e l'accesso alla VPN Moliris."
        );
        netErr.code = "NETWORK_DISCONNECTED";
        throw netErr;
      }
      throw err;
    }
  }

  public async get(endpoint: string): Promise<Response> {
    return this.request(endpoint, { method: "GET" });
  }

  public async post(endpoint: string, body?: unknown, options: RequestInit = {}): Promise<Response> {
    return this.request(endpoint, {
      method: "POST",
      body:
        body instanceof Blob || body instanceof FormData || typeof body === "string"
          ? body
          : JSON.stringify(body),
      ...options,
    });
  }

  public async put(endpoint: string, body?: unknown, options: RequestInit = {}): Promise<Response> {
    return this.request(endpoint, {
      method: "PUT",
      body: typeof body === "string" ? body : JSON.stringify(body),
      ...options,
    });
  }

  public async delete(endpoint: string, options: RequestInit = {}): Promise<Response> {
    return this.request(endpoint, {
      method: "DELETE",
      ...options,
    });
  }

  public createTerminalWebSocket(sessionId: string): WebSocket {
    const wsProto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${wsProto}//${window.location.host}/api/terminal/ws/${encodeURIComponent(sessionId)}`;
    return new WebSocket(wsUrl);
  }
}

export const apiClient = new ApiClient();
