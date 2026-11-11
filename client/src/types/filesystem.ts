export interface FsEntry {
  name: string;
  type: "file" | "directory" | "symlink" | "other";
  size: number;
  mtime: string;
  permissions?: string;
  target?: string;
}

export interface DirectoryListing {
  path: string;
  entries: FsEntry[];
  totalCount: number;
  isTruncated: boolean;
}
