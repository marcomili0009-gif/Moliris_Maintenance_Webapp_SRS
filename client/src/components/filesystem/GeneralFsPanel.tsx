import React, { useRef, useState, useEffect } from "react";
import { Archive, FolderPlus, RefreshCw, Trash2, UploadCloud } from "lucide-react";
import type { DirectoryListing } from "../../types/filesystem.ts";
import type { FormattedError } from "../../types/error.ts";
import { FsTable } from "./FsTable.tsx";
import { FsBreadcrumb } from "./FsBreadcrumb.tsx";
import { NewFolderModal } from "../common/NewFolderModal.tsx";

interface GeneralFsPanelProps {
  currentPath: string;
  listing: DirectoryListing | null;
  loading: boolean;
  error: FormattedError | null;
  isAdmin?: boolean;
  deletedRobotFolder?: string | null;
  onLoad: (path?: string) => void;
  onUp: () => void;
  onNavigateDir: (dirName: string) => void;
  onNavigatePath?: (path: string) => void;
  /** Apre il filesystem dedicato di un robot elencato nella root aggregata. */
  onOpenRobot?: (robotId: string) => void;
  /** Apre una directory di un robot eliminato dall'anagrafica (ISS-017). */
  onOpenDeletedRobot?: (folderName: string) => void;
  /** Eliminazione definitiva della cartella di un robot eliminato (solo admin - ISS-017). */
  onDeleteDeletedRobot?: (folderName: string) => void;
  onCreateFolder: (name: string) => Promise<{ success: boolean; error?: string }>;
  onUpload: (file: File) => void;
  onDownload: (fileName: string) => void;
  onDelete: (fileName: string) => void;
  onDeleteFolder?: (folderName: string) => void;
}

