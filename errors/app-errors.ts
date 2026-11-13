// Requisiti soddisfatti: SRS §9, RNF-MNT-003, RNF-SEC-002

export type ErrorSeverity = "recuperabile" | "richiede_intervento_amministrativo";

export const ErrorCode = {
  INVALID_CREDENTIALS: "AUTH_INVALID_CREDENTIALS",
  INSUFFICIENT_PERMISSIONS: "AUTH_INSUFFICIENT_PERMISSIONS",
  MISSING_ROBOT_PARAMS: "ROBOT_PARAMS_INVALID",
  HOST_UNREACHABLE: "NET_HOST_UNREACHABLE",
  SSH_PORT_UNAVAILABLE: "NET_PORT_UNAVAILABLE",
  SSH_AUTH_FAILED: "SSH_AUTH_FAILED",
  SSH_HOST_KEY_INVALID: "SSH_HOST_KEY_INVALID",
  HOST_KEY_INVALID: "SSH_HOST_KEY_INVALID",
  STATE_FILE_UNREADABLE: "MON_STATE_FILE_ERROR",
  TERMINAL_SESSION_ERROR: "TERM_SESSION_ERROR",
  REMOTE_FS_ERROR: "REMOTE_FS_IO_ERROR",
  SERVER_DIR_INACCESSIBLE: "SERVER_DIR_INACCESSIBLE",
  INSUFFICIENT_STORAGE: "STORAGE_INSUFFICIENT_SPACE",
  CONNECTION_LIMIT_REACHED: "CONNECTION_LIMIT_REACHED",
  TRANSFER_INTERRUPTED: "TRF_TRANSFER_INTERRUPTED",
  TIMEOUT_ERROR: "OPERATION_TIMEOUT",
  INTEGRITY_CHECK_FAILED: "TRF_INTEGRITY_FAILED",
  DB_PERSISTENCE_ERROR: "DB_PERSISTENCE_ERROR",
  DB_FS_SYNC_ERROR: "DB_FS_SYNC_ERROR",
  SECURITY_VIOLATION: "SECURITY_VIOLATION",
} as const;

export type ErrorCode = typeof ErrorCode[keyof typeof ErrorCode];

export interface AppErrorDefinition {
  code: ErrorCode;
  userMessage: string;
  classification: ErrorSeverity;
}

