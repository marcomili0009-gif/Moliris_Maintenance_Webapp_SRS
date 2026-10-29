// Requisiti soddisfatti: RF-ROB-001, RF-ROB-002, RF-ROB-003, RF-ROB-004, RF-ROB-005,
// RF-ROB-006, RF-ROB-007, RF-ROB-008, RF-ROB-009, RF-ROB-010, RF-ROB-011, RF-ROB-012,
// RF-ROB-013, RF-ROB-014, RNF-SEC-002, RNF-SEC-003, RNF-SEC-006, SRS §6.2, §6.3, §8.1..8.4, §9, §10.1, §10.2

import {
  type HostKeyVerificationParams,
  type SftpParameters,
  type RegistrationState,
} from "../../storage/robot-models.ts";
import { type RobotDetailDto, type RobotSummaryDto } from "../../storage/dto/robot-dto.ts";

/**
 * Funzionalità disponibili per un utente su uno specifico robot (RF-ROB-011, CA-ROB-010).
 * Calcolate dinamicamente in base a:
 * 1. Permessi dell'utente
 * 2. Stato anagrafico del robot (disabilitato/attivo)
 * 3. Stato di connessione e raggiungibilità
 * 4. Configurazione e stato del filesystem server
 */
export interface AvailableFeatures {
  monitoring: boolean;
  terminal: boolean;
  remoteFs: boolean;
  serverFs: boolean;
  transfers: boolean;
  reasons: {
    monitoring?: string;
    terminal?: string;
    remoteFs?: string;
    serverFs?: string;
    transfers?: string;
  };
}

/**
 * Payload di registrazione di un nuovo robot (RF-ROB-004, RF-ROB-005, §6.2 passi 1-3).
 * Include tassativamente e SOLAMENTE i campi previsti dalla specifica:
 * - nome visualizzato
 * - username remoto
 * - identificativo univoco (id)
 * - indirizzo IP o hostname
 * - porta SSH (default 22)
 * - metodo di autenticazione SSH supportato
 * - credenziali (password o chiave privata) o riferimento sicuro
 * - configurazione verifica chiave host SSH
 * - percorso remoto file per il monitoraggio (opzionale)
 * - parametri di accesso SFTP (SOLO se differenti da SSH, opzionale)
 * - eventuali ulteriori parametri custom (opzionale)
 */
export interface RobotRegistrationInput {
  id: string;
  displayName: string;
  remoteUsername: string;
  host: string;
  sshPort?: number;
  sshAuthMethod: "key" | "password";
  // Credenziale in chiaro (consegnata al CredentialProvider e mai restituita) o riferimento sicuro esistente
  password?: string;
  privateKey?: string;
  passphrase?: string;
  credentialReference?: string;
  hostKeyVerification: HostKeyVerificationParams;
  remoteMonitoringPath?: string;
  stateFilePaths?: string[];
  sftpParameters?: SftpParameters;
  customParameters?: Record<string, unknown>;
}

/**
 * Payload per l'aggiornamento della configurazione del robot (§8.3, §2.2).
 * NOTA SRS §11.3: Lo username remoto è immutabile e non presente qui.
 */
export interface RobotConfigurationUpdateInput {
  displayName?: string;
  host?: string;
  sshPort?: number;
  sshAuthMethod?: "key" | "password";
  password?: string;
  privateKey?: string;
  passphrase?: string;
  credentialReference?: string;
  hostKeyVerification?: HostKeyVerificationParams;
  remoteMonitoringPath?: string;
  stateFilePaths?: string[];
  sftpParameters?: SftpParameters;
  customParameters?: Record<string, unknown>;
}

/**
 * Esito dettagliato della registrazione del robot (RF-ROB-012, §6.2 passi 4-11).
 * Copre esattamente i 6 esiti distinti di RF-ROB-012:
 * 1. registrazione_completata
 * 2. registrazione_rifiutata
 * 3. ssh_non_verificata
 * 4. creazione_directory_fallita
 * 5. registrazione_incompleta
 * 6. completata_con_funzionalita_non_verificate
 */
export interface RegistrationResult {
  outcome: RegistrationState;
  robot?: RobotDetailDto;
  validationErrors?: Record<string, string>;
  performedActions: string[];
  skippedActions: string[];
  availableFeatures?: AvailableFeatures;
  recoveryPath?: string;
  message: string;
  diagnosticDetail?: string;
}

/**
 * Risultato della verifica manuale di connessione (RF-ROB-007, §6.3, §8.1).
 */
export interface ConnectionVerificationResult {
  robotId: string;
  success: boolean;
  connectionState: string;
  registrationState: RegistrationState;
  steps: {
    name: string;
    description: string;
    status: "success" | "failure" | "skipped";
    message?: string;
  }[];
  message: string;
}
