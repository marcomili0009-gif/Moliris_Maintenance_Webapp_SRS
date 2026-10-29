// Requisiti soddisfatti: RNF-MNT-001, RF-ROB-005, RF-TRF-012, RF-AUTH-006, RF-MON-001, RF-ROB-009, RF-SRVFS-007, RNF-SEC-002, §8.1

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
  tlsCertPath: string; // Riferimento sicuro senza contenere segreti (RNF-SEC-002)
  tlsKeyPath: string;  // Riferimento sicuro senza contenere segreti (RNF-SEC-002)

  // 9. Sottodirectory standard da creare per robot [opzionali] (RF-ROB-009, RF-SRVFS-007)
  standardSubdirectories?: string[];

  // 10. Permessi di accesso per le directory dei robot [opzionali] (RNF-FS-001, §11.1)
  serverDirectoryPermissions?: string;

  // 11. Modalità di registrazione: rigorosa o differita (§8.1, §11.3)
  registrationMode: "rigorosa" | "differita";

  // 12. Politica di conservazione degli eventi di audit (in giorni) (§10.4, RNF-SEC-009, §11.1)
  auditLogRetentionDays: number;

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

  if (missing.length > 0) {
    throw new Error(`Inizializzazione fallita. Parametri di configurazione obbligatori mancanti: ${missing.join(", ")}`);
  }

  // Parametri opzionali (se non specificati rimangono undefined senza inventare valori numerici)
  const maxFileSizeBytes = env["MOLIRIS_MAX_FILE_SIZE_BYTES"] && !isNaN(Number(env["MOLIRIS_MAX_FILE_SIZE_BYTES"]))
    ? Number(env["MOLIRIS_MAX_FILE_SIZE_BYTES"])
    : undefined;

  const quotaPerRobotBytes = env["MOLIRIS_QUOTA_PER_ROBOT_BYTES"] && !isNaN(Number(env["MOLIRIS_QUOTA_PER_ROBOT_BYTES"]))
    ? Number(env["MOLIRIS_QUOTA_PER_ROBOT_BYTES"])
    : undefined;

  const standardSubdirectories = env["MOLIRIS_STANDARD_SUBDIRS"]
    ? env["MOLIRIS_STANDARD_SUBDIRS"].split(",").map(s => s.trim()).filter(Boolean)
    : undefined;

  const serverDirectoryPermissions = env["MOLIRIS_DIR_PERMISSIONS"]
    ? env["MOLIRIS_DIR_PERMISSIONS"].trim()
    : undefined;

  // L'unico default ammesso dalla SRS è la porta SSH 22 (RF-ROB-005)
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
    tlsCertPath,
    tlsKeyPath,
    standardSubdirectories,
    serverDirectoryPermissions,
    registrationMode,
    auditLogRetentionDays,
    defaultSshPort,
  };
}
