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
} as const;

export type TransferDirection = (typeof TransferDirection)[keyof typeof TransferDirection];

/**
 * Stati tassativi dell'operazione di trasferimento deducibili dalla SRS (RF-TRF-006, RF-TRF-008, RF-TRF-012, §6.5..6.7).
 * Nessuno stato inventato.
 */
export const TransferStatus = {
  QUEUED: "QUEUED",                         // In attesa se limitata dalla concorrenza (RF-TRF-012)
  IN_PROGRESS: "IN_PROGRESS",               // In corso di trasferimento (RF-TRF-006)
  INTEGRITY_CHECKING: "INTEGRITY_CHECKING", // Verifica di integrità in corso (RF-TRF-008)
  COMPLETED: "COMPLETED",                   // Completata con successo (RF-TRF-006)
  FAILED: "FAILED",                         // Interrotta o fallita con errore (RF-TRF-006, RF-TRF-007)
  CANCELLED: "CANCELLED",                   // Annullata dall'utente o da chiusura sessione (RF-TRF-013)
  INTEGRITY_FAILED: "INTEGRITY_FAILED",     // Verifica di integrità fallita (RF-TRF-008, §9)
} as const;

export type TransferStatus = (typeof TransferStatus)[keyof typeof TransferStatus];

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
  userId: string;
  robotId: string;
  direction: TransferDirection;
  filename: string;
  sourcePath: string;
  destinationPath: string;
  totalBytes: number | null;
  transferredBytes: number;
  percent: number | null;
  speedBytesPerSec: number | null;
  etaSeconds: number | null;
  status: TransferStatus;
  error: string | null;
  checksum: string | null;
  checksumAlgorithm: string | null;
  startedAt: string; // ISO 8601
  completedAt: string | null; // ISO 8601
}

/**
 * Struttura interna di monitoraggio e ciclo di vita del trasferimento (RF-TRF-006..014)
 */
export interface TransferRecord {
  transferId: string;
  userId: string;
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
  etaSeconds: number | null;
  status: TransferStatus;
  error: string | null;
  errorCode?: string;
  expectedChecksum?: string;
  computedChecksum?: string;
  checksumAlgorithm?: string;
  startedAt: Date;
  completedAt?: Date;
  lastProgressUpdateAt: number;
  lastBytesAtUpdate: number;
  abortController: AbortController;
  cleanupHandlers: (() => Promise<void>)[];
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
}

/**
 * Opzioni per il trasferimento
 */
export interface TransferExecutionOptions {
  overwrite?: boolean;
  confirmed?: boolean;
  expectedChecksum?: string;
}
