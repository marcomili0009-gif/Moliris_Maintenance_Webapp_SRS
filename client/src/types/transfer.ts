export type TransferDirection =
  | "SERVER_TO_ROBOT"
  | "ROBOT_TO_SERVER"
  | "CLIENT_TO_SERVER"
  | "CLIENT_TO_ROBOT"
  | "SERVER_TO_CLIENT"
  | "ROBOT_TO_CLIENT"
  | "ROBOT_TO_ROBOT";

export type TransferStatus =
  | "QUEUED"
  | "IN_PROGRESS"
  | "PAUSED"
  | "INTEGRITY_CHECKING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED"
  | "INTEGRITY_FAILED";

export interface TransferProgress {
  transferId: string;
  batchId?: string;
  userId?: string;
  username?: string;
  robotId?: string;
  /** Nome del file trasferito. */
  filename: string;
  /** Percorso sorgente come riportato dal backend (relativo alla cartella robot sul server o assoluto sul robot). */
  sourcePath: string;
  /** Percorso di destinazione come riportato dal backend. */
  destinationPath: string;
  sourceFile: string;
  targetFile: string;
  direction: TransferDirection;
  status: TransferStatus;
  transferredBytes: number;
  totalBytes: number;
  percentage: number;
  speedBps: number;
  currentSpeedBps?: number | null;
  averageSpeedBps?: number | null;
  durationMs?: number | null;
  etaSeconds: number | null;
  errorMessage?: string;
  errorCode?: string;
  integrityLabel?: string;
  checksum?: string;
  startedAt: string;
  activeStartedAt?: string | null;
  completedAt?: string;
}

export interface TransferLogRecord {
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
  status: TransferStatus;
  currentSpeedBytesPerSec: number | null;
  averageSpeedBytesPerSec: number | null;
  etaSeconds: number | null;
  startedAt: string;
  activeStartedAt?: string | null;
  completedAt?: string | null;
  durationMs?: number | null;
  error?: string | null;
  errorCode?: string | null;
  checksum?: string | null;
  integrityLabel?: string | null;
}

/** Esito dell'avvio di un trasferimento Server ↔ Robot (HTTP 202 = preso in carico). */
export interface TransferStartResult {
  ok: boolean;
  transferId?: string;
  /** Messaggio utente in caso di rifiuto (destinazione non scrivibile, file esistente, spazio…). */
  error?: string;
}

export interface BulkConflict {
  targetType: "server" | "robot" | "general";
  targetId: string;
  targetName: string;
  filename: string;
  targetPath: string;
}

export interface BulkDestinations {
  general?: { subPath: string };
  server?: { robotId: string; subPath: string };
  servers?: Array<{ robotId: string; subPath: string }>;
  robots?: Array<{ robotId: string; remotePath: string }>;
}

export interface BulkTargetDescriptor {
  type: "server" | "robot" | "general";
  robotId?: string;
  directory?: string;
}

/** Traduce le destinazioni UI nel contratto atomico usato dal backend bulk. */
export function buildBulkTargets(destinations: BulkDestinations): BulkTargetDescriptor[] {
  const targets: BulkTargetDescriptor[] = [];
  if (destinations.general) {
    targets.push({
      type: "general",
      directory: destinations.general.subPath,
    });
  }
  const serverTargets = destinations.servers && destinations.servers.length > 0
    ? destinations.servers
    : destinations.server
    ? [destinations.server]
    : [];
  for (const srv of serverTargets) {
    targets.push({
      type: "server",
      robotId: srv.robotId,
      directory: srv.subPath,
    });
  }
  for (const robot of destinations.robots || []) {
    targets.push({
      type: "robot",
      robotId: robot.robotId,
      directory: robot.remotePath,
    });
  }
  return targets;
}

/** Determina se il passo Sorgente contiene una selezione valida. */
export function hasBulkSourceSelection(
  sourceType: "computer" | "general" | "server_robot" | "remote_robot",
  computerFiles: Array<{ name: string; size?: number }>,
  selectedServerFiles: string[]
): boolean {
  return sourceType === "computer"
    ? computerFiles.length > 0
    : selectedServerFiles.length > 0;
}

export interface BulkUploadTargetResult {
  targetType: "server" | "robot" | "general";
  targetId: string;
  targetName: string;
  success: boolean;
  transferredFiles: string[];
  failedFiles: Array<{ filename: string; reason: string }>;
}
