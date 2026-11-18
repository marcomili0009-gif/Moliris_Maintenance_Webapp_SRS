export interface FsEntry {
  name: string;
  type: "file" | "directory" | "symlink" | "other";
  size: number;
  mtime: string;
  modifiedAt?: string;
  permissions?: string;
  target?: string;
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

