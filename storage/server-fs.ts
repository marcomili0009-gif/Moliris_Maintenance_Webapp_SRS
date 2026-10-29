// Requisiti soddisfatti: SRS §5.6, §3.6, §4.2, §8.2, §10.3, §11.1, §11.3, §11.5,
// RF-SRVFS-001..007, RF-ROB-008, RF-ROB-009, RF-ROB-010, RF-FS-002,
// RNF-SEC-005, RNF-SEC-007, RNF-SEC-008, RNF-FS-001..004,
// CA-ROB-004, CA-ROB-005, CA-ROB-007, CA-ROB-008, CA-ROB-009, CA-ROB-011

import fs from "fs";
import path from "path";
import { type Readable, type Writable } from "stream";
import { type RobotEntity } from "./robot-models.ts";
import { type AuthorizedContext } from "../backend/auth/session-manager.ts";
import { AppPermission } from "../backend/auth/permissions.ts";
import { MolirisAppError, ErrorCode } from "../errors/app-errors.ts";
import { type AuditRepository } from "./audit-repository.ts";
import { AuditOperation } from "./audit-models.ts";
import { MolirisLogger } from "../logging/logger.ts";

/**
 * Risultato della creazione della directory di un robot (RF-ROB-008, RF-ROB-009, RNF-FS-004)
 */
export interface DirectoryCreationResult {
  robotId: string;
  serverDirectoryPath: string;
  created: boolean;        // true se creata ex-novo
  alreadyExisted: boolean; // true se già presente sul filesystem
  createdDirectories: string[]; // Percorsi creati in questa specifica chiamata (per rollback selettivo)
  standardSubdirectoriesCreated: string[];
}

/**
 * Risultato del rollback della directory (RF-ROB-010, CA-ROB-008)
 */
export interface RollbackResult {
  rolledBack: boolean;
  reason?: string;
  removedDirectories: string[];
}

/**
 * Elemento del filesystem server restituito durante la navigazione (RF-SRVFS-002, RF-FS-002)
 * Coerente con la struttura prevista per il filesystem remoto per uniformità di interfaccia.
 */
export interface ServerFileItem {
  name: string;
  type: "file" | "directory";
  size: number | null; // Byte per file regolari, null per directory
  modifiedAt: Date;
}

export class ServerFilesystemService {
  private fsRoot: string;
  private auditRepository: AuditRepository;
  private logger: MolirisLogger;

  constructor(fsRoot: string, auditRepository: AuditRepository, logger: MolirisLogger) {
    if (!fsRoot || fsRoot.trim() === "") {
      throw new Error("La root del filesystem server deve essere definita da configurazione (RNF-MNT-001, RF-SRVFS-001).");
    }
    this.fsRoot = path.resolve(fsRoot.trim());
    this.auditRepository = auditRepository;
    this.logger = logger;
  }

