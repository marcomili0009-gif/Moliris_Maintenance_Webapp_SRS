// Requisiti soddisfatti: RF-TRF-001, RF-TRF-002, RF-TRF-003, RF-TRF-004, RF-TRF-005,
// RF-TRF-009, RF-TRF-011, RF-AUTH-005, RF-SRVFS-005, RNF-SEC-004, RNF-SEC-005, RNF-REL-004, RNF-PERF-001

export type BulkTargetType = "server" | "robot";

export interface BulkTarget {
  type: BulkTargetType;
  robotId: string;
  directory?: string; // Sotto-percorso relativo sul server o cartella remota sul robot
}

export interface BulkFileConflict {
  filename: string;
  target: BulkTarget;
  destinationPath: string;
  existingSizeBytes?: number;
  existingModifiedAt?: Date;
}

export interface BulkPreCheckRequest {
  filenames: string[];
  targets: BulkTarget[];
}

export interface BulkPreCheckResponse {
  hasConflicts: boolean;
  conflicts: BulkFileConflict[];
  allowedTargetsCount: number;
  totalChecks: number;
}

export interface BulkUploadTargetResult {
  target: BulkTarget;
  success: boolean;
  destinationPath: string;
  bytesTransferred?: number;
  checksum?: string;
  error?: string;
}

export interface BulkFileResult {
  filename: string;
  sizeBytes: number;
  targets: BulkUploadTargetResult[];
  overallSuccess: boolean;
}

export interface BulkUploadResponse {
  success: boolean;
  totalFiles: number;
  results: BulkFileResult[];
  summary: {
    completed: number;
    failed: number;
    skipped: number;
  };
}
