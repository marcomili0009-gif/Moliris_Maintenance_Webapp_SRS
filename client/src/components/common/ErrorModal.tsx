import React, { useEffect, useRef } from "react";
import { AlertTriangle } from "lucide-react";
import { Modal } from "./Modal.tsx";
import type { FormattedError } from "../../types/error.ts";

export interface ErrorModalProps {
  isOpen: boolean;
  error?: FormattedError | null;
  onClose: () => void;
}

export const ErrorModal: React.FC<ErrorModalProps> = ({
  isOpen,
  error,
  onClose,
}) => {
  const closeBtnRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (isOpen) {
      // Focus immediato sul pulsante di chiusura per consentire invio o spazio per chiudere
      const timer = setTimeout(() => {
        closeBtnRef.current?.focus();
      }, 50);
      return () => clearTimeout(timer);
    }
  }, [isOpen]);

  if (!isOpen || !error) return null;

  const isCritical = error.classification === "richiede_intervento_amministrativo";

  return (
    <Modal
      id="modal-error-alert"
      isOpen={isOpen}
      onClose={onClose}
      role="alertdialog"
      ariaLabelledBy="error-modal-title"
      title={
        <h3 id="error-modal-title" className="d-flex align-items-center gap-2 text-danger m-0 fw-bold fs-5">
          <AlertTriangle size={24} className="text-danger flex-shrink-0" />
          <span>ATTENZIONE</span>
        </h3>
      }
      footer={
        <button
          type="button"
          ref={closeBtnRef}
          id="btn-error-modal-close"
          className="btn btn-primary px-4 fw-semibold"
          onClick={onClose}
        >
          Ho capito
        </button>
      }
    >
      <div className="d-flex flex-column gap-3 py-1">
        <div className={`p-3 rounded border ${isCritical ? "bg-danger-subtle border-danger" : "bg-warning-subtle border-warning"}`}>
          <div className="d-flex align-items-center justify-content-between mb-2 flex-wrap gap-2">
            <span className={`badge ${isCritical ? "bg-danger" : "bg-warning text-dark"} fs-6 fw-semibold`}>
              {isCritical ? "Richiesto Intervento Amministrativo" : "Errore Operativo"}
            </span>
            <span className="text-secondary small fw-semibold font-monospace">
              Codice: <code className="text-danger fw-bold">{error.code}</code>
            </span>
          </div>
          <div className="fs-6 text-dark fw-medium lh-base">
            {error.userMessage}
          </div>
        </div>

        {error.details && Object.keys(error.details).length > 0 && (
          <div className="small text-muted border-top pt-2">
            <div className="fw-semibold mb-1 text-secondary">Dettagli diagnostici:</div>
            <pre className="bg-light p-2 rounded border small mb-0 overflow-auto" style={{ maxHeight: 150 }}>
              {JSON.stringify(error.details, null, 2)}
            </pre>
          </div>
        )}
      </div>
    </Modal>
  );
};
