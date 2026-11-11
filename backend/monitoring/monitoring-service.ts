// Requisiti soddisfatti: RF-MON-001, RF-MON-002, RF-MON-003, RF-MON-004, RF-MON-005, RF-MON-006,
// RNF-PERF-004, RNF-REL-001, RNF-REL-002, RNF-SEC-002, SRS §5.3, §9, §10.2, §11.4,
// CA-MON-001, CA-MON-002, CA-MON-003, CA-MON-004

import { type SystemConfiguration } from "../../config/configuration.ts";
import { type RobotEntity, type ConnectionState, type LastAttemptOutcome } from "../../storage/robot-models.ts";
import { type RobotRepository } from "../../storage/robot-repository.ts";
import { type AuditRepository } from "../../storage/audit-repository.ts";
import { AuditOperation } from "../../storage/audit-models.ts";
import { type RobotDetailDto, toRobotDetailDto } from "../../storage/dto/robot-dto.ts";
import { type UserEntity } from "../auth/user-models.ts";
import { AppPermission, hasPermission, type RolePermissionMapping } from "../auth/permissions.ts";
import { MolirisAppError, ErrorCode } from "../../errors/app-errors.ts";
import { MolirisLogger } from "../../logging/logger.ts";
import { type StateFileParser } from "./state-file-parser.ts";
import { RemoteRobotReader, type RemoteReadResult } from "./robot-reader.ts";

export interface StatusRefreshResult {
  robot: RobotDetailDto;
  success: boolean;
  message: string;
}

export class MonitoringService {
  private config: SystemConfiguration;
  private robotRepository: RobotRepository;
  private auditRepository: AuditRepository;
  private remoteReader: RemoteRobotReader;
  private parser: StateFileParser;
  private roleMapping: RolePermissionMapping;
  private logger: MolirisLogger;

  // Tracciamento dei cicli di polling attivi per robot per evitare sovrapposizioni (RNF-PERF-004)
  private activePolls: Set<string> = new Set();
  private pollingTimer: NodeJS.Timeout | null = null;

  constructor(
    config: SystemConfiguration,
    robotRepository: RobotRepository,
    auditRepository: AuditRepository,
    remoteReader: RemoteRobotReader,
    parser: StateFileParser,
    roleMapping: RolePermissionMapping,
    logger: MolirisLogger
  ) {
    this.config = config;
    this.robotRepository = robotRepository;
    this.auditRepository = auditRepository;
    this.remoteReader = remoteReader;
    this.parser = parser;
    this.roleMapping = roleMapping;
    this.logger = logger;
  }

  /**
   * Avvia il servizio di polling periodico (RF-MON-003, CA-MON-002).
   * Se l'intervallo non è configurato o è <= 0, il servizio non parte e lo segnala chiaramente.
   */
  public startPolling(): boolean {
    const interval = this.config.pollingIntervalSeconds;

    if (interval === undefined || interval === null || isNaN(interval) || interval <= 0) {
      this.logger.info("Servizio di polling periodico NON avviato: intervallo di polling non configurato o disabilitato (<= 0s).");
      return false;
    }

    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = null;
    }

    this.logger.info(`Avvio del servizio di polling periodico con intervallo di ${interval} secondi.`);

    this.pollingTimer = setInterval(() => {
      this.pollAllRobots().catch((err) => {
        this.logger.error("Errore non gestito durante il ciclo di polling periodico", err);
      });
    }, interval * 1000);

