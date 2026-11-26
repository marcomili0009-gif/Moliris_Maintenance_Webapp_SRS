// Requisiti soddisfatti: RF-TRF-001, RF-TRF-002, RF-TRF-003, RF-TRF-004, RF-TRF-005,
// RF-TRF-006, RF-TRF-007, RF-TRF-008, RF-TRF-009, RF-TRF-010, RF-TRF-011, RF-TRF-012,
// RF-TRF-013, RF-TRF-014, RNF-SEC-002, RNF-SEC-004, RNF-SEC-005, RNF-SEC-007, RNF-SEC-008,
// RNF-SEC-009, RNF-PERF-001, RNF-PERF-002, RNF-PERF-003, RNF-REL-001, RNF-REL-004, RNF-REL-005,
// SRS §1.2, §2.4, §5.5, §6.5, §6.6, §6.7, §9, §10.3, §11.1, §11.5, §11.7

import { type Readable, type Writable } from "stream";

/**
 * Tutte le 6 direzioni bidirezionali prescritte da RF-TRF-001, RF-TRF-002, RF-TRF-003:
 * a) computer utente ↔ filesystem server (§6.5)
 * b) filesystem server ↔ filesystem remoto del robot (§6.6)
 * c) computer utente ↔ robot tramite backend intermediario (§6.7)
 */
export const TransferDirection = {
  CLIENT_TO_SERVER: "CLIENT_TO_SERVER",
  SERVER_TO_CLIENT: "SERVER_TO_CLIENT",
  SERVER_TO_ROBOT: "SERVER_TO_ROBOT",
  ROBOT_TO_SERVER: "ROBOT_TO_SERVER",
  CLIENT_TO_ROBOT: "CLIENT_TO_ROBOT",
  ROBOT_TO_CLIENT: "ROBOT_TO_CLIENT",
  ROBOT_TO_ROBOT: "ROBOT_TO_ROBOT",
} as const;

export type TransferDirection = (typeof TransferDirection)[keyof typeof TransferDirection];

/**
 * Stati tassativi dell'operazione di trasferimento deducibili dalla SRS (RF-TRF-006, RF-TRF-008, RF-TRF-012, §6.5..6.7).
 * Nessuno stato inventato.
 */
export const TransferStatus = {
  QUEUED: "QUEUED",                         // In attesa se limitata dalla concorrenza (RF-TRF-012)
  IN_PROGRESS: "IN_PROGRESS",               // In corso di trasferimento (RF-TRF-006)
  PAUSED: "PAUSED",                         // In pausa su richiesta utente (riprendibile)
  INTEGRITY_CHECKING: "INTEGRITY_CHECKING", // Verifica di integrità in corso (RF-TRF-008)
  COMPLETED: "COMPLETED",                   // Completata con successo (RF-TRF-006)
  FAILED: "FAILED",                         // Interrotta o fallita con errore (RF-TRF-006, RF-TRF-007)
  CANCELLED: "CANCELLED",                   // Annullata dall'utente o da chiusura sessione (RF-TRF-013)
  INTEGRITY_FAILED: "INTEGRITY_FAILED",     // Verifica di integrità fallita (RF-TRF-008, §9)
} as const;

export type TransferStatus = (typeof TransferStatus)[keyof typeof TransferStatus];

/**
 * Stati "attivi" (non terminali) che devono essere sempre visibili nella pagina
 * Gestione Trasferimenti: coda, trasferimento in corso, in pausa e verifica di integrità.
 */
export const ACTIVE_TRANSFER_STATUSES: ReadonlySet<TransferStatus> = new Set<TransferStatus>([
  TransferStatus.QUEUED,
  TransferStatus.IN_PROGRESS,
  TransferStatus.PAUSED,
  TransferStatus.INTEGRITY_CHECKING,
]);

export function isActiveTransferStatus(status: TransferStatus): boolean {
  return ACTIVE_TRANSFER_STATUSES.has(status);
}

/**
 * Interfaccia isolata per gli algoritmi di checksum (scelta aperta §11.5, RF-TRF-008)
 */
export interface IChecksumAlgorithm {
  readonly name: string;
  createHasher(): {
    update(chunk: Buffer): void;
    digest(): string;
  };
}

/**
 * Snapshot dei dati di avanzamento calcolati (RF-TRF-006, CA-TRF-002)
 */
export interface TransferProgressSnapshot {
  transferredBytes: number;
  totalBytes: number | null;
  percent: number | null;
  speedBytesPerSec: number | null;
  etaSeconds: number | null;
}

/**
 * DTO sicuro restituito al frontend (RNF-SEC-002, RNF-SEC-007, RF-TRF-006)
 * Non include percorsi interni assoluti del server, né segreti.
 */
