// Requisiti soddisfatti: RF-FS-001, RF-FS-002, RF-FS-003, RF-FS-004, RF-FS-005, RF-FS-006, RF-FS-007,
// RNF-SEC-004, RNF-SEC-005, RNF-SEC-006, RNF-SEC-009, RNF-PERF-001, RNF-PERF-002, RNF-REL-001, RNF-REL-005,
// SRS §1.2, §5.5, §9, §10.3, §11.5, §11.6, §11.7, CA-FS-001

import path from "path";
import { Readable, Writable } from "stream";
import { type SFTPWrapper } from "ssh2";
import { type SystemConfiguration } from "../../config/configuration.ts";
import { type RobotEntity } from "../../storage/robot-models.ts";
import { type AuthorizedContext } from "../auth/session-manager.ts";
import { AppPermission, type RolePermissionMapping, DEFAULT_ROLE_PERMISSIONS, hasPermission } from "../auth/permissions.ts";
import { type RobotConnectionManager } from "../connection/robot-connection-manager.ts";
import { type AuditRepository } from "../../storage/audit-repository.ts";
import { AuditOperation } from "../../storage/audit-models.ts";
import { MolirisLogger, redactSensitiveData } from "../../logging/logger.ts";
import { MolirisAppError, ErrorCode } from "../../errors/app-errors.ts";
import {
  type RemoteFileItemDto,
  type RemoteFileItemType,
  type RemoteDirectoryListingDto,
  type RemoteWriteStreamOptions,
  type RemoteReadStreamHandle,
  type RemoteWriteStreamHandle,
} from "./remote-fs-models.ts";

export interface PipelinedStreamOptions {
  concurrency?: number;
  chunkSize?: number;
  highWaterMark?: number;
  start?: number;
}

/**
 * Flusso in scrittura SFTP ad alte prestazioni basato su sliding-window (RNF-PERF-001, §6.7).
 * Mantiene fino a N richieste in volo simultaneamente, eliminando il collo di bottiglia stop-and-wait.
 */
export class PipelinedSftpWriteStream extends Writable {
  private sftp: SFTPWrapper;
  private remotePath: string;
  private flags: string;
  private mode: number;
  private concurrency: number;
  private chunkSize: number;
  private handle: Buffer | null = null;
  private pos: number;
  private inFlight = 0;
  private drainCb: (() => void) | null = null;
  private openError: Error | null = null;
  private isClosing = false;

  constructor(sftp: SFTPWrapper, remotePath: string, options?: PipelinedStreamOptions & { flags?: string; mode?: number }) {
    super({ highWaterMark: options?.highWaterMark || 2 * 1024 * 1024 });
    this.sftp = sftp;
    this.remotePath = remotePath;
    this.flags = options?.flags || "w";
    this.mode = options?.mode || 0o644;
    this.concurrency = options?.concurrency || 32;
    this.chunkSize = options?.chunkSize || 32768;
    this.pos = options?.start || 0;
  }

  _construct(callback: (error?: Error | null) => void): void {
    this.sftp.open(this.remotePath, this.flags as any, this.mode, (err, handle) => {
      if (err) {
        this.openError = err;
        return callback(err);
      }
      this.handle = handle;
      callback();
    });
  }

  _write(chunk: any, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    if (!this.handle) {
      if (this.openError) return callback(this.openError);
      return callback(new Error("SFTP handle non pronto"));
    }

    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
    let offset = 0;
    const total = buf.length;

    const dispatch = () => {
      while (offset < total && this.inFlight < this.concurrency) {
        const len = Math.min(this.chunkSize, total - offset);
        const sub = buf.subarray(offset, offset + len);
        const writePos = this.pos;
        this.pos += len;
        offset += len;
        this.inFlight++;

        this.sftp.write(this.handle!, sub, 0, len, writePos, (err) => {
          this.inFlight--;
          if (err) {
            this.destroy(err);
            return;
          }
          if (this.drainCb && this.inFlight < this.concurrency) {
            const cb = this.drainCb;
            this.drainCb = null;
            cb();
          }
        });
      }

      if (offset < total) {
        this.drainCb = dispatch;
      } else {
        callback();
      }
    };

    dispatch();
  }

  _final(callback: (error?: Error | null) => void): void {
    if (this.isClosing) return callback();
    this.isClosing = true;

    const finalize = () => {
      if (this.inFlight > 0) {
        setTimeout(finalize, 2);
        return;
      }
      if (this.handle) {
        const h = this.handle;
        this.handle = null;
        this.sftp.close(h, callback);
      } else {
        callback();
      }
    };
    finalize();
  }

  _destroy(error: Error | null, callback: (error: Error | null) => void): void {
    if (this.handle) {
      const h = this.handle;
      this.handle = null;
      this.sftp.close(h, () => callback(error));
    } else {
      callback(error);
    }
  }
}

/**
 * Flusso in lettura SFTP ad alte prestazioni basato su prefetching sliding-window (RNF-PERF-001, §6.7).
 * Prefetch ordinato di blocchi consecutivi in parallelo con memoria costante.
 */
export class PipelinedSftpReadStream extends Readable {
  private sftp: SFTPWrapper;
  private remotePath: string;
  private fileSize?: number | null;
  private concurrency: number;
  private chunkSize: number;
  private handle: Buffer | null = null;
  private requestPos: number;
  private emitPos: number;
  private inFlight = 0;
  private pendingChunks = new Map<number, Buffer>();
  private eofReached = false;
  private isReading = false;
  private isClosing = false;
  private openError: Error | null = null;