    return true;
  }

  /**
   * Arresta il polling periodico (rilascio timer).
   */
  public stopPolling(): void {
    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = null;
      this.logger.info("Servizio di polling periodico arrestato.");
    }
  }

  public isPollingActive(): boolean {
    return this.pollingTimer !== null;
  }

  /**
   * Esegue un ciclo di polling su tutti i robot idonei (RF-MON-003).
   * Concorrenza isolata: l'errore su un robot non blocca gli altri (RNF-REL-001).
   */
  public async pollAllRobots(): Promise<void> {
    const robots = await this.robotRepository.list();

    const eligible = robots.filter(
      (r) =>
        r.anagraphicState === "attivo" &&
       (r.registrationState as any) !== "rimosso" &&
        r.registrationState !== "ssh_non_verificata"
    );

    const promises = eligible.map(async (robot) => {
      // Divieto di cicli di polling sovrapposti sullo stesso robot (RNF-PERF-004)
      if (this.activePolls.has(robot.id)) {
        return;
      }
      try {
        await this.pollSingleRobot(robot.id, "system_monitor");
      } catch (err: any) {
  this.logger.error(`Errore durante il polling del robot '${robot.id}': ${err?.message || String(err)}`);
      }
    });

    await Promise.allSettled(promises);
  }

  /**
   * Esegue la lettura e interpretazione dello stato di un singolo robot (RF-MON-001, RF-MON-002, CA-MON-001).
   * Rispetta rigorosamente la separazione degli stati (RF-MON-005, §10.2, RNF-REL-002):
   * - operationalState e lastValidUpdateAt aggiornati SOLO in caso di successo.
   * - In caso di fallimento, l'ultimo dato valido NON viene sovrascritto né azzerato.
   * - Nessun enum fittizio (offline, spento) scritto nello stato operativo.
   */
  public async pollSingleRobot(robotId: string, actorUserId: string): Promise<RobotEntity | null> {
    if (this.activePolls.has(robotId)) {
      return null;
    }

    this.activePolls.add(robotId);

    try {
      const robot = await this.robotRepository.findById(robotId);
      if (!robot) {
        return null;
      }

      // Non eseguire su robot non attivi o non verificati
      if (robot.anagraphicState !== "attivo" || (robot.registrationState as any) === "rimosso") {
        return robot;
      }

      // 1. Lettura remota e interpretazione del primo file valido (Problema B2, RF-MON-001, §10.1)
      const readResult: RemoteReadResult = await this.remoteReader.readStateFile(
        actorUserId,
        robot,
        this.config.stateFilePaths,
        this.parser
      );

      const now = new Date();

      if (readResult.success) {
        // Se parsedData è già presente da readStateFile, usalo; altrimenti invoca il parser
        let finalData: Record<string, unknown> | null = readResult.parsedData || null;
        if (!finalData && readResult.content && readResult.filePath) {
          const parseResult = this.parser.parse(readResult.content, readResult.filePath);
          if (parseResult.success) {
            finalData = parseResult.data;
          } else {
            const outcome: LastAttemptOutcome = {
              timestamp: now,
              success: false,
              stage: "monitoring",
              errorCode: ErrorCode.STATE_FILE_UNREADABLE,
              subType: parseResult.subType,
              diagnosticMessage: parseResult.errorMessage,
              attempts: readResult.attempts,
            };
            return await this.robotRepository.updateConnectionState(robot.id, "avviso", outcome);
          }
        }

        const outcome: LastAttemptOutcome = {
          timestamp: now,
          success: true,
          stage: "monitoring",
          diagnosticMessage: `Stato operativo acquisito con successo dal file '${readResult.filePath}'.`,
          attempts: readResult.attempts,
        };

        if (finalData) {
          await this.robotRepository.updateOperationalState(robot.id, finalData, now);
        }
        return await this.robotRepository.updateConnectionState(robot.id, "raggiungibile", outcome);
      } else {
        // Errore lettura remota, file assente o non interpretabile (Problema B2 punto c, RF-MON-005):
        // Preserva intatto l'ultimo dato valido precedente; aggiorna connectionState e lastAttemptOutcome
        let connectionState: ConnectionState = "avviso";
        if (readResult.subType === "connection_error" || readResult.subType === "timeout") {
          connectionState = "non_raggiungibile";
        }

        const outcome: LastAttemptOutcome = {
          timestamp: now,
          success: false,
          stage: "monitoring",
          errorCode: readResult.errorCode || ErrorCode.STATE_FILE_UNREADABLE,
          subType: readResult.subType as any,
          diagnosticMessage: readResult.errorMessage || "file di stato assente o non interpretabile",
          attempts: readResult.attempts,
        };

        return await this.robotRepository.updateConnectionState(robot.id, connectionState, outcome);
      }
    } finally {
      this.activePolls.delete(robotId);
    }
  }

  /**
   * Richiesta di aggiornamento manuale dello stato on-demand (RF-MON-004, CA-MON-003).
   * Richiede permesso STATUS_REFRESH_MANUAL.
   * Evita sovrapposizioni se un aggiornamento è già in corso.
   */
  public async refreshRobotStatus(user: UserEntity, robotId: string): Promise<StatusRefreshResult> {
    // 1. Controllo centralizzato di autorizzazione (CA-MON-003)
    if (!hasPermission(user, AppPermission.STATUS_REFRESH_MANUAL, robotId, this.roleMapping)) {
      await this.auditRepository.record({
        userId: user.username,
        operation: AuditOperation.SECURITY_AUTHORIZATION_ERROR,
        robotId,
        outcome: "FAILURE",
        timestamp: new Date(),
        details: { reason: "PERMISSION_DENIED_STATUS_REFRESH_MANUAL" },
      });

      throw new MolirisAppError(
        ErrorCode.INSUFFICIENT_PERMISSIONS,
        "Operazione non consentita: autorizzazioni insufficienti per richiedere l'aggiornamento manuale dello stato."
      );
    }

    const robot = await this.robotRepository.findById(robotId);
    if (!robot) {
      throw new MolirisAppError(ErrorCode.MISSING_ROBOT_PARAMS, `Robot '${robotId}' non trovato.`);
    }

    if (robot.anagraphicState === "disabilitato" || robot.anagraphicState === "rimosso") {
      throw new MolirisAppError(
        ErrorCode.INSUFFICIENT_PERMISSIONS,
        `Impossibile aggiornare lo stato di un robot ${robot.anagraphicState}.`
      );
    }

    if (robot.registrationState === "ssh_non_verificata") {
      throw new MolirisAppError(
        ErrorCode.HOST_UNREACHABLE,
        "Impossibile aggiornare lo stato: connessione SSH non ancora verificata. Eseguire prima la verifica della connessione."
      );
    }

    // 2. Controllo assenza di cicli sovrapposti sullo stesso robot (RNF-PERF-004)
    if (this.activePolls.has(robotId)) {
      throw new MolirisAppError(
        ErrorCode.TIMEOUT_ERROR,
        "Aggiornamento dello stato già in corso per questo robot. Attendere il completamento."
      );
    }

    // 3. Esecuzione del refresh
    const updated = await this.pollSingleRobot(robotId, user.username);
    const finalRobot = updated || (await this.robotRepository.findById(robotId))!;
    const isSuccess = finalRobot.lastAttemptOutcome ? finalRobot.lastAttemptOutcome.success : false;

    let message = "Stato operativo aggiornato con successo.";
    if (!isSuccess && finalRobot.lastAttemptOutcome) {
      message = `Aggiornamento non riuscito: ${finalRobot.lastAttemptOutcome.diagnosticMessage || "errore sconosciuto"}`;
    }

    return {
      robot: toRobotDetailDto(finalRobot, this.config.staleDataThresholdSeconds),
      success: isSuccess,
      message,
    };
  }

  /**
   * Recupero dello stato di dettaglio e monitoraggio del robot (RF-ROB-002, RF-MON-006).
   * Richiede permesso STATUS_VIEW.
   */
  public async getRobotStatus(user: UserEntity, robotId: string): Promise<RobotDetailDto> {
    if (!hasPermission(user, AppPermission.STATUS_VIEW, robotId, this.roleMapping)) {
      await this.auditRepository.record({
        userId: user.username,
        operation: AuditOperation.SECURITY_AUTHORIZATION_ERROR,
        robotId,
        outcome: "FAILURE",
        timestamp: new Date(),
        details: { reason: "PERMISSION_DENIED_STATUS_VIEW" },
      });

      throw new MolirisAppError(
        ErrorCode.INSUFFICIENT_PERMISSIONS,
        "Operazione non consentita: autorizzazioni insufficienti per visualizzare lo stato del robot."
      );
    }

    const robot = await this.robotRepository.findById(robotId);
    if (!robot) {
      throw new MolirisAppError(ErrorCode.MISSING_ROBOT_PARAMS, `Robot '${robotId}' non trovato.`);
    }

    return toRobotDetailDto(robot, this.config.staleDataThresholdSeconds);
  }
}