export interface TransferDto {
  transferId: string;
  batchId?: string;
  userId: string;
  username?: string;
  robotId: string;
  direction: TransferDirection;
  filename: string;
  sourcePath: string;
  destinationPath: string;
  totalBytes: number | null;
  transferredBytes: number;
  percent: number | null;
  speedBytesPerSec: number | null;
  currentSpeedBytesPerSec?: number | null;
  averageSpeedBytesPerSec?: number | null;
  etaSeconds: number | null;
  status: TransferStatus;
  error: string | null;
  errorCode?: string;
  checksum: string | null;
  checksumAlgorithm: string | null;
  integrityLabel?: string;
  integrityVerification?: {
    verified: boolean;
    label: string;
    mode: "stream" | "readback" | "none";
    details?: string;
  };
  startedAt: string; // ISO 8601
  activeStartedAt?: string | null; // ISO 8601
  completedAt: string | null; // ISO 8601
  durationMs?: number | null;
  sourceFile?: string;
  targetFile?: string;
  percentage?: number;
  speedBps?: number;
  currentSpeedBps?: number | null;
  averageSpeedBps?: number | null;
  errorMessage?: string;
}

/**
 * Struttura interna di monitoraggio e ciclo di vita del trasferimento (RF-TRF-006..014)
 */
export interface TransferRecord {
  transferId: string;
  batchId?: string;
  userId: string;
  username?: string;
  userSessionId: string;
  robotId: string;
  direction: TransferDirection;
  filename: string;
  sourcePath: string;
  destinationPath: string;
  tempDestinationPath?: string;
  totalBytes: number | null;
  transferredBytes: number;
  speedBytesPerSec: number | null;
  currentSpeedBytesPerSec?: number | null;
  averageSpeedBytesPerSec?: number | null;
  etaSeconds: number | null;
  status: TransferStatus;
  error: string | null;
  errorCode?: string;
  expectedChecksum?: string;
  computedChecksum?: string;
  checksumAlgorithm?: string;
  integrityLabel?: string;
  integrityVerification?: {
    verified: boolean;
    label: string;
    mode: "stream" | "readback" | "none";
    details?: string;
  };
  startedAt: Date;
  activeStartedAt?: Date;
  activeStartedPerfMs?: number;
  pausedAtMs?: number | null;
  pausedDurationMs?: number;
  durationMs?: number | null;
  completedAt?: Date;
  lastProgressUpdateAt: number;
  lastBytesAtUpdate: number;
  abortController: AbortController;
  pauseController?: {
    pause: () => void;
    resume: () => void;
  };
  cleanupHandlers: (() => Promise<void>)[];
  /** Richiesta originale (solo Server ↔ Robot) per consentire Riprova/Riprendi (RF-TRF-010). */
  originalRequest?: Omit<StartServerRobotTransferRequest, "onAccepted" | "onQueued">;
}

/**
 * Richiesta di avvio trasferimento Server ↔ Robot (RF-TRF-002, §6.6)
 */
export interface StartServerRobotTransferRequest {
  direction: "SERVER_TO_ROBOT" | "ROBOT_TO_SERVER";
  serverRelativePath: string;
  remotePath: string;
  overwrite?: boolean;
  confirmed?: boolean;
  expectedChecksum?: string;
  /**
   * Hook interni (non serializzabili via JSON), usati dalla route in modalità background:
   * - onQueued: record registrato e già visibile in lista (stato QUEUED);
   * - onAccepted: controlli preliminari superati (destinazione esistente/scrivibile, spazio,
   *   politica di sovrascrittura) e flusso dati in procinto di partire.
   */
  onQueued?: (dto: TransferDto) => void;
  onAccepted?: (dto: TransferDto) => void;
}

/**
 * Opzioni per il trasferimento
 */
export interface TransferExecutionOptions {
  overwrite?: boolean;
  confirmed?: boolean;
  expectedChecksum?: string;
}

/**
 * Richiesta trasferimento Copia/Sposta Robot -> Robot (§6)
 */
export interface RobotToRobotTransferRequest {
  sourceRobotId: string;
  sourceRemotePath: string;
  targetRobotIds: string[];
  targetRemotePaths?: Record<string, string>;
  commonTargetDirectory?: string;
  isMove?: boolean;
  confirmation?: boolean;
  overwrite?: boolean;
}

export interface RobotToRobotTargetResult {
  robotId: string;
  transferId?: string;
  success: boolean;
  error?: string;
  destinationPath: string;
}

export interface RobotToRobotExecutionResult {
  sourceRobotId: string;
  sourceRemotePath: string;
  isMove: boolean;
  allTargetsSucceeded: boolean;
  sourceDeleted?: boolean;
  sourceDeleteError?: string;
  results: RobotToRobotTargetResult[];
}
