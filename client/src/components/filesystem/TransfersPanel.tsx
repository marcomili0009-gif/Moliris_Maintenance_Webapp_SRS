import React from "react";
import type { TransferProgress } from "../../types/transfer.ts";
import { StateFormatter } from "../../services/state-formatter.ts";

interface TransfersPanelProps {
  transfers: TransferProgress[];
  loading: boolean;
  onRefresh: () => void;
  onPurgeTemp: () => void;
  onCancelTransfer: (transferId: string) => void;
}

export const TransfersPanel: React.FC<TransfersPanelProps> = ({
  transfers,
  onRefresh,
  onPurgeTemp,
  onCancelTransfer,
}) => {
  return (
    <div id="fs-panel-transfers" className="fs-panel">
      <div className="fs-header">
        <div>
          <h3>Trasferimenti File e Avanzamento Streaming</h3>
          <small className="fs-subtitle">
            Monitoraggio in tempo reale di tutte le operazioni di trasferimento (Computer ↔ Server, Server ↔ Robot, Computer ↔ Robot).
          </small>
        </div>
        <div style={{ display: "flex", gap: "0.5rem" }}>
          <button
            type="button"
            id="btn-purge-transfers-temp"
            className="btn btn-danger btn-sm"
            title="Bonifica file temporanei orfani da tutti i robot e server"
            onClick={onPurgeTemp}
          >
            Bonifica File Temp
          </button>
          <button
            type="button"
            id="btn-refresh-transfers"
            className="btn btn-secondary btn-sm"
            onClick={onRefresh}
          >
            Aggiorna Lista
          </button>
        </div>
      </div>

      <div id="transfers-container" className="transfers-list-container mt-3">
        {transfers.length === 0 ? (
          <div id="transfers-empty-msg" className="fs-empty-msg">
            Nessun trasferimento attivo o recente registrato.
          </div>
        ) : (
          <div id="transfers-list" className="transfers-card-list">
            {transfers.map((trf) => {
              const isInProgress = trf.status === "IN_PROGRESS";
              const isFailed = trf.status === "FAILED";
              const isCancelled = trf.status === "CANCELLED";
              const isCompleted = trf.status === "COMPLETED";

              let statusClass = "badge-attivo";
              if (isInProgress) statusClass = "badge-avviso";
              else if (isFailed || isCancelled) statusClass = "badge-errore";

              return (
                <div
                  key={trf.transferId}
                  className="transfer-card card p-3 mb-2 border rounded"
                  style={{ background: "#ffffff" }}
                >
                  <div className="flex justify-between items-center mb-1">
                    <span className="font-semibold text-sm">
                      {trf.sourceFile} &rarr; {trf.targetFile}
                    </span>
                    <span className={`badge-status ${statusClass}`}>
                      {trf.status}
                    </span>
                  </div>

                  <div className="progress-container my-1.5" style={{ background: "#e2e8f0", borderRadius: "4px", height: "8px", overflow: "hidden" }}>
                    <div
                      className="progress-bar"
                      style={{
                        width: `${Math.min(100, Math.max(0, trf.percentage || 0))}%`,
                        height: "100%",
                        backgroundColor: isFailed ? "#ef4444" : "#0b57d0",
                        transition: "width 0.3s ease",
                      }}
                    />
                  </div>

                  <div className="flex justify-between items-center text-xs text-gray-600">
                    <span>
                      {StateFormatter.formatBytes(trf.transferredBytes)} /{" "}
                      {StateFormatter.formatBytes(trf.totalBytes)} ({trf.percentage}%)
                    </span>
                    {isInProgress && (
                      <span>
                        Velocità: {StateFormatter.formatBytes(trf.speedBps)}/s | ETA:{" "}
                        {trf.etaSeconds !== null ? `${trf.etaSeconds}s` : "-"}
                      </span>
                    )}
                    {isInProgress && (
                      <button
                        type="button"
                        className="btn btn-danger btn-sm text-xs py-0.5 px-2"
                        onClick={() => onCancelTransfer(trf.transferId)}
                      >
                        Annulla
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};
