import React, { useRef } from "react";
import type { DirectoryListing } from "../../types/filesystem.ts";
import type { FormattedError } from "../../types/error.ts";
import { FsTable } from "./FsTable.tsx";

interface ServerFsPanelProps {
  robotId: string;
  onRobotIdChange: (id: string) => void;
  currentPath: string;
  listing: DirectoryListing | null;
  loading: boolean;
  error: FormattedError | null;
  onLoad: () => void;
  onUp: () => void;
  onNavigateDir: (dirName: string) => void;
  onUpload: (file: File) => void;
  onDownload: (fileName: string) => void;
  onTransferToRemote: (fileName: string) => void;
  onDelete: (fileName: string) => void;
}

export const ServerFsPanel: React.FC<ServerFsPanelProps> = ({
  robotId,
  onRobotIdChange,
  currentPath,
  listing,
  loading,
  error,
  onLoad,
  onUp,
  onNavigateDir,
  onUpload,
  onDownload,
  onTransferToRemote,
  onDelete,
}) => {
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      onUpload(file);
      e.target.value = "";
    }
  };

  return (
    <div id="fs-panel-server" className="fs-panel">
      <div className="fs-header">
        <div>
          <h3>Esplora Filesystem Server del Robot</h3>
          <small className="fs-subtitle">
            File e directory archiviati nella root server dedicata al robot selezionato.
          </small>
        </div>
        <div className="fs-robot-selector">
          <label htmlFor="fs-robot-id">ID Robot:</label>
          <input
            type="text"
            id="fs-robot-id"
            name="fsRobotId"
            placeholder="es. robot_01"
            value={robotId}
            onChange={(e) => onRobotIdChange(e.target.value)}
          />
          <button
            type="button"
            id="btn-fs-load"
            className="btn btn-secondary"
            onClick={onLoad}
          >
            Carica Directory Server
          </button>
        </div>
      </div>

      <div className="fs-navigation-bar">
        <button
          type="button"
          id="btn-fs-up"
          className="btn btn-secondary"
          title="Torna al livello superiore"
          onClick={onUp}
          disabled={currentPath === "/" || !currentPath}
        >
          Torna su
        </button>
        <span className="fs-breadcrumb">
          Percorso Server: <strong id="fs-current-path">{currentPath || "/"}</strong>
        </span>
        <div className="fs-actions" style={{ marginLeft: "auto", display: "flex", gap: "0.5rem" }}>
          <input
            type="file"
            id="fs-server-file-input"
            name="fsServerFileInput"
            ref={fileInputRef}
            style={{ display: "none" }}
            aria-label="Seleziona file da caricare sul server"
            onChange={handleFileChange}
          />
          <button
            type="button"
            id="btn-fs-server-upload"
            className="btn btn-primary btn-sm"
            title="Carica file dal computer al server (RF-TRF-001)"
            onClick={() => fileInputRef.current?.click()}
          >
            Carica sul Server
          </button>
        </div>
      </div>

      <div
        id="fs-error"
        className={`error-message ${error ? "" : "hidden"}`}
        role="alert"
      >
        {error?.userMessage}
      </div>

      <FsTable
        entries={listing?.entries || []}
        tbodyId="fs-table-body"
        emptyMessage={
          loading
            ? "Caricamento directory in corso..."
            : "Nessuna directory caricata. Selezionare un robot o inserire un ID e premere 'Carica Directory Server'."
        }
        onNavigateDir={onNavigateDir}
        onDownload={onDownload}
        onTransfer={onTransferToRemote}
        onDelete={onDelete}
        transferActionLabel="Invia al Robot"
      />
    </div>
  );
};
