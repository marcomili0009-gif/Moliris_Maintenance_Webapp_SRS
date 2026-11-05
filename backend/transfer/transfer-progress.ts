// Requisiti soddisfatti: RF-TRF-004, RF-TRF-005, RF-TRF-006, RF-TRF-013, CA-TRF-002, RNF-PERF-001, RNF-PERF-002

import { Transform, type TransformCallback } from "stream";
import { type TransferProgressSnapshot } from "./transfer-models.ts";

export interface ProgressTrackerOptions {
  totalBytes: number | null;
  idleTimeoutMs?: number;
  onProgress?: (snapshot: TransferProgressSnapshot) => void;
  onIdleTimeout?: () => void;
  highWaterMark?: number;
}

/**
 * Stream di trasformazione pass-through per il calcolo trasparente di avanzamento, velocità ed ETA (RF-TRF-006, CA-TRF-002).
 * Non accumula dati in memoria e gestisce nativamente la contropressione (RNF-PERF-001).
 */
export class ProgressTrackerStream extends Transform {
  private totalBytes: number | null;
  private transferredBytes: number = 0;
  private startTime: number;
  private lastUpdateTime: number;
  private lastBytesAtUpdate: number = 0;
  private currentSpeed: number | null = null;
  private onProgressCallback?: (snapshot: TransferProgressSnapshot) => void;
  private onIdleTimeoutCallback?: () => void;
  private idleTimeoutMs?: number;
  private idleTimer: NodeJS.Timeout | null = null;

  constructor(options: ProgressTrackerOptions) {
    super({ highWaterMark: options.highWaterMark || 2 * 1024 * 1024 });
    this.totalBytes = options.totalBytes;
    this.onProgressCallback = options.onProgress;
    this.onIdleTimeoutCallback = options.onIdleTimeout;
    this.idleTimeoutMs = options.idleTimeoutMs;
    this.startTime = Date.now();
    this.lastUpdateTime = this.startTime;

    this.resetIdleTimer();
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.idleTimeoutMs && this.idleTimeoutMs > 0) {
      this.idleTimer = setTimeout(() => {
        if (this.onIdleTimeoutCallback) {
          this.onIdleTimeoutCallback();
        }
        this.emit("idleTimeout");
      }, this.idleTimeoutMs);
    }
  }

  public _transform(chunk: any, encoding: BufferEncoding, callback: TransformCallback): void {
    const len = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk, encoding);
    this.transferredBytes += len;
    this.resetIdleTimer();

    const now = Date.now();
    const elapsedSinceLastUpdate = now - this.lastUpdateTime;

    // Aggiornamento periodico dei parametri di velocità ed ETA ogni 200ms
    if (elapsedSinceLastUpdate >= 200 || (this.totalBytes && this.transferredBytes >= this.totalBytes)) {
      const bytesDelta = this.transferredBytes - this.lastBytesAtUpdate;
      const speed = elapsedSinceLastUpdate > 0 ? (bytesDelta / elapsedSinceLastUpdate) * 1000 : 0;
      
      // Media mobile ponderata (EWMA) per stabilizzare la velocità istantanea
      this.currentSpeed = this.currentSpeed === null ? speed : Math.round(this.currentSpeed * 0.7 + speed * 0.3);

      this.lastUpdateTime = now;
      this.lastBytesAtUpdate = this.transferredBytes;

      this.emitProgressSnapshot();
    }

    this.push(chunk);
    callback();
  }

  public _flush(callback: TransformCallback): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    this.emitProgressSnapshot();
    callback();
  }

  public _destroy(error: Error | null, callback: (error: Error | null) => void): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    callback(error);
  }

  private emitProgressSnapshot(): void {
    let percent: number | null = null;
    let etaSeconds: number | null = null;

    if (this.totalBytes && this.totalBytes > 0) {
      percent = Math.min(100, Math.round((this.transferredBytes / this.totalBytes) * 10000) / 100);
      if (this.currentSpeed && this.currentSpeed > 0 && this.transferredBytes < this.totalBytes) {
        const remainingBytes = this.totalBytes - this.transferredBytes;
        etaSeconds = Math.max(0, Math.round(remainingBytes / this.currentSpeed));
      } else if (this.transferredBytes >= this.totalBytes) {
        etaSeconds = 0;
      }
    }

    const snapshot: TransferProgressSnapshot = {
      transferredBytes: this.transferredBytes,
      totalBytes: this.totalBytes,
      percent,
      speedBytesPerSec: this.currentSpeed,
      etaSeconds,
    };

    if (this.onProgressCallback) {
      this.onProgressCallback(snapshot);
    }
  }

  public getSnapshot(): TransferProgressSnapshot {
    let percent: number | null = null;
    let etaSeconds: number | null = null;

    if (this.totalBytes && this.totalBytes > 0) {
      percent = Math.min(100, Math.round((this.transferredBytes / this.totalBytes) * 10000) / 100);
      if (this.currentSpeed && this.currentSpeed > 0 && this.transferredBytes < this.totalBytes) {
        const remainingBytes = this.totalBytes - this.transferredBytes;
        etaSeconds = Math.max(0, Math.round(remainingBytes / this.currentSpeed));
      }
    }

    return {
      transferredBytes: this.transferredBytes,
      totalBytes: this.totalBytes,
      percent,
      speedBytesPerSec: this.currentSpeed,
      etaSeconds,
    };
  }
}
