import React, { useEffect, useRef } from "react";
import type { TerminalState } from "../../hooks/useTerminal.ts";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

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

  const { isOpen, robotName, sessionId, status, error, cols, rows } = terminalState;

  useEffect(() => {
    if (!isOpen || !sessionId || !containerRef.current) return;

    const term = new Terminal({
      cursorBlink: true,
      cols: cols || 80,
      rows: rows || 24,
      fontFamily: '"DejaVu Sans Mono", "Ubuntu Mono", "Liberation Mono", Menlo, Monaco, Consolas, "Courier New", monospace',
      fontSize: 14,
      theme: {
        background: "#1e1e1e",
        foreground: "#f0f0f0",
        cursor: "#ffffff",
      },
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    fitAddonRef.current = fitAddon;
    termInstanceRef.current = term;

    containerRef.current.replaceChildren();
    term.open(containerRef.current);

    // Adattamento responsive con ResizeObserver e requestAnimationFrame
    const performFit = () => {
      if (fitAddonRef.current && termInstanceRef.current && containerRef.current) {
        try {
          fitAddonRef.current.fit();
          const newCols = termInstanceRef.current.cols;
          const newRows = termInstanceRef.current.rows;
          if (newCols && newRows) {
            onResize(newCols, newRows);
          }
        } catch {}
      }
    };

    // Primo fit immediato e ritardato di un frame per garantire il paint del DOM
    requestAnimationFrame(() => {
      performFit();
    });

    const resizeObserver = new ResizeObserver(() => {
      requestAnimationFrame(() => {
        performFit();
      });
    });
    resizeObserver.observe(containerRef.current);

    term.onData((data: string) => {
      onSendInput(data);
    });

    onAttachWebSocket(
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

    const handleWindowResize = () => {
      performFit();
    };
    window.addEventListener("resize", handleWindowResize);

    return () => {
      window.removeEventListener("resize", handleWindowResize);
      resizeObserver.disconnect();
      try {
        term.dispose();
      } catch {}
      termInstanceRef.current = null;
      fitAddonRef.current = null;
    };
  }, [isOpen, sessionId, onAttachWebSocket, onSendInput, onResize, cols, rows]);

  if (!isOpen) return null;

  let statusBadgeClass = "badge-non_verificato";
  let statusText = "Connessione in corso...";
  if (status === "connected") {
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
      <div className="modal-content modal-terminal-window">
        <div className="modal-header terminal-modal-header">
          <div className="terminal-title-container flex items-center gap-2">
            <h3 id="terminal-robot-title">Terminale Remoto: {robotName}</h3>
            <span id="terminal-session-status" className={`badge-status ${statusBadgeClass}`}>
              {statusText}
            </span>
          </div>
          <div className="terminal-header-actions flex items-center gap-2">
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
            >
              &times;
            </button>
          </div>
        </div>

        {error && (
          <div className="error-message m-2" role="alert">
            {error.userMessage}
          </div>
        )}

        <div
          className="terminal-body"
          id="terminal-container"
          ref={containerRef}
          style={{ minHeight: "340px", backgroundColor: "#1e1e1e", padding: "8px" }}
        />

        <div className="terminal-footer flex justify-between items-center text-xs text-gray-400 p-2">
          <span id="terminal-footer-info">
            Connessione PTY interattiva bidirezionale (RF-SSH-002, RF-SSH-004)
          </span>
          <span id="terminal-footer-dims" className="badge bg-secondary">
            {cols} x {rows}
          </span>
        </div>
      </div>
    </div>
  );
};
