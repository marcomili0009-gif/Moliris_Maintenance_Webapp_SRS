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
  onRetryTransfer?: (transferId: string) => void | Promise<unknown>;
  onRemoveTransfer?: (transferId: string) => void | Promise<unknown>;
}

export const TransfersPanel: React.FC<TransfersPanelProps> = ({
  transfers,
  loading,
  onRefresh,
  onCancelTransfer,
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
                {visible.map((trf) => {
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
      </div>
    </div>
  );
};
