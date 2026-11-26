import { useState, useCallback, useEffect, useMemo } from "react";
import { apiClient } from "../services/api-client.ts";
import { ErrorPresenter } from "../services/error-presenter.ts";
import {
  buildBulkTargets,
  type TransferProgress,
  type BulkConflict,
  type BulkDestinations,
  type BulkUploadTargetResult,
} from "../types/transfer.ts";
import type { FormattedError } from "../types/error.ts";

function formatBulkResponseError(data: { message?: unknown }, status: number): FormattedError {
  const error = ErrorPresenter.formatError(data);
  if (status >= 400 && status < 500 && typeof data?.message === "string") {
    // L'API bulk fornisce un messaggio utente specifico, ad esempio per duplicati o limiti multipart.
    const message = ErrorPresenter.sanitizeString(data.message);
    if (message) return { ...error, userMessage: message };
  }
  return error;
}

/** Normalizza il DTO del backend nel modello usato dall'interfaccia. */
export function normalizeTransfer(dto: any): TransferProgress {
  const transferredBytes = Number(dto.transferredBytes || 0);
  const totalBytes = Number(dto.totalBytes || 0);
  const rawPercent = dto.percentage ?? dto.percent;
  const percentage =
    rawPercent !== undefined && rawPercent !== null
      ? Number(rawPercent)
      : totalBytes > 0
      ? Math.min(100, Math.round((transferredBytes / totalBytes) * 10000) / 100)
      : dto.status === "COMPLETED" && totalBytes === 0 && transferredBytes === 0
      ? 100
      : 0;
  const filename = String(dto.filename || dto.sourceFile || "Trasferimento");
  const rawCurrentSpeed = dto.currentSpeedBps ?? dto.currentSpeedBytesPerSec;
  const rawAverageSpeed = dto.averageSpeedBps ?? dto.averageSpeedBytesPerSec;
  const currentSpeedBps =
    rawCurrentSpeed !== undefined && rawCurrentSpeed !== null && Number.isFinite(Number(rawCurrentSpeed))
      ? Number(rawCurrentSpeed)
      : null;
  const averageSpeedBps =
    rawAverageSpeed !== undefined && rawAverageSpeed !== null && Number.isFinite(Number(rawAverageSpeed))
      ? Number(rawAverageSpeed)
      : null;
  const fallbackSpeed = Number(dto.speedBps ?? dto.speedBytesPerSec ?? 0);
  const speedBps =
    dto.status === "COMPLETED"
      ? (averageSpeedBps ?? fallbackSpeed)
      : dto.status === "IN_PROGRESS"
      ? (currentSpeedBps ?? fallbackSpeed)
      : (averageSpeedBps ?? fallbackSpeed);
  const rawDuration = dto.durationMs;
  const durationMs =
    rawDuration !== undefined && rawDuration !== null && Number.isFinite(Number(rawDuration))
      ? Number(rawDuration)
      : null;

  return {
    transferId: String(dto.transferId),
    batchId: dto.batchId ? String(dto.batchId) : undefined,
    userId: dto.userId ? String(dto.userId) : undefined,
    username: dto.username ? String(dto.username) : undefined,
    isBulkStaging: dto.isBulkStaging === true,
    bulkBatch: dto.bulkBatch,
    robotId: dto.robotId,
    filename,
    sourcePath: String(dto.sourcePath || ""),
    destinationPath: String(dto.destinationPath || ""),
    sourceFile: dto.sourceFile || filename,
    targetFile: dto.targetFile || dto.destinationPath || filename,
    direction: dto.direction,
    status: dto.status,
    transferredBytes,
    totalBytes,
    percentage,
    speedBps,
    currentSpeedBps,
    averageSpeedBps,
    durationMs,
    etaSeconds: dto.etaSeconds ?? null,
    errorMessage: dto.errorMessage || dto.error || undefined,
    errorCode: dto.errorCode || undefined,
    integrityLabel: dto.integrityLabel || undefined,
    checksum: dto.checksum || undefined,
    startedAt: dto.startedAt || new Date().toISOString(),
    activeStartedAt: dto.activeStartedAt || null,
    completedAt: dto.completedAt || undefined,
  };
}

