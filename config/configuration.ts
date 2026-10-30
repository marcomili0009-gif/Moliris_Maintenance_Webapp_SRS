// Requisiti soddisfatti: RNF-MNT-001, RF-ROB-005, RF-TRF-012, RF-AUTH-006, RF-MON-001, RF-ROB-009, RF-SRVFS-007, RNF-SEC-002, RNF-SEC-004, §8.1, §11.1..11.6

import fs from "fs";

export interface SystemConfiguration {
  // 1. Root del filesystem server (RNF-MNT-001, RF-SRVFS-001)
  serverFilesystemRoot: string;

  // 2. Intervallo di polling per monitoraggio (RNF-MNT-001, RF-MON-003, RNF-PERF-004)
  pollingIntervalSeconds: number;

  // 3. Timeout connessioni SSH/SFTP (RNF-MNT-001, RF-TRF-013)
  sshConnectionTimeoutMs: number;

  // 4. Numero massimo di connessioni e trasferimenti simultanei (RNF-MNT-001, RF-TRF-012, RNF-PERF-003)
  maxConcurrentTransfersPerUser: number;
  maxConcurrentTransfersPerRobot: number;
  maxConcurrentTransfersServer: number;

  // 5. Limiti di dimensione o quote, se previsti (RNF-MNT-001, RF-TRF-014, §11.1, §11.5) [opzionali]
  maxFileSizeBytes?: number;
  quotaPerRobotBytes?: number;

  // 6. Politica di conservazione dei file temporanei (RNF-MNT-001, RF-TRF-009, §11.5)
  tempFileRetentionMinutes: number;

  // 7. Percorsi dei file di stato (RNF-MNT-001, RF-MON-001, §11.4)
  stateFilePaths: string[];

  // 8. Parametri di sicurezza e sessione (RNF-MNT-001, RF-AUTH-006, §11.6, RNF-SEC-001)
  inactiveSessionTimeoutMinutes: number;
  sessionAbsoluteMaxMinutes?: number; // MOLIRIS_SESSION_ABSOLUTE_MAX_MIN (opzionale, nessun default)
  tlsCertPath: string; // Riferimento sicuro senza contenere segreti (RNF-SEC-002)
  tlsKeyPath: string;  // Riferimento sicuro senza contenere segreti (RNF-SEC-002)

  // Parametri del provider di credenziali (§11.2, RNF-SEC-002, RNF-SEC-004)
  credentialProviderType?: "mongo" | "in-memory";
  masterKeyFilePath?: string;

  // 9. Sottodirectory standard da creare per robot [opzionali] (RF-ROB-009, RF-SRVFS-007)
  standardSubdirectories?: string[];

  // 10. Permessi di accesso per le directory dei robot [opzionali] (RNF-FS-001, §11.1)
  serverDirectoryPermissions?: string;

  // 11. Modalità di registrazione: rigorosa o differita (§8.1, §11.3)
  registrationMode: "rigorosa" | "differita";

  // Politica di unicità dello username del robot (§8.2, §11.3, RF-ROB-006)
  // "per_host": username unico per singolo host/porta; "globale": username unico in tutta la flotta
  robotUsernameUniqueness?: "per_host" | "globale";

  // 12. Politica di conservazione degli eventi di audit (in giorni) (§10.4, RNF-SEC-009, §11.1)
  auditLogRetentionDays: number;

  // 13. Metodi di autenticazione SSH consentiti [opzionali] (§11.2)
  allowedSshAuthMethods?: ("key" | "password")[];

  // 14. Destinazioni remote consentite per registrazione [opzionali] (RNF-SEC-006, §11.2)
  allowedDestinations?: string[];

  // 15. Limite verifiche di connessione simultanee in registrazione [opzionali] (RNF-SEC-006)
  maxConcurrentRegistrationVerifications?: number;

  // 16. Politica in caso di directory già esistente [opzionale] (§11.3, RF-SRVFS-006)
  existingDirectoryPolicy?: "accetta" | "rifiuta";

