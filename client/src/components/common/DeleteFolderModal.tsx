import React, { useEffect, useState } from "react";
import { AlertTriangle, RefreshCw, Trash2 } from "lucide-react";
import { Modal } from "./Modal.tsx";
import { DoubleSubmitButton } from "./DoubleSubmitButton.tsx";
import { apiClient } from "../../services/api-client.ts";

export interface DeleteFolderTarget {
  folderName: string;
  folderPath: string;
  scope: "server" | "general" | "remote" | "deleted_robot";
  robotId?: string;
}

interface DeleteFolderModalProps {
  target: DeleteFolderTarget | null;
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (
    target: DeleteFolderTarget,
    recursive: boolean,
    expectedFileCount: number,
    expectedDirectoryCount: number
  ) => Promise<boolean | void>;
}

export const DeleteFolderModal: React.FC<DeleteFolderModalProps> = ({
  target,
  isOpen,
  onClose,
  onConfirm,
}) => {
  const [inspecting, setInspecting] = useState<boolean>(true);
  const [fileCount, setFileCount] = useState<number>(0);
  const [directoryCount, setDirectoryCount] = useState<number>(0);
  const [inspectError, setInspectError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen || !target) {
      setInspecting(true);
      setFileCount(0);
      setDirectoryCount(0);
      setInspectError(null);
      return;
    }

    let isMounted = true;
    const inspectFolder = async () => {
      setInspecting(true);
      setInspectError(null);
      setFileCount(0);
      setDirectoryCount(0);
      try {
        let endpoint = "";
        if (target.scope === "server" && target.robotId) {
          endpoint = `/api/robots/${encodeURIComponent(target.robotId)}/fs/server/folder/inspect?path=${encodeURIComponent(target.folderPath)}`;
        } else if (target.scope === "general") {
          endpoint = `/api/fs/general/folder/inspect?path=${encodeURIComponent(target.folderPath)}`;
        } else if (target.scope === "deleted_robot") {
          endpoint = `/api/fs/deleted-robots/${encodeURIComponent(target.folderName)}/inspect`;
        } else if (target.scope === "remote" && target.robotId) {
          endpoint = `/api/robots/${encodeURIComponent(target.robotId)}/fs/remote/folder/inspect?path=${encodeURIComponent(target.folderPath)}`;
        } else {
          throw new Error("Target della cartella non valido.");
        }

        const response = await apiClient.get(endpoint);
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(data.message || "Impossibile verificare il contenuto della cartella.");
        }
        if (isMounted) {
          setFileCount(Number(data.fileCount || 0));
          setDirectoryCount(Number(data.directoryCount ?? data.dirCount ?? 0));
        }
      } catch (error: any) {
        if (isMounted) {
          setInspectError(error?.message || "Impossibile verificare il contenuto della cartella.");
        }
      } finally {
        if (isMounted) setInspecting(false);
      }
    };

    void inspectFolder();
    return () => {
      isMounted = false;
    };
  }, [isOpen, target]);

  const totalCount = fileCount + directoryCount;
  const warningNote =
    totalCount > 0
      ? `Attenzione: la cartella non è vuota e contiene ${fileCount} file. Tutti gli elementi al suo interno verranno eliminati definitivamente.${
          directoryCount > 0 ? ` Sono presenti anche ${directoryCount} sottodirectory.` : ""
        }`
      : "La cartella è vuota. L'eliminazione è comunque irreversibile.";

  const handleConfirm = async () => {
    const result = await onConfirm(target!, totalCount > 0, fileCount, directoryCount);
    if (result !== false) onClose();
  };

  return (
    <Modal
      id="delete-folder-modal"
      isOpen={isOpen}
      onClose={onClose}
      title={
        target?.scope === "deleted_robot"
          ? "Eliminazione Definitiva Dati Robot Eliminato"
          : "Conferma Eliminazione Cartella"
      }
      role="alertdialog"
      ariaLabelledBy="delete-folder-modal-title"
      footer={
        <>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={onClose}
            disabled={inspecting}
          >
            Annulla
          </button>
          <DoubleSubmitButton
            type="button"
            className="btn btn-danger btn-sm"
            id="btn-confirm-delete-folder"
            onAsyncClick={handleConfirm}
            disabled={inspecting || Boolean(inspectError) || !target}
            pendingText="Eliminazione in corso..."
          >
            <Trash2 size={14} strokeWidth={2.2} aria-hidden="true" /> Elimina Definitivamente
          </DoubleSubmitButton>
        </>
      }
    >
      <p>
        Sei sicuro di voler eliminare definitivamente la cartella &apos;{target?.folderName}&apos;?
        {fileCount > 0
          ? ` Verranno eliminati in modo permanente anche ${fileCount} file contenuti al suo interno.`
          : " La cartella è vuota. L'eliminazione è irreversibile."}
      </p>

      {inspecting && (
        <div className="d-flex align-items-center gap-2 text-secondary" role="status">
          <RefreshCw size={15} className="spin" aria-hidden="true" />
          Verifica del contenuto in corso...
        </div>
      )}

      {!inspecting && !inspectError && (
        <div className="alert alert-warning d-flex align-items-start gap-2" role="alert">
          <AlertTriangle size={18} aria-hidden="true" />
          <div>
            <div>{warningNote}</div>
            <small className="d-block mt-1">File: {fileCount} · Sottodirectory: {directoryCount}</small>
          </div>
        </div>
      )}

      {!inspecting && inspectError && (
        <div className="alert alert-danger" role="alert">
          {inspectError} L'eliminazione è stata bloccata per evitare una rimozione non verificata.
        </div>
      )}
    </Modal>
  );
};