export const ERROR_CATALOG: Record<ErrorCode, AppErrorDefinition> = {
  [ErrorCode.INVALID_CREDENTIALS]: {
    code: ErrorCode.INVALID_CREDENTIALS,
    userMessage: "Credenziali di accesso non valide.",
    classification: "recuperabile",
  },
  [ErrorCode.INSUFFICIENT_PERMISSIONS]: {
    code: ErrorCode.INSUFFICIENT_PERMISSIONS,
    userMessage: "Operazione non consentita: autorizzazioni insufficienti.",
    classification: "recuperabile",
  },
  [ErrorCode.MISSING_ROBOT_PARAMS]: {
    code: ErrorCode.MISSING_ROBOT_PARAMS,
    userMessage: "Parametri del robot mancanti o non conformi.",
    classification: "recuperabile",
  },
  [ErrorCode.HOST_UNREACHABLE]: {
    code: ErrorCode.HOST_UNREACHABLE,
    userMessage: "Dispositivo remoto non raggiungibile. Verificare lo stato di rete e la connessione.",
    classification: "recuperabile",
  },
  [ErrorCode.SSH_PORT_UNAVAILABLE]: {
    code: ErrorCode.SSH_PORT_UNAVAILABLE,
    userMessage: "Servizio di connessione remota non disponibile sulla porta specificata.",
    classification: "recuperabile",
  },
  [ErrorCode.SSH_AUTH_FAILED]: {
    code: ErrorCode.SSH_AUTH_FAILED,
    userMessage: "Autenticazione remota verso il dispositivo fallita.",
    classification: "recuperabile",
  },
  [ErrorCode.HOST_KEY_INVALID]: {
    code: ErrorCode.HOST_KEY_INVALID,
    userMessage: "Verifica di sicurezza dell'host fallita: chiave non riconosciuta o non valida.",
    classification: "richiede_intervento_amministrativo",
  },
  [ErrorCode.STATE_FILE_UNREADABLE]: {
    code: ErrorCode.STATE_FILE_UNREADABLE,
    userMessage: "Informazioni di stato del dispositivo non disponibili o non interpretabili.",
    classification: "recuperabile",
  },
  [ErrorCode.TERMINAL_SESSION_ERROR]: {
    code: ErrorCode.TERMINAL_SESSION_ERROR,
    userMessage: "Errore durante la gestione della sessione di terminale.",
    classification: "recuperabile",
  },
  [ErrorCode.REMOTE_FS_ERROR]: {
    code: ErrorCode.REMOTE_FS_ERROR,
    userMessage: "Impossibile completare l'operazione sul filesystem del robot.",
    classification: "recuperabile",
  },
  [ErrorCode.SERVER_DIR_INACCESSIBLE]: {
    code: ErrorCode.SERVER_DIR_INACCESSIBLE,
    userMessage: "Archivio server non accessibile. Contattare l'amministratore.",
    classification: "richiede_intervento_amministrativo",
  },
  [ErrorCode.INSUFFICIENT_STORAGE]: {
    code: ErrorCode.INSUFFICIENT_STORAGE,
    userMessage: "Spazio di archiviazione insufficiente per completare l'operazione.",
    classification: "recuperabile",
  },
  [ErrorCode.CONNECTION_LIMIT_REACHED]: {
    code: ErrorCode.CONNECTION_LIMIT_REACHED,
    userMessage: "Troppe connessioni simultanee. Riprovare a breve.",
    classification: "recuperabile",
  },
  [ErrorCode.TRANSFER_INTERRUPTED]: {
    code: ErrorCode.TRANSFER_INTERRUPTED,
    userMessage: "Trasferimento file interrotto prima del completamento.",
    classification: "recuperabile",
  },
  [ErrorCode.TIMEOUT_ERROR]: {
    code: ErrorCode.TIMEOUT_ERROR,
    userMessage: "L'operazione richiesta ha superato il tempo massimo di attesa consentito.",
    classification: "recuperabile",
  },
  [ErrorCode.INTEGRITY_CHECK_FAILED]: {
    code: ErrorCode.INTEGRITY_CHECK_FAILED,
    userMessage: "Verifica di integrità del file trasferito fallita.",
    classification: "recuperabile",
  },
  [ErrorCode.DB_PERSISTENCE_ERROR]: {
    code: ErrorCode.DB_PERSISTENCE_ERROR,
    userMessage: "Errore durante il salvataggio dei dati applicativi. Riprovare o contattare l'amministratore.",
    classification: "richiede_intervento_amministrativo",
  },
  [ErrorCode.DB_FS_SYNC_ERROR]: {
    code: ErrorCode.DB_FS_SYNC_ERROR,
    userMessage: "Incoerenza rilevata tra anagrafica e archivio dati. Richiesto intervento di ripristino.",
    classification: "richiede_intervento_amministrativo",
  },
  [ErrorCode.SECURITY_VIOLATION]: {
    code: ErrorCode.SECURITY_VIOLATION,
    userMessage: "Violazione delle regole di sicurezza rilevata: accesso a risorse riservate bloccato.",
    classification: "richiede_intervento_amministrativo",
  },
};

export class MolirisAppError extends Error {
  public readonly code: ErrorCode;
  public readonly userMessage: string;
  public readonly classification: ErrorSeverity;
  public readonly diagnosticDetail: string;

  constructor(code: ErrorCode, diagnosticDetail: string, customUserMessage?: string) {
    const catalogEntry = ERROR_CATALOG[code];
    super(customUserMessage || catalogEntry.userMessage);
    this.name = "MolirisAppError";
    this.code = code;
    this.userMessage = customUserMessage || catalogEntry.userMessage;
    this.classification = catalogEntry.classification;
    this.diagnosticDetail = diagnosticDetail;
  }
}
