import { useState, useCallback, useEffect } from "react";
import { apiClient } from "../services/api-client.ts";
import { ErrorPresenter } from "../services/error-presenter.ts";
import type { TransferProgress, BulkConflict, BulkUploadTargetResult } from "../types/transfer.ts";
import type { FormattedError } from "../types/error.ts";

export function useTransfers(isAuthenticated: boolean) {
  const [transfers, setTransfers] = useState<TransferProgress[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<FormattedError | null>(null);

  const loadTransfers = useCallback(async (robotId?: string) => {
    if (!isAuthenticated) return;
    setLoading(true);
    try {
      const endpoint = robotId
        ? `/api/robots/${encodeURIComponent(robotId)}/transfers`
        : "/api/transfers/active";
      const res = await apiClient.get(endpoint);
      if (res.ok) {
        const data = await res.json();
        setTransfers(data.transfers || []);
      }
    } catch (err) {
      setError(ErrorPresenter.formatError(err));
    } finally {
      setLoading(false);
    }
  }, [isAuthenticated]);

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
    destinations: {
      server?: { robotId: string; subPath: string };
      robots?: Array<{ robotId: string; remotePath: string }>;
    }
  ): Promise<{ hasConflicts: boolean; conflicts: BulkConflict[]; error?: FormattedError }> => {
    try {
      const res = await apiClient.post("/api/transfers/bulk/pre-check", {
        files,
        destinations,
      });
      const data = await res.json();
      if (res.ok) {
        return {
          hasConflicts: data.hasConflicts || false,
          conflicts: data.conflicts || [],
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
    destinations: {
      server?: { robotId: string; subPath: string };
      robots?: Array<{ robotId: string; remotePath: string }>;
    },
    overwrite = false,
    onProgress?: (percentage: number) => void
  ): Promise<{ success: boolean; results?: BulkUploadTargetResult[]; error?: FormattedError }> => {
    const formData = new FormData();
    files.forEach((file) => {
      formData.append("files", file);
    });
    formData.append("destinations", JSON.stringify(destinations));
    if (overwrite) {
      formData.append("overwrite", "true");
    }

    try {
      if (onProgress) onProgress(10);
      const res = await apiClient.post("/api/transfers/bulk", formData);
      if (onProgress) onProgress(100);

      const data = await res.json();
      if (res.ok) {
        return {
          success: true,
          results: data.results || [],
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
    if (!isAuthenticated) return;
    loadTransfers();
    const pollIntervalMs =
      (typeof window !== "undefined" && (window as any).MOLIRIS_TRANSFER_POLL_INTERVAL_MS) || 1000;
    const interval = setInterval(() => loadTransfers(), pollIntervalMs);
    return () => clearInterval(interval);
  }, [isAuthenticated, loadTransfers]);

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
