import React, { useEffect, useRef, useState } from "react";
import type { TerminalState } from "../../hooks/useTerminal.ts";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import { TerminalClipboard } from "./TerminalClipboard.tsx";

interface TerminalModalProps {
  terminalState: TerminalState;
  onClose: () => void;
  onAttachWebSocket: (
    sessionId: string,
    onData: (data: string | Uint8Array) => void,
    onClose: () => void,
    onError: (err: Event) => void
  ) => void;
  onSendInput: (data: string) => void;
  onResize: (cols: number, rows: number) => void;
}

export const TerminalModal: React.FC<TerminalModalProps> = ({
  terminalState,
  onClose,
  onAttachWebSocket,
  onSendInput,
  onResize,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termInstanceRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const fitRef = useRef<() => void>(() => {});
  const lastSentSizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const [failedSession, setFailedSession] = useState<string | null>(null);
  const [isExpanded, setIsExpanded] = useState<boolean>(false);
  const [clipboardSession, setClipboardSession] = useState<{ id: string; terminal: Terminal } | null>(null);

  const { isOpen, robotId, robotName, sessionId, status, error, cols, rows } = terminalState;

  // I callback del parent vengono letti da un ref mutabile: il terminale e il
  // WebSocket devono essere creati UNA SOLA VOLTA per sessione, non a ogni
  // render o resize (altrimenti il PTY viene chiuso e la sessione va persa).
  const callbacksRef = useRef({ onAttachWebSocket, onSendInput, onResize });
  callbacksRef.current = { onAttachWebSocket, onSendInput, onResize };

  // Ogni nuova sessione (e ogni chiusura) riparte sempre in modalità ridotta.
  useEffect(() => {
    setIsExpanded(false);
  }, [isOpen, sessionId]);

  useEffect(() => {
    if (!isOpen || !sessionId || !containerRef.current) return;

    const container = containerRef.current;
    let cancelled = false;
    let dispose: (() => void) | undefined;
    void Promise.all([
      import("@xterm/xterm"),
      import("@xterm/addon-fit"),
      import("@xterm/xterm/css/xterm.css"),
    ]).then(([{ Terminal }, { FitAddon }]) => {
      if (cancelled) return;
      const term = new Terminal({
        cursorBlink: true,
        cursorStyle: "bar",
        cursorWidth: 2,
        cursorInactiveStyle: "outline",
        // Il bridge PTY locale (pipe senza ONLCR) emette solo "\n": senza questa
        // opzione xterm interpreterebbe il newline senza ritorno a capo,
        // producendo l'effetto "staircase".
        convertEol: true,
        cols: cols || 80,
        rows: rows || 24,
        fontFamily: '"DejaVu Sans Mono", "Ubuntu Mono", "Liberation Mono", Menlo, Monaco, Consolas, "Courier New", monospace',
        fontSize: 13,
        theme: {
          background: "#1e1e1e",
          foreground: "#f0f0f0",
          cursor: "#ffffff",
          cursorAccent: "#1e1e1e",
          selectionBackground: "rgba(255, 255, 255, 0.28)",
          black: "#1e1e1e",
          red: "#f14c4c",
          green: "#23d18b",
          yellow: "#f5f543",
          blue: "#3b8eea",
          magenta: "#d670d6",
          cyan: "#29b8db",
          white: "#e5e5e5",
          brightBlack: "#666666",
          brightRed: "#f14c4c",
          brightGreen: "#23d18b",
          brightYellow: "#f5f543",
          brightBlue: "#3b8eea",
          brightMagenta: "#d670d6",
          brightCyan: "#29b8db",
          brightWhite: "#ffffff",
        },
      });

      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      fitAddonRef.current = fitAddon;
      termInstanceRef.current = term;
      lastSentSizeRef.current = null;

      container.replaceChildren();
      term.open(container);
      term.focus();
      setClipboardSession({ id: sessionId, terminal: term });

      // Adatta il PTY alle dimensioni reali del contenitore. Invia il resize
      // solo quando righe/colonne cambiano davvero, per evitare raffiche inutili.
      const performFit = () => {
        if (!fitAddonRef.current || !termInstanceRef.current) return;
        try {
          fitAddonRef.current.fit();
          const newCols = termInstanceRef.current.cols;
          const newRows = termInstanceRef.current.rows;
          const previous = lastSentSizeRef.current;
          if (newCols && newRows && (previous?.cols !== newCols || previous?.rows !== newRows)) {
            lastSentSizeRef.current = { cols: newCols, rows: newRows };
            callbacksRef.current.onResize(newCols, newRows);
          }
        } catch {}
      };
      fitRef.current = performFit;

      let fitFrame = 0;
      const scheduleFit = () => {
        if (fitFrame) return;
        fitFrame = requestAnimationFrame(() => {
          fitFrame = 0;
          performFit();
        });
      };

      // Aggancia il WebSocket una sola volta per sessione, prima del primo fit:
      // le dimensioni iniziali vengono accodate dal hook se la socket non è
      // ancora aperta, e inviate appena possibile.
      callbacksRef.current.onAttachWebSocket(
        sessionId,
        (data: string | Uint8Array) => {
          term.write(data);
        },
        () => {
          term.write("\r\n\x1b[31m[Sessione terminale terminata dal server]\x1b[0m\r\n");
        },
        () => {
          term.write("\r\n\x1b[31m[Errore canale WebSocket]\x1b[0m\r\n");
        }
      );

      scheduleFit();

      const resizeObserver = new ResizeObserver(() => {
        scheduleFit();
      });
      resizeObserver.observe(container);

      term.onData((data: string) => {
        callbacksRef.current.onSendInput(data);
      });

      const handleWindowResize = () => {
        scheduleFit();
      };
      window.addEventListener("resize", handleWindowResize);

      dispose = () => {
        cancelAnimationFrame(fitFrame);
        window.removeEventListener("resize", handleWindowResize);
        resizeObserver.disconnect();
        fitRef.current = () => {};
        setClipboardSession(null);
        try {
          term.dispose();
        } catch {}
        termInstanceRef.current = null;
        fitAddonRef.current = null;
        lastSentSizeRef.current = null;
      };
    }).catch(() => {
      if (!cancelled) setFailedSession(sessionId);
    });
    return () => {
      cancelled = true;
      dispose?.();
    };
    // Volutamente NON dipendente da cols/rows né dai callback del parent:
    // questo effetto governa il ciclo di vita della sessione terminale.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, sessionId]);

  // Il toggle di layout ridimensiona solo il contenitore: la sessione PTY,
  // il WebSocket e l'istanza xterm restano invariati. Il fit avviene dopo il
  // paint del nuovo layout.
  useEffect(() => {
    if (!isOpen) return;
    const raf = requestAnimationFrame(() => {
      fitRef.current();
    });
    return () => cancelAnimationFrame(raf);
  }, [isExpanded, isOpen]);

  if (!isOpen) return null;

  let statusBadgeClass = "badge-non_verificato";
  let statusText = "Connessione in corso...";
  const emulatorFailed = sessionId !== null && failedSession === sessionId;
  if (emulatorFailed) {
    statusBadgeClass = "badge-errore";
    statusText = "Errore caricamento";
  } else if (status === "connected") {
    statusBadgeClass = "badge-attivo";
    statusText = "Connesso";
  } else if (status === "disconnected") {
    statusBadgeClass = "badge-disabilitato";
    statusText = "Disconnesso";
  } else if (status === "error") {
    statusBadgeClass = "badge-errore";
    statusText = "Errore Connessione";
  }

  return (
    <div id="modal-terminal" className="modal" role="dialog" aria-modal="true">
      <div className={`modal-content modal-terminal-window ${isExpanded ? "terminal-expanded" : ""}`}>
        <div className="modal-header terminal-modal-header">
          <div className="terminal-title-container flex items-center gap-2">
            <h3 id="terminal-robot-title">
              {robotId === "server" ? "Terminale Server: Host Locale" : `Terminale Remoto: ${robotName}`}
            </h3>
            <span id="terminal-session-status" className={`badge-status ${statusBadgeClass}`}>
              {statusText}
            </span>
          </div>
          <div className="terminal-header-actions flex items-center gap-2">
            <button
              type="button"
              className="btn btn-outline-light btn-sm"
              id="btn-terminal-expand"
              title={isExpanded ? "Ripristina dimensioni normali" : "Espandi a finestra intera"}
              aria-pressed={isExpanded}
              onClick={() => setIsExpanded((current) => !current)}
            >
              {isExpanded ? "Ripristina" : "Espandi"}
            </button>
            <button
              type="button"
              className="btn btn-danger btn-sm"
              id="btn-terminal-disconnect"
              onClick={onClose}
            >
              Disconnetti
            </button>
            <button
              type="button"
              className="btn-close"
              id="btn-close-terminal"
              onClick={onClose}
              aria-label="Chiudi e chiudi la sessione terminale"
            />
          </div>
        </div>

        {error && (
          <div className="error-message m-2" role="alert">
            {error.userMessage}
          </div>
        )}

        {emulatorFailed && (
          <div className="error-message m-2" role="alert">
            Impossibile caricare il terminale. Chiudi la finestra e riprova.
          </div>
        )}

        <div className="terminal-body" id="terminal-container" ref={containerRef} />
        {clipboardSession && clipboardSession.id === sessionId && (
          <TerminalClipboard key={sessionId} terminal={clipboardSession.terminal} />
        )}

        <div className="terminal-footer flex justify-between items-center text-xs text-gray-400 p-2">
          <span id="terminal-footer-info">
            Connessione PTY interattiva bidirezionale
          </span>
          <span id="terminal-footer-dims" className="badge bg-secondary">
            {cols} x {rows}
          </span>
        </div>
      </div>
    </div>
  );
};
