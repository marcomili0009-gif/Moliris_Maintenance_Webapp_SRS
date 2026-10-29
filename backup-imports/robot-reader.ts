// Requisiti soddisfatti: RF-MON-001, RF-MON-002, RF-ROB-005, RF-SSH-008, RNF-SEC-002, RNF-SEC-003, RNF-REL-001, RNF-REL-005, SRS §5.3, §9

import { type RobotEntity } from "../../storage/robot-models.ts";
import { type RobotConnectionManager, type ManagedRobotConnection } from "../connection/robot-connection-manager.ts";
import { MolirisAppError, ErrorCode } from "../../errors/app-errors.ts";
import { redactSensitiveData, MolirisLogger } from "../../logging/logger.ts";

export type RemoteReadFailureSubType =
  | "missing"
  | "timeout"
  | "connection_error"
  | "read_error";

export type RemoteReadResult =
  | { success: true; content: string; filePath: string }
  | {
      success: false;
      subType: RemoteReadFailureSubType;
      errorCode: string;
      errorMessage: string;
      filePath?: string;
    };

/**
 * Validatore di sicurezza per i percorsi dei file remoti (RNF-SEC-002, RNF-SEC-005).
 * Rifiuta null byte, caratteri di shell injection e percorsi relativi anomali.
 */