  constructor(
    sftp: SFTPWrapper,
    remotePath: string,
    fileSizeOrOptions?: number | null | PipelinedStreamOptions,
    options?: PipelinedStreamOptions
  ) {
    let actualSize: number | null | undefined = null;
    let actualOpts: PipelinedStreamOptions | undefined = options;
    if (typeof fileSizeOrOptions === "number") {
      actualSize = fileSizeOrOptions;
    } else if (fileSizeOrOptions && typeof fileSizeOrOptions === "object") {
      actualOpts = fileSizeOrOptions as PipelinedStreamOptions;
    }
    super({ highWaterMark: actualOpts?.highWaterMark || 2 * 1024 * 1024 });
    this.sftp = sftp;
    this.remotePath = remotePath;
    this.fileSize = actualSize;
    this.concurrency = actualOpts?.concurrency || 32;
    this.chunkSize = actualOpts?.chunkSize || 32768;
    this.requestPos = actualOpts?.start || 0;
    this.emitPos = this.requestPos;
  }

  _construct(callback: (error?: Error | null) => void): void {
    this.sftp.open(this.remotePath, "r" as any, 0o644, (err, handle) => {
      if (err) {
        this.openError = err;
        return callback(err);
      }
      this.handle = handle;
      callback();
    });
  }

  _read(size: number): void {
    if (!this.handle) {
      if (this.openError) {
        this.destroy(this.openError);
        return;
      }
      return;
    }
    this.isReading = true;
    this._drainAndPrefetch();
  }

  private _drainAndPrefetch(): void {
    while (this.pendingChunks.has(this.emitPos)) {
      const chunk = this.pendingChunks.get(this.emitPos)!;
      this.pendingChunks.delete(this.emitPos);
      this.emitPos += chunk.length;
      const canContinue = this.push(chunk);
      if (!canContinue) {
        this.isReading = false;
        break;
      }
    }

    if (this.eofReached && this.pendingChunks.size === 0) {
      this.push(null);
      this._closeHandle();
      return;
    }
    if (this.fileSize !== undefined && this.fileSize !== null && this.emitPos >= this.fileSize) {
      this.push(null);
      this._closeHandle();
      return;
    }

    if (!this.isReading || this.eofReached) {
      return;
    }

    while (this.inFlight < this.concurrency && !this.eofReached) {
      if (this.fileSize !== undefined && this.fileSize !== null && this.requestPos >= this.fileSize) {
        break;
      }

      const readPos = this.requestPos;
      let len = this.chunkSize;
      if (this.fileSize !== undefined && this.fileSize !== null) {
        len = Math.min(len, this.fileSize - readPos);
        if (len <= 0) break;
      }

      this.requestPos += len;
      this.inFlight++;

      const buf = Buffer.allocUnsafe(len);
      this.sftp.read(this.handle!, buf, 0, len, readPos, (err, bytesRead) => {
        this.inFlight--;
        if (err) {
          if ((err as any).code === 1 || (err as any).message?.toLowerCase().includes("eof")) {
            this.eofReached = true;
            this._drainAndPrefetch();
            return;
          }
          this.destroy(err);
          return;
        }

        if (bytesRead === 0) {
          this.eofReached = true;
        } else {
          const finalChunk = bytesRead < len ? buf.subarray(0, bytesRead) : buf;
          this.pendingChunks.set(readPos, finalChunk);
          if (bytesRead < len) {
            this.eofReached = true;
          }
        }

        this._drainAndPrefetch();
      });
    }
  }

  private _closeHandle(): void {
    if (this.handle && !this.isClosing) {
      this.isClosing = true;
      const h = this.handle;
      this.handle = null;
      this.sftp.close(h, () => {});
    }
  }

  _destroy(error: Error | null, callback: (error: Error | null) => void): void {
    if (this.handle) {
      const h = this.handle;
      this.handle = null;
      this.sftp.close(h, () => callback(error));
    } else {
      callback(error);
    }
  }
}

export class RemoteFilesystemService {
  private config: SystemConfiguration;
  private connectionManager: RobotConnectionManager;
  private auditRepository: AuditRepository;
  private roleMapping: RolePermissionMapping;
  private logger: MolirisLogger;

  constructor(
    config: SystemConfiguration,
    connectionManager: RobotConnectionManager,
    auditRepository: AuditRepository,
    logger: MolirisLogger,
    roleMapping: RolePermissionMapping = DEFAULT_ROLE_PERMISSIONS
  ) {
    this.config = config;
    this.connectionManager = connectionManager;
    this.auditRepository = auditRepository;
    this.roleMapping = roleMapping;
    this.logger = logger;
  }

  public getConnectionManager(): RobotConnectionManager {
    return this.connectionManager;
  }

  private getTransferBufferSize(): number {
    return this.config.transferChunkSizeBytes || 2 * 1024 * 1024;
  }

