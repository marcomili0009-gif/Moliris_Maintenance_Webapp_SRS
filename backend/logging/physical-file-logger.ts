// Requisiti soddisfatti: Requisito #8, RNF-SEC-002, RNF-SEC-004, RNF-SEC-005, SRS §10.1, §10.4

import fs from "fs";
import path from "path";
import { createHash, randomUUID } from "node:crypto";
import type { Collection, Db } from "mongodb";
import type { MolirisLogger } from "../../logging/logger.ts";
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

interface PendingLogEntry {
  _id: string;
  line: string;
  createdAt: Date;
  projectedAt: Date | null;
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
  private readonly journal?: Collection<PendingLogEntry>;
  private readonly logger?: MolirisLogger;
  private writes: Promise<unknown> = Promise.resolve();
  private retryTimer?: NodeJS.Timeout;
  private retrying = false;
  private journalIndexed = false;
  private lastArchiveTime = 0;
  private lastQueuedTime = 0;
  private persistenceFailure = false;
  private initialized = false;

  constructor(logDir?: string, options?: { maxFileSizeBytes?: number; maxRotatedFiles?: number; db?: Db; logger?: MolirisLogger }) {
    this.logDir = logDir
      ? path.resolve(logDir)
      : path.resolve(process.cwd(), "logs");
    this.accessLogPath = path.join(this.logDir, "access.log");
    this.transfersLogPath = path.join(this.logDir, "transfers.log");
    const envMaxBytes = Number(process.env["MOLIRIS_LOG_MAX_BYTES"]);
    this.journal = options?.db?.collection<PendingLogEntry>("transfer_log_outcomes");
    this.logger = options?.logger;
    this.maxFileSizeBytes =
      options?.maxFileSizeBytes && options.maxFileSizeBytes > 0
        ? options.maxFileSizeBytes
        : Number.isFinite(envMaxBytes) && envMaxBytes > 0
        ? envMaxBytes
        : 10 * 1024 * 1024; // 10 MB predefinito

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

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.writes.then(operation);
    this.writes = pending.catch(() => {});
    return pending;
  }

  public async startRecovery(): Promise<void> {
    if (!this.journal || this.retryTimer) return;
    const recover = () => {
      if (this.retrying) return;
      this.retrying = true;
      void this.enqueue(async () => {
        const journal = this.journal!;
        if (!this.journalIndexed) {
          await journal.createIndex({ projectedAt: 1, createdAt: 1 }, { timeoutMS: 2_000 });
          this.journalIndexed = true;
        }
        await this.recoverLocalSpool();
        for await (const entry of journal.find({ projectedAt: null }, { timeoutMS: 2_000 }).sort({ createdAt: 1 }).limit(200)) {
          await this.project(entry, true);
        }
      }).catch((error: unknown) => {
        this.reportWriteFailure("Proiezione degli esiti in sospeso non disponibile", error);
      }).finally(() => { this.retrying = false; });
    };
    this.retryTimer = setInterval(recover, 5_000);
    this.retryTimer.unref();
    recover();
  }

  public stopRecovery(): void {
    clearInterval(this.retryTimer);
    this.retryTimer = undefined;
  }

  public async flush(): Promise<void> {
    await this.writes;
  }

  public isPersistenceHealthy(): boolean {
    return !this.persistenceFailure;
  }

  private reportWriteFailure(message: string, error: unknown, id?: string): void {
    const context = { eventId: id, code: (error as NodeJS.ErrnoException)?.code };
    if (this.logger) this.logger.error(message, undefined, context);
    else console.error(message, context);
  }

