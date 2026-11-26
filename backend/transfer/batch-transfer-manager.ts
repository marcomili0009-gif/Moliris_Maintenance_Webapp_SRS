// Requisiti soddisfatti: Requisito #9, RF-TRF-001..005, RF-TRF-009, RNF-REL-004, RNF-SEC-004

import fs from "fs";
import crypto from "crypto";
import { type PhysicalFileLogger } from "../logging/physical-file-logger.ts";
import { MolirisAppError, ErrorCode } from "../../errors/app-errors.ts";

export type BatchItemStatus =
  | "QUEUED"
  | "IN_PROGRESS"
  | "COMPLETING"
  | "COMPLETED"
  | "CANCELLED"
  | "FAILED";

export interface BatchItem {
  id: string;
  filename: string;
  sizeBytes: number;
  transferredBytes: number;
  status: BatchItemStatus;
  progressPercent: number;
  target?: any;
  tempPartPath?: string;
  abortController?: AbortController;
  error?: string;
  onCancelCleanup?: () => Promise<void> | void;
  onCancelQueued?: () => Promise<void>;
  onCompleteForce?: () => Promise<void> | void;
}

export interface BatchRecord {
  batchId: string;
  userId: string;
  username: string;
  createdAt: Date;
  updatedAt: Date;
  status: "QUEUED" | "IN_PROGRESS" | "COMPLETED" | "CANCELLED" | "FAILED";
  totalFiles: number;
  completedCount: number;
  cancelledCount: number;
  failedCount: number;
  items: BatchItem[];
}

export class BatchTransferManager {
  private batches: Map<string, BatchRecord> = new Map();
  private fileLogger?: PhysicalFileLogger;

  constructor(fileLogger?: PhysicalFileLogger) {
    this.fileLogger = fileLogger;
  }

  public setFileLogger(logger: PhysicalFileLogger): void {
    this.fileLogger = logger;
  }

  /**
   * Crea un nuovo batch raggruppando più file (Requisito #9).
   */
  public createBatch(params: {
    batchId?: string;
    userId: string;
    username: string;
    files: Array<{
      id?: string;
      filename: string;
      sizeBytes?: number;
      target?: any;
      tempPartPath?: string;
      onCancelQueued?: () => Promise<void>;
    }>;
  }): BatchRecord {
    const batchId = params.batchId || crypto.randomUUID();
    const now = new Date();

    const items: BatchItem[] = params.files.map((f, idx) => ({
      id: f.id || `${batchId}_item_${idx + 1}`,
      filename: f.filename,
      sizeBytes: typeof f.sizeBytes === "number" ? f.sizeBytes : 0,
      transferredBytes: 0,
      status: "QUEUED",
      progressPercent: 0,
      target: f.target,
      tempPartPath: f.tempPartPath,
      onCancelQueued: f.onCancelQueued,
    }));

    const batch: BatchRecord = {
      batchId,
      userId: params.userId,
      username: params.username,
      createdAt: now,
      updatedAt: now,
      status: "QUEUED",
      totalFiles: items.length,
      completedCount: 0,
      cancelledCount: 0,
      failedCount: 0,
      items,
    };

    this.batches.set(batchId, batch);

    if (this.fileLogger) {
      this.fileLogger.logBulkStart(batchId, params.username, items.length).catch(() => {});
    }

    return batch;
  }

  public getBatch(batchId: string): BatchRecord | undefined {
    return this.batches.get(batchId);
  }

  public listBatches(userId?: string): BatchRecord[] {
    const list = Array.from(this.batches.values());
    if (userId) {
      return list.filter((b) => b.userId === userId);
    }
    return list;
  }

  public setItemInProgress(
    batchId: string,
    itemId: string,
    options?: {
      abortController?: AbortController;
      tempPartPath?: string;
      onCancelCleanup?: () => Promise<void> | void;
      onCompleteForce?: () => Promise<void> | void;
    }
  ): void {
    const batch = this.batches.get(batchId);
    if (!batch) return;

    const item = batch.items.find((i) => i.id === itemId || i.filename === itemId);
    if (!item) return;

    item.status = "IN_PROGRESS";
    item.onCancelQueued = undefined;
    if (options?.abortController) item.abortController = options.abortController;
    if (options?.tempPartPath) item.tempPartPath = options.tempPartPath;
    if (options?.onCancelCleanup) item.onCancelCleanup = options.onCancelCleanup;
    if (options?.onCompleteForce) item.onCompleteForce = options.onCompleteForce;

    batch.status = "IN_PROGRESS";
    batch.updatedAt = new Date();
  }

  public updateItemProgress(batchId: string, itemId: string, transferredBytes: number): void {
    const batch = this.batches.get(batchId);
    if (!batch) return;

    const item = batch.items.find((i) => i.id === itemId || i.filename === itemId);
    if (!item) return;

    item.transferredBytes = transferredBytes;
    if (item.sizeBytes > 0) {
      item.progressPercent = Math.min(100, Math.round((transferredBytes / item.sizeBytes) * 100));
    }
    batch.updatedAt = new Date();
  }

  public setItemCompleted(batchId: string, itemId: string): void {
    const batch = this.batches.get(batchId);
    if (!batch) return;

    const item = batch.items.find((i) => i.id === itemId || i.filename === itemId);
    if (!item) return;

    item.status = "COMPLETED";
    item.onCancelQueued = undefined;
    item.transferredBytes = item.sizeBytes;
    item.progressPercent = 100;
    batch.completedCount = batch.items.filter((i) => i.status === "COMPLETED").length;
    batch.updatedAt = new Date();

    if (batch.completedCount + batch.cancelledCount + batch.failedCount >= batch.totalFiles) {
      batch.status = batch.failedCount > 0 ? "FAILED" : batch.cancelledCount > 0 ? "CANCELLED" : "COMPLETED";
      if (this.fileLogger) {
        this.fileLogger.logBulkEnd(batchId, {
          completed: batch.completedCount,
          cancelled: batch.cancelledCount,
          failed: batch.failedCount,
          totalFiles: batch.totalFiles,
          outcome: batch.status,
        }).catch(() => {});
      }
    }
  }