  /**
   * STEP 3 – Validazione e normalizzazione del percorso remoto (§10.3, RNF-SEC-005, RF-FS-007).
   * L'input del frontend non è attendibile.
   * - Rifiuta byte nulli (\0), caratteri anomali o lunghezze eccessive.
   * - Normalizza il percorso in formato POSIX.
   * - Se specificato, applica le restrizioni configurate (remoteFsAllowedPaths).
   * - Se omesso, usa il percorso iniziale configurato o il punto di partenza naturale SFTP.
   */
  public async resolveAndValidatePath(
    rawPath: string | undefined | null,
    context: AuthorizedContext,
    robot: RobotEntity,
    sftpClient?: SFTPWrapper
  ): Promise<string> {
    // 1. Controllo byte nulli e lunghezze anomale (RNF-SEC-005)
    if (rawPath !== undefined && rawPath !== null) {
      if (rawPath.includes("\0")) {
        await this.recordSecurityViolation(
          context.username,
          robot.id,
          "MALFORMED_PATH_NULL_BYTE",
          { rawPath: redactSensitiveData(rawPath) }
        );
        throw new MolirisAppError(
          ErrorCode.REMOTE_FS_ERROR,
          `Percorso malformato con byte nulli rifiutato: ${redactSensitiveData(rawPath)}`,
          "Percorso specificato non valido: contiene caratteri nulli o non ammessi."
        );
      }
      if (rawPath.length > 4096) {
        throw new MolirisAppError(
          ErrorCode.REMOTE_FS_ERROR,
          "Percorso con lunghezza eccessiva (> 4096)",
          "Percorso specificato non valido: lunghezza superiore al limite consentito."
        );
      }
    }

    let targetPath = (rawPath || "").trim();

    // 2. Determinazione del punto di partenza se il percorso è vuoto o omesso (Step 3, §11.6)
    if (!targetPath) {
      if (this.config.remoteFsInitialPath && this.config.remoteFsInitialPath.trim() !== "") {
        targetPath = this.config.remoteFsInitialPath.trim();
      } else if (sftpClient) {
        // Risoluzione del punto di partenza naturale tramite il protocollo SFTP per l'account configurato
        try {
          targetPath = await new Promise<string>((resolve, reject) => {
            sftpClient.realpath(".", (err, resolved) => {
              if (err) return reject(err);
              resolve(resolved || "/");
            });
          });
        } catch {
          targetPath = "/";
        }
      } else {
        targetPath = "/";
      }
    }

    // 3. Normalizzazione POSIX standard
    const normalized = path.posix.normalize(targetPath);

    // 4. Applicazione restrizioni configurate e Jail RBAC Operatore vs Admin (RF-AUTH-005, RNF-SEC-004, RNF-SEC-005)
    const roles = context.roles || [];
    const isAdmin = roles.some((r) => {
      const lower = r.toLowerCase();
      return lower === "amministratore" || lower === "admin";
    });

    if (!isAdmin) {
      // Ruolo Operatore: limitato rigorosamente alle sole cartelle consentite (jail)
      const allowedPaths =
        this.config.remoteFsAllowedPaths && this.config.remoteFsAllowedPaths.length > 0
          ? this.config.remoteFsAllowedPaths
          : this.config.defaultOperatorAllowedPaths;

      if (allowedPaths && allowedPaths.length > 0) {
        const isAllowed = allowedPaths.some((allowed) => {
          let normAllowed = path.posix.normalize(allowed.trim());
          if (!normAllowed.startsWith("/")) {
            normAllowed = "/" + normAllowed;
          }
          return (
            normalized === normAllowed ||
            normalized.startsWith(normAllowed.endsWith("/") ? normAllowed : `${normAllowed}/`)
          );
        });

        if (!isAllowed) {
          await this.recordSecurityViolation(
            context.username,
            robot.id,
            "PATH_OUTSIDE_ALLOWED_RESTRICTIONS",
            { requestedPath: normalized, allowedPaths }
          );
          throw new MolirisAppError(
            ErrorCode.INSUFFICIENT_PERMISSIONS,
            `Accesso negato: il percorso '${normalized}' è esterno ai percorsi configurati consentiti per l'operatore`,
            `Accesso al percorso non consentito dalle restrizioni di sistema configurate per il ruolo operatore.`
          );
        }
      }
    } else {
      // Ruolo Amministratore: se configurata remoteFsAllowedPaths a livello perimetrale di sistema, verifica solo quella
      if (this.config.remoteFsAllowedPaths && this.config.remoteFsAllowedPaths.length > 0) {
        const isAllowed = this.config.remoteFsAllowedPaths.some((allowed) => {
          let normAllowed = path.posix.normalize(allowed.trim());
          if (!normAllowed.startsWith("/")) {
            normAllowed = "/" + normAllowed;
          }
          return (
            normalized === normAllowed ||
            normalized.startsWith(normAllowed.endsWith("/") ? normAllowed : `${normAllowed}/`)
          );
        });

        if (!isAllowed) {
          await this.recordSecurityViolation(
            context.username,
            robot.id,
            "PATH_OUTSIDE_ALLOWED_RESTRICTIONS",
            { requestedPath: normalized, allowedPaths: this.config.remoteFsAllowedPaths }
          );
          throw new MolirisAppError(
            ErrorCode.INSUFFICIENT_PERMISSIONS,
            `Accesso negato: il percorso '${normalized}' è esterno ai percorsi configurati consentiti`,
            `Accesso al percorso non consentito dalle restrizioni di sistema configurate.`
          );
        }
      }
    }

    return normalized;
  }

