// Requisiti soddisfatti: SRS v1.0 §2 "File di Configurazione (config)",
// RNF-MNT-001, RNF-SEC-004, RNF-PERF-001, RNF-REL-004, RF-TRF-001..005, RF-SSH-001..008

import { z } from "zod";

/**
 * Schema per la configurazione del caricamento massivo multi-target (RF-TRF-001..005, RNF-PERF-001)
 */
export const BulkUploadConfigSchema = z.object({
  /**
   * Numero massimo di file trasferibili contemporaneamente in un singolo batch (default: 20)
   */
  maxConcurrentFiles: z
    .number({ message: "maxConcurrentFiles deve essere un numero" })
    .int("maxConcurrentFiles deve essere un intero")
    .min(1, "maxConcurrentFiles deve essere almeno 1")
    .max(100, "maxConcurrentFiles non può superare 100")
    .default(20),

  /**
   * Dimensione del buffer/chunk di trasferimento in byte (default: 2 MB = 2097152)
   */
  chunkSizeBytes: z
    .number({ message: "chunkSizeBytes deve essere un numero" })
    .int("chunkSizeBytes deve essere un intero")
    .min(64 * 1024, "chunkSizeBytes deve essere almeno 64 KB (65536 byte)")
    .max(64 * 1024 * 1024, "chunkSizeBytes non può superare 64 MB")
    .default(2 * 1024 * 1024),

  /**
   * Lista o pattern dei percorsi consentiti per il ruolo Operatore (jail/sandbox)
   */
  allowedSubPaths: z
    .array(z.string().min(1, "Il percorso consentito non può essere vuoto"))
    .default(["upload", "shared", "logs", "backups", "configs"]),
});

export type BulkUploadConfig = z.infer<typeof BulkUploadConfigSchema>;

/**
 * Schema estensibile per futuri vincoli operativi e di scala (§2, futureExtensions)
 */
export const FutureExtensionsConfigSchema = z.object({
  /**
   * Numero massimo di robot gestibili contemporaneamente nella flotta (default: 100)
   */
  maxFleetRobots: z
    .number({ message: "maxFleetRobots deve essere un numero" })
    .int("maxFleetRobots deve essere un intero")
    .min(1, "maxFleetRobots deve essere almeno 1")
    .optional()
    .default(100),

  /**
   * Numero massimo di sessioni simultanee attive per singolo account (default: 3)
   */
  maxSessionsPerAccount: z
    .number({ message: "maxSessionsPerAccount deve essere un numero" })
    .int("maxSessionsPerAccount deve essere un intero")
    .min(1, "maxSessionsPerAccount deve essere almeno 1")
    .optional()
    .default(3),

  /**
   * Parametri personalizzati o sperimentali opzionali concordati con il committente
   */
  customSettings: z.record(z.string(), z.unknown()).optional().default({}),
});

export type FutureExtensionsConfig = z.infer<typeof FutureExtensionsConfigSchema>;

/**
 * Schema principale di configurazione conforme al punto 2 dell'SRS ("File di Configurazione - config")
 */
export const AppConfigSchema = z.object({
  /**
   * 1. Timeout inattività sessione web app in minuti (default: 30)
   */
  sessionInactivityTimeoutMinutes: z
    .number({ message: "sessionInactivityTimeoutMinutes deve essere un numero" })
    .int("sessionInactivityTimeoutMinutes deve essere un intero")
    .min(1, "sessionInactivityTimeoutMinutes deve essere almeno 1 minuto")
    .max(1440, "sessionInactivityTimeoutMinutes non può superare 24 ore (1440 min)")
    .default(30),

  /**
   * 2. Timeout massimo attività sessione terminale SSH (watchdog timer) in minuti (default: 60)
   */
  sshTerminalActiveTimeoutMinutes: z
    .number({ message: "sshTerminalActiveTimeoutMinutes deve essere un numero" })
    .int("sshTerminalActiveTimeoutMinutes deve essere un intero")
    .min(1, "sshTerminalActiveTimeoutMinutes deve essere almeno 1 minuto")
    .max(1440, "sshTerminalActiveTimeoutMinutes non può superare 24 ore (1440 min)")
    .default(60),

  /**
   * 3. Numero massimo di utenti concorrenti ammessi alla web app (default: 10)
   */
  maxConcurrentWebUsers: z
    .number({ message: "maxConcurrentWebUsers deve essere un numero" })
    .int("maxConcurrentWebUsers deve essere un intero")
    .min(1, "maxConcurrentWebUsers deve essere almeno 1")
    .max(1000, "maxConcurrentWebUsers non può superare 1000")
    .default(10),

  /**
   * 4. Terminali SSH concorrenti aperti per singolo robot (default: 1, es. configurabile fino a 2)
   */
  maxConcurrentTerminalsPerRobot: z
    .number({ message: "maxConcurrentTerminalsPerRobot deve essere un numero" })
    .int("maxConcurrentTerminalsPerRobot deve essere un intero")
    .min(1, "maxConcurrentTerminalsPerRobot deve essere almeno 1")
    .max(10, "maxConcurrentTerminalsPerRobot non può superare 10")
    .default(1),

  /**
   * 5. Impostazioni per il caricamento file massivo (chunk size, concorrenza, jail operatori)
   */
  bulkUploadConfig: BulkUploadConfigSchema.default({
    maxConcurrentFiles: 20,
    chunkSizeBytes: 2 * 1024 * 1024,
    allowedSubPaths: ["upload", "shared", "logs", "backups", "configs"],
  }),

  /**
   * 6. Dimensione massima ammessa per upload file sia verso il server che verso i robot (default: 3 GB)
   */
  maxFileUploadBytes: z
    .number({ message: "maxFileUploadBytes deve essere un numero" })
    .int("maxFileUploadBytes deve essere un intero")
    .min(1024 * 1024, "maxFileUploadBytes deve essere almeno 1 MB (1048576 byte)")
    .max(50 * 1024 * 1024 * 1024, "maxFileUploadBytes non può superare 50 GB")
    .default(3 * 1024 * 1024 * 1024), // 3 GB = 3,221,225,472 bytes

  /**
   * 7. Struttura estensibile per futuri vincoli discussi con il committente (es. maxFleetRobots)
   */
  futureExtensions: FutureExtensionsConfigSchema.default({
    maxFleetRobots: 100,
    maxSessionsPerAccount: 3,
    customSettings: {},
  }),
});

export type AppConfig = z.infer<typeof AppConfigSchema>;
export type AppConfigInput = z.input<typeof AppConfigSchema>;
