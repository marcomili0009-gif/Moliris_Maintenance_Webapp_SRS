import React from "react";
import type { FsEntry } from "../../types/filesystem.ts";
import { StateFormatter } from "../../services/state-formatter.ts";

interface FsTableProps {
  entries: FsEntry[];
  tbodyId?: string;
  emptyMessage?: string;
  onNavigateDir: (dirName: string) => void;
  onDownload: (fileName: string) => void;
  onTransfer?: (fileName: string) => void;
  onDelete: (fileName: string) => void;
  transferActionLabel?: string;
}

export const FsTable: React.FC<FsTableProps> = ({
  entries,
  tbodyId,
  emptyMessage = "Nessun elemento presente.",
  onNavigateDir,
  onDownload,
  onTransfer,
  onDelete,
  transferActionLabel,
}) => {
  return (
    <div className="fs-table-container">
      <table className="fs-table">
        <thead>
          <tr>
            <th style={{ width: "10%" }}>Tipo</th>
            <th style={{ width: "35%" }}>Nome</th>
            <th style={{ width: "15%" }}>Dimensione</th>
            <th style={{ width: "20%" }}>Ultima Modifica</th>
            <th style={{ width: "20%" }}>Azioni Trasferimento</th>
          </tr>
        </thead>
        <tbody id={tbodyId}>
          {entries.length === 0 ? (
            <tr>
              <td colSpan={5} className="fs-empty-msg">
                {emptyMessage}
              </td>
            </tr>
          ) : (
            entries.map((entry) => {
              const isDir = entry.type === "directory";
              const isSymlink = entry.type === "symlink";

              return (
                <tr key={entry.name}>
                  <td>
                    <span className={`badge ${isDir ? "badge-info" : isSymlink ? "badge-warning" : "badge-secondary"}`}>
                      {isDir ? "Cartella" : isSymlink ? "Link" : "File"}
                    </span>
                  </td>
                  <td>
                    {isDir ? (
                      <button
                        type="button"
                        className="btn-link font-semibold text-blue-600 hover:underline"
                        onClick={() => onNavigateDir(entry.name)}
                      >
                        {entry.name}/
                      </button>
                    ) : (
                      <span>{entry.name}</span>
                    )}
                  </td>
                  <td>{isDir ? "-" : StateFormatter.formatBytes(entry.size)}</td>
                  <td>{StateFormatter.formatDate(entry.mtime || entry.modifiedAt)}</td>
                  <td>
                    <div style={{ display: "flex", gap: "0.25rem", flexWrap: "wrap" }}>
                      {!isDir && (
                        <>
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            title="Scarica file sul tuo computer"
                            onClick={() => onDownload(entry.name)}
                          >
                            Scarica
                          </button>
                          {onTransfer && transferActionLabel && (
                            <button
                              type="button"
                              className="btn btn-primary btn-sm"
                              title={transferActionLabel}
                              onClick={() => onTransfer(entry.name)}
                            >
                              {transferActionLabel}
                            </button>
                          )}
                          <button
                            type="button"
                            className="btn btn-danger btn-sm"
                            title="Elimina file"
                            onClick={() => onDelete(entry.name)}
                          >
                            Elimina
                          </button>
                        </>
                      )}
                    </div>
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
