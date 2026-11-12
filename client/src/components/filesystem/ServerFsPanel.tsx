import React, { useRef } from "react";
import type { DirectoryListing } from "../../types/filesystem.ts";
import type { FormattedError } from "../../types/error.ts";
import type { RobotSummaryDto } from "../../types/fleet.ts";
import { FsTable } from "./FsTable.tsx";
import { RobotCombobox } from "../common/RobotCombobox.tsx";

interface ServerFsPanelProps {
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
  onTransferToRemote: (fileName: string) => void;
  onDelete: (fileName: string) => void;
}

export const ServerFsPanel: React.FC<ServerFsPanelProps> = ({
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

  const entries = listing?.entries || (listing as any)?.items || [];

  let emptyMessage = "Nessuna directory caricata.";
  if (loading) {
    emptyMessage = "Caricamento directory in corso...";
  } else if (!robotId) {
    emptyMessage = "Nessun robot selezionato. Selezionare o inserire un ID robot per visualizzare i file.";
  } else if (!listing) {
    emptyMessage = "Robot selezionato. Premere 'Carica Directory Server' per consultare i file.";
  } else if (entries.length === 0) {
    emptyMessage = "La cartella è vuota.";
  }

  return (
    <div id="fs-panel-server" className="fs-panel">
      {/* 3. Titolo e descrizione del contesto */}
      <div className="fs-context-header mb-3">
        <h3 className="h5 fw-bold mb-1">Esplora Filesystem Server del Robot</h3>
        <small className="fs-subtitle text-secondary">
          File e directory archiviati nella root server dedicata al robot selezionato.
        </small>
      </div>

      {/* 4. Selettore robot + Carica Directory */}
      <div className="fs-robot-selector-bar d-flex align-items-center gap-3 mb-3 p-3 bg-light border rounded flex-wrap">
        <label htmlFor="fs-robot-id" className="form-label mb-0 fw-semibold text-secondary" style={{ whiteSpace: "nowrap" }}>
          ID Robot:
        </label>
        <div className="fs-combobox-wrapper" style={{ minWidth: 280, maxWidth: 400, flex: "1 1 300px" }}>
          <RobotCombobox
            id="fs-robot-id"
            name="fsRobotId"
            placeholder="es. robot_01"
            value={robotId}
            onChange={onRobotIdChange}
            onSubmit={onLoad}
            robots={robots}
          />
        </div>
        <button
          type="button"
          id="btn-fs-load"
          className="btn btn-primary fs-control-btn"
          onClick={onLoad}
        >
          Carica Directory Server
        </button>
      </div>

      {/* 5. Barra del percorso corrente e azioni */}
      <div className="fs-navigation-bar d-flex align-items-center gap-3 p-2 px-3 mb-3 bg-light border rounded flex-wrap">
        <button
          type="button"
          id="btn-fs-up"
          className="btn btn-outline-secondary btn-sm"
          title="Torna al livello superiore"
          onClick={onUp}
          disabled={currentPath === "/" || !currentPath}
        >
          Torna su
        </button>
        <span className="fs-breadcrumb">
          Percorso Server: <strong id="fs-current-path">{currentPath || "/"}</strong>
        </span>
        <div className="fs-actions ms-auto d-flex gap-2">
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
            title="Carica file dal computer al server"
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

      {/* 6. Tabella dei file */}
      <FsTable
        entries={entries}
        tbodyId="fs-table-body"
        emptyMessage={emptyMessage}
        onNavigateDir={onNavigateDir}
        onDownload={onDownload}
        onTransfer={onTransferToRemote}
        onDelete={onDelete}
        transferActionLabel="Invia al Robot"
      />
    </div>
  );
};
