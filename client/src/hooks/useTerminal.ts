import { useState, useRef, useCallback, useEffect } from "react";
import { apiClient } from "../services/api-client.ts";
import { ErrorPresenter } from "../services/error-presenter.ts";
import type { FormattedError } from "../types/error.ts";

interface TerminalIdleWarning {
  deadline: number;
  message: string;
}

export interface TerminalState {
  target: string;
  robotId: string | null;
  robotName: string;
  sessionId: string | null;
  status: "connecting" | "connected" | "disconnecting" | "disconnected" | "error";
  error: FormattedError | null;
  cols: number;
  rows: number;
  idleWarning?: TerminalIdleWarning;
}

interface TerminalEntry {
  state: TerminalState;
  socket?: WebSocket;
  opening?: Promise<void>;
  pendingResize?: { cols: number; rows: number };
}

const DEFAULT_SIZE = { cols: 80, rows: 24 };
const sessionEndpoint = (id: string) => `/api/terminal/sessions/${encodeURIComponent(id)}`;

function sendControl(entry: TerminalEntry, message: object) {
  if (entry.socket?.readyState === WebSocket.OPEN) {
    entry.socket.send(JSON.stringify(message));
  }
}

export function useTerminal() {
  const entries = useRef(new Map<string, TerminalEntry>());
  const visibleTarget = useRef<string | null>(null);
  const [activeTarget, setActiveTarget] = useState<string | null>(null);
  const [terminals, setTerminals] = useState<TerminalState[]>([]);
  const [now, setNow] = useState(Date.now);

  const publish = useCallback(() => {
    setTerminals(Array.from(entries.current.values(), (entry) => entry.state));
  }, []);

  const update = useCallback((entry: TerminalEntry, changes: Partial<TerminalState>) => {
    entry.state = { ...entry.state, ...changes };
    publish();
  }, [publish]);

  const select = useCallback((target: string | null) => {
    const previous = visibleTarget.current;
    if (previous === target) return;

    const previousEntry = previous === null ? undefined : entries.current.get(previous);
    if (previousEntry) {
      if (previousEntry.state.status === "disconnected" || previousEntry.state.status === "error") {
        entries.current.delete(previousEntry.state.target);
        previousEntry.socket?.close();
      } else {
        sendControl(previousEntry, { type: "visibility", hidden: true });
      }
    }

    visibleTarget.current = target;
    setActiveTarget(target);
    const entry = target === null ? undefined : entries.current.get(target);
    if (entry?.socket?.readyState === WebSocket.OPEN) {
      sendControl(entry, { type: "visibility", hidden: false });
      if (entry.pendingResize) {
        sendControl(entry, { type: "resize", ...entry.pendingResize });
        entry.pendingResize = undefined;
      }
    }
    publish();
  }, [publish]);

  const open = useCallback(async (robotId: string | null, robotName: string) => {
    const target = robotId === null ? "server" : `robot:${robotId}`;
    select(target);
    if (entries.current.has(target)) return;

    const entry: TerminalEntry = {
      state: {
        target, robotId, robotName, sessionId: null,
        status: "connecting", error: null, ...DEFAULT_SIZE,
      },
    };
    entries.current.set(target, entry);
    publish();

    entry.opening = (async () => {
      try {
        const endpoint = robotId === null
          ? "/api/server/terminal/sessions"
          : `/api/robots/${encodeURIComponent(robotId)}/terminal/sessions`;
        const res = await apiClient.post(endpoint, DEFAULT_SIZE);
        const data = await res.json();
        if (!res.ok || !data.sessionId) throw data;

        // La richiesta può terminare dopo il logout o lo smontaggio della dashboard.
        if (entries.current.get(target) !== entry) {
          await apiClient.delete(sessionEndpoint(data.sessionId)).catch(() => {});
          return;
        }
        update(entry, {
          sessionId: data.sessionId,
          cols: data.cols || DEFAULT_SIZE.cols,
          rows: data.rows || DEFAULT_SIZE.rows,
        });
      } catch (error) {
        if (entries.current.get(target) !== entry || entry.state.status === "disconnecting") return;
        if (visibleTarget.current === target) {
          update(entry, { status: "error", error: ErrorPresenter.formatError(error) });
        } else {
          entries.current.delete(target);
          publish();
        }
      }
    })();
    await entry.opening;
  }, [select, publish, update]);

  const attachWebSocket = useCallback((
    target: string,
    sessionId: string,
    onData: (data: string | Uint8Array) => void,
    onClose: () => void,
    onError: () => void,
  ) => {
    const entry = entries.current.get(target);
    if (!entry || entry.state.sessionId !== sessionId || entry.state.status === "disconnecting" || entry.socket) return;
    const ws = apiClient.createTerminalWebSocket(sessionId);
    entry.socket = ws;
    ws.binaryType = "arraybuffer";
    let serverClosed = false;
    const isCurrent = () => entries.current.get(target) === entry;

    ws.onopen = () => {
      if (!isCurrent() || entry.state.status === "disconnecting") return;
      if (visibleTarget.current !== target) {
        sendControl(entry, { type: "visibility", hidden: true });
      } else if (entry.pendingResize) {
        sendControl(entry, { type: "resize", ...entry.pendingResize });
        entry.pendingResize = undefined;
      }
      update(entry, { status: "connected" });
    };

    ws.onmessage = ({ data }) => {
      if (!isCurrent() || entry.state.status === "disconnecting") return;
      if (data instanceof ArrayBuffer) {
        onData(new Uint8Array(data));
        return;
      }
      if (typeof data !== "string") return;

      if (data.startsWith("{") && data.endsWith("}")) {
        try {
          const message = JSON.parse(data);
          switch (message.type) {
            case "terminal_idle_warning": {
              const seconds = message.remainingSeconds ?? (message.remainingMinutes || 5) * 60;
              onData(`\r\n\x1b[33m[Avviso: ${message.message}]\x1b[0m\r\n`);
              const receivedAt = Date.now();
              setNow(receivedAt);
              update(entry, { idleWarning: { deadline: receivedAt + seconds * 1000, message: message.message } });
              return;
            }
            case "terminal_idle_reset":
              update(entry, { idleWarning: undefined });
              return;
            case "session_closed":
              serverClosed = true;
              update(entry, { idleWarning: undefined });
              onData(`\r\n\x1b[33m[${message.message || "Connessione terminale chiusa."}]\x1b[0m\r\n`);
              return;
            case "error":
              onData(`\r\n\x1b[31m[Errore: ${message.message}]\x1b[0m\r\n`);
              return;
          }
        } catch {}
      }
      onData(data);
    };

    ws.onclose = () => {
      if (!isCurrent() || entry.state.status === "disconnecting") return;
      if (visibleTarget.current !== target) {
        entries.current.delete(target);
        publish();
      } else {
        update(entry, { status: "disconnected", idleWarning: undefined });
        if (!serverClosed) onClose();
      }
    };

    ws.onerror = () => {
      if (!isCurrent() || entry.state.status === "disconnecting") return;
      update(entry, {
        status: "error",
        error: ErrorPresenter.formatError({
          code: "TERM_SESSION_ERROR",
          userMessage: "Errore di connessione sul canale terminale WebSocket.",
        }),
      });
      onError();
    };
  }, [publish, update]);

  const sendInput = useCallback((target: string, input: string) => {
    const entry = entries.current.get(target);
    if (entry?.state.status === "connected" &&
        entry.socket?.readyState === WebSocket.OPEN) {
      sendControl(entry, { type: "input", data: input });
    }
  }, []);

  const resize = useCallback((target: string, cols: number, rows: number) => {
    const entry = entries.current.get(target);
    if (!entry || target !== visibleTarget.current) return;
    if (entry.socket?.readyState === WebSocket.OPEN) {
      sendControl(entry, { type: "resize", cols, rows });
    } else {
      entry.pendingResize = { cols, rows };
    }
    if (entry.state.cols !== cols || entry.state.rows !== rows) update(entry, { cols, rows });
  }, [update]);

  const disconnectTerminal = useCallback(async (target: string) => {
    const entry = entries.current.get(target);
    if (!entry || entry.state.status === "disconnecting") return;
    update(entry, { status: "disconnecting", idleWarning: undefined });

    try {
      await entry.opening;
      if (entry.state.sessionId) {
        const response = await apiClient.delete(sessionEndpoint(entry.state.sessionId));
        if (!response.ok && response.status !== 404) sendControl(entry, { type: "close" });
      }
    } catch {
      sendControl(entry, { type: "close" });
    } finally {
      entry.socket?.close(1000, "USER_EXPLICIT");
      if (entries.current.get(target) === entry) {
        entries.current.delete(target);
        if (visibleTarget.current === target) select(null);
        else publish();
      }
    }
  }, [publish, select, update]);

  const handleLoadError = useCallback((target: string) => {
    const entry = entries.current.get(target);
    if (!entry || entry.state.status === "disconnecting") return;
    entry.socket?.close();
    if (entry.state.sessionId) void apiClient.delete(sessionEndpoint(entry.state.sessionId)).catch(() => {});

    if (visibleTarget.current === target) {
      update(entry, {
        status: "error",
        error: ErrorPresenter.formatError({
          code: "TERM_SESSION_ERROR",
          userMessage: "Impossibile caricare il terminale. Chiudi la finestra e riprova.",
        }),
      });
    } else {
      entries.current.delete(target);
      publish();
    }
  }, [publish, update]);

  useEffect(() => {
    const sessions = entries.current;
    return () => {
      for (const entry of sessions.values()) entry.socket?.close();
      sessions.clear();
    };
  }, []);

  const activeTerminal = terminals.find((terminal) => terminal.target === activeTarget);
  const deadline = activeTerminal?.idleWarning?.deadline;
  useEffect(() => {
    if (deadline === undefined) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [deadline]);

  return {
    terminals,
    activeTerminal,
    terminalIdleWarning: deadline !== undefined && deadline > now ? {
      remainingSeconds: Math.ceil((deadline - now) / 1000),
      message: activeTerminal?.idleWarning?.message,
    } : null,
    openTerminal: open,
    openServerTerminal: () => open(null, "Terminale Server Moliris"),
    hideTerminal: () => select(null),
    disconnectTerminal,
    handleLoadError,
    attachWebSocket,
    sendInput,
    resize,
    confirmTerminalIdle: () => {
      if (activeTarget === null) return;
      const entry = entries.current.get(activeTarget);
      if (!entry) return;
      sendControl(entry, { type: "confirm_idle" });
      update(entry, { idleWarning: undefined });
    },
  };
}