  // 17. Politica per sessioni attive alla disabilitazione [opzionale] (§8.4, §11.3)
  activeSessionPolicyOnDisable?: "chiudi_immediatamente" | "lascia_terminare";

  // 18. Soglia di età per marcatura dati obsoleti (in secondi) [opzionale, §11.4]
  staleDataThresholdSeconds?: number;

  // 19. Parametri per sessioni di terminale remoto [opzionali] (§5.4, §6.4 passo 7, §11.6, §11.7, RNF-PERF-003)
  terminalSessionTimeoutMinutes?: number;
  maxConcurrentTerminalSessionsServer?: number;
  maxConcurrentTerminalSessionsPerUser?: number;
  maxConcurrentTerminalSessionsPerRobot?: number;
  terminalDisconnectPolicy?: "chiudi_immediatamente";
  wsPingIntervalMs?: number;
  wsPingTimeoutMs?: number;

  // 20. Parametri per navigazione e accesso al filesystem remoto del robot [opzionali] (§5.5, §10.3, §11.5, §11.6, §11.7)
  remoteFsInitialPath?: string;
  remoteFsAllowedPaths?: string[];
  remoteFsMaxDirectoryEntries?: number;
  remoteFsOverwritePolicy?: "rifiuta" | "sovrascrivi";
  remoteFsConnectionIdleTimeoutMs?: number;

  // 21. Parametri per il servizio di trasferimento file [opzionali] (§5.5, §6.5..6.7, §11.5, §11.6, §11.7)
  transferChunkSizeBytes?: number;
  transferChecksumAlgorithm?: "sha256" | "md5";
  transferOverwritePolicy?: "rifiuta" | "richiedi_conferma" | "sovrascrivi";
  transferResumeEnabled?: boolean;
  transferConcurrencyQueuePolicy?: "rifiuta" | "coda";
  transferIdleTimeoutMs?: number;

  // Modalità verifica integrità trasferimenti (Problema A1, default baseline: stream)
  transferVerifyMode?: "stream" | "readback";

  // Sostituzione non atomica sul robot in assenza di posix-rename (Problema A2, default false)
  robotNonAtomicReplace?: boolean;

  // Margine di sicurezza spazio su disco in MB (Problema A4, default 0)
  transferSpaceMarginMb?: number;

  // Formato file di stato (Problema B1, default "auto")
  stateFileFormat?: "auto" | "json" | "keyvalue";


  // Schema JSON opzionale per file di stato (Problema B1, §11.4)
  stateFileSchemaPath?: string;

  // Default unico ammesso: porta SSH 22 (RF-ROB-005)
  defaultSshPort: number;
}

