// Requisiti soddisfatti: SRS v1.0 §2 "File di Configurazione (config)",
// RNF-MNT-001, RNF-SEC-004, RNF-PERF-001, RNF-REL-004, RF-TRF-001..005, RF-SSH-001..008

import fs from "fs";
import path from "path";
import { type FastifyInstance, type FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { type z } from "zod";
import {
  AppConfigSchema,
  type AppConfig,
  type AppConfigInput,
  type BulkUploadConfig,
  type FutureExtensionsConfig,
} from "./schema.ts";

export {
  AppConfigSchema,
  type AppConfig,
  type AppConfigInput,
  type BulkUploadConfig,
  type FutureExtensionsConfig,
};

/**
 * Errore fatale di configurazione sollevato durante il bootstrap del server.
 */
export class ConfigError extends Error {
  public readonly code: string;
  public readonly fatal: boolean = true;

  constructor(message: string, code = "CONFIG_FATAL_ERROR") {
    super(message);
    this.name = "ConfigError";
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Errore di validazione dello schema di configurazione, con dettaglio campo per campo.
 */
export class ConfigValidationError extends ConfigError {
  public readonly issues: z.ZodIssue[];

  constructor(issues: z.ZodIssue[], customMessage?: string) {
    const formatted = issues
      .map((i) => `  - [${i.path.join(".") || "root"}]: ${i.message}`)
      .join("\n");
    const msg = customMessage
      ? `${customMessage}\n${formatted}`
      : `Errore fatale di validazione della configurazione all'avvio (bootstrap interrotto):\n${formatted}`;
    super(msg, "CONFIG_VALIDATION_ERROR");
    this.name = "ConfigValidationError";
    this.issues = issues;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface LoadConfigOptions {
  /**
   * Percorso esplicito del file di configurazione JSON.
   * Se non specificato, viene verificata la variabile d'ambiente MOLIRIS_CONFIG_FILE o CONFIG_FILE_PATH.
   */
  configPath?: string;

  /**
   * Directory base per la ricerca dei file di configurazione (default: process.cwd()).
   */
  cwd?: string;

  /**
   * Oggetto variabili d'ambiente (default: process.env).
   */
  env?: Record<string, string | undefined>;

  /**
   * Sovrascritture programmatiche applicate con precedenza massima.
   */
  overrides?: Partial<AppConfigInput>;

  /**
   * Se true, non solleva eccezione se il file predefinito manca, ma usa i default validati.
   */
  allowMissingFileFallback?: boolean;
}

/**
 * Estrae e converte variabili d'ambiente coerenti con la configurazione dell'SRS §2.
 */
function extractEnvConfig(env: Record<string, string | undefined>): Record<string, any> {
  const result: Record<string, any> = {};

  // 1. sessionInactivityTimeoutMinutes
  const rawSession =
    env["MOLIRIS_SESSION_TIMEOUT_MIN"] ??
    env["MOLIRIS_SESSION_INACTIVITY_TIMEOUT_MINUTES"] ??
    env["SESSION_INACTIVITY_TIMEOUT_MINUTES"];
  if (rawSession !== undefined && rawSession.trim() !== "") {
    const n = Number(rawSession);
    result.sessionInactivityTimeoutMinutes = isNaN(n) ? rawSession : n;
  }

  // 1b. sessionInactivityWarningMinutes
  const rawSessionWarning =
    env["MOLIRIS_SESSION_WARNING_MIN"] ??
    env["MOLIRIS_SESSION_INACTIVITY_WARNING_MINUTES"] ??
    env["SESSION_INACTIVITY_WARNING_MINUTES"];
  if (rawSessionWarning !== undefined && rawSessionWarning.trim() !== "") {
    const n = Number(rawSessionWarning);
    result.sessionInactivityWarningMinutes = isNaN(n) ? rawSessionWarning : n;
  }

  // 2. sshTerminalActiveTimeoutMinutes
  const rawTerminal =
    env["MOLIRIS_TERMINAL_IDLE_MIN"] ??
    env["MOLIRIS_SSH_TERMINAL_ACTIVE_TIMEOUT_MINUTES"] ??
    env["SSH_TERMINAL_ACTIVE_TIMEOUT_MINUTES"];
  if (rawTerminal !== undefined && rawTerminal.trim() !== "") {
    const n = Number(rawTerminal);
    result.sshTerminalActiveTimeoutMinutes = isNaN(n) ? rawTerminal : n;
  }

  // 2b. sshTerminalWarningMinutes
  const rawTermWarning =
    env["MOLIRIS_TERMINAL_WARNING_MIN"] ??
    env["MOLIRIS_SSH_TERMINAL_WARNING_MINUTES"] ??
    env["TERMINAL_SESSION_WARNING_MINUTES"];
  if (rawTermWarning !== undefined && rawTermWarning.trim() !== "") {
    const n = Number(rawTermWarning);
    result.sshTerminalWarningMinutes = isNaN(n) ? rawTermWarning : n;
  }

  // 3. maxConcurrentWebUsers
  const rawWebUsers = env["MOLIRIS_MAX_CONCURRENT_WEB_USERS"] ?? env["MAX_CONCURRENT_WEB_USERS"];
  if (rawWebUsers !== undefined && rawWebUsers.trim() !== "") {
    const n = Number(rawWebUsers);
    result.maxConcurrentWebUsers = isNaN(n) ? rawWebUsers : n;
  }

  // 4. maxConcurrentTerminalsPerRobot
  const rawTermPerRobot = env["MOLIRIS_MAX_CONCURRENT_TERMINALS_PER_ROBOT"] ?? env["MAX_CONCURRENT_TERMINALS_PER_ROBOT"];
  if (rawTermPerRobot !== undefined && rawTermPerRobot.trim() !== "") {
    const n = Number(rawTermPerRobot);
    result.maxConcurrentTerminalsPerRobot = isNaN(n) ? rawTermPerRobot : n;
  }

  // 5. maxFileUploadBytes
  const rawMaxUpload = env["MOLIRIS_MAX_FILE_UPLOAD_BYTES"] ?? env["MAX_FILE_UPLOAD_BYTES"];
  if (rawMaxUpload !== undefined && rawMaxUpload.trim() !== "") {
    const n = Number(rawMaxUpload);
    result.maxFileUploadBytes = isNaN(n) ? rawMaxUpload : n;
  }

  // 6. bulkUploadConfig
  const bulkUpload: Record<string, any> = {};
  const rawMaxBulk = env["MOLIRIS_MAX_BULK_UPLOAD_FILES"] ?? env["MAX_BULK_UPLOAD_FILES"];
  if (rawMaxBulk !== undefined && rawMaxBulk.trim() !== "") {
    const n = Number(rawMaxBulk);
    bulkUpload.maxConcurrentFiles = isNaN(n) ? rawMaxBulk : n;
  }
  const rawChunkSize = env["MOLIRIS_TRANSFER_CHUNK_SIZE_BYTES"] ?? env["TRANSFER_CHUNK_SIZE_BYTES"];
  if (rawChunkSize !== undefined && rawChunkSize.trim() !== "") {
    const n = Number(rawChunkSize);
    bulkUpload.chunkSizeBytes = isNaN(n) ? rawChunkSize : n;
  }
  const rawAllowedPaths = env["MOLIRIS_DEFAULT_OPERATOR_ALLOWED_PATHS"] ?? env["DEFAULT_OPERATOR_ALLOWED_PATHS"];
  if (rawAllowedPaths !== undefined && rawAllowedPaths.trim() !== "") {
    bulkUpload.allowedSubPaths = rawAllowedPaths.split(",").map((p) => p.trim()).filter(Boolean);
  }
  if (Object.keys(bulkUpload).length > 0) {
    result.bulkUploadConfig = bulkUpload;
  }

  // 7. futureExtensions
  const futureExt: Record<string, any> = {};
  const rawFleetRobots = env["MOLIRIS_MAX_FLEET_ROBOTS"] ?? env["MAX_FLEET_ROBOTS"];
  if (rawFleetRobots !== undefined && rawFleetRobots.trim() !== "") {
    const n = Number(rawFleetRobots);
    futureExt.maxFleetRobots = isNaN(n) ? rawFleetRobots : n;
  }
  const rawMaxSessions = env["MOLIRIS_MAX_SESSIONS_PER_ACCOUNT"] ?? env["MAX_SESSIONS_PER_ACCOUNT"];
  if (rawMaxSessions !== undefined && rawMaxSessions.trim() !== "") {
    const n = Number(rawMaxSessions);
    const parsedSessions = isNaN(n) ? rawMaxSessions : n;
    result.maxSessionsPerAccount = parsedSessions;
    futureExt.maxSessionsPerAccount = parsedSessions;
  }
  if (Object.keys(futureExt).length > 0) {
    result.futureExtensions = futureExt;
  }

  // 8. fleetPollingIntervalSeconds
  const rawFleetPolling = env["MOLIRIS_POLLING_INTERVAL_SEC"] ?? env["FLEET_POLLING_INTERVAL_SECONDS"];
  if (rawFleetPolling !== undefined && rawFleetPolling.trim() !== "") {
    const n = Number(rawFleetPolling);
    result.fleetPollingIntervalSeconds = isNaN(n) ? rawFleetPolling : n;
  }

  // 9. maxConcurrentTransfers
  const rawMaxTrf = env["MOLIRIS_MAX_TRF_SERVER"] ?? env["MAX_CONCURRENT_TRANSFERS"];
  if (rawMaxTrf !== undefined && rawMaxTrf.trim() !== "") {
    const n = Number(rawMaxTrf);
    result.maxConcurrentTransfers = isNaN(n) ? rawMaxTrf : n;
  }

  // 10. sshConnectTimeoutSeconds
  const rawSshTimeout = env["MOLIRIS_SSH_CONNECTION_TIMEOUT_MS"] ?? env["MOLIRIS_SSH_TIMEOUT_MS"] ?? env["SSH_CONNECT_TIMEOUT_SECONDS"];
  if (rawSshTimeout !== undefined && rawSshTimeout.trim() !== "") {
    const n = Number(rawSshTimeout);
    result.sshConnectTimeoutSeconds = isNaN(n) ? rawSshTimeout : (n > 1000 ? Math.round(n / 1000) : n);
  }

  // 11. transferTimeoutMinutes
  const rawTrfTimeoutMs = env["MOLIRIS_TRANSFER_IDLE_TIMEOUT_MS"];
  const rawTrfTimeout = rawTrfTimeoutMs ? String(Math.round(Number(rawTrfTimeoutMs) / 60000)) : env["TRANSFER_TIMEOUT_MINUTES"];
  if (rawTrfTimeout !== undefined && rawTrfTimeout.trim() !== "") {
    const n = Number(rawTrfTimeout);
    result.transferTimeoutMinutes = isNaN(n) ? rawTrfTimeout : n;
  }

  // 12. transferResumeEnabled
  const rawTrfResume = (env["MOLIRIS_TRANSFER_RESUME_ENABLED"] ?? env["TRANSFER_RESUME_ENABLED"])?.trim().toLowerCase();
  if (rawTrfResume === "true" || rawTrfResume === "false") {
    result.transferResumeEnabled = rawTrfResume === "true";
  }

  return result;
}

/**
 * Rimuove commenti single-line (//...) e multi-line (/* ... * /) preservando le stringhe,
 * consentendo commenti standard in stile JSONC nei file di configurazione.
 */
export function stripJsonComments(jsonString: string): string {
  return jsonString.replace(
    /("(?:[^"\\]|\\.)*")|(\/\/[^\r\n]*|\/\*[\s\S]*?\*\/)/g,
    (_match, stringLiteral) => (stringLiteral ? stringLiteral : "")
  );
}

/**
 * Individua, carica e valida rigidamente il file di configurazione dell'applicazione (SRS §2).
 * In caso di file mancante (se specificato) o parametri non validi, solleva un errore fatale e interrompe il bootstrap.
 */
export function loadConfig(options: LoadConfigOptions = {}): AppConfig {
  const env = options.env || process.env;
  let fileConfig: Record<string, any> = {};
  const cwd = path.resolve(options.cwd || process.cwd());

  const targetPath = options.configPath || env["MOLIRIS_CONFIG_FILE"] || env["CONFIG_FILE_PATH"];
  const defaultPaths = [
    path.join(cwd, "config", "config.json"),
    path.join(cwd, "config.json"),
    path.join(cwd, "config.example.json"),
  ];
  const resolvedPath = targetPath
    ? path.resolve(cwd, targetPath)
    : defaultPaths.find((candidate) => fs.existsSync(candidate));

  if (targetPath && resolvedPath && !fs.existsSync(resolvedPath)) {
    throw new ConfigError(
      `File di configurazione specificato non trovato: "${resolvedPath}". Interruzione immediata del bootstrap.`,
      "CONFIG_FILE_NOT_FOUND"
    );
  }

  if (resolvedPath && fs.existsSync(resolvedPath)) {
    try {
      const rawContent = fs.readFileSync(resolvedPath, "utf-8");
      const parsedConfig = JSON.parse(stripJsonComments(rawContent));
      if (!parsedConfig || typeof parsedConfig !== "object" || Array.isArray(parsedConfig)) {
        throw new ConfigError(
          `Il file di configurazione "${resolvedPath}" deve contenere un oggetto JSON.`,
          "CONFIG_FORMAT_ERROR"
        );
      }
      fileConfig = parsedConfig;
    } catch (err: any) {
      if (err instanceof ConfigError) throw err;
      if (err instanceof SyntaxError) {
        throw new ConfigError(
          `Sintassi JSON non valida nel file di configurazione "${resolvedPath}": ${err.message}`,
          "CONFIG_SYNTAX_ERROR"
        );
      }
      throw new ConfigError(
        `Impossibile leggere il file di configurazione "${resolvedPath}": ${err.message}`,
        "CONFIG_READ_ERROR"
      );
    }
  }

  const envConfig = extractEnvConfig(env);

  // Unione gerarchica: file di configurazione -> variabili d'ambiente -> override programmatici
  const mergedPayload: Record<string, any> = {
    ...fileConfig,
    ...envConfig,
    ...(options.overrides || {}),
    loadedConfigPath: resolvedPath && fs.existsSync(resolvedPath) ? resolvedPath : undefined,
  };

  // Fusione profonda degli oggetti annidati (bulkUploadConfig, futureExtensions)
  if (fileConfig.bulkUploadConfig || envConfig.bulkUploadConfig || options.overrides?.bulkUploadConfig) {
    mergedPayload.bulkUploadConfig = {
      ...(fileConfig.bulkUploadConfig || {}),
      ...(envConfig.bulkUploadConfig || {}),
      ...(options.overrides?.bulkUploadConfig || {}),
    };
  }

  if (fileConfig.futureExtensions || envConfig.futureExtensions || options.overrides?.futureExtensions) {
    mergedPayload.futureExtensions = {
      ...(fileConfig.futureExtensions || {}),
      ...(envConfig.futureExtensions || {}),
      ...(options.overrides?.futureExtensions || {}),
    };
  }

  // Supporto bidirezionale per maxSessionsPerAccount sia a livello radice che in futureExtensions
  const resolvedMaxSessions =
    options.overrides?.maxSessionsPerAccount ??
    options.overrides?.futureExtensions?.maxSessionsPerAccount ??
    envConfig.maxSessionsPerAccount ??
    envConfig.futureExtensions?.maxSessionsPerAccount ??
    fileConfig.maxSessionsPerAccount ??
    fileConfig.futureExtensions?.maxSessionsPerAccount;

  if (resolvedMaxSessions !== undefined) {
    mergedPayload.maxSessionsPerAccount = resolvedMaxSessions;
    if (!mergedPayload.futureExtensions) {
      mergedPayload.futureExtensions = {};
    }
    mergedPayload.futureExtensions.maxSessionsPerAccount = resolvedMaxSessions;
  }

  // Validazione rigorosa tramite lo schema Zod
  const parseResult = AppConfigSchema.safeParse(mergedPayload);

  if (!parseResult.success) {
    throw new ConfigValidationError(parseResult.error.issues);
  }

  const finalConfig = parseResult.data;
  const effectiveMaxSessions =
    finalConfig.maxSessionsPerAccount ?? finalConfig.futureExtensions?.maxSessionsPerAccount ?? 1;

  const enrichedConfig = {
    ...finalConfig,
    maxSessionsPerAccount: effectiveMaxSessions,
    futureExtensions: {
      ...(finalConfig.futureExtensions || { maxFleetRobots: 100, customSettings: {} }),
      maxSessionsPerAccount: effectiveMaxSessions,
    },
  };

  return Object.freeze(enrichedConfig);
}

/**
 * Estensione dei tipi per l'istanza FastifyInstance
 */
declare module "fastify" {
  interface FastifyInstance {
    appConfig: AppConfig;
  }
}

/**
 * Registra il decoratore di configurazione sull'istanza Fastify.
 */
export function registerAppConfig(fastify: FastifyInstance, config: AppConfig): void {
  if (fastify.hasDecorator("appConfig")) {
    return;
  }
  fastify.decorate("appConfig", config);
}

/**
 * Plugin Fastify per caricamento, validazione e decorazione automatica all'avvio (bootstrap/onRegister).
 * Non incapsulato (tramite fastify-plugin) per esporre 'appConfig' sull'intera istanza applicativa.
 */
export const configPlugin: FastifyPluginAsync<LoadConfigOptions> = fp(
  async (fastify: FastifyInstance, opts: LoadConfigOptions) => {
    const config = loadConfig(opts);
    registerAppConfig(fastify, config);
  },
  {
    name: "moliris-app-config",
    fastify: "5.x",
  }
);
