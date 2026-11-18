import React from "react";
import {
  Bot,
  ChevronRight,
  Download,
  File,
  FileArchive,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  Folder,
  FolderOpen,
  Send,
  Trash2,
} from "lucide-react";
import type { FsEntry } from "../../types/filesystem.ts";
import { StateFormatter } from "../../services/state-formatter.ts";

interface FsTableProps {
  entries: FsEntry[];
  tbodyId?: string;
  emptyMessage?: React.ReactNode;
  emptyHint?: string;
  loading?: boolean;
  onNavigateDir: (dirName: string) => void;
  /** Invocato quando l'utente apre una directory di robot dall'Archivio Generale aggregato. */
  onOpenRobot?: (robotId: string) => void;
  onDownload: (fileName: string) => void;
  onTransfer?: (fileName: string) => void;
  onDelete: (fileName: string) => void;
  onDeleteFolder?: (folderName: string) => void;
  transferActionLabel?: string;
}

const DATE_FORMATTER = new Intl.DateTimeFormat("it-IT", {
  day: "2-digit",
  month: "short",
  year: "numeric",
});

const TIME_FORMATTER = new Intl.DateTimeFormat("it-IT", {
  hour: "2-digit",
  minute: "2-digit",
});

function formatModified(value?: string | null): { date: string; time: string } {
  if (!value) return { date: "—", time: "" };
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return { date: "—", time: "" };
  if (parsed.getTime() <= 0) return { date: "—", time: "" };
  return { date: DATE_FORMATTER.format(parsed), time: TIME_FORMATTER.format(parsed) };
}

function getExtension(name: string): string {
  const dotIndex = name.lastIndexOf(".");
  if (dotIndex <= 0 || dotIndex === name.length - 1) return "";
  const extension = name.slice(dotIndex + 1);
  return extension.length <= 6 ? extension.toUpperCase() : "";
}

function getFileIcon(name: string) {
  const extension = getExtension(name).toLowerCase();
  if (["png", "jpg", "jpeg", "gif", "bmp", "svg", "webp", "ico"].includes(extension)) {
    return FileImage;
  }
  if (["zip", "tar", "gz", "tgz", "bz2", "xz", "7z", "rar"].includes(extension)) {
    return FileArchive;
  }
  if (["js", "ts", "tsx", "jsx", "json", "py", "sh", "yml", "yaml", "html", "css", "xml"].includes(extension)) {
    return FileCode;
  }
  if (["csv", "xls", "xlsx", "ods"].includes(extension)) {
    return FileSpreadsheet;
  }
  if (["txt", "md", "log", "cfg", "conf", "ini", "pdf", "doc", "docx"].includes(extension)) {
    return FileText;
  }
  return File;
}

const SKELETON_ROWS = 5;

