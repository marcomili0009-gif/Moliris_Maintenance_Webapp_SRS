import React, { useRef } from "react";
import type { DirectoryListing } from "../../types/filesystem.ts";
import type { FormattedError } from "../../types/error.ts";
import { FsTable } from "./FsTable.tsx";

interface RemoteFsPanelProps {
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
  onTransferToServer: (fileName: string) => void;
  onDelete: (fileName: string) => void;
  onPurgeTemp: () => void;
}

export const RemoteFsPanel: React.FC<RemoteFsPanelProps> = ({
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
  onTransferToServer,
  onDelete,
  onPurgeTemp,
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
    <div id="fs-panel-remote" className="fs-panel">
      <div className="fs-header">
        <div>
          <h3>Esplora Filesystem del Robot (Remoto SFTP)</h3>
          <small className="fs-subtitle">
            Navigazione diretta nel filesystem remoto del robot tramite SFTP via backend (§1.2, vincolo 2.4). Nessun file archiviato sul server locale.
          </small>
        </div>
        <div className="fs-robot-selector">
          <label htmlFor="fs-remote-robot-id">ID Robot:</label>
          <input
            type="text"
            id="fs-remote-robot-id"
            name="fsRemoteRobotId"
            placeholder="es. robot_01"
            value={robotId}
            onChange={(e) => onRobotIdChange(e.target.value)}
          />
          <button
            type="button"
            id="btn-fs-remote-load"
            className="btn btn-primary"
            onClick={onLoad}
          >
            Carica Directory Remota
          </button>
        </div>
      </div>

      <div className="fs-navigation-bar">
        <button
          type="button"
          id="btn-fs-remote-up"
          className="btn btn-secondary"
          title="Torna al livello precedente (RF-FS-003)"
          onClick={onUp}
          disabled={currentPath === "/" || !currentPath}
        >
          Torna al livello precedente
        </button>
        <span className="fs-breadcrumb">
          Percorso Remoto: <strong id="fs-remote-current-path">{currentPath || "/"}</strong>
        </span>
        <div className="fs-actions" style={{ marginLeft: "auto", display: "flex", gap: "0.5rem" }}>
          <input
            type="file"
            id="fs-remote-file-input"
            name="fsRemoteFileInput"
            ref={fileInputRef}
            style={{ display: "none" }}
            aria-label="Seleziona file da caricare sul robot"
            onChange={handleFileChange}
          />
          <button
            type="button"
            id="btn-fs-remote-upload"
            className="btn btn-primary btn-sm"
            title="Carica file dal computer verso il robot (RF-TRF-003)"
            onClick={() => fileInputRef.current?.click()}
          >
            Carica sul Robot
          </button>
          <button
            type="button"
            id="btn-fs-remote-purge"
            className="btn btn-danger btn-sm"
            title="Elimina definitivamente tutti i file temporanei orfani (.tmp_moliris_*) dal robot e server"
            onClick={onPurgeTemp}
          >
            Bonifica Temp
          </button>
        </div>
      </div>

      <div
        id="fs-remote-error"
        className={`error-message ${error ? "" : "hidden"}`}
        role="alert"
      >
        {error?.userMessage}
      </div>

      <FsTable
        entries={listing?.entries || []}
        tbodyId="fs-remote-table-body"
        emptyMessage={
          loading
            ? "Caricamento directory remota in corso..."
            : "Nessuna directory remota caricata. Selezionare un robot attivo e premere 'Carica Directory Remota'."
        }
        onNavigateDir={onNavigateDir}
        onDownload={onDownload}
        onTransfer={onTransferToServer}
        onDelete={onDelete}
        transferActionLabel="Copia su Server"
      />
    </div>
  );
};