  /**
   * Risolve e valida in modo sicuro un percorso relativo all'interno della directory del robot (RNF-SEC-005, CA-ROB-009).
   * Rifiuta percorsi assoluti, path traversal ("..", sequenze codificate), link simbolici che fuoriescono.
   */
  public async resolveRobotPath(
    robot: Pick<RobotEntity, "id" | "remoteUsername" | "host" | "serverDirectoryPath">,
    relativeSubPath?: string
  ): Promise<string> {
    const robotDir = path.resolve(robot.serverDirectoryPath);

    // Se non è specificato alcun sotto-percorso o è vuoto, restituisce la root del robot
    if (!relativeSubPath || relativeSubPath.trim() === "" || relativeSubPath.trim() === ".") {
      return robotDir;
    }

    const subPath = relativeSubPath.trim();

    // 1. Rifiuto di byte nulli o caratteri di controllo
    if (subPath.includes("\0")) {
      await this.recordPathTraversalViolation(robot.id, subPath, "NULL_BYTE_DETECTED");
      throw new MolirisAppError(ErrorCode.SERVER_DIR_INACCESSIBLE, "Percorso non valido: sequenza non consentita.");
    }

    // 2. Rifiuto di percorsi assoluti forniti dall'utente (es. /etc/passwd o C:\)
    if (path.isAbsolute(subPath) || /^[a-zA-Z]:/.test(subPath)) {
      await this.recordPathTraversalViolation(robot.id, subPath, "ABSOLUTE_PATH_REJECTED");
      throw new MolirisAppError(ErrorCode.SERVER_DIR_INACCESSIBLE, "Percorso non consentito: percorsi assoluti rifiutati.");
    }

    // 3. Rifiuto di sequenze esplicite di path traversal o varianti codificate
    if (/(?:^|[\\/])\.\.(?:[\\/]|$)/.test(subPath) || /%2e%2e/i.test(subPath)) {
      await this.recordPathTraversalViolation(robot.id, subPath, "PATH_TRAVERSAL_DETECTED");
      throw new MolirisAppError(ErrorCode.SERVER_DIR_INACCESSIBLE, "Percorso non consentito: attraversamento directory non autorizzato.");
    }

    // 4. Risoluzione normalizzata rispetto alla directory del robot
    const resolvedPath = path.resolve(robotDir, subPath);

    // 5. Verifica che il percorso normalizzato inizi tassativamente con la directory del robot
    if (!resolvedPath.startsWith(robotDir + path.sep) && resolvedPath !== robotDir) {
      await this.recordPathTraversalViolation(robot.id, subPath, "PATH_ESCAPED_ROBOT_DIR");
      throw new MolirisAppError(ErrorCode.SERVER_DIR_INACCESSIBLE, "Percorso non consentito: accesso all'esterno della directory del robot negato.");
    }

    // 6. Verifica link simbolici: se il file/directory esiste, il percorso reale (canonical) deve essere interno
    try {
      if (fs.existsSync(resolvedPath)) {
        const realTarget = await fs.promises.realpath(resolvedPath);
        let realRobotDir = robotDir;
        if (fs.existsSync(robotDir)) {
          realRobotDir = await fs.promises.realpath(robotDir);
        }
        if (!realTarget.startsWith(realRobotDir + path.sep) && realTarget !== realRobotDir) {
          await this.recordPathTraversalViolation(robot.id, subPath, "SYMLINK_ESCAPED_ROOT");
          throw new MolirisAppError(ErrorCode.SERVER_DIR_INACCESSIBLE, "Percorso non consentito: collegamento simbolico esterno non autorizzato.");
        }
      }
    } catch (err: any) {
      if (err instanceof MolirisAppError) throw err;
      // Se il file non esiste ancora (es. creazione nuovo file), la verifica sintattica del punto 5 è già valida
    }

    return resolvedPath;
  }

  /**
   * Crea in modo idempotente la directory dedicata per il robot e le eventuali sottodirectory standard
   * (RF-ROB-008, RF-ROB-009, RF-SRVFS-006, RNF-FS-004, CA-ROB-004, CA-ROB-005, CA-ROB-007).
   */
  public async ensureRobotDirectory(
    robot: Pick<RobotEntity, "id" | "remoteUsername" | "host" | "serverDirectoryPath">,
    options?: { standardSubdirectories?: string[]; directoryPermissions?: string }
  ): Promise<DirectoryCreationResult> {
    const robotDir = path.resolve(robot.serverDirectoryPath);

    // CA-ROB-007: Verifica che la root del server esista e sia accessibile in scrittura
    try {
      await fs.promises.access(this.fsRoot, fs.constants.W_OK | fs.constants.R_OK);
    } catch (err: any) {
      this.logger.error("Root filesystem server non accessibile in scrittura", err.message, { fsRoot: this.fsRoot });
      throw new MolirisAppError(
        ErrorCode.SERVER_DIR_INACCESSIBLE,
        "Archivio server non accessibile. Impossibile inizializzare la directory del robot."
      );
    }

    const createdDirectories: string[] = [];
    const standardSubdirectoriesCreated: string[] = [];
    let alreadyExisted = false;

    // Convalida permessi cartella se configurati (§11.1, RNF-FS-001)
    const mode = options?.directoryPermissions ? parseInt(options.directoryPermissions, 8) : undefined;

    try {
      if (fs.existsSync(robotDir)) {
        // CA-ROB-005, RF-SRVFS-006: se esiste già, non sovrascrive né altera i dati esistenti
        alreadyExisted = true;
      } else {
        await fs.promises.mkdir(robotDir, { recursive: true, mode });
        createdDirectories.push(robotDir);
      }

      // Creazione idempotente delle sottodirectory standard opzionali (RF-ROB-009, RF-SRVFS-007)
      if (options?.standardSubdirectories && options.standardSubdirectories.length > 0) {
        for (const subName of options.standardSubdirectories) {
          const subPath = await this.resolveRobotPath(robot, subName);
          if (!fs.existsSync(subPath)) {
            await fs.promises.mkdir(subPath, { recursive: true, mode });
            createdDirectories.push(subPath);
            standardSubdirectoriesCreated.push(subName);
          }
        }
      }

      return {
        robotId: robot.id,
        serverDirectoryPath: robotDir,
        created: !alreadyExisted,
        alreadyExisted,
        createdDirectories,
        standardSubdirectoriesCreated,
      };
    } catch (err: any) {
      if (err instanceof MolirisAppError) throw err;
      this.logger.error("Errore durante creazione directory robot", err.message, { robotId: robot.id, path: robotDir });
      throw new MolirisAppError(
        ErrorCode.SERVER_DIR_INACCESSIBLE,
        "Errore durante l'accesso o la creazione della directory sul server."
      );
    }
  }

