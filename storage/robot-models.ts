// Requisiti soddisfatti: SRS §10.1, §10.2, §8.1, §8.2, §8.4, RF-ROB-001, RF-ROB-005, RF-ROB-006,
// RF-ROB-008, RF-ROB-009, RF-ROB-010, RF-ROB-012, RF-ROB-013, RF-ROB-014, RF-MON-001, RF-MON-005,
// RNF-SEC-002, RNF-SEC-003, RNF-REL-002, CA-ROB-003, CA-ROB-006, CA-ROB-008, CA-ROB-011, CA-MON-004

/**
 * Stato Anagrafico del Robot (§10.2, RF-ROB-013, §8.4)
 * Distinto e separato dagli altri stati.
 */
export type AnagraphicState = "attivo" | "disabilitato" | "rimosso";

/**
 * Stato della Connessione SSH/SFTP (§10.2, RF-ROB-001, RF-ROB-014, CA-ROB-003, CA-ROB-012)
 * Deve poter esprimere almeno "non verificato", "raggiungibile", "non raggiungibile", "errore", "avviso".
 * L'elenco definitivo dei valori è tracciato in DECISIONS.md.
 */
export type ConnectionState = "non_verificato" | "raggiungibile" | "non_raggiungibile" | "errore" | "avviso";

/**
 * Stato Operativo interpretato dai file remoti (§10.2, RF-MON-005, §11.4)
 * Regola SRS: NON inventare valori o enum rigidi; il formato e le regole sono aperti (§11.4).
 * Regola SRS (RF-MON-005): l'assenza di dati non deve mai essere scritta come stato operativo specifico.
 * Viene quindi rappresentato come record opaco o null in caso di assenza dati.
 */
export type OperationalState = Record<string, unknown> | null;

/**
 * Esito dell'ultimo tentativo di connessione o monitoraggio (§10.2, RF-MON-005, CA-MON-004)
 * Mantenuto separato dall'ultimo stato valido: un tentativo fallito non sovrascrive lo stato valido precedente.
 */
export interface LastAttemptOutcome {
  timestamp: Date;
  success: boolean;
  stage: "connection" | "monitoring";
  errorCode?: string;
  subType?: "missing" | "empty" | "incomplete" | "malformed" | "timeout" | "connection_error" | "read_error";
  diagnosticMessage?: string;
  attempts?: Array<{
    path: string;
    success: boolean;
    subType?: string;
    errorMessage?: string;
  }>;
}

/**
 * Stato di Configurazione e Registrazione (RF-ROB-010, RF-ROB-012, CA-ROB-003, CA-ROB-008)
 * Copre esattamente gli esiti previsti da RF-ROB-012 per gestire la non-atomicità tra DB e filesystem.
 */
export type RegistrationState =
  | "registrazione_completata"
  | "registrazione_rifiutata"
  | "ssh_non_verificata"
  | "creazione_directory_fallita"
  | "registrazione_incompleta"
  | "completata_con_funzionalita_non_verificate";

/**
 * Parametri di verifica della chiave host (RF-ROB-005, RNF-SEC-003)
 */
export interface HostKeyVerificationParams {
  fingerprint?: string;
  knownHostsPath?: string;
  strictHostKeyChecking?: boolean; // opzionale per compatibilità con i test; default = verificata (true)
}

/**
 * Informazioni sull'ultima verifica di connessione (§10.1, CA-ROB-003)
 */
export interface ConnectionVerificationInfo {
  timestamp: Date;
  success: boolean;
  message?: string;
}

/**
 * Parametri SFTP opzionali (RF-ROB-005), specificati SOLO se differenti da quelli SSH.
 */
export interface SftpParameters {
  host?: string;
  port?: number;
  username?: string;
}

/**
 * Schema dell'Entità Robot (§10.1, RF-ROB-005, RNF-SEC-002, vincoli 2.4 punti 1-2, 6)
 */
export interface RobotEntity {
  // Identificativo interno univoco
  id: string;

