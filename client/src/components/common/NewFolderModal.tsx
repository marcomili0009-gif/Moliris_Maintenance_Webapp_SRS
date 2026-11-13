import React, { useState, useEffect } from "react";
import { Modal } from "./Modal.tsx";

interface NewFolderModalProps {
  isOpen: boolean;
  currentPath: string;
  onClose: () => void;
  onCreate: (folderName: string) => Promise<{ success: boolean; error?: string }>;
}

export const NewFolderModal: React.FC<NewFolderModalProps> = ({
  isOpen,
  currentPath,
  onClose,
  onCreate,
}) => {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setName("");
      setError(null);
      setLoading(false);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const validateName = (val: string): string | null => {
    const trimmed = val.trim();
    if (!trimmed) {
      return "Il nome della cartella non può essere vuoto.";
    }
    if (trimmed.length > 255) {
      return "Il nome della cartella non può superare i 255 caratteri.";
    }
    if (trimmed === "." || trimmed === "..") {
      return "Nome cartella non valido.";
    }
    if (/[/\\:\0*?"<>|]/.test(trimmed)) {
      return "Il nome contiene caratteri non validi (/ \\ : * ? \" < > |).";
    }
    return null;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const validationErr = validateName(name);
    if (validationErr) {
      setError(validationErr);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const res = await onCreate(name.trim());
      if (res.success) {
        onClose();
      } else {
        setError(res.error || "Impossibile creare la cartella.");
      }
    } catch (err: any) {
      setError(err?.message || "Errore imprevisto durante la creazione della cartella.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Nuova Cartella"
      footer={
        <div className="d-flex justify-content-end gap-2 w-100">
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={onClose}
            disabled={loading}
          >
            Annulla
          </button>
          <button
            type="button"
            id="btn-confirm-mkdir"
            className="btn btn-primary btn-sm"
            onClick={handleSubmit}
            disabled={loading || !name.trim()}
          >
            {loading ? "Creazione in corso..." : "Crea Cartella"}
          </button>
        </div>
      }
    >
      <form onSubmit={handleSubmit}>
        <div className="mb-3">
          <label className="form-label text-secondary small mb-1">
            Percorso di destinazione:
          </label>
          <div className="p-2 bg-light border rounded small font-monospace text-break">
            {currentPath || "/"}
          </div>
        </div>

        <div className="mb-3">
          <label htmlFor="input-folder-name" className="form-label fw-semibold">
            Nome nuova cartella <span className="text-danger">*</span>
          </label>
          <input
            type="text"
            id="input-folder-name"
            className={`form-control ${error ? "is-invalid" : ""}`}
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              if (error) setError(null);
            }}
            placeholder="es. aggiornamenti_2026"
            autoFocus
            disabled={loading}
          />
          {error && <div className="invalid-feedback d-block mt-1">{error}</div>}
        </div>
      </form>
    </Modal>
  );
};
