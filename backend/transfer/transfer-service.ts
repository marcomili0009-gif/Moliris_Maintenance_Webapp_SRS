// Requisiti soddisfatti: RF-TRF-001, RF-TRF-002, RF-TRF-003, RF-TRF-004, RF-TRF-005,
// RF-TRF-006, RF-TRF-007, RF-TRF-008, RF-TRF-009, RF-TRF-010, RF-TRF-011, RF-TRF-012,
// RF-TRF-013, RF-TRF-014, RNF-SEC-002, RNF-SEC-004, RNF-SEC-005, RNF-SEC-007, RNF-SEC-008,
// RNF-SEC-009, RNF-PERF-001, RNF-PERF-002, RNF-PERF-003, RNF-REL-001, RNF-REL-004, RNF-REL-005,
// SRS §1.2, §2.4, §5.5, §6.5, §6.6, §6.7, §9, §10.3, §10.4, §11.1, §11.5, §11.7, CA-FS-002..004, CA-TRF-001..007

import crypto from "crypto";
import fs from "fs";
import path from "path";
import { performance } from "perf_hooks";
import { addAbortSignal, PassThrough, pipeline, type Readable, type Writable } from "stream";
import { pipeline as pipelineWithSignal } from "node:stream/promises";
import { type SystemConfiguration } from "../../config/configuration.ts";
import { type RobotEntity } from "../../storage/robot-models.ts";
import { type RobotRepository } from "../../storage/robot-repository.ts";
import { type ServerFilesystemService } from "../../storage/server-fs.ts";
import {
  type TransferRepository,
  type TransferHistoryDocument,
  InMemoryTransferRepository,
} from "../../storage/transfer-repository.ts";
import { type RemoteFilesystemService } from "../remote-fs/remote-fs-service.ts";
import { type RobotConnectionManager, type ManagedRobotConnection } from "../connection/robot-connection-manager.ts";
import { type SessionManager, type AuthorizedContext } from "../auth/session-manager.ts";
import { AppPermission, type RolePermissionMapping, DEFAULT_ROLE_PERMISSIONS } from "../auth/permissions.ts";
import { type AuditRepository } from "../../storage/audit-repository.ts";
import { validateAndNormalizePath } from "../auth/path-authorization.ts";
import { AuditOperation } from "../../storage/audit-models.ts";
import { MolirisLogger, redactSensitiveData } from "../../logging/logger.ts";
import { MolirisAppError, ErrorCode } from "../../errors/app-errors.ts";
import {
  TransferDirection,
  TransferStatus,
  type BulkTransferTotals,
  type TransferRecord,
  type TransferDto,
  type TransferExecutionOptions,
  type StartServerRobotTransferRequest,
  type IChecksumAlgorithm,
  type TransferProgressSnapshot,
  type RobotToRobotTransferRequest,
  type RobotToRobotExecutionResult,
  type RobotToRobotTargetResult,
} from "./transfer-models.ts";
import { resolveChecksumAlgorithm, ChecksumTransformStream } from "./checksum-service.ts";
import { ProgressTrackerStream } from "./transfer-progress.ts";
import { PipelinedSftpReadStream, PipelinedSftpWriteStream, SftpWriteError } from "../remote-fs/remote-fs-service.ts";
import { type PhysicalFileLogger, type TransferLogEntry, type TransferLogRoute } from "../logging/physical-file-logger.ts";
import { type BatchTransferManager } from "./batch-transfer-manager.ts";
import {
  type BulkTarget,
  type BulkFileConflict,
  type BulkPreCheckRequest,
  type BulkPreCheckResponse,
  type BulkUploadTargetResult,
  type BulkFileResult,
  type BulkUploadResponse,
} from "./bulk-transfer-models.ts";

type TransferLogAttempt = TransferLogRoute & Pick<TransferLogEntry, "filename" | "batchId" | "transferId">;
type BulkLogSource = { scope: "general" | "server"; robotId?: string };

export class TransferService {
  private config: SystemConfiguration;
  private robotRepository: RobotRepository;
  private serverFsService: ServerFilesystemService;
  private remoteFsService: RemoteFilesystemService;
  private connectionManager: RobotConnectionManager;
  private sessionManager: SessionManager;
  private auditRepository: AuditRepository;
  private logger: MolirisLogger;
  private checksumAlgorithm: IChecksumAlgorithm;

  // Blocco anti-corsa TOCTOU su percorsi destinazione (RNF-FS-003, RF-TRF-011)
  private activeDestinationLocks: Set<string> = new Set();

  // Registro in memoria dei trasferimenti attivi e recenti (RF-TRF-006, RNF-SEC-007)
  private transfers: Map<string, TransferRecord> = new Map();
  private readonly promotingTransfers = new WeakSet<TransferRecord>();

  // Tracciamento concorrenza (RF-TRF-012, RNF-PERF-003, CA-TRF-007)
  private activeCountByUser: Map<string, number> = new Map();
  private activeCountByRobot: Map<string, number> = new Map();
  private activeCountServer: number = 0;

  // Coda per politica di attesa (se configurata MOLIRIS_TRANSFER_CONCURRENCY_POLICY=coda).
  // Ogni voce è annullabile: un trasferimento in coda può essere cancellato senza
  // restare bloccato in attesa di uno slot che non gli verrà mai assegnato.
  private waitQueue: Array<{
    resolve: () => void;
    reject: (err: Error) => void;
    signal?: AbortSignal;
    onAbort?: () => void;
  }> = [];

  // Registro pulizie in sospeso per robot temporaneamente irraggiungibili (Problema A2 punto d)
  private pendingCleanups: Array<{ robotId: string; remoteTempPath: string; createdAt: Date }> = [];
  private startupCleanupTimer: NodeJS.Timeout | null = null;
  private shuttingDown = false;
  private readonly backgroundTransfers = new Set<Promise<unknown>>();
  private readonly pendingCancellations = new Set<Promise<TransferDto>>();
  private hourlyCleanupTimer: NodeJS.Timeout | null = null;
  private recordEvictionTimer: NodeJS.Timeout | null = null;

  private static readonly GENERAL_SERVER_ID = "server";

  private static readonly TERMINAL_STATUSES: ReadonlySet<TransferStatus> = new Set<TransferStatus>([
    TransferStatus.COMPLETED,
    TransferStatus.FAILED,
    TransferStatus.CANCELLED,
    TransferStatus.INTEGRITY_FAILED,
  ]);

  private physicalFileLogger?: PhysicalFileLogger;
  private readonly transferLogUsers = new WeakMap<TransferRecord, string>();
  private readonly transferLogRoutes = new WeakMap<TransferRecord, TransferLogRoute & Pick<TransferLogEntry, "batchId">>();
  private readonly terminalLogWrites = new WeakMap<TransferRecord, Promise<void>>();
  private batchTransferManager?: BatchTransferManager;
  private transferRepository: TransferRepository = new InMemoryTransferRepository();
  private readonly historyWrites = new Map<string, Promise<void>>();

  public setPhysicalFileLogger(logger: PhysicalFileLogger): void {
    this.physicalFileLogger = logger;
  }

  public setBatchTransferManager(manager: BatchTransferManager): void {
    this.batchTransferManager = manager;
  }

  public setTransferRepository(repo: TransferRepository): void {
    this.transferRepository = repo;
  }

  public getTransferRepository(): TransferRepository {
    return this.transferRepository;
  }

  /**
   * All'avvio del server:
   * 1) marca come FAILED eventuali trasferimenti rimasti bloccati in stati attivi da un crash/riavvio precedente;
   * 2) idrata in memoria lo storico recente così avanzamento, velocità media ed errori restano visibili dopo il riavvio.
   */
  public async hydrateFromRepository(limit = 200): Promise<void> {
    try {
      if (this.transferRepository.ensureIndexes) {
        await this.transferRepository.ensureIndexes();
      }
      const interrupted = await this.transferRepository.markStaleActiveAsInterrupted(
        "Trasferimento interrotto per riavvio del server."
      );
      if (interrupted > 0) {
        this.logger.warn(`Ripristinati ${interrupted} trasferimenti rimasti in stato attivo dopo riavvio.`);
      }
      const persisted = await this.transferRepository.list({
        includeHiddenFromRecent: false,
        limit,
      });
      for (const doc of persisted) {
        if (this.transfers.has(doc.transferId)) continue;
        this.transfers.set(doc.transferId, this.fromHistoryDocument(doc));
      }
    } catch (err: any) {
      this.logger.warn("Impossibile idratare lo storico trasferimenti dal repository", {
        error: err?.message || String(err),
      });
    }
  }

  private fromHistoryDocument(doc: TransferHistoryDocument): TransferRecord {
    return {
      transferId: doc.transferId,
      batchId: doc.batchId,
      userId: doc.userId,
      username: doc.username,
      userSessionId: "persisted-history",
      robotId: doc.robotId,
      direction: doc.direction,
      filename: doc.filename,
      sourcePath: doc.sourcePath,
      destinationPath: doc.destinationPath,
      totalBytes: doc.totalBytes,
      transferredBytes: doc.transferredBytes,
      speedBytesPerSec: doc.speedBytesPerSec ?? doc.averageSpeedBytesPerSec ?? null,
      currentSpeedBytesPerSec: doc.currentSpeedBytesPerSec ?? null,
      averageSpeedBytesPerSec: doc.averageSpeedBytesPerSec ?? null,
      etaSeconds: doc.etaSeconds ?? null,
      status: doc.status,
      error: doc.error,
      errorCode: doc.errorCode,
      computedChecksum: doc.checksum || undefined,
      checksumAlgorithm: doc.checksumAlgorithm || undefined,
      integrityLabel: doc.integrityLabel,
      integrityVerification: doc.integrityVerification,
      startedAt: new Date(doc.startedAt),
      activeStartedAt: doc.activeStartedAt ? new Date(doc.activeStartedAt) : undefined,
      completedAt: doc.completedAt ? new Date(doc.completedAt) : undefined,
      durationMs: doc.durationMs ?? null,
      pausedDurationMs: doc.pausedDurationMs ?? 0,
      lastProgressUpdateAt: new Date(doc.updatedAt || doc.completedAt || doc.startedAt).getTime(),
      lastBytesAtUpdate: doc.transferredBytes,
      abortController: new AbortController(),
      cleanupHandlers: [],
    };
  }

  private toHistoryDocument(record: TransferRecord): TransferHistoryDocument {
    const dto = this.toDto(record);
    return {
      transferId: dto.transferId,
      batchId: dto.batchId,
      userId: dto.userId,
      username: record.username,
      robotId: dto.robotId,
      direction: dto.direction,
      filename: dto.filename,
      sourcePath: dto.sourcePath,
      destinationPath: dto.destinationPath,
      totalBytes: dto.totalBytes,
      transferredBytes: dto.transferredBytes,
      percent: dto.percent,
      status: dto.status,
      error: dto.error,
      errorCode: record.errorCode,
      checksum: dto.checksum,
      checksumAlgorithm: dto.checksumAlgorithm,
      integrityLabel: dto.integrityLabel,
      integrityVerification: dto.integrityVerification,
      startedAt: dto.startedAt,
      activeStartedAt: dto.activeStartedAt ?? null,
      completedAt: dto.completedAt,
      durationMs: dto.durationMs ?? null,
      pausedDurationMs: record.pausedDurationMs ?? 0,
      currentSpeedBytesPerSec: dto.currentSpeedBytesPerSec ?? null,
      averageSpeedBytesPerSec: dto.averageSpeedBytesPerSec ?? null,
      speedBytesPerSec: dto.speedBytesPerSec,
      etaSeconds: dto.etaSeconds,
      updatedAt: new Date().toISOString(),
    };
  }

  private persistRecord(record: TransferRecord): void {
    const snapshot = this.toHistoryDocument(record);
    const previous = this.historyWrites.get(record.transferId) ?? Promise.resolve();
    const queued = previous.then(() => this.transferRepository.upsert(snapshot)).catch((error) => {
      this.logger.warn("Errore persistenza record trasferimento", {
        transferId: record.transferId,
        error: error?.message || String(error),
      });
    });
    this.historyWrites.set(record.transferId, queued);
    void queued.finally(() => {
      if (this.historyWrites.get(record.transferId) === queued) this.historyWrites.delete(record.transferId);
    });
  }

  public async flushTransferHistory(): Promise<void> {
    await Promise.all(this.historyWrites.values());
  }

  private markTransferActive(record: TransferRecord): void {
    record.status = TransferStatus.IN_PROGRESS;
    if (!record.activeStartedAt) {
      record.activeStartedAt = new Date();
      record.activeStartedPerfMs = performance.now();
    }
    if (record.pausedDurationMs === undefined) {
      record.pausedDurationMs = 0;
    }
    this.persistRecord(record);
  }

  private finalizeTransferStats(record: TransferRecord, verifiedBytes?: number): void {
    if (verifiedBytes !== undefined && Number.isFinite(verifiedBytes) && verifiedBytes >= 0) {
      record.transferredBytes = verifiedBytes;
    }
    if (!record.completedAt) {
      record.completedAt = new Date();
    }
    if (record.pausedAtMs !== null && record.pausedAtMs !== undefined) {
      record.pausedDurationMs = (record.pausedDurationMs ?? 0) + Math.max(0, performance.now() - record.pausedAtMs);
      record.pausedAtMs = null;
    }
    if (record.status === TransferStatus.COMPLETED) {
      if (record.totalBytes === null || record.totalBytes === undefined) {
        record.totalBytes = record.transferredBytes;
      } else if (record.transferredBytes === 0 && record.totalBytes === 0) {
        record.transferredBytes = 0;
      }
      record.etaSeconds = 0;
    } else {
      record.etaSeconds = null;
    }

    const pausedMs = Math.max(0, record.pausedDurationMs ?? 0);
    let activeDurationMs: number | null = null;
    if (record.activeStartedPerfMs !== undefined) {
      activeDurationMs = Math.max(1, Math.round(performance.now() - record.activeStartedPerfMs - pausedMs));
    } else if (record.activeStartedAt) {
      activeDurationMs = Math.max(1, record.completedAt.getTime() - record.activeStartedAt.getTime() - Math.round(pausedMs));
    } else if (record.startedAt) {
      activeDurationMs = Math.max(1, record.completedAt.getTime() - record.startedAt.getTime() - Math.round(pausedMs));
    }
    record.durationMs = activeDurationMs;

    if (activeDurationMs !== null && activeDurationMs > 0 && record.transferredBytes > 0) {
      const avgBps = Math.round(record.transferredBytes / (activeDurationMs / 1000));
      record.averageSpeedBytesPerSec = avgBps;
      if (record.status === TransferStatus.COMPLETED) {
        record.speedBytesPerSec = avgBps;
      } else if (!record.speedBytesPerSec || record.speedBytesPerSec <= 0) {
        record.speedBytesPerSec = avgBps;
      }
    }
    record.pauseController = undefined;
    this.persistRecord(record);
  }

  constructor(
    config: SystemConfiguration,
    robotRepository: RobotRepository,
    serverFsService: ServerFilesystemService,
    remoteFsService: RemoteFilesystemService,
    sessionManager: SessionManager,
    auditRepository: AuditRepository,
    logger: MolirisLogger,
    _roleMapping: RolePermissionMapping = DEFAULT_ROLE_PERMISSIONS,
    customChecksumAlgo?: IChecksumAlgorithm,
    connectionManager?: RobotConnectionManager
  ) {
    this.config = config;
    this.robotRepository = robotRepository;
    this.serverFsService = serverFsService;
    this.remoteFsService = remoteFsService;
    this.connectionManager = connectionManager || remoteFsService.getConnectionManager();
    this.sessionManager = sessionManager;
    this.auditRepository = auditRepository;
    this.logger = logger;
    this.checksumAlgorithm = customChecksumAlgo || resolveChecksumAlgorithm(config.transferChecksumAlgorithm);

    // STEP 9 – Hook di chiusura/scadenza sessione utente (RF-TRF-013, Prompt 3)
    this.sessionManager.onSessionTerminated((sessionId, userId, reason) => {
      this.cancelTransfersForSession(
        sessionId,
        userId,
        `SESSION_TERMINATED_${reason}`
      );
    });

    // Prompt #4: Registra il verificatore di trasferimenti attivi presso il SessionManager
    // per sospendere la scadenza di inattività durante i trasferimenti in corso
    this.sessionManager.setActiveTransferChecker((sessionId, userId) => {
      const bySession = this.getActiveTransfersCountForSession(sessionId);
      if (bySession > 0) return bySession;
      return this.getActiveTransfersCountForUser(userId);
    });

    // Task per la pulizia dei file temporanei orfani sul server (Problema A2 punto e, RF-TRF-009, RNF-REL-004)
    // 1. Bonifica immediata all'avvio per recupero da crash o riavvii
    this.startupCleanupTimer = setTimeout(() => {
      this.startupCleanupTimer = null;
      this.cleanupServerOrphanTempFiles().catch((err) => {
        this.logger.error("Errore pulizia iniziale temporanei server all'avvio", err?.message);
      });
    }, 500).unref?.();

    // 2. Bonifica periodica oraria programmata
    this.hourlyCleanupTimer = setInterval(() => {
      this.cleanupServerOrphanTempFiles().catch((err) => {
        this.logger.error("Errore task orario pulizia temporanei server", err?.message);
      });
    }, 60 * 60 * 1000);
    this.hourlyCleanupTimer.unref?.();

    // Eviction dei record di trasferimento conclusi dalla mappa in memoria
    this.recordEvictionTimer = setInterval(() => {
      const n = this.evictFinishedTransfers();
      if (n > 0) (this.logger as any).info?.(`Rimossi ${n} record di trasferimento conclusi`);
    }, 5 * 60 * 1000);
    this.recordEvictionTimer.unref?.();
  }

  public stopCleanupTask(): void {
    if (this.startupCleanupTimer) {
      clearTimeout(this.startupCleanupTimer);
      this.startupCleanupTimer = null;
    }

    if (this.recordEvictionTimer) {
      clearInterval(this.recordEvictionTimer);
      this.recordEvictionTimer = null;
    }
    if (this.hourlyCleanupTimer) {
      clearInterval(this.hourlyCleanupTimer);
      this.hourlyCleanupTimer = null;
    }
  }