export function loadAndValidateConfig(env: Record<string, string | undefined>): SystemConfiguration {
  const missing: string[] = [];

  function requireString(key: string): string {
    const val = env[key];
    if (!val || val.trim() === "") {
      missing.push(key);
      return "";
    }
    return val.trim();
  }

  function requireNumber(key: string): number {
    const val = env[key];
    if (!val || val.trim() === "" || isNaN(Number(val))) {
      missing.push(key);
      return 0;
    }
    return Number(val);
  }

  const serverFilesystemRoot = requireString("MOLIRIS_FS_ROOT");
  const pollingIntervalSeconds = requireNumber("MOLIRIS_POLLING_INTERVAL_SEC");
  const sshConnectionTimeoutMs = requireNumber("MOLIRIS_SSH_TIMEOUT_MS");
  const maxConcurrentTransfersPerUser = requireNumber("MOLIRIS_MAX_TRF_PER_USER");
  const maxConcurrentTransfersPerRobot = requireNumber("MOLIRIS_MAX_TRF_PER_ROBOT");
  const maxConcurrentTransfersServer = requireNumber("MOLIRIS_MAX_TRF_SERVER");
  const tempFileRetentionMinutes = requireNumber("MOLIRIS_TEMP_RETENTION_MIN");

  const rawStatePaths = requireString("MOLIRIS_STATE_FILE_PATHS");
  const stateFilePaths = rawStatePaths ? rawStatePaths.split(",").map(p => p.trim()).filter(Boolean) : [];

  const inactiveSessionTimeoutMinutes = requireNumber("MOLIRIS_SESSION_TIMEOUT_MIN");
  const tlsCertPath = requireString("MOLIRIS_TLS_CERT_PATH");
  const tlsKeyPath = requireString("MOLIRIS_TLS_KEY_PATH");
  const auditLogRetentionDays = requireNumber("MOLIRIS_AUDIT_RETENTION_DAYS");

  const rawRegMode = requireString("MOLIRIS_REGISTRATION_MODE");
  let registrationMode: "rigorosa" | "differita" = "rigorosa";
  if (rawRegMode) {
    if (rawRegMode !== "rigorosa" && rawRegMode !== "differita") {
      throw new Error(`Valore non valido per MOLIRIS_REGISTRATION_MODE: '${rawRegMode}'. Valori ammessi: 'rigorosa', 'differita'.`);
    }
    registrationMode = rawRegMode as "rigorosa" | "differita";
  }

  // Timeout assoluto massimo sessione utente (§11.6, RF-AUTH-006)
  let sessionAbsoluteMaxMinutes: number | undefined = undefined;
  if (env["MOLIRIS_SESSION_ABSOLUTE_MAX_MIN"] !== undefined && env["MOLIRIS_SESSION_ABSOLUTE_MAX_MIN"].trim() !== "") {
    const val = Number(env["MOLIRIS_SESSION_ABSOLUTE_MAX_MIN"]);
    if (isNaN(val) || !Number.isInteger(val) || val <= 0) {
      throw new Error("Valore non valido per MOLIRIS_SESSION_ABSOLUTE_MAX_MIN: deve essere un numero intero positivo maggiore di zero.");
    }
    sessionAbsoluteMaxMinutes = val;
  }

  // Provider di credenziali (§11.2, RNF-SEC-002, RNF-SEC-004)
  const rawCredProvider = env["MOLIRIS_CREDENTIAL_PROVIDER"]?.trim().toLowerCase() || "mongo";
  if (rawCredProvider !== "mongo" && rawCredProvider !== "in-memory") {
    throw new Error(`Valore non valido per MOLIRIS_CREDENTIAL_PROVIDER: '${rawCredProvider}'. Valori ammessi: 'mongo', 'in-memory'.`);
  }
  if (rawCredProvider === "in-memory" && env["NODE_ENV"] === "production") {
    throw new Error("Configurazione non sicura: il provider di credenziali 'in-memory' non è consentito in ambiente di produzione (NODE_ENV=production).");
  }
  const credentialProviderType: "mongo" | "in-memory" = rawCredProvider;

  let masterKeyFilePath: string | undefined = undefined;
  if (credentialProviderType === "mongo") {
    const keyFile = env["MOLIRIS_MASTER_KEY_FILE"];
    if (!keyFile || keyFile.trim() === "") {
      missing.push("MOLIRIS_MASTER_KEY_FILE");
    } else {
      masterKeyFilePath = keyFile.trim();
    }
  } else if (env["MOLIRIS_MASTER_KEY_FILE"]) {
    masterKeyFilePath = env["MOLIRIS_MASTER_KEY_FILE"].trim();
  }

  if (missing.length > 0) {
    throw new Error(`Inizializzazione fallita. Parametri di configurazione obbligatori mancanti: ${missing.join(", ")}`);
  }

  // Parametri opzionali
  const maxFileSizeBytes = env["MOLIRIS_MAX_FILE_SIZE_BYTES"] && !isNaN(Number(env["MOLIRIS_MAX_FILE_SIZE_BYTES"]))
    ? Number(env["MOLIRIS_MAX_FILE_SIZE_BYTES"])
    : undefined;

  const quotaPerRobotBytes = env["MOLIRIS_QUOTA_PER_ROBOT_BYTES"] && !isNaN(Number(env["MOLIRIS_QUOTA_PER_ROBOT_BYTES"]))
    ? Number(env["MOLIRIS_QUOTA_PER_ROBOT_BYTES"])
    : undefined;

  // Unicità dello username del robot (§8.2, §11.3, RF-ROB-006)
  const rawUsernameUniqueness = env["MOLIRIS_ROBOT_USERNAME_UNIQUENESS"]?.trim().toLowerCase() || "per_host";
  if (rawUsernameUniqueness !== "per_host" && rawUsernameUniqueness !== "globale") {
    throw new Error(`Valore non valido per MOLIRIS_ROBOT_USERNAME_UNIQUENESS: '${rawUsernameUniqueness}'. Valori ammessi: 'per_host', 'globale'.`);
  }
  const robotUsernameUniqueness: "per_host" | "globale" = rawUsernameUniqueness;

  const standardSubdirectories = env["MOLIRIS_STANDARD_SUBDIRS"]
    ? env["MOLIRIS_STANDARD_SUBDIRS"].split(",").map(s => s.trim()).filter(Boolean)
    : undefined;

  const serverDirectoryPermissions = env["MOLIRIS_DIR_PERMISSIONS"]
    ? env["MOLIRIS_DIR_PERMISSIONS"].trim()
    : undefined;

  // Controllo sicurezza permessi root filesystem (§11.1, RNF-FS-001)
  if (fs.existsSync(serverFilesystemRoot) && process.platform !== "win32") {
    try {
      const rootStat = fs.statSync(serverFilesystemRoot);
      const rootMode = rootStat.mode & 0o777;
      if ((rootMode & 0o027) !== 0) {
        const warningMsg = `Permessi sulla root del filesystem server (${serverFilesystemRoot}) sono ${rootMode.toString(8)}, più ampi di 0750 (RNF-FS-001).`;
        if (env["NODE_ENV"] === "production") {
          throw new Error(`Configurazione non sicura: ${warningMsg} In produzione sono ammessi permessi massimi 0750.`);
        }
      }
    } catch (permErr: any) {
      if (permErr.message.includes("Configurazione non sicura")) throw permErr;
    }
  }

  const allowedSshAuthMethods = env["MOLIRIS_ALLOWED_SSH_AUTH_METHODS"]
    ? (env["MOLIRIS_ALLOWED_SSH_AUTH_METHODS"].split(",").map(m => m.trim().toLowerCase()).filter(m => m === "key" || m === "password") as ("key" | "password")[])
    : undefined;

  const allowedDestinations = env["MOLIRIS_ALLOWED_DESTINATIONS"]
    ? env["MOLIRIS_ALLOWED_DESTINATIONS"].split(",").map(d => d.trim()).filter(Boolean)
    : undefined;

  const maxConcurrentRegistrationVerifications = env["MOLIRIS_MAX_REG_VERIFICATIONS"] && !isNaN(Number(env["MOLIRIS_MAX_REG_VERIFICATIONS"]))
    ? Number(env["MOLIRIS_MAX_REG_VERIFICATIONS"])
    : undefined;

  const rawExistingDirPolicy = env["MOLIRIS_EXISTING_DIR_POLICY"]?.trim().toLowerCase();
  const existingDirectoryPolicy = (rawExistingDirPolicy === "accetta" || rawExistingDirPolicy === "rifiuta")
    ? (rawExistingDirPolicy as "accetta" | "rifiuta")
    : undefined;

  const rawSessionPolicy = env["MOLIRIS_ON_DISABLE_SESSION_POLICY"]?.trim().toLowerCase();
  const activeSessionPolicyOnDisable = (rawSessionPolicy === "chiudi_immediatamente" || rawSessionPolicy === "lascia_terminare")
    ? (rawSessionPolicy as "chiudi_immediatamente" | "lascia_terminare")
    : undefined;

  const staleDataThresholdSeconds = env["MOLIRIS_STALE_DATA_THRESHOLD_SEC"] && !isNaN(Number(env["MOLIRIS_STALE_DATA_THRESHOLD_SEC"]))
    ? Number(env["MOLIRIS_STALE_DATA_THRESHOLD_SEC"])
    : undefined;

  const terminalSessionTimeoutMinutes = env["MOLIRIS_TERMINAL_SESSION_TIMEOUT_MIN"] && !isNaN(Number(env["MOLIRIS_TERMINAL_SESSION_TIMEOUT_MIN"]))
    ? Number(env["MOLIRIS_TERMINAL_SESSION_TIMEOUT_MIN"])
    : undefined;

  const maxConcurrentTerminalSessionsServer = env["MOLIRIS_MAX_TERMINAL_SESSIONS_SERVER"] && !isNaN(Number(env["MOLIRIS_MAX_TERMINAL_SESSIONS_SERVER"]))
    ? Number(env["MOLIRIS_MAX_TERMINAL_SESSIONS_SERVER"])
    : undefined;

  const maxConcurrentTerminalSessionsPerUser = env["MOLIRIS_MAX_TERMINAL_SESSIONS_PER_USER"] && !isNaN(Number(env["MOLIRIS_MAX_TERMINAL_SESSIONS_PER_USER"]))
    ? Number(env["MOLIRIS_MAX_TERMINAL_SESSIONS_PER_USER"])
    : undefined;

  const maxConcurrentTerminalSessionsPerRobot = env["MOLIRIS_MAX_TERMINAL_SESSIONS_PER_ROBOT"] && !isNaN(Number(env["MOLIRIS_MAX_TERMINAL_SESSIONS_PER_ROBOT"]))
    ? Number(env["MOLIRIS_MAX_TERMINAL_SESSIONS_PER_ROBOT"])
    : undefined;

  // Politica di disconnessione terminale:
  // "Né opzione A né opzione B. Rimuovi il valore mantieni_in_background.
  // Accetta solo chiudi_immediatamente. Se la configurazione contiene mantieni_in_background, l’avvio fallisce con messaggio chiaro."
  const rawDisconnectPolicy = env["MOLIRIS_TERMINAL_DISCONNECT_POLICY"]?.trim().toLowerCase();
  if (rawDisconnectPolicy === "mantieni_in_background") {
    throw new Error(
      "Configurazione non consentita: il valore 'mantieni_in_background' per MOLIRIS_TERMINAL_DISCONNECT_POLICY è stato rimosso per prevenire processi orfani e garantire l'isolamento (RF-SSH-006). L'unico valore ammesso è 'chiudi_immediatamente'."
    );
  }
  let terminalDisconnectPolicy: "chiudi_immediatamente" | undefined = undefined;
  if (rawDisconnectPolicy) {
    if (rawDisconnectPolicy !== "chiudi_immediatamente") {
      throw new Error(`Valore non valido per MOLIRIS_TERMINAL_DISCONNECT_POLICY: '${rawDisconnectPolicy}'. Valore ammesso: 'chiudi_immediatamente'.`);
    }
    terminalDisconnectPolicy = "chiudi_immediatamente";
  }

  // Parametri opzionali Heartbeat WebSocket
  const wsPingIntervalMs = env["MOLIRIS_WS_PING_INTERVAL_MS"] && !isNaN(Number(env["MOLIRIS_WS_PING_INTERVAL_MS"]))
    ? Number(env["MOLIRIS_WS_PING_INTERVAL_MS"])
    : undefined;
  const wsPingTimeoutMs = env["MOLIRIS_WS_PING_TIMEOUT_MS"] && !isNaN(Number(env["MOLIRIS_WS_PING_TIMEOUT_MS"]))
    ? Number(env["MOLIRIS_WS_PING_TIMEOUT_MS"])
    : undefined;

  // Parametri opzionali Filesystem Remoto Robot (§5.5, §10.3, §11.5, §11.6, §11.7)
  const rawRemoteFsInitialPath = env["MOLIRIS_REMOTE_FS_INITIAL_PATH"]?.trim();
  const remoteFsInitialPath = rawRemoteFsInitialPath && rawRemoteFsInitialPath.length > 0
    ? rawRemoteFsInitialPath
    : undefined;

  const rawRemoteFsAllowed = env["MOLIRIS_REMOTE_FS_ALLOWED_PATHS"]?.trim();
  const remoteFsAllowedPaths = rawRemoteFsAllowed
    ? rawRemoteFsAllowed.split(",").map(p => p.trim()).filter(Boolean)
    : undefined;

  const remoteFsMaxDirectoryEntries = env["MOLIRIS_REMOTE_FS_MAX_ENTRIES"] && !isNaN(Number(env["MOLIRIS_REMOTE_FS_MAX_ENTRIES"]))
    ? Number(env["MOLIRIS_REMOTE_FS_MAX_ENTRIES"])
    : undefined;

  const rawOverwritePolicy = env["MOLIRIS_REMOTE_FS_OVERWRITE_POLICY"]?.trim().toLowerCase();
  const remoteFsOverwritePolicy = (rawOverwritePolicy === "rifiuta" || rawOverwritePolicy === "sovrascrivi")
    ? (rawOverwritePolicy as "rifiuta" | "sovrascrivi")
    : undefined;

  const remoteFsConnectionIdleTimeoutMs = env["MOLIRIS_REMOTE_FS_IDLE_TIMEOUT_MS"] && !isNaN(Number(env["MOLIRIS_REMOTE_FS_IDLE_TIMEOUT_MS"]))
    ? Number(env["MOLIRIS_REMOTE_FS_IDLE_TIMEOUT_MS"])
    : undefined;

  // Parametri opzionali Trasferimento File (§5.5, §11.5, §11.7, RF-TRF-001..014)
  const transferChunkSizeBytes = env["MOLIRIS_TRANSFER_CHUNK_SIZE_BYTES"] && !isNaN(Number(env["MOLIRIS_TRANSFER_CHUNK_SIZE_BYTES"]))
    ? Number(env["MOLIRIS_TRANSFER_CHUNK_SIZE_BYTES"])
    : undefined;

  const rawChecksumAlgo = env["MOLIRIS_TRANSFER_CHECKSUM_ALGO"]?.trim().toLowerCase();
  const transferChecksumAlgorithm = (rawChecksumAlgo === "sha256" || rawChecksumAlgo === "md5")
    ? (rawChecksumAlgo as "sha256" | "md5")
    : undefined;

  if (transferChecksumAlgorithm === "md5") {
    console.warn("[AVVISO SICUREZZA] Algoritmo MD5 selezionato per i checksum dei trasferimenti: algoritmo crittograficamente debole e sconsigliato. Si raccomanda sha256.");
  }

  // Modalità verifica integrità trasferimenti (Problema A1, default baseline: stream; readback è PROPOSTA DA CONFERMARE)
  const rawVerifyMode = env["MOLIRIS_TRANSFER_VERIFY_MODE"]?.trim().toLowerCase();
  const transferVerifyMode: "stream" | "readback" = rawVerifyMode === "readback" ? "readback" : "stream";

  // Sostituzione non atomica sul robot in assenza di posix-rename (Problema A2, default false)
  const rawNonAtomic = env["MOLIRIS_ROBOT_NONATOMIC_REPLACE"]?.trim().toLowerCase();
  const robotNonAtomicReplace = rawNonAtomic === "true";

  // Margine di spazio trasferimento in MB (Problema A4, default 0; PROPOSTA DA CONFERMARE)
  const transferSpaceMarginMb = env["MOLIRIS_TRANSFER_SPACE_MARGIN_MB"] && !isNaN(Number(env["MOLIRIS_TRANSFER_SPACE_MARGIN_MB"]))
    ? Number(env["MOLIRIS_TRANSFER_SPACE_MARGIN_MB"])
    : 0;

  // Formato file di stato (Problema B1, default "auto", oppure "json", "keyvalue")
  const rawStateFormat = env["MOLIRIS_STATE_FILE_FORMAT"]?.trim().toLowerCase();
  const stateFileFormat: "auto" | "json" | "keyvalue" =
    rawStateFormat === "json" || rawStateFormat === "keyvalue" ? rawStateFormat : "auto";

  // Schema file di stato opzionale (Problema B1)
  const stateFileSchemaPath = env["MOLIRIS_STATE_FILE_SCHEMA"]?.trim() || undefined;

  const rawTrfOverwritePolicy = env["MOLIRIS_TRANSFER_OVERWRITE_POLICY"]?.trim().toLowerCase();
  const transferOverwritePolicy = (rawTrfOverwritePolicy === "rifiuta" || rawTrfOverwritePolicy === "richiedi_conferma" || rawTrfOverwritePolicy === "sovrascrivi")
    ? (rawTrfOverwritePolicy as "rifiuta" | "richiedi_conferma" | "sovrascrivi")
    : undefined;

  const rawResume = env["MOLIRIS_TRANSFER_RESUME_ENABLED"]?.trim().toLowerCase();
  const transferResumeEnabled = rawResume === "true" ? true : rawResume === "false" ? false : undefined;

  const rawQueuePolicy = env["MOLIRIS_TRANSFER_CONCURRENCY_POLICY"]?.trim().toLowerCase();
  const transferConcurrencyQueuePolicy = (rawQueuePolicy === "rifiuta" || rawQueuePolicy === "coda")
    ? (rawQueuePolicy as "rifiuta" | "coda")
    : undefined;

  const transferIdleTimeoutMs = env["MOLIRIS_TRANSFER_IDLE_TIMEOUT_MS"] && !isNaN(Number(env["MOLIRIS_TRANSFER_IDLE_TIMEOUT_MS"]))
    ? Number(env["MOLIRIS_TRANSFER_IDLE_TIMEOUT_MS"])
    : undefined;

  const defaultSshPort = env["MOLIRIS_DEFAULT_SSH_PORT"] && !isNaN(Number(env["MOLIRIS_DEFAULT_SSH_PORT"]))
    ? Number(env["MOLIRIS_DEFAULT_SSH_PORT"])
    : 22;

  return {
    serverFilesystemRoot,
    pollingIntervalSeconds,
    sshConnectionTimeoutMs,
    maxConcurrentTransfersPerUser,
    maxConcurrentTransfersPerRobot,
    maxConcurrentTransfersServer,
    maxFileSizeBytes,
    quotaPerRobotBytes,
    tempFileRetentionMinutes,
    stateFilePaths,
    inactiveSessionTimeoutMinutes,
    sessionAbsoluteMaxMinutes,
    tlsCertPath,
    tlsKeyPath,
    credentialProviderType,
    masterKeyFilePath,
    standardSubdirectories,
    serverDirectoryPermissions,
    registrationMode,
    robotUsernameUniqueness,
    auditLogRetentionDays,
    allowedSshAuthMethods,
    allowedDestinations,
    maxConcurrentRegistrationVerifications,
    existingDirectoryPolicy,
    activeSessionPolicyOnDisable,
    staleDataThresholdSeconds,
    terminalSessionTimeoutMinutes,
    maxConcurrentTerminalSessionsServer,
    maxConcurrentTerminalSessionsPerUser,
    maxConcurrentTerminalSessionsPerRobot,
    terminalDisconnectPolicy,
    wsPingIntervalMs,
    wsPingTimeoutMs,
    remoteFsInitialPath,
    remoteFsAllowedPaths,
    remoteFsMaxDirectoryEntries,
    remoteFsOverwritePolicy,
    remoteFsConnectionIdleTimeoutMs,
    transferChunkSizeBytes,
    transferChecksumAlgorithm,
    transferOverwritePolicy,
    transferResumeEnabled,
    transferConcurrencyQueuePolicy,
    transferIdleTimeoutMs,
    transferVerifyMode,
    robotNonAtomicReplace,
    transferSpaceMarginMb,
    stateFileFormat,
    stateFileSchemaPath,
    defaultSshPort,
  };
}
