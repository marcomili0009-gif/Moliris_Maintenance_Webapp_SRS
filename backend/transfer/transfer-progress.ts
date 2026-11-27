// Requisiti soddisfatti: RF-TRF-004, RF-TRF-005, RF-TRF-006, RF-TRF-013, CA-TRF-002, RNF-PERF-001, RNF-PERF-002

import { Transform, type TransformCallback } from "stream";
import { performance } from "perf_hooks";
import { type TransferProgressSnapshot } from "./transfer-models.ts";

export interface ProgressTrackerOptions {
  totalBytes: number | null;
  initialBytes?: number;
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
  private initialBytes: number = 0;
  private transferredBytes: number = 0;
  private startPerfMs: number;
  private lastUpdatePerfMs: number;
  private lastBytesAtUpdate: number = 0;
  private currentSpeed: number | null = null;
  private pausedAtPerfMs: number | null = null;
  private pausedDurationMs: number = 0;
  private onProgressCallback?: (snapshot: TransferProgressSnapshot) => void;
  private onIdleTimeoutCallback?: () => void;
  private idleTimeoutMs?: number;
  private lastActivityTime: number;
  private watchdogTimer: NodeJS.Timeout | null = null;

  constructor(options: ProgressTrackerOptions) {
    super({ highWaterMark: options.highWaterMark || 2 * 1024 * 1024 });
    this.totalBytes = options.totalBytes;
    this.initialBytes = options.initialBytes || 0;
    this.transferredBytes = this.initialBytes;
    this.lastBytesAtUpdate = this.transferredBytes;
    this.onProgressCallback = options.onProgress;
    this.onIdleTimeoutCallback = options.onIdleTimeout;
    this.idleTimeoutMs = options.idleTimeoutMs;
    this.startPerfMs = performance.now();
    this.lastUpdatePerfMs = this.startPerfMs;
    this.lastActivityTime = Date.now();

    this.startWatchdog();
  }

  public markPaused(): void {
    if (this.pausedAtPerfMs === null) {
      this.pausedAtPerfMs = performance.now();
      this.stopWatchdog();
    }
  }

  public markResumed(): void {
    if (this.pausedAtPerfMs !== null) {
      const nowPerf = performance.now();
      this.pausedDurationMs += Math.max(0, nowPerf - this.pausedAtPerfMs);
      this.pausedAtPerfMs = null;
      this.lastUpdatePerfMs = nowPerf;
      this.lastBytesAtUpdate = this.transferredBytes;
      this.lastActivityTime = Date.now();
      this.startWatchdog();
    }
  }

  public getActiveDurationMs(): number {
    const nowPerf = this.pausedAtPerfMs !== null ? this.pausedAtPerfMs : performance.now();
    return Math.max(1, nowPerf - this.startPerfMs - this.pausedDurationMs);
  }

  public getPausedDurationMs(): number {
    return Math.round(this.pausedDurationMs);
  }

  private startWatchdog(): void {
    if (this.idleTimeoutMs && this.idleTimeoutMs > 0 && !this.watchdogTimer) {
      const checkIntervalMs = Math.min(1000, Math.max(200, Math.floor(this.idleTimeoutMs / 4)));
      this.watchdogTimer = setInterval(() => {
        if (this.pausedAtPerfMs !== null) return;
        const idleElapsed = Date.now() - this.lastActivityTime;
        if (idleElapsed >= this.idleTimeoutMs!) {
          this.stopWatchdog();
          if (this.onIdleTimeoutCallback) {
            this.onIdleTimeoutCallback();
          }
          this.emit("idleTimeout");
        }
      }, checkIntervalMs);
    }
  }

  private stopWatchdog(): void {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  public _transform(chunk: any, encoding: BufferEncoding, callback: TransformCallback): void {
    const len = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk, encoding);
    this.transferredBytes += len;
    this.lastActivityTime = Date.now();

    const nowPerf = performance.now();
    const elapsedSinceLastUpdate = nowPerf - this.lastUpdatePerfMs;

    // Aggiornamento periodico dei parametri di velocità ed ETA ogni 200ms (o al completamento)
    if (elapsedSinceLastUpdate >= 200 || (this.totalBytes && this.transferredBytes >= this.totalBytes)) {
      const bytesDelta = this.transferredBytes - this.lastBytesAtUpdate;
      const effectiveElapsedMs = Math.max(1, elapsedSinceLastUpdate);
      const speed = (bytesDelta / effectiveElapsedMs) * 1000;

      // Media mobile ponderata (EWMA) per stabilizzare la velocità istantanea
      this.currentSpeed = this.currentSpeed === null ? Math.round(speed) : Math.round(this.currentSpeed * 0.7 + speed * 0.3);

      this.lastUpdatePerfMs = nowPerf;
      this.lastBytesAtUpdate = this.transferredBytes;

      this.emitProgressSnapshot();
    }

    this.push(chunk);
    callback();
  }

  public _flush(callback: TransformCallback): void {
    this.stopWatchdog();
    const activeSec = this.getActiveDurationMs() / 1000;
    const sessionBytes = Math.max(0, this.transferredBytes - this.initialBytes);
    const bytesForSpeed = sessionBytes > 0 ? sessionBytes : this.transferredBytes;
    if (activeSec > 0 && bytesForSpeed > 0) {
      this.currentSpeed = Math.round(bytesForSpeed / activeSec);
    }
    this.emitProgressSnapshot();
    callback();
  }

  public _destroy(error: Error | null, callback: (error: Error | null) => void): void {
    this.stopWatchdog();
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
