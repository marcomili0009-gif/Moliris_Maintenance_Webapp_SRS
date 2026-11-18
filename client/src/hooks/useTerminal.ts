import { useState, useRef, useCallback } from "react";
import { apiClient } from "../services/api-client.ts";
import { ErrorPresenter } from "../services/error-presenter.ts";
import type { FormattedError } from "../types/error.ts";

export interface TerminalState {
  isOpen: boolean;
  robotId: string | null;
  robotName: string;
  sessionId: string | null;
  status: "idle" | "connecting" | "connected" | "disconnected" | "error";
  error: FormattedError | null;
  cols: number;
  rows: number;
}

const IDLE_STATE: TerminalState = {
  isOpen: false,
  robotId: null,
  robotName: "",
  sessionId: null,
  status: "idle",
  error: null,
  cols: 80,
  rows: 24,
};

export function useTerminal() {
  const [terminalState, setTerminalState] = useState<TerminalState>(IDLE_STATE);

  const wsRef = useRef<WebSocket | null>(null);
  const wsSessionIdRef = useRef<string | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const callbacksRef = useRef<{
    onData: (data: string | Uint8Array) => void;
    onClose: () => void;
    onError: (err: Event) => void;
  } | null>(null);
  // Dimensioni calcolate dal fit di xterm prima che la socket sia OPEN.
  const pendingResizeRef = useRef<{ cols: number; rows: number } | null>(null);
  // Chiusura richiesta dal client: evita messaggi di errore su un canale
  // chiuso intenzionalmente.
  const intentionalCloseRef = useRef(false);
  // Il server ha già notificato la chiusura: non duplicare il messaggio.
  const serverClosedRef = useRef(false);

  sessionIdRef.current = terminalState.sessionId;

  const sendResizeIfOpen = (cols: number, rows: number): boolean => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ type: "resize", cols, rows }));
        pendingResizeRef.current = null;
        return true;
      } catch {
        pendingResizeRef.current = { cols, rows };
        return false;
      }
    }
    pendingResizeRef.current = { cols, rows };
    return false;
  };

  const releaseCurrentConnection = useCallback((notifyBackend: boolean) => {
    const previousSessionId = sessionIdRef.current;
    const ws = wsRef.current;

    intentionalCloseRef.current = true;
    if (ws) {
      if (notifyBackend && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({ type: "close" }));
        } catch {}
      }
      try {
        ws.close(1000, "USER_EXPLICIT");
      } catch {}
    }

    wsRef.current = null;
    wsSessionIdRef.current = null;
    callbacksRef.current = null;
    pendingResizeRef.current = null;
    serverClosedRef.current = false;

    if (notifyBackend && previousSessionId) {
      // Routine atomica: payload di chiusura sul canale, chiusura socket e
      // DELETE formale della sessione PTY lato backend. Un 404 è atteso se il
      // server ha già chiuso la sessione reagendo alla chiusura della socket.
      apiClient
        .delete(`/api/terminal/sessions/${encodeURIComponent(previousSessionId)}`)
        .catch(() => {});
    }

    return previousSessionId;
  }, []);

  const openTerminal = useCallback(
    async (robotId: string, robotName: string) => {
      releaseCurrentConnection(true);
      setTerminalState({ ...IDLE_STATE, isOpen: true, robotId, robotName, status: "connecting" });

      try {
        const res = await apiClient.post(
          `/api/robots/${encodeURIComponent(robotId)}/terminal/sessions`,
          { cols: 80, rows: 24 }
        );

        const data = await res.json();
        if (!res.ok || !data.sessionId) {
          setTerminalState((prev) => ({
            ...prev,
            status: "error",
            error: ErrorPresenter.formatError(data),
          }));
          return;
        }

        setTerminalState((prev) => ({
          ...prev,
          sessionId: data.sessionId,
          cols: data.cols || 80,
          rows: data.rows || 24,
        }));
      } catch (err) {
        setTerminalState((prev) => ({
          ...prev,
          status: "error",
          error: ErrorPresenter.formatError(err),
        }));
      }
    },
    [releaseCurrentConnection]
  );

  const openServerTerminal = useCallback(async () => {
    releaseCurrentConnection(true);
    setTerminalState({
      ...IDLE_STATE,
      isOpen: true,
      robotId: "server",
      robotName: "Terminale Server Moliris",
      status: "connecting",
    });

    try {
      const res = await apiClient.post(
        `/api/server/terminal/sessions`,
        { cols: 80, rows: 24 }
      );

      const data = await res.json();
      if (!res.ok || !data.sessionId) {
        setTerminalState((prev) => ({
          ...prev,
          status: "error",
          error: ErrorPresenter.formatError(data),
        }));
        return;
      }

      setTerminalState((prev) => ({
        ...prev,
        sessionId: data.sessionId,
        cols: data.cols || 80,
        rows: data.rows || 24,
      }));
    } catch (err) {
      setTerminalState((prev) => ({
        ...prev,
        status: "error",
        error: ErrorPresenter.formatError(err),
      }));
    }
  }, [releaseCurrentConnection]);

  const attachWebSocket = useCallback(
    (
      sessionId: string,
      onData: (data: string | Uint8Array) => void,
      onClose: () => void,
      onError: (err: Event) => void
    ) => {
      callbacksRef.current = { onData, onClose, onError };

      // Idempotenza: se la socket per questa stessa sessione è già in corso o
      // aperta, riusa il canale esistente invece di aprirne un secondo (il
      // backend rifiuta un doppio attach e chiude la sessione).
      const existing = wsRef.current;
      if (
        existing &&
        wsSessionIdRef.current === sessionId &&
        (existing.readyState === WebSocket.CONNECTING || existing.readyState === WebSocket.OPEN)
      ) {
        return;
      }

      if (existing) {
        try {
          existing.close(1000, "REATTACH");
        } catch {}
        wsRef.current = null;
        wsSessionIdRef.current = null;
      }

      intentionalCloseRef.current = false;
      serverClosedRef.current = false;

      const ws = apiClient.createTerminalWebSocket(sessionId);
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;
      wsSessionIdRef.current = sessionId;

      ws.onopen = () => {
        if (wsRef.current !== ws) return;
        setTerminalState((prev) => ({ ...prev, status: "connected" }));
        const pending = pendingResizeRef.current;
        if (pending) {
          try {
            ws.send(JSON.stringify({ type: "resize", cols: pending.cols, rows: pending.rows }));
            pendingResizeRef.current = null;
          } catch {}
        }
      };

      ws.onmessage = async (event) => {
        if (wsRef.current !== ws) return;
        const handlers = callbacksRef.current;
        if (!handlers) return;

        if (typeof event.data === "string") {
          if (event.data.startsWith("{") && event.data.endsWith("}")) {
            try {
              const parsed = JSON.parse(event.data);
              if (parsed.type === "terminal_idle_warning") {
                handlers.onData(`\r\n\x1b[33m[Avviso: ${parsed.message}]\x1b[0m\r\n`);
                return;
              }
              if (parsed.type === "terminal_idle_reset") {
                return;
              }
              if (parsed.type === "session_closed") {
                serverClosedRef.current = true;
                handlers.onData(
                  `\r\n\x1b[33m[${parsed.message || "Connessione terminale chiusa."}]\x1b[0m\r\n`
                );
                return;
              }
              if (parsed.type === "error") {
                handlers.onData(`\r\n\x1b[31m[Errore: ${parsed.message}]\x1b[0m\r\n`);
                return;
              }
            } catch {}
          }
          handlers.onData(event.data);
        } else if (event.data instanceof ArrayBuffer) {
          handlers.onData(new Uint8Array(event.data));
        } else if (event.data instanceof Blob) {
          try {
            const buf = await event.data.arrayBuffer();
            if (wsRef.current === ws) {
              callbacksRef.current?.onData(new Uint8Array(buf));
            }
          } catch {
            // Se fallisce la lettura blob, ignoriamo
          }
        }
      };

      ws.onclose = () => {
        if (wsRef.current !== ws) return;
        wsRef.current = null;
        wsSessionIdRef.current = null;
        const handlers = callbacksRef.current;
        setTerminalState((prev) => ({ ...prev, status: "disconnected" }));

        if (intentionalCloseRef.current || serverClosedRef.current) {
          intentionalCloseRef.current = false;
          serverClosedRef.current = false;
          callbacksRef.current = null;
          return;
        }
        handlers?.onClose();
        callbacksRef.current = null;
      };

      ws.onerror = (err) => {
        if (wsRef.current !== ws) return;
        setTerminalState((prev) => ({
          ...prev,
          status: "error",
          error: ErrorPresenter.formatError({
            code: "TERM_SESSION_ERROR",
            userMessage: "Errore di connessione sul canale terminale WebSocket.",
          }),
        }));
        callbacksRef.current?.onError(err);
      };
    },
    []
  );

  const sendInput = useCallback((input: string) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(input);
    }
  }, []);

  const resize = useCallback((cols: number, rows: number) => {
    sendResizeIfOpen(cols, rows);
    setTerminalState((prev) =>
      prev.cols === cols && prev.rows === rows ? prev : { ...prev, cols, rows }
    );
  }, []);

  /**
   * Chiusura atomica richiesta dall'utente (pulsante "Disconnetti" o "X"):
   * 1. invia il payload di chiusura al backend (chiusura sessione PTY);
   * 2. chiude la socket/stream;
   * 3. resetta lo stato frontend e chiude il pannello.
   */
  const disconnectTerminal = useCallback(() => {
    releaseCurrentConnection(true);
    setTerminalState(IDLE_STATE);
  }, [releaseCurrentConnection]);

  return {
    terminalState,
    openTerminal,
    openServerTerminal,
    attachWebSocket,
    sendInput,
    resize,
    closeTerminal: disconnectTerminal,
    disconnectTerminal,
  };
}
