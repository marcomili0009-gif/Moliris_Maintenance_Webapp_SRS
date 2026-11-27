import React, { useCallback, useMemo, useState } from "react";
import type { TransferProgress } from "../../types/transfer.ts";
import {
  DIRECTION_LABELS,
  STATUS_LABELS,
  formatDurationMs,
  formatEta,
  formatProgressBytes,
  formatSpeedWithArrow,
  formatTransferEndpoints,
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
  onPauseTransfer?: (transferId: string) => void | Promise<unknown>;
  onResumeTransfer?: (transferId: string) => void | Promise<unknown>;
  onCancelBatch?: (batchId: string) => void | Promise<unknown>;
  onRetryTransfer?: (transferId: string) => void | Promise<unknown>;
  onRemoveTransfer?: (transferId: string) => void | Promise<unknown>;
  onClearTransfers?: () => void | Promise<unknown>;
}

function renderSpeedCell(trf: TransferProgress): React.ReactNode {
  const currentSpeed = trf.currentSpeedBps ?? trf.speedBps;
  const averageSpeed = trf.averageSpeedBps ?? (trf.status === "COMPLETED" ? trf.speedBps : null);

  if (trf.status === "IN_PROGRESS") {
    if (currentSpeed && currentSpeed > 0) {
      const speedLabel = formatSpeedWithArrow(trf.direction, currentSpeed);
      const etaLabel = formatEta(trf.etaSeconds);
      return (
        <span className="fw-semibold text-nowrap" title="Velocità istantanea e tempo residuo stimato">
          {etaLabel !== "—" ? `${speedLabel} · ETA ${etaLabel}` : speedLabel}
        </span>
      );
    }
    return <span className="text-muted">—</span>;
  }

  if (trf.status === "COMPLETED") {
    if (averageSpeed && averageSpeed > 0) {
      return (
        <span className="fw-semibold text-nowrap" title="Velocità media reale del trasferimento">
          {formatSpeedWithArrow(trf.direction, averageSpeed)}
        </span>
      );
    }
    return <span className="text-muted">—</span>;
  }

  if (trf.status === "QUEUED") {
    return <span className="text-muted">In attesa di uno slot</span>;
  }

  if (trf.status === "PAUSED") {
    return <span className="text-muted">In pausa</span>;
  }

  if (trf.status === "INTEGRITY_CHECKING") {
    return <span className="text-muted">Verifica in corso</span>;
  }

  if (averageSpeed && averageSpeed > 0) {
    return (
      <span className="text-muted text-nowrap" title="Velocità media raggiunta prima dell'interruzione">
        {formatSpeedWithArrow(trf.direction, averageSpeed)}
      </span>
    );
  }
  return <span className="text-muted">—</span>;
}

