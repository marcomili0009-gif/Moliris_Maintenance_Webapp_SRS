import React, { useRef, useState } from "react";
import { FolderPlus, RefreshCw, Server, UploadCloud } from "lucide-react";
import type { DirectoryListing, FsEntry } from "../../types/filesystem.ts";
import type { FormattedError } from "../../types/error.ts";
import type { RobotSummaryDto } from "../../types/fleet.ts";
import { FsTable } from "./FsTable.tsx";
import { FsBreadcrumb } from "./FsBreadcrumb.tsx";
import { RobotCombobox } from "../common/RobotCombobox.tsx";
import { NewFolderModal } from "../common/NewFolderModal.tsx";

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
  onNavigatePath?: (path: string) => void;
  onCreateFolder?: (name: string) => Promise<{ success: boolean; error?: string }>;
  onUpload: (file: File) => void;
  onDownload: (fileName: string) => void;
  onTransferToRemote: (fileName: string, entry?: FsEntry) => void;
  onDelete: (fileName: string) => void;
  onDeleteFolder?: (folderName: string) => void;
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
  onNavigatePath,
  onCreateFolder,
  onUpload,
  onDownload,
  onTransferToRemote,
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

  let emptyMessage: React.ReactNode = "Nessuna directory caricata.";
  let emptyHint: string | undefined;
  if (loading) {
    emptyMessage = "Caricamento directory in corso...";
  } else if (!robotId) {
    emptyMessage = "Nessun robot selezionato.";
    emptyHint = "Seleziona o inserisci un ID robot per esplorare la sua area dedicata sul server.";
  } else if (!listing) {
    emptyMessage = "Robot selezionato, directory non ancora caricata.";
    emptyHint = "Premi “Carica Directory Server” per consultare i file archiviati.";
  } else if (entries.length === 0) {
    emptyMessage = "La cartella è vuota.";
    emptyHint = "Carica un file o crea una nuova cartella per iniziare.";
  }

  return (
    <div id="fs-panel-server" className="fs-panel">
      <div className="fs-context-header">
        <div className="fs-context-heading">
          <span className="fs-context-icon" aria-hidden="true">
            <Server size={20} strokeWidth={1.9} />
          </span>
          <div>
            <h3>Esplora Filesystem Server del Robot</h3>
            <p className="fs-subtitle">
              File e directory archiviati nella root server dedicata al robot selezionato.
            </p>
          </div>
        </div>

        {listing && (
          <div className="fs-context-stats" aria-label="Riepilogo contenuti">
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
        <label htmlFor="fs-robot-id" className="form-label">
          ID Robot:
        </label>
        <div className="fs-combobox-wrapper">
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
        {selectedRobot && (
          <span className="fs-selected-robot" title={selectedRobot.id}>
            {selectedRobot.displayName || selectedRobot.id}
          </span>
        )}
        <button
          type="button"
          id="btn-fs-load"
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
              Carica Directory Server
            </>
          )}
        </button>
      </div>

      <div className="fs-navigation-bar">
        <button
          type="button"
          id="btn-fs-up"
          className="btn btn-outline-secondary btn-sm fs-nav-btn"
          title={isRoot ? "Torna all'Archivio Generale Server" : "Torna al livello superiore"}
          onClick={onUp}
          disabled={!robotId}
        >
          Torna su
        </button>

        <FsBreadcrumb
          id="fs-server-breadcrumb"
          path={robotId ? (currentPath === "/" ? `/${robotId}` : `/${robotId}${currentPath}`) : (currentPath || "/")}
          rootLabel="Archivio"
          ariaLabel="Percorso server del robot"
          currentPathId="fs-current-path"
          onNavigate={(targetPath) => {
            if (robotId) {
              const stripped = targetPath.replace(new RegExp(`^/${robotId}`), "");
              const realPath = stripped === "" ? "/" : stripped;
              if (onNavigatePath) onNavigatePath(realPath);
              else if (realPath === "/") onUp();
            } else {
              if (onNavigatePath) onNavigatePath(targetPath);
            }
          }}
          onRootClick={onUp}
        />

        <div className="fs-actions">
          {onCreateFolder && (
            <button
              type="button"
              id="btn-server-mkdir"
              className="btn btn-outline-primary btn-sm fs-toolbar-btn"
              title="Crea una nuova cartella nel percorso corrente"
              onClick={() => setIsNewFolderOpen(true)}
              disabled={!robotId}
            >
              <FolderPlus size={15} aria-hidden="true" />
              Nuova Cartella
            </button>
          )}
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
            className="btn btn-primary btn-sm fs-toolbar-btn"
            title="Carica file dal computer al server"
            onClick={() => fileInputRef.current?.click()}
            disabled={!robotId}
          >
            <UploadCloud size={15} aria-hidden="true" />
            Carica sul Server
          </button>
        </div>
      </div>

      <div id="fs-error" className={`fs-error-banner ${error ? "" : "hidden"}`} role="alert">
        {error?.userMessage}
      </div>

      <FsTable
        entries={entries}
        tbodyId="fs-table-body"
        emptyMessage={emptyMessage}
        emptyHint={emptyHint}
        loading={loading}
        onNavigateDir={onNavigateDir}
        onDownload={onDownload}
        onTransfer={onTransferToRemote}
        onDelete={onDelete}
        onDeleteFolder={onDeleteFolder}
        transferActionLabel="Invia al Robot"
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