  /**
   * Annulla le operazioni reversibili di creazione directory rimuovendo SOLO quanto creato in questa chiamata,
   * e SOLO se la directory è vuota, per garantire l'assenza totale di perdita dati (RF-ROB-010, CA-ROB-008, CA-ROB-011).
   */
  public async rollbackRobotDirectory(creationResult: DirectoryCreationResult): Promise<RollbackResult> {
    if (creationResult.alreadyExisted) {
      // Non tocca mai directory preesistenti
      return { rolledBack: false, reason: "ALREADY_EXISTED", removedDirectories: [] };
    }

    const removedDirectories: string[] = [];

    // Rimozione a ritroso delle directory create
    const toRemove = [...creationResult.createdDirectories].reverse();

    for (const dir of toRemove) {
      try {
        if (fs.existsSync(dir)) {
          const files = await fs.promises.readdir(dir);
          // Rimuove la cartella solo ed esclusivamente se è priva di file
          if (files.length === 0) {
            await fs.promises.rmdir(dir);
            removedDirectories.push(dir);
          } else {
            this.logger.info(`Rollback saltato per directory non vuota: ${dir}`);
          }
        }
      } catch (err: any) {
        this.logger.error("Errore parziale durante rollback directory", err.message, { dir });
      }
    }

    return {
      rolledBack: removedDirectories.length > 0,
      removedDirectories,
    };
  }

