export type TransferDirection =
  | "SERVER_TO_ROBOT"
  | "ROBOT_TO_SERVER"
  | "CLIENT_TO_SERVER"
  | "CLIENT_TO_ROBOT"
  | "SERVER_TO_CLIENT"
  | "ROBOT_TO_CLIENT";

export type TransferStatus =
  | "QUEUED"
  | "IN_PROGRESS"
  | "INTEGRITY_CHECKING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED"
  | "INTEGRITY_FAILED";

export interface TransferProgress {
  transferId: string;
  batchId?: string;
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
  etaSeconds: number | null;
  errorMessage?: string;
  integrityLabel?: string;
  checksum?: string;
  startedAt: string;
  completedAt?: string;
}

/** Esito dell'avvio di un trasferimento Server ↔ Robot (HTTP 202 = preso in carico). */
export interface TransferStartResult {
  ok: boolean;
  transferId?: string;
  /** Messaggio utente in caso di rifiuto (destinazione non scrivibile, file esistente, spazio…). */
  error?: string;
}

export interface BulkConflict {
  targetType: "server" | "robot";
  targetId: string;
  targetName: string;
  filename: string;
  targetPath: string;
}

export interface BulkDestinations {
  server?: { robotId: string; subPath: string };
  robots?: Array<{ robotId: string; remotePath: string }>;
}

export interface BulkTargetDescriptor {
  type: "server" | "robot";
  robotId: string;
  directory?: string;
}

/** Traduce le destinazioni UI nel contratto atomico usato dal backend bulk. */
export function buildBulkTargets(destinations: BulkDestinations): BulkTargetDescriptor[] {
  const targets: BulkTargetDescriptor[] = [];
  if (destinations.server) {
    targets.push({
      type: "server",
      robotId: destinations.server.robotId,
      directory: destinations.server.subPath,
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
  targetType: "server" | "robot";
  targetId: string;
  targetName: string;
  success: boolean;
  transferredFiles: string[];
  failedFiles: Array<{ filename: string; reason: string }>;
}
