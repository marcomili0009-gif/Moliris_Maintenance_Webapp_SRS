// Requisiti soddisfatti: RF-MON-001, RF-MON-002, RF-ROB-005, RF-SSH-008, RNF-SEC-002, RNF-SEC-003, RNF-REL-001, RNF-REL-005, SRS §5.3, §9

import { type RobotEntity } from "../../storage/robot-models.ts";
import { type RobotConnectionManager, type ManagedRobotConnection } from "../connection/robot-connection-manager.ts";
import { MolirisAppError, ErrorCode } from "../../errors/app-errors.ts";
import { redactSensitiveData, MolirisLogger } from "../../logging/logger.ts";
import { type StateFileParser } from "./state-file-parser.ts";

export type RemoteReadFailureSubType =
  | "missing"
  | "timeout"
  | "connection_error"
  | "read_error";

export interface StateFileAttemptDetail {
  path: string;
  success: boolean;
  subType?: string;
  errorMessage?: string;
}

export type RemoteReadResult =
  | {
      success: true;
      content: string;
      filePath: string;
      parsedData?: Record<string, unknown>;
      attempts?: StateFileAttemptDetail[];
    }
  | {
      success: false;
      subType: RemoteReadFailureSubType | string;
      errorCode: string;
      errorMessage: string;
      filePath?: string;
      attempts?: StateFileAttemptDetail[];
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
    configuredPaths: string[],
    parser?: StateFileParser
  ): Promise<RemoteReadResult> {
    // 1. Risoluzione dei percorsi: priorità ai percorsi configurati nel robot (§10.1, RF-MON-001),
    // i percorsi specifici del robot SOSTITUISCONO la lista comune (non si fondono).
    const candidatePaths: string[] =
      robot.stateFilePaths && robot.stateFilePaths.length > 0
        ? robot.stateFilePaths
        : configuredPaths;

    if (!candidatePaths || candidatePaths.length === 0) {
      return {
        success: false,
        subType: "missing",
        errorCode: ErrorCode.STATE_FILE_UNREADABLE,
        errorMessage: "file di stato assente o non interpretabile (nessun percorso configurato)",
        attempts: [],
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
        attempts: [],
      };
    }

    const attempts: StateFileAttemptDetail[] = [];

    try {
      // 3. Iterazione sui percorsi candidati in ordine (Problema B2):
      // Si leggono i file in sequenza e si adotta il primo che si legge E si interpreta con successo.
      for (const rawPath of candidatePaths) {
        let safePath: string;
        try {
          safePath = validateRemoteFilePath(rawPath);
        } catch (validationErr: any) {
          attempts.push({
            path: rawPath,
            success: false,
            subType: "malformed",
            errorMessage: validationErr.message,
          });
          continue;
        }

        // RF-SSH-008: Nessuna elevazione di privilegi, comando di sola lettura sicuro
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
            // Se è fornito il parser, interpretiamo il contenuto subito
            if (parser) {
              const parseRes = parser.parse(result.stdout, safePath);
              if (parseRes.success) {
                attempts.push({ path: safePath, success: true });
                return {
                  success: true,
                  content: result.stdout,
                  filePath: safePath,
                  parsedData: parseRes.data,
                  attempts,
                };
              } else {
                // Errore interpretazione (empty, incomplete, malformed)
                attempts.push({
                  path: safePath,
                  success: false,
                  subType: parseRes.subType,
                  errorMessage: parseRes.errorMessage,
                });
                // Continua con il percorso successivo!
                continue;
              }
            } else {
              attempts.push({ path: safePath, success: true });
              return {
                success: true,
                content: result.stdout,
                filePath: safePath,
                attempts,
              };
            }
          }

          if (result.exitCode === 2 || result.stderr.includes("__MOLIRIS_FILE_NOT_FOUND__") || result.stderr.includes("No such file")) {
            attempts.push({
              path: safePath,
              success: false,
              subType: "missing",
              errorMessage: "File di stato assente",
            });
            continue;
          }

          // Altro errore di lettura
          attempts.push({
            path: safePath,
            success: false,
            subType: "read_error",
            errorMessage: `Errore durante la lettura del file remoto '${safePath}': ${redactSensitiveData(result.stderr || result.stdout)}`,
          });
          continue;
        } catch (execErr: any) {
          if (timeoutHandle) clearTimeout(timeoutHandle);
          const isTimeout = execErr instanceof MolirisAppError && execErr.code === ErrorCode.TIMEOUT_ERROR;
          attempts.push({
            path: safePath,
            success: false,
            subType: isTimeout ? "timeout" : "read_error",
            errorMessage: redactSensitiveData(execErr?.message || ""),
          });
          continue;
        }
      }

      // Se nessun percorso candidato è stato letto E interpretato con successo
      const lastSubType = attempts.length > 0 && attempts[attempts.length - 1].subType
        ? (attempts[attempts.length - 1].subType as any)
        : "missing";

      return {
        success: false,
        subType: lastSubType,
        errorCode: ErrorCode.STATE_FILE_UNREADABLE,
        errorMessage: "file di stato assente o non interpretabile",
        filePath: candidatePaths[0],
        attempts,
      };
    } finally {
      // 4. Chiusura garantita della connessione per prevenire perdite di risorse (RNF-REL-005)
      try {
        await connection.close();
      } catch (closeErr) {
        this.logger.error(`Errore durante la chiusura della connessione di monitoraggio per '${robot.id}': ${String(closeErr)}`);
      }
    }
  }
}
