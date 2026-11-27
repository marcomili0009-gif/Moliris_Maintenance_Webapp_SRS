// Requisiti soddisfatti: Requisito #8, RNF-SEC-002, RNF-SEC-004, RNF-SEC-005, SRS §10.1, §10.4

import fs from "fs";
import path from "path";
import { Readable } from "node:stream";
import { redactSensitiveData } from "../../logging/logger.ts";

export interface AccessLogEntry {
  event: "LOGIN" | "LOGOUT" | "INACTIVITY_LOGOUT" | string;
  username: string;
  role?: string | string[];
  outcome: "SUCCESSO" | "FALLIMENTO";
  details?: string | Record<string, any>;
  timestamp?: Date;
}

export interface TransferLogRoute {
  direction: string;
  source?: string;
  destination?: string;
}

export interface TransferLogEntry extends TransferLogRoute {
  filename: string;
  username: string;
  outcome: "SUCCESSO" | "FALLIMENTO" | "ANNULLATO";
  transferId?: string;
  batchId?: string;
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
 * Formatta un timestamp UTC nel formato tassativo [YYYY-MM-DD HH:MM:SS].
 */
export function formatLogTimestamp(date: Date = new Date()): string {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

/**
 * Rende un valore testuale sicuro per una riga di log a campi delimitati.
 * I caratteri di controllo diventano sequenze visibili; pipe e marcatori di
 * delimitazione vengono escaped prima di qualsiasi concatenazione.
 */
export function sanitizeLogText(value: string): string {
  return String(value ?? "")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, (char) =>
      `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`
    )
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029")
    .replace(/\|/g, "\\|")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .replace(/={3,}/g, (match) => match.replace(/=/g, "\\="));
}

function redactLogValue(value: string): string {
  return redactSensitiveData(value)
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi, "$1[REDACTED]@");
}

/**
 * Sanitizza i dettagli rimuovendo segreti e neutralizzando i delimitatori.
 */
export function sanitizeLogDetails(details?: string | Record<string, any>): string {
  if (!details) return "N/A";
  if (typeof details === "string") {
    let s = redactLogValue(details);
    s = s.replace(/password[:=]\s*[^\s,;]+/gi, "password: [REDACTED]");
    s = s.replace(/token[:=]\s*[^\s,;]+/gi, "token: [REDACTED]");
    s = s.replace(/secret[:=]\s*[^\s,;]+/gi, "secret: [REDACTED]");
    s = s.replace(/authorization[:=]\s*[^\s,;]+/gi, "authorization: [REDACTED]");
    s = s.replace(/passwordhash[:=]\s*[^\s,;]+/gi, "passwordHash: [REDACTED]");
    s = s.replace(/passphrase[:=]\s*[^\s,;]+/gi, "passphrase: [REDACTED]");
    return sanitizeLogText(s.trim()).replace(/\\\[REDACTED\\\]/g, "[REDACTED]") || "N/A";
  }

  try {
    const forbiddenKeys = [
      "password",
      "passwordHash",
      "passphrase",
      "token",
      "secret",
      "privateKey",
      "cookie",
      "authorization",
    ];
    const serialized = JSON.stringify(details, (key, value) => {
      if (key && forbiddenKeys.some((f) => key.toLowerCase().includes(f.toLowerCase()))) {
        return "[REDACTED]";
      }
      return typeof value === "string" ? redactLogValue(value) : value;
    });
    return sanitizeLogText(serialized || "N/A").replace(/\\\[REDACTED\\\]/g, "[REDACTED]");
  } catch {
    return "N/A";
  }
}

/**
 * Normalizza il ruolo per l'output leggibile: Amministratore o Operatore.
 */
export function normalizeRoleForLog(roleOrRoles?: string | string[]): string {
  const roles = (Array.isArray(roleOrRoles) ? roleOrRoles : [roleOrRoles])
    .map((role) => role?.trim().toLowerCase());
  if (roles.includes("admin") || roles.includes("amministratore")) return "Amministratore";
  if (roles.includes("operatore")) return "Operatore";
  return "—";
}

/**
 * PhysicalFileLogger scrive direttamente su disco fisico su access.log e transfers.log
 * applicando rigorosamente permessi 0700 alla directory e 0600 ai file (RNF-SEC-005, Requisito #8).
 */
