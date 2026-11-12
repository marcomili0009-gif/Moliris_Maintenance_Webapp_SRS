import React, { useState } from "react";
import type { RobotSummaryDto } from "../../types/fleet.ts";
import type { BulkConflict, BulkUploadTargetResult } from "../../types/transfer.ts";
import type { FormattedError } from "../../types/error.ts";
import { DoubleSubmitButton } from "../common/DoubleSubmitButton.tsx";

interface BulkUploadModalProps {
  isOpen: boolean;
  onClose: () => void;
  robots: RobotSummaryDto[];
  onPreCheck: (
    files: string[],
    destinations: {
      server?: { robotId: string; subPath: string };
      robots?: Array<{ robotId: string; remotePath: string }>;
    }
  ) => Promise<{ hasConflicts: boolean; conflicts: BulkConflict[]; error?: FormattedError }>;
  onExecuteUpload: (
    files: File[],
    destinations: {
      server?: { robotId: string; subPath: string };
      robots?: Array<{ robotId: string; remotePath: string }>;
    },
    overwrite?: boolean,
    onProgress?: (percentage: number) => void
  ) => Promise<{ success: boolean; results?: BulkUploadTargetResult[]; error?: FormattedError }>;
  onConflictsDetected: (
    conflicts: BulkConflict[],
    files: File[],
    destinations: {
      server?: { robotId: string; subPath: string };
      robots?: Array<{ robotId: string; remotePath: string }>;
    }
  ) => void;
}

