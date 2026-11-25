import React from "react";
import type { RegistrationOutcome } from "../../types/fleet.ts";

interface RegistrationOutcomeModalProps {
  outcome: RegistrationOutcome | string | null;
  isOpen: boolean;
  onClose: () => void;
}

const OUTCOME_LABELS: Record<string, string> = {
  registrazione_completata: "Registrazione Completata",
  registrazione_completata_con_avvisi: "Registrazione Completata con Avvisi",
  ssh_non_verificata: "SSH Non Verificata (Modalità Differita)",
  completata_con_funzionalita_non_verificate: "Completata con Funzionalità Non Verificate",
  creazione_directory_fallita: "Creazione Directory Fallita",
};

export const RegistrationOutcomeModal: React.FC<RegistrationOutcomeModalProps> = ({
  outcome,
  isOpen,
  onClose,
}) => {
  if (!isOpen || !outcome) return null;

  const normalized: RegistrationOutcome =
    typeof outcome === "string"
      ? { outcome, success: outcome === "registrazione_completata" }
      : outcome;

  const rawCode = normalized.caseCode || normalized.outcome || "registrazione_completata";
  const displayCaseCode = OUTCOME_LABELS[rawCode] ? `${rawCode} (${OUTCOME_LABELS[rawCode]})` : rawCode;
  const isSuccess =
    normalized.success !== undefined
      ? normalized.success
      : rawCode === "registrazione_completata";
  const description = normalized.description || normalized.message || "Operazione completata.";
  const warningText =
    normalized.warning ||
    (rawCode === "ssh_non_verificata" || rawCode === "registrazione_completata_con_avvisi"
      ? "Alcune verifiche o funzionalità richiedono controllo prima dell'uso operativo."
      : undefined);
  const suggestedAction = normalized.suggestedAction || normalized.recoveryPath;
  const performedActions = Array.isArray(normalized.performedActions) ? normalized.performedActions : [];
  const skippedActions = Array.isArray(normalized.skippedActions) ? normalized.skippedActions : [];

  return (
    <div id="modal-registration-outcome" className="modal" role="dialog" aria-modal="true">
      <div className="modal-content">
        <div className="modal-header">
          <h3 id="outcome-modal-title">{normalized.title || "Riepilogo Esito Registrazione"}</h3>
          <button
            type="button"
            className="btn-close"
            id="btn-close-outcome"
            onClick={onClose}
            aria-label="Chiudi"
          />
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
              Codice Caso: <span className="badge text-bg-secondary ms-1">{displayCaseCode}</span>
            </div>
            <p className="mt-2 mb-0 text-sm">{description}</p>
          </div>

          {warningText && (
            <div className="alert-box alert-warning text-sm mb-3 p-2 rounded border border-warning">
              <strong>Avvertenza:</strong> {warningText}
            </div>
          )}

          {performedActions.length > 0 && (
            <div className="text-sm mb-3">
              <strong>Azioni eseguite:</strong>
              <ul className="mb-0 mt-1 ps-3">
                {performedActions.map((act) => (
                  <li key={act}><code>{act}</code></li>
                ))}
              </ul>
            </div>
          )}

          {skippedActions.length > 0 && (
            <div className="text-sm mb-3 text-muted">
              <strong>Azioni saltate:</strong>
              <ul className="mb-0 mt-1 ps-3">
                {skippedActions.map((act) => (
                  <li key={act}><code>{act}</code></li>
                ))}
              </ul>
            </div>
          )}

          {suggestedAction && (
            <div className="text-sm text-gray-700 bg-light p-2.5 rounded border">
              <strong>Azione suggerita:</strong> {suggestedAction}
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