/** Evita re-render (e quindi ricalcoli a cascata) quando lo snapshot SSE non è cambiato. */
function sameTransfers(a: TransferProgress[], b: TransferProgress[]): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

export function useTransfers(isAuthenticated: boolean) {
  const [transfers, setTransfers] = useState<TransferProgress[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<FormattedError | null>(null);

  const applyRows = useCallback((rows: unknown[]) => {
    const next = rows.map(normalizeTransfer);
    setTransfers((prev) => (sameTransfers(prev, next) ? prev : next));
  }, []);

  const fetchTransfers = useCallback(async (robotId?: string) => {
    if (!isAuthenticated) return;
    const endpoint = robotId
      ? `/api/robots/${encodeURIComponent(robotId)}/transfers`
      : "/api/transfers/recent";
    const res = await apiClient.get(endpoint);
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.message || "Impossibile aggiornare l'elenco dei trasferimenti.");
    }
    const data = await res.json();
    const rows = Array.isArray(data) ? data : (data.transfers || []);
    applyRows(rows);
  }, [isAuthenticated, applyRows]);

  const loadTransfers = useCallback(async (robotId?: string) => {
    if (!isAuthenticated) return;
    setLoading(true);
    try {
      await fetchTransfers(robotId);
    } catch (err) {
      setError(ErrorPresenter.formatError(err));
    } finally {
      setLoading(false);
    }
  }, [fetchTransfers, isAuthenticated]);

  /** Aggiorna silenziosamente lo stato JSON dei trasferimenti (nessun reload di pagina, nessun flag di loading). */
  const syncNow = useCallback(async (): Promise<void> => {
    try {
      await fetchTransfers();
    } catch {
      // L'aggiornamento successivo (SSE/polling) riallinea comunque la lista.
    }
  }, [fetchTransfers]);

  const cancelTransfer = useCallback(async (transferId: string): Promise<boolean> => {
    try {
      const res = await apiClient.post(`/api/transfers/${encodeURIComponent(transferId)}/cancel`, {});
      if (res.ok) {
        const dto = await res.json().catch(() => null);
        setTransfers((prev) =>
          prev.map((t) =>
            t.transferId === transferId
              ? dto
                ? normalizeTransfer(dto)
                : { ...t, status: "CANCELLED", etaSeconds: null }
              : t
          )
        );
        void syncNow();
        return true;
      }
      const errData = await res.json().catch(() => ({}));
      setError(ErrorPresenter.formatError(errData));
      return false;
    } catch (err) {
      setError(ErrorPresenter.formatError(err));
      return false;
    }
  }, [syncNow]);

  const pauseTransfer = useCallback(async (transferId: string): Promise<boolean> => {
    try {
      const res = await apiClient.post(`/api/transfers/${encodeURIComponent(transferId)}/pause`, {});
      if (res.ok) {
        const dto = await res.json().catch(() => null);
        if (dto) {
          const normalized = normalizeTransfer(dto);
          setTransfers((prev) => prev.map((t) => (t.transferId === transferId ? normalized : t)));
        }
        void syncNow();
        return true;
      }
      const errData = await res.json().catch(() => ({}));
      setError(ErrorPresenter.formatError(errData));
      return false;
    } catch (err) {
      setError(ErrorPresenter.formatError(err));
      return false;
    }
  }, [syncNow]);

  const resumeTransfer = useCallback(async (transferId: string): Promise<boolean> => {
    try {
      const res = await apiClient.post(`/api/transfers/${encodeURIComponent(transferId)}/resume`, {});
      if (res.ok) {
        const dto = await res.json().catch(() => null);
        if (dto) {
          const normalized = normalizeTransfer(dto);
          setTransfers((prev) => prev.map((t) => (t.transferId === transferId ? normalized : t)));
        }
        void syncNow();
        return true;
      }
      const errData = await res.json().catch(() => ({}));
      setError(ErrorPresenter.formatError(errData));
      return false;
    } catch (err) {
      setError(ErrorPresenter.formatError(err));
      return false;
    }
  }, [syncNow]);

  /** Annulla selettivamente un intero batch di caricamento massivo (ISS-009, Requisito #9). */
  const cancelBatch = useCallback(async (batchId: string): Promise<boolean> => {
    try {
      const res = await apiClient.post(`/api/transfers/batches/${encodeURIComponent(batchId)}/cancel`, {});
      if (res.ok) {
        void syncNow();
        return true;
      }
      const errData = await res.json().catch(() => ({}));
      setError(ErrorPresenter.formatError(errData));
      return false;
    } catch (err) {
      setError(ErrorPresenter.formatError(err));
      return false;
    }
  }, [syncNow]);

  /** Riprova/Riprende un trasferimento fallito, annullato o interrotto (RF-TRF-010). */
  const retryTransfer = useCallback(async (transferId: string): Promise<boolean> => {
    try {
      const res = await apiClient.post(`/api/transfers/${encodeURIComponent(transferId)}/retry`, {});
      if (res.ok) {
        await syncNow();
        return true;
      }
      const errData = await res.json().catch(() => ({}));
      setError(ErrorPresenter.formatError(errData));
      return false;
    } catch (err) {
      setError(ErrorPresenter.formatError(err));
      return false;
    }
  }, [syncNow]);

  /** Rimuove un trasferimento concluso dallo storico (non elimina alcun file). */
  const removeTransfer = useCallback(async (transferId: string): Promise<boolean> => {
    try {
      const res = await apiClient.delete(`/api/transfers/${encodeURIComponent(transferId)}`);
      if (res.ok) {
        setTransfers((prev) => prev.filter((t) => t.transferId !== transferId));
        return true;
      }
      const errData = await res.json().catch(() => ({}));
      setError(ErrorPresenter.formatError(errData));
      return false;
    } catch (err) {
      setError(ErrorPresenter.formatError(err));
      return false;
    }
  }, []);

  const cleanupAllTemp = async (): Promise<boolean> => {
    try {
      const res = await apiClient.post("/api/fs/cleanup-temp-all", {});
      return res.ok;
    } catch {
      return false;
    }
  };

  // Bulk Upload Pre-Check (RF-TRF-009, RF-TRF-011)
  const preCheckBulkUpload = async (
    files: string[],
    destinations: BulkDestinations
  ): Promise<{ hasConflicts: boolean; conflicts: BulkConflict[]; error?: FormattedError }> => {
    try {
      const res = await apiClient.post("/api/transfers/bulk/pre-check", {
        filenames: files,
        targets: buildBulkTargets(destinations),
      });
      const data = await res.json();
      if (res.ok) {
        const conflicts: BulkConflict[] = (data.conflicts || []).map((conflict: any) => {
          const targetType =
            conflict.target?.type === "general"
              ? "general"
              : conflict.target?.type === "server"
              ? "server"
              : "robot";
          return {
            targetType,
            targetId: conflict.target?.robotId || (targetType === "general" ? "general" : ""),
            targetName:
              targetType === "general"
                ? "Archivio Generale Server"
                : conflict.target?.robotId || "Destinazione",
            filename: conflict.filename,
            targetPath: conflict.destinationPath || "",
          };
        });
        return {
          hasConflicts: data.hasConflicts || false,
          conflicts,
        };
      } else {
        return {
          hasConflicts: false,
          conflicts: [],
          error: formatBulkResponseError(data, res.status),
        };
      }
    } catch (err) {
      return {
        hasConflicts: false,
        conflicts: [],
        error: ErrorPresenter.formatError(err),
      };
    }
  };

  // Bulk Upload Execution (RF-TRF-001..005)
  const executeBulkUpload = async (
    files: File[],
    destinations: BulkDestinations,
    overwrite = false,
    onProgress?: (percentage: number) => void
  ): Promise<{ success: boolean; results?: BulkUploadTargetResult[]; error?: FormattedError }> => {
    const formData = new FormData();
    // I metadati precedono i file: il backend può associare a ogni file la
    // dimensione dichiarata e mostrare la percentuale già durante l'upload.
    formData.append("targets", JSON.stringify(buildBulkTargets(destinations)));
    if (overwrite) {
      formData.append("overwrite", "true");
    }
    formData.append("fileSizes", JSON.stringify(files.map((file) => file.size)));
    files.forEach((file) => {
      formData.append("files", file);
    });

    try {
      if (onProgress) onProgress(10);
      const res = await apiClient.post("/api/transfers/bulk/upload", formData);
      if (onProgress) onProgress(100);

      const data = await res.json();
      if (res.ok) {
        const results: BulkUploadTargetResult[] = (data.results || []).flatMap((fileResult: any) =>
          (fileResult.targets || []).map((targetResult: any) => {
            const targetType =
              targetResult.target?.type === "general"
                ? "general"
                : targetResult.target?.type === "server"
                ? "server"
                : "robot";
            return {
              targetType,
              targetId: targetResult.target?.robotId || (targetType === "general" ? "general" : ""),
              targetName:
                targetType === "general"
                  ? "Archivio Generale Server"
                  : targetResult.target?.robotId || "Destinazione",
              success: Boolean(targetResult.success),
              transferredFiles: targetResult.success ? [fileResult.filename] : [],
              failedFiles: targetResult.success
                ? []
                : [{ filename: fileResult.filename, reason: targetResult.error || "Trasferimento non riuscito" }],
            };
          })
        );
        const anyFailure =
          data.success === false ||
          (data.summary && Number(data.summary.failed) > 0);
        return {
          success: !anyFailure,
          results,
        };
      } else {
        return {
          success: false,
          error: formatBulkResponseError(data, res.status),
        };
      }
    } catch (err) {
      return {
        success: false,
        error: ErrorPresenter.formatError(err),
      };
    }
  };

  useEffect(() => {
    if (!isAuthenticated || typeof EventSource === "undefined") {
      if (isAuthenticated) void loadTransfers();
      return;
    }

    void loadTransfers();
    const source = new EventSource("/api/transfers/stream", { withCredentials: true });
    const handleSnapshot = (event: MessageEvent) => {
      try {
        const payload = JSON.parse(event.data);
        const rows = Array.isArray(payload) ? payload : (payload.transfers || []);
        applyRows(rows);
      } catch {
        // Un payload SSE malformato non deve interrompere il monitoraggio successivo.
      }
    };
    source.addEventListener("snapshot", handleSnapshot as EventListener);

    // Fallback conservativo: EventSource riconnette automaticamente, il polling
    // garantisce comunque un aggiornamento immediato anche su proxy che lo limitano.
    const pollIntervalMs =
      (typeof window !== "undefined" && (window as any).MOLIRIS_TRANSFER_POLL_INTERVAL_MS) || 5000;
    const interval = setInterval(() => void fetchTransfers().catch(() => undefined), pollIntervalMs);

    return () => {
      source.removeEventListener("snapshot", handleSnapshot as EventListener);
      source.close();
      clearInterval(interval);
    };
  }, [fetchTransfers, isAuthenticated, loadTransfers, applyRows]);

  const activeCount = useMemo(
    () =>
      transfers.filter(
        (t) =>
          t.status === "QUEUED" ||
          t.status === "IN_PROGRESS" ||
          t.status === "PAUSED" ||
          t.status === "INTEGRITY_CHECKING"
      ).length,
    [transfers]
  );

  return {
    transfers,
    loading,
    error,
    activeCount,
    loadTransfers,
    refresh: loadTransfers,
    syncNow,
    cancelTransfer,
    pauseTransfer,
    resumeTransfer,
    cancelBatch,
    retryTransfer,
    removeTransfer,
    cleanupAllTemp,
    preCheckBulkUpload,
    executeBulkUpload,
    clearError: () => setError(null),
  };
}
