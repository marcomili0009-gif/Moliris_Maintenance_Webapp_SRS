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
