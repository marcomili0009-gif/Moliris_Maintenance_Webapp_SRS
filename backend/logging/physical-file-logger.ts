// Requisiti soddisfatti: Requisito #8, RNF-SEC-002, RNF-SEC-004, RNF-SEC-005, SRS §10.1, §10.4

import fs from "fs";
import path from "path";

export interface AccessLogEntry {
  event: "LOGIN" | "LOGOUT" | "INACTIVITY_LOGOUT" | string;
  username: string;
  role: string; // "Amministratore" | "Operatore"
  outcome: "SUCCESSO" | "FALLIMENTO";
  details?: string | Record<string, any>;
  timestamp?: Date;
}

export interface TransferLogEntry {
  filename: string;
  username: string;
  direction: string; // "SERVER_TO_ROBOT" | "ROBOT_TO_SERVER" | "CLIENT_TO_SERVER" | "CLIENT_TO_ROBOT" | "ROBOT_TO_ROBOT"
  outcome: "SUCCESSO" | "FALLIMENTO";
  details?: string | Record<string, any>;
  timestamp?: Date;
}

export interface BulkSummary {
  completed: number;
  cancelled: number;
  failed: number;
  totalFiles: number;
  outcome?: string;
}

/**
 * Formatta un timestamp nel formato tassativo [YYYY-MM-DD HH:MM:SS].
 */
export function formatLogTimestamp(date: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const y = date.getFullYear();
  const m = pad(date.getMonth() + 1);
  const d = pad(date.getDate());
  const h = pad(date.getHours());
  const min = pad(date.getMinutes());
  const s = pad(date.getSeconds());
  return `${y}-${m}-${d} ${h}:${min}:${s}`;
}

/**
 * Sanitizza i dettagli rimuovendo qualsiasi segreto, password o token sensibile.
 */
export function sanitizeLogDetails(details?: string | Record<string, any>): string {
  if (!details) return "N/A";
  if (typeof details === "string") {
    let s = details;
    s = s.replace(/password[:=]\s*[^\s,;]+/gi, "password: [REDACTED]");
    s = s.replace(/token[:=]\s*[^\s,;]+/gi, "token: [REDACTED]");
    s = s.replace(/secret[:=]\s*[^\s,;]+/gi, "secret: [REDACTED]");
    s = s.replace(/authorization[:=]\s*[^\s,;]+/gi, "authorization: [REDACTED]");
    s = s.replace(/passwordhash[:=]\s*[^\s,;]+/gi, "passwordHash: [REDACTED]");
    return s.trim() || "N/A";
  }

  try {
    const copy = { ...details };
    const forbiddenKeys = ["password", "passwordHash", "token", "secret", "privateKey", "cookie", "authorization"];
    for (const key of Object.keys(copy)) {
      if (forbiddenKeys.some((f) => key.toLowerCase().includes(f.toLowerCase()))) {
        copy[key] = "[REDACTED]";
      }
    }
    return JSON.stringify(copy);
  } catch {
    return "N/A";
  }
}

/**
 * Normalizza il ruolo per l'output leggibile: Amministratore o Operatore.
 */
export function normalizeRoleForLog(roleOrRoles?: string | string[]): string {
  if (!roleOrRoles) return "Operatore";
  const roles = Array.isArray(roleOrRoles) ? roleOrRoles : [roleOrRoles];
  const isAdmin = roles.some((r) => {
    const lower = (r || "").toLowerCase();
    return lower === "amministratore" || lower === "admin";
  });
  return isAdmin ? "Amministratore" : "Operatore";
}

/**
 * PhysicalFileLogger scrive direttamente su disco fisico su access.log e transfers.log
 * applicando rigorosamente permessi 0700 alla directory e 0600 ai file (RNF-SEC-005, Requisito #8).
 */
export class PhysicalFileLogger {
  private logDir: string;
  private accessLogPath: string;
  private transfersLogPath: string;
  private initialized = false;

  constructor(logDir?: string) {
    this.logDir = logDir
      ? path.resolve(logDir)
      : path.resolve(process.cwd(), "logs");
    this.accessLogPath = path.join(this.logDir, "access.log");
    this.transfersLogPath = path.join(this.logDir, "transfers.log");
  }

  public getLogDir(): string {
    return this.logDir;
  }

  public getAccessLogFilePath(): string {
    return this.accessLogPath;
  }

  public getTransferLogFilePath(): string {
    return this.transfersLogPath;
  }

  /**
   * Assicura che la directory esista con permessi 0700 e i file con 0600.
   */
  public async ensureInitialized(): Promise<void> {
    if (this.initialized) return;

    if (!fs.existsSync(this.logDir)) {
      await fs.promises.mkdir(this.logDir, { recursive: true, mode: 0o700 });
    }
    try {
      await fs.promises.chmod(this.logDir, 0o700);
    } catch {}

    for (const file of [this.accessLogPath, this.transfersLogPath]) {
      if (!fs.existsSync(file)) {
        await fs.promises.writeFile(file, "", { mode: 0o600 });
      }
      try {
        await fs.promises.chmod(file, 0o600);
      } catch {}
    }

    this.initialized = true;
  }

  private async append(filePath: string, line: string): Promise<void> {
    await this.ensureInitialized();
    await fs.promises.appendFile(filePath, line + "\n", { encoding: "utf-8", mode: 0o600 });
    try {
      await fs.promises.chmod(filePath, 0o600);
    } catch {}
  }

