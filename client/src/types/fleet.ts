import type { InterpretedState } from "./monitoring.ts";

export interface RobotSummaryDto {
  id: string;
  displayName: string;
  remoteUsername: string;
  host: string;
  sshPort: number;
  anagraphicState: "attivo" | "disabilitato" | "rimosso";
  connectionState: "non_verificato" | "raggiungibile" | "non_raggiungibile" | "errore" | "avviso";
  operationalState: Record<string, unknown> | null;
  lastValidUpdateAt: string | null;
  lastAttemptOutcome: InterpretedState["lastAttemptOutcome"];
  isStale?: boolean;
  hasWarningsOrErrors?: boolean;
  clientId?: string;
  customerName?: string;
  plantId?: string;
  plantName?: string;
}

export interface RobotDetailDto extends RobotSummaryDto {
  serverDirectoryPath: string;
  sshAuthMethod: "password" | "key";
  stateFilePaths: string[];
  registrationState: string;
  lastConnectionVerification?: {
    timestamp: string;
    success: boolean;
    diagnosticMessage?: string;
  } | null;
  sftpConfig?: {
    host?: string;
    port?: number;
    username?: string;
  };
  features?: {
    terminal: { available: boolean; reason?: string };
    remoteFs: { available: boolean; reason?: string };
    serverFs: { available: boolean; reason?: string };
    transfer: { available: boolean; reason?: string };
    statusRefresh: { available: boolean; reason?: string };
    configure: { available: boolean; reason?: string };
    disable: { available: boolean; reason?: string };
    enable: { available: boolean; reason?: string };
    remove: { available: boolean; reason?: string };
  };
}

export interface RegisterRobotPayload {
  id: string;
  displayName: string;
  remoteUsername: string;
  host: string;
  sshPort: number;
  sshAuthMethod: "password" | "key";
  password?: string;
  privateKey?: string;
  passphrase?: string;
  fingerprint?: string;
  knownHostsPath?: string;
  strictHostKeyChecking?: boolean;
  remoteMonitoringPath?: string;
  sftpHost?: string;
  sftpPort?: number;
  sftpUser?: string;
  customerName?: string;
  plantName?: string;
}

export interface RegistrationOutcome {
  caseCode: "CASO_1" | "CASO_2" | "CASO_3" | "CASO_4" | "CASO_5" | "CASO_6";
  success: boolean;
  title: string;
  description: string;
  robotId?: string;
  robot?: RobotSummaryDto;
  suggestedAction?: string;
  warning?: string;
}

export interface EditRobotPayload {
  displayName?: string;
  host?: string;
  sshPort?: number;
  sshAuthMethod?: "password" | "key";
  password?: string;
  privateKey?: string;
  passphrase?: string;
  fingerprint?: string;
  remoteMonitoringPath?: string;
  customerName?: string;
  plantName?: string;
}
