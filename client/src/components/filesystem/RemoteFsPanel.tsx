import React, { useRef } from "react";
import type { DirectoryListing } from "../../types/filesystem.ts";
import type { FormattedError } from "../../types/error.ts";
import type { RobotSummaryDto } from "../../types/fleet.ts";
import { FsTable } from "./FsTable.tsx";
import { RobotCombobox } from "../common/RobotCombobox.tsx";

interface RemoteFsPanelProps {
  robotId: string;
  onRobotIdChange: (id: string) => void;
  robots?: RobotSummaryDto[];
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
  robots = [],
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

  const entries = listing?.entries || (listing as any)?.items || [];

  let emptyMessage = "Nessuna directory remota caricata.";
  if (loading) {
    emptyMessage = "Caricamento directory remota in corso...";
  } else if (!robotId) {
    emptyMessage = "Nessun robot selezionato. Selezionare o inserire un ID robot per visualizzare i file.";
  } else if (!listing) {
    emptyMessage = "Robot selezionato. Premere 'Carica Directory Remota' per consultare i file.";
  } else if (entries.length === 0) {
    emptyMessage = "La cartella remota è vuota.";
  }

  return (
    <div id="fs-panel-remote" className="fs-panel">
      {/* 3. Titolo e descrizione del contesto */}
      <div className="fs-context-header mb-3">
        <h3 className="h5 fw-bold mb-1">Esplora Filesystem del Robot (Remoto SFTP)</h3>
        <small className="fs-subtitle text-secondary">
          Navigazione diretta nel filesystem remoto del robot tramite SFTP via backend. Nessun file archiviato sul server locale.
        </small>
      </div>

      {/* 4. Selettore robot + Carica Directory */}
      <div className="fs-robot-selector-bar d-flex align-items-center gap-3 mb-3 p-3 bg-light border rounded flex-wrap">
        <label htmlFor="fs-remote-robot-id" className="form-label mb-0 fw-semibold text-secondary" style={{ whiteSpace: "nowrap" }}>
          ID Robot:
        </label>
        <div className="fs-combobox-wrapper" style={{ minWidth: 280, maxWidth: 400, flex: "1 1 300px" }}>
          <RobotCombobox
            id="fs-remote-robot-id"
            name="fsRemoteRobotId"
            placeholder="es. robot_01"
            value={robotId}
            onChange={onRobotIdChange}
            onSubmit={onLoad}
            robots={robots}
          />
        </div>
        <button
          type="button"
          id="btn-fs-remote-load"
          className="btn btn-primary fs-control-btn"
          onClick={onLoad}
        >
          Carica Directory Remota
        </button>
      </div>

      {/* 5. Barra del percorso corrente e azioni */}
      <div className="fs-navigation-bar d-flex align-items-center gap-3 p-2 px-3 mb-3 bg-light border rounded flex-wrap">
        <button
          type="button"
          id="btn-fs-remote-up"
          className="btn btn-outline-secondary btn-sm"
          title="Torna al livello precedente"
          onClick={onUp}
          disabled={currentPath === "/" || !currentPath}
        >
          Torna al livello precedente
        </button>
        <span className="fs-breadcrumb">
          Percorso Remoto: <strong id="fs-remote-current-path">{currentPath || "/"}</strong>
        </span>
        <div className="fs-actions ms-auto d-flex gap-2">
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
            title="Carica file dal computer verso il robot"
            onClick={() => fileInputRef.current?.click()}
          >
            Carica sul Robot
          </button>
          <button
            type="button"
            id="btn-fs-remote-purge"
            className="btn btn-danger btn-sm"
            title="Elimina definitivamente i file temporanei orfani dal robot e server"
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

      {/* 6. Tabella dei file */}
      <FsTable
        entries={entries}
        tbodyId="fs-remote-table-body"
        emptyMessage={emptyMessage}
        onNavigateDir={onNavigateDir}
        onDownload={onDownload}
        onTransfer={onTransferToServer}
        onDelete={onDelete}
        transferActionLabel="Copia su Server"
      />
    </div>
  );
};
