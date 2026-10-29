// Requisiti soddisfatti: RF-FS-001, RF-FS-002, RF-FS-003, RF-FS-004, RF-FS-005, RF-FS-006, RF-FS-007,
// RNF-SEC-004, RNF-SEC-005, RNF-SEC-006, RNF-SEC-009, RNF-PERF-001, RNF-PERF-002, RNF-REL-001, RNF-REL-005,
// SRS §1.2, §5.5, §9, §10.3, §11.5, §11.6, §11.7, CA-FS-001

import path from "path";
import { type Readable, type Writable } from "stream";
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

    // 4. Applicazione restrizioni configurate se presenti (Step 3)
    // Se non configurate, l'accesso reale è determinato esclusivamente dai permessi dell'account Linux (RF-FS-007)
    if (this.config.remoteFsAllowedPaths && this.config.remoteFsAllowedPaths.length > 0) {
      const isAllowed = this.config.remoteFsAllowedPaths.some((allowed) => {
        const normAllowed = path.posix.normalize(allowed.trim());
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

      return {
        robotId: robot.id,
        currentPath: targetPath,
        parentPath,
        items,
        totalCount,
        truncated,
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
    remotePath: string
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

      // Verifica che il percorso esista e sia un file
      await new Promise<void>((resolve, reject) => {
        sftp.stat(targetPath, (err, stats) => {
          if (err) return reject(this.mapSftpError(err, targetPath, robot.id));
          if (stats.isDirectory()) {
            return reject(
              new MolirisAppError(
                ErrorCode.REMOTE_FS_ERROR,
                `Tentativo di download su directory: ${targetPath}`,
                "Impossibile scaricare: il percorso indicato è una directory."
              )
            );
          }
          resolve();
        });
      });

      // Apertura flusso di lettura (senza buffer in RAM, RNF-PERF-001)
      const stream = sftp.createReadStream(targetPath, { autoClose: true });

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

      // Apertura flusso di scrittura (senza caricare in RAM l'intero file, RNF-PERF-001)
      const stream = sftp.createWriteStream(targetPath, { flags: "w", autoClose: true });

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
  private mapSftpError(err: any, remotePath: string, robotId: string): MolirisAppError {
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