  private async rotateIfNeeded(filePath: string, incomingBytes: number): Promise<void> {
    const stat = await fs.promises.stat(filePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return undefined;
    });
    if (!stat?.size || stat.size + incomingBytes <= this.maxFileSizeBytes) return;
    this.lastArchiveTime = Math.max(Date.now(), this.lastArchiveTime + 1);
    const timestamp = new Date(this.lastArchiveTime).toISOString().replace(/[:.]/g, "-");
    await fs.promises.rename(filePath, `${filePath}.archive.${timestamp}-${randomUUID()}`);
    const directory = await fs.promises.open(this.logDir, "r");
    try { await directory.sync(); } finally { await directory.close(); }
  }

  private async append(filePath: string, line: string): Promise<void> {
    await this.ensureInitialized();
    const payload = line + "\n";
    await this.rotateIfNeeded(filePath, Buffer.byteLength(payload));
    await fs.promises.appendFile(filePath, payload, { encoding: "utf-8", mode: 0o600, flush: true });
    const directory = await fs.promises.open(this.logDir, "r");
    try { await directory.sync(); } finally { await directory.close(); }
  }

  private async project(entry: PendingLogEntry, checkExisting: boolean): Promise<void> {
    if (entry.projectedAt) return;
    if (!checkExisting || !await this.hasExactLine(entry.line)) {
      await this.append(this.transfersLogPath, entry.line);
    }
    await this.journal!.updateOne(
      { _id: entry._id }, { $set: { projectedAt: new Date() } },
      { writeConcern: { w: "majority", journal: true }, timeoutMS: 2_000 },
    );
  }

  private async hasExactLine(expected: string): Promise<boolean> {
    for (const file of await this.logPaths(this.transfersLogPath)) {
      try {
        for await (const text of readLogLinesBackwards(file)) {
          if (text === expected) return true;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return false;
  }

  private async writeJournal(id: string, line: string, createdAt?: Date) {
    this.lastQueuedTime = Math.max(createdAt?.getTime() || Date.now(), this.lastQueuedTime + 1);
    const journalTime = new Date(this.lastQueuedTime);
    const result = await this.journal!.findOneAndUpdate(
      { _id: id }, { $setOnInsert: { line, createdAt: journalTime, projectedAt: null } },
      { upsert: true, returnDocument: "after", includeResultMetadata: true,
        writeConcern: { w: "majority", journal: true }, timeoutMS: 2_000 },
    );
    if (!result.value) throw new Error("Registrazione journal non confermata.");
    return { entry: result.value, duplicate: result.lastErrorObject?.updatedExisting === true };
  }

  private async spoolLocally(id: string, line: string): Promise<void> {
    const directory = path.join(this.logDir, ".transfer-log-pending");
    await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
    const digest = createHash("sha256").update(id).digest("hex");
    const file = path.join(directory, digest + ".json");
    const temporary = file + "." + randomUUID() + ".tmp";
    try {
      await fs.promises.writeFile(temporary, JSON.stringify({ id, line, createdAt: new Date() }), {
        flag: "wx", flush: true, mode: 0o600,
      });
      try {
        await fs.promises.link(temporary, file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      for (const dir of [directory, this.logDir]) {
        const handle = await fs.promises.open(dir, "r");
        try { await handle.sync(); } finally { await handle.close(); }
      }
    } finally {
      await fs.promises.unlink(temporary).catch(() => {});
    }
  }

  private async recoverLocalSpool(): Promise<void> {
    const directory = path.join(this.logDir, ".transfer-log-pending");
    const files = await fs.promises.readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return [];
    });
    for (const file of files.filter((entry) => entry.isFile() && /^[a-f0-9]{64}\.json$/.test(entry.name)).slice(0, 200)) {
      const pathname = path.join(directory, file.name);
      const record = JSON.parse(await fs.promises.readFile(pathname, "utf8"));
      if (typeof record.id !== "string" || typeof record.line !== "string" || /[\r\n]/.test(record.line)) {
        this.reportWriteFailure("Spool trasferimenti con record non valido", undefined, file.name);
        continue;
      }
      await this.writeJournal(record.id, record.line, new Date(record.createdAt));
      await fs.promises.unlink(pathname);
    }
  }

  private writeTransferLine(id: string, line: string): Promise<string> {
    return this.enqueue(async () => {
      let entry: PendingLogEntry | null = null;
      let duplicate = false;
      if (this.journal) {
        try {
          ({ entry, duplicate } = await this.writeJournal(id, line));
        } catch (error) {
          try {
            await this.spoolLocally(id, line);
          } catch (spoolError) {
            this.persistenceFailure = true;
            this.reportWriteFailure("Esito trasferimento non persistito in journal né in spool", spoolError, id);
            throw spoolError;
          }
          this.reportWriteFailure("Journal MongoDB non disponibile, esito durevole in spool locale", error, id);
          return line;
        }
      }
      if (!entry) {
        try {
          await this.append(this.transfersLogPath, line);
        } catch (error) {
          this.persistenceFailure = true;
          this.reportWriteFailure("Esito trasferimento non persistito", error, id);
          throw error;
        }
        return line;
      }
      try {
        await this.project(entry, duplicate);
      } catch (error) {
        this.reportWriteFailure("Esito durevole su MongoDB, proiezione su file in sospeso", error, id);
      }
      return entry.line;
    });
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
    await this.enqueue(() => this.append(this.accessLogPath, line));
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
    return this.writeTransferLine(entry.transferId ? `transfer:${entry.transferId}` : randomUUID(), line);
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
    return this.writeTransferLine(`batch:${batchId}:start`, line);
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
    return this.writeTransferLine(`batch:${batchId}:file:${k}`, line);
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
    return this.writeTransferLine(`batch:${batchId}:end`, line);
  }

  /**
   * Legge le righe del file access.log con supporto filtri (user, event, limit).
   */
  public async getAccessLogs(filter?: { user?: string; event?: string; limit?: number }): Promise<string[]> {
    await this.ensureInitialized();
    const lines: string[] = [];
    const limit = filter?.limit && filter.limit > 0 ? Math.min(filter.limit, 1000) : 100;
    for (const file of await this.logPaths(this.accessLogPath)) {
      for await (const line of this.readExistingLog(file)) {
        if (!line.trim()) continue;
        if (filter?.user && !line.includes(`Utente: ${filter.user}`)) continue;
        if (filter?.event && !line.includes(`EVENT: ${filter.event}`)) continue;
        lines.push(line);
        if (lines.length >= limit) return lines.reverse();
      }
    }
    return lines.reverse();
  }

  private async *readExistingLog(file: string): AsyncGenerator<string> {
    try {
      yield* readLogLinesBackwards(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private async logPaths(filePath: string): Promise<string[]> {
    await this.ensureInitialized();
    const name = path.basename(filePath);
    const entries = await fs.promises.readdir(this.logDir, { withFileTypes: true });
    const copies = entries.filter((entry) => entry.isFile() && entry.name.startsWith(name + "."));
    const archives = copies
      .filter((entry) => /^archive\.[0-9TZ-]+[a-f0-9-]+$/.test(entry.name.slice(name.length + 1)))
      .map((entry) => entry.name).sort().reverse();
    const legacy = copies
      .filter((entry) => /^\d+$/.test(entry.name.slice(name.length + 1)))
      .sort((a, b) => Number(a.name.slice(name.length + 1)) - Number(b.name.slice(name.length + 1)))
      .map((entry) => entry.name);
    return [filePath, ...archives.concat(legacy).map((entry) => path.join(this.logDir, entry))];
  }

  public async openTransferLogDownload(): Promise<Readable> {
    return this.openLogDownload(this.transfersLogPath);
  }

  public async openAccessLogDownload(): Promise<Readable> {
    return this.openLogDownload(this.accessLogPath);
  }

  private async openLogDownload(file: string): Promise<Readable> {
    const { paths, activeFile, activeLength } = await this.enqueue(async () => {
      const paths = (await this.logPaths(file)).reverse();
      const activeFile = await fs.promises.open(paths.pop()!, "r").catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
        return undefined;
      });
      try {
        return { paths, activeFile, activeLength: activeFile ? (await activeFile.stat()).size : 0 };
      } catch (error) {
        await activeFile?.close();
        throw error;
      }
    });
    const result = Readable.from((async function* () {
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
      if (activeFile && activeLength > 0) {
        if (needsSeparator) yield "\n";
        yield* activeFile.createReadStream({ end: activeLength - 1, autoClose: false });
      }
    })());
    result.once("close", () => { void activeFile?.close().catch(() => {}); });
    return result;
  }

  public async getTransferLogs(filter?: { user?: string; outcome?: string; limit?: number }): Promise<string[]> {
    const limit = filter?.limit && filter.limit > 0 ? Math.min(filter.limit, 1000) : 100;
    const lines: string[] = [];
    for (const filePath of await this.logPaths(this.transfersLogPath)) {
      for await (const line of this.readExistingLog(filePath)) {
        if (!line.trim()) continue;
        const entry = line.split(" | Dettagli:")[0];
        const user = /(?:^|\|) Utente: (.*?)(?: \||$)/.exec(entry)?.[1];
        const rawOutcome = / \| Esito: ([\p{L}_]+)/u.exec(entry)?.[1]?.toUpperCase();
        const outcome = rawOutcome === "OK" || rawOutcome === "COMPLETED" ? "SUCCESSO"
          : rawOutcome === "FALLITO" || rawOutcome === "FAILED" ? "FALLIMENTO"
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
