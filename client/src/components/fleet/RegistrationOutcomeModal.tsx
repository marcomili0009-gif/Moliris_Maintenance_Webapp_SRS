import React from "react";
import type { RegistrationOutcome } from "../../types/fleet.ts";

interface RegistrationOutcomeModalProps {
  outcome: RegistrationOutcome | null;
  isOpen: boolean;
  onClose: () => void;
}

export const RegistrationOutcomeModal: React.FC<RegistrationOutcomeModalProps> = ({
  outcome,
  isOpen,
  onClose,
}) => {
  if (!isOpen || !outcome) return null;

  const isSuccess = outcome.success;

  return (
    <div id="modal-registration-outcome" className="modal" role="dialog" aria-modal="true">
      <div className="modal-content">
        <div className="modal-header">
          <h3 id="outcome-modal-title">{outcome.title || "Riepilogo Esito Registrazione"}</h3>
          <button
            type="button"
            className="btn-close"
            id="btn-close-outcome"
            onClick={onClose}
          >
            &times;
          </button>
        </div>

        <div className="modal-body" id="outcome-modal-body">
          <div
            className={`alert-box ${isSuccess ? "alert-success" : "alert-warning"} mb-3`}
            style={{
              padding: "0.75rem",
              borderRadius: "6px",
              backgroundColor: isSuccess ? "#f0fdf4" : "#fffbeb",
              border: `1px solid ${isSuccess ? "#86efac" : "#fcd34d"}`,
            }}
          >
            <div className="font-semibold text-sm">
              Codice Caso: <span className="badge">{outcome.caseCode}</span>
            </div>
            <p className="mt-1 text-sm">{outcome.description}</p>
          </div>

          {outcome.warning && (
            <div className="alert-box alert-warning text-sm mb-3">
              <strong>Avvertenza:</strong> {outcome.warning}
            </div>
          )}

          {outcome.suggestedAction && (
            <div className="text-sm text-gray-700 bg-gray-50 p-2.5 rounded border border-gray-200">
              <strong>Azione suggerita:</strong> {outcome.suggestedAction}
            </div>
          )}
        </div>

        <div className="modal-footer">
          <button
            type="button"
            className="btn btn-primary"
            id="btn-dismiss-outcome"
            onClick={onClose}
          >
            Chiudi
          </button>
        </div>
      </div>
    </div>
  );
};