  /**
   * Elenca il contenuto di una directory del robot sul server (RF-SRVFS-002).
   * Richiede contesto autorizzato per il robot selezionato (RF-SRVFS-005, RNF-FS-002, RNF-SEC-007).
   */
  public async listDirectory(
    context: AuthorizedContext,
    robot: RobotEntity,
    relativeSubPath?: string
  ): Promise<ServerFileItem[]> {
    this.assertAuthorizedContext(context, robot, AppPermission.FS_SERVER_NAVIGATE);

    const targetDir = await this.resolveRobotPath(robot, relativeSubPath);

    try {
      if (!fs.existsSync(targetDir)) {
        throw new MolirisAppError(ErrorCode.SERVER_DIR_INACCESSIBLE, "Percorso specificato non trovato.");
      }

      const stat = await fs.promises.stat(targetDir);
      if (!stat.isDirectory()) {
        throw new MolirisAppError(ErrorCode.SERVER_DIR_INACCESSIBLE, "Il percorso specificato non è una directory.");
      }

      const entries = await fs.promises.readdir(targetDir, { withFileTypes: true });
      const items: ServerFileItem[] = [];

      for (const entry of entries) {
        const fullItemPath = path.join(targetDir, entry.name);
        try {
          const itemStat = await fs.promises.stat(fullItemPath);
          items.push({
            name: entry.name,
            type: entry.isDirectory() ? "directory" : "file",
            size: entry.isDirectory() ? null : itemStat.size,
            modifiedAt: itemStat.mtime,
          });
        } catch {
          // Se un file temporaneo o speciale non è leggibile, viene omesso in sicurezza
        }
      }

      // Ordinamento alfabetico con directory per prime
      items.sort((a, b) => {
        if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

      return items;
    } catch (err: any) {
      if (err instanceof MolirisAppError) throw err;
      this.logger.error("Errore lettura directory server", err.message, { robotId: robot.id, path: targetDir });
      throw new MolirisAppError(ErrorCode.SERVER_DIR_INACCESSIBLE, "Impossibile leggere il contenuto della directory server.");
    }
  }

  /**
   * Predisposizione per lo streaming in lettura (RF-SRVFS-004, Prompt 10).
   * Restituisce un Readable stream del file verificato.
   */
  public async openFileReadStream(
    context: AuthorizedContext,
    robot: RobotEntity,
    relativeFilePath: string
  ): Promise<Readable> {
    this.assertAuthorizedContext(context, robot, AppPermission.FS_SERVER_DOWNLOAD);

    const targetPath = await this.resolveRobotPath(robot, relativeFilePath);
    if (!fs.existsSync(targetPath)) {
      throw new MolirisAppError(ErrorCode.SERVER_DIR_INACCESSIBLE, "File specificato non trovato sul server.");
    }

    const stat = await fs.promises.stat(targetPath);
    if (!stat.isFile()) {
      throw new MolirisAppError(ErrorCode.SERVER_DIR_INACCESSIBLE, "Il percorso specificato non è un file regolare.");
    }

    return fs.createReadStream(targetPath);
  }

  /**
   * Predisposizione per lo streaming in scrittura (RF-SRVFS-003, RF-TRF-011, RNF-FS-003, Prompt 10).
   * Blocca la sovrascrittura silenziosa se non esplicitamente autorizzata.
   */
  public async openFileWriteStream(
    context: AuthorizedContext,
    robot: RobotEntity,
    relativeFilePath: string,
    options?: { overwrite?: boolean; confirmed?: boolean }
  ): Promise<Writable> {
    this.assertAuthorizedContext(context, robot, AppPermission.FS_SERVER_UPLOAD);

    const targetPath = await this.resolveRobotPath(robot, relativeFilePath);

    // Controllo sovrascrittura non consentita (§11.5, RF-TRF-011, RNF-FS-003)
    if (fs.existsSync(targetPath)) {
      if (options?.overwrite !== true) {
        throw new MolirisAppError(
          ErrorCode.REMOTE_FS_ERROR,
          "File già esistente. Sovrascrittura non consentita senza conferma esplicita."
        );
      }
    }

    // Assicura che la directory genitrice esista
    const parentDir = path.dirname(targetPath);
    if (!fs.existsSync(parentDir)) {
      await fs.promises.mkdir(parentDir, { recursive: true });
    }

    return fs.createWriteStream(targetPath);
  }

  /**
   * Crea l'area temporanea isolata per il robot con permessi ristretti (RNF-SEC-008, RF-TRF-009).
   */
  public async ensureTempDirectory(robot: RobotEntity): Promise<string> {
    const tempDir = path.join(robot.serverDirectoryPath, ".moliris_tmp");
    if (!fs.existsSync(tempDir)) {
      await fs.promises.mkdir(tempDir, { recursive: true, mode: 0o700 });
    }
    return tempDir;
  }

  private assertAuthorizedContext(
    context: AuthorizedContext,
    robot: RobotEntity,
    requiredPermission: AppPermission
  ): void {
    // Isolamento tra robot (RF-SRVFS-005, RNF-FS-002, RNF-SEC-007)
    if (context.targetRobotId && context.targetRobotId !== robot.id) {
      throw new MolirisAppError(
        ErrorCode.INSUFFICIENT_PERMISSIONS,
        "Operazione non consentita: contesto autorizzato per un robot differente."
      );
    }

    if (!context.permissions.has(requiredPermission)) {
      throw new MolirisAppError(
        ErrorCode.INSUFFICIENT_PERMISSIONS,
        "Operazione non consentita: autorizzazioni insufficienti per il filesystem server."
      );
    }
  }

  private async recordPathTraversalViolation(
    robotId: string,
    attemptedPath: string,
    reason: string
  ): Promise<void> {
    this.logger.error("Tentativo di violazione sicurezza percorsi (Path Traversal)", reason, { robotId });
    try {
      await this.auditRepository.record({
        userId: "anonymous",
        operation: AuditOperation.SECURITY_AUTHORIZATION_ERROR,
        robotId,
        outcome: "FAILURE",
        timestamp: new Date(),
        details: {
          reason,
          attemptedPath: "[REDACTED]", // RNF-SEC-002
        },
      });
    } catch {}
  }
}