  // Nome visualizzato
  displayName: string;

  // Username remoto
  remoteUsername: string;

  // Hostname o indirizzo IP
  host: string;

  // Porta SSH (default 22, RF-ROB-005)
  sshPort: number;

  // Metodo di autenticazione SSH ("key" | "password")
  sshAuthMethod: "key" | "password";

  // Riferimento sicuro alle credenziali (SOLO riferimento, MAI password né chiave: RF-ROB-005, RNF-SEC-002, vincoli 2.4)
  credentialReference: string;

  // Parametri di verifica della chiave host (RF-ROB-005, RNF-SEC-003)
  hostKeyVerification?: HostKeyVerificationParams;

  // Percorsi dei file di stato (RF-MON-001: per robot o da configurazione comune)
  stateFilePaths?: string[];

  // Percorso della directory associata sul server (nome = username del robot, dentro la root configurata: RF-ROB-008, vincolo 2.4 punto 6)
  serverDirectoryPath: string;

  // a) Stato anagrafico del robot (§10.2, RF-ROB-013, §8.4)
  anagraphicState: AnagraphicState;

  // b) Stato della connessione SSH/SFTP (§10.2, RF-ROB-014, CA-ROB-003)
  connectionState: ConnectionState;

  // c) Stato operativo interpretato dai file remoti (§10.2, RF-MON-005)
  operationalState: OperationalState;

  // d) Data e ora dell'ultimo aggiornamento valido (§10.2, RNF-REL-002, RF-MON-005)
  lastValidUpdateAt: Date | null;

  // e) Esito dell'ultimo tentativo di connessione o monitoraggio (§10.2, CA-MON-004)
  lastAttemptOutcome?: LastAttemptOutcome | null;

  // Stato del processo di registrazione (RF-ROB-010, RF-ROB-012)
  registrationState: RegistrationState;

  // Informazioni sull'ultima verifica di connessione (§10.1)
  lastConnectionVerification?: ConnectionVerificationInfo | null;

  // Date di creazione e ultima modifica (§10.1)
  createdAt: Date;
  updatedAt: Date;

  // Flag di directory preesistente persistito prima della creazione sul filesystem (RF-ROB-010, CA-ROB-008)
  directoryPreexisting?: boolean;

  // Campi opzionali richiesti da RF-ROB-005
  remoteMonitoringPath?: string;
  sftpParameters?: SftpParameters;
  customParameters?: Record<string, unknown>;
}

/**
 * Politica di risoluzione percorso directory server del robot (§8.2, §11.3, §2.4 punto 6, RF-ROB-008)
 * Incapsula la regola di naming <username>_<id> in modo che nessun'altra parte del codice conosca il formato.
 */
export interface RobotDirectoryNamingPolicy {
  resolveDirectoryName(robot: { id: string; remoteUsername: string }): string;
  resolveDirectoryPath(fsRoot: string, robot: { id: string; remoteUsername: string; host?: string }): string;
}

/**
 * Implementazione baseline (§8.2, §2.4 punto 6, RF-ROB-008):
 * Naming directory sul server = <username>_<id>.
 * Evita collisioni quando robot diversi condividono lo stesso username remoto.
 */
export class StandardRobotDirectoryNamingPolicy implements RobotDirectoryNamingPolicy {
  resolveDirectoryName(robot: { id: string; remoteUsername: string }): string {
    const cleanUsername = robot.remoteUsername.trim().replace(/[/\\?%*:|"<>]/g, "");
    const cleanId = robot.id.trim().replace(/[/\\?%*:|"<>]/g, "");
    return `${cleanUsername}_${cleanId}`;
  }

  resolveDirectoryPath(fsRoot: string, robot: { id: string; remoteUsername: string; host?: string }): string {
    const dirName = this.resolveDirectoryName(robot);
    const cleanRoot = fsRoot.replace(/\/+$/, "");
    return `${cleanRoot}/${dirName}`;
  }
}
