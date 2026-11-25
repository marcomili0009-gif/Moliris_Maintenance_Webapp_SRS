// Requisiti soddisfatti: RF-TRF-001, RF-TRF-002, RF-TRF-003, RF-TRF-004, RF-TRF-005,
// RF-TRF-006, RF-TRF-007, RF-TRF-008, RF-TRF-009, RF-TRF-010, RF-TRF-011, RF-TRF-012,
// RF-TRF-013, RF-TRF-014, RNF-SEC-002, RNF-SEC-004, RNF-SEC-005, RNF-SEC-007, RNF-SEC-008,
// RNF-SEC-009, RNF-PERF-001, RNF-PERF-002, RNF-PERF-003, RNF-REL-001, RNF-REL-004, RNF-REL-005,
// SRS §1.2, §2.4, §5.5, §6.5, §6.6, §6.7, §9, §10.3, §10.4, §11.1, §11.5, §11.7, CA-FS-002..004, CA-TRF-001..007

import crypto from "crypto";
import fs from "fs";
import path from "path";
import { PassThrough, pipeline, type Readable, type Writable } from "stream";
import { pipeline as pipelineWithSignal } from "node:stream/promises";
import { type SystemConfiguration } from "../../config/configuration.ts";
import { type RobotEntity } from "../../storage/robot-models.ts";
import { type RobotRepository } from "../../storage/robot-repository.ts";
import { type ServerFilesystemService } from "../../storage/server-fs.ts";
import { type RemoteFilesystemService } from "../remote-fs/remote-fs-service.ts";
import { type RobotConnectionManager, type ManagedRobotConnection } from "../connection/robot-connection-manager.ts";
import { type SessionManager, type AuthorizedContext } from "../auth/session-manager.ts";
import { AppPermission, type RolePermissionMapping, DEFAULT_ROLE_PERMISSIONS } from "../auth/permissions.ts";
import { type AuditRepository } from "../../storage/audit-repository.ts";
import { AuditOperation } from "../../storage/audit-models.ts";
import { MolirisLogger, redactSensitiveData } from "../../logging/logger.ts";
import { MolirisAppError, ErrorCode } from "../../errors/app-errors.ts";
import {
  TransferDirection,
  TransferStatus,
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
import { PipelinedSftpReadStream, PipelinedSftpWriteStream } from "../remote-fs/remote-fs-service.ts";
import { type PhysicalFileLogger } from "../logging/physical-file-logger.ts";
import {
  type BulkTarget,
  type BulkFileConflict,
  type BulkPreCheckRequest,
  type BulkPreCheckResponse,
  type BulkUploadTargetResult,
  type BulkFileResult,
  type BulkUploadResponse,
} from "./bulk-transfer-models.ts";

export class TransferService {
  private config: SystemConfiguration;
  private robotRepository: RobotRepository;
  private serverFsService: ServerFilesystemService;
  private remoteFsService: RemoteFilesystemService;
  private connectionManager: RobotConnectionManager;
  private sessionManager: SessionManager;
  private auditRepository: AuditRepository;
  private roleMapping: RolePermissionMapping;
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

  public setPhysicalFileLogger(logger: PhysicalFileLogger): void {
    this.physicalFileLogger = logger;
  }

  constructor(
    config: SystemConfiguration,
    robotRepository: RobotRepository,
    serverFsService: ServerFilesystemService,
    remoteFsService: RemoteFilesystemService,
    sessionManager: SessionManager,
    auditRepository: AuditRepository,
    logger: MolirisLogger,
    roleMapping: RolePermissionMapping = DEFAULT_ROLE_PERMISSIONS,
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
    this.roleMapping = roleMapping;
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
    setTimeout(() => {
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
    if (this.recordEvictionTimer) {
      clearInterval(this.recordEvictionTimer);
      this.recordEvictionTimer = null;
    }
    if (this.hourlyCleanupTimer) {
      clearInterval(this.hourlyCleanupTimer);
      this.hourlyCleanupTimer = null;
    }
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
    userId: string;
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
      userId: args.userId,
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
      etaSeconds: null,
      status: TransferStatus.QUEUED,
      error: null,
      expectedChecksum: args.expectedChecksum,
      checksumAlgorithm: args.checksumAlgorithm || this.checksumAlgorithm.name,
      startedAt: new Date(),
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
    this.assertActiveSession(record.userSessionId);
    this.transfers.set(record.transferId, record);
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

    const destLockKey = `server:${robot.id}:${targetRelative}`;
    let slotAcquired = false;
    let lockAcquired = false;
    try {
      await this.acquireTransferSlot(context.userId, robot.id, record.abortController.signal);
      slotAcquired = true;
      this.assertTransferActive(record);
      record.status = TransferStatus.IN_PROGRESS;
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
      await cleanupSource();
      releaseOnce();
    };

    const finishFailure = async (err: any) => {
      if (settled) return;
      settled = true;
      removeAbortListener();
      await this.handleTransferFailure(record, err);
      await cleanupSource();
      releaseOnce();
    };

    pipeline(sourceStream, progressTracker, checksumStream, outStream, (err) => {
      if (err) {
        void finishFailure(err);
      } else {
        void finishSuccess();
      }
    });

    // Il consumo completo dello stream da parte del client è il segnale più
    // affidabile di successo; 'close' può arrivare subito dopo 'end'.
    outStream.once("end", () => {
      void finishSuccess();
    });

    outStream.once("close", () => {
      if (!settled && !outStream.readableEnded) {
        void finishFailure(
          new MolirisAppError(
            ErrorCode.TRANSFER_INTERRUPTED,
            "Download interrotto prima del completamento (client disconnesso)."
          )
        );
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
      userSessionId: context.sessionId,
      robotId: robot.id,
      direction: TransferDirection.SERVER_TO_CLIENT,
      filename,
      sourcePath: relativeFilePath,
      destinationPath: filename,
      totalBytes: stat.size,
    });
    this.registerTransfer(record);

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
      record.status = TransferStatus.IN_PROGRESS;
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
    this.assertRobotAccessible(robot);

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
    this.markAccepted(record, req);

    const destLockKey = `robot:${robot.id}:${req.remotePath}`;
    let slotAcquired = false;
    let lockAcquired = false;
    let managedConn: ManagedRobotConnection | null = null;
    try {
      await this.acquireTransferSlot(context.userId, robot.id, record.abortController.signal);
      slotAcquired = true;
      this.assertTransferActive(record);
      record.status = TransferStatus.IN_PROGRESS;
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
    this.markAccepted(record, req);

    const destLockKey = `server:${robot.id}:${targetServerRelative}`;
    let slotAcquired = false;
    let lockAcquired = false;
    let remoteReadHandle: Awaited<ReturnType<RemoteFilesystemService["openRemoteReadStream"]>> | null = null;
    try {
      await this.acquireTransferSlot(context.userId, robot.id, record.abortController.signal);
      slotAcquired = true;
      this.assertTransferActive(record);
      record.status = TransferStatus.IN_PROGRESS;
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

    const destLockKey = `robot:${robot.id}:${displayDirectory}/${safeFilename}`;
    let slotAcquired = false;
    let lockAcquired = false;
    let managedConn: ManagedRobotConnection | null = null;
    try {
      await this.acquireTransferSlot(context.userId, robot.id, record.abortController.signal);
      slotAcquired = true;
      this.assertTransferActive(record);
      record.status = TransferStatus.IN_PROGRESS;
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
      userSessionId: context.sessionId,
      robotId: robot.id,
      direction: TransferDirection.ROBOT_TO_CLIENT,
      filename,
      sourcePath: remoteFilePath,
      destinationPath: filename,
      totalBytes: stats.size,
    });
    this.registerTransfer(record);

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
      record.status = TransferStatus.IN_PROGRESS;
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

    await fs.promises.mkdir(path.dirname(finalPath), { recursive: true, mode: 0o750 });
    const tempFilePath = path.join(
      path.dirname(finalPath),
      `.tmp_moliris_${record.transferId}.tmp`
    );
    record.tempDestinationPath = tempFilePath;
    const destLockKey = `general:${safeRelative}`;
    let slotAcquired = false;
    let lockAcquired = false;

    try {
      await this.acquireTransferSlot(context.userId, TransferService.GENERAL_SERVER_ID, record.abortController.signal);
      slotAcquired = true;
      this.assertTransferActive(record);
      record.status = TransferStatus.IN_PROGRESS;
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
      await fs.promises.mkdir(path.dirname(finalPath), { recursive: true, mode: 0o750 });
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
      userSessionId: context.sessionId,
      robotId: TransferService.GENERAL_SERVER_ID,
      direction: TransferDirection.SERVER_TO_CLIENT,
      filename,
      sourcePath: relativeFilePath,
      destinationPath: filename,
      totalBytes: stat.size,
    });
    this.registerTransfer(record);

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
      record.status = TransferStatus.IN_PROGRESS;
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

    await pipelineWithSignal(sourceStream, progressTracker, checksumStream, destStream, {
      signal: record.abortController.signal,
    });
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
    record.error = reason === "SESSION_TERMINATED_EXPIRED"
      ? "Trasferimento interrotto perché la sessione è scaduta."
      : "Trasferimento annullato dall'utente.";
    record.integrityLabel = "integrità non verificata";
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

    await this.auditRepository.record({
      userId: record.userId,
      operation: AuditOperation.TRANSFER_FAILURE,
      robotId: record.robotId,
      outcome: "FAILURE",
      timestamp: new Date(),
      details: {
        transferId: record.transferId,
        direction: record.direction,
        filename: record.filename,
        cancelled: true,
        reason,
      },
    });

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
  }

  /**
   * Annulla tutti i trasferimenti attivi associati a un utente (es. a chiusura/scadenza sessione).
   */
  public cancelTransfersForUser(userId: string, reason: string): void {
    for (const record of Array.from(this.transfers.values())) {
      if (record.userId === userId && !TransferService.TERMINAL_STATUSES.has(record.status)) {
        this.cancelTransfer(record.transferId, userId, reason).catch(() => {});
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
        this.cancelTransfer(record.transferId, userId, reason).catch(() => {});
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

    // Esecuzione pulizia dei file temporanei (RF-TRF-009, RNF-REL-005)
    for (const cleanup of record.cleanupHandlers) {
      try { await cleanup(); } catch {}
    }

    this.logger.error("Fallimento trasferimento file", err?.message || safeUserMsg, {
      transferId: record.transferId,
      direction: record.direction,
      robotId: record.robotId,
      errorCode,
    });

    await this.auditRepository.record({
      userId: record.userId,
      operation: AuditOperation.TRANSFER_FAILURE,
      robotId: record.robotId,
      outcome: "FAILURE",
      timestamp: new Date(),
      details: {
        transferId: record.transferId,
        direction: record.direction,
        filename: record.filename,
        sourcePath: record.sourcePath,
        destinationPath: record.destinationPath,
        errorCode,
        cancelled: false,
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
    const isAdmin = Array.isArray(context.roles) && context.roles.some((r) => r.toLowerCase() === "admin" || r.toLowerCase() === "amministratore");
    for (const record of this.transfers.values()) {
      if (robotId && record.robotId !== robotId) continue;
      if (isAdmin || record.userId === context.userId || context.targetRobotId === record.robotId || !context.targetRobotId) {
        list.push(record);
      }
    }
    return list.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
      .map((record) => this.toDto(record));
  }

  private toDto(record: TransferRecord): TransferDto {
    let percent: number | null = null;
    if (record.totalBytes && record.totalBytes > 0) {
      percent = Math.min(100, Math.round((record.transferredBytes / record.totalBytes) * 10000) / 100);
    }

    return {
      transferId: record.transferId,
      userId: record.userId,
      robotId: record.robotId,
      direction: record.direction,
      filename: record.filename,
      sourcePath: record.sourcePath,
      destinationPath: record.destinationPath,
      totalBytes: record.totalBytes,
      transferredBytes: record.transferredBytes,
      percent,
      speedBytesPerSec: record.speedBytesPerSec,
      etaSeconds: record.etaSeconds,
      status: record.status,
      error: record.error,
      checksum: record.computedChecksum || null,
      checksumAlgorithm: record.checksumAlgorithm || null,
      integrityLabel: record.integrityLabel || (record.status === TransferStatus.COMPLETED ? "completato" : "integrità non verificata"),
      integrityVerification: record.integrityVerification,
      startedAt: record.startedAt.toISOString(),
      completedAt: record.completedAt ? record.completedAt.toISOString() : null,
      sourceFile: record.filename || record.sourcePath,
      targetFile: record.destinationPath ? path.basename(record.destinationPath) : record.filename,
      percentage: percent ?? 0,
      speedBps: record.speedBytesPerSec || 0,
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
    // Controllo anti-corsa TOCTOU su destinazione finale subito prima della promozione
    const exists = await new Promise<boolean>((resolve) => {
      sftpClient.stat(finalPath, (err: any) => resolve(!err));
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
            if (err) return reject(this.remoteFsService.mapSftpError(err, finalPath, robotId));
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
              if (err) return reject(this.remoteFsService.mapSftpError(err, finalPath, robotId));
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
          if (err) return reject(this.remoteFsService.mapSftpError(err, finalPath, robotId));
          resolve();
        });
      });
    }
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
        direction: record.direction,
        filename: record.filename,
        sourcePath: record.sourcePath,
        destinationPath: record.destinationPath,
        transferredBytes: record.transferredBytes,
        checksum: record.computedChecksum,
      },
    });

    if (this.physicalFileLogger) {
      try {
        await this.physicalFileLogger.logTransfer({
          filename: record.filename,
          username: record.userId,
          direction: record.direction,
          outcome: "SUCCESSO",
          details: `Completato (${record.transferredBytes} byte, checksum: ${record.computedChecksum || "N/A"})`,
          timestamp: record.completedAt || new Date(),
        });
      } catch {}
    }
  }

  private async recordAuditFailure(record: TransferRecord, err: any): Promise<void> {
    try {
      await this.auditRepository.record({
        userId: record.userId,
        operation: AuditOperation.TRANSFER_FAILURE,
        robotId: record.robotId,
        outcome: "FAILURE",
        timestamp: record.completedAt || new Date(),
        details: {
          transferId: record.transferId,
          direction: record.direction,
          filename: record.filename,
          error: record.error || err?.message || String(err),
        },
      });

      if (this.physicalFileLogger) {
        try {
          await this.physicalFileLogger.logTransfer({
            filename: record.filename,
            username: record.userId,
            direction: record.direction,
            outcome: "FALLIMENTO",
            details: record.error || err?.message || String(err),
            timestamp: record.completedAt || new Date(),
          });
        } catch {}
      }
    } catch {}
  }

  private async recordAuditComplete(record: TransferRecord): Promise<void> {
    await this.recordAuditSuccess(record);
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
    robotId?: string
  ): Promise<TransferRecord> {
    const safeFilename = this.sanitizeFilename(filename);
    const record = this.buildTransferRecord({
      userId: context.userId,
      userSessionId: context.sessionId,
      robotId: robotId || TransferService.GENERAL_SERVER_ID,
      direction: TransferDirection.CLIENT_TO_SERVER,
      filename: safeFilename,
      sourcePath: safeFilename,
      destinationPath: safeFilename,
      totalBytes,
    });
    record.status = TransferStatus.IN_PROGRESS;
    this.registerTransfer(record);
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
    record.speedBytesPerSec = speedBytesPerSec;
    record.etaSeconds = etaSeconds;
    record.lastProgressUpdateAt = Date.now();
    if (record.userSessionId) this.sessionManager.touchSession(record.userSessionId);
  }

  public async completeBulkStagingTransfer(
    record: TransferRecord,
    checksum: string | null
  ): Promise<void> {
    if (this.isTerminalRecord(record)) return;
    this.assertTransferActive(record);
    record.status = TransferStatus.COMPLETED;
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
    await this.handleTransferFailure(record, err);
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

    const maxFiles = this.config.maxBulkUploadFiles || 20;
    if (filenames.length > maxFiles) {
      throw new MolirisAppError(
        ErrorCode.INSUFFICIENT_PERMISSIONS,
        `Numero di file selezionati (${filenames.length}) superiore al limite massimo consentito (${maxFiles}).`
      );
    }

    const conflicts: BulkFileConflict[] = [];
    let totalChecks = 0;

    for (const target of targets) {
      const robot = await this.robotRepository.findById(target.robotId);
      if (!robot) {
        throw new MolirisAppError(
          ErrorCode.MISSING_ROBOT_PARAMS,
          `Robot target '${target.robotId}' non trovato nell'anagrafica.`
        );
      }

      if (target.type === "server") {
        this.assertAuthorized(context, robot, [AppPermission.FS_SERVER_UPLOAD]);
        this.serverFsService.assertOperatorAccess(context, target.directory, "UPLOAD");

        for (const fname of filenames) {
          totalChecks++;
          const safeFilename = this.sanitizeFilename(fname);
          const relPath = target.directory
            ? path.posix.join(path.posix.normalize(target.directory), safeFilename)
            : safeFilename;
          const fullPath = await this.serverFsService.resolveRobotPath(robot, relPath);

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
          const targetDir = target.directory || "/";

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
            } catch {
              // File non presente, nessun conflitto
            }
          }
        } finally {
          // Connessione gestita dal connection pool (RobotConnectionManager)
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
   * Esegue il caricamento massivo multi-target con streaming a memoria costante (< 10 MB RAM)
   * e sostituzione atomica via staging e file temporanei .part (RF-TRF-001..005, RF-TRF-009, RF-TRF-011, RNF-REL-004).
   */
  public async executeBulkUpload(
    context: AuthorizedContext,
    options: {
      targets: BulkTarget[];
      overwrite: boolean;
      stagedFiles: Array<{
        filename: string;
        stagingPath: string;
        sizeBytes: number;
        sha256: string;
      }>;
    }
  ): Promise<BulkUploadResponse> {
    const { targets, overwrite, stagedFiles } = options;
    const results: BulkFileResult[] = [];
    let completed = 0;
    let failed = 0;
    let skipped = 0;

    for (const staged of stagedFiles) {
      const fileTargetResults: BulkUploadTargetResult[] = [];
      let allTargetsSuccess = true;

      for (const target of targets) {
        const robot = await this.robotRepository.findById(target.robotId);
        if (!robot) {
          fileTargetResults.push({
            target,
            success: false,
            destinationPath: "",
            error: `Robot '${target.robotId}' non trovato.`,
          });
          allTargetsSuccess = false;
          failed++;
          continue;
        }

        if (target.type === "server") {
          try {
            this.assertAuthorized(context, robot, [AppPermission.FS_SERVER_UPLOAD]);
            this.serverFsService.assertOperatorAccess(context, target.directory, "UPLOAD");

            const safeFilename = this.sanitizeFilename(staged.filename);
            const relPath = target.directory
              ? path.posix.join(path.posix.normalize(target.directory), safeFilename)
              : safeFilename;
            const finalPath = await this.serverFsService.resolveRobotPath(robot, relPath);

            // Verifica esistenza e politica sovrascrittura
            if (fs.existsSync(finalPath) && !overwrite) {
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
            const tempDir = await this.serverFsService.ensureTempDirectory(robot);
            const transferId = crypto.randomUUID();
            const tempPartPath = path.join(tempDir, `bulk_${transferId}.part`);

            const startTime = Date.now();
            const record: TransferRecord = {
              transferId,
              userId: context.userId,
              userSessionId: context.sessionId || "session-system",
              robotId: robot.id,
              direction: TransferDirection.CLIENT_TO_SERVER,
              sourcePath: staged.stagingPath,
              destinationPath: finalPath,
              tempDestinationPath: tempPartPath,
              filename: safeFilename,
              totalBytes: staged.sizeBytes,
              transferredBytes: 0,
              status: TransferStatus.IN_PROGRESS,
              speedBytesPerSec: 0,
              etaSeconds: null,
              startedAt: new Date(),
              completedAt: undefined,
              error: null,
              checksumAlgorithm: this.checksumAlgorithm.name,
              lastProgressUpdateAt: startTime,
              lastBytesAtUpdate: 0,
              abortController: new AbortController(),
              cleanupHandlers: [
                async () => {
                  try { if (fs.existsSync(tempPartPath)) await fs.promises.unlink(tempPartPath); } catch {}
                },
              ],
            };
            this.registerTransfer(record);
            await this.recordAuditStart(record);

            // Stream da staging a tempPartPath con calcolo sha256 e tracciamento in tempo reale
            const hash = crypto.createHash("sha256");
            let writtenBytes = 0;
            const readStream = fs.createReadStream(staged.stagingPath);
            const writeStream = fs.createWriteStream(tempPartPath, { mode: 0o600 });

            readStream.on("data", (chunk: Buffer | string) => {
              const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
              hash.update(buf);
              writtenBytes += buf.length;
              record.transferredBytes = writtenBytes;
              const elapsedSec = Math.max(0.001, (Date.now() - startTime) / 1000);
              record.speedBytesPerSec = Math.round(writtenBytes / elapsedSec);
              if (record.totalBytes && record.speedBytesPerSec > 0) {
                const remaining = Math.max(0, record.totalBytes - writtenBytes);
                record.etaSeconds = Math.ceil(remaining / record.speedBytesPerSec);
              }
              record.lastProgressUpdateAt = Date.now();
            });
            await pipelineWithSignal(readStream, writeStream, {
              signal: record.abortController.signal,
            }).catch(async (err) => {
              await this.handleTransferFailure(record, err);
              throw err;
            });

            const computedHash = hash.digest("hex");
            if (computedHash !== staged.sha256) {
              record.status = TransferStatus.INTEGRITY_FAILED;
              record.error = "Checksum non corrispondente durante il salvataggio sul server.";
              record.completedAt = new Date();
              await this.recordAuditFailure(record, new Error(record.error));
              try { if (fs.existsSync(tempPartPath)) await fs.promises.unlink(tempPartPath); } catch {}
              throw new MolirisAppError(
                ErrorCode.INTEGRITY_CHECK_FAILED,
                "Checksum non corrispondente durante il salvataggio sul server."
              );
            }

            // Verifica dimensione su disco prima della promozione (CA-TRF-004)
            const tempStat = await fs.promises.stat(tempPartPath);
            if (tempStat.size !== writtenBytes) {
              record.status = TransferStatus.INTEGRITY_FAILED;
              record.error = "Dimensione del file temporaneo non corrispondente ai byte ricevuti.";
              record.completedAt = new Date();
              await this.recordAuditFailure(record, new Error(record.error));
              try { if (fs.existsSync(tempPartPath)) await fs.promises.unlink(tempPartPath); } catch {}
              throw new MolirisAppError(
                ErrorCode.INTEGRITY_CHECK_FAILED,
                `Dimensione su disco (${tempStat.size}) diversa dai byte ricevuti (${writtenBytes})`
              );
            }

            // Assicura che la directory genitore esista con permessi 0750 prima del rename
            await fs.promises.mkdir(path.dirname(finalPath), { recursive: true, mode: 0o750 });

            // Sostituzione atomica via rename
            this.beginPromotion(record);
            await fs.promises.rename(tempPartPath, finalPath);

            record.status = TransferStatus.COMPLETED;
            record.completedAt = new Date();
            record.transferredBytes = writtenBytes;
            record.computedChecksum = computedHash;
            await this.recordAuditComplete(record);

            fileTargetResults.push({
              target,
              success: true,
              destinationPath: finalPath,
              bytesTransferred: writtenBytes,
              checksum: computedHash,
            });
            completed++;
          } catch (err: any) {
            fileTargetResults.push({
              target,
              success: false,
              destinationPath: "",
              error: err.userMessage || err.message || "Errore durante scrittura su server",
            });
            allTargetsSuccess = false;
            failed++;
          }
        } else if (target.type === "robot") {
          let managedConn: ManagedRobotConnection | null = null;
          let tempRemotePartPath = "";
          let record: TransferRecord | null = null;
          try {
            this.assertRobotAccessible(robot);
            this.assertAuthorized(context, robot, [AppPermission.FS_REMOTE_UPLOAD]);

            managedConn = await this.connectionManager.acquireConnection(context.username, robot);
            const sftp = await managedConn.getSftpClient();

            const safeFilename = this.sanitizeFilename(staged.filename);
            const targetDir = target.directory || "/";
            const finalRemotePath = await this.remoteFsService.resolveAndValidatePath(
              path.posix.join(targetDir, safeFilename),
              context,
              robot,
              sftp
            );

            // Verifica esistenza preventiva
            const exists = await new Promise<boolean>((resolve) => {
              sftp.stat(finalRemotePath, (err) => resolve(!err));
            });
            if (exists && !overwrite) {
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
            const transferId = crypto.randomUUID();
            tempRemotePartPath = path.posix.join(
              path.posix.dirname(finalRemotePath),
              `.tmp_moliris_${transferId}.part`
            );

            const startTime = Date.now();
            const targetRecord: TransferRecord = {
              transferId,
              userId: context.userId,
              userSessionId: context.sessionId || "session-system",
              robotId: robot.id,
              direction: TransferDirection.CLIENT_TO_ROBOT,
              sourcePath: staged.stagingPath,
              destinationPath: finalRemotePath,
              tempDestinationPath: tempRemotePartPath,
              filename: safeFilename,
              totalBytes: staged.sizeBytes,
              transferredBytes: 0,
              status: TransferStatus.IN_PROGRESS,
              speedBytesPerSec: 0,
              etaSeconds: null,
              startedAt: new Date(),
              completedAt: undefined,
              error: null,
              checksumAlgorithm: this.checksumAlgorithm.name,
              lastProgressUpdateAt: startTime,
              lastBytesAtUpdate: 0,
              abortController: new AbortController(),
              cleanupHandlers: [],
            };
            record = targetRecord;
            this.registerTransfer(targetRecord);
            await this.recordAuditStart(targetRecord);

            const hash = crypto.createHash("sha256");
            let writtenBytes = 0;
            const readStream = fs.createReadStream(staged.stagingPath);
            const remoteWriteStream = new PipelinedSftpWriteStream(sftp, tempRemotePartPath, {
              flags: "w",
              mode: 0o600,
            });

            readStream.on("data", (chunk: Buffer | string) => {
              const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
              hash.update(buf);
              writtenBytes += buf.length;
              if (record) {
                record.transferredBytes = writtenBytes;
                const elapsedSec = Math.max(0.001, (Date.now() - startTime) / 1000);
                record.speedBytesPerSec = Math.round(writtenBytes / elapsedSec);
                if (record.totalBytes && record.speedBytesPerSec > 0) {
                  const remaining = Math.max(0, record.totalBytes - writtenBytes);
                  record.etaSeconds = Math.ceil(remaining / record.speedBytesPerSec);
                }
                record.lastProgressUpdateAt = Date.now();
              }
            });
            await pipelineWithSignal(readStream, remoteWriteStream, {
              signal: targetRecord.abortController.signal,
            }).catch(async (err) => {
              await this.handleTransferFailure(targetRecord, err);
              await this.safeUnlinkRobotFile(sftp, robot.id, tempRemotePartPath);
              throw err;
            });

            const computedHash = hash.digest("hex");
            if (computedHash !== staged.sha256) {
              if (record) {
                record.status = TransferStatus.INTEGRITY_FAILED;
                record.error = "Checksum non corrispondente durante il trasferimento al robot.";
                record.completedAt = new Date();
                await this.recordAuditFailure(record, new Error(record.error));
              }
              try {
                await new Promise<void>((res) => sftp.unlink(tempRemotePartPath, () => res()));
              } catch {}
              throw new MolirisAppError(
                ErrorCode.INTEGRITY_CHECK_FAILED,
                "Checksum non corrispondente durante il trasferimento al robot."
              );
            }

            // Verifica dimensione remota prima della promozione (CA-TRF-004)
            const remoteTempStat = await new Promise<any>((resolve, reject) => {
              sftp.stat(tempRemotePartPath, (err: any, st: any) => {
                if (err) return reject(this.remoteFsService.mapSftpError(err, tempRemotePartPath, robot.id));
                resolve(st);
              });
            });
            if (remoteTempStat.size !== writtenBytes) {
              if (record) {
                record.status = TransferStatus.INTEGRITY_FAILED;
                record.error = "Dimensione del file sul robot non corrispondente ai byte inviati.";
                record.completedAt = new Date();
                await this.recordAuditFailure(record, new Error(record.error));
              }
              try {
                await new Promise<void>((res) => sftp.unlink(tempRemotePartPath, () => res()));
              } catch {}
              throw new MolirisAppError(
                ErrorCode.INTEGRITY_CHECK_FAILED,
                `Dimensione sul robot (${remoteTempStat.size}) diversa dai byte inviati (${writtenBytes})`
              );
            }

            // Sostituzione atomica e sicura sul robot: se la destinazione esiste,
            // usa posix-rename quando disponibile e non distrugge il file valido
            // in caso di errore (CA-TRF-005).
            await this.promoteRemoteTempFile(
              sftp,
              tempRemotePartPath,
              finalRemotePath,
              overwrite === true,
              robot.id,
              record
            );

            if (record) {
              record.status = TransferStatus.COMPLETED;
              record.completedAt = new Date();
              record.transferredBytes = writtenBytes;
              record.computedChecksum = computedHash;
              await this.recordAuditComplete(record);
            }

            fileTargetResults.push({
              target,
              success: true,
              destinationPath: finalRemotePath,
              bytesTransferred: writtenBytes,
              checksum: computedHash,
            });
            completed++;
          } catch (err: any) {
            if (record) await this.handleTransferFailure(record, err);
            if (tempRemotePartPath && managedConn) {
              try {
                const sftp = await managedConn.getSftpClient();
                await new Promise<void>((res) => sftp.unlink(tempRemotePartPath, () => res()));
              } catch {}
            }
            fileTargetResults.push({
              target,
              success: false,
              destinationPath: "",
              error: err.userMessage || err.message || "Errore durante trasferimento al robot",
            });
            allTargetsSuccess = false;
            failed++;
          } finally {
            // Connessione gestita dal pool (RobotConnectionManager)
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
      // Un file saltato (conflitto sopraggiunto) non è un successo: il client
      // non deve presentare l'operazione come completata (CA-TRF-003/005).
      success: failed === 0 && skipped === 0,
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
    }
  ): Promise<BulkUploadResponse> {
    const stagedFiles: Array<{
      filename: string;
      stagingPath: string;
      sizeBytes: number;
      sha256: string;
    }> = [];

    for (const sourceRel of req.sourcePaths) {
      let resolvedSourcePath: string;
      if (req.sourceScope === "general") {
        resolvedSourcePath = await this.serverFsService.resolveGeneralPath(sourceRel);
      } else {
        if (!req.sourceRobotId) {
          throw new MolirisAppError(ErrorCode.MISSING_ROBOT_PARAMS, "sourceRobotId mancante per sorgente server robot.");
        }
        let robot = await this.robotRepository.findById(req.sourceRobotId);
        if (!robot) {
          robot = await this.robotRepository.findByServerDirectory(req.sourceRobotId);
        }
        if (!robot) {
          throw new MolirisAppError(ErrorCode.MISSING_ROBOT_PARAMS, `Robot sorgente '${req.sourceRobotId}' non trovato.`);
        }
        resolvedSourcePath = await this.serverFsService.resolveRobotPath(robot, sourceRel);
      }

      if (!fs.existsSync(resolvedSourcePath)) {
        throw new MolirisAppError(ErrorCode.SERVER_DIR_INACCESSIBLE, `File sorgente sul server '${sourceRel}' non trovato.`);
      }

      const stat = await fs.promises.stat(resolvedSourcePath);
      if (stat.isDirectory()) {
        throw new MolirisAppError(ErrorCode.SERVER_DIR_INACCESSIBLE, `Il percorso '${sourceRel}' è una directory, atteso un file.`);
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
        filename: path.basename(sourceRel),
        stagingPath: resolvedSourcePath,
        sizeBytes: stat.size,
        sha256,
      });
    }

    return await this.executeBulkUpload(context, {
      targets: req.targets,
      overwrite: req.overwrite,
      stagedFiles,
    });
  }

  /**
   * Trasferimento Copia o Spostamento da Robot a Robot con stream intermediario costante (§6)
   */
  public async executeRobotToRobotTransfer(
    context: AuthorizedContext,
    req: RobotToRobotTransferRequest
  ): Promise<RobotToRobotExecutionResult> {
    const { sourceRobotId, sourceRemotePath, targetRobotIds, isMove = false, confirmation = false, overwrite = false } = req;

    if (!sourceRobotId || !sourceRemotePath || !Array.isArray(targetRobotIds) || targetRobotIds.length === 0) {
      throw new MolirisAppError(ErrorCode.MISSING_ROBOT_PARAMS, "Parametri obbligatori mancanti per il trasferimento Robot->Robot.");
    }

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

    const filename = path.posix.basename(sourceRemotePath);
    const results: RobotToRobotTargetResult[] = [];
    let allTargetsSucceeded = true;

    for (const targetRobotId of targetRobotIds) {
      const destDir = (req.targetRemotePaths && req.targetRemotePaths[targetRobotId])
        || req.commonTargetDirectory
        || "/";
      const finalDestPath = destDir.endsWith("/") ? `${destDir}${filename}` : `${destDir}/${filename}`;

      const targetRobot = await this.robotRepository.findById(targetRobotId);
      if (!targetRobot) {
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
        userSessionId: context.sessionId,
        robotId: targetRobot.id,
        direction: TransferDirection.ROBOT_TO_ROBOT,
        filename,
        sourcePath: `robot:${sourceRobot.id}:${sourceRemotePath}`,
        destinationPath: `robot:${targetRobot.id}:${finalDestPath}`,
        totalBytes: sourceSize,
      });
      this.registerTransfer(targetRecord);

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
        targetRecord.status = TransferStatus.IN_PROGRESS;

        // Connessione dedicata al robot destinatario, riusata per scrittura,
        // verifica di dimensione e promozione atomica (CA-TRF-005).
        targetManagedConn = await this.connectionManager.acquireConnection(context.username, targetRobot);
        targetSftp = await targetManagedConn.getSftpClient();

        // Validazione del percorso finale (jail operatore, traversal, symlink).
        const resolvedDestPath = await this.remoteFsService.resolveAndValidatePath(
          finalDestPath,
          context,
          targetRobot,
          targetSftp
        );

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
