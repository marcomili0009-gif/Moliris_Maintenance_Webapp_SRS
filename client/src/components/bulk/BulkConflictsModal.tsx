import React from "react";
import type { BulkConflict } from "../../types/transfer.ts";
import { DoubleSubmitButton } from "../common/DoubleSubmitButton.tsx";

interface BulkConflictsModalProps {
  isOpen: boolean;
  conflicts: BulkConflict[];
  onClose: () => void;
  onConfirmOverwrite: () => Promise<void>;
}

export const BulkConflictsModal: React.FC<BulkConflictsModalProps> = ({
  isOpen,
  conflicts,
  onClose,
  onConfirmOverwrite,
}) => {
  if (!isOpen) return null;

  return (
    <div id="modal-bulk-conflicts" className="modal" role="dialog" aria-modal="true">
      <div className="modal-content">
        <div className="modal-header">
          <h3 style={{ color: "#b91c1c" }}>Rilevati Conflitti di Sovrascrittura</h3>
          <button
            type="button"
            className="btn-close"
            id="btn-close-bulk-conflicts"
            onClick={onClose}
          >
            &times;
          </button>
        </div>

        <div className="modal-body">
          <p>I seguenti file esistono già nelle destinazioni selezionate:</p>
          <div
            id="bulk-conflicts-list"
            style={{
              maxHeight: "160px",
              overflowY: "auto",
              background: "#fef2f2",
              border: "1px solid #f87171",
              borderRadius: "6px",
              padding: "0.75rem",
              margin: "1rem 0",
              fontFamily: "monospace",
              fontSize: "0.85rem",
            }}
          >
            {conflicts.map((c, i) => (
              <div key={i} className="mb-1">
                <strong>[{c.targetType.toUpperCase()}: {c.targetName}]</strong> {c.filename} &rarr; {c.targetPath}
              </div>
            ))}
          </div>

          <div className="alert-box alert-warning">
            <strong>Politica di integrità e atomicità:</strong>
            <br />
            Se confermi, i file preesistenti verranno sostituiti in modo atomico solo al termine del trasferimento e verifica del checksum.
            <br />
            Se annulli, l'intera operazione verrà interrotta immediatamente e i file originari resteranno completamente intatti e inalterati.
          </div>
        </div>

        <div className="modal-footer">
          <button
            type="button"
            className="btn btn-secondary"
            id="btn-bulk-cancel-conflicts"
            onClick={onClose}
          >
            Annulla Operazione (Conserva Esistenti)
          </button>
          <DoubleSubmitButton
            type="button"
            className="btn btn-danger"
            id="btn-bulk-confirm-overwrite"
            onAsyncClick={onConfirmOverwrite}
            pendingText="Sovrascrittura in corso..."
          >
            Sovrascrivi Confermati
          </DoubleSubmitButton>
        </div>
      </div>
    </div>
  );
};