  /**
   * STEP 2 & 3 – Elenco e navigazione delle directory remote (RF-FS-001, RF-FS-002, RF-FS-003, CA-FS-001).
   * - Accesso esclusivamente lato backend tramite livello SFTP (RF-FS-004/005, vincolo 2.4).
   * - Verifica stato del robot e guardia centrale autorizzazione per robot (RF-AUTH-005).
   * - Restituisce solo i metadati restituiti dal protocollo (nome, tipo, dimensione, data modifica).
   * - Rilascio garantito delle connessioni e rispetto limiti concorrenza (RNF-PERF-003, RNF-REL-005).
   */
  public async listDirectory(
    context: AuthorizedContext,
    robot: RobotEntity,
    requestedPath?: string
  ): Promise<RemoteDirectoryListingDto> {
    // 1. Verifica autorizzazione applicativa e robot target (RF-FS-007, RF-AUTH-005, RNF-SEC-004)
    if (context.targetRobotId && context.targetRobotId !== robot.id) {
      await this.recordSecurityViolation(
        context.username,
        robot.id,
        "CROSS_ROBOT_ACCESS_ATTEMPT",
        { contextRobotId: context.targetRobotId, targetRobotId: robot.id }
      );
      throw new MolirisAppError(
        ErrorCode.INSUFFICIENT_PERMISSIONS,
        `Operazione non consentita: contesto autorizzato per un robot differente (${context.targetRobotId} != ${robot.id}).`
      );
    }

    if (!context.permissions.has(AppPermission.FS_REMOTE_NAVIGATE)) {
      await this.recordSecurityViolation(
        context.username,
        robot.id,
        "PERMISSION_DENIED_FS_REMOTE_NAVIGATE"
      );
      throw new MolirisAppError(
        ErrorCode.INSUFFICIENT_PERMISSIONS,
        `Utente '${context.username}' non autorizzato alla navigazione remota del robot '${robot.id}'.`
      );
    }

    // 2. Verifica stato del robot (RF-FS-001, §6.3, §8.4)
    this.assertRobotAccessible(robot);

    // 3. Acquisizione connessione gestita SSH/SFTP (Prompt 5, RNF-PERF-003, RNF-REL-005)
    const managedConn = await this.connectionManager.acquireConnection(context.username, robot);

    try {
      const sftp = await managedConn.getSftpClient();

      // Risoluzione e validazione del percorso richiesto
      const targetPath = await this.resolveAndValidatePath(requestedPath, context, robot, sftp);

      // Lettura contenuto directory tramite SFTP
      const rawEntries = await new Promise<any[]>((resolve, reject) => {
        sftp.readdir(targetPath, (err, list) => {
          if (err) return reject(this.mapSftpError(err, targetPath, robot.id));
          resolve(list || []);
        });
      });

      // Conversione e mappatura metadati (RF-FS-002)
      // Esclusione delle voci speciali "." e ".." (la navigazione padre è fornita da parentPath)
      const items: RemoteFileItemDto[] = [];
      for (const entry of rawEntries) {
        if (entry.filename === "." || entry.filename === "..") continue;

        const attrs = entry.attrs;
        let type: RemoteFileItemType = "file";
        if (typeof attrs?.isDirectory === "function" && attrs.isDirectory()) {
          type = "directory";
        } else if (typeof attrs?.isSymbolicLink === "function" && attrs.isSymbolicLink()) {
          type = "link";
        } else if (typeof attrs?.isFile === "function" && attrs.isFile()) {
          type = "file";
        } else if (typeof attrs?.isCharacterDevice === "function" && (attrs.isCharacterDevice() || attrs.isBlockDevice() || attrs.isFIFO() || attrs.isSocket())) {
          type = "special";
        } else if (entry.longname && entry.longname.startsWith("d")) {
          type = "directory";
        } else if (entry.longname && entry.longname.startsWith("l")) {
          type = "link";
        }

        // Dimensione: applicabile solo a file regolari, null per directory o se non disponibile
        const size = type === "directory" ? null : (typeof attrs?.size === "number" ? attrs.size : null);

        // Data di modifica: da mtime in secondi epoch, ISO string o null se non disponibile
        let modifiedAt: string | null = null;
        if (typeof attrs?.mtime === "number" && attrs.mtime > 0) {
          modifiedAt = new Date(attrs.mtime * 1000).toISOString();
        }

        items.push({
          name: entry.filename,
          type,
          size,
          modifiedAt,
        });
      }

      // Ordinamento: directory per prime, poi alfabetico per nome
      items.sort((a, b) => {
        if (a.type === "directory" && b.type !== "directory") return -1;
        if (a.type !== "directory" && b.type === "directory") return 1;
        return a.name.localeCompare(b.name);
      });

      const totalCount = items.length;
      let truncated = false;

      // Gestione directory con molti elementi tramite parametro di configurazione (RNF-PERF-002, Step 2)
      if (this.config.remoteFsMaxDirectoryEntries && this.config.remoteFsMaxDirectoryEntries > 0) {
        if (items.length > this.config.remoteFsMaxDirectoryEntries) {
          items.splice(this.config.remoteFsMaxDirectoryEntries);
          truncated = true;
        }
      }

      // Calcolo parentPath (RF-FS-003, CA-FS-001)
      const parentPath = targetPath === "/" ? null : path.posix.dirname(targetPath);

      const mappedEntries = items.map((it) => ({
        name: it.name,
        type: it.type === "directory" ? ("directory" as const) : (it.type === "link" ? ("symlink" as const) : ("file" as const)),
        size: typeof it.size === "number" ? it.size : 0,
        mtime: it.modifiedAt || new Date().toISOString(),
        modifiedAt: it.modifiedAt || new Date().toISOString(),
      }));

      return {
        robotId: robot.id,
        currentPath: targetPath,
        parentPath,
        items,
        entries: mappedEntries,
        totalCount,
        truncated,
        isTruncated: truncated,
      };
    } finally {
      // Rilascio garantito della connessione (RNF-REL-005)
      await managedConn.close();
    }
  }