  public setItemFailed(batchId: string, itemId: string, error?: string): void {
    const batch = this.batches.get(batchId);
    if (!batch) return;

    const item = batch.items.find((i) => i.id === itemId || i.filename === itemId);
    if (!item) return;

    item.status = "FAILED";
    item.onCancelQueued = undefined;
    item.error = error;
    batch.failedCount = batch.items.filter((i) => i.status === "FAILED").length;
    batch.updatedAt = new Date();

    if (batch.completedCount + batch.cancelledCount + batch.failedCount >= batch.totalFiles) {
      batch.status = batch.failedCount > 0 ? "FAILED" : batch.cancelledCount > 0 ? "CANCELLED" : "COMPLETED";
      if (this.fileLogger) {
        this.fileLogger.logBulkEnd(batchId, {
          completed: batch.completedCount,
          cancelled: batch.cancelledCount,
          failed: batch.failedCount,
          totalFiles: batch.totalFiles,
          outcome: batch.status,
        }).catch(() => {});
      }
    }
  }

  /**
   * Cancellazione selettiva conforme al Requisito #9:
   * - File in QUEUED: imposta a CANCELLED ed espelli dalla coda
   * - File in COMPLETED: mantieni intatti (mai cancellarli retroattivamente)
   * - File in IN_PROGRESS:
   *   * Se percentuale < 90%: interrompi il flusso, elimina il file temporaneo .part (pulizia garantita), imposta stato a CANCELLED
   *   * Se percentuale >= 90%: consenti il completamento automatico (porta al 100% / COMPLETED)
   * - Registra in transfers.log l'evento con il tag === CARICAMENTO MASSIVO TERMINATO ... ===
   */
  public async cancelBatch(
    batchId: string,
    requestedByUserId?: string,
    isAdmin?: boolean
  ): Promise<{
    batch: BatchRecord;
    cancelledFiles: string[];
    completedFiles: string[];
  }> {
    const batch = this.batches.get(batchId);
    if (!batch) {
      throw new MolirisAppError(
        ErrorCode.TRANSFER_INTERRUPTED,
        `Batch di trasferimento '${batchId}' non trovato.`,
        "Batch di trasferimento non trovato."
      );
    }

    if (requestedByUserId && !isAdmin && batch.userId !== requestedByUserId) {
      throw new MolirisAppError(
        ErrorCode.INSUFFICIENT_PERMISSIONS,
        `Utente '${requestedByUserId}' non autorizzato ad annullare il batch '${batchId}'.`,
        "Accesso non consentito: non si dispone dei permessi per annullare questo batch."
      );
    }

    const cancelledFiles: string[] = [];
    const completedFiles: string[] = [];

    const queuedLogWrites: Array<Promise<void>> = [];

    for (const item of batch.items) {
      if (item.status === "QUEUED") {
        item.status = "CANCELLED";
        item.error = "Annullato dall'utente prima dell'avvio.";
        cancelledFiles.push(item.filename);
        if (item.onCancelQueued) queuedLogWrites.push(item.onCancelQueued());
        item.onCancelQueued = undefined;
      } else if (item.status === "COMPLETED") {
        // I file già completati vengono mantenuti intatti
        completedFiles.push(item.filename);
      } else if (item.status === "IN_PROGRESS" || item.status === "COMPLETING") {
        const percent = item.progressPercent;
        if (percent < 90) {
          // Interruzione flusso e pulizia file .part
          item.status = "CANCELLED";
          item.error = `Annullato durante il trasferimento (avanzamento: ${percent}% < 90%).`;
          cancelledFiles.push(item.filename);

          if (item.abortController) {
            try {
              item.abortController.abort();
            } catch {}
          }
          if (item.onCancelCleanup) {
            try {
              await item.onCancelCleanup();
            } catch {}
          }
          if (item.tempPartPath && fs.existsSync(item.tempPartPath)) {
            try {
              await fs.promises.unlink(item.tempPartPath);
            } catch {}
          }
        } else {
          // Avanzamento >= 90%: completamento garantito al 100%
          item.status = "COMPLETED";
          item.progressPercent = 100;
          item.transferredBytes = item.sizeBytes;
          completedFiles.push(item.filename);

          if (item.onCompleteForce) {
            try {
              await item.onCompleteForce();
            } catch {}
          }
        }
      }
    }

    batch.completedCount = batch.items.filter((i) => i.status === "COMPLETED").length;
    batch.cancelledCount = batch.items.filter((i) => i.status === "CANCELLED").length;
    batch.failedCount = batch.items.filter((i) => i.status === "FAILED").length;
    batch.status = "CANCELLED";
    batch.updatedAt = new Date();

    await Promise.all(queuedLogWrites);
    if (this.fileLogger) {
      await this.fileLogger.logBulkEnd(batchId, {
        completed: batch.completedCount,
        cancelled: batch.cancelledCount,
        failed: batch.failedCount,
        totalFiles: batch.totalFiles,
        outcome: "ANNULLATO_SELETTIVO",
      });
    }

    return {
      batch,
      cancelledFiles,
      completedFiles,
    };
  }
}