export const FsTable: React.FC<FsTableProps> = ({
  entries,
  tbodyId,
  emptyMessage = "Nessun elemento presente.",
  emptyHint,
  loading = false,
  onNavigateDir,
  onOpenRobot,
  onDownload,
  onTransfer,
  onDelete,
  onDeleteFolder,
  transferActionLabel,
}) => {
  const showSkeleton = loading && entries.length === 0;

  return (
    <div className={`fs-table-container ${showSkeleton ? "is-loading" : ""}`}>
      <table className="fs-table">
        <thead>
          <tr>
            <th scope="col" className="fs-col-name">
              Nome
            </th>
            <th scope="col" className="fs-col-size">
              Dimensione
            </th>
            <th scope="col" className="fs-col-date">
              Ultima modifica
            </th>
            <th scope="col" className="fs-col-actions">
              Azioni
            </th>
          </tr>
        </thead>
        <tbody id={tbodyId}>
          {showSkeleton ? (
            Array.from({ length: SKELETON_ROWS }).map((_, index) => (
              <tr key={`skeleton-${index}`} className="fs-row fs-row-skeleton" aria-hidden="true">
                <td>
                  <span className="fs-skeleton fs-skeleton-name" />
                </td>
                <td>
                  <span className="fs-skeleton fs-skeleton-size" />
                </td>
                <td>
                  <span className="fs-skeleton fs-skeleton-date" />
                </td>
                <td>
                  <span className="fs-skeleton fs-skeleton-action" />
                </td>
              </tr>
            ))
          ) : entries.length === 0 ? (
            <tr>
              <td colSpan={4}>
                <div className="fs-empty-state">
                  <div className="fs-empty-icon" aria-hidden="true">
                    <FolderOpen size={26} strokeWidth={1.6} />
                  </div>
                  <p className="fs-empty-title">{emptyMessage}</p>
                  {emptyHint && <p className="fs-empty-hint">{emptyHint}</p>}
                </div>
              </td>
            </tr>
          ) : (
            entries.map((entry) => {
              const isDir = entry.type === "directory";
              const isSymlink = entry.type === "symlink";
              const isRobotEntry = entry.scope === "robot";
              const robotId = entry.robotId;
              const displayLabel = isRobotEntry && entry.displayName ? entry.displayName : entry.name;
              const extension = !isDir && !isSymlink ? getExtension(entry.name) : "";
              const FileIcon = getFileIcon(entry.name);
              const modified = formatModified(entry.modifiedAt || entry.mtime);
              const rowKey = `${entry.scope || "general"}:${robotId || entry.name}:${entry.name}`;

              const openEntry = () => {
                if (isRobotEntry && robotId && onOpenRobot) {
                  onOpenRobot(robotId);
                  return;
                }
                if (isDir) {
                  onNavigateDir(entry.name);
                }
              };

              return (
                <tr
                  key={rowKey}
                  className={`fs-row ${isDir ? "fs-row-dir" : "fs-row-file"} ${isRobotEntry ? "fs-row-robot" : ""}`}
                  onDoubleClick={isDir ? openEntry : undefined}
                >
                  <td className="fs-cell-name">
                    <div className="fs-entry">
                      <span
                        className={`fs-entry-icon ${isDir ? "is-dir" : "is-file"} ${isRobotEntry ? "is-robot" : ""}`}
                        aria-hidden="true"
                      >
                        {isRobotEntry ? (
                          <Bot size={19} strokeWidth={1.9} />
                        ) : isDir ? (
                          <Folder size={19} strokeWidth={1.9} />
                        ) : (
                          <FileIcon size={19} strokeWidth={1.8} />
                        )}
                      </span>

                      <div className="fs-entry-text">
                        {isDir ? (
                          <button
                            type="button"
                            className="fs-entry-name fs-entry-button"
                            onClick={openEntry}
                            title={isRobotEntry ? `Apri il filesystem del robot ${robotId}` : `Apri la cartella ${entry.name}`}
                          >
                            <span className="fs-entry-label">{displayLabel}</span>
                            {!isRobotEntry && <span className="fs-entry-dir-slash">/</span>}
                          </button>
                        ) : (
                          <span className="fs-entry-name" title={entry.name}>
                            {entry.name}
                          </span>
                        )}

                        <span className="fs-entry-meta">
                          {isRobotEntry ? (
                            <>
                              <span className="fs-chip fs-chip-robot">
                                <Bot size={11} strokeWidth={2} aria-hidden="true" />
                                Robot
                              </span>
                              <span className="fs-entry-subtitle">
                                {entry.name}
                                {entry.exists === false ? " · directory non ancora creata" : ""}
                              </span>
                            </>
                          ) : isSymlink ? (
                            <span className="fs-chip fs-chip-link">Collegamento</span>
                          ) : isDir ? (
                            <span className="fs-entry-subtitle">Cartella</span>
                          ) : (
                            extension && <span className="fs-chip fs-chip-ext">{extension}</span>
                          )}
                        </span>
                      </div>
                    </div>
                  </td>

                  <td className="fs-cell-size">
                    {isDir ? (
                      <span className="fs-size fs-size-dir">—</span>
                    ) : (
                      <span className="fs-size">{StateFormatter.formatBytes(entry.size)}</span>
                    )}
                  </td>

                  <td className="fs-cell-date">
                    {isRobotEntry && entry.exists === false ? (
                      <span className="fs-chip fs-chip-missing">Non creata</span>
                    ) : (
                      <span className="fs-date">
                        <span className="fs-date-day">{modified.date}</span>
                        {modified.time && <span className="fs-date-time">{modified.time}</span>}
                      </span>
                    )}
                  </td>

                  <td className="fs-cell-actions">
                    {isDir ? (
                      <div className="fs-actions-row">
                        <button
                          type="button"
                          className="fs-action fs-action-open"
                          onClick={openEntry}
                          title={isRobotEntry ? `Apri il robot ${robotId}` : `Apri ${entry.name}`}
                        >
                          <ChevronRight size={15} strokeWidth={2.2} aria-hidden="true" />
                          <span>Apri</span>
                        </button>
                        {!isRobotEntry && onDeleteFolder && (
                          <button
                            type="button"
                            className="fs-action fs-action-danger"
                            title="Elimina cartella"
                            onClick={() => onDeleteFolder(entry.name)}
                          >
                            <Trash2 size={14} strokeWidth={2} aria-hidden="true" />
                            <span>Elimina</span>
                          </button>
                        )}
                      </div>
                    ) : (
                      <div className="fs-actions-row">
                        <button
                          type="button"
                          className="fs-action"
                          title="Scarica file sul tuo computer"
                          onClick={() => onDownload(entry.name)}
                        >
                          <Download size={14} strokeWidth={2} aria-hidden="true" />
                          <span>Scarica</span>
                        </button>

                        {onTransfer && transferActionLabel && (
                          <button
                            type="button"
                            className="fs-action fs-action-primary"
                            title={transferActionLabel}
                            onClick={() => onTransfer(entry.name)}
                          >
                            <Send size={14} strokeWidth={2} aria-hidden="true" />
                            <span>{transferActionLabel}</span>
                          </button>
                        )}

                        <button
                          type="button"
                          className="fs-action fs-action-danger"
                          title="Elimina file"
                          onClick={() => onDelete(entry.name)}
                        >
                          <Trash2 size={14} strokeWidth={2} aria-hidden="true" />
                          <span>Elimina</span>
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
};