export function validateRemoteFilePath(pathStr: string): string {
  if (!pathStr || typeof pathStr !== "string" || pathStr.trim().length === 0) {
    throw new MolirisAppError(
      ErrorCode.MISSING_ROBOT_PARAMS,
      "Percorso del file di stato non specificato."
    );
  }

  const clean = pathStr.trim();

  // Controllo caratteri pericolosi per iniezione di comando o null byte
  if (clean.includes("\0") || /[\r\n\t;&|`$><]/.test(clean)) {
    throw new MolirisAppError(
      ErrorCode.STATE_FILE_UNREADABLE,
      "Percorso del file di stato contiene caratteri speciali o di iniezione non consentiti."
    );
  }

  // Percorso deve essere assoluto POSIX
  if (!clean.startsWith("/")) {
    throw new MolirisAppError(
      ErrorCode.STATE_FILE_UNREADABLE,
      "Il percorso del file di stato deve essere un percorso assoluto (deve iniziare con '/')."
    );
  }

  return clean;
}

/**
 * Esegue la lettura remota in sola lettura e rigorosamente non distruttiva (RF-MON-001, RF-SSH-008).
 * Non modifica file, non crea lock temporanei, non invoca sudo, garantisce il rilascio delle connessioni.
 */
export class RemoteRobotReader {
  private connectionManager: RobotConnectionManager;
  private defaultTimeoutMs: number;
  private logger: MolirisLogger;

  constructor(
    connectionManager: RobotConnectionManager,
    defaultTimeoutMs: number,
    logger: MolirisLogger
  ) {
    this.connectionManager = connectionManager;
    this.defaultTimeoutMs = defaultTimeoutMs;
    this.logger = logger;
  }

  public async readStateFile(
    userId: string,
    robot: RobotEntity,
    configuredPaths: string[]
  ): Promise<RemoteReadResult> {
    // 1. Risoluzione dei percorsi: priorità ai percorsi configurati nel robot (§10.1, RF-MON-001),
    // altrimenti usa i percorsi comuni configurati a livello di sistema.
    const candidatePaths: string[] =
      robot.stateFilePaths && robot.stateFilePaths.length > 0
        ? robot.stateFilePaths
        : configuredPaths;

    if (!candidatePaths || candidatePaths.length === 0) {
      return {
        success: false,
        subType: "missing",
        errorCode: ErrorCode.STATE_FILE_UNREADABLE,
        errorMessage: "Nessun percorso di file di stato configurato per questo robot né a livello di sistema.",
      };
    }

    let connection: ManagedRobotConnection | null = null;

    try {
      // 2. Acquisizione connessione SSH tramite il ConnectionManager centralizzato (RNF-PERF-003, RNF-REL-005)
      connection = await this.connectionManager.acquireConnection(userId, robot);
    } catch (connErr: any) {
      const appErr = connErr instanceof MolirisAppError ? connErr : null;
      const errorCode = appErr ? appErr.code : ErrorCode.HOST_UNREACHABLE;
      const errorMessage = appErr ? appErr.message : redactSensitiveData(connErr?.message || "Errore di connessione");

      let subType: RemoteReadFailureSubType = "connection_error";
      if (errorCode === ErrorCode.TIMEOUT_ERROR) {
        subType = "timeout";
      }

      return {
        success: false,
        subType,
        errorCode,
        errorMessage,
      };
    }

    try {
      // 3. Iterazione sui percorsi candidati: tenta la lettura del primo file disponibile
      for (const rawPath of candidatePaths) {
        let safePath: string;
        try {
          safePath = validateRemoteFilePath(rawPath);
        } catch (validationErr: any) {
          return {
            success: false,
            subType: "missing",
            errorCode: ErrorCode.STATE_FILE_UNREADABLE,
            errorMessage: validationErr.message,
            filePath: rawPath,
          };
        }

        // RF-SSH-008: Nessuna elevazione di privilegi, comando di sola lettura sicuro
        // escape rigoroso con apici singoli
        const escapedPath = `'${safePath.replace(/'/g, "'\\''")}'`;
        const readCommand = `if [ -f ${escapedPath} ]; then cat ${escapedPath}; else echo "__MOLIRIS_FILE_NOT_FOUND__" >&2; exit 2; fi`;

        // Timeout di esecuzione comando
        let commandPromise: Promise<{ stdout: string; stderr: string; exitCode: number }>;
        let timeoutHandle: NodeJS.Timeout | null = null;

        const timeoutPromise = new Promise<{ stdout: string; stderr: string; exitCode: number }>((_, reject) => {
          timeoutHandle = setTimeout(() => {
            reject(new MolirisAppError(ErrorCode.TIMEOUT_ERROR, `Timeout durante la lettura remota del file '${safePath}'.`));
          }, this.defaultTimeoutMs);
        });

        try {
          commandPromise = connection.executeCommand(readCommand);
          const result = await Promise.race([commandPromise, timeoutPromise]);

          if (timeoutHandle) clearTimeout(timeoutHandle);

          if (result.exitCode === 0) {
            return {
              success: true,
              content: result.stdout,
              filePath: safePath,
            };
          }

          if (result.exitCode === 2 || result.stderr.includes("__MOLIRIS_FILE_NOT_FOUND__") || result.stderr.includes("No such file")) {
            // File assente: continua con il percorso successivo se presente
            continue;
          }

          // Altro errore di lettura
          return {
            success: false,
            subType: "read_error",
            errorCode: ErrorCode.REMOTE_FS_ERROR,
            errorMessage: `Errore durante la lettura del file remoto '${safePath}': ${redactSensitiveData(result.stderr || result.stdout)}`,
            filePath: safePath,
          };
        } catch (execErr: any) {
          if (timeoutHandle) clearTimeout(timeoutHandle);
          if (execErr instanceof MolirisAppError && execErr.code === ErrorCode.TIMEOUT_ERROR) {
            return {
              success: false,
              subType: "timeout",
              errorCode: ErrorCode.TIMEOUT_ERROR,
              errorMessage: execErr.message,
              filePath: safePath,
            };
          }
          return {
            success: false,
            subType: "read_error",
            errorCode: ErrorCode.REMOTE_FS_ERROR,
            errorMessage: `Eccezione durante la lettura del file remoto '${safePath}': ${redactSensitiveData(execErr?.message || "")}`,
            filePath: safePath,
          };
        }
      }

      // Se nessun percorso candidato è stato trovato
      return {
        success: false,
        subType: "missing",
        errorCode: ErrorCode.STATE_FILE_UNREADABLE,
        errorMessage: `Nessun file di stato trovato tra i percorsi candidati: ${candidatePaths.join(", ")}`,
        filePath: candidatePaths[0],
      };
    } finally {
      // 4. Chiusura garantita della connessione per prevenire perdite di risorse (RNF-REL-005)
      try {
        await connection.close();
      } catch (closeErr) {
        this.logger.warn("Errore durante la chiusura della connessione di monitoraggio", {
          robotId: robot.id,
          err: String(closeErr),
        });
      }
    }
  }
}