  public async shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.stopCleanupTask();
    for (const record of this.transfers.values()) {
      if (!TransferService.TERMINAL_STATUSES.has(record.status) && (!record.batchId || record.isBulkStaging)) {
        this.cancelTrackedTransfer(record, "SERVICE_SHUTDOWN");
      }
    }
    await Promise.allSettled([
      ...this.pendingCancellations,
      this.batchTransferManager?.shutdown(),
    ]);
  }

  public trackBackgroundTransfer<T>(running: Promise<T>): Promise<T> {
    this.backgroundTransfers.add(running);
    void running.finally(() => this.backgroundTransfers.delete(running)).catch(() => {});
    return running;
  }

  public async waitForBackgroundTransfers(): Promise<void> {
    await Promise.allSettled(this.backgroundTransfers);
  }

  private cancelTrackedTransfer(record: TransferRecord, reason: string): void {
    const cancellation = this.cancelTransfer(record.transferId, record.userId, reason);
    this.pendingCancellations.add(cancellation);
    void cancellation.catch((error) => {
      this.logger.error("Annullamento trasferimento non completato", error?.message, {
        transferId: record.transferId, reason,
      });
    }).finally(() => this.pendingCancellations.delete(cancellation));
  }

  public getConfig(): SystemConfiguration {
    return this.config;
  }

  private getChunkSize(): number {
    return this.config.transferChunkSizeBytes || 2 * 1024 * 1024;
  }

  /**
   * Costruisce un record di trasferimento con stato iniziale QUEUED.
   * Il record viene inserito nel registro PRIMA di attendere uno slot di
   * concorrenza, così un trasferimento in coda è subito visibile al frontend
   * (RF-TRF-006, RF-TRF-012, Problema 1).
   */
  private buildTransferRecord(args: {
    transferId?: string;
    batchId?: string;
    isBulkStaging?: boolean;
    bulkBatch?: BulkTransferTotals;
    userId: string;
    username?: string;
    userSessionId: string;
    robotId: string;
    direction: TransferDirection;
    filename: string;
    sourcePath: string;
    destinationPath: string;
    tempDestinationPath?: string;
    totalBytes?: number | null;
    initialBytes?: number;
    expectedChecksum?: string;
    checksumAlgorithm?: string;
  }): TransferRecord {
    const initialBytes = args.initialBytes ?? 0;
    return {
      transferId: args.transferId || crypto.randomUUID(),
      batchId: args.batchId,
      isBulkStaging: args.isBulkStaging,
      bulkBatch: args.bulkBatch,
      userId: args.userId,
      username: args.username,
      userSessionId: args.userSessionId,
      robotId: args.robotId,
      direction: args.direction,
      filename: args.filename,
      sourcePath: args.sourcePath,
      destinationPath: args.destinationPath,
      tempDestinationPath: args.tempDestinationPath,
      totalBytes: args.totalBytes ?? null,
      transferredBytes: initialBytes,
      speedBytesPerSec: null,
      currentSpeedBytesPerSec: null,
      averageSpeedBytesPerSec: null,
      etaSeconds: null,
      status: TransferStatus.QUEUED,
      error: null,
      expectedChecksum: args.expectedChecksum,
      checksumAlgorithm: args.checksumAlgorithm || this.checksumAlgorithm.name,
      startedAt: new Date(),
      pausedAtMs: null,
      pausedDurationMs: 0,
      durationMs: null,
      lastProgressUpdateAt: Date.now(),
      lastBytesAtUpdate: initialBytes,
      abortController: new AbortController(),
      cleanupHandlers: [],
    };
  }

  private assertActiveSession(sessionId: string): void {
    if (!this.sessionManager.isSessionActive(sessionId)) {
      throw new MolirisAppError(ErrorCode.INVALID_CREDENTIALS, "Sessione utente non valida o scaduta.");
    }
  }

  private registerTransfer(record: TransferRecord): void {
    if (this.shuttingDown) throw new MolirisAppError(ErrorCode.TRANSFER_INTERRUPTED, "Servizio in arresto.");
    this.assertActiveSession(record.userSessionId);
    this.transfers.set(record.transferId, record);
    const username = record.username || this.sessionManager.getSession(record.userSessionId)?.username;
    if (username) {
      record.username = username;
      this.transferLogUsers.set(record, username);
    }
    this.persistRecord(record);
  }

  private assertTransferActive(record: TransferRecord): void {
    this.assertActiveSession(record.userSessionId);
    if (record.abortController.signal.aborted) {
      throw new MolirisAppError(ErrorCode.TRANSFER_INTERRUPTED, "Trasferimento annullato o interrotto.");
    }
  }

  private beginPromotion(record: TransferRecord): void {
    this.assertTransferActive(record);
    // Il file è già verificato. Lascia concludere il commit già avviato
    // senza concorrere con la pulizia della destinazione temporanea.
    this.promotingTransfers.add(record);
  }

  /**
   * Memorizza la richiesta originale (per Riprova/Riprendi) e notifica che il record è visibile
   * in lista (stato QUEUED) prima di slot e handshake SSH.
   */
  private markAccepted(record: TransferRecord, req: StartServerRobotTransferRequest): void {
    const { onAccepted: _onAccepted, onQueued, ...original } = req;
    record.originalRequest = original;
    if (onQueued) {
      try {
        onQueued(this.toDto(record));
      } catch {
        // Un errore nel callback non deve interrompere il trasferimento.
      }
    }
  }

  /** Segnala che i controlli preliminari sono superati e il trasferimento sta per partire. */
  private signalAccepted(record: TransferRecord, req: StartServerRobotTransferRequest): void {
    if (!req.onAccepted) return;
    try {
      req.onAccepted(this.toDto(record));
    } catch {
      // Un errore nel callback non deve interrompere il trasferimento.
    }
  }

  /**
   * Verifica che la cartella di destinazione sul robot esista, sia una directory e sia scrivibile
   * (RF-TRF-014, RF-FS-007): il test di scrittura usa lo stesso file temporaneo del trasferimento.
   */
  private async assertRemoteDestinationWritable(
    sftp: any,
    remoteTargetDir: string,
    remoteTempPath: string,
    robotId: string
  ): Promise<void> {
    const dirStat = await new Promise<any>((resolve) => {
      sftp.stat(remoteTargetDir, (err: any, st: any) => resolve(err ? null : st));
    });
    const isDir = Boolean(
      dirStat &&
        (typeof dirStat.isDirectory === "function"
          ? dirStat.isDirectory()
          : dirStat.mode && (dirStat.mode & 0o170000) === 0o040000)
    );
    if (!isDir) {
      throw new MolirisAppError(
        ErrorCode.REMOTE_FS_ERROR,
        `Cartella di destinazione remota non trovata o non valida: ${remoteTargetDir} (robot ${robotId})`,
        "La cartella di destinazione sul robot non esiste o non è una directory."
      );
    }
    await new Promise<void>((resolve, reject) => {
      sftp.open(remoteTempPath, "a", (err: any, handle: any) => {
        if (err) {
          return reject(
            new MolirisAppError(
              ErrorCode.REMOTE_FS_ERROR,
              `Cartella di destinazione remota non scrivibile: ${remoteTargetDir} (robot ${robotId}): ${err.message}`,
              "Directory di sola lettura o permessi insufficienti per l'utente SSH: seleziona una cartella scrivibile come /home/<utente>."
            )
          );
        }
        sftp.close(handle, () => resolve());
      });
    });
  }

  private isTerminalRecord(record: TransferRecord): boolean {
    return TransferService.TERMINAL_STATUSES.has(record.status);
  }

  private acquireDestinationLock(lockKey: string): void {
    if (this.activeDestinationLocks.has(lockKey)) {
      throw new MolirisAppError(
        ErrorCode.TRANSFER_INTERRUPTED,
        `Trasferimento concorrente sullo stesso percorso di destinazione già in corso: ${lockKey}`,
        "Un trasferimento verso la stessa destinazione è già in corso. Attendi il completamento prima di riprovare."
      );
    }
    this.activeDestinationLocks.add(lockKey);
  }

  private releaseDestinationLock(lockKey: string): void {
    this.activeDestinationLocks.delete(lockKey);
  }

  // =========================================================================
  // DIREZIONE A: Computer Utente ↔ Filesystem Server (§6.5, RF-TRF-001, CA-FS-002)
  // =========================================================================

  /**
   * Upload dal browser dell'utente verso il filesystem del server (Computer → Server).
   */
  public async uploadClientToServer(
    context: AuthorizedContext,
    robot: RobotEntity,
    relativeSubPath: string | undefined,
    filename: string,
    incomingStream: Readable,
    options?: TransferExecutionOptions,
    totalBytes?: number | null
  ): Promise<TransferDto> {
    const { record, targetRelative, finalServerPath, tempFilePath } = await this.prepareTransfer(
      context, this.describeTransferAttempt(TransferDirection.CLIENT_TO_SERVER, robot.id, filename, undefined, relativeSubPath),
      async () => {
        this.assertAuthorized(context, robot, [AppPermission.FS_SERVER_UPLOAD]);
        this.assertRobotNotDisabled(robot);

        const safeFilename = this.sanitizeFilename(filename);
        const targetRelative = relativeSubPath
          ? path.posix.join(path.posix.normalize(relativeSubPath), safeFilename)
          : safeFilename;

        const finalServerPath = await this.serverFsService.resolveRobotPath(robot, targetRelative);

        // 1. Controllo sovrascrittura preventiva (§11.5, RF-TRF-011)
        await this.checkServerOverwritePolicy(finalServerPath, options);

        // 2. Controllo preventivo spazio su disco server (§11.1, RF-TRF-014, CA-TRF-006)
        if (totalBytes && totalBytes > 0) {
          await this.checkServerDiskSpace(path.dirname(finalServerPath), totalBytes);
        }

        // 3. Verifica quota e dimensione massima se configurate (§11.1, RNF-MNT-001)
        this.checkMaxFileSize(totalBytes);

        const transferId = crypto.randomUUID();
        const tempDir = await this.serverFsService.ensureTempDirectory(robot);
        const tempFilePath = path.join(tempDir, `transfer_${transferId}.tmp`);

        // Il record è registrato SUBITO, con stato QUEUED, prima di attendere uno
        // slot di concorrenza: la coda è visibile al frontend (Problema 1).
        const record = this.buildTransferRecord({
          transferId,
          userId: context.userId,
          username: context.username,
          userSessionId: context.sessionId,
          robotId: robot.id,
          direction: TransferDirection.CLIENT_TO_SERVER,
          filename: safeFilename,
          sourcePath: safeFilename,
          destinationPath: targetRelative,
          tempDestinationPath: tempFilePath,
          totalBytes: totalBytes || null,
          expectedChecksum: options?.expectedChecksum,
        });
        this.registerTransfer(record);
        return { record, targetRelative, finalServerPath, tempFilePath };
      }
    );

    const destLockKey = `server:${robot.id}:${targetRelative}`;
    let slotAcquired = false;
    let lockAcquired = false;
    try {
      await this.acquireTransferSlot(context.userId, robot.id, record.abortController.signal);
      slotAcquired = true;
      this.assertTransferActive(record);
      this.markTransferActive(record);
      this.acquireDestinationLock(destLockKey);
      lockAcquired = true;
      await this.recordAuditStart(record);

      const tempWriteStream = fs.createWriteStream(tempFilePath, {
        mode: 0o700,
        flags: "w",
        highWaterMark: this.getChunkSize(),
      });
      record.cleanupHandlers.push(async () => {
        try { tempWriteStream.destroy(); } catch {}
        try { if (fs.existsSync(tempFilePath)) await fs.promises.unlink(tempFilePath); } catch {}
      });

      await this.streamWithTrackingAndChecksum(
        incomingStream,
        tempWriteStream,
        record,
        options?.expectedChecksum
      );

      // 1. Verifica integrità base: confronto dimensione finale del file su disco
      const finalStat = await fs.promises.stat(tempFilePath);
      if (finalStat.size !== record.transferredBytes) {
        try { await fs.promises.unlink(tempFilePath); } catch {}
        this.assertTransferActive(record);
        record.status = TransferStatus.INTEGRITY_FAILED;
        throw new MolirisAppError(
          ErrorCode.INTEGRITY_CHECK_FAILED,
          `Verifica integrità fallita: dimensione su disco (${finalStat.size}) diversa dai byte trasferiti (${record.transferredBytes})`,
          "Verifica di integrità del file trasferito fallita."
        );
      }

      // 2. Verifica estesa readback opzionale
      if (this.config.transferVerifyMode === "readback") {
        const readbackDigest = await this.computeLocalFileDigest(tempFilePath);
        if (readbackDigest.toLowerCase() !== (record.computedChecksum || "").toLowerCase()) {
          try { await fs.promises.unlink(tempFilePath); } catch {}
          this.assertTransferActive(record);
          record.status = TransferStatus.INTEGRITY_FAILED;
          throw new MolirisAppError(
            ErrorCode.INTEGRITY_CHECK_FAILED,
            `Verifica integrità readback fallita: atteso ${record.computedChecksum}, calcolato su disco ${readbackDigest}`,
            "Verifica di integrità del file trasferito fallita."
          );
        }
      }

      // 3. Controllo anti-corsa TOCTOU prima della promozione
      await this.checkServerOverwritePolicy(finalServerPath, options);

      // Spostamento atomico sul file di destinazione definitivo (RF-TRF-009, CA-TRF-005)
      const targetDir = path.dirname(finalServerPath);
      if (!fs.existsSync(targetDir)) {
        await fs.promises.mkdir(targetDir, { recursive: true });
      }
      this.beginPromotion(record);
      await fs.promises.rename(tempFilePath, finalServerPath);

      const isReadback = this.config.transferVerifyMode === "readback";
      record.integrityLabel = isReadback
        ? "completato — digest + dimensione verificata e readback locale"
        : "completato — digest + dimensione verificata";
      record.integrityVerification = {
        verified: true,
        mode: isReadback ? "readback" : "stream",
        label: record.integrityLabel,
      };

      record.status = TransferStatus.COMPLETED;
      record.completedAt = new Date();
      await this.recordAuditSuccess(record);

      return this.toDto(record);
    } catch (err: any) {
      await this.handleTransferFailure(record, err);
      if (err instanceof MolirisAppError) throw err;
      throw new MolirisAppError(
        (record.errorCode as any) || ErrorCode.TRANSFER_INTERRUPTED,
        err.message || "Trasferimento interrotto prima del completamento.",
        record.error || "Trasferimento file interrotto prima del completamento."
      );
    } finally {
      if (lockAcquired) this.releaseDestinationLock(destLockKey);
      if (slotAcquired) this.releaseTransferSlot(context.userId, robot.id);
    }
  }

  /**
   * Costruisce il pipeline di download con tracking, checksum e gestione affidabile
   * della chiusura. Il trasferimento viene marcato COMPLETED solo quando il flusso
   * è stato letto fino in fondo e la dimensione coincide; una disconnessione del
   * browser (close prematuro) lo marca FAILED e libera lo slot (Problema 2).
   */
  private createTrackedDownloadStream(args: {
    record: TransferRecord;
    sourceStream: Readable;
    releaseSlot: () => void;
    cleanupSource: () => Promise<void>;
    integrityLabel: string;
  }): Readable {
    const { record, sourceStream, releaseSlot, cleanupSource, integrityLabel } = args;
    const progressTracker = new ProgressTrackerStream({
      totalBytes: record.totalBytes,
      idleTimeoutMs: this.config.transferIdleTimeoutMs,
      highWaterMark: this.getChunkSize(),
      onProgress: (snap) => this.updateProgress(record, snap),
      onIdleTimeout: () => record.abortController.abort(),
    });
    const checksumStream = new ChecksumTransformStream(this.checksumAlgorithm, this.getChunkSize());
    const outStream = new PassThrough({ highWaterMark: this.getChunkSize() });

    record.pauseController = {
      pause: () => {
        sourceStream.pause();
        progressTracker.markPaused();
      },
      resume: () => {
        progressTracker.markResumed();
        sourceStream.resume();
      },
    };

    let settled = false;
    let released = false;
    const releaseOnce = () => {
      if (released) return;
      released = true;
      releaseSlot();
    };
    const removeAbortListener = () => {
      record.abortController.signal.removeEventListener("abort", abortHandler);
    };
    const abortHandler = () => {
      const abortErr = new MolirisAppError(
        ErrorCode.TRANSFER_INTERRUPTED,
        "Download annullato o interrotto."
      );
      try { sourceStream.destroy(abortErr); } catch {}
      try { outStream.destroy(abortErr); } catch {}
    };
    record.abortController.signal.addEventListener("abort", abortHandler, { once: true });

    const finishSuccess = async () => {
      if (settled) return;
      settled = true;
      removeAbortListener();
      try {
        const expectedTotal = record.totalBytes;
        if (expectedTotal !== null && expectedTotal !== undefined && record.transferredBytes !== expectedTotal) {
          record.status = TransferStatus.INTEGRITY_FAILED;
          await this.handleTransferFailure(
            record,
            new MolirisAppError(
              ErrorCode.INTEGRITY_CHECK_FAILED,
              `Download incompleto: ricevuti ${record.transferredBytes} byte su ${expectedTotal}`,
              "Verifica di integrità del file trasferito fallita."
            )
          );
        } else {
          record.computedChecksum = checksumStream.getDigest() || undefined;
          record.integrityLabel = integrityLabel;
          record.integrityVerification = {
            verified: true,
            mode: "stream",
            label: integrityLabel,
          };
          record.status = TransferStatus.COMPLETED;
          record.completedAt = new Date();
          await this.recordAuditSuccess(record);
        }
      } finally {
        try { await cleanupSource(); } finally { releaseOnce(); }
      }
    };

    const finishFailure = async (err: any) => {
      if (settled) return;
      settled = true;
      removeAbortListener();
      try {
        await this.handleTransferFailure(record, err);
      } finally {
        try { await cleanupSource(); } finally { releaseOnce(); }
      }
    };

    const trackFinalization = (operation: Promise<void>) => {
      void this.trackBackgroundTransfer(operation).catch((error) => {
        this.logger.error("Finalizzazione download non completata", error?.message, {
          transferId: record.transferId,
        });
      });
    };

    pipeline(sourceStream, progressTracker, checksumStream, outStream, (err) => {
      if (err) {
        trackFinalization(finishFailure(err));
      }
    });

    // Il consumo completo dello stream da parte del client è il segnale più
    // affidabile di successo; 'close' può arrivare subito dopo 'end'.
    outStream.once("end", () => {
      trackFinalization(finishSuccess());
    });

    outStream.once("close", () => {
      if (!settled && !outStream.readableEnded) {
        trackFinalization(finishFailure(
          new MolirisAppError(
            ErrorCode.TRANSFER_INTERRUPTED,
            "Download interrotto prima del completamento (client disconnesso)."
          )
        ));
      }
    });

    if (record.abortController.signal.aborted) abortHandler();

    return outStream;
  }

  /**
   * Download dal filesystem del server verso il browser dell'utente (Server → Computer).
   */
  public async openDownloadServerToClient(
    context: AuthorizedContext,
    robot: RobotEntity,
    relativeFilePath: string
  ): Promise<{ stream: Readable; transferDto: TransferDto; filename: string; totalBytes: number }> {
    const { record, filename, targetPath, stat } = await this.prepareTransfer(
      context, this.describeTransferAttempt(TransferDirection.SERVER_TO_CLIENT, robot.id, relativeFilePath, relativeFilePath),
      async () => {
        this.assertAuthorized(context, robot, [AppPermission.FS_SERVER_DOWNLOAD]);
        this.assertRobotNotDisabled(robot);

        const targetPath = await this.serverFsService.resolveRobotPath(robot, relativeFilePath);
        if (!fs.existsSync(targetPath)) {
          throw new MolirisAppError(
            ErrorCode.SERVER_DIR_INACCESSIBLE,
            `File non trovato sul server: ${targetPath}`,
            "Il file richiesto non è presente sul server."
          );
        }

        const stat = await fs.promises.stat(targetPath);
        if (!stat.isFile()) {
          throw new MolirisAppError(
            ErrorCode.SERVER_DIR_INACCESSIBLE,
            `Il percorso specificato non è un file regolare: ${targetPath}`,
            "Il percorso richiesto non è un file regolare."
          );
        }

        const filename = path.basename(targetPath);
        const record = this.buildTransferRecord({
          userId: context.userId,
          username: context.username,
          userSessionId: context.sessionId,
          robotId: robot.id,
          direction: TransferDirection.SERVER_TO_CLIENT,
          filename,
          sourcePath: relativeFilePath,
          destinationPath: filename,
          totalBytes: stat.size,
        });
        this.registerTransfer(record);
        return { record, filename, targetPath, stat };
      }
    );

    let slotAcquired = false;
    let released = false;
    const releaseSlot = () => {
      if (released) return;
      released = true;
      if (slotAcquired) this.releaseTransferSlot(context.userId, robot.id);
    };

    try {
      await this.acquireTransferSlot(context.userId, robot.id, record.abortController.signal);
      slotAcquired = true;
      this.assertTransferActive(record);
      this.markTransferActive(record);
      await this.recordAuditStart(record);

      const rawStream = fs.createReadStream(targetPath, {
        highWaterMark: this.getChunkSize(),
      });

      let sourceCleaned = false;
      const cleanupSource = async () => {
        if (sourceCleaned) return;
        sourceCleaned = true;
        try { rawStream.destroy(); } catch {}
      };
      record.cleanupHandlers.push(cleanupSource);

      this.assertTransferActive(record);
      const outStream = this.createTrackedDownloadStream({
        record,
        sourceStream: rawStream,
        releaseSlot,
        cleanupSource,
        // Etichetta specifica download browser: MAI "verificato end-to-end"
        integrityLabel: "completato — integrità verificata solo lato server",
      });

      return {
        stream: outStream,
        transferDto: this.toDto(record),
        filename,
        totalBytes: stat.size,
      };
    } catch (err: any) {
      releaseSlot();
      await this.handleTransferFailure(record, err);
      if (err instanceof MolirisAppError) throw err;
      throw new MolirisAppError(
        ErrorCode.TRANSFER_INTERRUPTED,
        err.message || "Download interrotto prima del completamento.",
        "Trasferimento file interrotto prima del completamento."
      );
    }
  }

  // =========================================================================
  // DIREZIONE B: Filesystem Server ↔ Filesystem Remoto Robot (§6.6, RF-TRF-002, CA-FS-003)
  // =========================================================================

  /**
   * Trasferimento bidirezionale tra Filesystem Server e Filesystem Remoto del Robot (§6.6).
   */
  public async executeServerRobotTransfer(
    context: AuthorizedContext,
    robot: RobotEntity,
    req: StartServerRobotTransferRequest
  ): Promise<TransferDto> {
    await this.prepareTransfer(context, req.direction === TransferDirection.ROBOT_TO_SERVER
      ? this.describeTransferAttempt(req.direction, robot.id, req.remotePath, req.remotePath, req.serverRelativePath)
      : this.describeTransferAttempt(req.direction, robot.id, req.serverRelativePath, req.serverRelativePath, req.remotePath),
      async () => this.assertRobotAccessible(robot));

    if (req.direction === "SERVER_TO_ROBOT") {
      return this.executeServerToRobot(context, robot, req);
    } else if (req.direction === "ROBOT_TO_SERVER") {
      return this.executeRobotToServer(context, robot, req);
    } else {
      throw new MolirisAppError(
        ErrorCode.MISSING_ROBOT_PARAMS,
        `Direzione non valida: ${(req as any).direction}`,
        "Direzione di trasferimento non valida."
      );
    }
  }

  private async executeServerToRobot(
    context: AuthorizedContext,
    robot: RobotEntity,
    req: StartServerRobotTransferRequest
  ): Promise<TransferDto> {
    const { record, filename, sourceServerPath, stat } = await this.prepareTransfer(
      context, this.describeTransferAttempt(TransferDirection.SERVER_TO_ROBOT, robot.id, req.serverRelativePath, req.serverRelativePath, req.remotePath),
      async () => {
        // Verifica permessi tassativi: TRANSFER_SERVER_ROBOT + download server + upload robot
        this.assertAuthorized(context, robot, [
          AppPermission.TRANSFER_SERVER_ROBOT,
          AppPermission.FS_SERVER_DOWNLOAD,
          AppPermission.FS_REMOTE_UPLOAD,
        ]);

        this.serverFsService.assertOperatorAccess(context, req.serverRelativePath, "TRANSFER_SOURCE");

        const sourceServerPath = await this.serverFsService.resolveRobotPath(robot, req.serverRelativePath);
        if (!fs.existsSync(sourceServerPath)) {
          throw new MolirisAppError(
            ErrorCode.SERVER_DIR_INACCESSIBLE,
            `File sorgente server non trovato: ${sourceServerPath}`,
            "File sorgente non presente sul server."
          );
        }

        const stat = await fs.promises.stat(sourceServerPath);
        if (!stat.isFile()) {
          throw new MolirisAppError(
            ErrorCode.SERVER_DIR_INACCESSIBLE,
            `Il percorso sorgente server non è un file: ${sourceServerPath}`,
            "Il percorso sorgente non è un file regolare."
          );
        }

        this.checkMaxFileSize(stat.size);

        const filename = path.basename(sourceServerPath);
        // Record visibile già in coda, prima dello slot e dell'handshake SSH.
        const record = this.buildTransferRecord({
          userId: context.userId,
          username: context.username,
          userSessionId: context.sessionId,
          robotId: robot.id,
          direction: TransferDirection.SERVER_TO_ROBOT,
          filename,
          sourcePath: req.serverRelativePath,
          destinationPath: req.remotePath || filename,
          totalBytes: stat.size,
          expectedChecksum: req.expectedChecksum,
        });
        this.registerTransfer(record);
        return { record, filename, sourceServerPath, stat };
      }
    );
    this.markAccepted(record, req);

    const destLockKey = `robot:${robot.id}:${req.remotePath}`;
    let slotAcquired = false;
    let lockAcquired = false;
    let managedConn: ManagedRobotConnection | null = null;
    try {
      await this.acquireTransferSlot(context.userId, robot.id, record.abortController.signal);
      slotAcquired = true;
      this.assertTransferActive(record);
      this.markTransferActive(record);
      this.acquireDestinationLock(destLockKey);
      lockAcquired = true;
      await this.recordAuditStart(record);

      // Riutilizzo di UNA sola connessione SSH/SFTP per l'intero ciclo del trasferimento (§6.6, RNF-PERF-001)
      managedConn = await this.connectionManager.acquireConnection(context.username, robot);
      const sftp = await managedConn.getSftpClient();
      await this.processPendingCleanupsForRobot(robot.id, sftp);
      const finalResolvedRemote = await this.remoteFsService.resolveAndValidatePath(req.remotePath, context, robot, sftp);

      // Risoluzione destinazione finale: se punta a una cartella, accoda il nome del file sorgente
      const initialStat = await new Promise<any>((resolve) => {
        sftp.stat(finalResolvedRemote, (err: any, st: any) => resolve(err ? null : st));
      });
      const isDir = Boolean(
        initialStat &&
          (typeof initialStat.isDirectory === "function"
            ? initialStat.isDirectory()
            : (initialStat.mode && (initialStat.mode & 0o170000) === 0o040000))
      );
      const finalTargetRemote = (isDir || (req.remotePath || "").endsWith("/"))
        ? path.posix.join(finalResolvedRemote, filename)
        : finalResolvedRemote;
      record.destinationPath = finalTargetRemote;

      // Controllo anti-corsa TOCTOU preventivo prima dell'avvio della scrittura (Problema A3)
      const initialExists = isDir
        ? await new Promise<boolean>((resolve) => {
            sftp.stat(finalTargetRemote, (err: any) => resolve(!err));
          })
        : Boolean(initialStat);
      if (initialExists) {
        const policy = this.config.transferOverwritePolicy || "richiedi_conferma";
        if (policy === "rifiuta") {
          throw new MolirisAppError(
            ErrorCode.REMOTE_FS_ERROR,
            `File remoto finale già esistente: ${finalTargetRemote}`,
            "File di destinazione sul robot già esistente. Sovrascrittura categoricamente non consentita dalla politica di sistema."
          );
        }
        if (policy !== "sovrascrivi" && req.overwrite !== true) {
          throw new MolirisAppError(
            ErrorCode.REMOTE_FS_ERROR,
            `File remoto finale già esistente: ${finalTargetRemote}`,
            "File di destinazione sul robot già esistente. Sovrascrittura non consentita senza conferma esplicita."
          );
        }
      }

      // Controllo preventivo spazio su disco robot (Problema A4)
      const remoteTargetDir = path.posix.dirname(finalTargetRemote);
      await this.checkRobotDiskSpace(sftp, remoteTargetDir, stat.size, robot.id);

      const remoteTempPath = path.posix.join(
        remoteTargetDir,
        `.tmp_moliris_${record.transferId}.tmp`
      );
      record.tempDestinationPath = remoteTempPath;
      await this.assertRemoteDestinationWritable(sftp, remoteTargetDir, remoteTempPath, robot.id);

      // RF-TRF-010: Ripresa trasferimenti interrotti (opzionale se abilitata)
      let startOffset = 0;
      let writeFlags: "w" | "a" = "w";
      if (this.config.transferResumeEnabled) {
        const existingTempStat = await new Promise<any>((resolve) => {
          sftp.stat(remoteTempPath, (err: any, st: any) => resolve(err ? null : st));
        });
        if (existingTempStat && existingTempStat.size > 0 && existingTempStat.size < stat.size) {
          startOffset = existingTempStat.size;
          writeFlags = "a";
          record.transferredBytes = startOffset;
          record.lastBytesAtUpdate = startOffset;
          this.logger.info("Ripresa trasferimento server->robot attivata (RF-TRF-010)", {
            robotId: robot.id,
            offset: startOffset,
            totalBytes: stat.size,
          });
        }
      }

      this.assertTransferActive(record);
      this.signalAccepted(record, req);

      const localReadStream = fs.createReadStream(sourceServerPath, {
        start: startOffset,
        highWaterMark: this.getChunkSize(),
      });

      const remoteWriteStream = typeof (sftp as any).open === "function"
        ? new PipelinedSftpWriteStream(sftp, remoteTempPath, {
            flags: writeFlags,
            concurrency: 32,
            chunkSize: 32768,
            highWaterMark: this.getChunkSize(),
            start: startOffset,
          })
        : sftp.createWriteStream(remoteTempPath, {
            flags: writeFlags,
            autoClose: true,
            highWaterMark: this.getChunkSize(),
          });

      record.cleanupHandlers.push(async () => {
        try { localReadStream.destroy(); } catch {}
        try { remoteWriteStream.destroy(); } catch {}
        try {
          await this.safeUnlinkRobotFile(sftp, robot.id, remoteTempPath);
        } catch {
          this.recordPendingCleanup(robot.id, remoteTempPath);
        }
      });

      await this.streamWithTrackingAndChecksum(
        localReadStream,
        remoteWriteStream,
        record,
        req.expectedChecksum,
        startOffset
      );

      // 1. Verifica integrità base sulla STESSA sftp
      const remoteStat = await new Promise<any>((resolve, reject) => {
        sftp.stat(remoteTempPath, (err: any, st: any) => {
          if (err) return reject(this.remoteFsService.mapSftpError(err, remoteTempPath, robot.id));
          resolve(st);
        });
      });

      if (remoteStat.size !== record.transferredBytes) {
        await this.safeUnlinkRobotFile(sftp, robot.id, remoteTempPath);
        this.assertTransferActive(record);
        record.status = TransferStatus.INTEGRITY_FAILED;
        throw new MolirisAppError(
          ErrorCode.INTEGRITY_CHECK_FAILED,
          `Verifica integrità fallita: dimensione sul robot (${remoteStat.size}) diversa dai byte trasferiti (${record.transferredBytes})`,
          "Verifica di integrità del file trasferito fallita."
        );
      }

      // 2. Verifica estesa readback opzionale
      const isReadback = this.config.transferVerifyMode === "readback";
      if (isReadback) {
        const readbackDigest = await this.computeRemoteFileDigest(sftp, remoteTempPath);
        if (readbackDigest.toLowerCase() !== (record.computedChecksum || "").toLowerCase()) {
          await this.safeUnlinkRobotFile(sftp, robot.id, remoteTempPath);
          this.assertTransferActive(record);
          record.status = TransferStatus.INTEGRITY_FAILED;
          throw new MolirisAppError(
            ErrorCode.INTEGRITY_CHECK_FAILED,
            `Verifica integrità readback fallita sul robot: atteso ${record.computedChecksum}, calcolato ${readbackDigest}`,
            "Verifica di integrità del file trasferito fallita."
          );
        }
      }

      // 3. Sostituzione atomica e controllo anti-corsa TOCTOU prima della promozione sulla STESSA sftp
      await this.promoteRemoteTempFile(sftp, remoteTempPath, finalTargetRemote, req.overwrite === true, robot.id, record);

      record.integrityLabel = isReadback
        ? "completato — digest + dimensione verificata e readback remoto"
        : "completato — digest + dimensione verificata sul robot";
      record.integrityVerification = {
        verified: true,
        mode: isReadback ? "readback" : "stream",
        label: record.integrityLabel,
      };

      record.status = TransferStatus.COMPLETED;
      record.completedAt = new Date();
      await this.recordAuditSuccess(record);

      return this.toDto(record);
    } catch (err: any) {
      await this.handleTransferFailure(record, err);
      if (err instanceof MolirisAppError) throw err;
      throw new MolirisAppError(
        (record.errorCode as any) || ErrorCode.TRANSFER_INTERRUPTED,
        err.message || "Trasferimento interrotto prima del completamento.",
        record.error || "Trasferimento file interrotto prima del completamento."
      );
    } finally {
      if (managedConn) {
        try { await managedConn.close(); } catch {}
      }
      if (lockAcquired) this.releaseDestinationLock(destLockKey);
      if (slotAcquired) this.releaseTransferSlot(context.userId, robot.id);
    }
  }

  private async executeRobotToServer(
    context: AuthorizedContext,
    robot: RobotEntity,
    req: StartServerRobotTransferRequest
  ): Promise<TransferDto> {
    const { record, targetServerRelative, finalServerPath } = await this.prepareTransfer(
      context, this.describeTransferAttempt(TransferDirection.ROBOT_TO_SERVER, robot.id, req.remotePath, req.remotePath, req.serverRelativePath),
      async () => {
        // Verifica permessi: TRANSFER_SERVER_ROBOT + download robot + upload server
        this.assertAuthorized(context, robot, [
          AppPermission.TRANSFER_SERVER_ROBOT,
          AppPermission.FS_REMOTE_DOWNLOAD,
          AppPermission.FS_SERVER_UPLOAD,
        ]);

        const safeFilename = path.basename(req.remotePath);
        let targetServerRelative: string;
        if (!req.serverRelativePath || req.serverRelativePath.trim() === "" || req.serverRelativePath === ".") {
          targetServerRelative = safeFilename;
        } else {
          const norm = path.posix.normalize(req.serverRelativePath.trim());
          const stripped = norm === "/" ? "" : norm.replace(/^[/\\]+/, "");
          const fullCandidate = path.resolve(robot.serverDirectoryPath, stripped);
          const expectedPrefix = robot.serverDirectoryPath.endsWith(path.sep)
            ? robot.serverDirectoryPath
            : robot.serverDirectoryPath + path.sep;
          if (fullCandidate !== robot.serverDirectoryPath && !fullCandidate.startsWith(expectedPrefix)) {
            throw new MolirisAppError(
              ErrorCode.SECURITY_VIOLATION,
              `Tentativo di path traversal rilevato nel percorso server: ${redactSensitiveData(norm)}`,
              "Percorso specificato non valido: accesso al di fuori della cartella del robot non consentito."
            );
          }
          if (norm.endsWith("/") || (fs.existsSync(fullCandidate) && fs.statSync(fullCandidate).isDirectory())) {
            targetServerRelative = stripped ? path.posix.join(stripped, safeFilename) : safeFilename;
          } else {
            targetServerRelative = stripped || safeFilename;
          }
        }

        this.serverFsService.assertOperatorAccess(context, targetServerRelative, "TRANSFER_DESTINATION");

        const finalServerPath = await this.serverFsService.resolveRobotPath(robot, targetServerRelative);

        // Record visibile già in coda, prima dello slot e della connessione SFTP.
        const record = this.buildTransferRecord({
          userId: context.userId,
          username: context.username,
          userSessionId: context.sessionId,
          robotId: robot.id,
          direction: TransferDirection.ROBOT_TO_SERVER,
          filename: safeFilename,
          sourcePath: req.remotePath,
          destinationPath: targetServerRelative,
          totalBytes: null,
          expectedChecksum: req.expectedChecksum,
        });
        this.registerTransfer(record);
        return { record, safeFilename, targetServerRelative, finalServerPath };
      }
    );
    this.markAccepted(record, req);

    const destLockKey = `server:${robot.id}:${targetServerRelative}`;
    let slotAcquired = false;
    let lockAcquired = false;
    let remoteReadHandle: Awaited<ReturnType<RemoteFilesystemService["openRemoteReadStream"]>> | null = null;
    try {
      await this.acquireTransferSlot(context.userId, robot.id, record.abortController.signal);
      slotAcquired = true;
      this.assertTransferActive(record);
      this.markTransferActive(record);
      this.acquireDestinationLock(destLockKey);
      lockAcquired = true;
      await this.recordAuditStart(record);

      // Risoluzione e controllo metadati file sorgente sul robot (Prompt 9, RF-FS-004)
      const remoteStats = await this.remoteFsService.getRemoteFileStats(context, robot, req.remotePath);
      if (remoteStats.type === "directory") {
        throw new MolirisAppError(
          ErrorCode.REMOTE_FS_ERROR,
          `Il percorso remoto è una directory: ${req.remotePath}`,
          "Impossibile trasferire una directory."
        );
      }
      record.totalBytes = remoteStats.size;
      this.checkMaxFileSize(remoteStats.size);

      // Controllo sovrascrittura preventiva server (§11.5, RF-TRF-011, Problema A3)
      await this.checkServerOverwritePolicy(finalServerPath, req);

      // Controllo preventivo spazio su server (RF-TRF-014, Problema A4)
      if (remoteStats.size && remoteStats.size > 0) {
        await this.checkServerDiskSpace(path.dirname(finalServerPath), remoteStats.size);
      }

      const tempDir = await this.serverFsService.ensureTempDirectory(robot);
      const tempFilePath = path.join(tempDir, `transfer_${record.transferId}.tmp`);
      record.tempDestinationPath = tempFilePath;

      // RF-TRF-010: Ripresa trasferimenti interrotti (se abilitata)
      let startOffset = 0;
      let writeFlags: "w" | "a" = "w";
      if (this.config.transferResumeEnabled && fs.existsSync(tempFilePath)) {
        const existingStat = await fs.promises.stat(tempFilePath);
        if (existingStat.size > 0 && remoteStats.size !== null && existingStat.size < remoteStats.size) {
          startOffset = existingStat.size;
          writeFlags = "a";
          record.transferredBytes = startOffset;
          record.lastBytesAtUpdate = startOffset;
          this.logger.info("Ripresa trasferimento robot->server attivata (RF-TRF-010)", {
            robotId: robot.id,
            offset: startOffset,
            totalBytes: remoteStats.size,
          });
        }
      }

      const tempWriteStream = fs.createWriteStream(tempFilePath, {
        mode: 0o700,
        flags: writeFlags,
        highWaterMark: this.getChunkSize(),
      });

      record.cleanupHandlers.push(async () => {
        try { tempWriteStream.destroy(); } catch {}
        try {
          if (fs.existsSync(tempFilePath)) await fs.promises.unlink(tempFilePath);
        } catch {}
        if (remoteReadHandle) {
          try { await remoteReadHandle.cleanup(); } catch {}
        }
      });

      remoteReadHandle = await this.remoteFsService.openRemoteReadStream(context, robot, req.remotePath, {
        start: startOffset,
      });
      this.assertTransferActive(record);
      this.signalAccepted(record, req);

      await this.streamWithTrackingAndChecksum(
        remoteReadHandle.stream,
        tempWriteStream,
        record,
        req.expectedChecksum,
        startOffset
      );

      await remoteReadHandle.cleanup();
      remoteReadHandle = null;

      // 1. Verifica integrità base: confronto dimensione file su disco
      const finalStat = await fs.promises.stat(tempFilePath);
      if (finalStat.size !== record.transferredBytes) {
        try { await fs.promises.unlink(tempFilePath); } catch {}
        this.assertTransferActive(record);
        record.status = TransferStatus.INTEGRITY_FAILED;
        throw new MolirisAppError(
          ErrorCode.INTEGRITY_CHECK_FAILED,
          `Verifica integrità fallita: dimensione su server (${finalStat.size}) diversa dai byte trasferiti (${record.transferredBytes})`,
          "Verifica di integrità del file trasferito fallita."
        );
      }

      // 2. Verifica estesa readback opzionale
      const isReadback = this.config.transferVerifyMode === "readback";
      if (isReadback) {
        const readbackDigest = await this.computeLocalFileDigest(tempFilePath);
        if (readbackDigest.toLowerCase() !== (record.computedChecksum || "").toLowerCase()) {
          try { await fs.promises.unlink(tempFilePath); } catch {}
          this.assertTransferActive(record);
          record.status = TransferStatus.INTEGRITY_FAILED;
          throw new MolirisAppError(
            ErrorCode.INTEGRITY_CHECK_FAILED,
            `Verifica integrità readback fallita: atteso ${record.computedChecksum}, calcolato su disco ${readbackDigest}`,
            "Verifica di integrità del file trasferito fallita."
          );
        }
      }

      // 3. Controllo anti-corsa TOCTOU subito prima della promozione
      await this.checkServerOverwritePolicy(finalServerPath, req);

      // Spostamento atomico sulla destinazione server definitiva (RF-TRF-009, CA-TRF-005)
      const targetDir = path.dirname(finalServerPath);
      if (!fs.existsSync(targetDir)) {
        await fs.promises.mkdir(targetDir, { recursive: true });
      }
      this.beginPromotion(record);
      await fs.promises.rename(tempFilePath, finalServerPath);

      record.integrityLabel = isReadback
        ? "completato — digest + dimensione verificata e readback locale"
        : "completato — digest + dimensione verificata sul server";
      record.integrityVerification = {
        verified: true,
        mode: isReadback ? "readback" : "stream",
        label: record.integrityLabel,
      };

      record.status = TransferStatus.COMPLETED;
      record.completedAt = new Date();
      await this.recordAuditSuccess(record);

      return this.toDto(record);
    } catch (err: any) {
      await this.handleTransferFailure(record, err);
      if (err instanceof MolirisAppError) throw err;
      throw new MolirisAppError(
        (record.errorCode as any) || ErrorCode.TRANSFER_INTERRUPTED,
        err.message || "Trasferimento interrotto prima del completamento.",
        record.error || "Trasferimento file interrotto prima del completamento."
      );
    } finally {
      if (remoteReadHandle) {
        try { await remoteReadHandle.cleanup(); } catch {}
      }
      if (lockAcquired) this.releaseDestinationLock(destLockKey);
      if (slotAcquired) this.releaseTransferSlot(context.userId, robot.id);
    }
  }

  // =========================================================================
  // DIREZIONE C: Computer Utente ↔ Robot con Server Intermediario (§6.7, RF-TRF-003, CA-FS-004)
  // =========================================================================

  /**
   * Upload progressivo da browser verso il robot attraverso il server intermediario (§6.7).
   * Il browser non instaura alcuna connessione diretta SSH/SFTP (RF-TRF-003, CA-FS-004).
   * Lo stream transita senza caricare in memoria l'intero file (RF-TRF-004, RNF-PERF-001).
   */
  public async uploadClientToRobot(
    context: AuthorizedContext,
    robot: RobotEntity,
    remoteDirectoryPath: string,
    filename: string,
    incomingStream: Readable,
    options?: TransferExecutionOptions,
    totalBytes?: number | null
  ): Promise<TransferDto> {
    const { record, safeFilename, displayDirectory } = await this.prepareTransfer(
      context, this.describeTransferAttempt(TransferDirection.CLIENT_TO_ROBOT, robot.id, filename, undefined, remoteDirectoryPath),
      async () => {
        this.assertRobotAccessible(robot);
        this.assertAuthorized(context, robot, [
          AppPermission.TRANSFER_CLIENT_ROBOT,
          AppPermission.FS_REMOTE_UPLOAD,
        ]);

        const safeFilename = this.sanitizeFilename(filename);
        this.checkMaxFileSize(totalBytes);

        const displayDirectory = remoteDirectoryPath === "." ? "" : remoteDirectoryPath;
        const displayDestination = path.posix.join(displayDirectory, safeFilename);
        // Record visibile già in coda, prima dello slot e dell'handshake SSH.
        const record = this.buildTransferRecord({
          userId: context.userId,
          username: context.username,
          userSessionId: context.sessionId,
          robotId: robot.id,
          direction: TransferDirection.CLIENT_TO_ROBOT,
          filename: safeFilename,
          sourcePath: safeFilename,
          destinationPath: displayDestination,
          totalBytes: totalBytes || null,
          expectedChecksum: options?.expectedChecksum,
        });
        this.registerTransfer(record);
        return { record, safeFilename, displayDirectory };
      }
    );

    const destLockKey = `robot:${robot.id}:${displayDirectory}/${safeFilename}`;
    let slotAcquired = false;
    let lockAcquired = false;
    let managedConn: ManagedRobotConnection | null = null;
    try {
      await this.acquireTransferSlot(context.userId, robot.id, record.abortController.signal);
      slotAcquired = true;
      this.assertTransferActive(record);
      this.markTransferActive(record);
      this.acquireDestinationLock(destLockKey);
      lockAcquired = true;
      await this.recordAuditStart(record);

      // Riutilizzo di UNA sola connessione SSH/SFTP per l'intero ciclo del caricamento client->robot (§6.7, RNF-PERF-001)
      managedConn = await this.connectionManager.acquireConnection(context.username, robot);
      const sftp = await managedConn.getSftpClient();
      await this.processPendingCleanupsForRobot(robot.id, sftp);

      const targetBase = remoteDirectoryPath === "." ? "" : remoteDirectoryPath;
      const finalResolvedRemote = await this.remoteFsService.resolveAndValidatePath(
        path.posix.join(targetBase, safeFilename),
        context,
        robot,
        sftp
      );
      record.destinationPath = finalResolvedRemote;

      // Controllo anti-corsa TOCTOU preventivo prima dell'avvio dello streaming (Problema A3)
      const initialExists = await new Promise<boolean>((resolve) => {
        sftp.stat(finalResolvedRemote, (err: any) => resolve(!err));
      });
      if (initialExists) {
        const policy = this.config.transferOverwritePolicy || "richiedi_conferma";
        if (policy === "rifiuta") {
          throw new MolirisAppError(
            ErrorCode.REMOTE_FS_ERROR,
            `File remoto finale già esistente: ${finalResolvedRemote}`,
            "File di destinazione sul robot già esistente. Sovrascrittura categoricamente non consentita dalla politica di sistema."
          );
        }
        if (policy !== "sovrascrivi" && options?.overwrite !== true) {
          throw new MolirisAppError(
            ErrorCode.REMOTE_FS_ERROR,
            `File remoto finale già esistente: ${finalResolvedRemote}`,
            "File di destinazione sul robot già esistente. Sovrascrittura non consentita senza conferma esplicita."
          );
        }
      }

      // Controllo preventivo spazio su disco robot (Problema A4)
      if (totalBytes && totalBytes > 0) {
        const remoteTargetDir = path.posix.dirname(finalResolvedRemote);
        await this.checkRobotDiskSpace(sftp, remoteTargetDir, totalBytes, robot.id);
      }

      const remoteTargetDir = path.posix.dirname(finalResolvedRemote);
      const remoteTempPath = path.posix.join(
        remoteTargetDir,
        `.tmp_moliris_${record.transferId}.tmp`
      );
      record.tempDestinationPath = remoteTempPath;

      const remoteWriteStream = typeof (sftp as any).open === "function"
        ? new PipelinedSftpWriteStream(sftp, remoteTempPath, {
            flags: "w",
            concurrency: 32,
            chunkSize: 32768,
            highWaterMark: this.getChunkSize(),
          })
        : sftp.createWriteStream(remoteTempPath, {
            flags: "w",
            autoClose: true,
            highWaterMark: this.getChunkSize(),
          });

      record.cleanupHandlers.push(async () => {
        try { incomingStream.destroy(); } catch {}
        try { remoteWriteStream.destroy(); } catch {}
        try {
          await this.safeUnlinkRobotFile(sftp, robot.id, remoteTempPath);
        } catch {
          this.recordPendingCleanup(robot.id, remoteTempPath);
        }
      });

      await this.streamWithTrackingAndChecksum(
        incomingStream,
        remoteWriteStream,
        record,
        options?.expectedChecksum
      );

      // 1. Verifica integrità base sulla STESSA sftp
      const remoteStat = await new Promise<any>((resolve, reject) => {
        sftp.stat(remoteTempPath, (err: any, st: any) => {
          if (err) return reject(this.remoteFsService.mapSftpError(err, remoteTempPath, robot.id));
          resolve(st);
        });
      });

      if (remoteStat.size !== record.transferredBytes) {
        await this.safeUnlinkRobotFile(sftp, robot.id, remoteTempPath);
        this.assertTransferActive(record);
        record.status = TransferStatus.INTEGRITY_FAILED;
        throw new MolirisAppError(
          ErrorCode.INTEGRITY_CHECK_FAILED,
          `Verifica integrità fallita: dimensione sul robot (${remoteStat.size}) diversa dai byte trasferiti (${record.transferredBytes})`,
          "Verifica di integrità del file trasferito fallita."
        );
      }

      // 2. Verifica estesa readback opzionale (Problema A1 punto b)
      const isReadback = this.config.transferVerifyMode === "readback";
      if (isReadback) {
        const readbackDigest = await this.computeRemoteFileDigest(sftp, remoteTempPath);
        if (readbackDigest.toLowerCase() !== (record.computedChecksum || "").toLowerCase()) {
          await this.safeUnlinkRobotFile(sftp, robot.id, remoteTempPath);
          this.assertTransferActive(record);
          record.status = TransferStatus.INTEGRITY_FAILED;
          throw new MolirisAppError(
            ErrorCode.INTEGRITY_CHECK_FAILED,
            `Verifica integrità readback fallita sul robot: atteso ${record.computedChecksum}, calcolato ${readbackDigest}`,
            "Verifica di integrità del file trasferito fallita."
          );
        }
      }

      // 3. Sostituzione atomica e promozione sulla STESSA sftp
      await this.promoteRemoteTempFile(sftp, remoteTempPath, finalResolvedRemote, options?.overwrite === true, robot.id, record);

      record.integrityLabel = isReadback
        ? "completato — digest + dimensione verificata e readback remoto"
        : "completato — digest + dimensione verificata sul robot";
      record.integrityVerification = {
        verified: true,
        mode: isReadback ? "readback" : "stream",
        label: record.integrityLabel,
      };

      record.status = TransferStatus.COMPLETED;
      record.completedAt = new Date();
      await this.recordAuditSuccess(record);

      return this.toDto(record);
    } catch (err: any) {
      await this.handleTransferFailure(record, err);
      if (err instanceof MolirisAppError) throw err;
      throw new MolirisAppError(
        (record.errorCode as any) || ErrorCode.TRANSFER_INTERRUPTED,
        err.message || "Trasferimento interrotto prima del completamento.",
        record.error || "Trasferimento file interrotto prima del completamento."
      );
    } finally {
      if (managedConn) {
        try { await managedConn.close(); } catch {}
      }
      if (lockAcquired) this.releaseDestinationLock(destLockKey);
      if (slotAcquired) this.releaseTransferSlot(context.userId, robot.id);
    }
  }

  /**
   * Download progressivo dal robot verso il browser dell'utente attraverso il server intermediario (§6.7).
   * Il backend legge dal robot via SFTP e invia progressivamente il contenuto al browser senza caricarlo in RAM.
   */
  public async openDownloadRobotToClient(
    context: AuthorizedContext,
    robot: RobotEntity,
    remoteFilePath: string
  ): Promise<{ stream: Readable; transferDto: TransferDto; filename: string; totalBytes: number | null }> {
    const { record, filename, stats } = await this.prepareTransfer(
      context, this.describeTransferAttempt(TransferDirection.ROBOT_TO_CLIENT, robot.id, remoteFilePath, remoteFilePath),
      async () => {
        this.assertRobotAccessible(robot);
        this.assertAuthorized(context, robot, [
          AppPermission.TRANSFER_CLIENT_ROBOT,
          AppPermission.FS_REMOTE_DOWNLOAD,
        ]);

        const stats = await this.remoteFsService.getRemoteFileStats(context, robot, remoteFilePath);
        if (stats.type === "directory") {
          throw new MolirisAppError(
            ErrorCode.REMOTE_FS_ERROR,
            `Il percorso remoto è una directory: ${remoteFilePath}`,
            "Impossibile scaricare una directory."
          );
        }

        const filename = path.basename(remoteFilePath);
        const record = this.buildTransferRecord({
          userId: context.userId,
          username: context.username,
          userSessionId: context.sessionId,
          robotId: robot.id,
          direction: TransferDirection.ROBOT_TO_CLIENT,
          filename,
          sourcePath: remoteFilePath,
          destinationPath: filename,
          totalBytes: stats.size,
        });
        this.registerTransfer(record);
        return { record, filename, stats };
      }
    );

    let slotAcquired = false;
    let released = false;
    const releaseSlot = () => {
      if (released) return;
      released = true;
      if (slotAcquired) this.releaseTransferSlot(context.userId, robot.id);
    };

    let remoteReadHandle: any = null;
    try {
      await this.acquireTransferSlot(context.userId, robot.id, record.abortController.signal);
      slotAcquired = true;
      this.assertTransferActive(record);
      this.markTransferActive(record);
      await this.recordAuditStart(record);

      remoteReadHandle = await this.remoteFsService.openRemoteReadStream(context, robot, remoteFilePath);

      let sourceCleaned = false;
      const cleanupSource = async () => {
        if (sourceCleaned) return;
        sourceCleaned = true;
        if (remoteReadHandle) {
          try { await remoteReadHandle.cleanup(); } catch {}
          remoteReadHandle = null;
        }
      };
      record.cleanupHandlers.push(cleanupSource);

      this.assertTransferActive(record);
      const outStream = this.createTrackedDownloadStream({
        record,
        sourceStream: remoteReadHandle.stream,
        releaseSlot,
        cleanupSource,
        integrityLabel: "completato — integrità verificata solo lato server",
      });

      return {
        stream: outStream,
        transferDto: this.toDto(record),
        filename,
        totalBytes: stats.size,
      };
    } catch (err: any) {
      if (remoteReadHandle) {
        try { await remoteReadHandle.cleanup(); } catch {}
      }
      releaseSlot();
      await this.handleTransferFailure(record, err);
      if (err instanceof MolirisAppError) throw err;
      throw new MolirisAppError(
        ErrorCode.TRANSFER_INTERRUPTED,
        err.message || "Download interrotto prima del completamento.",
        "Trasferimento file interrotto prima del completamento."
      );
    }
  }

  // =========================================================================
  // DIREZIONE A-bis: Computer ↔ Archivio Generale del Server (§6.5, RF-TRF-001)
  // =========================================================================

  /**
   * Upload dall'Archivio Generale del server (Computer → Server) con lo stesso
   * ciclo di vita degli altri trasferimenti: record visibile, streaming,
   * checksum, scrittura su file temporaneo e rename atomico.
   */
  public async executeGeneralUpload(
    context: AuthorizedContext,
    relativeFilePath: string,
    incomingStream: Readable,
    options?: TransferExecutionOptions,
    totalBytes?: number | null
  ): Promise<TransferDto> {
    const { record, safeRelative, finalPath } = await this.prepareTransfer(
      context, this.describeTransferAttempt(TransferDirection.CLIENT_TO_SERVER, TransferService.GENERAL_SERVER_ID, relativeFilePath, undefined, relativeFilePath),
      async () => {
        if (!context.permissions.has(AppPermission.FS_SERVER_UPLOAD)) {
          throw new MolirisAppError(
            ErrorCode.INSUFFICIENT_PERMISSIONS,
            `Utente '${context.username}' non autorizzato al caricamento nell'archivio generale.`,
            "Operazione non consentita: autorizzazioni insufficienti per il trasferimento file."
          );
        }

        // Non normalizzare prima della validazione: resolveGeneralPath deve poter
        // vedere e rifiutare esplicitamente eventuali sequenze "..".
        const safeRelative = relativeFilePath.replace(/^[/\\]+/, "");
        const filename = path.basename(safeRelative);
        const finalPath = await this.serverFsService.resolveGeneralPath(safeRelative);

        await this.checkServerOverwritePolicy(finalPath, options);

        this.checkMaxFileSize(totalBytes);
        if (totalBytes && totalBytes > 0) {
          await this.checkServerDiskSpace(path.dirname(finalPath), totalBytes);
        }

        const record = this.buildTransferRecord({
          userId: context.userId,
          username: context.username,
          userSessionId: context.sessionId,
          robotId: TransferService.GENERAL_SERVER_ID,
          direction: TransferDirection.CLIENT_TO_SERVER,
          filename,
          sourcePath: filename,
          destinationPath: safeRelative,
          totalBytes: totalBytes || null,
          expectedChecksum: options?.expectedChecksum,
        });
        this.registerTransfer(record);
        return { record, safeRelative, finalPath };
      }
    );

    const tempFilePath = path.join(
      path.dirname(finalPath),
      `.tmp_moliris_${record.transferId}.tmp`
    );
    record.tempDestinationPath = tempFilePath;
    const destLockKey = `general:${safeRelative}`;
    let slotAcquired = false;
    let lockAcquired = false;

    try {
      await fs.promises.mkdir(path.dirname(finalPath), { recursive: true, mode: 0o750 });
      await this.acquireTransferSlot(context.userId, TransferService.GENERAL_SERVER_ID, record.abortController.signal);
      slotAcquired = true;
      this.assertTransferActive(record);
      this.markTransferActive(record);
      this.acquireDestinationLock(destLockKey);
      lockAcquired = true;
      await this.recordAuditStart(record);

      const tempWriteStream = fs.createWriteStream(tempFilePath, {
        mode: 0o700,
        flags: "w",
        highWaterMark: this.getChunkSize(),
      });
      record.cleanupHandlers.push(async () => {
        try { tempWriteStream.destroy(); } catch {}
        try { if (fs.existsSync(tempFilePath)) await fs.promises.unlink(tempFilePath); } catch {}
      });

      await this.streamWithTrackingAndChecksum(
        incomingStream,
        tempWriteStream,
        record,
        options?.expectedChecksum
      );

      const finalStat = await fs.promises.stat(tempFilePath);
      if (finalStat.size !== record.transferredBytes) {
        try { await fs.promises.unlink(tempFilePath); } catch {}
        this.assertTransferActive(record);
        record.status = TransferStatus.INTEGRITY_FAILED;
        throw new MolirisAppError(
          ErrorCode.INTEGRITY_CHECK_FAILED,
          `Verifica integrità fallita: dimensione su disco (${finalStat.size}) diversa dai byte trasferiti (${record.transferredBytes})`,
          "Verifica di integrità del file trasferito fallita."
        );
      }

      if (this.config.transferVerifyMode === "readback") {
        const readbackDigest = await this.computeLocalFileDigest(tempFilePath);
        if (readbackDigest.toLowerCase() !== (record.computedChecksum || "").toLowerCase()) {
          try { await fs.promises.unlink(tempFilePath); } catch {}
          this.assertTransferActive(record);
          record.status = TransferStatus.INTEGRITY_FAILED;
          throw new MolirisAppError(
            ErrorCode.INTEGRITY_CHECK_FAILED,
            "Verifica integrità readback fallita sull'archivio generale.",
            "Verifica di integrità del file trasferito fallita."
          );
        }
      }

      // Ricontrollo TOCTOU e promozione atomica (RF-TRF-009, CA-TRF-005)
      await this.checkServerOverwritePolicy(finalPath, options);
        this.beginPromotion(record);
      await fs.promises.rename(tempFilePath, finalPath);

      const isReadback = this.config.transferVerifyMode === "readback";
      record.integrityLabel = isReadback
        ? "completato — digest + dimensione verificata e readback locale"
        : "completato — digest + dimensione verificata";
      record.integrityVerification = {
        verified: true,
        mode: isReadback ? "readback" : "stream",
        label: record.integrityLabel,
      };
      record.status = TransferStatus.COMPLETED;
      record.completedAt = new Date();
      await this.recordAuditSuccess(record);

      return this.toDto(record);
    } catch (err: any) {
      await this.handleTransferFailure(record, err);
      if (err instanceof MolirisAppError) throw err;
      throw new MolirisAppError(
        (record.errorCode as any) || ErrorCode.TRANSFER_INTERRUPTED,
        err.message || "Trasferimento interrotto prima del completamento.",
        record.error || "Trasferimento file interrotto prima del completamento."
      );
    } finally {
      if (lockAcquired) this.releaseDestinationLock(destLockKey);
      if (slotAcquired) this.releaseTransferSlot(context.userId, TransferService.GENERAL_SERVER_ID);
    }
  }

  /**
   * Preflight di un download dal filesystem server: verifica esistenza,
   * tipo e permessi senza creare un record né aprire lo stream. Consente al
   * frontend di mostrare un errore comprensibile prima del download diretto.
   */
  public async inspectServerDownload(
    context: AuthorizedContext,
    robot: RobotEntity,
    relativeFilePath: string
  ): Promise<{ filename: string; totalBytes: number }> {
    this.assertAuthorized(context, robot, [AppPermission.FS_SERVER_DOWNLOAD]);
    this.assertRobotNotDisabled(robot);
    const targetPath = await this.serverFsService.resolveRobotPath(robot, relativeFilePath);
    if (!fs.existsSync(targetPath)) {
      throw new MolirisAppError(
        ErrorCode.SERVER_DIR_INACCESSIBLE,
        `File non trovato sul server: ${targetPath}`,
        "Il file richiesto non è presente sul server."
      );
    }
    const stat = await fs.promises.stat(targetPath);
    if (!stat.isFile()) {
      throw new MolirisAppError(
        ErrorCode.SERVER_DIR_INACCESSIBLE,
        `Il percorso specificato non è un file regolare: ${targetPath}`,
        "Il percorso richiesto non è un file regolare."
      );
    }
    return { filename: path.basename(targetPath), totalBytes: stat.size };
  }

  /**
   * Preflight di un download dal robot: verifica metadati e tipo senza aprire
   * il flusso verso il browser.
   */
  public async inspectRobotDownload(
    context: AuthorizedContext,
    robot: RobotEntity,
    remoteFilePath: string
  ): Promise<{ filename: string; totalBytes: number | null }> {
    this.assertRobotAccessible(robot);
    this.assertAuthorized(context, robot, [
      AppPermission.TRANSFER_CLIENT_ROBOT,
      AppPermission.FS_REMOTE_DOWNLOAD,
    ]);
    const stats = await this.remoteFsService.getRemoteFileStats(context, robot, remoteFilePath);
    if (stats.type === "directory") {
      throw new MolirisAppError(
        ErrorCode.REMOTE_FS_ERROR,
        `Il percorso remoto è una directory: ${remoteFilePath}`,
        "Impossibile scaricare una directory."
      );
    }
    return { filename: path.posix.basename(remoteFilePath), totalBytes: stats.size };
  }

  /**
   * Preflight di un download dall'Archivio Generale del server.
   */
  public async inspectGeneralDownload(
    context: AuthorizedContext,
    relativeFilePath: string
  ): Promise<{ filename: string; totalBytes: number }> {
    if (!context.permissions.has(AppPermission.FS_SERVER_DOWNLOAD)) {
      throw new MolirisAppError(
        ErrorCode.INSUFFICIENT_PERMISSIONS,
        `Utente '${context.username}' non autorizzato allo scaricamento dall'archivio generale.`,
        "Operazione non consentita: autorizzazioni insufficienti per il trasferimento file."
      );
    }
    const finalPath = await this.serverFsService.resolveGeneralPath(relativeFilePath);
    if (!fs.existsSync(finalPath)) {
      throw new MolirisAppError(
        ErrorCode.SERVER_DIR_INACCESSIBLE,
        `File non trovato nell'archivio generale: ${finalPath}`,
        "Il file richiesto non è presente nell'archivio generale."
      );
    }
    const stat = await fs.promises.stat(finalPath);
    if (!stat.isFile()) {
      throw new MolirisAppError(
        ErrorCode.SERVER_DIR_INACCESSIBLE,
        `Il percorso non è un file regolare: ${finalPath}`,
        "Il percorso richiesto non è un file regolare."
      );
    }
    return { filename: path.basename(finalPath), totalBytes: stat.size };
  }

  /**
   * Download dall'Archivio Generale del server (Server → Computer) con tracking
   * e rilevamento delle interruzioni del client.
   */
  public async openGeneralDownload(
    context: AuthorizedContext,
    relativeFilePath: string
  ): Promise<{ stream: Readable; transferDto: TransferDto; filename: string; totalBytes: number }> {
    const { record, filename, finalPath, stat } = await this.prepareTransfer(
      context, this.describeTransferAttempt(TransferDirection.SERVER_TO_CLIENT, TransferService.GENERAL_SERVER_ID, relativeFilePath, relativeFilePath),
      async () => {
        if (!context.permissions.has(AppPermission.FS_SERVER_DOWNLOAD)) {
          throw new MolirisAppError(
            ErrorCode.INSUFFICIENT_PERMISSIONS,
            `Utente '${context.username}' non autorizzato allo scaricamento dall'archivio generale.`,
            "Operazione non consentita: autorizzazioni insufficienti per il trasferimento file."
          );
        }

        const finalPath = await this.serverFsService.resolveGeneralPath(relativeFilePath);
        if (!fs.existsSync(finalPath)) {
          throw new MolirisAppError(
            ErrorCode.SERVER_DIR_INACCESSIBLE,
            `File non trovato nell'archivio generale: ${finalPath}`,
            "Il file richiesto non è presente nell'archivio generale."
          );
        }
        const stat = await fs.promises.stat(finalPath);
        if (!stat.isFile()) {
          throw new MolirisAppError(
            ErrorCode.SERVER_DIR_INACCESSIBLE,
            `Il percorso non è un file regolare: ${finalPath}`,
            "Il percorso richiesto non è un file regolare."
          );
        }

        const filename = path.basename(finalPath);
        const record = this.buildTransferRecord({
          userId: context.userId,
          username: context.username,
          userSessionId: context.sessionId,
          robotId: TransferService.GENERAL_SERVER_ID,
          direction: TransferDirection.SERVER_TO_CLIENT,
          filename,
          sourcePath: relativeFilePath,
          destinationPath: filename,
          totalBytes: stat.size,
        });
        this.registerTransfer(record);
        return { record, filename, finalPath, stat };
      }
    );

    let slotAcquired = false;
    let released = false;
    const releaseSlot = () => {
      if (released) return;
      released = true;
      if (slotAcquired) this.releaseTransferSlot(context.userId, TransferService.GENERAL_SERVER_ID);
    };

    try {
      await this.acquireTransferSlot(context.userId, TransferService.GENERAL_SERVER_ID, record.abortController.signal);
      slotAcquired = true;
      this.assertTransferActive(record);
      this.markTransferActive(record);
      await this.recordAuditStart(record);

      const rawStream = fs.createReadStream(finalPath, { highWaterMark: this.getChunkSize() });
      let sourceCleaned = false;
      const cleanupSource = async () => {
        if (sourceCleaned) return;
        sourceCleaned = true;
        try { rawStream.destroy(); } catch {}
      };
      record.cleanupHandlers.push(cleanupSource);

      this.assertTransferActive(record);
      const outStream = this.createTrackedDownloadStream({
        record,
        sourceStream: rawStream,
        releaseSlot,
        cleanupSource,
        integrityLabel: "completato — integrità verificata solo lato server",
      });

      return { stream: outStream, transferDto: this.toDto(record), filename, totalBytes: stat.size };
    } catch (err: any) {
      releaseSlot();
      await this.handleTransferFailure(record, err);
      if (err instanceof MolirisAppError) throw err;
      throw new MolirisAppError(
        ErrorCode.TRANSFER_INTERRUPTED,
        err.message || "Download interrotto prima del completamento.",
        "Trasferimento file interrotto prima del completamento."
      );
    }
  }

  // =========================================================================
  // GESTIONE STREAMING, INTEGRITÀ, CONTROPRESSIONE E BUFFERING LIMITATO
  // =========================================================================

  /**
   * Esegue lo streaming tra due flussi applicando:
   * - Buffering limitato e contropressione nativa (RNF-PERF-001, CA-TRF-001)
   * - Tracciamento progresso in tempo reale (RF-TRF-006, CA-TRF-002)
   * - Calcolo checksum in transito (RF-TRF-008, §11.5)
   * - Rifiuto del successo in caso di discrepanza checksum (RF-TRF-008, CA-TRF-004)
   */
  private async streamWithTrackingAndChecksum(
    sourceStream: Readable,
    destStream: Writable,
    record: TransferRecord,
    expectedChecksum?: string,
    initialBytes: number = 0
  ): Promise<void> {
    const progressTracker = new ProgressTrackerStream({
      totalBytes: record.totalBytes,
      initialBytes,
      idleTimeoutMs: this.config.transferIdleTimeoutMs,
      highWaterMark: this.getChunkSize(),
      onProgress: (snap) => this.updateProgress(record, snap),
      onIdleTimeout: () => {
        record.abortController.abort();
      },
    });

    const checksumStream = new ChecksumTransformStream(this.checksumAlgorithm, this.getChunkSize());

    record.pauseController = {
      pause: () => {
        sourceStream.pause();
        progressTracker.markPaused();
      },
      resume: () => {
        progressTracker.markResumed();
        sourceStream.resume();
      },
    };

    try {
      await pipelineWithSignal(sourceStream, progressTracker, checksumStream, destStream, {
        signal: record.abortController.signal,
      });
    } finally {
      record.pausedDurationMs = Math.max(record.pausedDurationMs ?? 0, progressTracker.getPausedDurationMs());
      record.pauseController = undefined;
    }
    this.assertTransferActive(record);
    record.computedChecksum = checksumStream.getDigest() || undefined;

    // STEP 4 – Verifica di integrità (RF-TRF-008, CA-TRF-004)
    if (expectedChecksum && record.computedChecksum) {
      record.status = TransferStatus.INTEGRITY_CHECKING;
      if (record.computedChecksum.toLowerCase() !== expectedChecksum.toLowerCase()) {
        record.status = TransferStatus.INTEGRITY_FAILED;
        throw new MolirisAppError(
          ErrorCode.INTEGRITY_CHECK_FAILED,
          `Verifica integrità fallita: atteso ${expectedChecksum}, calcolato ${record.computedChecksum}`,
          "Verifica di integrità del file trasferito fallita."
        );
      }
    }
  }

  // =========================================================================
  // ANNULLAMENTO, TIMEOUT E PULIZIA (RF-TRF-013, RNF-REL-005)
  // =========================================================================

  /**
   * Annulla un trasferimento su richiesta dell'utente autorizzato (RF-TRF-013).
   */
  public async cancelTransfer(transferId: string, requestedByUserId: string, reason = "USER_CANCELLED"): Promise<TransferDto> {
    const record = this.transfers.get(transferId);
    if (!record) {
      throw new MolirisAppError(
        ErrorCode.TRANSFER_INTERRUPTED,
        `Trasferimento '${transferId}' non trovato`,
        "Trasferimento non trovato."
      );
    }

    // Isolamento: solo il titolare del trasferimento o utenti autorizzati possono annullare (RNF-SEC-007)
    if (record.userId !== requestedByUserId) {
      throw new MolirisAppError(
        ErrorCode.INSUFFICIENT_PERMISSIONS,
        `Utente '${requestedByUserId}' non autorizzato ad annullare il trasferimento di '${record.userId}'`,
        "Operazione non consentita: non è possibile annullare trasferimenti altrui."
      );
    }

    if (TransferService.TERMINAL_STATUSES.has(record.status) || this.promotingTransfers.has(record)) {
      return this.toDto(record);
    }

    record.status = TransferStatus.CANCELLED;
    record.completedAt = new Date();
    record.error = reason === "SERVICE_SHUTDOWN"
      ? "Trasferimento interrotto per arresto del servizio."
      : reason === "SESSION_TERMINATED_EXPIRED"
      ? "Trasferimento interrotto perché la sessione è scaduta."
      : "Trasferimento annullato dall'utente.";
    record.integrityLabel = "integrità non verificata";
    this.finalizeTransferStats(record);
    record.abortController.abort();

    // Riavvia il timer di inattività della sessione al termine dell'operazione (Prompt #4)
    if (record.userSessionId) {
      try {
        this.sessionManager.touchSession(record.userSessionId);
      } catch {}
    }

    // Rilascio e pulizia dei file temporanei (RF-TRF-009, RNF-REL-005)
    for (const cleanup of record.cleanupHandlers) {
      try { await cleanup(); } catch {}
    }

    await this.persistTransferOutcome(record);

    await this.auditRepository.record({
      userId: record.userId,
      operation: AuditOperation.TRANSFER_FAILURE,
      robotId: record.robotId,
      outcome: "FAILURE",
      timestamp: new Date(),
      details: {
        transferId: record.transferId,
        batchId: record.batchId,
        direction: record.direction,
        filename: record.filename,
        sourcePath: record.sourcePath,
        destinationPath: record.destinationPath,
        transferredBytes: record.transferredBytes,
        totalBytes: record.totalBytes,
        error: record.error,
        cancelled: true,
        reason,
      },
    });

    return this.toDto(record);
  }

  /**
   * Mette in pausa un trasferimento attivo (escludendo la durata della pausa dalla velocità media).
   */
  public pauseTransfer(transferId: string, requestedByUserId: string): TransferDto {
    const record = this.transfers.get(transferId);
    if (!record) {
      throw new MolirisAppError(ErrorCode.TRANSFER_INTERRUPTED, `Trasferimento '${transferId}' non trovato`, "Trasferimento non trovato.");
    }
    if (record.userId !== requestedByUserId) {
      throw new MolirisAppError(ErrorCode.INSUFFICIENT_PERMISSIONS, "Non autorizzato a mettere in pausa trasferimenti altrui.");
    }
    if (record.status !== TransferStatus.IN_PROGRESS) {
      return this.toDto(record);
    }
    record.status = TransferStatus.PAUSED;
    record.pausedAtMs = performance.now();
    record.currentSpeedBytesPerSec = 0;
    record.speedBytesPerSec = 0;
    record.etaSeconds = null;
    record.pauseController?.pause();
    this.persistRecord(record);
    return this.toDto(record);
  }

  /**
   * Riprende un trasferimento precedentemente messo in pausa.
   */
  public resumeTransfer(transferId: string, requestedByUserId: string): TransferDto {
    const record = this.transfers.get(transferId);
    if (!record) {
      throw new MolirisAppError(ErrorCode.TRANSFER_INTERRUPTED, `Trasferimento '${transferId}' non trovato`, "Trasferimento non trovato.");
    }
    if (record.userId !== requestedByUserId) {
      throw new MolirisAppError(ErrorCode.INSUFFICIENT_PERMISSIONS, "Non autorizzato a riprendere trasferimenti altrui.");
    }
    if (record.status !== TransferStatus.PAUSED) {
      return this.toDto(record);
    }
    if (record.pausedAtMs !== null && record.pausedAtMs !== undefined) {
      record.pausedDurationMs = (record.pausedDurationMs ?? 0) + Math.max(0, performance.now() - record.pausedAtMs);
      record.pausedAtMs = null;
    }
    record.status = TransferStatus.IN_PROGRESS;
    record.pauseController?.resume();
    this.persistRecord(record);
    return this.toDto(record);
  }

  /**
   * Riprova/Riprende un trasferimento Server ↔ Robot interrotto, fallito o annullato (RF-TRF-010, RF-TRF-012).
   * Usa la richiesta originale: con transferResumeEnabled il file temporaneo parziale viene riutilizzato.
   * I trasferimenti originati dal computer dell'utente non sono riavviabili dal backend (il corpo
   * del file non è conservato): in tal caso viene restituito un errore esplicito.
   */
  public async retryTransfer(
    transferId: string,
    context: AuthorizedContext,
    robot: RobotEntity,
    hooks?: { onQueued?: (dto: TransferDto) => void; onAccepted?: (dto: TransferDto) => void }
  ): Promise<TransferDto> {
    const record = this.transfers.get(transferId);
    if (!record) {
      throw new MolirisAppError(
        ErrorCode.TRANSFER_INTERRUPTED,
        `Trasferimento '${transferId}' non trovato`,
        "Trasferimento non trovato."
      );
    }
    if (record.userId !== context.userId) {
      throw new MolirisAppError(
        ErrorCode.INSUFFICIENT_PERMISSIONS,
        `Utente '${context.userId}' non autorizzato a riprovare il trasferimento di '${record.userId}'`,
        "Operazione non consentita: non è possibile riavviare trasferimenti altrui."
      );
    }
    if (!TransferService.TERMINAL_STATUSES.has(record.status) || record.status === TransferStatus.COMPLETED) {
      throw new MolirisAppError(
        ErrorCode.TRANSFER_INTERRUPTED,
        `Trasferimento '${transferId}' in stato ${record.status}: non riavviabile`,
        "Solo i trasferimenti interrotti, falliti o annullati possono essere riprovati."
      );
    }
    if (!record.originalRequest) {
      throw new MolirisAppError(
        ErrorCode.TRANSFER_INTERRUPTED,
        `Trasferimento '${transferId}' (${record.direction}) non riavviabile dal backend`,
        "Questo trasferimento è stato avviato dal computer: ripeti l'operazione di caricamento o download."
      );
    }
    const original = record.originalRequest;
    // Il vecchio record viene sostituito solo quando il nuovo è stato effettivamente registrato:
    // se la validazione iniziale fallisce, il tentativo precedente resta consultabile.
    return this.executeServerRobotTransfer(context, robot, {
      ...original,
      onQueued: (dto) => {
        this.transfers.delete(transferId);
        hooks?.onQueued?.(dto);
      },
      onAccepted: hooks?.onAccepted,
    });
  }

  /**
   * Rimuove dallo storico un trasferimento terminale (pulizia lista, non cancella file).
   */
  public removeTransfer(transferId: string, requestedByUserId: string): void {
    const record = this.transfers.get(transferId);
    if (!record) {
      throw new MolirisAppError(
        ErrorCode.TRANSFER_INTERRUPTED,
        `Trasferimento '${transferId}' non trovato`,
        "Trasferimento non trovato."
      );
    }
    if (record.userId !== requestedByUserId) {
      throw new MolirisAppError(
        ErrorCode.INSUFFICIENT_PERMISSIONS,
        `Utente '${requestedByUserId}' non autorizzato a rimuovere il trasferimento di '${record.userId}'`,
        "Operazione non consentita: non è possibile rimuovere trasferimenti altrui."
      );
    }
    if (!TransferService.TERMINAL_STATUSES.has(record.status)) {
      throw new MolirisAppError(
        ErrorCode.TRANSFER_INTERRUPTED,
        `Trasferimento '${transferId}' ancora attivo (${record.status})`,
        "Annulla il trasferimento prima di rimuoverlo dalla lista."
      );
    }
    this.transfers.delete(transferId);
    // Nasconde dalla lista Recenti ma conserva intatto lo storico per la vista LOG
    this.transferRepository.markHiddenFromRecent(transferId).catch(() => {});
  }

  /**
   * Rimuove tutti i trasferimenti conclusi dell'utente dalla lista Recenti
   * (non elimina alcun file trasferito e preserva intatto lo storico nei LOG).
   */
  public clearTransferList(requestedByUserId: string): { removedCount: number; skippedActiveCount: number } {
    let removedCount = 0;
    let skippedActiveCount = 0;

    for (const [transferId, record] of Array.from(this.transfers.entries())) {
      if (record.userId !== requestedByUserId) continue;
      if (!TransferService.TERMINAL_STATUSES.has(record.status)) {
        skippedActiveCount++;
        continue;
      }
      this.transfers.delete(transferId);
      this.transferRepository.markHiddenFromRecent(transferId).catch(() => {});
      removedCount++;
    }

    return { removedCount, skippedActiveCount };
  }

  /**
   * Annulla tutti i trasferimenti attivi associati a un utente (es. a chiusura/scadenza sessione).
   */
  public cancelTransfersForUser(userId: string, reason: string): void {
    for (const record of Array.from(this.transfers.values())) {
      if (record.userId === userId && !TransferService.TERMINAL_STATUSES.has(record.status)) {
        this.cancelTrackedTransfer(record, reason);
      }
    }
  }

  /**
   * Annulla i trasferimenti attivi associati a una specifica sessione utente.
   */
  public cancelTransfersForSession(
    sessionId: string,
    userId: string,
    reason: string
  ): void {
    for (const record of Array.from(this.transfers.values())) {
      if (
        record.userId === userId &&
        record.userSessionId === sessionId &&
        !TransferService.TERMINAL_STATUSES.has(record.status)
      ) {
        this.cancelTrackedTransfer(record, reason);
      }
    }
  }

  // =========================================================================
  // GESTIONE CONCORRENZA E LIMITI SIMULTANEI (RF-TRF-012, RNF-PERF-003, CA-TRF-007)
  // =========================================================================

  /** Rimuove dalla mappa i record terminali più vecchi del periodo di retention (default 1h). */
  public evictFinishedTransfers(now = Date.now()): number {
    const ttlMs = (this.config as any).transferRecordRetentionMs ?? 60 * 60 * 1000;
    let evicted = 0;
    for (const [id, rec] of this.transfers) {
      if (!TransferService.TERMINAL_STATUSES.has(rec.status) || !rec.completedAt) continue;
      if (now - rec.completedAt.getTime() >= ttlMs) {
        rec.cleanupHandlers.length = 0;
        this.transfers.delete(id);
        evicted++;
      }
    }
    return evicted;
  }

  /**
   * Restituisce il numero di trasferimenti attivi (QUEUED, IN_PROGRESS, INTEGRITY_CHECKING)
   * associati a una determinata sessione utente (Prompt #4).
   */
  public getActiveTransfersCountForSession(sessionId: string): number {
    if (!sessionId) return 0;
    let count = 0;
    for (const record of this.transfers.values()) {
      if (record.userSessionId === sessionId) {
        if (
          record.status === TransferStatus.QUEUED ||
          record.status === TransferStatus.IN_PROGRESS ||
          record.status === TransferStatus.INTEGRITY_CHECKING
        ) {
          count++;
        }
      }
    }
    return count;
  }

  /**
   * Restituisce il numero di trasferimenti attivi associati a un determinato utente (Prompt #4).
   */
  public getActiveTransfersCountForUser(userId: string): number {
    if (!userId) return 0;
    let count = 0;
    for (const record of this.transfers.values()) {
      if (record.userId === userId) {
        if (
          record.status === TransferStatus.QUEUED ||
          record.status === TransferStatus.IN_PROGRESS ||
          record.status === TransferStatus.INTEGRITY_CHECKING
        ) {
          count++;
        }
      }
    }
    return count;
  }

  /**
   * Alias per provider trasferimenti attivi utente (Requisito #4).
   */
  public countActiveTransfersForUser(userId: string): number {
    return this.getActiveTransfersCountForUser(userId);
  }

  /**
   * Restituisce true se vi è almeno un trasferimento attivo associato alla sessione (Prompt #4).
   */
  public hasActiveTransfersForSession(sessionId: string): boolean {
    return this.getActiveTransfersCountForSession(sessionId) > 0;
  }

  private reconcileActiveCounts(): void {
    const userCounts = new Map<string, number>();
    const robotCounts = new Map<string, number>();
    let serverCount = 0;

    for (const rec of this.transfers.values()) {
      // QUEUED non occupa uno slot; IN_PROGRESS e INTEGRITY_CHECKING sì.
      if (
        rec.status === TransferStatus.IN_PROGRESS ||
        rec.status === TransferStatus.INTEGRITY_CHECKING
      ) {
        serverCount++;
        userCounts.set(rec.userId, (userCounts.get(rec.userId) || 0) + 1);
        robotCounts.set(rec.robotId, (robotCounts.get(rec.robotId) || 0) + 1);
      }
    }

    for (const [uid, count] of this.activeCountByUser.entries()) {
      const real = userCounts.get(uid) || 0;
      if (count > real) {
        this.activeCountByUser.set(uid, real);
      }
    }
    for (const [rid, count] of this.activeCountByRobot.entries()) {
      const real = robotCounts.get(rid) || 0;
      if (count > real) {
        this.activeCountByRobot.set(rid, real);
      }
    }
    if (this.activeCountServer > serverCount) {
      this.activeCountServer = serverCount;
    }
  }

  private async acquireTransferSlot(
    userId: string,
    robotId: string,
    signal?: AbortSignal
  ): Promise<void> {
    const maxPerUser = this.config.maxConcurrentTransfersPerUser;
    const maxPerRobot = this.config.maxConcurrentTransfersPerRobot;
    const maxServer = this.config.maxConcurrentTransfersServer;

    // Loop: dopo un risveglio dalla coda il limite viene rivalutato, perché
    // nel frattempo un altro trasferimento può aver occupato lo slot liberato.
    for (;;) {
      if (signal?.aborted) {
        throw new MolirisAppError(
          ErrorCode.TRANSFER_INTERRUPTED,
          "Trasferimento annullato mentre era in coda."
        );
      }

      this.reconcileActiveCounts();
      const userCount = this.activeCountByUser.get(userId) || 0;
      const robotCount = this.activeCountByRobot.get(robotId) || 0;

      const limitExceeded =
        (maxPerUser > 0 && userCount >= maxPerUser) ||
        (maxPerRobot > 0 && robotCount >= maxPerRobot) ||
        (maxServer > 0 && this.activeCountServer >= maxServer);

      if (!limitExceeded) {
        this.activeCountByUser.set(userId, userCount + 1);
        this.activeCountByRobot.set(robotId, robotCount + 1);
        this.activeCountServer++;
        return;
      }

      if (this.config.transferConcurrencyQueuePolicy !== "coda") {
        // Politica predefinita prudente: rifiuta con messaggio chiaro (RF-TRF-012, CA-TRF-007)
        throw new MolirisAppError(
          ErrorCode.TRANSFER_INTERRUPTED,
          `Limite trasferimenti simultanei raggiunto (server: ${this.activeCountServer}/${maxServer}, user: ${userCount}/${maxPerUser}, robot: ${robotCount}/${maxPerRobot})`,
          "Limite di trasferimenti simultanei raggiunto. Riprovare al termine delle operazioni in corso."
        );
      }

      // Il record del chiamante è già QUEUED e resta visibile mentre attende.
      await new Promise<void>((resolve, reject) => {
        const queue = this.waitQueue;
        let settled = false;
        const removeFromQueue = () => {
          const index = queue.indexOf(entry);
          if (index >= 0) queue.splice(index, 1);
        };
        const cleanup = () => {
          settled = true;
          removeFromQueue();
          signal?.removeEventListener("abort", onAbort);
        };
        const onAbort = () => {
          if (settled) return;
          cleanup();
          reject(
            new MolirisAppError(
              ErrorCode.TRANSFER_INTERRUPTED,
              "Trasferimento annullato mentre era in coda."
            )
          );
        };
        const entry = {
          signal,
          onAbort,
          resolve: () => {
            if (settled) return;
            cleanup();
            resolve();
          },
          reject: (err: Error) => {
            if (settled) return;
            cleanup();
            reject(err);
          },
        };
        if (signal) signal.addEventListener("abort", onAbort, { once: true });
        queue.push(entry);
      });
    }
  }

  private releaseTransferSlot(userId: string, robotId: string): void {
    const userCount = this.activeCountByUser.get(userId) || 1;
    const robotCount = this.activeCountByRobot.get(robotId) || 1;

    this.activeCountByUser.set(userId, Math.max(0, userCount - 1));
    this.activeCountByRobot.set(robotId, Math.max(0, robotCount - 1));
    this.activeCountServer = Math.max(0, this.activeCountServer - 1);

    this.reconcileActiveCounts();

    // Risveglia il primo waiter ancora valido; i waiter annullati si sono già rimossi.
    while (this.waitQueue.length > 0) {
      const next = this.waitQueue.shift()!;
      if (next.signal?.aborted) continue;
      next.resolve();
      break;
    }
  }

  // =========================================================================
  // GESTIONE ERRORI, DISCONNESSIONI E FALLIMENTI (RF-TRF-007, CA-TRF-003, §9)
  // =========================================================================

  private async handleTransferFailure(record: TransferRecord, err: any): Promise<void> {
    // Idempotenza: un errore può essere osservato sia dal callback della pipeline
    // sia dall'evento close. Non sovrascrivere uno stato terminale già consolidato.
    if (record.completedAt && TransferService.TERMINAL_STATUSES.has(record.status)) {
      return;
    }
    if (record.status !== TransferStatus.INTEGRITY_FAILED && record.status !== TransferStatus.CANCELLED) {
      record.status = TransferStatus.FAILED;
    }
    record.completedAt = new Date();

    if (record.userSessionId) {
      try {
        this.sessionManager.touchSession(record.userSessionId);
      } catch {}
    }

    let safeUserMsg = "Trasferimento file non riuscito.";
    let errorCode = ErrorCode.TRANSFER_INTERRUPTED;

    if (err instanceof MolirisAppError) {
      safeUserMsg = err.userMessage;
      errorCode = err.code as any;
    } else if (err.code === "ENOSPC" || (err.message && err.message.toLowerCase().includes("space"))) {
      safeUserMsg = "Spazio di archiviazione insufficiente.";
      errorCode = ErrorCode.INSUFFICIENT_STORAGE as any;
    }

    record.error = safeUserMsg;
    record.errorCode = errorCode;
    this.finalizeTransferStats(record);

    // Esecuzione pulizia dei file temporanei (RF-TRF-009, RNF-REL-005)
    for (const cleanup of record.cleanupHandlers) {
      try { await cleanup(); } catch {}
    }

    this.logger.error("Fallimento trasferimento file", err?.message || safeUserMsg, {
      transferId: record.transferId,
      batchId: record.batchId,
      direction: record.direction,
      robotId: record.robotId,
      errorCode,
    });

    await this.persistTransferOutcome(record, err);

    await this.auditRepository.record({
      userId: record.userId,
      operation: AuditOperation.TRANSFER_FAILURE,
      robotId: record.robotId,
      outcome: "FAILURE",
      timestamp: record.completedAt || new Date(),
      details: {
        transferId: record.transferId,
        batchId: record.batchId,
        direction: record.direction,
        filename: record.filename,
        sourcePath: record.sourcePath,
        destinationPath: record.destinationPath,
        transferredBytes: record.transferredBytes,
        totalBytes: record.totalBytes,
        durationMs: record.durationMs,
        averageSpeedBytesPerSec: record.averageSpeedBytesPerSec,
        error: safeUserMsg,
        errorCode,
        ...(record.batchId ? {
          isBulkStaging: record.isBulkStaging === true,
          failurePhase: record.failurePhase,
          protocolErrorCode: record.protocolErrorCode,
          reason: safeUserMsg,
        } : {}),
        cancelled: record.status === TransferStatus.CANCELLED,
      },
    });
  }

  // =========================================================================
  // CONTROLLI DI SICUREZZA, SPAZIO E VALIDAZIONI PREVENTIVE
  // =========================================================================

  private sanitizeFilename(raw: string): string {
    if (!raw || raw.trim() === "") {
      throw new MolirisAppError(
        ErrorCode.MISSING_ROBOT_PARAMS,
        "Nome file vuoto o non valido.",
        "Nome file non specificato."
      );
    }
    if (raw.includes("\0")) {
      throw new MolirisAppError(
        ErrorCode.REMOTE_FS_ERROR,
        "Nome file contenente byte nulli rifiutato.",
        "Nome file non valido: caratteri non consentiti."
      );
    }
    // Rimuove eventuali prefissi di percorso per estrarre il nome base
    const basename = path.basename(raw.replace(/\\/g, "/"));
    if (basename === "." || basename === ".." || basename === "") {
      throw new MolirisAppError(
        ErrorCode.REMOTE_FS_ERROR,
        `Nome file non valido: ${raw}`,
        "Nome file non consentito."
      );
    }
    return basename;
  }

  private checkMaxFileSize(totalBytes?: number | null): void {
    if (this.config.maxFileSizeBytes && totalBytes && totalBytes > this.config.maxFileSizeBytes) {
      throw new MolirisAppError(
        ErrorCode.INSUFFICIENT_STORAGE,
        `Dimensione file (${totalBytes}) supera il limite massimo configurato (${this.config.maxFileSizeBytes})`,
        "Il file supera la dimensione massima consentita dalla configurazione di sistema."
      );
    }
  }

  private async checkServerDiskSpace(directoryPath: string, requiredBytes: number): Promise<void> {
    const marginBytes = (this.config.transferSpaceMarginMb || 0) * 1024 * 1024;
    const totalRequired = requiredBytes + marginBytes;
    try {
      if ((fs.promises as any).statfs) {
        const stats = await (fs.promises as any).statfs(directoryPath);
        const freeBytes = Number(stats.bavail || stats.bfree) * Number(stats.bsize);
        if (freeBytes < totalRequired) {
          throw new MolirisAppError(
            ErrorCode.INSUFFICIENT_STORAGE,
            `Spazio server insufficiente: richiesti ${totalRequired} byte (incluso margine ${this.config.transferSpaceMarginMb || 0} MB), liberi ${freeBytes} byte`,
            "Spazio di archiviazione insufficiente sul server per completare l'operazione."
          );
        }
      }
    } catch (err: any) {
      if (err instanceof MolirisAppError) throw err;
      // Se statfs non è supportato dall'OS, il controllo avverrà a runtime durante la scrittura
    }
  }

  private async checkRobotDiskSpace(sftpClient: any, targetDir: string, requiredBytes: number, robotId: string): Promise<void> {
    const marginBytes = (this.config.transferSpaceMarginMb || 0) * 1024 * 1024;
    const totalRequired = requiredBytes + marginBytes;
    const hasStatvfs =
      (sftpClient as any)._extensions?.["statvfs@openssh.com"] === "2" &&
      typeof sftpClient.ext_openssh_statvfs === "function";

    if (!hasStatvfs) {
      this.logger.warn("statvfs non supportata dal robot, verifica preventiva spazio saltata", { robotId, targetDir });
      return;
    }

    try {
      const stats = await new Promise<any>((resolve, reject) => {
        sftpClient.ext_openssh_statvfs(targetDir, (err: any, st: any) => {
          if (err) return reject(err);
          resolve(st);
        });
      });
      const freeBytes = Number(stats.f_bavail || stats.f_bfree) * Number(stats.f_frsize || stats.f_bsize);
      if (freeBytes < totalRequired) {
        throw new MolirisAppError(
          ErrorCode.INSUFFICIENT_STORAGE,
          `Spazio robot insufficiente: richiesti ${totalRequired} byte (incluso margine ${this.config.transferSpaceMarginMb || 0} MB), liberi ${freeBytes} byte`,
          "Spazio di archiviazione insufficiente sul robot per completare l'operazione."
        );
      }
    } catch (err: any) {
      if (err instanceof MolirisAppError) throw err;
      this.logger.warn("statvfs non supportata dal robot, verifica preventiva spazio saltata", { robotId, error: err?.message });
    }
  }

  private async checkServerOverwritePolicy(finalPath: string, options?: TransferExecutionOptions): Promise<void> {
    if (fs.existsSync(finalPath)) {
      const policy = this.config.transferOverwritePolicy || "richiedi_conferma";
      if (policy === "rifiuta") {
        throw new MolirisAppError(
          ErrorCode.SERVER_DIR_INACCESSIBLE,
          `File server finale già esistente '${finalPath}': sovrascrittura categoricamente vietata da politica 'rifiuta'`,
          "File già esistente sul server. Sovrascrittura categoricamente non consentita dalla politica di sistema."
        );
      }
      const overwriteAllowed = options?.overwrite === true || options?.confirmed === true || policy === "sovrascrivi";

      if (!overwriteAllowed) {
        throw new MolirisAppError(
          ErrorCode.SERVER_DIR_INACCESSIBLE,
          `File server finale già esistente '${finalPath}': sovrascrittura non confermata`,
          "File già esistente sul server. Sovrascrittura non consentita senza conferma esplicita."
        );
      }
    }
  }

  private assertRobotNotDisabled(robot: RobotEntity): void {
    if (robot.anagraphicState === "disabilitato") {
      throw new MolirisAppError(
        ErrorCode.INSUFFICIENT_PERMISSIONS,
        `Accesso negato: robot '${robot.id}' disabilitato`,
        "Operazione non consentita: il robot è disabilitato."
      );
    }
  }

  private assertRobotAccessible(robot: RobotEntity): void {
    this.assertRobotNotDisabled(robot);
    const isCompleted =
      (robot as any).registrationStatus === "completata" ||
      robot.registrationState === "registrazione_completata" ||
      (robot.registrationState as any) === "completata";

    if (!isCompleted) {
      throw new MolirisAppError(
        ErrorCode.REMOTE_FS_ERROR,
        `Robot '${robot.id}' con registrazione '${robot.registrationState}' non accessibile`,
        "Accesso al robot non consentito: registrazione differita non ancora verificata o fallita."
      );
    }
  }

  private assertAuthorized(context: AuthorizedContext, robot: RobotEntity, requiredPermissions: AppPermission[]): void {
    if (context.targetRobotId && context.targetRobotId !== robot.id) {
      this.recordSecurityViolation(context.username, robot.id, "CROSS_ROBOT_ACCESS_DENIED");
      throw new MolirisAppError(
        ErrorCode.INSUFFICIENT_PERMISSIONS,
        `Violazione isolamento robot: contesto per '${context.targetRobotId}', richiesto '${robot.id}'`,
        "Operazione non consentita: contesto autorizzato per un robot differente."
      );
    }

    for (const perm of requiredPermissions) {
      if (!context.permissions.has(perm)) {
        this.recordSecurityViolation(context.username, robot.id, `PERMISSION_DENIED_${perm}`);
        throw new MolirisAppError(
          ErrorCode.INSUFFICIENT_PERMISSIONS,
          `Permesso '${perm}' mancante per utente '${context.username}' su robot '${robot.id}'`,
          "Operazione non consentita: autorizzazioni insufficienti per il trasferimento file."
        );
      }
    }
  }

  private updateProgress(record: TransferRecord, snap: TransferProgressSnapshot): void {
    record.transferredBytes = snap.transferredBytes;
    record.totalBytes = snap.totalBytes;
    record.currentSpeedBytesPerSec = snap.speedBytesPerSec;
    record.speedBytesPerSec = snap.speedBytesPerSec;
    record.etaSeconds = snap.etaSeconds;
    record.lastProgressUpdateAt = Date.now();

    // Attività qualificata: avanzamento di un trasferimento avviato dalla stessa sessione -> rinnovo sessione
    if (record.userSessionId) {
      this.sessionManager.touchSession(record.userSessionId);
    }
  }

  // =========================================================================
  // METODI DI INTERROGAZIONE E DTO (RNF-SEC-002, RNF-SEC-007)
  // =========================================================================

  public getTransfer(transferId: string, context: AuthorizedContext): TransferDto {
    const record = this.transfers.get(transferId);
    if (!record) {
      throw new MolirisAppError(
        ErrorCode.TRANSFER_INTERRUPTED,
        `Trasferimento '${transferId}' non trovato`,
        "Trasferimento non trovato."
      );
    }

    // Isolamento: solo il titolare del trasferimento o utenti con permesso sul robot possono vederlo (RNF-SEC-007)
    if (record.userId !== context.userId && (!context.targetRobotId || context.targetRobotId !== record.robotId)) {
      throw new MolirisAppError(
        ErrorCode.INSUFFICIENT_PERMISSIONS,
        `Accesso negato ai dati di trasferimento di altro utente`,
        "Operazione non consentita."
      );
    }

    return this.toDto(record);
  }

  public listTransfers(context: AuthorizedContext, robotId?: string): TransferDto[] {
    const list: TransferRecord[] = [];
    const isAdmin = Array.isArray(context.roles) && context.roles.some((r) => r.toLowerCase() === "admin");
    for (const record of this.transfers.values()) {
      if (robotId && record.robotId !== robotId) continue;
      if (isAdmin || record.userId === context.userId || context.targetRobotId === record.robotId || !context.targetRobotId) {
        list.push(record);
      }
    }
    return list.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
      .map((record) => this.toDto(record));
  }

  /**
   * Restituisce l'elenco completo dello storico trasferimenti per la vista LOG (inclusi falliti,
   * annullati, interrotti, in corso e quelli nascosti dalla lista Recenti).
   * Non esclude mai i trasferimenti falliti salvo filtro esplicito.
   */
  public async listAllTransferHistory(options?: {
    userId?: string;
    isAdmin?: boolean;
    batchId?: string;
    status?: string;
    user?: string;
    outcome?: string;
    file?: string;
    limit?: number;
    offset?: number;
  }): Promise<TransferHistoryDocument[]> {
    const merged = new Map<string, TransferHistoryDocument>();
    const persisted = await this.transferRepository.list({
      userId: options?.userId,
      isAdmin: options?.isAdmin ?? true,
      batchId: options?.batchId,
      status: options?.status,
      includeHiddenFromRecent: true,
    });
    for (const doc of persisted) {
      merged.set(doc.transferId, doc);
    }
    for (const record of this.transfers.values()) {
      const doc = this.toHistoryDocument(record);
      if (options?.batchId && doc.batchId !== options.batchId) continue;
      if (options?.status && options.status !== "ALL" && doc.status !== options.status) continue;
      if (options?.isAdmin === false && options?.userId && doc.userId !== options.userId) continue;
      merged.set(doc.transferId, doc);
    }

    const userNeedle = options?.user?.trim().toLowerCase();
    const fileNeedle = options?.file?.trim().toLowerCase();
    const outcomeUpper = options?.outcome?.trim().toUpperCase();

    const filtered = Array.from(merged.values()).filter((doc) => {
      if (userNeedle) {
        const matchUser =
          (doc.username || "").toLowerCase().includes(userNeedle) ||
          (doc.userId || "").toLowerCase().includes(userNeedle);
        if (!matchUser) return false;
      }
      if (fileNeedle && !(doc.filename || "").toLowerCase().includes(fileNeedle)) {
        return false;
      }
      if (outcomeUpper && outcomeUpper !== "ALL") {
        if (outcomeUpper === "SUCCESSO" || outcomeUpper === "COMPLETED") {
          if (doc.status !== TransferStatus.COMPLETED) return false;
        } else if (outcomeUpper === "FALLIMENTO" || outcomeUpper === "FALLITO" || outcomeUpper === "FAILED") {
          if (
            doc.status !== TransferStatus.FAILED &&
            doc.status !== TransferStatus.INTEGRITY_FAILED &&
            doc.status !== TransferStatus.CANCELLED
          ) {
            return false;
          }
        } else if (doc.status.toUpperCase() !== outcomeUpper) {
          return false;
        }
      }
      return true;
    });

    const sorted = filtered.sort(
      (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
    );
    const offset = Math.max(0, options?.offset ?? 0);
    const limit = options?.limit && options.limit > 0 ? options.limit : sorted.length;
    return sorted.slice(offset, offset + limit);
  }

  private toDto(record: TransferRecord): TransferDto {
    let percent: number | null = record.status === TransferStatus.COMPLETED ? 100 : null;
    if (record.totalBytes && record.totalBytes > 0) {
      percent = Math.min(100, Math.round((record.transferredBytes / record.totalBytes) * 10000) / 100);
    } else if (record.status === TransferStatus.COMPLETED && record.totalBytes === 0 && record.transferredBytes === 0) {
      percent = 100;
    }

    const effectiveCurrentSpeed =
      record.status === TransferStatus.IN_PROGRESS
        ? (record.currentSpeedBytesPerSec ?? record.speedBytesPerSec ?? null)
        : null;
    const effectiveAverageSpeed = record.averageSpeedBytesPerSec ?? null;
    const effectiveDisplaySpeed =
      record.status === TransferStatus.COMPLETED
        ? (effectiveAverageSpeed ?? record.speedBytesPerSec ?? null)
        : record.status === TransferStatus.IN_PROGRESS
          ? effectiveCurrentSpeed
          : (effectiveAverageSpeed ?? record.speedBytesPerSec ?? null);

    return {
      transferId: record.transferId,
      batchId: record.batchId,
      isBulkStaging: record.isBulkStaging,
      bulkBatch: record.bulkBatch && {
        ...record.bulkBatch,
        status: record.batchId ? this.batchTransferManager?.getBatch(record.batchId)?.status : undefined,
      },
      failurePhase: record.failurePhase,
      userId: record.userId,
      username: record.username,
      robotId: record.robotId,
      direction: record.direction,
      filename: record.filename,
      sourcePath: record.sourcePath,
      destinationPath: record.destinationPath,
      totalBytes: record.totalBytes,
      transferredBytes: record.transferredBytes,
      percent,
      speedBytesPerSec: effectiveDisplaySpeed,
      currentSpeedBytesPerSec: effectiveCurrentSpeed,
      averageSpeedBytesPerSec: effectiveAverageSpeed,
      etaSeconds: record.status === TransferStatus.IN_PROGRESS ? record.etaSeconds : record.status === TransferStatus.COMPLETED ? 0 : null,
      status: record.status,
      error: record.error,
      errorCode: record.errorCode,
      checksum: record.computedChecksum || null,
      checksumAlgorithm: record.checksumAlgorithm || null,
      integrityLabel: record.integrityLabel || (record.status === TransferStatus.COMPLETED ? "completato" : "integrità non verificata"),
      integrityVerification: record.integrityVerification,
      startedAt: record.startedAt.toISOString(),
      activeStartedAt: record.activeStartedAt ? record.activeStartedAt.toISOString() : null,
      completedAt: record.completedAt ? record.completedAt.toISOString() : null,
      durationMs: record.durationMs ?? null,
      sourceFile: record.filename || record.sourcePath,
      targetFile: record.destinationPath ? path.basename(record.destinationPath) : record.filename,
      percentage: percent ?? 0,
      speedBps: effectiveDisplaySpeed || 0,
      currentSpeedBps: effectiveCurrentSpeed,
      averageSpeedBps: effectiveAverageSpeed,
      errorMessage: record.error || undefined,
    };
  }

  private async computeLocalFileDigest(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const readStream = fs.createReadStream(filePath, { highWaterMark: this.getChunkSize() });
      const checksumStream = new ChecksumTransformStream(this.checksumAlgorithm, this.getChunkSize());
      readStream.on("error", reject);
      checksumStream.on("error", reject);
      checksumStream.on("finish", () => {
        const digest = checksumStream.getDigest();
        if (digest === null) {
          reject(new Error("Impossibile calcolare il digest del file"));
          return;
        }
        resolve(digest);
      });
      readStream.pipe(checksumStream);
    });
  }

  private async computeRemoteFileDigest(sftpClient: any, remotePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const readStream = typeof (sftpClient as any).open === "function"
        ? new PipelinedSftpReadStream(sftpClient, remotePath, {
            concurrency: 32,
            chunkSize: 32768,
            highWaterMark: this.getChunkSize(),
          })
        : sftpClient.createReadStream(remotePath, { highWaterMark: this.getChunkSize() });
      const checksumStream = new ChecksumTransformStream(this.checksumAlgorithm, this.getChunkSize());
      readStream.on("error", reject);
      checksumStream.on("error", reject);
      checksumStream.on("finish", () => {
        const digest = checksumStream.getDigest();
        if (digest === null) {
          reject(new Error("Impossibile calcolare il digest del file"));
          return;
        }
        resolve(digest);
      });
      readStream.pipe(checksumStream);
    });
  }

  private async safeUnlinkRobotFile(sftpClient: any, robotId: string, remoteTempPath: string): Promise<void> {
    let unlinked = false;
    if (sftpClient && typeof sftpClient.unlink === "function") {
      try {
        await new Promise<void>((resolve, reject) => {
          sftpClient.unlink(remoteTempPath, (err: any) => {
            if (err) {
              if (err.code === 2 || err.code === "ENOENT" || (err.message && err.message.toLowerCase().includes("no such file"))) {
                return resolve(); // File già rimosso o non esistente
              }
              return reject(err);
            }
            resolve();
          });
        });
        unlinked = true;
      } catch {
        unlinked = false;
      }
    }

    if (!unlinked) {
      // Fallback con connessione dedicata per garantire l'eliminazione immediata (RF-TRF-009)
      try {
        const robot = await this.robotRepository.findById(robotId);
        if (robot && this.connectionManager) {
          const cleanConn = await this.connectionManager.acquireConnection("system_cleanup", robot);
          try {
            const cleanSftp = await cleanConn.getSftpClient();
            await new Promise<void>((resolve, reject) => {
              cleanSftp.unlink(remoteTempPath, (err: any) => {
                if (err && err.code !== 2 && err.code !== "ENOENT" && !(err.message && err.message.toLowerCase().includes("no such file"))) {
                  return reject(err);
                }
                resolve();
              });
            });
            unlinked = true;
          } finally {
            await cleanConn.close().catch(() => {});
          }
        }
      } catch {
        this.recordPendingCleanup(robotId, remoteTempPath);
      }
    }
  }

  public async purgeTempFilesForRobot(robot: RobotEntity): Promise<{
    purgedCount: number;
    freedBytes: number;
    purgedFiles: string[];
  }> {
    let purgedCount = 0;
    let freedBytes = 0;
    const purgedFiles: string[] = [];

    // 1. Scansione e pulizia sul server (cartella associata a questo robot)
    if (fs.existsSync(robot.serverDirectoryPath)) {
      const scanServer = async (dir: string) => {
        let entries: fs.Dirent[] = [];
        try {
          entries = await fs.promises.readdir(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            await scanServer(fullPath);
          } else if (entry.isFile() && (entry.name.startsWith(".tmp_moliris_") || (entry.name.startsWith(".tmp_") && entry.name.endsWith(".tmp")))) {
            try {
              const st = await fs.promises.stat(fullPath);
              await fs.promises.unlink(fullPath);
              purgedCount++;
              freedBytes += st.size;
              purgedFiles.push(`[SERVER] ${fullPath}`);
            } catch {}
          }
        }
      };
      await scanServer(robot.serverDirectoryPath);
    }

    // 2. Scansione e pulizia sul robot via SFTP
    let managedConn: ManagedRobotConnection | null = null;
    try {
      managedConn = await this.connectionManager.acquireConnection("system_cleanup", robot);
      const sftp = await managedConn.getSftpClient();

      const dirsToScan = [
        `/home/${robot.remoteUsername}`,
        "/tmp",
      ];

      for (const dir of dirsToScan) {
        const list: any[] = await new Promise((resolve) => {
          sftp.readdir(dir, (err: any, files: any) => resolve(err ? [] : files));
        });

        const tempItems = list.filter((item: any) =>
          item.filename &&
          (item.filename.startsWith(".tmp_moliris_") || (item.filename.startsWith(".tmp_") && item.filename.endsWith(".tmp")))
        );

        for (const item of tempItems) {
          const remoteFilePath = path.posix.join(dir, item.filename);
          const size = item.attrs?.size || 0;
          await new Promise<void>((resolve) => {
            sftp.unlink(remoteFilePath, () => resolve());
          });
          purgedCount++;
          freedBytes += size;
          purgedFiles.push(`[ROBOT ${robot.id}] ${remoteFilePath}`);
        }
      }
    } catch (err: any) {
      this.logger.warn("Bonifica remota sul robot fallita o non disponibile", {
        robotId: robot.id,
        errorCode: err instanceof MolirisAppError ? err.code : undefined,
        error: err instanceof MolirisAppError
          ? err.diagnosticDetail
          : err instanceof Error ? err.message : String(err),
        userMessage: err instanceof MolirisAppError ? err.userMessage : undefined,
      });
    } finally {
      if (managedConn) {
        try { await managedConn.close(); } catch {}
      }
    }

    // Rimuove eventuali cleanup memorizzati per questo robot
    this.pendingCleanups = this.pendingCleanups.filter((p) => p.robotId !== robot.id);

    return { purgedCount, freedBytes, purgedFiles };
  }

  public async purgeAllTempFiles(): Promise<{
    serverPurged: number;
    serverFreedBytes: number;
    robotsPurged: number;
    robotsFreedBytes: number;
    details: string[];
  }> {
    let serverPurged = 0;
    let serverFreedBytes = 0;
    let robotsPurged = 0;
    let robotsFreedBytes = 0;
    const details: string[] = [];

    // Scansione root server-fs
    const rootDir = this.config.serverFilesystemRoot;
    if (fs.existsSync(rootDir)) {
      const scanServer = async (dir: string) => {
        let entries: fs.Dirent[] = [];
        try {
          entries = await fs.promises.readdir(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            await scanServer(fullPath);
          } else if (entry.isFile() && (entry.name.startsWith(".tmp_moliris_") || (entry.name.startsWith(".tmp_") && entry.name.endsWith(".tmp")))) {
            try {
              const st = await fs.promises.stat(fullPath);
              await fs.promises.unlink(fullPath);
              serverPurged++;
              serverFreedBytes += st.size;
              details.push(`[SERVER] ${fullPath} (${(st.size / (1024 * 1024)).toFixed(2)} MB)`);
            } catch {}
          }
        }
      };
      await scanServer(rootDir);
    }

    // Scansione di tutti i robot registrati
    const robots = await this.robotRepository.list();
    for (const robot of robots) {
      const res = await this.purgeTempFilesForRobot(robot);
      robotsPurged += res.purgedCount;
      robotsFreedBytes += res.freedBytes;
      for (const item of res.purgedFiles) {
        details.push(item);
      }
    }

    this.pendingCleanups = [];

    return {
      serverPurged,
      serverFreedBytes,
      robotsPurged,
      robotsFreedBytes,
      details,
    };
  }

  private recordPendingCleanup(robotId: string, remoteTempPath: string): void {
    this.pendingCleanups.push({
      robotId,
      remoteTempPath,
      createdAt: new Date(),
    });
    this.logger.warn("Registrata pulizia in sospeso per robot", { robotId, remoteTempPath });
  }

  private async processPendingCleanupsForRobot(robotId: string, sftpClient: any): Promise<void> {
    const now = Date.now();
    const remaining: typeof this.pendingCleanups = [];

    for (const item of this.pendingCleanups) {
      if (item.robotId !== robotId) {
        remaining.push(item);
        continue;
      }

      const ageMs = now - item.createdAt.getTime();
      if (ageMs > 60 * 60 * 1000) {
        this.logger.warn(
          "AVVISO AMMINISTRATIVO: File orfano su robot non rimosso dopo 60 minuti da disconnessione. Verifica manuale richiesta.",
          { robotId: item.robotId, remoteTempPath: item.remoteTempPath, createdAt: item.createdAt }
        );
      } else {
        try {
          await new Promise<void>((resolve, reject) => {
            sftpClient.unlink(item.remoteTempPath, (err: any) => {
              if (err) return reject(err);
              resolve();
            });
          });
          this.logger.info("Pulizia file orfano completata alla riconnessione del robot", {
            robotId: item.robotId,
            remoteTempPath: item.remoteTempPath,
          });
        } catch {
          remaining.push(item);
        }
      }
    }
    this.pendingCleanups = remaining;
  }

  public async cleanupServerOrphanTempFiles(): Promise<number> {
    let cleanedCount = 0;
    const rootDir = this.config.serverFilesystemRoot;
    if (!fs.existsSync(rootDir)) return 0;

    const maxAgeMs = (this.config.tempFileRetentionMinutes || 60) * 60 * 1000;
    const now = Date.now();

    const scanDirectory = async (dir: string) => {
      let entries: fs.Dirent[] = [];
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === ".tmp") {
            try {
              const tmpFiles = await fs.promises.readdir(fullPath);
              for (const tf of tmpFiles) {
                const tfPath = path.join(fullPath, tf);
                try {
                  const st = await fs.promises.stat(tfPath);
                  if (now - st.mtimeMs > maxAgeMs) {
                    await fs.promises.unlink(tfPath);
                    cleanedCount++;
                  }
                } catch {}
              }
            } catch {}
          } else {
            await scanDirectory(fullPath);
          }
        } else if (entry.isFile() && (entry.name.startsWith(".tmp_moliris_") || (entry.name.startsWith(".tmp_") && entry.name.endsWith(".tmp")))) {
          try {
            const st = await fs.promises.stat(fullPath);
            if (now - st.mtimeMs > maxAgeMs) {
              await fs.promises.unlink(fullPath);
              cleanedCount++;
            }
          } catch {}
        }
      }
    };

    await scanDirectory(rootDir);
    if (cleanedCount > 0) {
      this.logger.info(`Pulizia periodica server: rimossi ${cleanedCount} file temporanei orfani.`);
    }
    return cleanedCount;
  }

  private async promoteRemoteTempFile(
    sftpClient: any,
    remoteTempPath: string,
    finalPath: string,
    overwriteConfirmed: boolean,
    robotId: string,
    record: TransferRecord
  ): Promise<void> {
    const mapError = (err: Error & { code?: string | number }) => Object.assign(
      this.remoteFsService.mapSftpError(err, finalPath, robotId),
      { protocolErrorCode: err.code }
    );
    // Controllo anti-corsa TOCTOU su destinazione finale subito prima della promozione
    const exists = await new Promise<boolean>((resolve, reject) => {
      sftpClient.stat(finalPath, (err: any) => {
        if (!err) resolve(true);
        else if (err.code === 2 || err.code === "ENOENT") resolve(false);
        else reject(mapError(err));
      });
    });

    if (exists) {
      const policy = this.config.transferOverwritePolicy || "richiedi_conferma";
      if (policy === "rifiuta") {
        await this.safeUnlinkRobotFile(sftpClient, robotId, remoteTempPath);
        throw new MolirisAppError(
          ErrorCode.REMOTE_FS_ERROR,
          `File remoto finale già esistente: ${finalPath}`,
          "File di destinazione sul robot già esistente. Sovrascrittura categoricamente non consentita dalla politica di sistema."
        );
      }
      if (policy !== "sovrascrivi" && !overwriteConfirmed) {
        await this.safeUnlinkRobotFile(sftpClient, robotId, remoteTempPath);
        throw new MolirisAppError(
          ErrorCode.REMOTE_FS_ERROR,
          `File remoto finale già esistente: ${finalPath}`,
          "File di destinazione sul robot già esistente. Sovrascrittura non consentita senza conferma esplicita."
        );
      }

      // Sostituzione atomica: verifica supporto estensione OpenSSH posix-rename@openssh.com
      const hasPosixRename =
        (sftpClient as any)._extensions?.["posix-rename@openssh.com"] === "1" &&
        typeof sftpClient.ext_openssh_rename === "function";

      if (hasPosixRename) {
        this.beginPromotion(record);
        await new Promise<void>((resolve, reject) => {
          sftpClient.ext_openssh_rename(remoteTempPath, finalPath, (err: any) => {
            if (err) return reject(mapError(err));
            resolve();
          });
        });
      } else {
        if (this.config.robotNonAtomicReplace === true) {
          this.logger.warn("Sostituzione non atomica sul robot: rischio perdita file in caso di crash", {
            robotId,
            targetPath: finalPath,
          });
          this.beginPromotion(record);
          await new Promise<void>((res) => sftpClient.unlink(finalPath, () => res()));
          await new Promise<void>((resolve, reject) => {
            sftpClient.rename(remoteTempPath, finalPath, (err: any) => {
              if (err) return reject(mapError(err));
              resolve();
            });
          });
        } else {
          await this.safeUnlinkRobotFile(sftpClient, robotId, remoteTempPath);
          throw new MolirisAppError(
            ErrorCode.REMOTE_FS_ERROR,
            `Sostituzione atomica non supportata dal robot (posix-rename assente). File preesistente preservato: ${finalPath}`,
            "Impossibile sostituire atomicamente il file sul robot senza rischiare la perdita del file preesistente."
          );
        }
      }
    } else {
      this.beginPromotion(record);
      await new Promise<void>((resolve, reject) => {
        sftpClient.rename(remoteTempPath, finalPath, (err: any) => {
          if (err) return reject(mapError(err));
          resolve();
        });
      });
    }
  }

  public describeTransferAttempt(
    direction: string, robotId: string, filename: string, sourcePath?: string, destinationPath?: string
  ): TransferLogAttempt {
    const at = (location: string, filePath?: string) => filePath ? `${location} · ${filePath}` : location;
    const archive = robotId === TransferService.GENERAL_SERVER_ID ? "Archivio generale" : `Archivio server robot ${robotId}`;
    const remote = `SFTP robot ${robotId}`;
    const actualName = path.posix.basename((filename || "").replace(/\\/g, "/")) || "File non specificato";
    switch (direction) {
      case TransferDirection.CLIENT_TO_SERVER:
        return { direction, filename: actualName, source: "Computer", destination: at(archive, destinationPath) };
      case TransferDirection.CLIENT_TO_ROBOT:
        return { direction, filename: actualName, source: "Computer", destination: at(remote, destinationPath) };
      case TransferDirection.SERVER_TO_CLIENT:
        return { direction, filename: actualName, source: at(archive, sourcePath), destination: "Computer" };
      case TransferDirection.ROBOT_TO_CLIENT:
        return { direction, filename: actualName, source: at(remote, sourcePath), destination: "Computer" };
      case TransferDirection.SERVER_TO_ROBOT:
        return { direction, filename: actualName, source: at(archive, sourcePath), destination: at(remote, destinationPath) };
      case TransferDirection.ROBOT_TO_SERVER:
        return { direction, filename: actualName, source: at(remote, sourcePath), destination: at(archive, destinationPath) };
      default:
        return { direction, filename: actualName, source: sourcePath, destination: destinationPath };
    }
  }

  private describeBulkAttempt(
    filename: string, target: BulkTarget, batchId: string, source?: BulkLogSource, sourcePath?: string
  ): TransferLogAttempt {
    const destination = path.posix.join(target.directory || "/", filename);
    const targetId = target.type === "general" ? TransferService.GENERAL_SERVER_ID : target.robotId || "sconosciuto";
    const route = this.describeTransferAttempt(
      target.type === "robot" ? TransferDirection.CLIENT_TO_ROBOT : TransferDirection.CLIENT_TO_SERVER,
      targetId, filename, undefined, destination
    );
    if (source) {
      const archive = source.scope === "general" ? "Archivio generale" : `Archivio server robot ${source.robotId || "sconosciuto"}`;
      route.source = `${archive} · ${sourcePath || filename}`;
      route.direction = target.type === "robot" ? TransferDirection.SERVER_TO_ROBOT : "SERVER_TO_SERVER";
    }
    return { ...route, batchId };
  }

  private async appendTransferOutcome(entry: TransferLogEntry): Promise<void> {
    if (!this.physicalFileLogger) return;
    try {
      await this.physicalFileLogger.logTransfer(entry);
    } catch (err) {
      this.logger.error("Scrittura esito in transfers.log non riuscita", undefined, {
        transferId: entry.transferId, batchId: entry.batchId, outcome: entry.outcome,
        code: (err as NodeJS.ErrnoException)?.code,
      });
    }
  }

  private transferFailureDetail(err: unknown): string {
    if (err instanceof MolirisAppError) return `${err.userMessage} [${err.code}]`;
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (err instanceof SftpWriteError) return `Operazione SFTP ${err.operation} non riuscita${typeof err.code === "number" ? ` (codice ${err.code})` : ""}.`;
    switch (code) {
      case "ENOENT": return "File o cartella non presente.";
      case "EACCES":
      case "EPERM": return "Permessi insufficienti.";
      case "ENOSPC":
      case "EDQUOT": return "Spazio di archiviazione insufficiente.";
      case "ETIMEDOUT": return "Tempo massimo di attesa superato.";
      case "ECONNRESET":
      case "EPIPE": return "Connessione interrotta.";
      default: return "Errore I/O durante il trasferimento.";
    }
  }

  public async logTransferPrecheckFailure(
    username: string, attempt: TransferLogAttempt, err: unknown
  ): Promise<void> {
    await this.appendTransferOutcome({
      ...attempt,
      transferId: attempt.transferId || crypto.randomUUID(),
      username,
      outcome: "FALLIMENTO",
      details: `Pre-check: ${this.transferFailureDetail(err)}`,
    });
  }

  public async logBulkPrecheckFailure(
    username: string, filenames: string[], targets: BulkTarget[], batchId: string, err: unknown, source?: BulkLogSource
  ): Promise<void> {
    for (const file of new Set(filenames)) {
      const filename = path.posix.basename(file.replace(/\\/g, "/"));
      for (const target of targets) {
        await this.logTransferPrecheckFailure(username, this.describeBulkAttempt(filename, target, batchId, source, file), err);
      }
    }
  }

  private async prepareTransfer<T>(
    context: AuthorizedContext, attempt: TransferLogAttempt, prepare: () => Promise<T>
  ): Promise<T> {
    try {
      return await prepare();
    } catch (err) {
      await this.logTransferPrecheckFailure(context.username, attempt, err);
      throw err;
    }
  }

  private persistTransferOutcome(record: TransferRecord, cause?: unknown): Promise<void> {
    const existing = this.terminalLogWrites.get(record);
    if (existing) return existing;

    let route = this.transferLogRoutes.get(record);
    if (!route) {
      route = record.isBulkStaging
        ? { direction: record.direction, source: "Computer", destination: "Ricezione temporanea sul server" }
        : this.describeTransferAttempt(
          record.direction, record.robotId, record.filename, record.sourcePath, record.destinationPath
        );
    }
    const outcome = record.status === TransferStatus.COMPLETED ? "SUCCESSO"
      : record.status === TransferStatus.CANCELLED ? "ANNULLATO" : "FALLIMENTO";
    const avgLabel =
      record.averageSpeedBytesPerSec && record.averageSpeedBytesPerSec > 0
        ? `, media: ${record.averageSpeedBytesPerSec} B/s`
        : "";
    const details = outcome === "SUCCESSO"
      ? `Completato (${record.transferredBytes} byte${avgLabel}, checksum: ${record.computedChecksum || "N/A"})`
      : cause && !(cause instanceof MolirisAppError) && outcome !== "ANNULLATO"
        ? this.transferFailureDetail(cause)
        : record.error || this.transferFailureDetail(cause);
    const protocol = typeof record.protocolErrorCode === "number" ? ` (codice SFTP ${record.protocolErrorCode})` : "";
    const write = this.appendTransferOutcome({
      ...route,
      transferId: record.transferId,
      batchId: record.batchId ?? route.batchId,
      filename: record.filename,
      username: record.username || this.transferLogUsers.get(record) || record.userId,
      outcome,
      details: details + protocol,
      timestamp: record.completedAt,
    });
    this.terminalLogWrites.set(record, write);
    return write;
  }

  private async recordAuditStart(record: TransferRecord): Promise<void> {
    this.assertTransferActive(record);
    await this.auditRepository.record({
      userId: record.userId,
      operation: AuditOperation.TRANSFER_START,
      robotId: record.robotId,
      outcome: "SUCCESS",
      timestamp: record.startedAt,
      details: {
        transferId: record.transferId,
        ...(record.batchId ? { batchId: record.batchId, isBulkStaging: record.isBulkStaging === true } : {}),
        direction: record.direction,
        filename: record.filename,
        sourcePath: record.sourcePath,
        destinationPath: record.destinationPath,
        totalBytes: record.totalBytes,
      },
    });
    this.assertTransferActive(record);
  }

  private async recordAuditSuccess(record: TransferRecord): Promise<void> {
    this.finalizeTransferStats(record);
    await this.persistTransferOutcome(record);

    if (record.userSessionId) {
      try {
        this.sessionManager.touchSession(record.userSessionId);
      } catch {}
    }

    await this.auditRepository.record({
      userId: record.userId,
      operation: AuditOperation.TRANSFER_COMPLETE,
      robotId: record.robotId,
      outcome: "SUCCESS",
      timestamp: record.completedAt || new Date(),
      details: {
        transferId: record.transferId,
        ...(record.batchId ? { batchId: record.batchId, isBulkStaging: record.isBulkStaging === true } : {}),
        direction: record.direction,
        filename: record.filename,
        sourcePath: record.sourcePath,
        destinationPath: record.destinationPath,
        transferredBytes: record.transferredBytes,
        totalBytes: record.totalBytes,
        durationMs: record.durationMs,
        averageSpeedBytesPerSec: record.averageSpeedBytesPerSec,
        checksum: record.computedChecksum,
      },
    });
  }

  private async recordAuditFailure(record: TransferRecord, err: any): Promise<void> {
    this.finalizeTransferStats(record);
    await this.persistTransferOutcome(record, err);
    try {
      const errMsg = record.error || err?.userMessage || err?.message || String(err);
      await this.auditRepository.record({
        userId: record.userId,
        operation: AuditOperation.TRANSFER_FAILURE,
        robotId: record.robotId,
        outcome: "FAILURE",
        timestamp: record.completedAt || new Date(),
        details: {
          transferId: record.transferId,
          batchId: record.batchId,
          direction: record.direction,
          filename: record.filename,
          sourcePath: record.sourcePath,
          destinationPath: record.destinationPath,
          transferredBytes: record.transferredBytes,
          totalBytes: record.totalBytes,
          durationMs: record.durationMs,
          averageSpeedBytesPerSec: record.averageSpeedBytesPerSec,
          error: errMsg,
        },
      });
    } catch {}
  }

  private async recordAuditComplete(record: TransferRecord): Promise<void> {
    try {
      await this.recordAuditSuccess(record);
    } catch (err) {
      // La promozione è già avvenuta. Un errore di audit non rende incompleto il file pubblicato.
      this.logger.error("Audit di completamento bulk non riuscito", String(err), {
        batchId: record.batchId, transferId: record.transferId,
      });
    }
  }

  private async recordSecurityViolation(username: string, robotId: string, reason: string): Promise<void> {
    try {
      await this.auditRepository.record({
        userId: username || "anonymous",
        operation: AuditOperation.SECURITY_AUTHORIZATION_ERROR,
        robotId,
        outcome: "FAILURE",
        timestamp: new Date(),
        details: { reason },
      });
    } catch {}
  }

  /**
   * Registra un trasferimento di staging (browser → server) per un file del
   * caricamento massivo. Serve a rendere visibile nella pagina Gestione
   * Trasferimenti anche la fase di ricezione dal browser, che per file grandi
   * è la più lunga (Problema 1).
   */
  public async registerBulkStagingTransfer(
    context: AuthorizedContext,
    filename: string,
    totalBytes: number | null,
    robotId?: string,
    batchId?: string
  ): Promise<TransferRecord> {
    const safeFilename = this.sanitizeFilename(filename);
    const record = this.buildTransferRecord({
      batchId,
      isBulkStaging: true,
      userId: context.userId,
      username: context.username,
      userSessionId: context.sessionId,
      robotId: robotId || TransferService.GENERAL_SERVER_ID,
      direction: TransferDirection.CLIENT_TO_SERVER,
      filename: safeFilename,
      sourcePath: safeFilename,
      destinationPath: safeFilename,
      totalBytes,
    });
    this.registerTransfer(record);
    this.markTransferActive(record);
    await this.recordAuditStart(record);
    return record;
  }

  public updateBulkStagingTransfer(
    record: TransferRecord,
    transferredBytes: number,
    speedBytesPerSec: number | null,
    etaSeconds: number | null
  ): void {
    record.transferredBytes = transferredBytes;
    record.currentSpeedBytesPerSec = speedBytesPerSec;
    record.speedBytesPerSec = speedBytesPerSec;
    record.etaSeconds = etaSeconds;
    record.lastProgressUpdateAt = Date.now();
    if (record.userSessionId) this.sessionManager.touchSession(record.userSessionId);
  }

  public async completeBulkStagingTransfer(
    record: TransferRecord,
    checksum: string | null,
    totalBytes: number
  ): Promise<void> {
    if (this.isTerminalRecord(record)) return;
    this.assertTransferActive(record);
    record.status = TransferStatus.COMPLETED;
    record.transferredBytes = totalBytes;
    record.totalBytes = totalBytes;
    record.completedAt = new Date();
    record.computedChecksum = checksum || undefined;
    record.integrityLabel = "completato — file ricevuto dal browser e checksum verificato";
    record.integrityVerification = {
      verified: true,
      mode: "stream",
      label: record.integrityLabel,
    };
    await this.recordAuditSuccess(record);
  }

  public async failBulkStagingTransfer(record: TransferRecord, err: any): Promise<void> {
    await this.handleBulkTargetFailure(record, err);
  }

  private validateBulkFilenames(filenames: string[]): void {
    const maxFiles = this.config.maxBulkUploadFiles || 20;
    if (filenames.length > maxFiles) {
      throw new MolirisAppError(
        ErrorCode.INSUFFICIENT_PERMISSIONS,
        `Numero di file selezionati (${filenames.length}) superiore al limite massimo consentito (${maxFiles}).`
      );
    }
    const names = new Set<string>();
    for (const filename of filenames) {
      const name = this.sanitizeFilename(filename).trim();
      if (names.has(name)) {
        throw new MolirisAppError(
          ErrorCode.MISSING_ROBOT_PARAMS,
          "Più sorgenti hanno lo stesso nome di destinazione.",
          "La selezione contiene file con lo stesso nome. Seleziona file con nomi distinti."
        );
      }
      names.add(name);
    }
  }

  private async resolveBulkServerDestination(directory: string | undefined, filename: string, robot?: RobotEntity): Promise<string> {
    // Il selettore usa "/" come radice virtuale dell'archivio, come il file browser.
    // Valida la sintassi originale prima di rimuovere il prefisso virtuale.
    let rawDir = directory?.trim() || "/";
    if (rawDir === "~" || rawDir === "~/") rawDir = "/";
    else if (rawDir.startsWith("~/")) rawDir = rawDir.slice(2).trim() || "/";
    const relativeDir = validateAndNormalizePath(rawDir).replace(/^\/+/, "");
    const resolvePath = (relativePath: string) => robot
      ? this.serverFsService.resolveRobotPath(robot, relativePath)
      : this.serverFsService.resolveGeneralPath(relativePath);
    const destination = await resolvePath(path.posix.join(relativeDir, filename));

    // Il file nuovo non ha ancora un realpath. Verifica il primo antenato
    // esistente, compresi i link simbolici pendenti, prima di creare directory.
    let parent = relativeDir || ".";
    while (parent !== ".") {
      const resolvedParent = await resolvePath(parent);
      try {
        await fs.promises.realpath(resolvedParent);
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        const entry = await fs.promises.lstat(resolvedParent).catch((statError: NodeJS.ErrnoException) => {
          if (statError.code !== "ENOENT") throw statError;
        });
        if (entry?.isSymbolicLink()) {
          throw new MolirisAppError(ErrorCode.SERVER_DIR_INACCESSIBLE, "Collegamento simbolico di destinazione non risolvibile.");
        }
        parent = path.posix.dirname(parent);
      }
    }
    return destination;
  }

  public async ensureBulkTempDirectory(
    root = path.resolve(this.config.serverFilesystemRoot.trim()),
    name = ".tmp_bulk"
  ): Promise<string> {
    const directory = path.join(root, name);
    try {
      await fs.promises.mkdir(directory, { mode: 0o700 });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    const entry = await fs.promises.lstat(directory);
    if (!entry.isDirectory() || (entry.mode & 0o022) !== 0) {
      throw new MolirisAppError(ErrorCode.SERVER_DIR_INACCESSIBLE, `Directory temporanea non sicura: ${directory}`);
    }
    await fs.promises.access(directory, fs.constants.W_OK | fs.constants.X_OK);
    return directory;
  }

  private async handleBulkTargetFailure(record: TransferRecord, err: unknown): Promise<void> {
    if (record.status === TransferStatus.CANCELLED) return;
    try {
      await this.handleTransferFailure(record, err);
    } catch (auditError) {
      this.logger.error("Audit di fallimento bulk non riuscito", String(auditError), {
        batchId: record.batchId, transferId: record.transferId,
      });
    }
  }

  private logBulkTargetFailure(batchId: string, target: BulkTarget, filename: string, err: unknown): void {
    const detail = err as NodeJS.ErrnoException;
    this.logger.error(
      "Destinazione del caricamento massivo non riuscita",
      err instanceof MolirisAppError ? err.diagnosticDetail : detail?.message,
      { batchId, targetType: target.type, robotId: target.robotId, directory: target.directory, filename, code: detail?.code }
    );
  }

  private async removeBulkPart(tempPath: string): Promise<void> {
    try {
      await fs.promises.unlink(tempPath);
    } catch (err) {
      const ioError = err as NodeJS.ErrnoException;
      if (ioError.code !== "ENOENT") {
        this.logger.warn("Pulizia del file temporaneo bulk non riuscita", { path: tempPath, code: ioError.code });
      }
    }
  }

  private async promoteBulkServerFile(record: TransferRecord, tempPath: string, finalPath: string, overwrite: boolean): Promise<void> {
    await fs.promises.mkdir(path.dirname(finalPath), { recursive: true, mode: 0o750 });
    this.beginPromotion(record);
    const mayReplace = overwrite && this.config.transferOverwritePolicy !== "rifiuta";
    if (mayReplace) {
      await fs.promises.rename(tempPath, finalPath);
    } else {
      try {
        // Pubblica atomicamente un file nuovo, anche se un'altra richiesta vince la corsa.
        await fs.promises.link(tempPath, finalPath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        throw new MolirisAppError(
          ErrorCode.SERVER_DIR_INACCESSIBLE,
          `File di destinazione già esistente: ${finalPath}`,
          "File già esistente. Sovrascrittura non autorizzata."
        );
      }
    }
  }

  /**
   * Pre-check preventivo dei conflitti di sovrascrittura per upload massivo multi-target (RF-TRF-009, RF-TRF-011).
   * Verifica le autorizzazioni, il jail dell'operatore e l'esistenza preventiva dei file sulle destinazioni.
   */
  public async checkBulkConflicts(
    context: AuthorizedContext,
    request: BulkPreCheckRequest
  ): Promise<BulkPreCheckResponse> {
    const filenames = request.filenames || [];
    const targets = request.targets || [];

    if (filenames.length === 0 || targets.length === 0) {
      return {
        hasConflicts: false,
        conflicts: [],
        allowedTargetsCount: targets.length,
        totalChecks: 0,
      };
    }

    this.validateBulkFilenames(filenames);

    const conflicts: BulkFileConflict[] = [];
    let totalChecks = 0;

    for (const target of targets) {
      if (target.type === "general") {
        if (!context.permissions.has(AppPermission.FS_SERVER_UPLOAD)) {
          this.recordSecurityViolation(context.username, TransferService.GENERAL_SERVER_ID, `PERMISSION_DENIED_${AppPermission.FS_SERVER_UPLOAD}`);
          throw new MolirisAppError(
            ErrorCode.INSUFFICIENT_PERMISSIONS,
            `Permesso '${AppPermission.FS_SERVER_UPLOAD}' mancante per archivio generale`,
            "Operazione non consentita: autorizzazioni insufficienti per il caricamento nell'archivio generale."
          );
        }
        this.serverFsService.assertOperatorAccess(context, target.directory, "UPLOAD");

        for (const fname of filenames) {
          totalChecks++;
          const safeFilename = this.sanitizeFilename(fname);
          const fullPath = await this.resolveBulkServerDestination(target.directory, safeFilename);

          if (fs.existsSync(fullPath)) {
            try {
              const st = await fs.promises.stat(fullPath);
              conflicts.push({
                filename: fname,
                target,
                destinationPath: fullPath,
                existingSizeBytes: st.size,
                existingModifiedAt: st.mtime,
              });
            } catch {
              conflicts.push({
                filename: fname,
                target,
                destinationPath: fullPath,
              });
            }
          }
        }
        continue;
      }

      const robotId = target.robotId || "";
      const robot = await this.robotRepository.findById(robotId);
      if (!robot) {
        throw new MolirisAppError(
          ErrorCode.MISSING_ROBOT_PARAMS,
          `Robot target '${robotId}' non trovato nell'anagrafica.`
        );
      }

      if (target.type === "server") {
        this.assertAuthorized(context, robot, [AppPermission.FS_SERVER_UPLOAD]);
        this.serverFsService.assertOperatorAccess(context, target.directory, "UPLOAD");

        for (const fname of filenames) {
          totalChecks++;
          const safeFilename = this.sanitizeFilename(fname);
          const fullPath = await this.resolveBulkServerDestination(target.directory, safeFilename, robot);

          if (fs.existsSync(fullPath)) {
            try {
              const st = await fs.promises.stat(fullPath);
              conflicts.push({
                filename: fname,
                target,
                destinationPath: fullPath,
                existingSizeBytes: st.size,
                existingModifiedAt: st.mtime,
              });
            } catch {
              conflicts.push({
                filename: fname,
                target,
                destinationPath: fullPath,
              });
            }
          }
        }
      } else if (target.type === "robot") {
        this.assertRobotAccessible(robot);
        this.assertAuthorized(context, robot, [AppPermission.FS_REMOTE_UPLOAD]);

        const managedConn = await this.connectionManager.acquireConnection(context.username, robot);
        try {
          const sftp = await managedConn.getSftpClient();
          const targetDir = (target.directory ?? "").trim() || ".";

          for (const fname of filenames) {
            totalChecks++;
            const safeFilename = this.sanitizeFilename(fname);
            const remotePath = await this.remoteFsService.resolveAndValidatePath(
              path.posix.join(targetDir, safeFilename),
              context,
              robot,
              sftp
            );

            try {
              const stats = await new Promise<any>((resolve, reject) => {
                sftp.stat(remotePath, (err, res) => (err ? reject(err) : resolve(res)));
              });
              conflicts.push({
                filename: fname,
                target,
                destinationPath: remotePath,
                existingSizeBytes: stats.size,
                existingModifiedAt: stats.mtime ? new Date(stats.mtime * 1000) : undefined,
              });
            } catch (err) {
              if ((err as { code?: number }).code !== 2) {
                throw this.remoteFsService.mapSftpError(err, remotePath, robot.id);
              }
            }
          }
        } finally {
          try {
            await managedConn.close();
          } catch {}
        }
      }
    }

    return {
      hasConflicts: conflicts.length > 0,
      conflicts,
      allowedTargetsCount: targets.length,
      totalChecks,
    };
  }

  /**
   * Assicura che la directory genitore sul robot esista prima di creare il file .part
   * durante un caricamento massivo multi-target (fix Batch 540f0b21 / 203e6760).
   * Richiamato esclusivamente DOPO resolveAndValidatePath (jail Operatore + anti-traversal).
   */
  private async ensureRemoteDirectoryExists(
    sftp: any,
    remoteDir: string,
    robotId: string
  ): Promise<void> {
    const normalized = path.posix.normalize(remoteDir || "/");
    if (!normalized || normalized === "/" || normalized === ".") return;

    const statPath = (p: string): Promise<any | null> =>
      new Promise((resolve) => {
        sftp.stat(p, (err: any, st: any) => resolve(err ? null : st));
      });

    const existing = await statPath(normalized);
    if (existing) {
      const isDir =
        typeof existing.isDirectory === "function"
          ? existing.isDirectory()
          : Boolean(existing.mode && (existing.mode & 0o170000) === 0o040000);
      if (!isDir) {
        throw new MolirisAppError(
          ErrorCode.REMOTE_FS_ERROR,
          `Il percorso di destinazione '${normalized}' sul robot '${robotId}' esiste ma non è una directory.`,
          `Percorso non valido sul robot '${robotId}': '${normalized}' non è una directory.`
        );
      }
      return;
    }

    if (typeof sftp.mkdir !== "function") {
      throw new MolirisAppError(
        ErrorCode.REMOTE_FS_ERROR,
        `Directory remota '${normalized}' non trovata sul robot '${robotId}' e creazione directory SFTP non supportata.`,
        `Directory remota '${normalized}' inesistente sul robot '${robotId}'.`
      );
    }

    const segments = normalized.split("/").filter(Boolean);
    let current = normalized.startsWith("/") ? "" : ".";
    for (const seg of segments) {
      current = current === "" ? `/${seg}` : `${current}/${seg}`;
      const st = await statPath(current);
      if (st) continue;
      await new Promise<void>((resolve, reject) => {
        sftp.mkdir(current, (err: any) => {
          if (!err) return resolve();
          // Verifica se nel frattempo è stata creata (race / codice EEXIST / FAILURE)
          statPath(current).then((retryStat) => {
            if (retryStat) return resolve();
            const mapped = this.remoteFsService.mapSftpError(err, current, robotId);
            reject(
              new MolirisAppError(
                mapped.code,
                `Impossibile creare la directory remota '${current}' sul robot '${robotId}': ${err?.message || err}`,
                `Impossibile creare la directory remota '${current}' sul robot '${robotId}': verificare permessi e percorso.`
              )
            );
          }).catch(() => reject(this.remoteFsService.mapSftpError(err, current, robotId)));
        });
      });
    }
  }

  /**
   * Registra e persiste un TransferRecord fallito anche quando l'errore in un batch massivo
   * si verifica prima dell'avvio dello stream (es. robot inesistente/disabilitato, errore SSH/SFTP,
   * violazione permessi, percorso non valido, file già esistente senza sovrascrittura).
   * Garantisce visibilità al 100% in UI, DB transfers, audit_events e transfers.log.
   */
  private async recordBulkTargetFailure(args: {
    context: AuthorizedContext;
    batchId: string;
    bulkBatch?: BulkTransferTotals;
    logRoute?: TransferLogRoute & Pick<TransferLogEntry, "batchId">;
    filename: string;
    sourcePath: string;
    totalBytes: number;
    target: BulkTarget;
    destinationPath?: string;
    err: any;
  }): Promise<TransferRecord> {
    const safeFilename = this.sanitizeFilename(args.filename);
    const robotId =
      args.target.type === "general"
        ? TransferService.GENERAL_SERVER_ID
        : args.target.robotId || "unknown-robot";
    const direction =
      args.target.type === "robot"
        ? TransferDirection.CLIENT_TO_ROBOT
        : TransferDirection.CLIENT_TO_SERVER;
    const fallbackDest = args.destinationPath
      || (args.target.directory
        ? path.posix.join(args.target.directory, safeFilename)
        : safeFilename);

    const failedRecord = this.buildTransferRecord({
      batchId: args.batchId,
      bulkBatch: args.bulkBatch,
      userId: args.context.userId,
      username: args.context.username,
      userSessionId: args.context.sessionId || "session-system",
      robotId,
      direction,
      filename: safeFilename,
      sourcePath: args.sourcePath,
      destinationPath: fallbackDest,
      totalBytes: args.totalBytes,
    });
    this.registerTransfer(failedRecord);
    if (args.logRoute) {
      this.transferLogRoutes.set(failedRecord, args.logRoute);
    }
    await this.handleTransferFailure(failedRecord, args.err);
    return failedRecord;
  }

  /**
   * Esegue il caricamento massivo multi-target con streaming a memoria costante (< 10 MB RAM)
   * e sostituzione atomica via staging e file temporanei .part (RF-TRF-001..005, RF-TRF-009, RF-TRF-011, RNF-REL-004).
   */
  public async executeBulkUpload(
    context: AuthorizedContext,
    options: {
      targets: BulkTarget[];
      overwrite: boolean;
      batchId?: string;
      logSource?: BulkLogSource;
      stagedFiles: Array<{
        filename: string;
        stagingPath: string;
        sizeBytes: number;
        sha256: string;
        logSourcePath?: string;
      }>;
    }
  ): Promise<BulkUploadResponse> {
    if (this.shuttingDown) throw new MolirisAppError(ErrorCode.TRANSFER_INTERRUPTED, "Servizio in arresto.");
    const { targets, overwrite, stagedFiles } = options;
    const filenames = stagedFiles.map(({ filename }) => filename);
    const batchId = options.batchId || crypto.randomUUID();
    try {
      this.validateBulkFilenames(filenames);
    } catch (err) {
      await this.logBulkPrecheckFailure(context.username, filenames, targets, batchId, err, options.logSource);
      throw err;
    }
    const results: BulkFileResult[] = [];
    let completed = 0;
    let failed = 0;
    let skipped = 0;

    // Integrazione BatchTransferManager (ISS-009, Requisito #9)
    const cancellationLogWrites = new Map<string, Promise<void>>();
    const logUnstartedCancellation = (itemId: string, attempt: TransferLogAttempt) => {
      const existing = cancellationLogWrites.get(itemId);
      if (existing) return existing;
      const write = this.appendTransferOutcome({
        ...attempt, transferId: itemId, username: context.username, outcome: "ANNULLATO",
        details: "Annullato prima dell’avvio con il blocco massivo.",
      });
      cancellationLogWrites.set(itemId, write);
      return write;
    };
    const batchItemsSpec: Array<{
      id: string; filename: string; sizeBytes: number; target: BulkTarget; onCancelQueued: () => Promise<void>;
    }> = [];
    stagedFiles.forEach((staged, sIdx) => {
      targets.forEach((target, tIdx) => {
        const id = `${batchId}_${sIdx}_${tIdx}`;
        batchItemsSpec.push({
          id,
          onCancelQueued: () => logUnstartedCancellation(id,
            this.describeBulkAttempt(staged.filename, target, batchId, options.logSource, staged.logSourcePath)
          ),
          filename: staged.filename,
          sizeBytes: staged.sizeBytes,
          target,
        });
      });
    });
    const bulkBatch = {
      totalItems: batchItemsSpec.length,
      totalBytes: stagedFiles.reduce((sum, item) => sum + item.sizeBytes, 0) * targets.length,
    };
    const batchRecord = this.batchTransferManager?.createBatch({
      batchId,
      userId: context.userId,
      username: context.username,
      files: batchItemsSpec,
    });

    const isItemCancelledByBatch = (itemId: string): boolean => {
      if (!batchRecord) return false;
      const item = batchRecord.items.find((i) => i.id === itemId);
      return batchRecord.status === "CANCELLED" || item?.status === "CANCELLED";
    };

    for (let sIdx = 0; sIdx < stagedFiles.length; sIdx++) {
      const staged = stagedFiles[sIdx];
      const fileTargetResults: BulkUploadTargetResult[] = [];
      let allTargetsSuccess = true;

      for (let tIdx = 0; tIdx < targets.length; tIdx++) {
        const target = targets[tIdx];
        const batchItemId = `${batchId}_${sIdx}_${tIdx}`;
        const logRoute = this.describeBulkAttempt(staged.filename, target, batchId, options.logSource, staged.logSourcePath);
        const logWithoutRecord = (outcome: "FALLIMENTO", details: string) =>
          this.appendTransferOutcome({ ...logRoute, transferId: batchItemId, username: context.username, outcome, details });

        if (isItemCancelledByBatch(batchItemId)) {
          await logUnstartedCancellation(batchItemId, logRoute);
          fileTargetResults.push({
            target,
            success: false,
            destinationPath: "",
            error: "Annullato con il blocco massivo.",
          });
          allTargetsSuccess = false;
          skipped++;
          continue;
        }

        if (target.type === "general") {
          let tempPartPath = "";
          let record: TransferRecord | null = null;
          let resolvedDestForError = "";
          try {
            if (!context.permissions.has(AppPermission.FS_SERVER_UPLOAD)) {
              this.recordSecurityViolation(context.username, TransferService.GENERAL_SERVER_ID, `PERMISSION_DENIED_${AppPermission.FS_SERVER_UPLOAD}`);
              throw new MolirisAppError(
                ErrorCode.INSUFFICIENT_PERMISSIONS,
                `Permesso '${AppPermission.FS_SERVER_UPLOAD}' mancante per archivio generale`,
                "Operazione non consentita: autorizzazioni insufficienti per il caricamento nell'archivio generale."
              );
            }
            this.serverFsService.assertOperatorAccess(context, target.directory, "UPLOAD");

            const safeFilename = this.sanitizeFilename(staged.filename);
            const finalPath = await this.resolveBulkServerDestination(target.directory, safeFilename);
            resolvedDestForError = finalPath;

            if (fs.existsSync(finalPath) && !overwrite) {
              const conflictErr = new MolirisAppError(
                ErrorCode.SERVER_DIR_INACCESSIBLE,
                "File già esistente nell'archivio generale. Sovrascrittura non autorizzata.",
                "File già esistente. Sovrascrittura non autorizzata."
              );
              await this.recordBulkTargetFailure({
                context,
                batchId,
                bulkBatch,
                logRoute,
                filename: staged.filename,
                sourcePath: staged.stagingPath,
                totalBytes: staged.sizeBytes,
                target,
                destinationPath: finalPath,
                err: conflictErr,
              });
              this.batchTransferManager?.setItemFailed(batchId, batchItemId, "File già esistente nell'archivio generale.");
              fileTargetResults.push({
                target,
                success: false,
                destinationPath: finalPath,
                error: "File già esistente. Sovrascrittura non autorizzata.",
              });
              allTargetsSuccess = false;
              skipped++;
              continue;
            }

            const tempDir = await this.ensureBulkTempDirectory();
            const transferId = crypto.randomUUID();
            tempPartPath = path.join(tempDir, `bulk_general_${transferId}.part`);

            const genRecord = this.buildTransferRecord({
              transferId,
              batchId,
              bulkBatch,
              userId: context.userId,
              username: context.username,
              userSessionId: context.sessionId || "session-system",
              robotId: TransferService.GENERAL_SERVER_ID,
              direction: TransferDirection.CLIENT_TO_SERVER,
              filename: safeFilename,
              sourcePath: staged.stagingPath,
              destinationPath: finalPath,
              tempDestinationPath: tempPartPath,
              totalBytes: staged.sizeBytes,
            });
            genRecord.cleanupHandlers.push(() => this.removeBulkPart(tempPartPath));
            record = genRecord;
            this.registerTransfer(genRecord);
            this.transferLogRoutes.set(genRecord, logRoute);
            this.markTransferActive(genRecord);
            await this.recordAuditStart(genRecord);

            this.batchTransferManager?.setItemInProgress(batchId, batchItemId, {
              abortController: genRecord.abortController,
              tempPartPath,
              onCancelCleanup: async () => {
                genRecord.status = TransferStatus.CANCELLED;
                genRecord.completedAt = new Date();
                genRecord.error = "Trasferimento annullato con il blocco massivo.";
                this.finalizeTransferStats(genRecord);
                await this.persistTransferOutcome(genRecord);
                for (const c of genRecord.cleanupHandlers) {
                  try { await c(); } catch {}
                }
              },
            });

            const startPerfMs = genRecord.activeStartedPerfMs ?? performance.now();
            const hash = crypto.createHash("sha256");
            let writtenBytes = 0;
            const readStream = fs.createReadStream(staged.stagingPath);
            const writeStream = fs.createWriteStream(tempPartPath, { mode: 0o600, flags: "wx" });

            readStream.on("data", (chunk: Buffer | string) => {
              const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
              hash.update(buf);
              writtenBytes += buf.length;
              genRecord.transferredBytes = writtenBytes;
              const elapsedSec = Math.max(0.0001, (performance.now() - startPerfMs) / 1000);
              const speed = Math.round(writtenBytes / elapsedSec);
              genRecord.currentSpeedBytesPerSec = speed;
              genRecord.speedBytesPerSec = speed;
              if (genRecord.totalBytes && speed > 0) {
                const remaining = Math.max(0, genRecord.totalBytes - writtenBytes);
                genRecord.etaSeconds = Math.ceil(remaining / speed);
              }
              genRecord.lastProgressUpdateAt = Date.now();
              this.batchTransferManager?.updateItemProgress(batchId, batchItemId, writtenBytes);
            });
            await pipelineWithSignal(readStream, writeStream, { signal: genRecord.abortController.signal });

            const computedHash = hash.digest("hex");
            if (computedHash !== staged.sha256) {
              genRecord.status = TransferStatus.INTEGRITY_FAILED;
              genRecord.error = "Checksum non corrispondente durante il salvataggio nell'archivio generale.";
              genRecord.completedAt = new Date();
              await this.recordAuditFailure(genRecord, new Error(genRecord.error));
              throw new MolirisAppError(ErrorCode.INTEGRITY_CHECK_FAILED, genRecord.error);
            }

            const tempStat = await fs.promises.stat(tempPartPath);
            if (tempStat.size !== writtenBytes || writtenBytes !== staged.sizeBytes) {
              genRecord.status = TransferStatus.INTEGRITY_FAILED;
              genRecord.error = "Dimensione del file temporaneo non corrispondente ai byte ricevuti.";
              genRecord.completedAt = new Date();
              await this.recordAuditFailure(genRecord, new Error(genRecord.error));
              throw new MolirisAppError(ErrorCode.INTEGRITY_CHECK_FAILED, genRecord.error);
            }

            await this.promoteBulkServerFile(genRecord, tempPartPath, finalPath, overwrite);

            genRecord.status = TransferStatus.COMPLETED;
            genRecord.completedAt = new Date();
            genRecord.transferredBytes = writtenBytes;
            genRecord.computedChecksum = computedHash;
            await this.recordAuditComplete(genRecord);
            this.batchTransferManager?.setItemCompleted(batchId, batchItemId);

            fileTargetResults.push({
              target,
              success: true,
              destinationPath: finalPath,
              bytesTransferred: writtenBytes,
              checksum: computedHash,
            });
            completed++;
          } catch (err: any) {
            const errMsg = err instanceof MolirisAppError ? err.userMessage : "Errore durante scrittura nell'archivio generale.";
            if (record) {
              await this.handleBulkTargetFailure(record, err);
            } else {
              await this.recordBulkTargetFailure({
                context,
                batchId,
                bulkBatch,
                logRoute,
                filename: staged.filename,
                sourcePath: staged.stagingPath,
                totalBytes: staged.sizeBytes,
                target,
                destinationPath: resolvedDestForError,
                err,
              });
            }
            this.logBulkTargetFailure(batchId, target, staged.filename, err);
            if (!record || record.status !== TransferStatus.CANCELLED) {
              this.batchTransferManager?.setItemFailed(batchId, batchItemId, errMsg);
            }
            fileTargetResults.push({
              target,
              success: false,
              destinationPath: resolvedDestForError,
              error: errMsg,
            });
            allTargetsSuccess = false;
            failed++;
          } finally {
            if (tempPartPath) await this.removeBulkPart(tempPartPath);
          }
          continue;
        }

        const targetRobotId = target.robotId || "";
        const robot = await this.robotRepository.findById(targetRobotId).catch(async (err) => {
          await logWithoutRecord("FALLIMENTO", "Impossibile consultare l’anagrafica del robot destinatario.");
          throw err;
        });
        if (!robot) {
          const notFoundErr = new MolirisAppError(
            ErrorCode.MISSING_ROBOT_PARAMS,
            `Robot '${targetRobotId}' non trovato.`,
            "Robot destinatario non trovato."
          );
          await this.recordBulkTargetFailure({
            context,
            batchId,
            bulkBatch,
            logRoute,
            filename: staged.filename,
            sourcePath: staged.stagingPath,
            totalBytes: staged.sizeBytes,
            target,
            err: notFoundErr,
          });
          this.batchTransferManager?.setItemFailed(batchId, batchItemId, `Robot '${targetRobotId}' non trovato.`);
          fileTargetResults.push({
            target,
            success: false,
            destinationPath: "",
            error: `Robot '${targetRobotId}' non trovato.`,
          });
          allTargetsSuccess = false;
          failed++;
          continue;
        }

        if (target.type === "server") {
          let tempPartPath = "";
          let record: TransferRecord | null = null;
          let resolvedDestForError = "";
          try {
            this.assertAuthorized(context, robot, [AppPermission.FS_SERVER_UPLOAD]);
            this.serverFsService.assertOperatorAccess(context, target.directory, "UPLOAD");

            const safeFilename = this.sanitizeFilename(staged.filename);
            const finalPath = await this.resolveBulkServerDestination(target.directory, safeFilename, robot);
            resolvedDestForError = finalPath;

            // Verifica esistenza e politica sovrascrittura
            if (fs.existsSync(finalPath) && !overwrite) {
              const conflictErr = new MolirisAppError(
                ErrorCode.SERVER_DIR_INACCESSIBLE,
                "File già esistente sul server robot. Sovrascrittura non autorizzata.",
                "File già esistente. Sovrascrittura non autorizzata."
              );
              await this.recordBulkTargetFailure({
                context,
                batchId,
                bulkBatch,
                logRoute,
                filename: staged.filename,
                sourcePath: staged.stagingPath,
                totalBytes: staged.sizeBytes,
                target,
                destinationPath: finalPath,
                err: conflictErr,
              });
              this.batchTransferManager?.setItemFailed(batchId, batchItemId, "File già esistente. Sovrascrittura non autorizzata.");
              fileTargetResults.push({
                target,
                success: false,
                destinationPath: finalPath,
                error: "File già esistente. Sovrascrittura non autorizzata.",
              });
              allTargetsSuccess = false;
              skipped++;
              continue;
            }

            // Sostituzione atomica: scrittura in file temporaneo .part e rename solo a checksum verificato
            const tempDir = await this.ensureBulkTempDirectory(robot.serverDirectoryPath, ".tmp");
            const transferId = crypto.randomUUID();
            tempPartPath = path.join(tempDir, `bulk_${transferId}.part`);

            const serverRecord = this.buildTransferRecord({
              transferId,
              batchId,
              bulkBatch,
              userId: context.userId,
              username: context.username,
              userSessionId: context.sessionId || "session-system",
              robotId: robot.id,
              direction: TransferDirection.CLIENT_TO_SERVER,
              filename: safeFilename,
              sourcePath: staged.stagingPath,
              destinationPath: finalPath,
              tempDestinationPath: tempPartPath,
              totalBytes: staged.sizeBytes,
            });
            serverRecord.cleanupHandlers.push(() => this.removeBulkPart(tempPartPath));
            record = serverRecord;
            this.registerTransfer(serverRecord);
            this.transferLogRoutes.set(serverRecord, logRoute);
            this.markTransferActive(serverRecord);
            await this.recordAuditStart(serverRecord);

            this.batchTransferManager?.setItemInProgress(batchId, batchItemId, {
              abortController: serverRecord.abortController,
              tempPartPath,
              onCancelCleanup: async () => {
                serverRecord.status = TransferStatus.CANCELLED;
                serverRecord.completedAt = new Date();
                serverRecord.error = "Trasferimento annullato con il blocco massivo.";
                this.finalizeTransferStats(serverRecord);
                await this.persistTransferOutcome(serverRecord);
                for (const c of serverRecord.cleanupHandlers) {
                  try { await c(); } catch {}
                }
              },
            });

            // Stream da staging a tempPartPath con calcolo sha256 e tracciamento in tempo reale
            const startPerfMs = serverRecord.activeStartedPerfMs ?? performance.now();
            const hash = crypto.createHash("sha256");
            let writtenBytes = 0;
            const readStream = fs.createReadStream(staged.stagingPath);
            const writeStream = fs.createWriteStream(tempPartPath, { mode: 0o600, flags: "wx" });

            readStream.on("data", (chunk: Buffer | string) => {
              const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
              hash.update(buf);
              writtenBytes += buf.length;
              serverRecord.transferredBytes = writtenBytes;
              const elapsedSec = Math.max(0.0001, (performance.now() - startPerfMs) / 1000);
              const speed = Math.round(writtenBytes / elapsedSec);
              serverRecord.currentSpeedBytesPerSec = speed;
              serverRecord.speedBytesPerSec = speed;
              if (serverRecord.totalBytes && speed > 0) {
                const remaining = Math.max(0, serverRecord.totalBytes - writtenBytes);
                serverRecord.etaSeconds = Math.ceil(remaining / speed);
              }
              serverRecord.lastProgressUpdateAt = Date.now();
              this.batchTransferManager?.updateItemProgress(batchId, batchItemId, writtenBytes);
            });
            await pipelineWithSignal(readStream, writeStream, {
              signal: serverRecord.abortController.signal,
            });

            const computedHash = hash.digest("hex");
            if (computedHash !== staged.sha256) {
              serverRecord.status = TransferStatus.INTEGRITY_FAILED;
              serverRecord.error = "Checksum non corrispondente durante il salvataggio sul server.";
              serverRecord.completedAt = new Date();
              await this.recordAuditFailure(serverRecord, new Error(serverRecord.error));
              throw new MolirisAppError(
                ErrorCode.INTEGRITY_CHECK_FAILED,
                "Checksum non corrispondente durante il salvataggio sul server."
              );
            }

            // Verifica dimensione su disco prima della promozione (CA-TRF-004)
            const tempStat = await fs.promises.stat(tempPartPath);
            if (tempStat.size !== writtenBytes || writtenBytes !== staged.sizeBytes) {
              serverRecord.status = TransferStatus.INTEGRITY_FAILED;
              serverRecord.error = "Dimensione del file temporaneo non corrispondente ai byte ricevuti.";
              serverRecord.completedAt = new Date();
              await this.recordAuditFailure(serverRecord, new Error(serverRecord.error));
              throw new MolirisAppError(
                ErrorCode.INTEGRITY_CHECK_FAILED,
                `Dimensione su disco (${tempStat.size}) diversa dai byte ricevuti (${writtenBytes})`
              );
            }

            await this.promoteBulkServerFile(serverRecord, tempPartPath, finalPath, overwrite);

            serverRecord.status = TransferStatus.COMPLETED;
            serverRecord.completedAt = new Date();
            serverRecord.transferredBytes = writtenBytes;
            serverRecord.computedChecksum = computedHash;
            await this.recordAuditComplete(serverRecord);
            this.batchTransferManager?.setItemCompleted(batchId, batchItemId);

            fileTargetResults.push({
              target,
              success: true,
              destinationPath: finalPath,
              bytesTransferred: writtenBytes,
              checksum: computedHash,
            });
            completed++;
          } catch (err: any) {
            const errMsg = err instanceof MolirisAppError ? err.userMessage : "Errore durante scrittura su server.";
            if (record) {
              await this.handleBulkTargetFailure(record, err);
            } else {
              await this.recordBulkTargetFailure({
                context,
                batchId,
                bulkBatch,
                logRoute,
                filename: staged.filename,
                sourcePath: staged.stagingPath,
                totalBytes: staged.sizeBytes,
                target,
                destinationPath: resolvedDestForError,
                err,
              });
            }
            this.logBulkTargetFailure(batchId, target, staged.filename, err);
            if (!record || record.status !== TransferStatus.CANCELLED) {
              this.batchTransferManager?.setItemFailed(batchId, batchItemId, errMsg);
            }
            fileTargetResults.push({
              target,
              success: false,
              destinationPath: resolvedDestForError,
              error: errMsg,
            });
            allTargetsSuccess = false;
            failed++;
          } finally {
            if (tempPartPath) await this.removeBulkPart(tempPartPath);
          }
        } else if (target.type === "robot") {
          let managedConn: ManagedRobotConnection | null = null;
          let tempRemotePartPath = "";
          let record: TransferRecord | null = null;
          let resolvedDestForError = "";
          let sftp: Awaited<ReturnType<ManagedRobotConnection["getSftpClient"]>> | undefined;
          let phase = "connessione SSH/SFTP";
          let sourceError: Error | undefined;
          let destinationLock: string | undefined;
          let idleTimer: ReturnType<typeof setTimeout> | undefined;
          let timeoutError: MolirisAppError | undefined;
          const resetIdleTimer = () => {
            const idleTimeoutMs = this.config.transferIdleTimeoutMs;
            if (!idleTimeoutMs || timeoutError) return;
            if (idleTimer) {
              idleTimer.refresh();
              return;
            }
            idleTimer = setTimeout(() => {
              timeoutError = new MolirisAppError(ErrorCode.TIMEOUT_ERROR,
                `Nessuna risposta SFTP durante la fase ${phase} per ${idleTimeoutMs} ms.`,
                phase === "pubblicazione (rename SFTP)"
                  ? "Il robot non ha confermato la pubblicazione. Verifica la destinazione prima di riprovare."
                  : undefined);
              void managedConn?.close().catch(() => {});
            }, idleTimeoutMs);
            idleTimer.unref();
          };
          try {
            this.assertAuthorized(context, robot, [AppPermission.FS_REMOTE_UPLOAD]);

            const safeFilename = this.sanitizeFilename(staged.filename);
            const rawTargetDir = (target.directory ?? "").trim();
            const targetDir = rawTargetDir || ".";
            const isRelativeOrHomeTarget = Boolean(
              rawTargetDir && rawTargetDir !== "." && !rawTargetDir.startsWith("/")
            );
            const targetRecord = this.buildTransferRecord({
              batchId,
              bulkBatch,
              userId: context.userId,
              username: context.username,
              userSessionId: context.sessionId || "session-system",
              robotId: robot.id,
              direction: TransferDirection.CLIENT_TO_ROBOT,
              filename: safeFilename,
              sourcePath: staged.stagingPath,
              destinationPath: path.posix.join(targetDir, safeFilename),
              totalBytes: staged.sizeBytes,
            });
            record = targetRecord;
            this.registerTransfer(targetRecord);
            this.transferLogRoutes.set(targetRecord, logRoute);
            this.markTransferActive(targetRecord);
            await this.recordAuditStart(targetRecord);

            this.batchTransferManager?.setItemInProgress(batchId, batchItemId, {
              abortController: targetRecord.abortController,
              onCancelCleanup: async () => {
                targetRecord.status = TransferStatus.CANCELLED;
                targetRecord.completedAt = new Date();
                targetRecord.error = "Trasferimento annullato con il blocco massivo.";
                this.finalizeTransferStats(targetRecord);
                await this.persistTransferOutcome(targetRecord);
                for (const c of targetRecord.cleanupHandlers) {
                  try { await c(); } catch {}
                }
              },
            });

            this.assertRobotAccessible(robot);
            managedConn = await this.connectionManager.acquireConnection(context.username, robot);
            resetIdleTimer();
            sftp = await managedConn.getSftpClient();
            resetIdleTimer();
            const channel = sftp;
            phase = "verifica cartella di destinazione";
            const finalRemotePath = await this.remoteFsService.resolveAndValidatePath(
              path.posix.join(targetDir, safeFilename),
              context,
              robot,
              sftp
            );
            resolvedDestForError = finalRemotePath;

            // Per percorsi relativi/home (es. TEST o ~/TEST), crea la sottocartella nella home del robot
            // se mancante; i percorsi assoluti richiedono che la cartella esista già.
            if (isRelativeOrHomeTarget) {
              await this.ensureRemoteDirectoryExists(sftp, path.posix.dirname(finalRemotePath), robot.id);
              resetIdleTimer();
            }

            targetRecord.destinationPath = finalRemotePath;
            const directory = path.posix.dirname(finalRemotePath);
            const directoryStat = await new Promise<import("ssh2").Stats>((resolve, reject) => {
              channel.stat(directory, (err, stat) => err ? reject(err) : resolve(stat));
            });
            resetIdleTimer();
            if (!directoryStat.isDirectory()) {
              throw new MolirisAppError(ErrorCode.REMOTE_FS_ERROR,
                "Il percorso di destinazione SFTP non è una directory.",
                "Il percorso selezionato sul robot non è una cartella.");
            }

            phase = "verifica file di destinazione";
            const lockKey = `robot:${robot.id}:${finalRemotePath}`;
            this.acquireDestinationLock(lockKey);
            destinationLock = lockKey;
            const exists = await new Promise<boolean>((resolve, reject) => {
              channel.stat(finalRemotePath, (err) => {
                if (!err) resolve(true);
                else if ((err as { code?: number }).code === 2) resolve(false);
                else reject(err);
              });
            });
            resetIdleTimer();
            if (exists && !overwrite) {
              await this.handleBulkTargetFailure(targetRecord, new MolirisAppError(
                ErrorCode.REMOTE_FS_ERROR, "Conflitto rilevato prima della scrittura SFTP.",
                "File già esistente sul robot. Sovrascrittura non autorizzata."
              ));
              this.batchTransferManager?.setItemFailed(batchId, batchItemId, "File già esistente sul robot.");
              fileTargetResults.push({
                target,
                success: false,
                destinationPath: finalRemotePath,
                error: "File già esistente sul robot. Sovrascrittura non autorizzata.",
              });
              allTargetsSuccess = false;
              skipped++;
              continue;
            }

            // Scrittura atomica remota via .part temporaneo nello stesso filesystem/cartella
            tempRemotePartPath = path.posix.join(directory, `.tmp_moliris_${targetRecord.transferId}.part`);
            targetRecord.tempDestinationPath = tempRemotePartPath;
            phase = "scrittura SFTP";

            const startPerfMs = targetRecord.activeStartedPerfMs ?? performance.now();
            const hash = crypto.createHash("sha256");
            let writtenBytes = 0;
            const readStream = fs.createReadStream(staged.stagingPath);
            readStream.once("error", (err) => { sourceError = err; });
            readStream.on("data", (chunk) => { hash.update(chunk); });
            const remoteWriteStream = new PipelinedSftpWriteStream(channel, tempRemotePartPath, {
              flags: "wx",
              mode: 0o600,
              onWriteAcknowledged: (bytes) => {
                resetIdleTimer();
                writtenBytes += bytes;
                targetRecord.transferredBytes = writtenBytes;
                const elapsedSec = Math.max(0.0001, (performance.now() - startPerfMs) / 1000);
                const speed = Math.round(writtenBytes / elapsedSec);
                targetRecord.currentSpeedBytesPerSec = speed;
                targetRecord.speedBytesPerSec = speed;
                if (targetRecord.totalBytes && speed > 0) {
                  targetRecord.etaSeconds = Math.ceil(Math.max(0, targetRecord.totalBytes - writtenBytes) / speed);
                }
                targetRecord.lastProgressUpdateAt = Date.now();
                this.batchTransferManager?.updateItemProgress(batchId, batchItemId, writtenBytes);
              },
            });
            await pipelineWithSignal(readStream, remoteWriteStream, {
              signal: targetRecord.abortController.signal,
            });

            resetIdleTimer();
            targetRecord.status = TransferStatus.INTEGRITY_CHECKING;
            phase = "verifica checksum";
            const computedHash = hash.digest("hex");
            if (computedHash !== staged.sha256) {
              targetRecord.status = TransferStatus.INTEGRITY_FAILED;
              throw new MolirisAppError(ErrorCode.INTEGRITY_CHECK_FAILED, "Checksum dei dati letti dallo staging diverso da quello atteso.");
            }

            phase = "verifica dimensione remota";
            const remoteTempStat = await new Promise<import("ssh2").Stats>((resolve, reject) => {
              channel.stat(tempRemotePartPath, (err, stat) => err ? reject(err) : resolve(stat));
            });
            resetIdleTimer();
            if (remoteTempStat.size !== writtenBytes || writtenBytes !== staged.sizeBytes) {
              targetRecord.status = TransferStatus.INTEGRITY_FAILED;
              throw new MolirisAppError(ErrorCode.INTEGRITY_CHECK_FAILED,
                `Dimensioni non coerenti: robot=${remoteTempStat.size}, confermati=${writtenBytes}, attesi=${staged.sizeBytes}`);
            }

            if (this.config.transferVerifyMode === "readback") {
              phase = "verifica checksum sul robot";
              const readbackHash = crypto.createHash("sha256");
              // Il lettore SFTP avanza dei byte effettivamente restituiti anche
              // quando il server risponde con blocchi più corti di quelli richiesti.
              const readback = channel.createReadStream(tempRemotePartPath, { highWaterMark: 32768 });
              addAbortSignal(record.abortController.signal, readback);
              for await (const chunk of readback) {
                this.assertTransferActive(record);
                resetIdleTimer();
                readbackHash.update(chunk);
              }
              if (readbackHash.digest("hex") !== computedHash) {
                record.status = TransferStatus.INTEGRITY_FAILED;
                throw new MolirisAppError(ErrorCode.INTEGRITY_CHECK_FAILED, "Checksum readback diverso dallo staging.");
              }
            }

            // Sostituzione atomica e sicura sul robot: se la destinazione esiste,
            // usa posix-rename quando disponibile e non distrugge il file valido
            // in caso di errore (CA-TRF-005).
            phase = "pubblicazione (rename SFTP)";
            resetIdleTimer();
            await this.promoteRemoteTempFile(
              sftp,
              tempRemotePartPath,
              finalRemotePath,
              overwrite === true,
              robot.id,
              record
            );

            clearTimeout(idleTimer);
            tempRemotePartPath = "";
            if (record) {
              record.status = TransferStatus.COMPLETED;
              record.completedAt = new Date();
              record.transferredBytes = writtenBytes;
              record.computedChecksum = computedHash;
              await this.recordAuditComplete(record);
            }
            this.batchTransferManager?.setItemCompleted(batchId, batchItemId);

            fileTargetResults.push({
              target,
              success: true,
              destinationPath: finalRemotePath,
              bytesTransferred: writtenBytes,
              checksum: computedHash,
            });
            completed++;
          } catch (err: any) {
            if (timeoutError) {
              err = timeoutError;
            } else if (err instanceof SftpWriteError) {
              phase = { OPEN: "apertura temporaneo SFTP", WRITE: "scrittura SFTP", CLOSE: "chiusura temporaneo SFTP" }[err.operation];
            } else if (err === sourceError) {
              phase = "lettura staging";
            }
            const missingDirectory = phase === "verifica cartella di destinazione" && err.code === 2;
            const cause = err instanceof MolirisAppError ? err
              : missingDirectory ? new MolirisAppError(ErrorCode.REMOTE_FS_ERROR, err.message,
                "Cartella di destinazione assente sul robot. Seleziona una cartella esistente.")
              : phase === "lettura staging" ? new MolirisAppError(ErrorCode.TRANSFER_INTERRUPTED, err.message,
                "Impossibile leggere il file temporaneo ricevuto dal browser.")
              : this.remoteFsService.mapSftpError(err, record?.destinationPath ?? target.directory ?? "/", robot.id);
            const protocolCode = err.protocolErrorCode ?? (err instanceof MolirisAppError ? undefined : err.code);
            const errMsg = `${phase}: ${cause.userMessage}`;
            this.logger.error("Destinazione SFTP del caricamento massivo non riuscita",
              err instanceof MolirisAppError ? err.diagnosticDetail : err.message, {
                batchId, transferId: record?.transferId, robotId: robot.id, directory: target.directory,
                filename: staged.filename, phase, code: err.code, protocolCode, acknowledgedBytes: record?.transferredBytes ?? 0,
              });
            if (record) {
              record.failurePhase = phase;
              record.protocolErrorCode = protocolCode;
              await this.handleBulkTargetFailure(record, new MolirisAppError(cause.code, cause.diagnosticDetail, errMsg));
            } else {
              await this.recordBulkTargetFailure({
                context,
                batchId,
                bulkBatch,
                logRoute,
                filename: staged.filename,
                sourcePath: staged.stagingPath,
                totalBytes: staged.sizeBytes,
                target,
                destinationPath: resolvedDestForError,
                err: new MolirisAppError(cause.code, cause.diagnosticDetail, errMsg),
              });
            }
            if (record?.status !== TransferStatus.CANCELLED) {
              this.batchTransferManager?.setItemFailed(batchId, batchItemId, errMsg);
            }
            fileTargetResults.push({
              target,
              success: false,
              destinationPath: resolvedDestForError,
              error: errMsg,
            });
            allTargetsSuccess = false;
            failed++;
          } finally {
            clearTimeout(idleTimer);
            try {
              if (tempRemotePartPath) await this.safeUnlinkRobotFile(timeoutError ? null : sftp, robot.id, tempRemotePartPath);
            } finally {
              if (destinationLock !== undefined) this.releaseDestinationLock(destinationLock);
              try {
                await managedConn?.close();
              } catch {}
            }
          }
        }
      }

      results.push({
        filename: staged.filename,
        sizeBytes: staged.sizeBytes,
        targets: fileTargetResults,
        overallSuccess: allTargetsSuccess,
      });
    }

    return {
      // Un file saltato (conflitto sopraggiunto o annullato) non è un successo: il client
      // non deve presentare l'operazione come completata (CA-TRF-003/005).
      success: failed === 0 && skipped === 0,
      batchId,
      totalFiles: stagedFiles.length,
      results,
      summary: {
        completed,
        failed,
        skipped,
      },
    };
  }

  /**
   * Esegue caricamento massivo partendo da file già presenti sul server (Archivio Generale o Server Robot) (§5, §7)
   */
  public async executeBulkServerSource(
    context: AuthorizedContext,
    req: {
      sourceScope: "general" | "server";
      sourceRobotId?: string;
      sourcePaths: string[];
      targets: BulkTarget[];
      overwrite: boolean;
      batchId?: string;
    }
  ): Promise<BulkUploadResponse> {
    const stagedFiles: Array<{
      filename: string;
      stagingPath: string;
      sizeBytes: number;
      sha256: string;
      logSourcePath: string;
    }> = [];

    const batchId = req.batchId || crypto.randomUUID();
    const logSource = { scope: req.sourceScope, robotId: req.sourceRobotId };
    try {
      this.validateBulkFilenames(req.sourcePaths);
      for (const sourceRel of req.sourcePaths) {
        const relativePath = validateAndNormalizePath(sourceRel).replace(/^\/+/, "");
        let resolvedSourcePath: string;
        let sizeBytes: number;
        if (req.sourceScope === "general") {
          ({ totalBytes: sizeBytes } = await this.inspectGeneralDownload(context, relativePath));
          resolvedSourcePath = await this.serverFsService.resolveGeneralPath(relativePath);
        } else {
          if (!req.sourceRobotId) {
            throw new MolirisAppError(ErrorCode.MISSING_ROBOT_PARAMS, "sourceRobotId mancante per sorgente server robot.");
          }
          const robot = await this.robotRepository.findById(req.sourceRobotId)
            ?? await this.robotRepository.findByServerDirectory(req.sourceRobotId);
          if (!robot) {
            throw new MolirisAppError(ErrorCode.MISSING_ROBOT_PARAMS, `Robot sorgente '${req.sourceRobotId}' non trovato.`);
          }
          ({ totalBytes: sizeBytes } = await this.inspectServerDownload(context, robot, relativePath));
          resolvedSourcePath = await this.serverFsService.resolveRobotPath(robot, relativePath);
        }

        const hash = crypto.createHash("sha256");
        const readStream = fs.createReadStream(resolvedSourcePath);
        await new Promise<void>((resolve, reject) => {
          readStream.on("data", (chunk) => hash.update(chunk));
          readStream.on("end", () => resolve());
          readStream.on("error", reject);
        });
        const sha256 = hash.digest("hex");

        stagedFiles.push({
          filename: path.basename(resolvedSourcePath),
          stagingPath: resolvedSourcePath,
          sizeBytes,
          sha256,
          logSourcePath: relativePath,
        });
      }
    } catch (err) {
      await this.logBulkPrecheckFailure(context.username, req.sourcePaths, req.targets, batchId, err, logSource);
      throw err;
    }

    return await this.executeBulkUpload(context, {
      batchId,
      logSource,
      targets: req.targets,
      overwrite: req.overwrite,
      stagedFiles,
    });
  }

  /**
   * Trasferimento Copia o Spostamento da Robot a Robot con stream intermediario costante (§6)
   */
  private describeRobotToRobotAttempt(req: RobotToRobotTransferRequest, targetRobotId: string): TransferLogAttempt {
    const filename = path.posix.basename(req.sourceRemotePath);
    const directory = req.targetRemotePaths?.[targetRobotId] || req.commonTargetDirectory || "/";
    return {
      ...this.describeTransferAttempt(TransferDirection.ROBOT_TO_ROBOT, targetRobotId, filename,
        `SFTP robot ${req.sourceRobotId} · ${req.sourceRemotePath}`,
        `SFTP robot ${targetRobotId} · ${path.posix.join(directory, filename)}`),
      batchId: req.logBatchId,
    };
  }

  public async logRobotToRobotPrecheckFailure(username: string, req: RobotToRobotTransferRequest, err: unknown): Promise<void> {
    for (const robotId of new Set(req.targetRobotIds)) {
      await this.logTransferPrecheckFailure(username, this.describeRobotToRobotAttempt(req, robotId), err);
    }
  }

  public async executeRobotToRobotTransfer(
    context: AuthorizedContext,
    req: RobotToRobotTransferRequest
  ): Promise<RobotToRobotExecutionResult> {
    const { sourceRobotId, sourceRemotePath, targetRobotIds, isMove = false, confirmation = false, overwrite = false } = req;

    const logRequest = { ...req, logBatchId: req.logBatchId || (targetRobotIds?.length > 1 ? crypto.randomUUID() : undefined) };
    if (!sourceRobotId || !sourceRemotePath || !Array.isArray(targetRobotIds) || targetRobotIds.length === 0) {
      throw new MolirisAppError(ErrorCode.MISSING_ROBOT_PARAMS, "Parametri obbligatori mancanti per il trasferimento Robot->Robot.");
    }

    const { sourceRobot, sourceSize, sourceMeta } = await (async () => {
      try {
        const sourceRobot = await this.robotRepository.findById(sourceRobotId);
        if (!sourceRobot) {
          throw new MolirisAppError(ErrorCode.MISSING_ROBOT_PARAMS, `Robot sorgente '${sourceRobotId}' non trovato.`);
        }

        this.assertRobotAccessible(sourceRobot);
        this.assertAuthorized(context, sourceRobot, [AppPermission.FS_REMOTE_DOWNLOAD]);
        if (isMove) {
          this.assertAuthorized(context, sourceRobot, [AppPermission.FS_REMOTE_DELETE]);
        }

        // Verifica esistenza e acquisizione metadati della sorgente remota
        const sourceMeta = await this.remoteFsService.getRemoteFileStats(context, sourceRobot, sourceRemotePath);
        if (sourceMeta.type === "directory") {
          throw new MolirisAppError(ErrorCode.REMOTE_FS_ERROR, "Impossibile trasferire una directory: selezionare singoli file.");
        }
        const sourceSize = typeof sourceMeta.size === "number" ? sourceMeta.size : 0;
        return { sourceRobot, sourceSize, sourceMeta };
      } catch (err) {
        await this.logRobotToRobotPrecheckFailure(context.username, logRequest, err);
        throw err;
      }
    })();

    const filename = path.posix.basename(sourceRemotePath);
    const results: RobotToRobotTargetResult[] = [];
    let allTargetsSucceeded = true;

    for (const targetRobotId of targetRobotIds) {
      const destDir = (req.targetRemotePaths && req.targetRemotePaths[targetRobotId])
        || req.commonTargetDirectory
        || "/";
      const finalDestPath = destDir.endsWith("/") ? `${destDir}${filename}` : `${destDir}/${filename}`;

      const logRoute = this.describeRobotToRobotAttempt(logRequest, targetRobotId);
      const targetRobot = await this.robotRepository.findById(targetRobotId);
      if (!targetRobot) {
        await this.logTransferPrecheckFailure(context.username, logRoute,
          new MolirisAppError(ErrorCode.MISSING_ROBOT_PARAMS, "Robot destinatario non trovato.", "Robot destinatario non trovato."));
        results.push({
          robotId: targetRobotId,
          destinationPath: finalDestPath,
          success: false,
          error: `Robot destinatario '${targetRobotId}' non trovato.`,
        });
        allTargetsSucceeded = false;
        continue;
      }

      if (targetRobot.anagraphicState === "disabilitato" || targetRobot.anagraphicState === "rimosso") {
        await this.logTransferPrecheckFailure(context.username, logRoute,
          new MolirisAppError(ErrorCode.INSUFFICIENT_PERMISSIONS, "Robot destinatario non attivo.", "Robot destinatario non attivo."));
        results.push({
          robotId: targetRobotId,
          destinationPath: finalDestPath,
          success: false,
          error: `Robot destinatario non attivo (${targetRobot.anagraphicState}).`,
        });
        allTargetsSucceeded = false;
        continue;
      }

      let readHandle: any = null;
      let targetManagedConn: ManagedRobotConnection | null = null;
      let targetSftp: any = null;
      let writeStream: any = null;
      let tempDestPath = "";
      const transferId = crypto.randomUUID();
      const destLockKey = `robot:${targetRobot.id}:${finalDestPath}`;

      const targetRecord = this.buildTransferRecord({
        transferId,
        userId: context.userId,
        username: context.username,
        userSessionId: context.sessionId,
        robotId: targetRobot.id,
        direction: TransferDirection.ROBOT_TO_ROBOT,
        filename,
        sourcePath: `robot:${sourceRobot.id}:${sourceRemotePath}`,
        destinationPath: `robot:${targetRobot.id}:${finalDestPath}`,
        totalBytes: sourceSize,
      });
      this.registerTransfer(targetRecord);
      this.transferLogRoutes.set(targetRecord, logRoute);

      let lockAcquired = false;
      try {
        if (
          sourceRobot.id === targetRobot.id &&
          path.posix.normalize(sourceRemotePath) === path.posix.normalize(finalDestPath)
        ) {
          throw new MolirisAppError(
            ErrorCode.REMOTE_FS_ERROR,
            "Sorgente e destinazione coincidono: operazione rifiutata per evitare la distruzione del file.",
            "Sorgente e destinazione coincidono: scegliere un percorso di destinazione diverso."
          );
        }

        this.assertAuthorized(context, targetRobot, [AppPermission.FS_REMOTE_UPLOAD]);
        this.acquireDestinationLock(destLockKey);
        lockAcquired = true;
        this.markTransferActive(targetRecord);

        // Connessione dedicata al robot destinatario, riusata per scrittura,
        // verifica di dimensione e promozione atomica (CA-TRF-005).
        targetManagedConn = await this.connectionManager.acquireConnection(context.username, targetRobot);
        targetSftp = await targetManagedConn.getSftpClient();

        // Validazione del percorso finale (jail operatore, traversal, symlink) e supporto percorsi relativi/home (~).
        const resolvedDestPath = await this.remoteFsService.resolveAndValidatePath(
          finalDestPath,
          context,
          targetRobot,
          targetSftp
        );
        await this.ensureRemoteDirectoryExists(targetSftp, path.posix.dirname(resolvedDestPath), targetRobot.id);

        // Verifica esistenza su target se overwrite non abilitato
        if (!overwrite) {
          const targetExists = await new Promise<boolean>((resolve) => {
            targetSftp.stat(resolvedDestPath, (err: any) => resolve(!err));
          });
          if (targetExists) {
            throw new MolirisAppError(
              ErrorCode.REMOTE_FS_ERROR,
              `File già esistente sulla destinazione: ${resolvedDestPath}`,
              "File già esistente sulla destinazione. Sovrascrittura non autorizzata."
            );
          }
        }

        tempDestPath = path.posix.join(
          path.posix.dirname(resolvedDestPath),
          `.tmp_moliris_${transferId}.tmp`
        );
        targetRecord.destinationPath = `robot:${targetRobot.id}:${resolvedDestPath}`;
        targetRecord.tempDestinationPath = tempDestPath;

        readHandle = await this.remoteFsService.openRemoteReadStream(context, sourceRobot, sourceRemotePath);
        writeStream = new PipelinedSftpWriteStream(targetSftp, tempDestPath, {
          flags: "w",
          concurrency: 32,
          chunkSize: 32768,
          highWaterMark: this.getChunkSize(),
        });

        targetRecord.cleanupHandlers.push(async () => {
          try { readHandle?.stream?.destroy(); } catch {}
          try { writeStream?.destroy(); } catch {}
          if (targetSftp && tempDestPath) {
            try {
              await new Promise<void>((resolve) => targetSftp.unlink(tempDestPath, () => resolve()));
            } catch {}
          }
        });

        await this.recordAuditStart(targetRecord);

        // Stream con tracking e checksum
        await this.streamWithTrackingAndChecksum(readHandle.stream, writeStream, targetRecord);

        await readHandle.cleanup();
        readHandle = null;

        // Verifica dimensione sul robot destinatario prima della promozione.
        const remoteStat = await new Promise<any>((resolve, reject) => {
          targetSftp.stat(tempDestPath, (err: any, st: any) => {
            if (err) return reject(this.remoteFsService.mapSftpError(err, tempDestPath, targetRobot.id));
            resolve(st);
          });
        });
        if (remoteStat.size !== targetRecord.transferredBytes) {
          targetRecord.status = TransferStatus.INTEGRITY_FAILED;
          throw new MolirisAppError(
            ErrorCode.INTEGRITY_CHECK_FAILED,
            `Dimensione sul robot destinatario (${remoteStat.size}) diversa dai byte trasferiti (${targetRecord.transferredBytes})`,
            "Verifica di integrità del file trasferito fallita."
          );
        }

        // Promozione atomica: la destinazione finale non viene mai troncata
        // prima che il file temporaneo sia completo e verificato.
        await this.promoteRemoteTempFile(
          targetSftp,
          tempDestPath,
          resolvedDestPath,
          overwrite,
          targetRobot.id,
          targetRecord
        );
        writeStream = null;

        targetRecord.integrityLabel = "completato — dimensione verificata sul robot destinatario";
        targetRecord.integrityVerification = {
          verified: true,
          mode: "stream",
          label: targetRecord.integrityLabel,
        };
        targetRecord.status = TransferStatus.COMPLETED;
        targetRecord.completedAt = new Date();
        await this.recordAuditSuccess(targetRecord);

        results.push({
          robotId: targetRobotId,
          transferId,
          destinationPath: finalDestPath,
          success: true,
        });
      } catch (err: any) {
        await this.handleTransferFailure(targetRecord, err);
        if (readHandle) {
          try { await readHandle.cleanup(); } catch {}
          readHandle = null;
        }
        if (writeStream) {
          try { writeStream.destroy(); } catch {}
          writeStream = null;
        }
        results.push({
          robotId: targetRobotId,
          transferId,
          destinationPath: finalDestPath,
          success: false,
          error: err?.userMessage || targetRecord.error || "Errore durante il trasferimento.",
        });
        allTargetsSucceeded = false;
      } finally {
        if (targetManagedConn) {
          try { await targetManagedConn.close(); } catch {}
        }
        if (lockAcquired) this.releaseDestinationLock(destLockKey);
      }
    }

    let sourceDeleted = false;
    let sourceDeleteError: string | undefined;

    if (isMove) {
      if (!allTargetsSucceeded) {
        sourceDeleteError = "Cancellazione sorgente annullata: uno o più trasferimenti verso i destinatari sono falliti.";
      } else if (!confirmation) {
        sourceDeleteError = "Cancellazione sorgente annullata: conferma esplicita dell'utente mancante.";
      } else {
        try {
          // Ricontrolla che la sorgente non sia stata modificata durante il trasferimento
          const currentMeta = await this.remoteFsService.getRemoteFileStats(context, sourceRobot, sourceRemotePath);
          if (currentMeta.size !== sourceMeta.size || (sourceMeta.modifiedAt && currentMeta.modifiedAt && currentMeta.modifiedAt !== sourceMeta.modifiedAt)) {
            sourceDeleteError = "Cancellazione sorgente annullata: il file sorgente è stato modificato durante il trasferimento.";
          } else {
            this.assertActiveSession(context.sessionId);
            await this.remoteFsService.deleteRemoteFile(context, sourceRobot, sourceRemotePath);
            sourceDeleted = true;
          }
        } catch (delErr: any) {
          sourceDeleteError = `Impossibile cancellare il file sorgente: ${delErr.message || delErr}`;
        }
      }
    }

    return {
      sourceRobotId,
      sourceRemotePath,
      isMove,
      allTargetsSucceeded,
      sourceDeleted: isMove ? sourceDeleted : undefined,
      sourceDeleteError,
      results,
    };
  }
}
