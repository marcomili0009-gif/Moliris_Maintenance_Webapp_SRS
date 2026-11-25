import React, { useRef, useState } from "react";
import { FolderPlus, Radio, RefreshCw, UploadCloud } from "lucide-react";
import type { DirectoryListing, FsEntry } from "../../types/filesystem.ts";
import type { FormattedError } from "../../types/error.ts";
import type { RobotSummaryDto } from "../../types/fleet.ts";
import { FsTable } from "./FsTable.tsx";
import { FsBreadcrumb } from "./FsBreadcrumb.tsx";
import { RobotCombobox } from "../common/RobotCombobox.tsx";
import { NewFolderModal } from "../common/NewFolderModal.tsx";

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
  onNavigatePath?: (path: string) => void;
  onCreateFolder?: (name: string) => Promise<{ success: boolean; error?: string }>;
  onUpload: (file: File) => void;
  onDownload: (fileName: string) => void;
  onTransferToServer: (fileName: string, entry?: FsEntry) => void;
  onDelete: (fileName: string) => void;
  onDeleteFolder?: (folderName: string) => void;
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
  onNavigatePath,
  onCreateFolder,
  onUpload,
  onDownload,
  onTransferToServer,
  onDelete,
  onDeleteFolder,
}) => {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [isNewFolderOpen, setIsNewFolderOpen] = useState(false);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      onUpload(file);
      e.target.value = "";
    }
  };

  const entries = listing?.entries || (listing as any)?.items || [];
  const isRoot = !currentPath || currentPath === "/";
  const selectedRobot = robots.find((robot) => robot.id === robotId);
  const totalFiles = entries.filter((entry: any) => entry.type !== "directory").length;
  const totalFolders = entries.filter((entry: any) => entry.type === "directory").length;

  let emptyMessage: React.ReactNode = "Nessuna directory remota caricata.";
  let emptyHint: string | undefined;
  if (loading) {
    emptyMessage = "Caricamento directory remota in corso...";
  } else if (!robotId) {
    emptyMessage = "Nessun robot selezionato.";
    emptyHint = "Seleziona o inserisci un ID robot per visualizzare i file remoti via SFTP.";
  } else if (!listing) {
    emptyMessage = "Robot selezionato, directory remota non ancora caricata.";
    emptyHint = "Premi “Carica Directory Remota” per consultare i file sul robot.";
  } else if (entries.length === 0) {
    emptyMessage = "La cartella remota è vuota.";
    emptyHint = "Carica un file dal computer per popolare questa directory.";
  }

  return (
    <div id="fs-panel-remote" className="fs-panel">
      <div className="fs-context-header">
        <div className="fs-context-heading">
          <span className="fs-context-icon" aria-hidden="true">
            <Radio size={20} strokeWidth={1.9} />
          </span>
          <div>
            <h3>Esplora Filesystem del Robot (Remoto SFTP)</h3>
            <p className="fs-subtitle">
              Navigazione diretta nel filesystem remoto del robot tramite SFTP. Nessun file archiviato sul server locale.
            </p>
          </div>
        </div>

        {listing && (
          <div className="fs-context-stats" aria-label="Riepilogo contenuti remoti">
            <span className="fs-stat">
              <strong>{totalFolders}</strong> cartelle
            </span>
            <span className="fs-stat-divider" aria-hidden="true" />
            <span className="fs-stat">
              <strong>{totalFiles}</strong> file
            </span>
          </div>
        )}
      </div>

      <div className="fs-robot-selector-bar">
        <label htmlFor="fs-remote-robot-id" className="form-label">
          ID Robot:
        </label>
        <div className="fs-combobox-wrapper">
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
        {selectedRobot && (
          <span className="fs-selected-robot" title={selectedRobot.id}>
            {selectedRobot.displayName || selectedRobot.id}
          </span>
        )}
        <button
          type="button"
          id="btn-fs-remote-load"
          className="btn btn-primary fs-control-btn"
          onClick={onLoad}
          disabled={loading}
        >
          {loading ? (
            <>
              <RefreshCw size={15} className="fs-spin" aria-hidden="true" />
              Caricamento...
            </>
          ) : (
            <>
              <RefreshCw size={15} aria-hidden="true" />
              Carica Directory Remota
            </>
          )}
        </button>
      </div>

      <div className="fs-navigation-bar">
        <button
          type="button"
          id="btn-fs-remote-up"
          className="btn btn-outline-secondary btn-sm fs-nav-btn"
          title="Torna al livello precedente"
          onClick={onUp}
          disabled={isRoot || !robotId}
        >
          Torna su
        </button>

        <FsBreadcrumb
          id="fs-remote-breadcrumb"
          path={currentPath || "/"}
          rootLabel="Robot (SFTP)"
          ariaLabel="Percorso remoto del robot"
          currentPathId="fs-remote-current-path"
          onNavigate={(path) => {
            if (onNavigatePath) onNavigatePath(path);
            else if (path === "/") onUp();
          }}
        />

        <div className="fs-actions">
          {onCreateFolder && (
            <button
              type="button"
              id="btn-fs-remote-mkdir"
              className="btn btn-outline-primary btn-sm fs-toolbar-btn"
              title="Crea una nuova cartella sul robot"
              onClick={() => setIsNewFolderOpen(true)}
              disabled={!robotId || loading}
            >
              <FolderPlus size={15} aria-hidden="true" />
              Nuova Cartella
            </button>
          )}
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
            className="btn btn-primary btn-sm fs-toolbar-btn"
            title="Carica file dal computer verso il robot"
            onClick={() => fileInputRef.current?.click()}
            disabled={!robotId}
          >
            <UploadCloud size={15} aria-hidden="true" />
            Carica sul Robot
          </button>
        </div>
      </div>

      <div id="fs-remote-error" className={`fs-error-banner ${error ? "" : "hidden"}`} role="alert">
        {error?.userMessage}
      </div>

      <FsTable
        entries={entries}
        tbodyId="fs-remote-table-body"
        emptyMessage={emptyMessage}
        emptyHint={emptyHint}
        loading={loading}
        onNavigateDir={onNavigateDir}
        onDownload={onDownload}
        onTransfer={onTransferToServer}
        onDelete={onDelete}
        onDeleteFolder={onDeleteFolder}
        transferActionLabel="Copia su Server"
      />

      {onCreateFolder && (
        <NewFolderModal
          isOpen={isNewFolderOpen}
          currentPath={currentPath || "/"}
          onClose={() => setIsNewFolderOpen(false)}
          onCreate={onCreateFolder}
        />
      )}
    </div>
  );
};