export const GeneralFsPanel: React.FC<GeneralFsPanelProps> = ({
  currentPath,
  listing,
  loading,
  error,
  isAdmin = false,
  deletedRobotFolder = null,
  onLoad,
  onUp,
  onNavigateDir,
  onNavigatePath,
  onOpenRobot,
  onOpenDeletedRobot,
  onDeleteDeletedRobot,
  onCreateFolder,
  onUpload,
  onDownload,
  onDelete,
  onDeleteFolder,
}) => {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [isNewFolderOpen, setIsNewFolderOpen] = useState(false);
  const didAutoLoadRef = useRef(false);

  // Caricamento iniziale se non ancora caricato (una sola volta per mount, per evitare loop su errore).
  useEffect(() => {
    if (didAutoLoadRef.current) return;
    if (!listing && !loading) {
      didAutoLoadRef.current = true;
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
  const isRoot = !deletedRobotFolder && (!currentPath || currentPath === "/");
  const isViewingDeletedRobot = Boolean(deletedRobotFolder);
  const robotEntries = entries.filter((entry: any) => entry.scope === "robot");
  const deletedRobotEntries = entries.filter((entry: any) => entry.scope === "deleted_robot" || entry.isDeletedRobot);
  const sharedEntries = entries.filter(
    (entry: any) => entry.scope !== "robot" && entry.scope !== "deleted_robot" && !entry.isDeletedRobot
  );
  const sharedFiles = sharedEntries.filter((entry: any) => entry.type !== "directory").length;
  const sharedFolders = sharedEntries.filter((entry: any) => entry.type === "directory").length;

  let emptyMessage: React.ReactNode = "Nessuna directory caricata.";
  let emptyHint: string | undefined;
  if (loading) {
    emptyMessage = "Caricamento archivio generale in corso...";
  } else if (!listing) {
    emptyMessage = "Archivio generale non ancora caricato.";
    emptyHint = "Attendi il caricamento della root aggregata.";
  } else if (entries.length === 0) {
    emptyMessage = "L'archivio generale è vuoto.";
    emptyHint = "Crea una cartella condivisa o registra un robot per vederne l'area dedicata.";
  }

  return (
    <div id="fs-panel-general" className="fs-panel">
      <div className="fs-context-header">
        <div className="fs-context-heading">
          <span className="fs-context-icon" aria-hidden="true">
            <Archive size={20} strokeWidth={1.9} />
          </span>
          <div>
            <div className="d-flex align-items-center gap-2">
              <h3 className="mb-0">
                {isViewingDeletedRobot ? `Archivio Robot: ${deletedRobotFolder}` : "Archivio Generale Server"}
              </h3>
              {isViewingDeletedRobot && (
                <span className="badge text-bg-danger">Eliminato</span>
              )}
            </div>
            <p className="fs-subtitle">
              {isViewingDeletedRobot
                ? "Cartella sul server appartenente a un robot eliminato dall'anagrafica. I file restano consultabili e scaricabili."
                : "Vista aggregata della root server: aree dedicate dei robot (attivi ed eliminati) e contenuti condivisi."}
            </p>
          </div>
        </div>

        {listing && (
          <div className="fs-context-stats" aria-label="Riepilogo archivio generale">
            {isRoot && (
              <>
                <span className="fs-stat">
                  <strong>{robotEntries.length}</strong> robot
                </span>
                {deletedRobotEntries.length > 0 && (
                  <>
                    <span className="fs-stat-divider" aria-hidden="true" />
                    <span className="fs-stat text-danger">
                      <strong>{deletedRobotEntries.length}</strong> eliminati
                    </span>
                  </>
                )}
                <span className="fs-stat-divider" aria-hidden="true" />
              </>
            )}
            <span className="fs-stat">
              <strong>{sharedFolders}</strong> cartelle
            </span>
            <span className="fs-stat-divider" aria-hidden="true" />
            <span className="fs-stat">
              <strong>{sharedFiles}</strong> file
            </span>
          </div>
        )}
      </div>

      <div className="fs-navigation-bar">
        <button
          type="button"
          id="btn-general-up"
          className="btn btn-outline-secondary btn-sm fs-nav-btn"
          title="Torna al livello superiore"
          onClick={onUp}
          disabled={isRoot}
        >
          Torna su
        </button>

        <FsBreadcrumb
          id="fs-general-breadcrumb"
          path={currentPath || "/"}
          rootLabel="Archivio Generale"
          ariaLabel="Percorso archivio generale"
          currentPathId="fs-general-current-path"
          onNavigate={(path) => {
            if (onNavigatePath) onNavigatePath(path);
            else if (path === "/") onLoad("/");
          }}
        />

        <div className="fs-actions">
          <button
            type="button"
            id="btn-general-refresh"
            className="btn btn-outline-secondary btn-sm fs-toolbar-btn"
            title="Aggiorna directory"
            onClick={() => onLoad(currentPath || "/")}
            disabled={loading}
          >
            <RefreshCw size={15} className={loading ? "fs-spin" : undefined} aria-hidden="true" />
            {loading ? "Aggiornamento..." : "Aggiorna"}
          </button>
          {isViewingDeletedRobot && isAdmin && deletedRobotFolder && onDeleteDeletedRobot ? (
            <button
              type="button"
              id="btn-deleted-robot-purge"
              className="btn btn-danger btn-sm fs-toolbar-btn"
              title="Elimina definitivamente tutti i file e la cartella del robot eliminato dal server"
              onClick={() => onDeleteDeletedRobot(deletedRobotFolder)}
              disabled={loading}
            >
              <Trash2 size={15} aria-hidden="true" />
              Elimina definitivamente
            </button>
          ) : (
            !isViewingDeletedRobot && (
              <>
                <button
                  type="button"
                  id="btn-general-mkdir"
                  className="btn btn-outline-primary btn-sm fs-toolbar-btn"
                  title="Crea una nuova cartella"
                  onClick={() => setIsNewFolderOpen(true)}
                  disabled={loading}
                >
                  <FolderPlus size={15} aria-hidden="true" />
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
                  className="btn btn-primary btn-sm fs-toolbar-btn"
                  title="Carica file dal computer nell'archivio generale"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={loading}
                >
                  <UploadCloud size={15} aria-hidden="true" />
                  Carica File
                </button>
              </>
            )
          )}
        </div>
      </div>

      {error && (
        <div
          id="fs-general-error"
          className="fs-error-banner"
          role="alert"
        >
          {error.userMessage}
        </div>
      )}

      <FsTable
        entries={entries}
        tbodyId="fs-general-table-body"
        emptyMessage={emptyMessage}
        emptyHint={emptyHint}
        loading={loading}
        isAdmin={isAdmin}
        readOnlyMode={isViewingDeletedRobot}
        onNavigateDir={onNavigateDir}
        onOpenRobot={onOpenRobot}
        onOpenDeletedRobot={onOpenDeletedRobot}
        onDeleteDeletedRobot={onDeleteDeletedRobot}
        onDownload={onDownload}
        onDelete={onDelete}
        onDeleteFolder={onDeleteFolder}
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
