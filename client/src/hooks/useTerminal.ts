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

export function useTerminal() {
  const [terminalState, setTerminalState] = useState<TerminalState>({
    isOpen: false,
    robotId: null,
    robotName: "",
    sessionId: null,
    status: "idle",
    error: null,
    cols: 80,
    rows: 24,
  });

  const wsRef = useRef<WebSocket | null>(null);

  const openTerminal = useCallback(async (robotId: string, robotName: string) => {
    setTerminalState({
      isOpen: true,
      robotId,
      robotName,
      sessionId: null,
      status: "connecting",
      error: null,
      cols: 80,
      rows: 24,
    });

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
  }, []);

  const attachWebSocket = useCallback(
    (
      sessionId: string,
      onData: (data: string) => void,
      onClose: () => void,
      onError: (err: Event) => void
    ) => {
      if (wsRef.current) {
        wsRef.current.close();
      }

      const ws = apiClient.createTerminalWebSocket(sessionId);
      wsRef.current = ws;

      ws.onopen = () => {
        setTerminalState((prev) => ({ ...prev, status: "connected" }));
      };

      ws.onmessage = (event) => {
        onData(event.data);
      };

      ws.onclose = () => {
        setTerminalState((prev) => ({ ...prev, status: "disconnected" }));
        onClose();
      };

      ws.onerror = (err) => {
        setTerminalState((prev) => ({
          ...prev,
          status: "error",
          error: ErrorPresenter.formatError({
            code: "TERM_SESSION_ERROR",
            userMessage: "Errore di connessione sul canale terminale WebSocket.",
          }),
        }));
        onError(err);
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
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "resize", cols, rows }));
      setTerminalState((prev) => ({ ...prev, cols, rows }));
    }
  }, []);

  const closeTerminal = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    setTerminalState({
      isOpen: false,
      robotId: null,
      robotName: "",
      sessionId: null,
      status: "idle",
      error: null,
      cols: 80,
      rows: 24,
    });
  }, []);

  return {
    terminalState,
    openTerminal,
    attachWebSocket,
    sendInput,
    resize,
    closeTerminal,
  };
}
