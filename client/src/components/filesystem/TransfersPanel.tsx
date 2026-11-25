import React, { useCallback, useMemo, useState } from "react";
import type { TransferProgress } from "../../types/transfer.ts";
import {
  DIRECTION_LABELS,
  STATUS_LABELS,
  describeRoute,
  formatEta,
  formatProgressBytes,
  formatSpeed,
  isActiveStatus,
  isErrorStatus,
  isRetryableDirection,
} from "../../utils/transfer-format.ts";

type TransferFilter = "all" | "active" | "completed" | "errors";

const FILTERS: Array<{ id: TransferFilter; label: string }> = [
  { id: "all", label: "Tutti" },
  { id: "active", label: "In corso" },
  { id: "completed", label: "Completati" },
  { id: "errors", label: "Errori" },
];

function matchesFilter(trf: TransferProgress, filter: TransferFilter): boolean {
  switch (filter) {
    case "active":
      return isActiveStatus(trf.status);
    case "completed":
      return trf.status === "COMPLETED";
    case "errors":
      return isErrorStatus(trf.status);
    default:
      return true;
  }
}

interface TransfersPanelProps {
  transfers: TransferProgress[];
  loading: boolean;
  onRefresh: () => void;
  onCancelTransfer: (transferId: string) => void | Promise<unknown>;
  onCancelBatch?: (batchId: string) => void | Promise<unknown>;
  onRetryTransfer?: (transferId: string) => void | Promise<unknown>;
  onRemoveTransfer?: (transferId: string) => void | Promise<unknown>;
}

