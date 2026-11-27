import React, { useEffect, useRef } from "react";
import { Modal } from "./Modal.tsx";

export interface IdleWarningModalProps {
  isOpen: boolean;
  context: "sessione" | "terminale";
  targetName?: string;
  remainingSeconds: number;
  warningWindowSeconds?: number;
  message?: string;
  onConfirm: () => void | Promise<void>;
  onLogout: () => void | Promise<void>;
}

export const IdleWarningModal: React.FC<IdleWarningModalProps> = ({
  isOpen,
  context,
  targetName,
  remainingSeconds,
  warningWindowSeconds,
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

  const safeRemaining = Math.max(0, Math.floor(remainingSeconds));
  const minutes = Math.floor(safeRemaining / 60);
  const seconds = safeRemaining % 60;
  const formattedCountdown = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  const warningWindowTotalSeconds =
    warningWindowSeconds && warningWindowSeconds > 0 ? warningWindowSeconds : 300;
  const progressPercent = Math.min(100, Math.max(0, Math.round((safeRemaining / warningWindowTotalSeconds) * 100)));
  const isCritical = safeRemaining <= 60;

  const contextLabel =
    context === "terminale"
      ? `Terminale SSH${targetName ? ` — ${targetName}` : ""}`
      : "Sessione applicativa";

  const defaultMessage =
    context === "terminale"
      ? `Il terminale SSH verrà disconnesso per inattività allo scadere del conto alla rovescia.`
      : `La sessione verrà chiusa automaticamente per inattività allo scadere del conto alla rovescia.`;

  return (
    <Modal
      id="modal-idle-warning"
      isOpen={isOpen}
      onClose={() => {}}
      disableDismiss={true}
      title={
        <div className="d-flex align-items-center justify-content-between gap-2 w-100">
          <div className="d-flex align-items-center gap-2">
            <span
              className={`badge ${isCritical ? "text-bg-danger" : "text-bg-warning"} text-uppercase`}
              id="idle-warning-badge"
            >
              {context === "terminale" ? "Terminale" : "Sessione"}
            </span>
            <h3 id="idle-warning-title" className="h5 mb-0 fw-semibold">
              Avviso di inattività
            </h3>
          </div>
        </div>
      }
      role="alertdialog"
      ariaLabelledBy="idle-warning-title"
      footer={
        <div className="d-flex justify-content-between align-items-center gap-2 w-100">
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
            className="btn btn-primary px-4"
            onClick={onConfirm}
          >
            Conferma
          </button>
        </div>
      }
    >
      <div className="py-2">
        <div className="d-flex align-items-center justify-content-between border rounded px-3 py-2 bg-light mb-3 small">
          <span className="text-secondary">Contesto interessato</span>
          <strong id="idle-warning-context-desc" className="text-dark">
            {contextLabel}
          </strong>
        </div>

        <div className="text-center border rounded p-3 mb-3 bg-white">
          <div className="text-uppercase small text-secondary fw-semibold mb-1">
            Tempo residuo prima della disconnessione
          </div>
          <div
            id="idle-warning-countdown"
            className={`display-5 fw-bold font-monospace mb-2 ${isCritical ? "text-danger" : "text-dark"}`}
            aria-live="polite"
          >
            {formattedCountdown}
          </div>
          <div
            className="progress"
            role="progressbar"
            aria-label="Tempo residuo prima della scadenza"
            aria-valuenow={progressPercent}
            aria-valuemin={0}
            aria-valuemax={100}
            style={{ height: "6px" }}
          >
            <div
              className={`progress-bar ${isCritical ? "bg-danger" : "bg-warning"}`}
              style={{ width: `${progressPercent}%`, transition: "width 0.3s linear" }}
            />
          </div>
        </div>

        <p id="idle-warning-message" className="mb-0 small text-secondary text-center">
          {message || defaultMessage}
        </p>
      </div>
    </Modal>
  );
};
