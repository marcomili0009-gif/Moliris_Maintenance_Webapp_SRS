import React, { useEffect, useRef } from "react";
import type { TerminalState } from "../../hooks/useTerminal.ts";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";

interface TerminalModalProps {
  terminalState: TerminalState;
  onClose: () => void;
  onAttachWebSocket: (
    sessionId: string,
    onData: (data: string) => void,
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
  const termInstanceRef = useRef<any>(null);
  const fitAddonRef = useRef<any>(null);

  const { isOpen, robotName, sessionId, status, error, cols, rows } = terminalState;

  useEffect(() => {
    if (!isOpen || !sessionId || !containerRef.current) return;

    // Inizializza xterm
    const TerminalClass = (window as any).Terminal || Terminal;
    const FitAddonClass = (window as any).FitAddon?.FitAddon || FitAddon;

    if (!TerminalClass) {
      console.error("Terminal class not available");
      return;
    }

    const term = new TerminalClass({
      cursorBlink: true,
      cols: cols || 80,
      rows: rows || 24,
      theme: {
        background: "#1e1e1e",
        foreground: "#f0f0f0",
      },
    });

    let fitAddon: any = null;
    if (FitAddonClass) {
      fitAddon = new FitAddonClass();
      term.loadAddon(fitAddon);
      fitAddonRef.current = fitAddon;
    }

    containerRef.current.innerHTML = "";
    term.open(containerRef.current);
    if (fitAddon) {
      try {
        fitAddon.fit();
      } catch {}
    }
    termInstanceRef.current = term;

    term.onData((data: string) => {
      onSendInput(data);
    });

    onAttachWebSocket(
      sessionId,
      (data) => {
        term.write(data);
      },
      () => {
        term.write("\r\n\x1b[31m[Sessione terminale terminata dal server]\x1b[0m\r\n");
      },
      () => {
        term.write("\r\n\x1b[31m[Errore canale WebSocket]\x1b[0m\r\n");
      }
    );

    const handleResize = () => {
      if (fitAddonRef.current && termInstanceRef.current) {
        try {
          fitAddonRef.current.fit();
          onResize(termInstanceRef.current.cols, termInstanceRef.current.rows);
        } catch {}
      }
    };
    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("resize", handleResize);
      try {
        term.dispose();
      } catch {}
      termInstanceRef.current = null;
      fitAddonRef.current = null;
    };
  }, [isOpen, sessionId, onAttachWebSocket, onSendInput, onResize, cols, rows]);

  if (!isOpen) return null;

  let statusBadgeClass = "badge-non_verificato";
  let statusText = "In connessione...";
  if (status === "connected") {
    statusBadgeClass = "badge-attivo";
    statusText = "Connesso (Attivo)";
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
          style={{ minHeight: "340px", backgroundColor: "#1e1e1e", padding: "4px" }}
        />

        <div className="terminal-footer flex justify-between items-center text-xs text-gray-500 p-2">
          <span id="terminal-footer-info">
            Connessione PTY interattiva bidirezionale (RF-SSH-002, RF-SSH-004)
          </span>
          <span id="terminal-footer-dims" className="badge">
            {cols} x {rows}
          </span>
        </div>
      </div>
    </div>
  );
};
