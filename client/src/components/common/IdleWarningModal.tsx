import React, { useEffect, useRef } from "react";
import { Modal } from "./Modal.tsx";

export interface IdleWarningModalProps {
  isOpen: boolean;
  context: "sessione" | "terminale";
  targetName?: string;
  remainingSeconds: number;
  message?: string;
  onConfirm: () => void | Promise<void>;
  onLogout: () => void | Promise<void>;
}

export const IdleWarningModal: React.FC<IdleWarningModalProps> = ({
  isOpen,
  context,
  targetName,
  remainingSeconds,
  message,
  onConfirm,
  onLogout,
}) => {
  const confirmBtnRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (isOpen) {
      // Accessibilità: focus immediato sull'azione predefinita di conferma
      confirmBtnRef.current?.focus();
    }
  }, [isOpen]);

  useEffect(() => {
    if (isOpen && remainingSeconds <= 0) {
      // Se il conto alla rovescia arriva a zero senza risposta, la sessione termina (Prompt #4)
      void onLogout();
    }
  }, [isOpen, remainingSeconds, onLogout]);

  if (!isOpen) return null;

  const minutes = Math.floor(Math.max(0, remainingSeconds) / 60);
  const seconds = Math.floor(Math.max(0, remainingSeconds) % 60);
  const formattedCountdown = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;

  const contextLabel =
    context === "terminale"
      ? `Terminale ${targetName ? `(${targetName})` : ""}`
      : "Sessione di lavoro generale";

  const defaultMessage =
    context === "terminale"
      ? `Il terminale SSH verrà disconnesso per inattività tra ${formattedCountdown}.`
      : `La sessione applicativa scadrà per inattività tra ${formattedCountdown}. Eseguire un'azione per mantenerla attiva.`;

  return (
    <Modal
      id="modal-idle-warning"
      isOpen={isOpen}
      onClose={onConfirm}
      title={
        <div className="d-flex align-items-center gap-2">
          <span className="badge bg-warning text-dark text-uppercase px-2 py-1" id="idle-warning-badge">
            {context === "terminale" ? "Terminale" : "Sessione"}
          </span>
          <h3 id="idle-warning-title" className="m-0 fs-5">
            Avviso di inattività
          </h3>
        </div>
      }
      role="alertdialog"
      ariaLabelledBy="idle-warning-title"
      footer={
        <div className="d-flex justify-content-end gap-2 w-100">
          <button
            type="button"
            id="btn-idle-logout"
            className="btn btn-outline-danger"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              void onLogout();
            }}
          >
            Esci
          </button>
          <button
            type="button"
            id="btn-idle-confirm"
            ref={confirmBtnRef}
            className="btn btn-primary"
            onClick={onConfirm}
          >
            Conferma
          </button>
        </div>
      }
    >
      <div className="text-center py-2">
        <p className="text-muted mb-2" id="idle-warning-context-desc">
          Contesto interessato: <strong>{contextLabel}</strong>
        </p>

        <div className="my-3">
          <div
            id="idle-warning-countdown"
            className="fs-1 fw-bold font-monospace text-danger"
            aria-live="polite"
          >
            {formattedCountdown}
          </div>
          <small className="text-muted">tempo residuo prima della disconnessione</small>
        </div>

        <p id="idle-warning-message" className="mb-0 text-secondary">
          {message || defaultMessage}
        </p>
      </div>
    </Modal>
  );
};
