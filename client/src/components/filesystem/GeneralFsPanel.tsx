import React, { useRef, useState, useEffect } from "react";
import type { DirectoryListing } from "../../types/filesystem.ts";
import type { FormattedError } from "../../types/error.ts";
import { FsTable } from "./FsTable.tsx";
import { NewFolderModal } from "../common/NewFolderModal.tsx";

interface GeneralFsPanelProps {
  currentPath: string;
  listing: DirectoryListing | null;
  loading: boolean;
  error: FormattedError | null;
  onLoad: (path?: string) => void;
  onUp: () => void;
  onNavigateDir: (dirName: string) => void;
  onCreateFolder: (name: string) => Promise<{ success: boolean; error?: string }>;
  onUpload: (file: File) => void;
  onDownload: (fileName: string) => void;
  onDelete: (fileName: string) => void;
}

export const GeneralFsPanel: React.FC<GeneralFsPanelProps> = ({
  currentPath,
  listing,
  loading,
  error,
  onLoad,
  onUp,
  onNavigateDir,
  onCreateFolder,
  onUpload,
  onDownload,
  onDelete,
}) => {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [isNewFolderOpen, setIsNewFolderOpen] = useState(false);

  // Caricamento iniziale se non ancora caricato
  useEffect(() => {
    if (!listing && !loading) {
      onLoad(currentPath || "/");
    }
  }, [listing, loading, onLoad, currentPath]);

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
    emptyMessage = "Caricamento archivio generale in corso...";
  } else if (!listing) {
    emptyMessage = "Caricamento archivio generale in corso...";
  } else if (entries.length === 0) {
    emptyMessage = "L'archivio generale è vuoto.";
  }

  return (
    <div id="fs-panel-general" className="fs-panel">
      {/* Intestazione del contesto */}
      <div className="fs-context-header mb-3">
        <h3 className="h5 fw-bold mb-1">Archivio Generale Server</h3>
        <small className="fs-subtitle text-secondary">
          Area di archiviazione centrale condivisa del server Moliris, accessibile indipendentemente dai singoli robot.
        </small>
      </div>

      {/* Barra di navigazione del percorso e azioni */}
      <div className="fs-navigation-bar d-flex align-items-center gap-3 p-2 px-3 mb-3 bg-light border rounded flex-wrap">
        <button
          type="button"
          id="btn-general-up"
          className="btn btn-outline-secondary btn-sm"
          title="Torna al livello superiore"
          onClick={onUp}
          disabled={currentPath === "/" || !currentPath}
        >
          Torna su
        </button>
        <span className="fs-breadcrumb">
          Percorso Generale: <strong id="fs-general-current-path">{currentPath || "/"}</strong>
        </span>
        <div className="fs-actions ms-auto d-flex gap-2">
          <button
            type="button"
            id="btn-general-refresh"
            className="btn btn-outline-secondary btn-sm"
            title="Aggiorna directory"
            onClick={() => onLoad(currentPath || "/")}
            disabled={loading}
          >
            {loading ? "Aggiornamento..." : "Aggiorna"}
          </button>
          <button
            type="button"
            id="btn-general-mkdir"
            className="btn btn-outline-primary btn-sm"
            title="Crea una nuova cartella"
            onClick={() => setIsNewFolderOpen(true)}
          >
            Nuova Cartella
          </button>
          <input
            type="file"
            id="fs-general-file-input"
            name="fsGeneralFileInput"
            ref={fileInputRef}
            style={{ display: "none" }}
            aria-label="Seleziona file da caricare nell'archivio generale"
            onChange={handleFileChange}
          />
          <button
            type="button"
            id="btn-general-upload"
            className="btn btn-primary btn-sm"
            title="Carica file dal computer nell'archivio generale"
            onClick={() => fileInputRef.current?.click()}
          >
            Carica File
          </button>
        </div>
      </div>

      {error && (
        <div
          id="fs-general-error"
          className="error-message alert alert-danger p-2 small mb-3"
          role="alert"
        >
          {error.userMessage}
        </div>
      )}

      {/* Tabella dei file */}
      <FsTable
        entries={entries}
        tbodyId="fs-general-table-body"
        emptyMessage={emptyMessage}
        onNavigateDir={onNavigateDir}
        onDownload={onDownload}
        onDelete={onDelete}
      />

      <NewFolderModal
        isOpen={isNewFolderOpen}
        currentPath={currentPath || "/"}
        onClose={() => setIsNewFolderOpen(false)}
        onCreate={onCreateFolder}
      />
    </div>
  );
};