  /**
   * STEP 5 – Punto di accesso per download in streaming verso il Prompt 10 (RF-FS-004, RNF-PERF-001, RNF-REL-005).
   * Modulo interno NON esposto direttamente al frontend.
   * Restituisce un flusso in lettura (Readable stream) con rilascio garantito delle risorse.
   */
  public async openRemoteReadStream(
    context: AuthorizedContext,
    robot: RobotEntity,
    remotePath: string,
    options?: { start?: number }
  ): Promise<RemoteReadStreamHandle> {
    // 1. Verifica autorizzazione specifica di download (RF-FS-007, RF-FS-004)
    if (context.targetRobotId && context.targetRobotId !== robot.id) {
      await this.recordSecurityViolation(
        context.username,
        robot.id,
        "CROSS_ROBOT_ACCESS_ATTEMPT",
        { contextRobotId: context.targetRobotId, targetRobotId: robot.id }
      );
      throw new MolirisAppError(
        ErrorCode.INSUFFICIENT_PERMISSIONS,
        `Operazione non consentita: contesto autorizzato per un robot differente.`
      );
    }

    if (!context.permissions.has(AppPermission.FS_REMOTE_DOWNLOAD)) {
      await this.recordSecurityViolation(
        context.username,
        robot.id,
        "PERMISSION_DENIED_FS_REMOTE_DOWNLOAD"
      );
      throw new MolirisAppError(
        ErrorCode.INSUFFICIENT_PERMISSIONS,
        `Utente '${context.username}' non autorizzato allo scaricamento di file dal robot '${robot.id}'.`
      );
    }

    this.assertRobotAccessible(robot);

    // 2. Acquisizione connessione gestita
    const managedConn = await this.connectionManager.acquireConnection(context.username, robot);

    try {
      const sftp = await managedConn.getSftpClient();
      const targetPath = await this.resolveAndValidatePath(remotePath, context, robot, sftp);

      // Verifica che il percorso esista e gestione symlink / file speciali (Problema C1, RF-FS-002, RF-FS-007)
      await new Promise<void>((resolve, reject) => {
        const processStats = async (stats: any, isLstat: boolean) => {
          // 1. Rifiuto directory
          if (typeof stats.isDirectory === "function" && stats.isDirectory()) {
            return reject(
              new MolirisAppError(
                ErrorCode.REMOTE_FS_ERROR,
                `Tentativo di download su directory: ${targetPath}`,
                "Impossibile scaricare: il percorso indicato è una directory."
              )
            );
          }

          // 2. Rifiuto categorico di file speciali: device, socket, FIFO (Problema C1 punto c)
          const isSpecial =
            (typeof stats.isCharacterDevice === "function" && stats.isCharacterDevice()) ||
            (typeof stats.isBlockDevice === "function" && stats.isBlockDevice()) ||
            (typeof stats.isFIFO === "function" && stats.isFIFO()) ||
            (typeof stats.isSocket === "function" && stats.isSocket());
          if (isSpecial) {
            return reject(
              new MolirisAppError(
                ErrorCode.REMOTE_FS_ERROR,
                `Tentativo di download su file speciale (device, socket, FIFO): ${targetPath}`,
                "Download non consentito: i file speciali di sistema non sono scaricabili."
              )
            );
          }

          // 3. Gestione Symlink (Problema C1 punto b): consentito solo se target è file regolare e ricade nei percorsi ammessi
          if (isLstat && typeof stats.isSymbolicLink === "function" && stats.isSymbolicLink()) {
            sftp.stat(targetPath, async (stErr, targetStats) => {
              if (stErr) return reject(this.mapSftpError(stErr, targetPath, robot.id));

              if (typeof targetStats.isDirectory === "function" && targetStats.isDirectory()) {
                return reject(
                  new MolirisAppError(
                    ErrorCode.REMOTE_FS_ERROR,
                    `Symlink punta a una directory: ${targetPath}`,
                    "Impossibile scaricare: il link simbolico punta a una directory."
                  )
                );
              }

              if (typeof targetStats.isFile === "function" && !targetStats.isFile()) {
                return reject(
                  new MolirisAppError(
                    ErrorCode.REMOTE_FS_ERROR,
                    `Symlink non punta a un file regolare: ${targetPath}`,
                    "Download non consentito: il link simbolico non punta a un file regolare."
                  )
                );
              }

              // Se sono configurati i percorsi consentiti, verifica che il target ricada nei percorsi autorizzati
              if (this.config.remoteFsAllowedPaths && this.config.remoteFsAllowedPaths.length > 0) {
                try {
                  const resolvedTarget = await new Promise<string>((res, rej) => {
                    sftp.realpath(targetPath, (rpErr, rpath) => {
                      if (rpErr) return rej(rpErr);
                      res(rpath || "/");
                    });
                  });

                  const normResolved = path.posix.normalize(resolvedTarget);
                  const isAllowed = this.config.remoteFsAllowedPaths.some((allowed) => {
                    const normAllowed = path.posix.normalize(allowed.trim());
                    return (
                      normResolved === normAllowed ||
                      normResolved.startsWith(normAllowed.endsWith("/") ? normAllowed : `${normAllowed}/`)
                    );
                  });

                  if (!isAllowed) {
                    await this.recordSecurityViolation(
                      context.username,
                      robot.id,
                      "SYMLINK_TARGET_OUTSIDE_ALLOWED_RESTRICTIONS",
                      { targetPath: normResolved, allowedPaths: this.config.remoteFsAllowedPaths }
                    );
                    return reject(
                      new MolirisAppError(
                        ErrorCode.INSUFFICIENT_PERMISSIONS,
                        `Accesso negato: il link simbolico punta a un percorso esterno a quelli autorizzati ('${normResolved}')`,
                        "Accesso al file non consentito dalle restrizioni di sistema configurate."
                      )
                    );
                  }
                } catch (rpErr: any) {
                  return reject(this.mapSftpError(rpErr, targetPath, robot.id));
                }
              }

              resolve();
            });
            return;
          }

          // 4. File normale
          if (typeof stats.isFile === "function" && !stats.isFile()) {
            return reject(
              new MolirisAppError(
                ErrorCode.REMOTE_FS_ERROR,
                `Il percorso non è un file regolare: ${targetPath}`,
                "Impossibile scaricare: il percorso indicato non è un file regolare."
              )
            );
          }

          resolve();
        };

        sftp.lstat(targetPath, async (lerr, lstats) => {
          if (lerr) {
            // Se lstat non è supportato dall'SFTP server (code 8 / OP_UNSUPPORTED), fallback trasparente su stat
            if ((lerr as any).code === 8 || (lerr as any).message?.toLowerCase().includes("unsupported")) {
              sftp.stat(targetPath, async (serr, sstats) => {
                if (serr) return reject(this.mapSftpError(serr, targetPath, robot.id));
                await processStats(sstats, false);
              });
              return;
            }
            return reject(this.mapSftpError(lerr, targetPath, robot.id));
          }
          await processStats(lstats, true);
        });
      });

      // Apertura flusso di lettura ad alte prestazioni con sliding window pipelined (RNF-PERF-001)
      let stream: Readable;
      if (typeof (sftp as any).open === "function") {
        let fileSize: number | null = null;
        try {
          const statRes: any = await new Promise((resolve) => sftp.stat(targetPath, (err, st) => resolve(err ? null : st)));
          if (statRes && typeof statRes.size === "number") {
            fileSize = statRes.size;
          }
        } catch {}

        stream = new PipelinedSftpReadStream(sftp, targetPath, fileSize, {
          concurrency: 32,
          chunkSize: 32768,
          highWaterMark: this.getTransferBufferSize(),
          ...(options?.start !== undefined ? { start: options.start } : {}),
        });
      } else {
        stream = sftp.createReadStream(targetPath, {
          autoClose: true,
          highWaterMark: this.getTransferBufferSize(),
          ...(options?.start !== undefined ? { start: options.start } : {}),
        });
      }

      let closed = false;
      const cleanup = async () => {
        if (closed) return;
        closed = true;
        try {
          stream.destroy();
        } catch {}
        await managedConn.close();
      };

      stream.once("close", () => cleanup());
      stream.once("error", () => cleanup());

      return {
        stream,
        cleanup,
      };
    } catch (err) {
      await managedConn.close();
      throw err;
    }
  }