  /**
   * Registra un evento di accesso nel file access.log
   * Formato: [YYYY-MM-DD HH:MM:SS] EVENT: <LOGIN|LOGOUT|INACTIVITY_LOGOUT> | Utente: <username> | Ruolo: <Amministratore|Operatore> | Esito: <SUCCESSO|FALLIMENTO> | Dettagli: <dettagli>
   */
  public async logAccess(entry: AccessLogEntry): Promise<string> {
    const ts = formatLogTimestamp(entry.timestamp || new Date());
    const role = normalizeRoleForLog(entry.role);
    const details = sanitizeLogDetails(entry.details);
    const line = `[${ts}] EVENT: ${entry.event} | Utente: ${entry.username} | Ruolo: ${role} | Esito: ${entry.outcome} | Dettagli: ${details}`;
    await this.append(this.accessLogPath, line);
    return line;
  }

  /**
   * Registra un trasferimento di file in transfers.log
   * Formato: [YYYY-MM-DD HH:MM:SS] File: <filename> | Utente: <username> | Direzione: <SERVER_TO_ROBOT|ROBOT_TO_SERVER|...> | Esito: <SUCCESSO|FALLIMENTO> | Dettagli: <info_o_errore>
   */
  public async logTransfer(entry: TransferLogEntry): Promise<string> {
    const ts = formatLogTimestamp(entry.timestamp || new Date());
    const details = sanitizeLogDetails(entry.details);
    const line = `[${ts}] File: ${entry.filename} | Utente: ${entry.username} | Direzione: ${entry.direction} | Esito: ${entry.outcome} | Dettagli: ${details}`;
    await this.append(this.transfersLogPath, line);
    return line;
  }

  /**
   * Delimita l'inizio di un caricamento massivo in transfers.log
   */
  public async logBulkStart(batchId: string, username: string, totalFiles: number): Promise<string> {
    const ts = formatLogTimestamp(new Date());
    const line = `=== INIZIO CARICAMENTO MASSIVO [batchId: ${batchId}] (${totalFiles} file) - Utente: ${username} [${ts}] ===`;
    await this.append(this.transfersLogPath, line);
    return line;
  }

  /**
   * Registra un singolo file di un caricamento massivo in transfers.log
   * Tag: [FILE k/N]
   */
  public async logBulkFile(
    batchId: string,
    k: number,
    totalFiles: number,
    entry: TransferLogEntry
  ): Promise<string> {
    const ts = formatLogTimestamp(entry.timestamp || new Date());
    const details = sanitizeLogDetails(entry.details);
    const line = `[${ts}] [batchId: ${batchId}] [FILE ${k}/${totalFiles}] File: ${entry.filename} | Utente: ${entry.username} | Direzione: ${entry.direction} | Esito: ${entry.outcome} | Dettagli: ${details}`;
    await this.append(this.transfersLogPath, line);
    return line;
  }

  /**
   * Delimita il termine di un caricamento massivo in transfers.log
   */
  public async logBulkEnd(batchId: string, summary: BulkSummary): Promise<string> {
    const ts = formatLogTimestamp(new Date());
    const outcome = summary.outcome || (summary.failed === 0 && summary.cancelled === 0 ? "SUCCESSO" : summary.completed > 0 ? "PARZIALE" : "FALLITO");
    const line = `=== CARICAMENTO MASSIVO TERMINATO [batchId: ${batchId}] - Esito: ${outcome} (Completati: ${summary.completed}/${summary.totalFiles}, Annullati: ${summary.cancelled}, Falliti: ${summary.failed}) [${ts}] ===`;
    await this.append(this.transfersLogPath, line);
    return line;
  }

  /**
   * Legge le righe del file access.log con supporto filtri (user, event, limit).
   */
  public async getAccessLogs(filter?: { user?: string; event?: string; limit?: number }): Promise<string[]> {
    await this.ensureInitialized();
    if (!fs.existsSync(this.accessLogPath)) return [];

    const content = await fs.promises.readFile(this.accessLogPath, "utf-8");
    let lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);

    if (filter?.user) {
      const userTarget = `Utente: ${filter.user}`;
      lines = lines.filter((l) => l.includes(userTarget));
    }
    if (filter?.event) {
      const eventTarget = `EVENT: ${filter.event}`;
      lines = lines.filter((l) => l.includes(eventTarget));
    }

    const limit = filter?.limit && filter.limit > 0 ? Math.min(filter.limit, 1000) : 100;
    return lines.slice(-limit);
  }

  /**
   * Legge le righe del file transfers.log con supporto filtri (user, outcome, limit).
   */
  public async getTransferLogs(filter?: { user?: string; outcome?: string; limit?: number }): Promise<string[]> {
    await this.ensureInitialized();
    if (!fs.existsSync(this.transfersLogPath)) return [];

    const content = await fs.promises.readFile(this.transfersLogPath, "utf-8");
    let lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);

    if (filter?.user) {
      const userTarget = `Utente: ${filter.user}`;
      lines = lines.filter((l) => l.includes(userTarget));
    }
    if (filter?.outcome) {
      const outcome = filter.outcome;
      const outcomeTarget = `Esito: ${outcome}`;
      lines = lines.filter((l) => l.includes(outcomeTarget) || l.includes(`Esito: ${outcome.toUpperCase()}`));
    }

    const limit = filter?.limit && filter.limit > 0 ? Math.min(filter.limit, 1000) : 100;
    return lines.slice(-limit);
  }
}
