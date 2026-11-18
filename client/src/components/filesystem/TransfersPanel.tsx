import React from "react";
import type { TransferProgress } from "../../types/transfer.ts";
import { StateFormatter } from "../../services/state-formatter.ts";

const STATUS_LABELS: Record<string, string> = {
  QUEUED: "In coda",
  IN_PROGRESS: "In corso",
  INTEGRITY_CHECKING: "Verifica integrità",
  COMPLETED: "Completato",
  FAILED: "Fallito",
  CANCELLED: "Annullato",
  INTEGRITY_FAILED: "Integrità fallita",
};

interface TransfersPanelProps {
  transfers: TransferProgress[];
  loading: boolean;
  onRefresh: () => void;
  onCancelTransfer: (transferId: string) => void;
}

export const TransfersPanel: React.FC<TransfersPanelProps> = ({
  transfers,
  loading,
  onRefresh,
  onCancelTransfer,
}) => {
  return (
    <div id="fs-panel-transfers" className="fs-panel">
      {/* Intestazione allineata con pulsante Aggiorna Lista posizionato a destra */}
      <div className="fs-header d-flex justify-content-between align-items-center mb-3 flex-wrap gap-2">
        <div>
          <h3 className="h5 fw-bold mb-1">Trasferimenti File e Avanzamento Streaming</h3>
          <small className="fs-subtitle text-secondary">
            Monitoraggio in tempo reale di tutte le operazioni di trasferimento (Computer ↔ Server, Server ↔ Robot, Computer ↔ Robot).
          </small>
        </div>
        <div className="d-flex align-items-center gap-2">
          <button
            type="button"
            id="btn-refresh-transfers"
            className="btn btn-outline-primary btn-sm"
            onClick={onRefresh}
            disabled={loading}
          >
            Aggiorna Lista
          </button>
        </div>
      </div>

      {/* Contenitore e Tabella Trasferimenti con avanzamento streaming */}
      <div id="transfers-container" className="transfers-list-container mt-2">
        {transfers.length === 0 ? (
          <div id="transfers-empty-msg" className="fs-empty-msg p-4 text-center text-secondary border rounded bg-white">
            Nessun trasferimento attivo o recente registrato.
          </div>
        ) : (
          <div className="table-responsive bg-white rounded border shadow-sm">
            <table className="table table-hover align-middle mb-0" id="transfers-table">
              <thead className="table-light">
                <tr>
                  <th scope="col" style={{ width: "30%" }}>Trasferimento</th>
                  <th scope="col" style={{ width: "32%" }}>Avanzamento Streaming</th>
                  <th scope="col" style={{ width: "16%" }}>Velocità / ETA</th>
                  <th scope="col" style={{ width: "12%" }}>Stato</th>
                  <th scope="col" style={{ width: "10%" }} className="text-end">Azioni</th>
                </tr>
              </thead>
              <tbody id="transfers-list">
                {transfers.map((trf) => {
                  const isQueued = trf.status === "QUEUED";
                  const isInProgress = trf.status === "IN_PROGRESS";
                  const isIntegrityChecking = trf.status === "INTEGRITY_CHECKING";
                  const isActive = isQueued || isInProgress || isIntegrityChecking;
                  const isFailed = trf.status === "FAILED" || trf.status === "INTEGRITY_FAILED";
                  const isCancelled = trf.status === "CANCELLED";
                  const isCompleted = trf.status === "COMPLETED";

                  let statusClass = "badge-attivo";
                  if (isActive) statusClass = "badge-avviso";
                  else if (isFailed || isCancelled) statusClass = "badge-errore";

                  return (
                    <tr key={trf.transferId} className="transfer-card">
                      <td>
                        <div className="fw-semibold text-truncate small" title={`${trf.sourceFile} → ${trf.targetFile}`}>
                          {trf.sourceFile} <span className="text-muted">&rarr;</span> {trf.targetFile}
                        </div>
                        {trf.direction && (
                          <span className="badge bg-light text-secondary border text-xs mt-1">
                            {trf.direction}
                          </span>
                        )}
                      </td>

                      <td>
                        <div className="d-flex justify-content-between text-xs mb-1">
                          <span>
                            {StateFormatter.formatBytes(trf.transferredBytes)} / {StateFormatter.formatBytes(trf.totalBytes)}
                          </span>
                          <span className="fw-bold">{trf.percentage}%</span>
                        </div>
                        <div className="progress" style={{ height: "7px", backgroundColor: "#e2e8f0" }}>
                          <div
                            className={`progress-bar ${
                              isFailed
                                ? "bg-danger"
                                : isCompleted
                                ? "bg-success"
                                : isCancelled
                                ? "bg-secondary"
                                : isQueued
                                ? "bg-warning progress-bar-striped"
                                : "bg-primary progress-bar-striped progress-bar-animated"
                            }`}
                            role="progressbar"
                            style={{
                              width: `${Math.min(100, Math.max(0, trf.percentage || 0))}%`,
                              transition: "width 0.3s ease",
                            }}
                            aria-valuenow={trf.percentage}
                            aria-valuemin={0}
                            aria-valuemax={100}
                          />
                        </div>
                      </td>

                      <td>
                        {isQueued ? (
                          <span className="text-muted text-xs">In attesa di uno slot libero</span>
                        ) : isIntegrityChecking ? (
                          <span className="text-muted text-xs">Verifica integrità in corso</span>
                        ) : isInProgress ? (
                          <div className="text-xs">
                            <div className="fw-semibold">{StateFormatter.formatBytes(trf.speedBps)}/s</div>
                            <div className="text-muted">ETA: {trf.etaSeconds !== null ? `${trf.etaSeconds}s` : "—"}</div>
                          </div>
                        ) : (
                          <span className="text-muted text-xs">—</span>
                        )}
                      </td>

                      <td>
                        <span className={`badge-status ${statusClass}`}>
                          {STATUS_LABELS[trf.status] || trf.status}
                        </span>
                      </td>

                      <td className="text-end">
                        {isActive && (
                          <button
                            type="button"
                            className="btn btn-outline-danger btn-sm py-0.5 px-2 text-xs"
                            onClick={() => onCancelTransfer(trf.transferId)}
                          >
                            Annulla
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};