  /**
   * STEP 5 – Punto di accesso per upload in streaming verso il Prompt 10 (RF-FS-005, RNF-PERF-001, RNF-REL-005).
   * Modulo interno NON esposto direttamente al frontend.
   * Restituisce un flusso in scrittura (Writable stream) con controllo di sovrascrittura (§11.5).
   */
  public async openRemoteWriteStream(
    context: AuthorizedContext,
    robot: RobotEntity,
    remotePath: string,
    options?: RemoteWriteStreamOptions
  ): Promise<RemoteWriteStreamHandle> {
    // 1. Verifica autorizzazione specifica di upload (RF-FS-007, RF-FS-005)
    if (context.targetRobotId && context.targetRobotId !== robot.id) {
      await this.recordSecurityViolation(
        context.username,
        robot.id,
        "CROSS_ROBOT_ACCESS_ATTEMPT",
        { contextRobotId: context.targetRobotId, targetRobotId: robot.id }
      );
      throw new MolirisAppError(
        ErrorCode.INSUFFICIENT_PERMISSIONS,
        `Operazione non consentita: contesto autorizzato per un robot differente.`
      );
    }

    if (!context.permissions.has(AppPermission.FS_REMOTE_UPLOAD)) {
      await this.recordSecurityViolation(
        context.username,
        robot.id,
        "PERMISSION_DENIED_FS_REMOTE_UPLOAD"
      );
      throw new MolirisAppError(
        ErrorCode.INSUFFICIENT_PERMISSIONS,
        `Utente '${context.username}' non autorizzato al caricamento di file sul robot '${robot.id}'.`
      );
    }

    this.assertRobotAccessible(robot);

    // 2. Acquisizione connessione gestita
    const managedConn = await this.connectionManager.acquireConnection(context.username, robot);

    try {
      const sftp = await managedConn.getSftpClient();
      const targetPath = await this.resolveAndValidatePath(remotePath, context, robot, sftp);

      // 3. Politica di sovrascrittura (Step 5, §11.5, RF-TRF-011)
      // La politica è aperta; rifiuta la sovrascrittura silenziosa se non esplicitamente autorizzata
      const overwriteAllowed = options?.overwrite ?? (this.config.remoteFsOverwritePolicy === "sovrascrivi");

      const fileExists = await new Promise<boolean>((resolve) => {
        sftp.stat(targetPath, (err) => {
          if (!err) resolve(true);
          else resolve(false);
        });
      });

      if (fileExists && !overwriteAllowed) {
        throw new MolirisAppError(
          ErrorCode.REMOTE_FS_ERROR,
          `File remoto già esistente '${targetPath}': sovrascrittura rifiutata da politica di sicurezza`,
          "Sovrascrittura non consentita: il file remoto esiste già."
        );
      }

      // Apertura flusso di scrittura ad alte prestazioni con sliding window pipelined (RNF-PERF-001)
      const stream = new PipelinedSftpWriteStream(sftp, targetPath, {
        flags: "w",
        concurrency: 32,
        chunkSize: 32768,
        highWaterMark: this.getTransferBufferSize(),
      });

      let closed = false;
      const cleanup = async () => {
        if (closed) return;
        closed = true;
        try {
          stream.destroy();
        } catch {}
        await managedConn.close();
      };

      stream.once("close", () => cleanup());
      stream.once("error", () => cleanup());
      stream.once("finish", () => cleanup());

      return {
        stream,
        cleanup,
      };
    } catch (err) {
      await managedConn.close();
      throw err;
    }
  }