export const BulkUploadModal: React.FC<BulkUploadModalProps> = ({
  isOpen,
  onClose,
  robots,
  onPreCheck,
  onExecuteUpload,
  onConflictsDetected,
}) => {
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [targetServerChecked, setTargetServerChecked] = useState<boolean>(false);
  const [targetServerRobotId, setTargetServerRobotId] = useState<string>("");
  const [targetServerSubPath, setTargetServerSubPath] = useState<string>("upload");
  const [selectedRobotIds, setSelectedRobotIds] = useState<string[]>([]);
  const [robotRemotePath, setRobotRemotePath] = useState<string>("/upload");

  const [progress, setProgress] = useState<number>(0);
  const [isUploading, setIsUploading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<BulkUploadTargetResult[] | null>(null);

  if (!isOpen) return null;

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      setSelectedFiles(Array.from(e.target.files));
    }
  };

  const handleRobotToggle = (robotId: string) => {
    setSelectedRobotIds((prev) =>
      prev.includes(robotId) ? prev.filter((id) => id !== robotId) : [...prev, robotId]
    );
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setResults(null);

    if (selectedFiles.length === 0) {
      setError("Selezionare almeno un file da caricare.");
      return;
    }
    if (!targetServerChecked && selectedRobotIds.length === 0) {
      setError("Selezionare almeno una destinazione (Server locale o uno o più Robot).");
      return;
    }
    if (targetServerChecked && !targetServerRobotId) {
      setError("Selezionare il robot da associare all'archivio server.");
      return;
    }

    const destinations = {
      server: targetServerChecked
        ? { robotId: targetServerRobotId, subPath: targetServerSubPath }
        : undefined,
      robots:
        selectedRobotIds.length > 0
          ? selectedRobotIds.map((id) => ({ robotId: id, remotePath: robotRemotePath }))
          : undefined,
    };

    const filenames = selectedFiles.map((f) => f.name);

    // Esegui pre-check dei conflitti
    const preCheck = await onPreCheck(filenames, destinations);
    if (preCheck.error) {
      setError(preCheck.error.userMessage);
      return;
    }

    if (preCheck.hasConflicts) {
      onConflictsDetected(preCheck.conflicts, selectedFiles, destinations);
      return;
    }

    // Nessun conflitto, procedi con l'upload
    setIsUploading(true);
    setProgress(10);
    const res = await onExecuteUpload(selectedFiles, destinations, false, (p) => setProgress(p));
    setIsUploading(false);

    if (res.success && res.results) {
      setResults(res.results);
    } else if (res.error) {
      setError(res.error.userMessage);
    }
  };

  return (
    <div id="modal-bulk-upload" className="modal" role="dialog" aria-modal="true">
      <div className="modal-content modal-large">
        <div className="modal-header">
          <h3>Caricamento Massivo</h3>
          <button
            type="button"
            className="btn-close"
            id="btn-close-bulk-upload"
            onClick={onClose}
          >
            &times;
          </button>
        </div>

        <div className="modal-body">
          <form id="form-bulk-upload" onSubmit={handleSubmit}>
            <div className="form-group">
              <label htmlFor="bulk-files-input">
                <strong>1. Seleziona uno o più file:</strong>
              </label>
              <input
                type="file"
                id="bulk-files-input"
                name="bulkFiles"
                multiple
                className="form-control"
                style={{ padding: "0.5rem", border: "1px dashed #cbd5e1", borderRadius: "6px", width: "100%" }}
                onChange={handleFileChange}
              />
              <small id="bulk-files-count" style={{ display: "block", marginTop: "0.25rem", color: "#64748b" }}>
                {selectedFiles.length === 0
                  ? "Nessun file selezionato (massimo configurato: 20 file)."
                  : `${selectedFiles.length} file selezionati.`}
              </small>
              <ul
                id="bulk-files-preview-list"
                style={{
                  maxHeight: "120px",
                  overflowY: "auto",
                  marginTop: "0.5rem",
                  paddingLeft: "1.25rem",
                  fontSize: "0.875rem",
                  color: "#334155",
                }}
              >
                {selectedFiles.map((f, i) => (
                  <li key={i}>{f.name} ({Math.round(f.size / 1024)} KB)</li>
                ))}
              </ul>
            </div>

            <div className="form-group" style={{ marginTop: "1rem" }}>
              <label>
                <strong>2. Seleziona le destinazioni di caricamento:</strong>
              </label>
              <div
                style={{
                  background: "#f8fafc",
                  border: "1px solid #e2e8f0",
                  borderRadius: "8px",
                  padding: "0.75rem",
                  marginTop: "0.5rem",
                }}
              >
                <div style={{ marginBottom: "0.75rem", paddingBottom: "0.5rem", borderBottom: "1px solid #e2e8f0" }}>
                  <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontWeight: 600, cursor: "pointer" }}>
                    <input
                      type="checkbox"
                      id="bulk-target-server-check"
                      checked={targetServerChecked}
                      onChange={(e) => setTargetServerChecked(e.target.checked)}
                    />{" "}
                    Server Locale (Archivio Dedicato Robot)
                  </label>
                  {targetServerChecked && (
                    <div id="bulk-server-config" style={{ marginTop: "0.5rem", marginLeft: "1.5rem" }}>
                      <label htmlFor="bulk-server-robot-select" style={{ fontSize: "0.85rem", marginRight: "0.5rem" }}>
                        Associa al Robot:
                      </label>
                      <select
                        id="bulk-server-robot-select"
                        value={targetServerRobotId}
                        onChange={(e) => setTargetServerRobotId(e.target.value)}
                        style={{ padding: "0.25rem 0.5rem", borderRadius: "4px", border: "1px solid #cbd5e1", marginRight: "0.5rem" }}
                      >
                        <option value="">Seleziona Robot...</option>
                        {robots.map((r) => (
                          <option key={r.id} value={r.id}>
                            {r.displayName} ({r.id})
                          </option>
                        ))}
                      </select>
                      <label htmlFor="bulk-server-subpath" style={{ fontSize: "0.85rem", marginRight: "0.5rem" }}>
                        Cartella destinazione:
                      </label>
                      <input
                        type="text"
                        id="bulk-server-subpath"
                        value={targetServerSubPath}
                        onChange={(e) => setTargetServerSubPath(e.target.value)}
                        placeholder="es. upload"
                        style={{ padding: "0.25rem 0.5rem", borderRadius: "4px", border: "1px solid #cbd5e1", width: "140px" }}
                      />
                    </div>
                  )}
                </div>

                <div>
                  <div style={{ fontWeight: 600, marginBottom: "0.25rem" }}>
                    Robot Remoti (SFTP Diretto):
                  </div>
                  <div
                    id="bulk-robots-checkboxes"
                    style={{ maxHeight: "140px", overflowY: "auto", paddingLeft: "0.5rem" }}
                  >
                    {robots.length === 0 ? (
                      <div style={{ color: "#64748b", fontSize: "0.85rem" }}>
                        Nessun robot attivo disponibile.
                      </div>
                    ) : (
                      robots.map((r) => (
                        <label
                          key={r.id}
                          style={{ display: "block", fontSize: "0.875rem", margin: "0.25rem 0", cursor: "pointer" }}
                        >
                          <input
                            type="checkbox"
                            checked={selectedRobotIds.includes(r.id)}
                            onChange={() => handleRobotToggle(r.id)}
                            style={{ marginRight: "0.5rem" }}
                          />
                          {r.displayName} (<code>{r.id}</code> - {r.connectionState})
                        </label>
                      ))
                    )}
                  </div>
                  <div style={{ marginTop: "0.5rem", marginLeft: "0.5rem" }}>
                    <label htmlFor="bulk-robot-remotepath" style={{ fontSize: "0.85rem", marginRight: "0.5rem" }}>
                      Cartella remota robot:
                    </label>
                    <input
                      type="text"
                      id="bulk-robot-remotepath"
                      value={robotRemotePath}
                      onChange={(e) => setRobotRemotePath(e.target.value)}
                      placeholder="es. /upload"
                      style={{ padding: "0.25rem 0.5rem", borderRadius: "4px", border: "1px solid #cbd5e1", width: "140px" }}
                    />
                  </div>
                </div>
              </div>
            </div>

            {isUploading && (
              <div
                id="bulk-progress-container"
                style={{ marginTop: "1rem", background: "#f1f5f9", padding: "0.75rem", borderRadius: "8px" }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.875rem", marginBottom: "0.25rem" }}>
                  <span id="bulk-progress-status">Caricamento in corso...</span>
                  <span id="bulk-progress-text">{progress}%</span>
                </div>
                <progress
                  id="bulk-progress-bar"
                  value={progress}
                  max={100}
                  style={{ width: "100%", height: "12px" }}
                />
              </div>
            )}

            {results && (
              <div
                id="bulk-results-container"
                style={{ marginTop: "1rem", maxHeight: "160px", overflowY: "auto", border: "1px solid #e2e8f0", borderRadius: "6px", padding: "0.5rem" }}
              >
                <h4 style={{ fontSize: "0.9rem", fontWeight: 600, marginBottom: "0.5rem" }}>
                  Riepilogo Caricamento:
                </h4>
                {results.map((res, i) => (
                  <div key={i} style={{ fontSize: "0.85rem", marginBottom: "0.25rem" }}>
                    <span className={res.success ? "badge bg-success me-1" : "badge bg-danger me-1"}>
                      {res.success ? "OK" : "KO"}
                    </span>{" "}
                    <strong>{res.targetName} ({res.targetType})</strong>:{" "}
                    {res.transferredFiles.length} file trasferiti con successo
                    {res.failedFiles.length > 0 && ` (${res.failedFiles.length} falliti)`}
                  </div>
                ))}
              </div>
            )}

            <div
              id="bulk-upload-error"
              className={`error-message ${error ? "" : "hidden"}`}
              style={{ marginTop: "0.75rem" }}
            >
              {error}
            </div>

            <div className="modal-footer" style={{ marginTop: "1rem" }}>
              <button
                type="button"
                className="btn btn-secondary"
                id="btn-cancel-bulk-upload"
                onClick={onClose}
              >
                Chiudi
              </button>
              <DoubleSubmitButton
                type="submit"
                className="btn btn-primary"
                id="btn-start-bulk-upload"
                pendingText="Caricamento..."
              >
                Avvia Caricamento Massivo
              </DoubleSubmitButton>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
};
