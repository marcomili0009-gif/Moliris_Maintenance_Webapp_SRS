export interface FsEntry {
  name: string;
  type: "file" | "directory" | "symlink" | "other";
  size: number;
  mtime: string;
  modifiedAt?: string;
  permissions?: string;
  target?: string;
  /** Provenienza nella vista aggregata dell'Archivio Generale. */
  scope?: "general" | "robot";
  /** ID del robot quando l'entry rappresenta la sua directory dedicata. */
  robotId?: string;
  /** Etichetta leggibile del robot (es. "Robot VM 01"). */
  displayName?: string;
  /** false se la directory del robot non esiste ancora sul filesystem. */
  exists?: boolean;
}

export interface DirectoryListing {
  path: string;
  currentPath?: string;
  robotId?: string;
  entries: FsEntry[];
  items?: any[];
  totalCount: number;
  isTruncated: boolean;
}

export interface DirectoryItem {
  name: string;
  path: string;
}

export interface PathVerificationResult {
  valid: boolean;
  exists: boolean;
  isDirectory: boolean;
  isWritable: boolean;
  resolvedPath: string;
  error: string | null;
}
