import React, { useState, useEffect, useCallback, useMemo } from "react";
import { Modal } from "./Modal.tsx";
import { apiClient } from "../../services/api-client.ts";
import { ErrorPresenter } from "../../services/error-presenter.ts";
import type { FormattedError } from "../../types/error.ts";

export interface FolderPickerModalProps {
  isOpen: boolean;
  scope: "general" | "server" | "remote";
  robotId?: string;
  robotName?: string;
  initialPath?: string;
  title?: string;
  onClose: () => void;
  onSelectFolder: (selectedPath: string) => void;
  canCreateFolder?: boolean;
}

interface FolderItem {
  name: string;
  type: string;
}

export const FolderPickerModal: React.FC<FolderPickerModalProps> = ({
  isOpen,
  scope,
  robotId,
  robotName,
  initialPath = "/",
  title = "Seleziona Cartella di Destinazione",
  onClose,
  onSelectFolder,
  canCreateFolder = true,
}) => {
  const [currentPath, setCurrentPath] = useState<string>(initialPath || "/");
  const [folders, setFolders] = useState<FolderItem[]>([]);
  const [filterQuery, setFilterQuery] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<FormattedError | null>(null);

  // Creazione cartella inline
  const [isCreatingFolder, setIsCreatingFolder] = useState<boolean>(false);
  const [newFolderName, setNewFolderName] = useState<string>("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState<boolean>(false);

  const fetchDirectory = useCallback(async (path: string) => {
    setLoading(true);
    setError(null);
    try {
      let endpoint = "";
      if (scope === "general") {
        endpoint = `/api/fs/general/list?path=${encodeURIComponent(path)}`;
      } else if (scope === "server") {
        if (!robotId) throw new Error("Robot non specificato per archivio server.");
        endpoint = `/api/robots/${encodeURIComponent(robotId)}/fs/server/list?path=${encodeURIComponent(path)}`;
      } else {
        if (!robotId) throw new Error("Robot non specificato per filesystem remoto.");
        endpoint = `/api/robots/${encodeURIComponent(robotId)}/fs/remote/list?path=${encodeURIComponent(path)}`;
      }

      const res = await apiClient.get(endpoint);
      const data = await res.json();
      if (res.ok) {
        const rawEntries: any[] = Array.isArray(data.entries)
          ? data.entries
          : Array.isArray(data.items)
          ? data.items
          : [];
        const dirList: FolderItem[] = rawEntries
          .filter((e) => e.type === "directory")
          .map((e) => ({ name: e.name, type: "directory" }));
        setFolders(dirList);
        setCurrentPath(data.path || data.currentPath || path);
      } else {
        setError(ErrorPresenter.formatError(data));
        setFolders([]);
      }
    } catch (err) {
      setError(ErrorPresenter.formatError(err));
      setFolders([]);
    } finally {
      setLoading(false);
    }
  }, [scope, robotId]);

  useEffect(() => {
    if (isOpen) {
      const startPath = initialPath || "/";
      setCurrentPath(startPath);
      setFilterQuery("");
      setIsCreatingFolder(false);
      setNewFolderName("");
      setCreateError(null);
      fetchDirectory(startPath);
    }
  }, [isOpen, initialPath, fetchDirectory]);

  const handleNavigateSubfolder = (folderName: string) => {
    const nextPath = currentPath.endsWith("/")
      ? `${currentPath}${folderName}`
      : `${currentPath}/${folderName}`;
    setFilterQuery("");
    fetchDirectory(nextPath);
  };

  const handleNavigateUp = () => {
    if (currentPath === "/" || !currentPath) return;
    const parts = currentPath.split("/").filter(Boolean);
    parts.pop();
    const parent = parts.length > 0 ? `/${parts.join("/")}` : "/";
    setFilterQuery("");
    fetchDirectory(parent);
  };

  const handleCreateFolder = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = newFolderName.trim();
    if (!trimmed) {
      setCreateError("Il nome della cartella non può essere vuoto.");
      return;
    }
    if (/[/\\:\0*?"<>|]/.test(trimmed)) {
      setCreateError("Il nome contiene caratteri non validi (/ \\ : * ? \" < > |).");
      return;
    }

    setCreating(true);
    setCreateError(null);
    try {
      let res: Response;
      if (scope === "general") {
        res = await apiClient.post("/api/fs/general/mkdir", { name: trimmed, path: currentPath });
      } else if (scope === "server") {
        res = await apiClient.post(`/api/robots/${encodeURIComponent(robotId!)}/fs/server/mkdir`, {
          name: trimmed,
          path: currentPath,
        });
      } else {
        throw new Error("Creazione cartella remota non supportata da questo selettore.");
      }

      if (res.ok) {
        setIsCreatingFolder(false);
        setNewFolderName("");
        await fetchDirectory(currentPath);
      } else {
        const errData = await res.json().catch(() => ({}));
        setCreateError(errData.message || "Impossibile creare la cartella.");
      }
    } catch (err: any) {
      setCreateError(err?.message || "Errore di rete o autorizzazione insufficiente.");
    } finally {
      setCreating(false);
    }
  };

  const filteredFolders = useMemo(() => {
    if (!filterQuery.trim()) return folders;
    const q = filterQuery.toLowerCase();
    return folders.filter((f) => f.name.toLowerCase().includes(q));
  }, [folders, filterQuery]);

  const scopeLabel =
    scope === "general"
      ? "Archivio Generale Server"
      : scope === "server"
      ? `Archivio Server Robot (${robotName || robotId})`
      : `Filesystem Remoto SFTP (${robotName || robotId})`;

  if (!isOpen) return null;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={title}
      size="large"
      footer={
        <div className="d-flex justify-content-between align-items-center w-100 flex-wrap gap-2">
          <div className="small text-secondary text-truncate" style={{ maxWidth: "55%" }}>
            Selezionata: <strong className="text-dark font-monospace">{currentPath || "/"}</strong>
          </div>
          <div className="d-flex gap-2 ms-auto">
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={onClose}
            >
              Annulla
            </button>
            <button
              type="button"
              id="btn-confirm-select-folder"
              className="btn btn-primary btn-sm"
              onClick={() => {
                onSelectFolder(currentPath || "/");
                onClose();
              }}
              disabled={loading}
            >
              Seleziona questa cartella
            </button>
          </div>
        </div>
      }
    >
      <div className="folder-picker-container">
        {/* Intestazione ambito */}
        <div className="mb-2 p-2 bg-light border rounded small d-flex justify-content-between align-items-center flex-wrap gap-2">
          <div>
            <span className="text-secondary">Ambito destinazione:</span>{" "}
            <strong>{scopeLabel}</strong>
          </div>
          {canCreateFolder && scope !== "remote" && (
            <button
              type="button"
              className="btn btn-outline-primary btn-sm py-0"
              onClick={() => {
                setIsCreatingFolder(!isCreatingFolder);
                setCreateError(null);
                setNewFolderName("");
              }}
            >
              {isCreatingFolder ? "Annulla Nuova Cartella" : "+ Nuova Cartella"}
            </button>
          )}
        </div>

        {/* Form Creazione Cartella inline */}
        {isCreatingFolder && (
          <form onSubmit={handleCreateFolder} className="mb-3 p-2 bg-white border border-primary rounded">
            <div className="d-flex gap-2">
              <input
                type="text"
                className="form-control form-control-sm"
                placeholder="Nome nuova cartella"
                value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value)}
                autoFocus
                disabled={creating}
              />
              <button
                type="submit"
                className="btn btn-primary btn-sm"
                disabled={creating || !newFolderName.trim()}
              >
                {creating ? "Creazione..." : "Crea"}
              </button>
            </div>
            {createError && (
              <div className="text-danger small mt-1">{createError}</div>
            )}
          </form>
        )}

        {/* Barra di navigazione percorso corrente */}
        <div className="d-flex align-items-center gap-2 mb-2 p-2 bg-light border rounded">
          <button
            type="button"
            className="btn btn-outline-secondary btn-sm"
            onClick={handleNavigateUp}
            disabled={currentPath === "/" || !currentPath || loading}
            title="Torna alla cartella superiore"
          >
            Torna su
          </button>
          <div className="font-monospace small text-break flex-grow-1 px-2">
            {currentPath || "/"}
          </div>
        </div>

        {/* Filtro cartelle */}
        <div className="mb-2">
          <input
            type="text"
            className="form-control form-control-sm"
            placeholder="Filtra cartelle nella directory corrente..."
            value={filterQuery}
            onChange={(e) => setFilterQuery(e.target.value)}
            disabled={loading}
          />
        </div>

        {/* Error alert */}
        {error && (
          <div className="alert alert-danger p-2 small mb-2" role="alert">
            {error.userMessage}
          </div>
        )}

        {/* Lista cartelle */}
        <div
          className="folder-list-box border rounded p-1"
          style={{ minHeight: "220px", maxHeight: "300px", overflowY: "auto" }}
        >
          {loading ? (
            <div className="text-center p-4 text-secondary small">
              Caricamento cartelle in corso...
            </div>
          ) : filteredFolders.length === 0 ? (
            <div className="text-center p-4 text-secondary small">
              {filterQuery ? "Nessuna cartella corrisponde al filtro." : "Nessuna sottocartella presente."}
            </div>
          ) : (
            <div className="list-group list-group-flush">
              {filteredFolders.map((f) => (
                <button
                  key={f.name}
                  type="button"
                  className="list-group-item list-group-item-action d-flex align-items-center justify-content-between py-2 px-3"
                  onClick={() => handleNavigateSubfolder(f.name)}
                >
                  <div className="d-flex align-items-center gap-2">
                    <span className="text-primary fw-semibold">[Cartella]</span>
                    <span>{f.name}</span>
                  </div>
                  <span className="badge bg-light text-secondary border">Apri</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
};
