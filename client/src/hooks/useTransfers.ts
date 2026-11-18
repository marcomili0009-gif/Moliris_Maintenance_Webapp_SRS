import { useState, useCallback, useEffect } from "react";
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

export function useTransfers(isAuthenticated: boolean) {
  const [transfers, setTransfers] = useState<TransferProgress[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<FormattedError | null>(null);

  const normalizeTransfer = (dto: any): TransferProgress => ({
    transferId: String(dto.transferId),
    robotId: dto.robotId,
    sourceFile: dto.sourceFile || dto.filename || dto.sourcePath || "Trasferimento",
    targetFile: dto.targetFile || dto.destinationPath || dto.filename || "Destinazione",
    direction: dto.direction,
    status: dto.status,
    transferredBytes: Number(dto.transferredBytes || 0),
    totalBytes: Number(dto.totalBytes || 0),
    percentage: Number(dto.percentage ?? dto.percent ?? 0),
    speedBps: Number(dto.speedBps ?? dto.speedBytesPerSec ?? 0),
    etaSeconds: dto.etaSeconds ?? null,
    errorMessage: dto.errorMessage || dto.error || undefined,
    startedAt: dto.startedAt || new Date().toISOString(),
    completedAt: dto.completedAt || undefined,
  });

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
    setTransfers(rows.map(normalizeTransfer));
  }, [isAuthenticated]);

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

  const cancelTransfer = async (transferId: string): Promise<boolean> => {
    try {
      const res = await apiClient.post(`/api/transfers/${encodeURIComponent(transferId)}/cancel`, {});
      if (res.ok) {
        setTransfers((prev) =>
          prev.map((t) => (t.transferId === transferId ? { ...t, status: "CANCELLED" } : t))
        );
        return true;
      }
      return false;
    } catch {
      return false;
    }
  };

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
        const conflicts: BulkConflict[] = (data.conflicts || []).map((conflict: any) => ({
          targetType: conflict.target?.type === "server" ? "server" : "robot",
          targetId: conflict.target?.robotId || "",
          targetName: conflict.target?.robotId || "Destinazione",
          filename: conflict.filename,
          targetPath: conflict.destinationPath || "",
        }));
        return {
          hasConflicts: data.hasConflicts || false,
          conflicts,
        };
      } else {
        return {
          hasConflicts: false,
          conflicts: [],
          error: ErrorPresenter.formatError(data),
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
    files.forEach((file) => {
      formData.append("files", file);
    });
    formData.append("targets", JSON.stringify(buildBulkTargets(destinations)));
    if (overwrite) {
      formData.append("overwrite", "true");
    }

    try {
      if (onProgress) onProgress(10);
      const res = await apiClient.post("/api/transfers/bulk/upload", formData);
      if (onProgress) onProgress(100);

      const data = await res.json();
      if (res.ok) {
        const results: BulkUploadTargetResult[] = (data.results || []).flatMap((fileResult: any) =>
          (fileResult.targets || []).map((targetResult: any) => ({
            targetType: targetResult.target?.type === "server" ? "server" : "robot",
            targetId: targetResult.target?.robotId || "",
            targetName: targetResult.target?.robotId || "Destinazione",
            success: Boolean(targetResult.success),
            transferredFiles: targetResult.success ? [fileResult.filename] : [],
            failedFiles: targetResult.success
              ? []
              : [{ filename: fileResult.filename, reason: targetResult.error || "Trasferimento non riuscito" }],
          }))
        );
        return {
          success: true,
          results,
        };
      } else {
        return {
          success: false,
          error: ErrorPresenter.formatError(data),
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
    const source = new EventSource("/api/transfers/stream");
    const handleSnapshot = (event: MessageEvent) => {
      try {
        const payload = JSON.parse(event.data);
        const rows = Array.isArray(payload) ? payload : (payload.transfers || []);
        setTransfers(rows.map(normalizeTransfer));
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
  }, [fetchTransfers, isAuthenticated, loadTransfers]);

  const activeCount = transfers.filter((t) => t.status === "IN_PROGRESS").length;

  return {
    transfers,
    loading,
    error,
    activeCount,
    loadTransfers,
    cancelTransfer,
    cleanupAllTemp,
    preCheckBulkUpload,
    executeBulkUpload,
    clearError: () => setError(null),
  };
}