  /**
   * STEP 5 – Metadati e dimensione di un file remoto per avanzamento e controllo spazio (RF-TRF-006, RF-TRF-014).
   * Modulo interno per il servizio di trasferimento (Prompt 10).
   */
  public async getRemoteFileStats(
    context: AuthorizedContext,
    robot: RobotEntity,
    remotePath: string
  ): Promise<RemoteFileItemDto> {
    if (context.targetRobotId && context.targetRobotId !== robot.id) {
      throw new MolirisAppError(
        ErrorCode.INSUFFICIENT_PERMISSIONS,
        `Operazione non consentita: contesto autorizzato per un robot differente.`
      );
    }

    if (!context.permissions.has(AppPermission.FS_REMOTE_NAVIGATE) && !context.permissions.has(AppPermission.FS_REMOTE_DOWNLOAD)) {
      throw new MolirisAppError(
        ErrorCode.INSUFFICIENT_PERMISSIONS,
        `Utente '${context.username}' non autorizzato alla consultazione metadati del robot '${robot.id}'.`
      );
    }

    this.assertRobotAccessible(robot);

    const managedConn = await this.connectionManager.acquireConnection(context.username, robot);
    try {
      const sftp = await managedConn.getSftpClient();
      const targetPath = await this.resolveAndValidatePath(remotePath, context, robot, sftp);

      const stats = await new Promise<any>((resolve, reject) => {
        sftp.stat(targetPath, (err, res) => {
          if (err) return reject(this.mapSftpError(err, targetPath, robot.id));
          resolve(res);
        });
      });

      let type: RemoteFileItemType = "file";
      if (stats.isDirectory()) type = "directory";
      else if (stats.isSymbolicLink()) type = "link";

      return {
        name: path.posix.basename(targetPath),
        type,
        size: type === "directory" ? null : stats.size,
        modifiedAt: stats.mtime ? new Date(stats.mtime * 1000).toISOString() : null,
      };
    } finally {
      await managedConn.close();
    }
  }

  /**
   * Eliminazione controllata di un file sul filesystem remoto del robot via SFTP (RF-FS-007, RNF-FS-003, RF-ROB-013).
   * Verifica permessi (FS_REMOTE_DELETE), isolamento robot, validazione percorso ed esclusione directory.
   */
  public async deleteRemoteFile(
    context: AuthorizedContext,
    robot: RobotEntity,
    remotePath: string
  ): Promise<void> {
    if (context.targetRobotId && context.targetRobotId !== robot.id) {
      await this.recordSecurityViolation(
        context.username,
        robot.id,
        "CROSS_ROBOT_ACCESS_ATTEMPT",
        { contextRobotId: context.targetRobotId, targetRobotId: robot.id }
      );
      throw new MolirisAppError(
        ErrorCode.INSUFFICIENT_PERMISSIONS,
        `Operazione non consentita: contesto autorizzato per un robot differente.`
      );
    }

    if (!context.permissions.has(AppPermission.FS_REMOTE_DELETE)) {
      await this.recordSecurityViolation(
        context.username,
        robot.id,
        "PERMISSION_DENIED_FS_REMOTE_DELETE"
      );
      throw new MolirisAppError(
        ErrorCode.INSUFFICIENT_PERMISSIONS,
        `Utente '${context.username}' non autorizzato all'eliminazione di file sul robot '${robot.id}'.`
      );
    }

    this.assertRobotAccessible(robot);

    const managedConn = await this.connectionManager.acquireConnection(context.username, robot);
    try {
      const sftp = await managedConn.getSftpClient();
      const targetPath = await this.resolveAndValidatePath(remotePath, context, robot, sftp);

      const stats = await new Promise<any>((resolve, reject) => {
        sftp.stat(targetPath, (err, res) => {
          if (err) return reject(this.mapSftpError(err, targetPath, robot.id));
          resolve(res);
        });
      });

      if (stats.isDirectory()) {
        throw new MolirisAppError(
          ErrorCode.REMOTE_FS_ERROR,
          `Impossibile eliminare una directory: ${targetPath}`,
          "Impossibile eliminare: il percorso selezionato sul robot è una directory."
        );
      }

      await new Promise<void>((resolve, reject) => {
        sftp.unlink(targetPath, (err) => {
          if (err) return reject(this.mapSftpError(err, targetPath, robot.id));
          resolve();
        });
      });

      this.logger.info("File eliminato con successo dal filesystem remoto del robot", {
        robotId: robot.id,
        file: path.posix.basename(targetPath),
        path: redactSensitiveData(targetPath),
        user: context.username,
      });
    } finally {
      await managedConn.close();
    }
  }

