export type TransferDirection =
  | "SERVER_TO_ROBOT"
  | "ROBOT_TO_SERVER"
  | "CLIENT_TO_SERVER"
  | "CLIENT_TO_ROBOT"
  | "SERVER_TO_CLIENT"
  | "ROBOT_TO_CLIENT";

export type TransferStatus = "IN_PROGRESS" | "COMPLETED" | "FAILED" | "CANCELLED";

export interface TransferProgress {
  transferId: string;
  robotId?: string;
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
  startedAt: string;
  completedAt?: string;
}

export interface BulkConflict {
  targetType: "server" | "robot";
  targetId: string;
  targetName: string;
  filename: string;
  targetPath: string;
}

export interface BulkUploadTargetResult {
  targetType: "server" | "robot";
  targetId: string;
  targetName: string;
  success: boolean;
  transferredFiles: string[];
  failedFiles: Array<{ filename: string; reason: string }>;
}
