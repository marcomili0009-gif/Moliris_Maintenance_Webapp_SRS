import React from "react";

export interface InactivityWarningModalProps {
  isOpen: boolean;
  remainingMinutes: number;
  onConfirm: () => void | Promise<void>;
  onLogout: () => void | Promise<void>;
}

export const InactivityWarningModal: React.FC<InactivityWarningModalProps> = ({
  isOpen,
  remainingMinutes,
  onConfirm,
  onLogout,
}) => {
  if (!isOpen) return null;

  return (
    <div
      className="modal fade show d-block"
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-labelledby="inactivity-modal-title"
      style={{ backgroundColor: "rgba(0, 0, 0, 0.5)", zIndex: 1060 }}
    >
      <div className="modal-dialog modal-dialog-centered" role="document">
        <div className="modal-content shadow border-0">
          <div className="modal-header bg-warning-subtle text-warning-emphasis">
            <h5 className="modal-title fw-bold" id="inactivity-modal-title">
              Avviso di Inattività della Sessione
            </h5>
          </div>
          <div className="modal-body py-4">
            <p className="mb-0 text-secondary">
              La sessione scadrà tra {remainingMinutes} {remainingMinutes === 1 ? "minuto" : "minuti"} per inattività. Confermare per mantenere attiva la sessione o uscire.
            </p>
          </div>
          <div className="modal-footer">
            <button
              type="button"
              id="btn-logout-activity"
              className="btn btn-outline-danger"
              onClick={onLogout}
            >
              Esci
            </button>
            <button
              type="button"
              id="btn-confirm-activity"
              className="btn btn-primary"
              onClick={onConfirm}
            >
              Conferma
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