  /**
   * Verifica preventiva accessibilità del robot (Step 1, RF-FS-001, §6.3, §8.4).
   */
  private assertRobotAccessible(robot: RobotEntity): void {
    if (robot.anagraphicState === "disabilitato" || robot.anagraphicState === "rimosso") {
      throw new MolirisAppError(
        ErrorCode.INSUFFICIENT_PERMISSIONS,
        `Robot '${robot.id}' in stato '${robot.anagraphicState}': operazioni sul filesystem remoto bloccate.`
      );
    }

    if (robot.registrationState === "ssh_non_verificata") {
      throw new MolirisAppError(
        ErrorCode.HOST_UNREACHABLE,
        `Impossibile accedere al filesystem: la connessione SSH del robot non è stata ancora verificata. Eseguire la verifica preliminare.`
      );
    }

    if (robot.connectionState === "non_raggiungibile") {
      throw new MolirisAppError(
        ErrorCode.HOST_UNREACHABLE,
        `Impossibile accedere al filesystem: il robot '${robot.id}' non è attualmente raggiungibile sulla rete.`
      );
    }
  }

  /**
   * STEP 6 – Mappatura degli errori del filesystem remoto e SFTP (RF-FS-006, §9).
   * Distingue file inesistente, permessi insufficienti, connessione interrotta, timeout e operazioni non consentite.
   * Restituisce messaggi chiari e sicuri all'utente, riservando i dettagli tecnici ai log (RNF-SEC-002).
   */
  public mapSftpError(err: any, remotePath: string, robotId: string): MolirisAppError {
    const msg = (err?.message || "").toLowerCase();
    const code = err?.code;

    this.logger.error("Errore operazione SFTP filesystem remoto", err?.message, {
      robotId,
      path: redactSensitiveData(remotePath),
      code,
    });

    // 1. File o directory inesistente (ENOENT, SSH_FX_NO_SUCH_FILE = 2)
    if (code === 2 || code === "ENOENT" || msg.includes("no such file") || msg.includes("not found")) {
      return new MolirisAppError(
        ErrorCode.REMOTE_FS_ERROR,
        `Percorso remoto non trovato: ${redactSensitiveData(remotePath)}`,
        "File o directory non presente sul filesystem del robot."
      );
    }

    // 2. Permessi insufficienti (EACCES, EPERM, SSH_FX_PERMISSION_DENIED = 3)
    if (code === 3 || code === "EACCES" || code === "EPERM" || msg.includes("permission denied")) {
      return new MolirisAppError(
        ErrorCode.INSUFFICIENT_PERMISSIONS,
        `Permessi insufficienti su percorso remoto: ${redactSensitiveData(remotePath)}`,
        "Permessi insufficienti per accedere al percorso sul robot."
      );
    }

    // 3. Operazione non consentita / non supportata (SSH_FX_OP_UNSUPPORTED = 8)
    if (code === 8 || msg.includes("unsupported") || msg.includes("not permitted")) {
      return new MolirisAppError(
        ErrorCode.REMOTE_FS_ERROR,
        `Operazione non consentita sul percorso remoto: ${redactSensitiveData(remotePath)}`,
        "Operazione non consentita sul filesystem del robot."
      );
    }

    // 4. Timeout
    if (code === "ETIMEDOUT" || msg.includes("timed out") || msg.includes("timeout")) {
      return new MolirisAppError(
        ErrorCode.TIMEOUT_ERROR,
        `Timeout connessione SFTP verso robot '${robotId}': ${err?.message}`
      );
    }

    // 5. Connessione interrotta / socket chiuso / errore di rete (RNF-REL-001)
    if (
      code === "ECONNRESET" ||
      code === "EPIPE" ||
      msg.includes("closed") ||
      msg.includes("ended") ||
      msg.includes("reset")
    ) {
      return new MolirisAppError(
        ErrorCode.HOST_UNREACHABLE,
        `Connessione con il robot '${robotId}' interrotta durante l'operazione SFTP: ${err?.message}`,
        "Connessione con il robot interrotta durante l'operazione."
      );
    }

    // 6. Errore generico di lettura o scrittura remota (§9)
    return new MolirisAppError(
      ErrorCode.REMOTE_FS_ERROR,
      `Errore SFTP remoto: ${redactSensitiveData(err?.message || "Errore sconosciuto")}`,
      "Impossibile completare l'operazione sul filesystem del robot."
    );
  }

  /**
   * STEP 8 – Registrazione delle violazioni di sicurezza ed errori di autorizzazione (RNF-SEC-009, §10.4).
   * La SRS NON elenca la semplice navigazione tra gli eventi di audit: NON registrarla.
   */
  private async recordSecurityViolation(
    username: string,
    robotId: string,
    reason: string,
    extraDetails?: Record<string, unknown>
  ): Promise<void> {
    try {
      await this.auditRepository.record({
        userId: username,
        operation: AuditOperation.SECURITY_AUTHORIZATION_ERROR,
        robotId,
        outcome: "FAILURE",
        timestamp: new Date(),
        details: {
          reason,
          ...extraDetails,
        },
      });
    } catch (auditErr: any) {
      this.logger.error("Errore salvataggio audit violazione sicurezza", auditErr.message);
    }
  }
}
