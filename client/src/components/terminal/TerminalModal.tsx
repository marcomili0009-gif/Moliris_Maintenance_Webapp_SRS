import React, { useEffect, useRef, useState } from "react";
import type { TerminalState } from "../../hooks/useTerminal.ts";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import { ConfirmDialog } from "../common/ConfirmDialog.tsx";
import { TerminalClipboard } from "./TerminalClipboard.tsx";

interface TerminalModalProps {
  terminalState: TerminalState;
  isOpen: boolean;
  onHide: () => void;
  onDisconnect: (target: string) => Promise<void>;
  onLoadError: (target: string) => void;
  onAttachWebSocket: (
    target: string,
    sessionId: string,
    onData: (data: string | Uint8Array) => void,
    onClose: () => void,
    onError: () => void
  ) => void;
  onSendInput: (target: string, data: string) => void;
  onResize: (target: string, cols: number, rows: number) => void;
}

export const TerminalModal: React.FC<TerminalModalProps> = ({
  terminalState,
  isOpen,
  onHide,
  onDisconnect,
  onLoadError,
  onAttachWebSocket,
  onSendInput,
  onResize,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termInstanceRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const fitRef = useRef<() => void>(() => {});
  const lastSentSizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const visibleRef = useRef(isOpen);
  visibleRef.current = isOpen;
  const [isExpanded, setIsExpanded] = useState<boolean>(false);
  const [clipboardSession, setClipboardSession] = useState<{ id: string; terminal: Terminal } | null>(null);

  const { target, robotId, robotName, sessionId, status, error, cols, rows } = terminalState;

  // I callback del parent vengono letti da un ref mutabile: il terminale e il
  // WebSocket devono essere creati UNA SOLA VOLTA per sessione, non a ogni
  // render o resize (altrimenti il PTY viene chiuso e la sessione va persa).
  const callbacksRef = useRef({ onAttachWebSocket, onSendInput, onResize, onLoadError });
  callbacksRef.current = { onAttachWebSocket, onSendInput, onResize, onLoadError };

  // Ogni nuova sessione (e ogni chiusura) riparte sempre in modalità ridotta.
  useEffect(() => {
    setIsExpanded(false);
    setConfirmDisconnect(false);
  }, [isOpen, sessionId]);

  useEffect(() => {
    if (!sessionId || !containerRef.current) return;

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
      if (visibleRef.current) term.focus();
      setClipboardSession({ id: sessionId, terminal: term });

      // Adatta il PTY alle dimensioni reali del contenitore. Invia il resize
      // solo quando righe/colonne cambiano davvero, per evitare raffiche inutili.
      const performFit = () => {
        if (!visibleRef.current || !fitAddonRef.current || !termInstanceRef.current) return;
        try {
          fitAddonRef.current.fit();
          const newCols = termInstanceRef.current.cols;
          const newRows = termInstanceRef.current.rows;
          const previous = lastSentSizeRef.current;
          if (newCols && newRows && (previous?.cols !== newCols || previous?.rows !== newRows)) {
            lastSentSizeRef.current = { cols: newCols, rows: newRows };
            callbacksRef.current.onResize(target, newCols, newRows);
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
        target,
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
        callbacksRef.current.onSendInput(target, data);
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
      if (!cancelled) callbacksRef.current.onLoadError(target);
    });
    return () => {
      cancelled = true;
      dispose?.();
    };
    // Volutamente NON dipendente da cols/rows né dai callback del parent:
    // questo effetto governa il ciclo di vita della sessione terminale.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, sessionId]);

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

  useEffect(() => {
    if (isOpen) termInstanceRef.current?.focus();
  }, [isOpen]);

  let statusBadgeClass = "badge-non_verificato";
  let statusText = "Connessione in corso...";
  if (status === "connected") {
    statusBadgeClass = "badge-attivo";
    statusText = "Connesso";
  } else if (status === "disconnecting") {
    statusText = "Disconnessione in corso...";
  } else if (status === "disconnected") {
    statusBadgeClass = "badge-disabilitato";
    statusText = "Disconnesso";
  } else if (status === "error") {
    statusBadgeClass = "badge-errore";
    statusText = "Errore Connessione";
  }

  return (
    <div id={isOpen ? "modal-terminal" : undefined} className={isOpen ? "modal" : "modal hidden"} role="dialog" aria-modal={isOpen || undefined} inert={!isOpen}>
      <div className={`modal-content modal-terminal-window ${isExpanded ? "terminal-expanded" : ""}`}>
        <div className="modal-header terminal-modal-header">
          <div className="terminal-title-container flex items-center gap-2">
            <h3 id={isOpen ? "terminal-robot-title" : undefined}>
              {robotId === null ? "Terminale Server: Host Locale" : `Terminale Remoto: ${robotName}`}
            </h3>
            <span id={isOpen ? "terminal-session-status" : undefined} className={`badge-status ${statusBadgeClass}`}>
              {statusText}
            </span>
          </div>
          <div className="terminal-header-actions flex items-center gap-2">
            <button
              type="button"
              className="btn btn-outline-light btn-sm"
              id={isOpen ? "btn-terminal-expand" : undefined}
              title={isExpanded ? "Ripristina dimensioni normali" : "Espandi a finestra intera"}
              aria-pressed={isExpanded}
              onClick={() => setIsExpanded((current) => !current)}
            >
              {isExpanded ? "Ripristina" : "Espandi"}
            </button>
            <button
              type="button"
              className="btn btn-danger btn-sm"
              id={isOpen ? "btn-terminal-disconnect" : undefined}
              disabled={status === "disconnecting"}
              onClick={() => {
                if (status === "connected" || status === "connecting") setConfirmDisconnect(true);
                else void onDisconnect(target);
              }}
            >
              Disconnetti
            </button>
            <button
              type="button"
              className="btn-close terminal-hide-button"
              id={isOpen ? "btn-close-terminal" : undefined}
              onClick={onHide}
              title="Nascondi terminale"
              aria-label="Nascondi terminale"
            />
          </div>
        </div>

        {error && (
          <div className="error-message m-2" role="alert">
            {error.userMessage}
          </div>
        )}

        <div className="terminal-body" id={isOpen ? "terminal-container" : undefined} ref={containerRef} />
        {isOpen && clipboardSession && clipboardSession.id === sessionId && (
          <TerminalClipboard key={sessionId} terminal={clipboardSession.terminal} />
        )}

        <div className="terminal-footer flex justify-between items-center text-xs text-gray-400 p-2">
          <span id={isOpen ? "terminal-footer-info" : undefined}>
            Connessione PTY interattiva bidirezionale
          </span>
          <span id={isOpen ? "terminal-footer-dims" : undefined} className="badge bg-secondary">
            {cols} x {rows}
          </span>
        </div>
      </div>
      {isOpen && (
        <ConfirmDialog
          id="modal-confirm-terminal-disconnect"
          isOpen={confirmDisconnect}
          onClose={() => setConfirmDisconnect(false)}
          onConfirm={() => onDisconnect(target)}
          title="Disconnettere il terminale?"
          warningNote="La disconnessione termina la sessione e può interrompere i comandi in esecuzione."
          confirmText="Disconnetti"
          confirmBtnId="btn-confirm-terminal-disconnect"
        />
      )}
    </div>
  );
};