export const TransfersPanel: React.FC<TransfersPanelProps> = ({
  transfers,
  loading,
  onRefresh,
  onCancelTransfer,
  onPauseTransfer,
  onResumeTransfer,
  onCancelBatch,
  onRetryTransfer,
  onRemoveTransfer,
  onClearTransfers,
}) => {
  const [filter, setFilter] = useState<TransferFilter>("all");
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [pending, setPending] = useState<Set<string>>(() => new Set());
  const [clearingList, setClearingList] = useState<boolean>(false);

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

  // Separazione e raggruppamento rigoroso per batchId (REQUISITO #9)
  // Tutti i trasferimenti con lo stesso batchId restano contenuti dentro la stessa card Caricamento Massivo.
  const { batchGroups, individualTransfers } = useMemo(() => {
    const batches = new Map<string, TransferProgress[]>();
    const individuals: TransferProgress[] = [];

    for (const trf of transfers) {
      const normalizedBatchId = trf.batchId?.trim();
      if (normalizedBatchId && !trf.isBulkStaging) {
        const existing = batches.get(normalizedBatchId) || [];
        existing.push(trf);
        batches.set(normalizedBatchId, existing);
      } else if (matchesFilter(trf, filter)) {
        individuals.push(trf);
      }
    }

    return {
      batchGroups: Array.from(batches.entries())
        .map(([batchId, items]) => {
          const sortedItems = [...items].sort((a, b) => {
            const byName = a.filename.localeCompare(b.filename);
            if (byName !== 0) return byName;
            const byEndpoint = formatTransferEndpoints(a).label.localeCompare(formatTransferEndpoints(b).label);
            if (byEndpoint !== 0) return byEndpoint;
            return a.transferId.localeCompare(b.transferId);
          });
          return {
            batchId,
            items: sortedItems,
            visibleItems: sortedItems.filter((item) => matchesFilter(item, filter)),
          };
        })
        .filter(({ visibleItems }) => visibleItems.length > 0),
      individualTransfers: individuals,
    };
  }, [transfers, filter]);

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

  const removableCount = useMemo(
    () => transfers.filter((trf) => !isActiveStatus(trf.status)).length,
    [transfers]
  );

  const handleClearList = useCallback(async () => {
    if (!onClearTransfers || clearingList || removableCount === 0) return;
    setClearingList(true);
    try {
      await onClearTransfers();
    } finally {
      setClearingList(false);
    }
  }, [onClearTransfers, clearingList, removableCount]);

  return (
    <div id="fs-panel-transfers" className="fs-panel">
      <div className="fs-header d-flex justify-content-between align-items-center mb-3 flex-wrap gap-2">
        <div>
          <h3 className="h5 fw-bold mb-1">Trasferimenti File e Avanzamento Streaming</h3>
          <small className="fs-subtitle text-secondary">
            Il totale include le ricezioni iniziali dal browser. Ogni batch conta solo gli invii alle destinazioni.
          </small>
        </div>
        <div className="d-flex align-items-center gap-2">
          <button
            type="button"
            id="btn-refresh-transfers"
            className="btn btn-outline-primary btn-sm"
            onClick={onRefresh}
            disabled={loading || clearingList}
          >
            {loading ? "Aggiornamento..." : "Aggiorna Lista"}
          </button>
          {onClearTransfers && (
            <button
              type="button"
              id="btn-clear-transfers-list"
              className="btn btn-outline-danger btn-sm"
              onClick={() => void handleClearList()}
              disabled={loading || clearingList || removableCount === 0}
              title="Rimuove tutti i trasferimenti conclusi dalla lista senza eliminare alcun file trasferito"
            >
              {clearingList ? "Eliminazione..." : "Elimina lista"}
            </button>
          )}
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
            {batchGroups.map(({ batchId, items, visibleItems }) => {
              const batch = items[0].bulkBatch;
              const totalItems = batch?.totalItems ?? items.length;
              const totalBytes = batch?.totalBytes ?? items.reduce((sum, item) => sum + (item.totalBytes || 0), 0);
              const transferredBytes = items.reduce((sum, item) => sum + (item.transferredBytes || 0), 0);
              const batchPercent =
                totalBytes > 0
                  ? Math.min(100, (transferredBytes / totalBytes) * 100)
                  : Math.min(
                      100,
                      items.reduce((sum, item) => sum + (Number(item.percentage) || 0), 0) / totalItems
                    );

              const completedCount = items.filter((trf) => trf.status === "COMPLETED").length;
              const failedCount = items.filter((trf) => isErrorStatus(trf.status)).length;
              const cancelledCount = items.filter((trf) => trf.status === "CANCELLED").length;
              const isBatchActive = batch?.status
                ? batch.status === "QUEUED" || batch.status === "IN_PROGRESS"
                : items.some((trf) => isActiveStatus(trf.status));
              const isBatchCompleted = batch?.status
                ? batch.status === "COMPLETED"
                : items.length > 0 && completedCount === items.length;
              const isBatchCancelled = batch?.status
                ? batch.status === "CANCELLED"
                : items.length > 0 && cancelledCount === items.length;
              const isBatchFailed = batch?.status
                ? batch.status === "FAILED"
                : !isBatchActive && failedCount > 0;

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
                    <div className="d-flex align-items-center flex-wrap gap-2">
                      <span className="badge text-bg-primary">Caricamento Massivo</span>
                      <span className="fw-bold small">Batch ID: <code>{batchId}</code></span>
                      <span className="text-secondary small">
                        ({totalItems} invii · {completedCount} completati
                        {failedCount > 0 ? ` · ${failedCount} falliti` : ""}
                        {cancelledCount > 0 ? ` · ${cancelledCount} annullati` : ""})
                      </span>
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
                        <span className="fw-bold">{(Math.floor(batchPercent * 10) / 10).toLocaleString("it-IT", { maximumFractionDigits: 1 })}%</span>
                      </div>
                      <div
                        className="transfer-progress-bar-bg"
                        role="progressbar"
                        aria-valuenow={Math.floor(batchPercent)}
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

                    {/* Elenco completo e contenuto dei file del batch con intestazione fissa e scorrimento interno */}
                    <div className="batch-transfer-table-wrap border rounded bg-white">
                      <table className="table table-sm table-hover align-middle mb-0 batch-transfer-table">
                        <colgroup>
                          <col style={{ width: "42%" }} />
                          <col style={{ width: "26%" }} />
                          <col style={{ width: "18%" }} />
                          <col style={{ width: "14%" }} />
                        </colgroup>
                        <thead className="table-light small">
                          <tr>
                            <th scope="col">File</th>
                            <th scope="col">Avanzamento</th>
                            <th scope="col">Velocità</th>
                            <th scope="col">Stato</th>
                          </tr>
                        </thead>
                        <tbody className="small">
                          {visibleItems.map((trf) => {
                            const itemPercent = Math.min(100, Math.max(0, Number(trf.percentage) || 0));
                            const itemCompleted = trf.status === "COMPLETED";
                            const itemFailed = isErrorStatus(trf.status);
                            const itemCancelled = trf.status === "CANCELLED";
                            const endpoint = formatTransferEndpoints(trf);
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
                                  <div className="fw-semibold text-break" title={trf.filename}>
                                    {trf.filename}
                                  </div>
                                  <small className="text-muted d-block batch-transfer-endpoint">
                                    {endpoint.label}
                                  </small>
                                  {(itemFailed || itemCancelled) && trf.errorMessage && (
                                    <small className="text-danger d-block mt-1 text-break">
                                      {trf.errorMessage}
                                    </small>
                                  )}
                                </td>
                                <td>
                                  <div className="d-flex justify-content-between small text-muted">
                                    <span>{formatProgressBytes(trf)}</span>
                                    <span className="fw-semibold">{itemPercent.toFixed(itemPercent % 1 === 0 ? 0 : 1)}%</span>
                                  </div>
                                  <div className="progress mt-1" style={{ height: "5px" }}>
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
                                <td className="transfers-cell-speed">
                                  {renderSpeedCell(trf)}
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
                      const busy = pending.has(trf.transferId);
                      const endpoint = formatTransferEndpoints(trf);
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

                      const speedCell = renderSpeedCell(trf);

                      return (
                        <React.Fragment key={trf.transferId}>
                          <tr className="transfers-row" data-transfer-id={trf.transferId} data-status={trf.status}>
                            <td className="transfers-cell-main">
                              <div className="transfers-file-line">
                                <span className="transfers-filename" title={trf.filename}>
                                  {trf.filename}
                                </span>
                                <span className="transfer-direction-badge">
                                  {trf.isBulkStaging ? "Ricezione dal browser" : directionLabel}
                                </span>
                              </div>
                              <div className="transfers-route">
                                {endpoint.label}
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
                              {trf.status === "IN_PROGRESS" && onPauseTransfer && (
                                <button
                                  type="button"
                                  className="btn btn-outline-warning btn-sm"
                                  onClick={() => void runAction(trf.transferId, onPauseTransfer)}
                                  disabled={busy}
                                >
                                  Pausa
                                </button>
                              )}
                              {trf.status === "PAUSED" && onResumeTransfer && (
                                <button
                                  type="button"
                                  className="btn btn-outline-primary btn-sm"
                                  onClick={() => void runAction(trf.transferId, onResumeTransfer)}
                                  disabled={busy}
                                >
                                  Riprendi
                                </button>
                              )}
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
                                    <strong>Origine:</strong> {endpoint.source}
                                  </div>
                                  <div>
                                    <strong>Destinazione:</strong> {endpoint.destination || "—"}
                                  </div>
                                  <div>
                                    <strong>Integrità:</strong> {trf.integrityLabel || "non verificata"}
                                  </div>
                                  {trf.durationMs !== null && trf.durationMs !== undefined && (
                                    <div>
                                      <strong>Durata attiva:</strong> {formatDurationMs(trf.durationMs)}
                                    </div>
                                  )}
                                  <div className="text-muted">
                                    ID trasferimento: {trf.transferId}
                                    {trf.batchId ? ` · Batch ID: ${trf.batchId}` : ""}
                                  </div>
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