export class PhysicalFileLogger {
  private logDir: string;
  private accessLogPath: string;
  private transfersLogPath: string;
  private maxFileSizeBytes: number;
  private maxRotatedFiles: number;
  private initialized = false;

  constructor(logDir?: string, options?: { maxFileSizeBytes?: number; maxRotatedFiles?: number }) {
    this.logDir = logDir
      ? path.resolve(logDir)
      : path.resolve(process.cwd(), "logs");
    this.accessLogPath = path.join(this.logDir, "access.log");
    this.transfersLogPath = path.join(this.logDir, "transfers.log");
    const envMaxBytes = Number(process.env["MOLIRIS_LOG_MAX_BYTES"]);
    const envMaxFiles = Number(process.env["MOLIRIS_LOG_MAX_FILES"]);
    this.maxFileSizeBytes =
      options?.maxFileSizeBytes && options.maxFileSizeBytes > 0
        ? options.maxFileSizeBytes
        : Number.isFinite(envMaxBytes) && envMaxBytes > 0
        ? envMaxBytes
        : 10 * 1024 * 1024; // 10 MB predefinito
    this.maxRotatedFiles =
      options?.maxRotatedFiles && options.maxRotatedFiles > 0
        ? options.maxRotatedFiles
        : Number.isFinite(envMaxFiles) && envMaxFiles > 0
        ? Math.min(envMaxFiles, 20)
        : 5;
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
        await fs.promises.appendFile(file, "", { mode: 0o600 });
      }
      try {
        await fs.promises.chmod(file, 0o600);
      } catch {}
    }

    this.initialized = true;
  }

  private async rotateIfNeeded(filePath: string, incomingBytes: number): Promise<void> {
    try {
      const stat = await fs.promises.stat(filePath);
      if (stat.size + incomingBytes <= this.maxFileSizeBytes) return;

      for (let i = this.maxRotatedFiles; i >= 1; i--) {
        const src = i === 1 ? filePath : `${filePath}.${i - 1}`;
        const dst = `${filePath}.${i}`;
        if (!fs.existsSync(src)) continue;
        if (i === this.maxRotatedFiles && fs.existsSync(dst)) {
          await fs.promises.unlink(dst).catch(() => {});
        }
        await fs.promises.rename(src, dst);
        await fs.promises.chmod(dst, 0o600).catch(() => {});
      }

      await fs.promises.writeFile(filePath, "", { mode: 0o600 });
      await fs.promises.chmod(filePath, 0o600).catch(() => {});
    } catch {
      // Se il file non esiste ancora, appendFile lo creerà con mode 0600
    }
  }

  private async append(filePath: string, line: string): Promise<void> {
    await this.ensureInitialized();
    const payload = line + "\n";
    // Lo storico dei trasferimenti è append-only. Manteniamo leggibili anche le
    // copie numerate prodotte dalla politica precedente.
    if (filePath !== this.transfersLogPath) {
      await this.rotateIfNeeded(filePath, Buffer.byteLength(payload, "utf-8"));
    }
    await fs.promises.appendFile(filePath, payload, { encoding: "utf-8", mode: 0o600 });
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
    const event = sanitizeLogText(entry.event);
    const username = sanitizeLogText(entry.username);
    const outcome = sanitizeLogText(entry.outcome);
    const line = `[${ts}] EVENT: ${event} | Utente: ${username} | Ruolo: ${role} | Esito: ${outcome} | Dettagli: ${details}`;
    await this.append(this.accessLogPath, line);
    return line;
  }

  /**
   * Registra un trasferimento di file in transfers.log
   * Formato: [YYYY-MM-DD HH:MM:SS] File: <filename> | Utente: <username> | Direzione: <SERVER_TO_ROBOT|ROBOT_TO_SERVER|...> | Esito: <SUCCESSO|FALLIMENTO> | Dettagli: <info_o_errore>
   */
  public async logTransfer(entry: TransferLogEntry): Promise<string> {
    const ts = formatLogTimestamp(entry.timestamp || new Date());
    const field = (value: string) => sanitizeLogText(redactLogValue(value));
    const details = sanitizeLogDetails(entry.details);
    const metadata = [
      entry.source && `Sorgente: ${field(entry.source)}`,
      entry.destination && `Destinazione: ${field(entry.destination)}`,
      entry.batchId && `Batch: ${field(entry.batchId)}`,
      entry.transferId && `ID: ${field(entry.transferId)}`,
    ].filter(Boolean);
    const extra = metadata.length ? ` | ${metadata.join(" | ")}` : "";
    const line = `[${ts}] File: ${field(entry.filename)} | Utente: ${field(entry.username)} | Direzione: ${field(entry.direction)} | Esito: ${entry.outcome}${extra} | Dettagli: ${details}`;
    await this.append(this.transfersLogPath, line);
    return line;
  }

  /**
   * Delimita l'inizio di un caricamento massivo in transfers.log
   * Formato allineato a SRS §6.2 / Specifiche di Sistema §6:
   *   === INIZIO CARICAMENTO MASSIVO ===
   *   Utente: <nome> | Data: <YYYY-MM-DD> | Ora: HH:MM:SS
   * I campi esterni (batchId, numero file) sono mantenuti come estensione tra parentesi.
   */
  public async logBulkStart(batchId: string, username: string, totalFiles: number): Promise<string> {
    const ts = formatLogTimestamp(new Date());
    const safeBatchId = sanitizeLogText(batchId);
    const safeUsername = sanitizeLogText(username);
    const line = `=== INIZIO CARICAMENTO MASSIVO === [batchId: ${safeBatchId}] (${totalFiles} file) Utente: ${safeUsername} | Data: ${ts.slice(0, 10)} | Ora: ${ts.slice(11)} ===`;
    await this.append(this.transfersLogPath, line);
    return line;
  }

  /**
   * Registra un singolo file di un caricamento massivo in transfers.log
   * Formato allineato a SRS §6.2 / Specifiche di Sistema §6:
   *   File N: <nome_file> | Esito: OK
   *   File N: <nome_file> | Esito: FALLITO (motivo)
   * I campi esterni (batchId, FILE k/N, direzione, dettagli) sono mantenuti come estensione.
   */
  public async logBulkFile(
    batchId: string,
    k: number,
    totalFiles: number,
    entry: TransferLogEntry
  ): Promise<string> {
    const ts = formatLogTimestamp(entry.timestamp || new Date());
    const details = sanitizeLogDetails(entry.details);
    const safeBatchId = sanitizeLogText(batchId);
    const filename = sanitizeLogText(entry.filename);
    const direction = sanitizeLogText(entry.direction);
    const outcome = sanitizeLogText(entry.outcome);
    const failedReason = outcome === "FALLIMENTO" && details && details !== "N/A" ? ` (${details})` : "";
    const line = `[batchId: ${safeBatchId}] [FILE ${k}/${totalFiles}] File ${k}: ${filename} | Esito: ${outcome}${failedReason} | Direzione: ${direction} | Dettagli: ${details}`;
    await this.append(this.transfersLogPath, line);
    return line;
  }

  /**
   * Delimita il termine di un caricamento massivo in transfers.log
   * Formato allineato a SRS §6.2 / Specifiche di Sistema §6:
   *   === CARICAMENTO MASSIVO TERMINATO ===
   */
  public async logBulkEnd(batchId: string, summary: BulkSummary): Promise<string> {
    const ts = formatLogTimestamp(new Date());
    const outcome = summary.outcome || (summary.failed === 0 && summary.cancelled === 0 ? "SUCCESSO" : summary.completed > 0 ? "PARZIALE" : "FALLITO");
    const safeBatchId = sanitizeLogText(batchId);
    const safeOutcome = sanitizeLogText(outcome);
    const line = `=== CARICAMENTO MASSIVO TERMINATO === [batchId: ${safeBatchId}] - Esito: ${safeOutcome} (Completati: ${summary.completed}/${summary.totalFiles}, Annullati: ${summary.cancelled}, Falliti: ${summary.failed}) | Data: ${ts.slice(0, 10)} | Ora: ${ts.slice(11)} ===`;
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

  private async clearLogFiles(primaryPath: string, rotatedPattern: RegExp): Promise<void> {
    await this.ensureInitialized();
    await fs.promises.writeFile(primaryPath, "", { encoding: "utf-8", mode: 0o600 });
    try {
      await fs.promises.chmod(primaryPath, 0o600);
    } catch {}

    const entries = await fs.promises.readdir(this.logDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && rotatedPattern.test(entry.name)) {
        await fs.promises.unlink(path.join(this.logDir, entry.name));
      }
    }
  }

  /**
   * Svuota esclusivamente il registro access.log ed eventuali file ruotati access.log.<N>.
   * Non modifica transfers.log.
   */
  public async clearAccessLogs(): Promise<void> {
    await this.clearLogFiles(this.accessLogPath, /^access\.log\.\d+$/);
  }

  /**
   * Svuota esclusivamente il registro transfers.log ed eventuali archivi ruotati transfers.log.<N>.
   * Non modifica access.log.
   */
  public async clearTransferLogs(): Promise<void> {
    await this.clearLogFiles(this.transfersLogPath, /^transfers\.log\.\d+$/);
  }

  // Dall'archivio più recente a quello più vecchio, poi invertiti per il download.
  private async transferLogPaths(): Promise<string[]> {
    await this.ensureInitialized();
    const entries = await fs.promises.readdir(this.logDir, { withFileTypes: true });
    const archives = entries
      .filter((entry) => entry.isFile() && /^transfers\.log\.\d+$/.test(entry.name))
      .sort((a, b) => Number(a.name.slice(14)) - Number(b.name.slice(14)));
    return [this.transfersLogPath, ...archives.map((entry) => path.join(this.logDir, entry.name))];
  }

  public async openTransferLogDownload(): Promise<Readable> {
    const paths = (await this.transferLogPaths()).reverse();
    return Readable.from((async function* () {
      let needsSeparator = false;
      for (const filePath of paths) {
        let firstChunk = true;
        for await (const chunk of fs.createReadStream(filePath) as AsyncIterable<Buffer>) {
          if (firstChunk && needsSeparator) yield "\n";
          yield chunk;
          needsSeparator = chunk[chunk.length - 1] !== 10;
          firstChunk = false;
        }
      }
    })());
  }

  public async getTransferLogs(filter?: { user?: string; outcome?: string; limit?: number }): Promise<string[]> {
    const limit = filter?.limit && filter.limit > 0 ? Math.min(filter.limit, 1000) : 100;
    const lines: string[] = [];
    for (const filePath of await this.transferLogPaths()) {
      for await (const line of readLogLinesBackwards(filePath)) {
        if (!line.trim()) continue;
        const entry = line.split(" | Dettagli:")[0];
        const user = /(?:^|\|) Utente: (.*?)(?: \||$)/.exec(entry)?.[1];
        const rawOutcome = / \| Esito: ([\p{L}_]+)/u.exec(entry)?.[1]?.toUpperCase();
        const outcome = rawOutcome === "OK" || rawOutcome === "COMPLETED" ? "SUCCESSO"
          : rawOutcome === "FALLITO" || rawOutcome === "FAILED" || rawOutcome === "INTEGRITY_FAILED" || rawOutcome === "PARZIALE" ? "FALLIMENTO"
          : rawOutcome === "CANCELLED" ? "ANNULLATO" : rawOutcome;
        const genuineEntry = /^\[\d{4}-\d{2}-\d{2} |^\[batchId: /.test(entry);
        if (filter?.user && !user?.includes(sanitizeLogText(filter.user))) continue;
        if (filter?.outcome && (!genuineEntry || outcome !== filter.outcome.toUpperCase())) continue;
        lines.push(line);
        if (lines.length === limit) return lines.reverse();
      }
    }
    return lines.reverse();
  }
}

async function* readLogLinesBackwards(filePath: string): AsyncGenerator<string> {
  const handle = await fs.promises.open(filePath, "r");
  try {
    let position = (await handle.stat()).size;
    let prefix = Buffer.alloc(0);
    while (position > 0) {
      const size = Math.min(position, 64 * 1024);
      position -= size;
      const chunk = Buffer.allocUnsafe(size);
      const { bytesRead } = await handle.read(chunk, 0, size, position);
      const data = Buffer.concat([chunk.subarray(0, bytesRead), prefix]);
      let end = data.length;
      for (let index = end - 1; index >= 0; index--) {
        if (data[index] === 10) {
          yield data.toString("utf8", index + 1, end).replace(/\r$/, "");
          end = index;
        }
      }
      prefix = data.subarray(0, end);
    }
    if (prefix.length) yield prefix.toString("utf8").replace(/\r$/, "");
  } finally {
    await handle.close();
  }
}
