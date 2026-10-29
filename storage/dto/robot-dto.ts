// Requisiti soddisfatti: RF-ROB-001, RF-ROB-002, RF-ROB-003, RF-ROB-005, RNF-SEC-002

import {
  type RobotEntity,
  type AnagraphicState,
  type ConnectionState,
  type OperationalState,
  type LastAttemptOutcome,
  type RegistrationState,
  type HostKeyVerificationParams,
  type ConnectionVerificationInfo,
  type SftpParameters,
} from "../robot-models.ts";

/**
 * DTO per la visualizzazione dell'elenco robot (RF-ROB-001).
 * Include: nome visualizzato, identificativo, username, host/IP, porta SSH,
 * stato connessione, stato operativo, data ultimo aggiornamento, errori o avvisi.
 * Esclude tassativamente qualunque credenziale o riferimento segreto (RNF-SEC-002).
 */
export interface RobotSummaryDto {
  id: string;
  displayName: string;
  remoteUsername: string;
  host: string;
  sshPort: number;
  connectionState: ConnectionState;
  operationalState: OperationalState;
  lastValidUpdateAt: Date | null;
  anagraphicState: AnagraphicState;
  hasWarningsOrErrors: boolean;
  lastAttemptOutcome: LastAttemptOutcome | null;
}

/**
 * DTO per il dettaglio di configurazione e stato del robot (RF-ROB-002, RF-ROB-003).
 * Esclude tassativamente 'credentialReference', password e chiavi private (RF-ROB-005, RNF-SEC-002).
 */
export interface RobotDetailDto {
  id: string;
  displayName: string;
  remoteUsername: string;
  host: string;
  sshPort: number;
  sshAuthMethod: "key" | "password";
  hostKeyVerification: HostKeyVerificationParams;
  stateFilePaths: string[];
  serverDirectoryPath: string;
  anagraphicState: AnagraphicState;
  connectionState: ConnectionState;
  operationalState: OperationalState;
  lastValidUpdateAt: Date | null;
  lastAttemptOutcome: LastAttemptOutcome | null;
  registrationState: RegistrationState;
  lastConnectionVerification: ConnectionVerificationInfo | null;
  remoteMonitoringPath?: string;
  sftpParameters?: SftpParameters;
  customParameters?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Converte l'entità interna nel DTO sintetico per l'elenco (RF-ROB-001).
 */
export function toRobotSummaryDto(robot: RobotEntity): RobotSummaryDto {
  const hasWarningsOrErrors =
    robot.connectionState === "errore" ||
    robot.connectionState === "avviso" ||
    (robot.lastAttemptOutcome !== null && !robot.lastAttemptOutcome.success);

  return {
    id: robot.id,
    displayName: robot.displayName,
    remoteUsername: robot.remoteUsername,
    host: robot.host,
    sshPort: robot.sshPort,
    connectionState: robot.connectionState,
    operationalState: robot.operationalState,
    lastValidUpdateAt: robot.lastValidUpdateAt,
    anagraphicState: robot.anagraphicState,
    hasWarningsOrErrors,
    lastAttemptOutcome: robot.lastAttemptOutcome,
  };
}

/**
 * Converte l'entità interna nel DTO di dettaglio (RF-ROB-002, RF-ROB-003).
 * RNF-SEC-002: elimina tassativamente 'credentialReference' e campi sensibili.
 */
export function toRobotDetailDto(robot: RobotEntity): RobotDetailDto {
  return {
    id: robot.id,
    displayName: robot.displayName,
    remoteUsername: robot.remoteUsername,
    host: robot.host,
    sshPort: robot.sshPort,
    sshAuthMethod: robot.sshAuthMethod,
    hostKeyVerification: { ...robot.hostKeyVerification },
    stateFilePaths: robot.stateFilePaths ? [...robot.stateFilePaths] : [],
    serverDirectoryPath: robot.serverDirectoryPath,
    anagraphicState: robot.anagraphicState,
    connectionState: robot.connectionState,
    operationalState: robot.operationalState,
    lastValidUpdateAt: robot.lastValidUpdateAt,
    lastAttemptOutcome: robot.lastAttemptOutcome,
    registrationState: robot.registrationState,
    lastConnectionVerification: robot.lastConnectionVerification,
    remoteMonitoringPath: robot.remoteMonitoringPath,
    sftpParameters: robot.sftpParameters ? { ...robot.sftpParameters } : undefined,
    customParameters: robot.customParameters ? { ...robot.customParameters } : undefined,
    createdAt: robot.createdAt,
    updatedAt: robot.updatedAt,
  };
}