export const TransfersPanel: React.FC<TransfersPanelProps> = ({
  transfers,
  loading,
  onRefresh,
  onCancelTransfer,
  onCancelBatch,
  onRetryTransfer,
  onRemoveTransfer,
}) => {
  const [filter, setFilter] = useState<TransferFilter>("all");
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [pending, setPending] = useState<Set<string>>(() => new Set());

  const counts = useMemo(() => {
    const result: Record<TransferFilter, number> = { all: transfers.length, active: 0, completed: 0, errors: 0 };
    for (const trf of transfers) {
      if (isActiveStatus(trf.status)) result.active += 1;
      else if (trf.status === "COMPLETED") result.completed += 1;
      else if (isErrorStatus(trf.status)) result.errors += 1;
    }
    return result;
  }, [transfers]);

  const visible = useMemo(() => transfers.filter((trf) => matchesFilter(trf, filter)), [transfers, filter]);

  // Separazione e raggruppamento per batchId (REQUISITO #9)
  const { batchGroups, individualTransfers } = useMemo(() => {
    const batches = new Map<string, TransferProgress[]>();
    const individuals: TransferProgress[] = [];

    for (const trf of visible) {
      if (trf.batchId) {
        const existing = batches.get(trf.batchId) || [];
        existing.push(trf);
        batches.set(trf.batchId, existing);
      } else {
        individuals.push(trf);
      }
    }

    return {
      batchGroups: Array.from(batches.entries()).map(([batchId, items]) => ({
        batchId,
        items,
      })),
      individualTransfers: individuals,
    };
  }, [visible]);

  const toggleExpanded = useCallback((transferId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(transferId)) next.delete(transferId);
      else next.add(transferId);
      return next;
    });
  }, []);

  const runAction = useCallback(
    async (transferId: string, action?: (id: string) => void | Promise<unknown>) => {
      if (!action) return;
      setPending((prev) => new Set(prev).add(transferId));
      try {
        await action(transferId);
      } finally {
        setPending((prev) => {
          const next = new Set(prev);
          next.delete(transferId);
          return next;
        });
      }
    },
    []
  );

  return (
    <div id="fs-panel-transfers" className="fs-panel">
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
            {loading ? "Aggiornamento..." : "Aggiorna Lista"}
          </button>
        </div>
      </div>

      <div className="transfers-filters" role="group" aria-label="Filtra trasferimenti" id="transfers-filters">
        {FILTERS.map((item) => (
          <button
            key={item.id}
            type="button"
            id={`btn-transfer-filter-${item.id}`}
            className={`transfers-filter-btn${filter === item.id ? " active" : ""}`}
            aria-pressed={filter === item.id}
            onClick={() => setFilter(item.id)}
          >
            {item.label}
            <span className="transfers-filter-count">{counts[item.id]}</span>
          </button>
        ))}
      </div>

      <div id="transfers-container" className="transfers-list-container mt-2">
        {visible.length === 0 ? (
          <div id="transfers-empty-msg" className="fs-empty-msg p-4 text-center text-secondary border rounded bg-white">
            {transfers.length === 0
              ? "Nessun trasferimento attivo o recente registrato."
              : "Nessun trasferimento corrisponde al filtro selezionato."}
          </div>
        ) : (
          <>
            {/* RAGGRUPPAMENTO BATCH / CARICAMENTO MASSIVO (REQUISITO #9) */}
            {batchGroups.map(({ batchId, items }) => {
              const totalBytes = items.reduce((sum, item) => sum + (item.totalBytes || 0), 0);
              const transferredBytes = items.reduce((sum, item) => sum + (item.transferredBytes || 0), 0);
              const batchPercent =
                totalBytes > 0
                  ? Math.min(100, (transferredBytes / totalBytes) * 100)
                  : Math.min(
                      100,
                      items.reduce((sum, item) => sum + (Number(item.percentage) || 0), 0) / (items.length || 1)
                    );

              const isBatchActive = items.some((trf) => isActiveStatus(trf.status));
              const isBatchCompleted = items.length > 0 && items.every((trf) => trf.status === "COMPLETED");
              const isBatchCancelled = items.length > 0 && items.every((trf) => trf.status === "CANCELLED");
              const isBatchFailed = !isBatchActive && items.some((trf) => isErrorStatus(trf.status));

              const batchStatusLabel = isBatchActive
                ? "In corso"
                : isBatchCompleted
                ? "Completato"
                : isBatchCancelled
                ? "Annullato"
                : isBatchFailed
                ? "Errori"
                : "In corso";

              const batchStatusClass = isBatchCompleted
                ? "badge-attivo"
                : isBatchFailed
                ? "badge-errore"
                : isBatchCancelled
                ? "badge-nodata"
                : "badge-avviso";

              const isBatchBusy = pending.has(batchId) || items.some((trf) => pending.has(trf.transferId));

              return (
                <div
                  className="card shadow-sm mb-3 border batch-transfer-card"
                  key={batchId}
                  id={`batch-card-${batchId}`}
                >
                  <div className="card-header bg-light d-flex justify-content-between align-items-center flex-wrap gap-2 py-2">
                    <div className="d-flex align-items-center gap-2">
                      <span className="badge text-bg-primary">Caricamento Massivo</span>
                      <span className="fw-bold">Batch ID: {batchId}</span>
                      <span className="text-secondary small">({items.length} file)</span>
                    </div>
                    <div className="d-flex align-items-center gap-2">
                      <span className={`badge-status ${batchStatusClass}`}>{batchStatusLabel}</span>
                      {isBatchActive && (
                        <button
                          type="button"
                          id={`btn-cancel-batch-${batchId}`}
                          className="btn btn-outline-danger btn-sm"
                          onClick={() => {
                            if (onCancelBatch) {
                              return runAction(batchId, onCancelBatch);
                            }
                            const activeItems = items.filter((trf) => isActiveStatus(trf.status));
                            return Promise.all(
                              activeItems.map((trf) => runAction(trf.transferId, onCancelTransfer))
                            );
                          }}
                          disabled={isBatchBusy}
                        >
                          Annulla
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="card-body p-3">
                    <div className="mb-3">
                      <div className="d-flex justify-content-between align-items-center small mb-1">
                        <span className="text-secondary">Avanzamento complessivo:</span>
                        <span className="fw-bold">{batchPercent.toFixed(batchPercent % 1 === 0 ? 0 : 1)}%</span>
                      </div>
                      <div
                        className="transfer-progress-bar-bg"
                        role="progressbar"
                        aria-valuenow={Math.round(batchPercent)}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-label={`Avanzamento complessivo batch ${batchId}`}
                      >
                        <div
                          className={`transfer-progress-bar-fill${
                            isBatchCompleted
                              ? " completed"
                              : isBatchFailed
                              ? " failed"
                              : isBatchCancelled
                              ? " cancelled"
                              : ""
                          }`}
                          style={{ width: `${batchPercent}%` }}
                        />
                      </div>
                    </div>

                    {/* Elenco file del batch SENZA pulsanti individuali di annullamento */}
                    <div className="table-responsive">
                      <table className="table table-sm align-middle mb-0">
                        <thead className="table-light small">
                          <tr>
                            <th scope="col" style={{ width: "40%" }}>File</th>
                            <th scope="col" style={{ width: "30%" }}>Avanzamento</th>
                            <th scope="col" style={{ width: "15%" }}>Velocità</th>
                            <th scope="col" style={{ width: "15%" }}>Stato</th>
                          </tr>
                        </thead>
                        <tbody className="small">
                          {items.map((trf) => {
                            const itemPercent = Math.min(100, Math.max(0, Number(trf.percentage) || 0));
                            const itemCompleted = trf.status === "COMPLETED";
                            const itemFailed = isErrorStatus(trf.status);
                            const itemCancelled = trf.status === "CANCELLED";
                            const itemStatusClass = itemCompleted
                              ? "badge-attivo"
                              : itemFailed
                              ? "badge-errore"
                              : itemCancelled
                              ? "badge-nodata"
                              : "badge-avviso";

                            return (
                              <tr key={trf.transferId} data-transfer-id={trf.transferId} data-status={trf.status}>
                                <td>
                                  <div className="fw-semibold text-break">{trf.filename}</div>
                                  <small className="text-muted">
                                    {describeRoute(trf).source} → {describeRoute(trf).destination}
                                  </small>
                                </td>
                                <td>
                                  <div className="d-flex justify-content-between small text-muted">
                                    <span>{formatProgressBytes(trf)}</span>
                                    <span>{itemPercent.toFixed(0)}%</span>
                                  </div>
                                  <div className="progress" style={{ height: "4px" }}>
                                    <div
                                      className={`progress-bar ${
                                        itemCompleted
                                          ? "bg-success"
                                          : itemFailed
                                          ? "bg-danger"
                                          : itemCancelled
                                          ? "bg-secondary"
                                          : "bg-primary"
                                      }`}
                                      style={{ width: `${itemPercent}%` }}
                                    />
                                  </div>
                                </td>
                                <td>
                                  {trf.status === "IN_PROGRESS" && trf.speedBps > 0 ? (
                                    <span className="fw-semibold">{formatSpeed(trf.speedBps)}</span>
                                  ) : (
                                    <span className="text-muted">—</span>
                                  )}
                                </td>
                                <td>
                                  <span className={`badge-status ${itemStatusClass}`}>
                                    {STATUS_LABELS[trf.status] || trf.status}
                                  </span>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              );
            })}

            {/* TRASFERIMENTI INDIVIDUALI / NON-BATCH */}
            {individualTransfers.length > 0 && (
              <div className="transfers-table-wrap bg-white rounded border shadow-sm">
                <table className="transfers-table" id="transfers-table">
                  <colgroup>
                    <col style={{ width: "34%" }} />
                    <col style={{ width: "24%" }} />
                    <col style={{ width: "14%" }} />
                    <col style={{ width: "14%" }} />
                    <col style={{ width: "14%" }} />
                  </colgroup>
                  <thead>
                    <tr>
                      <th scope="col">Trasferimento</th>
                      <th scope="col">Avanzamento</th>
                      <th scope="col">Velocità / ETA</th>
                      <th scope="col">Stato</th>
                      <th scope="col" className="text-end">
                        Azioni
                      </th>
                    </tr>
                  </thead>
                  <tbody id="transfers-list">
                    {individualTransfers.map((trf) => {
                      const active = isActiveStatus(trf.status);
                      const failed = isErrorStatus(trf.status);
                      const cancelled = trf.status === "CANCELLED";
                      const completed = trf.status === "COMPLETED";
                      const queued = trf.status === "QUEUED";
                      const busy = pending.has(trf.transferId);
                      const route = describeRoute(trf);
                      const directionLabel = DIRECTION_LABELS[trf.direction] || trf.direction;
                      const percent = Math.min(100, Math.max(0, Number(trf.percentage) || 0));
                      const isExpanded = expanded.has(trf.transferId);
                      const canRetry = isRetryableDirection(trf.direction);

                      const statusClass = completed
                        ? "badge-attivo"
                        : failed
                        ? "badge-errore"
                        : cancelled
                        ? "badge-nodata"
                        : "badge-avviso";

                      const speedCell =
                        trf.status === "IN_PROGRESS" && trf.speedBps > 0 ? (
                          <span className="fw-semibold">
                            {formatSpeed(trf.speedBps)} • {formatEta(trf.etaSeconds)}
                          </span>
                        ) : queued ? (
                          <span className="text-muted">In attesa di uno slot</span>
                        ) : trf.status === "INTEGRITY_CHECKING" ? (
                          <span className="text-muted">Verifica in corso</span>
                        ) : (
                          <span className="text-muted">—</span>
                        );

                      return (
                        <React.Fragment key={trf.transferId}>
                          <tr className="transfers-row" data-transfer-id={trf.transferId} data-status={trf.status}>
                            <td className="transfers-cell-main">
                              <div className="transfers-file-line">
                                <span className="transfers-filename" title={trf.filename}>
                                  {trf.filename}
                                </span>
                                <span className="transfer-direction-badge">{directionLabel}</span>
                              </div>
                              <div className="transfers-route" title={`${route.source} → ${route.destination}`}>
                                {route.source} <span aria-hidden="true">→</span> {route.destination}
                              </div>
                            </td>

                            <td>
                              <div className="transfers-progress-meta">
                                <span>{formatProgressBytes(trf)}</span>
                                <span className="fw-bold">{percent.toFixed(percent % 1 === 0 ? 0 : 1)}%</span>
                              </div>
                              <div
                                className="transfer-progress-bar-bg"
                                role="progressbar"
                                aria-valuenow={Math.round(percent)}
                                aria-valuemin={0}
                                aria-valuemax={100}
                                aria-label={`Avanzamento di ${trf.filename}`}
                              >
                                <div
                                  className={`transfer-progress-bar-fill${
                                    completed ? " completed" : failed ? " failed" : cancelled ? " cancelled" : ""
                                  }`}
                                  style={{ width: `${percent}%` }}
                                />
                              </div>
                            </td>

                            <td className="transfers-cell-speed">{speedCell}</td>

                            <td>
                              <span className={`badge-status ${statusClass}`}>{STATUS_LABELS[trf.status] || trf.status}</span>
                              {(failed || cancelled) && (
                                <button
                                  type="button"
                                  className="transfers-details-toggle"
                                  aria-expanded={isExpanded}
                                  onClick={() => toggleExpanded(trf.transferId)}
                                >
                                  {isExpanded ? "Nascondi dettagli" : "Dettagli"}
                                </button>
                              )}
                            </td>

                            <td className="transfers-cell-actions">
                              {active && (
                                <button
                                  type="button"
                                  className="btn btn-outline-danger btn-sm"
                                  onClick={() => void runAction(trf.transferId, onCancelTransfer)}
                                  disabled={busy}
                                >
                                  Annulla
                                </button>
                              )}
                              {(failed || cancelled) && (
                                <button
                                  type="button"
                                  className="btn btn-outline-primary btn-sm"
                                  onClick={() => void runAction(trf.transferId, onRetryTransfer)}
                                  disabled={busy || !canRetry || !onRetryTransfer}
                                  title={
                                    canRetry
                                      ? "Riprende il trasferimento dal punto disponibile oppure lo riesegue"
                                      : "Trasferimento avviato dal computer: ripetere il caricamento o il download"
                                  }
                                >
                                  {cancelled ? "Riprendi" : "Riprova"}
                                </button>
                              )}
                              {!active && onRemoveTransfer && (
                                <button
                                  type="button"
                                  className="btn btn-outline-secondary btn-sm"
                                  onClick={() => void runAction(trf.transferId, onRemoveTransfer)}
                                  disabled={busy}
                                >
                                  Rimuovi
                                </button>
                              )}
                            </td>
                          </tr>
                          {isExpanded && (
                            <tr className="transfers-details-row">
                              <td colSpan={5}>
                                <div className="transfers-details" role="region" aria-label={`Dettagli di ${trf.filename}`}>
                                  <div>
                                    <strong>Messaggio:</strong>{" "}
                                    {trf.errorMessage || "Nessun messaggio diagnostico fornito dal backend."}
                                  </div>
                                  <div>
                                    <strong>Sorgente:</strong> {route.source}
                                  </div>
                                  <div>
                                    <strong>Destinazione:</strong> {route.destination}
                                  </div>
                                  <div>
                                    <strong>Integrità:</strong> {trf.integrityLabel || "non verificata"}
                                  </div>
                                  <div className="text-muted">ID trasferimento: {trf.transferId}</div>
                                </div>
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
};
