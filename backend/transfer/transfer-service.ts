// Requisiti soddisfatti: RF-TRF-001, RF-TRF-002, RF-TRF-003, RF-TRF-004, RF-TRF-005,
// RF-TRF-006, RF-TRF-007, RF-TRF-008, RF-TRF-009, RF-TRF-010, RF-TRF-011, RF-TRF-012,
// RF-TRF-013, RF-TRF-014, RNF-SEC-002, RNF-SEC-004, RNF-SEC-005, RNF-SEC-007, RNF-SEC-008,
// RNF-SEC-009, RNF-PERF-001, RNF-PERF-002, RNF-PERF-003, RNF-REL-001, RNF-REL-004, RNF-REL-005,
// SRS §1.2, §2.4, §5.5, §6.5, §6.6, §6.7, §9, §10.3, §10.4, §11.1, §11.5, §11.7, CA-FS-002..004, CA-TRF-001..007

import crypto from "crypto";
import fs from "fs";
import path from "path";
import { pipeline, type Readable, type Writable } from "stream";
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
} from "./transfer-models.ts";
import { resolveChecksumAlgorithm, ChecksumTransformStream } from "./checksum-service.ts";
import { ProgressTrackerStream } from "./transfer-progress.ts";

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

  // Tracciamento concorrenza (RF-TRF-012, RNF-PERF-003, CA-TRF-007)
  private activeCountByUser: Map<string, number> = new Map();
  private activeCountByRobot: Map<string, number> = new Map();
  private activeCountServer: number = 0;

  // Coda per politica di attesa (se configurata MOLIRIS_TRANSFER_CONCURRENCY_POLICY=coda)
  private waitQueue: (() => void)[] = [];

  // Registro pulizie in sospeso per robot temporaneamente irraggiungibili (Problema A2 punto d)
  private pendingCleanups: Array<{ robotId: string; remoteTempPath: string; createdAt: Date }> = [];
  private hourlyCleanupTimer: NodeJS.Timeout | null = null;
  private recordEvictionTimer: NodeJS.Timeout | null = null;

  private static readonly TERMINAL_STATUSES: ReadonlySet<TransferStatus> = new Set<TransferStatus>([
    TransferStatus.COMPLETED,
    TransferStatus.FAILED,
    TransferStatus.CANCELLED,
    TransferStatus.INTEGRITY_FAILED,
  ]);

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
      this.cancelTransfersForUser(userId, `SESSION_TERMINATED_${reason}`);
    });

    // Task orario per la pulizia dei file temporanei orfani sul server (Problema A2 punto e, RF-TRF-009)
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

  private getChunkSize(): number {
    return this.config.transferChunkSizeBytes || 2 * 1024 * 1024;
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

    // 4. Acquisizione slot concorrenza (RF-TRF-012, RNF-PERF-003, CA-TRF-007)
    await this.acquireTransferSlot(context.userId, robot.id);

    const destLockKey = `server:${robot.id}:${targetRelative}`;
    this.acquireDestinationLock(destLockKey);

    let record: TransferRecord | null = null;
    try {
      const transferId = crypto.randomUUID();
      const tempDir = await this.serverFsService.ensureTempDirectory(robot);
      const tempFilePath = path.join(tempDir, `transfer_${transferId}.tmp`);

      record = {
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
        transferredBytes: 0,
        speedBytesPerSec: null,
        etaSeconds: null,
        status: TransferStatus.IN_PROGRESS,
        error: null,
        expectedChecksum: options?.expectedChecksum,
        checksumAlgorithm: this.checksumAlgorithm.name,
        startedAt: new Date(),
        lastProgressUpdateAt: Date.now(),
        lastBytesAtUpdate: 0,
        abortController: new AbortController(),
        cleanupHandlers: [],
      };

      this.transfers.set(transferId, record);
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

      // 1. Verifica integrità base (Problema A1 punto a): confronto dimensione finale del file su disco
      const finalStat = await fs.promises.stat(tempFilePath);
      if (finalStat.size !== record.transferredBytes) {
        try { await fs.promises.unlink(tempFilePath); } catch {}
        record.status = TransferStatus.INTEGRITY_FAILED;
        throw new MolirisAppError(
          ErrorCode.INTEGRITY_CHECK_FAILED,
          `Verifica integrità fallita: dimensione su disco (${finalStat.size}) diversa dai byte trasferiti (${record.transferredBytes})`,
          "Verifica di integrità del file trasferito fallita."
        );
      }

      // 2. Verifica estesa readback opzionale (Problema A1 punto b, MOLIRIS_TRANSFER_VERIFY_MODE=readback)
      if (this.config.transferVerifyMode === "readback") {
        const readbackDigest = await this.computeLocalFileDigest(tempFilePath);
        if (readbackDigest.toLowerCase() !== (record.computedChecksum || "").toLowerCase()) {
          try { await fs.promises.unlink(tempFilePath); } catch {}
          record.status = TransferStatus.INTEGRITY_FAILED;
          throw new MolirisAppError(
            ErrorCode.INTEGRITY_CHECK_FAILED,
            `Verifica integrità readback fallita: atteso ${record.computedChecksum}, calcolato su disco ${readbackDigest}`,
            "Verifica di integrità del file trasferito fallita."
          );
        }
      }

      // 3. Controllo anti-corsa TOCTOU prima della promozione (Problema A3)
      await this.checkServerOverwritePolicy(finalServerPath, options);

      // Spostamento atomico sul file di destinazione definitivo (RF-TRF-009, CA-TRF-005)
      const targetDir = path.dirname(finalServerPath);
      if (!fs.existsSync(targetDir)) {
        await fs.promises.mkdir(targetDir, { recursive: true });
      }
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
      if (record) {
        await this.handleTransferFailure(record, err);
      }
      if (err instanceof MolirisAppError) throw err;
      throw new MolirisAppError(
        (record?.errorCode as any) || ErrorCode.TRANSFER_INTERRUPTED,
        err.message || "Trasferimento interrotto prima del completamento.",
        record?.error || "Trasferimento file interrotto prima del completamento."
      );
    } finally {
      this.releaseDestinationLock(destLockKey);
      this.releaseTransferSlot(context.userId, robot.id);
    }
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

    await this.acquireTransferSlot(context.userId, robot.id);

    let slotReleased = false;
    const releaseSlot = () => {
      if (!slotReleased) {
        slotReleased = true;
        this.releaseTransferSlot(context.userId, robot.id);
      }
    };

    let record: TransferRecord | null = null;
    try {
      const transferId = crypto.randomUUID();
      const filename = path.basename(targetPath);

      record = {
        transferId,
        userId: context.userId,
        userSessionId: context.sessionId,
        robotId: robot.id,
        direction: TransferDirection.SERVER_TO_CLIENT,
        filename,
        sourcePath: relativeFilePath,
        destinationPath: filename,
        totalBytes: stat.size,
        transferredBytes: 0,
        speedBytesPerSec: null,
        etaSeconds: null,
        status: TransferStatus.IN_PROGRESS,
        error: null,
        checksumAlgorithm: this.checksumAlgorithm.name,
        startedAt: new Date(),
        lastProgressUpdateAt: Date.now(),
        lastBytesAtUpdate: 0,
        abortController: new AbortController(),
        cleanupHandlers: [],
      };

      this.transfers.set(transferId, record);
      await this.recordAuditStart(record);

      const rawStream = fs.createReadStream(targetPath, {
        highWaterMark: this.getChunkSize(),
      });

      const progressTracker = new ProgressTrackerStream({
        totalBytes: stat.size,
        idleTimeoutMs: this.config.transferIdleTimeoutMs,
        highWaterMark: this.getChunkSize(),
        onProgress: (snap) => this.updateProgress(record!, snap),
        onIdleTimeout: () => {
          this.handleTransferFailure(record!, new MolirisAppError(ErrorCode.TIMEOUT_ERROR, "Timeout inattività download superato."));
        },
      });

      const checksumStream = new ChecksumTransformStream(this.checksumAlgorithm, this.getChunkSize());

      record.cleanupHandlers.push(async () => {
        try { rawStream.destroy(); } catch {}
      });

      // Pipelining dello stream di lettura con tracking avanzamento e digest checksum
      const outStream = rawStream.pipe(progressTracker).pipe(checksumStream);

      outStream.on("finish", async () => {
        record!.status = TransferStatus.COMPLETED;
        record!.completedAt = new Date();
        record!.computedChecksum = checksumStream.getDigest() || undefined;
        // Etichetta specifica download browser (Problema A1 punto c): MAI "verificato end-to-end"
        record!.integrityLabel = "completato — integrità verificata solo lato server";
        record!.integrityVerification = {
          verified: true,
          mode: "stream",
          label: record!.integrityLabel,
        };
        await this.recordAuditSuccess(record!);
        releaseSlot();
      });

      outStream.on("error", async (err: any) => {
        await this.handleTransferFailure(record!, err);
        releaseSlot();
      });

      outStream.on("close", () => {
        releaseSlot();
      });

      return {
        stream: outStream,
        transferDto: this.toDto(record),
        filename,
        totalBytes: stat.size,
      };
    } catch (err) {
      releaseSlot();
      throw err;
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

    await this.acquireTransferSlot(context.userId, robot.id);

    const destLockKey = `robot:${robot.id}:${req.remotePath}`;
    this.acquireDestinationLock(destLockKey);

    let managedConn: ManagedRobotConnection | null = null;
    let record: TransferRecord | null = null;
    try {
      const transferId = crypto.randomUUID();
      const filename = path.basename(sourceServerPath);

      // Riutilizzo di UNA sola connessione SSH/SFTP per l'intero ciclo del trasferimento (§6.6, RNF-PERF-001)
      managedConn = await this.connectionManager.acquireConnection(context.username, robot);
      const sftp = await managedConn.getSftpClient();
      await this.processPendingCleanupsForRobot(robot.id, sftp);
      const finalResolvedRemote = await this.remoteFsService.resolveAndValidatePath(req.remotePath, context, robot, sftp);

      // Controllo anti-corsa TOCTOU preventivo prima dell'avvio della scrittura (Problema A3)
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
        if (policy !== "sovrascrivi" && req.overwrite !== true) {
          throw new MolirisAppError(
            ErrorCode.REMOTE_FS_ERROR,
            `File remoto finale già esistente: ${finalResolvedRemote}`,
            "File di destinazione sul robot già esistente. Sovrascrittura non consentita senza conferma esplicita."
          );
        }
      }

      // Controllo preventivo spazio su disco robot (Problema A4)
      const remoteTargetDir = path.posix.dirname(finalResolvedRemote);
      await this.checkRobotDiskSpace(sftp, remoteTargetDir, stat.size, robot.id);

      const remoteTempPath = path.posix.join(
        remoteTargetDir,
        `.tmp_moliris_${transferId}.tmp`
      );

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
          this.logger.info("Ripresa trasferimento server->robot attivata (RF-TRF-010)", {
            robotId: robot.id,
            offset: startOffset,
            totalBytes: stat.size,
          });
        }
      }

      record = {
        transferId,
        userId: context.userId,
        userSessionId: context.sessionId,
        robotId: robot.id,
        direction: TransferDirection.SERVER_TO_ROBOT,
        filename,
        sourcePath: req.serverRelativePath,
        destinationPath: req.remotePath,
        tempDestinationPath: remoteTempPath,
        totalBytes: stat.size,
        transferredBytes: startOffset,
        speedBytesPerSec: null,
        etaSeconds: null,
        status: TransferStatus.IN_PROGRESS,
        error: null,
        expectedChecksum: req.expectedChecksum,
        checksumAlgorithm: this.checksumAlgorithm.name,
        startedAt: new Date(),
        lastProgressUpdateAt: Date.now(),
        lastBytesAtUpdate: startOffset,
        abortController: new AbortController(),
        cleanupHandlers: [],
      };

      this.transfers.set(transferId, record);
      await this.recordAuditStart(record);

      const localReadStream = fs.createReadStream(sourceServerPath, {
        start: startOffset,
        highWaterMark: this.getChunkSize(),
      });

      const remoteWriteStream = sftp.createWriteStream(remoteTempPath, {
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
          record.status = TransferStatus.INTEGRITY_FAILED;
          throw new MolirisAppError(
            ErrorCode.INTEGRITY_CHECK_FAILED,
            `Verifica integrità readback fallita sul robot: atteso ${record.computedChecksum}, calcolato ${readbackDigest}`,
            "Verifica di integrità del file trasferito fallita."
          );
        }
      }

      // 3. Sostituzione atomica e controllo anti-corsa TOCTOU prima della promozione sulla STESSA sftp
      await this.promoteRemoteTempFile(sftp, remoteTempPath, finalResolvedRemote, req.overwrite === true, robot.id);

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
      if (record) {
        await this.handleTransferFailure(record, err);
      }
      if (err instanceof MolirisAppError) throw err;
      throw new MolirisAppError(
        (record?.errorCode as any) || ErrorCode.TRANSFER_INTERRUPTED,
        err.message || "Trasferimento interrotto prima del completamento.",
        record?.error || "Trasferimento file interrotto prima del completamento."
      );
    } finally {
      if (managedConn) {
        try { await managedConn.close(); } catch {}
      }
      this.releaseDestinationLock(destLockKey);
      this.releaseTransferSlot(context.userId, robot.id);
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

    // Risoluzione e controllo metadati file sorgente sul robot (Prompt 9, RF-FS-004)
    const remoteStats = await this.remoteFsService.getRemoteFileStats(context, robot, req.remotePath);
    if (remoteStats.type === "directory") {
      throw new MolirisAppError(
        ErrorCode.REMOTE_FS_ERROR,
        `Il percorso remoto è una directory: ${req.remotePath}`,
        "Impossibile trasferire una directory."
      );
    }

    this.checkMaxFileSize(remoteStats.size);

    const safeFilename = path.basename(req.remotePath);
    let targetServerRelative: string;
    if (!req.serverRelativePath || req.serverRelativePath.trim() === "" || req.serverRelativePath === ".") {
      targetServerRelative = safeFilename;
    } else {
      const norm = path.posix.normalize(req.serverRelativePath.trim());
      const fullCandidate = path.resolve(robot.serverDirectoryPath, norm);
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
        targetServerRelative = path.posix.join(norm, safeFilename);
      } else {
        targetServerRelative = norm;
      }
    }

    const finalServerPath = await this.serverFsService.resolveRobotPath(robot, targetServerRelative);

    // Controllo sovrascrittura preventiva server (§11.5, RF-TRF-011, Problema A3)
    await this.checkServerOverwritePolicy(finalServerPath, req);

    // Controllo preventivo spazio su server (RF-TRF-014, Problema A4)
    if (remoteStats.size && remoteStats.size > 0) {
      await this.checkServerDiskSpace(path.dirname(finalServerPath), remoteStats.size);
    }

    await this.acquireTransferSlot(context.userId, robot.id);

    const destLockKey = `server:${robot.id}:${targetServerRelative}`;
    this.acquireDestinationLock(destLockKey);

    let record: TransferRecord | null = null;
    try {
      const transferId = crypto.randomUUID();
      const tempDir = await this.serverFsService.ensureTempDirectory(robot);
      const tempFilePath = path.join(tempDir, `transfer_${transferId}.tmp`);

      // RF-TRF-010: Ripresa trasferimenti interrotti (se abilitata)
      let startOffset = 0;
      let writeFlags: "w" | "a" = "w";
      if (this.config.transferResumeEnabled && fs.existsSync(tempFilePath)) {
        const existingStat = await fs.promises.stat(tempFilePath);
        if (existingStat.size > 0 && remoteStats.size !== null && existingStat.size < remoteStats.size) {
          startOffset = existingStat.size;
          writeFlags = "a";
          this.logger.info("Ripresa trasferimento robot->server attivata (RF-TRF-010)", {
            robotId: robot.id,
            offset: startOffset,
            totalBytes: remoteStats.size,
          });
        }
      }

      record = {
        transferId,
        userId: context.userId,
        userSessionId: context.sessionId,
        robotId: robot.id,
        direction: TransferDirection.ROBOT_TO_SERVER,
        filename: safeFilename,
        sourcePath: req.remotePath,
        destinationPath: targetServerRelative,
        tempDestinationPath: tempFilePath,
        totalBytes: remoteStats.size,
        transferredBytes: startOffset,
        speedBytesPerSec: null,
        etaSeconds: null,
        status: TransferStatus.IN_PROGRESS,
        error: null,
        expectedChecksum: req.expectedChecksum,
        checksumAlgorithm: this.checksumAlgorithm.name,
        startedAt: new Date(),
        lastProgressUpdateAt: Date.now(),
        lastBytesAtUpdate: startOffset,
        abortController: new AbortController(),
        cleanupHandlers: [],
      };

      this.transfers.set(transferId, record);
      await this.recordAuditStart(record);

      let remoteReadHandle: any = null;
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

      await this.streamWithTrackingAndChecksum(
        remoteReadHandle.stream,
        tempWriteStream,
        record,
        req.expectedChecksum,
        startOffset
      );

      await remoteReadHandle.cleanup();
      remoteReadHandle = null;

      // 1. Verifica integrità base (Problema A1 punto a): confronto dimensione file su disco
      const finalStat = await fs.promises.stat(tempFilePath);
      if (finalStat.size !== record.transferredBytes) {
        try { await fs.promises.unlink(tempFilePath); } catch {}
        record.status = TransferStatus.INTEGRITY_FAILED;
        throw new MolirisAppError(
          ErrorCode.INTEGRITY_CHECK_FAILED,
          `Verifica integrità fallita: dimensione su server (${finalStat.size}) diversa dai byte trasferiti (${record.transferredBytes})`,
          "Verifica di integrità del file trasferito fallita."
        );
      }

      // 2. Verifica estesa readback opzionale (Problema A1 punto b)
      const isReadback = this.config.transferVerifyMode === "readback";
      if (isReadback) {
        const readbackDigest = await this.computeLocalFileDigest(tempFilePath);
        if (readbackDigest.toLowerCase() !== (record.computedChecksum || "").toLowerCase()) {
          try { await fs.promises.unlink(tempFilePath); } catch {}
          record.status = TransferStatus.INTEGRITY_FAILED;
          throw new MolirisAppError(
            ErrorCode.INTEGRITY_CHECK_FAILED,
            `Verifica integrità readback fallita: atteso ${record.computedChecksum}, calcolato su disco ${readbackDigest}`,
            "Verifica di integrità del file trasferito fallita."
          );
        }
      }

      // 3. Controllo anti-corsa TOCTOU subito prima della promozione (Problema A3)
      await this.checkServerOverwritePolicy(finalServerPath, req);

      // Spostamento atomico sulla destinazione server definitiva (RF-TRF-009, CA-TRF-005)
      const targetDir = path.dirname(finalServerPath);
      if (!fs.existsSync(targetDir)) {
        await fs.promises.mkdir(targetDir, { recursive: true });
      }
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
      if (record) {
        await this.handleTransferFailure(record, err);
      }
      if (err instanceof MolirisAppError) throw err;
      throw new MolirisAppError(
        (record?.errorCode as any) || ErrorCode.TRANSFER_INTERRUPTED,
        err.message || "Trasferimento interrotto prima del completamento.",
        record?.error || "Trasferimento file interrotto prima del completamento."
      );
    } finally {
      this.releaseDestinationLock(destLockKey);
      this.releaseTransferSlot(context.userId, robot.id);
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

    await this.acquireTransferSlot(context.userId, robot.id);

    const destLockKey = `robot:${robot.id}:${remoteDirectoryPath}/${safeFilename}`;
    this.acquireDestinationLock(destLockKey);

    let managedConn: ManagedRobotConnection | null = null;
    let record: TransferRecord | null = null;
    try {
      const transferId = crypto.randomUUID();

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
        `.tmp_moliris_${transferId}.tmp`
      );

      record = {
        transferId,
        userId: context.userId,
        userSessionId: context.sessionId,
        robotId: robot.id,
        direction: TransferDirection.CLIENT_TO_ROBOT,
        filename: safeFilename,
        sourcePath: safeFilename,
        destinationPath: finalResolvedRemote,
        tempDestinationPath: remoteTempPath,
        totalBytes: totalBytes || null,
        transferredBytes: 0,
        speedBytesPerSec: null,
        etaSeconds: null,
        status: TransferStatus.IN_PROGRESS,
        error: null,
        expectedChecksum: options?.expectedChecksum,
        checksumAlgorithm: this.checksumAlgorithm.name,
        startedAt: new Date(),
        lastProgressUpdateAt: Date.now(),
        lastBytesAtUpdate: 0,
        abortController: new AbortController(),
        cleanupHandlers: [],
      };

      this.transfers.set(transferId, record);
      await this.recordAuditStart(record);

      const remoteWriteStream = sftp.createWriteStream(remoteTempPath, {
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
          record.status = TransferStatus.INTEGRITY_FAILED;
          throw new MolirisAppError(
            ErrorCode.INTEGRITY_CHECK_FAILED,
            `Verifica integrità readback fallita sul robot: atteso ${record.computedChecksum}, calcolato ${readbackDigest}`,
            "Verifica di integrità del file trasferito fallita."
          );
        }
      }

      // 3. Sostituzione atomica e promozione sulla STESSA sftp
      await this.promoteRemoteTempFile(sftp, remoteTempPath, finalResolvedRemote, options?.overwrite === true, robot.id);

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
      if (record) {
        await this.handleTransferFailure(record, err);
      }
      if (err instanceof MolirisAppError) throw err;
      throw new MolirisAppError(
        (record?.errorCode as any) || ErrorCode.TRANSFER_INTERRUPTED,
        err.message || "Trasferimento interrotto prima del completamento.",
        record?.error || "Trasferimento file interrotto prima del completamento."
      );
    } finally {
      if (managedConn) {
        try { await managedConn.close(); } catch {}
      }
      this.releaseDestinationLock(destLockKey);
      this.releaseTransferSlot(context.userId, robot.id);
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

    await this.acquireTransferSlot(context.userId, robot.id);

    let slotReleased = false;
    const releaseSlot = () => {
      if (!slotReleased) {
        slotReleased = true;
        this.releaseTransferSlot(context.userId, robot.id);
      }
    };

    let record: TransferRecord | null = null;
    let remoteReadHandle: any = null;
    try {
      const transferId = crypto.randomUUID();
      const filename = path.basename(remoteFilePath);

      record = {
        transferId,
        userId: context.userId,
        userSessionId: context.sessionId,
        robotId: robot.id,
        direction: TransferDirection.ROBOT_TO_CLIENT,
        filename,
        sourcePath: remoteFilePath,
        destinationPath: filename,
        totalBytes: stats.size,
        transferredBytes: 0,
        speedBytesPerSec: null,
        etaSeconds: null,
        status: TransferStatus.IN_PROGRESS,
        error: null,
        checksumAlgorithm: this.checksumAlgorithm.name,
        startedAt: new Date(),
        lastProgressUpdateAt: Date.now(),
        lastBytesAtUpdate: 0,
        abortController: new AbortController(),
        cleanupHandlers: [],
      };

      this.transfers.set(transferId, record);
      await this.recordAuditStart(record);

      remoteReadHandle = await this.remoteFsService.openRemoteReadStream(context, robot, remoteFilePath);

      const progressTracker = new ProgressTrackerStream({
        totalBytes: stats.size,
        idleTimeoutMs: this.config.transferIdleTimeoutMs,
        highWaterMark: this.getChunkSize(),
        onProgress: (snap) => this.updateProgress(record!, snap),
        onIdleTimeout: () => {
          this.handleTransferFailure(record!, new MolirisAppError(ErrorCode.TIMEOUT_ERROR, "Timeout inattività download superato."));
        },
      });

      const checksumStream = new ChecksumTransformStream(this.checksumAlgorithm, this.getChunkSize());

      record.cleanupHandlers.push(async () => {
        if (remoteReadHandle) {
          try { await remoteReadHandle.cleanup(); } catch {}
        }
      });

      const outStream = remoteReadHandle.stream.pipe(progressTracker).pipe(checksumStream);

      outStream.on("finish", async () => {
        record!.status = TransferStatus.COMPLETED;
        record!.completedAt = new Date();
        record!.computedChecksum = checksumStream.getDigest() || undefined;
        record!.integrityLabel = "completato — integrità verificata solo lato server";
        record!.integrityVerification = {
          verified: true,
          mode: "stream",
          label: record!.integrityLabel,
        };
        await this.recordAuditSuccess(record!);
        await remoteReadHandle.cleanup();
        releaseSlot();
      });

      outStream.on("error", async (err: any) => {
        record!.integrityLabel = "integrità non verificata";
        await this.handleTransferFailure(record!, err);
        if (remoteReadHandle) {
          try { await remoteReadHandle.cleanup(); } catch {}
        }
        releaseSlot();
      });

      outStream.on("close", () => {
        releaseSlot();
      });

      return {
        stream: outStream,
        transferDto: this.toDto(record),
        filename,
        totalBytes: stats.size,
      };
    } catch (err) {
      if (remoteReadHandle) {
        try { await remoteReadHandle.cleanup(); } catch {}
      }
      releaseSlot();
      throw err;
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

    await new Promise<void>((resolve, reject) => {
      const abortHandler = () => {
        const abortErr = new MolirisAppError(
          ErrorCode.TRANSFER_INTERRUPTED,
          "Trasferimento annullato o interrotto."
        );
        sourceStream.destroy(abortErr);
        destStream.destroy(abortErr);
        reject(abortErr);
      };

      record.abortController.signal.addEventListener("abort", abortHandler, { once: true });

      // Pipelining nativo Node.js: source -> progressTracker -> checksumStream -> destStream
      pipeline(sourceStream, progressTracker, checksumStream, destStream, (err) => {
        record.abortController.signal.removeEventListener("abort", abortHandler);
        if (err) return reject(err);

        record.computedChecksum = checksumStream.getDigest() || undefined;
        resolve();
      });
    });

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

    if (TransferService.TERMINAL_STATUSES.has(record.status)) {
      return this.toDto(record);
    }

    record.status = TransferStatus.CANCELLED;
    record.completedAt = new Date();
    record.error = "Trasferimento annullato dall'utente.";
    record.integrityLabel = "integrità non verificata";
    record.abortController.abort();

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
   * Annulla tutti i trasferimenti attivi associati a un utente (es. a chiusura/scadenza sessione).
   */
  public cancelTransfersForUser(userId: string, reason: string): void {
    for (const record of Array.from(this.transfers.values())) {
      if (record.userId === userId && (record.status === TransferStatus.IN_PROGRESS || record.status === TransferStatus.INTEGRITY_CHECKING)) {
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

  private reconcileActiveCounts(): void {
    const userCounts = new Map<string, number>();
    const robotCounts = new Map<string, number>();
    let serverCount = 0;

    for (const rec of this.transfers.values()) {
      if (rec.status === TransferStatus.IN_PROGRESS) {
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

  private async acquireTransferSlot(userId: string, robotId: string): Promise<void> {
    this.reconcileActiveCounts();

    const userCount = this.activeCountByUser.get(userId) || 0;
    const robotCount = this.activeCountByRobot.get(robotId) || 0;

    const maxPerUser = this.config.maxConcurrentTransfersPerUser;
    const maxPerRobot = this.config.maxConcurrentTransfersPerRobot;
    const maxServer = this.config.maxConcurrentTransfersServer;

    const limitExceeded =
      (maxPerUser > 0 && userCount >= maxPerUser) ||
      (maxPerRobot > 0 && robotCount >= maxPerRobot) ||
      (maxServer > 0 && this.activeCountServer >= maxServer);

    if (limitExceeded) {
      if (this.config.transferConcurrencyQueuePolicy === "coda") {
        // Accoda la richiesta
        await new Promise<void>((resolve) => {
          this.waitQueue.push(resolve);
        });
      } else {
        // Politica predefinita prudente: rifiuta con messaggio chiaro (RF-TRF-012, CA-TRF-007)
        throw new MolirisAppError(
          ErrorCode.TRANSFER_INTERRUPTED,
          `Limite trasferimenti simultanei raggiunto (server: ${this.activeCountServer}/${maxServer}, user: ${userCount}/${maxPerUser}, robot: ${robotCount}/${maxPerRobot})`,
          "Limite di trasferimenti simultanei raggiunto. Riprovare al termine delle operazioni in corso."
        );
      }
    }

    this.activeCountByUser.set(userId, userCount + 1);
    this.activeCountByRobot.set(robotId, robotCount + 1);
    this.activeCountServer++;
  }

  private releaseTransferSlot(userId: string, robotId: string): void {
    const userCount = this.activeCountByUser.get(userId) || 1;
    const robotCount = this.activeCountByRobot.get(robotId) || 1;

    this.activeCountByUser.set(userId, Math.max(0, userCount - 1));
    this.activeCountByRobot.set(robotId, Math.max(0, robotCount - 1));
    this.activeCountServer = Math.max(0, this.activeCountServer - 1);

    this.reconcileActiveCounts();

    if (this.waitQueue.length > 0) {
      const next = this.waitQueue.shift();
      if (next) next();
    }
  }

  // =========================================================================
  // GESTIONE ERRORI, DISCONNESSIONI E FALLIMENTI (RF-TRF-007, CA-TRF-003, §9)
  // =========================================================================

  private async handleTransferFailure(record: TransferRecord, err: any): Promise<void> {
    if (record.status !== TransferStatus.INTEGRITY_FAILED && record.status !== TransferStatus.CANCELLED) {
      record.status = TransferStatus.FAILED;
    }
    record.completedAt = new Date();

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

    this.logger.error("Fallimento trasferimento file", err.message || safeUserMsg, {
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
    const list: TransferDto[] = [];
    for (const record of Array.from(this.transfers.values())) {
      if (robotId && record.robotId !== robotId) continue;
      // Visibile solo al titolare o a chi è autorizzato per quel robot
      if (record.userId === context.userId || context.targetRobotId === record.robotId) {
        list.push(this.toDto(record));
      }
    }
    // Ordina i più recenti per primi
    return list.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
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
      const readStream = sftpClient.createReadStream(remotePath, { highWaterMark: this.getChunkSize() });
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
        error: err.message,
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
    robotId: string
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
      await new Promise<void>((resolve, reject) => {
        sftpClient.rename(remoteTempPath, finalPath, (err: any) => {
          if (err) return reject(this.remoteFsService.mapSftpError(err, finalPath, robotId));
          resolve();
        });
      });
    }
  }

  private async recordAuditStart(record: TransferRecord): Promise<void> {
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
        totalBytes: record.totalBytes,
      },
    });
  }

  private async recordAuditSuccess(record: TransferRecord): Promise<void> {
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
        transferredBytes: record.transferredBytes,
        checksum: record.computedChecksum,
      },
    });
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
}
