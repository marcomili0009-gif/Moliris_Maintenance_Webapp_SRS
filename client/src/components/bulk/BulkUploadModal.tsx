import React, { useState, useEffect, useMemo } from "react";
import type { RobotSummaryDto } from "../../types/fleet.ts";
import type { BulkConflict, BulkUploadTargetResult } from "../../types/transfer.ts";
import type { FormattedError } from "../../types/error.ts";
import { DoubleSubmitButton } from "../common/DoubleSubmitButton.tsx";
import { FolderPickerModal } from "../common/FolderPickerModal.tsx";
import { apiClient } from "../../services/api-client.ts";
import { ErrorPresenter } from "../../services/error-presenter.ts";

export type BulkSourceType = "computer" | "general" | "server_robot" | "remote_robot";
export type BulkDestType = "general" | "server_robots" | "remote_robots";

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

interface ServerSourceFile {
  name: string;
  path: string;
  size?: number;
}

export const BulkUploadModal: React.FC<BulkUploadModalProps> = ({
  isOpen,
  onClose,
  robots,
  onPreCheck,
  onExecuteUpload,
  onConflictsDetected,
}) => {
  // Wizard steps: 1 = Sorgente, 2 = Destinazione, 3 = Destinatari, 4 = Cartelle, 5 = Riepilogo
  const [step, setStep] = useState<number>(1);

  // Passo 1: Sorgente
  const [sourceType, setSourceType] = useState<BulkSourceType>("computer");
  const [computerFiles, setComputerFiles] = useState<File[]>([]);
  const [sourceRobotId, setSourceRobotId] = useState<string>("");
  const [sourceAvailableFiles, setSourceAvailableFiles] = useState<ServerSourceFile[]>([]);
  const [selectedServerFiles, setSelectedServerFiles] = useState<string[]>([]);
  const [loadingSourceFiles, setLoadingSourceFiles] = useState<boolean>(false);
  const [sourceDirCurrent, setSourceDirCurrent] = useState<string>("/");

  // Passo 2: Tipo destinazione
  const [destType, setDestType] = useState<BulkDestType>("remote_robots");

  // Passo 3: Destinatari e filtri
  const [robotSearchFilter, setRobotSearchFilter] = useState<string>("");
  const [selectedTargetRobotIds, setSelectedTargetRobotIds] = useState<string[]>([]);

  // Passo 4: Cartella di destinazione
  const [commonDirectory, setCommonDirectory] = useState<string>("/upload");
  const [individualDirectories, setIndividualDirectories] = useState<Record<string, string>>({});
  const [isFolderPickerOpen, setIsFolderPickerOpen] = useState<boolean>(false);
  const [folderPickerTargetRobotId, setFolderPickerTargetRobotId] = useState<string | undefined>(undefined);

  // Passo 5: Opzioni trasferimento & Esecuzione
  const [isMove, setIsMove] = useState<boolean>(false);
  const [moveConfirmation, setMoveConfirmation] = useState<boolean>(false);
  const [overwrite, setOverwrite] = useState<boolean>(false);

  const [progress, setProgress] = useState<number>(0);
  const [isTransferring, setIsTransferring] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<BulkUploadTargetResult[] | null>(null);
  const [robotToRobotSummary, setRobotToRobotSummary] = useState<any | null>(null);

  // Reset all'apertura
  useEffect(() => {
    if (isOpen) {
      setStep(1);
      setSourceType("computer");
      setComputerFiles([]);
      setSourceRobotId(robots[0]?.id || "");
      setSelectedServerFiles([]);
      setSourceAvailableFiles([]);
      setDestType("remote_robots");
      setRobotSearchFilter("");
      setSelectedTargetRobotIds([]);
      setCommonDirectory("/upload");
      setIndividualDirectories({});
      setIsMove(false);
      setMoveConfirmation(false);
      setOverwrite(false);
      setProgress(0);
      setIsTransferring(false);
      setError(null);
      setResults(null);
      setRobotToRobotSummary(null);
    }
  }, [isOpen, robots]);

  // Caricamento file per sorgenti server o robot
  useEffect(() => {
    if (!isOpen || sourceType === "computer") return;

    const loadFiles = async () => {
      setLoadingSourceFiles(true);
      setError(null);
      try {
        let endpoint = "";
        if (sourceType === "general") {
          endpoint = `/api/fs/general/list?path=${encodeURIComponent(sourceDirCurrent)}`;
        } else if (sourceType === "server_robot") {
          if (!sourceRobotId) return;
          endpoint = `/api/robots/${encodeURIComponent(sourceRobotId)}/fs/server/list?path=${encodeURIComponent(sourceDirCurrent)}`;
        } else if (sourceType === "remote_robot") {
          if (!sourceRobotId) return;
          endpoint = `/api/robots/${encodeURIComponent(sourceRobotId)}/fs/remote/list?path=${encodeURIComponent(sourceDirCurrent)}`;
        }

        const res = await apiClient.get(endpoint);
        const data = await res.json();
        if (res.ok) {
          const rawEntries: any[] = Array.isArray(data.entries) ? data.entries : (data.items || []);
          const files: ServerSourceFile[] = rawEntries
            .filter((e) => e.type === "file")
            .map((e) => ({
              name: e.name,
              path: sourceDirCurrent.endsWith("/") ? `${sourceDirCurrent}${e.name}` : `${sourceDirCurrent}/${e.name}`,
              size: e.size,
            }));
          setSourceAvailableFiles(files);
        } else {
          setSourceAvailableFiles([]);
          setError(data.message || "Impossibile caricare i file della sorgente.");
        }
      } catch (err: any) {
        setSourceAvailableFiles([]);
        setError(err?.message || "Errore durante il caricamento dei file della sorgente.");
      } finally {
        setLoadingSourceFiles(false);
      }
    };

    loadFiles();
  }, [isOpen, sourceType, sourceRobotId, sourceDirCurrent]);

  if (!isOpen) return null;

  // Filtro ricerca robot destinatari (§5: ID, nome, cliente, impianto)
  const filteredRobots = robots.filter((r) => {
    if (!robotSearchFilter.trim()) return true;
    const q = robotSearchFilter.toLowerCase();
    const matchId = r.id.toLowerCase().includes(q);
    const matchName = (r.displayName || "").toLowerCase().includes(q);
    const matchCustomer = (r.customerName || "").toLowerCase().includes(q);
    const matchPlant = (r.plantName || "").toLowerCase().includes(q);
    return matchId || matchName || matchCustomer || matchPlant;
  });

  // Validazione prima di avanzare di passo
  const canProceedFromStep1 =
    sourceType === "computer"
      ? computerFiles.length > 0
      : selectedServerFiles.length > 0;

  const canProceedFromStep3 =
    destType === "general"
      ? true
      : selectedTargetRobotIds.length > 0;

  const handleNext = () => {
    setError(null);
    if (step === 1 && !canProceedFromStep1) {
      setError("Selezionare almeno un file sorgente per continuare.");
      return;
    }
    if (step === 3 && !canProceedFromStep3) {
      setError("Selezionare almeno un robot destinatario per continuare.");
      return;
    }
    setStep((s) => s + 1);
  };

  const handlePrev = () => {
    setError(null);
    setStep((s) => Math.max(1, s - 1));
  };

  const handleToggleTargetRobot = (id: string) => {
    setSelectedTargetRobotIds((prev) =>
      prev.includes(id) ? prev.filter((rId) => rId !== id) : [...prev, id]
    );
  };

  const handleSelectAllFilteredRobots = () => {
    const ids = filteredRobots.map((r) => r.id);
    setSelectedTargetRobotIds((prev) => Array.from(new Set([...prev, ...ids])));
  };

  const handleDeselectAllRobots = () => {
    setSelectedTargetRobotIds([]);
  };

  // Esecuzione del trasferimento finale
  const handleExecute = async () => {
    setError(null);
    setResults(null);
    setRobotToRobotSummary(null);
    setIsTransferring(true);
    setProgress(15);

    try {
      // Flusso A: File dal computer
      if (sourceType === "computer") {
        const destinations = {
          server:
            destType === "server_robots" && selectedTargetRobotIds.length > 0
              ? { robotId: selectedTargetRobotIds[0], subPath: commonDirectory }
              : undefined,
          robots:
            destType === "remote_robots"
              ? selectedTargetRobotIds.map((id) => ({
                  robotId: id,
                  remotePath: individualDirectories[id] || commonDirectory,
                }))
              : undefined,
        };

        const filenames = computerFiles.map((f) => f.name);

        if (!overwrite) {
          const preCheck = await onPreCheck(filenames, destinations);
          if (preCheck.hasConflicts) {
            setIsTransferring(false);
            onConflictsDetected(preCheck.conflicts, computerFiles, destinations);
            return;
          }
        }

        const res = await onExecuteUpload(computerFiles, destinations, overwrite, (p) => setProgress(p));
        if (res.success && res.results) {
          setResults(res.results);
          setProgress(100);
        } else {
          setError(res.error?.userMessage || "Errore durante il caricamento massivo.");
        }
      }

      // Flusso B: File già sul server (Archivio Generale o Robot Server) (§5, §7)
      else if (sourceType === "general" || sourceType === "server_robot") {
        const targets = selectedTargetRobotIds.map((id) => ({
          robotId: id,
          type: (destType === "server_robots" ? "server" : "robot") as "server" | "robot",
          directory: individualDirectories[id] || commonDirectory,
        }));

        const res = await apiClient.post("/api/transfers/bulk/server-source", {
          sourceScope: sourceType === "general" ? "general" : "server",
          sourceRobotId: sourceType === "server_robot" ? sourceRobotId : undefined,
          sourcePaths: selectedServerFiles,
          targets,
          overwrite,
        });

        const data = await res.json();
        if (res.ok) {
          setResults(
            (data.results || []).map((r: any) => ({
              targetName: r.filename,
              targetType: destType,
              success: r.overallSuccess,
              transferredFiles: (r.targets || []).filter((t: any) => t.success).map((t: any) => t.target.robotId),
              failedFiles: (r.targets || []).filter((t: any) => !t.success).map((t: any) => t.target.robotId),
            }))
          );
          setProgress(100);
        } else {
          setError(data.message || "Errore durante il trasferimento dei file dal server.");
        }
      }

      // Flusso C: Copia / Spostamento Robot -> Robot (§6)
      else if (sourceType === "remote_robot") {
        for (const filePath of selectedServerFiles) {
          const res = await apiClient.post("/api/transfers/robot-robot", {
            sourceRobotId,
            sourceRemotePath: filePath,
            targetRobotIds: selectedTargetRobotIds,
            targetRemotePaths: individualDirectories,
            commonTargetDirectory: commonDirectory,
            isMove,
            confirmation: moveConfirmation,
            overwrite,
          });

          const data = await res.json();
          if (res.ok) {
            setRobotToRobotSummary(data);
            setProgress(100);
          } else {
            setError(data.message || "Errore durante il trasferimento da robot a robot.");
            break;
          }
        }
      }
    } catch (err: any) {
      setError(err?.message || "Errore di connessione o operazione fallita.");
    } finally {
      setIsTransferring(false);
    }
  };

  return (
    <div id="modal-bulk-upload" className="modal" role="dialog" aria-modal="true">
      <div className="modal-content modal-large">
        <div className="modal-header">
          <div className="d-flex align-items-center gap-2">
            <h3 className="h5 fw-bold mb-0">Caricamento Massivo</h3>
            <span className="badge bg-primary">Passo {step} di 5</span>
          </div>
          <button
            type="button"
            className="btn-close"
            id="btn-close-bulk-upload"
            onClick={onClose}
            aria-label="Chiudi"
          />
        </div>

        <div className="modal-body" style={{ maxHeight: "70vh", overflowY: "auto" }}>
          {/* Progress stepper */}
          <div className="d-flex justify-content-between mb-3 border-bottom pb-2 text-center small text-secondary">
            <span className={step === 1 ? "fw-bold text-primary" : ""}>1. Sorgente</span>
            <span>&rarr;</span>
            <span className={step === 2 ? "fw-bold text-primary" : ""}>2. Destinazione</span>
            <span>&rarr;</span>
            <span className={step === 3 ? "fw-bold text-primary" : ""}>3. Destinatari</span>
            <span>&rarr;</span>
            <span className={step === 4 ? "fw-bold text-primary" : ""}>4. Cartelle</span>
            <span>&rarr;</span>
            <span className={step === 5 ? "fw-bold text-primary" : ""}>5. Riepilogo</span>
          </div>

          {/* ============================================================ */}
          {/* PASSO 1: Selezione Sorgente e File */}
          {/* ============================================================ */}
          {step === 1 && (
            <div>
              <h4 className="h6 fw-bold mb-2">1. Seleziona la Sorgente dei File:</h4>
              <div className="d-flex gap-2 mb-3 flex-wrap">
                <button
                  type="button"
                  className={`btn btn-sm ${sourceType === "computer" ? "btn-primary" : "btn-outline-secondary"}`}
                  onClick={() => setSourceType("computer")}
                >
                  File dal Computer
                </button>
                <button
                  type="button"
                  className={`btn btn-sm ${sourceType === "general" ? "btn-primary" : "btn-outline-secondary"}`}
                  onClick={() => setSourceType("general")}
                >
                  Archivio Generale Server
                </button>
                <button
                  type="button"
                  className={`btn btn-sm ${sourceType === "server_robot" ? "btn-primary" : "btn-outline-secondary"}`}
                  onClick={() => setSourceType("server_robot")}
                >
                  Archivio Server Robot
                </button>
                <button
                  type="button"
                  className={`btn btn-sm ${sourceType === "remote_robot" ? "btn-primary" : "btn-outline-secondary"}`}
                  onClick={() => setSourceType("remote_robot")}
                >
                  Robot Remoto (Robot &rarr; Robot)
                </button>
              </div>

              {sourceType === "computer" && (
                <div className="p-3 bg-light border rounded mb-3">
                  <label htmlFor="bulk-files-input" className="form-label fw-semibold">
                    Carica file dal tuo computer:
                  </label>
                  <input
                    type="file"
                    id="bulk-files-input"
                    multiple
                    className="form-control"
                    onChange={(e) => {
                      if (e.target.files) setComputerFiles(Array.from(e.target.files));
                    }}
                  />
                  <div className="small text-secondary mt-1">
                    {computerFiles.length === 0
                      ? "Nessun file selezionato."
                      : `${computerFiles.length} file selezionati:`}
                  </div>
                  {computerFiles.length > 0 && (
                    <ul className="small mt-1 mb-0 ps-3" style={{ maxHeight: "100px", overflowY: "auto" }}>
                      {computerFiles.map((f, i) => (
                        <li key={i}>{f.name} ({Math.round(f.size / 1024)} KB)</li>
                      ))}
                    </ul>
                  )}
                </div>
              )}

              {sourceType !== "computer" && (
                <div className="p-3 bg-light border rounded mb-3">
                  {sourceType !== "general" && (
                    <div className="mb-2">
                      <label className="form-label small fw-semibold">Seleziona Robot Sorgente:</label>
                      <select
                        className="form-select form-select-sm"
                        value={sourceRobotId}
                        onChange={(e) => setSourceRobotId(e.target.value)}
                      >
                        {robots.map((r) => (
                          <option key={r.id} value={r.id}>
                            {r.displayName} ({r.id})
                          </option>
                        ))}
                      </select>
                    </div>
                  )}

                  <div className="fw-semibold small mb-1">
                    File disponibili nella sorgente ({sourceDirCurrent}):
                  </div>
                  {loadingSourceFiles ? (
                    <div className="text-secondary small p-2">Caricamento file sorgente...</div>
                  ) : sourceAvailableFiles.length === 0 ? (
                    <div className="text-secondary small p-2">Nessun file presente nella directory sorgente.</div>
                  ) : (
                    <div className="border rounded bg-white p-2" style={{ maxHeight: "150px", overflowY: "auto" }}>
                      {sourceAvailableFiles.map((f) => (
                        <label key={f.path} className="d-block small mb-1 cursor-pointer">
                          <input
                            type="checkbox"
                            className="me-2"
                            checked={selectedServerFiles.includes(f.path)}
                            onChange={() => {
                              setSelectedServerFiles((prev) =>
                                prev.includes(f.path) ? prev.filter((p) => p !== f.path) : [...prev, f.path]
                              );
                            }}
                          />
                          {f.name} {f.size !== undefined && `(${Math.round(f.size / 1024)} KB)`}
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* ============================================================ */}
          {/* PASSO 2: Tipo Destinazione */}
          {/* ============================================================ */}
          {step === 2 && (
            <div>
              <h4 className="h6 fw-bold mb-2">2. Scegli il Tipo di Destinazione:</h4>
              <div className="list-group mb-3">
                <label className={`list-group-item list-group-item-action d-flex align-items-center gap-3 ${destType === "remote_robots" ? "active" : ""}`}>
                  <input
                    type="radio"
                    name="destType"
                    checked={destType === "remote_robots"}
                    onChange={() => setDestType("remote_robots")}
                  />
                  <div>
                    <strong>Uno o più Robot Remoti (SFTP Diretto)</strong>
                    <div className="small opacity-75">
                      Invia i file direttamente nel filesystem operativo dei robot selezionati.
                    </div>
                  </div>
                </label>

                {sourceType !== "remote_robot" && (
                  <label className={`list-group-item list-group-item-action d-flex align-items-center gap-3 ${destType === "server_robots" ? "active" : ""}`}>
                    <input
                      type="radio"
                      name="destType"
                      checked={destType === "server_robots"}
                      onChange={() => setDestType("server_robots")}
                    />
                    <div>
                      <strong>Directory Server Associate ai Robot</strong>
                      <div className="small opacity-75">
                        Archivia i file sul server locale nelle cartelle dedicate a ciascun robot selezionato.
                      </div>
                    </div>
                  </label>
                )}

                {sourceType === "computer" && (
                  <label className={`list-group-item list-group-item-action d-flex align-items-center gap-3 ${destType === "general" ? "active" : ""}`}>
                    <input
                      type="radio"
                      name="destType"
                      checked={destType === "general"}
                      onChange={() => setDestType("general")}
                    />
                    <div>
                      <strong>Archivio Generale Server (/home/robots/general)</strong>
                      <div className="small opacity-75">
                        Archiviazione centrale condivisa non legata a singoli robot.
                      </div>
                    </div>
                  </label>
                )}
              </div>
            </div>
          )}

          {/* ============================================================ */}
          {/* PASSO 3: Selezione Robot Destinatari con Ricerca */}
          {/* ============================================================ */}
          {step === 3 && (
            <div>
              <h4 className="h6 fw-bold mb-2">3. Seleziona i Robot Destinatari:</h4>
              {destType === "general" ? (
                <div className="alert alert-info small mb-3">
                  Destinazione selezionata: <strong>Archivio Generale Server</strong> (non richiede selezione robot).
                </div>
              ) : (
                <>
                  <div className="d-flex gap-2 mb-2">
                    <input
                      type="text"
                      className="form-control form-control-sm"
                      placeholder="Filtra per ID, Nome, Cliente o Impianto..."
                      value={robotSearchFilter}
                      onChange={(e) => setRobotSearchFilter(e.target.value)}
                    />
                    <button
                      type="button"
                      className="btn btn-outline-secondary btn-sm"
                      onClick={handleSelectAllFilteredRobots}
                    >
                      Seleziona tutti
                    </button>
                    <button
                      type="button"
                      className="btn btn-outline-secondary btn-sm"
                      onClick={handleDeselectAllRobots}
                    >
                      Deseleziona
                    </button>
                  </div>

                  <div className="border rounded p-2 mb-3 bg-light" style={{ maxHeight: "200px", overflowY: "auto" }}>
                    {filteredRobots.length === 0 ? (
                      <div className="text-secondary small p-2">Nessun robot corrispondente al filtro.</div>
                    ) : (
                      filteredRobots.map((r) => (
                        <label key={r.id} className="d-flex align-items-center justify-content-between small py-1 px-2 border-bottom bg-white mb-1 rounded cursor-pointer">
                          <div className="d-flex align-items-center gap-2">
                            <input
                              type="checkbox"
                              checked={selectedTargetRobotIds.includes(r.id)}
                              onChange={() => handleToggleTargetRobot(r.id)}
                            />
                            <strong>{r.displayName}</strong>
                            <code className="text-muted">{r.id}</code>
                          </div>
                          <div className="text-secondary small">
                            {r.customerName && <span className="me-2">{r.customerName}</span>}
                            {r.plantName && <span className="me-2 text-muted">[{r.plantName}]</span>}
                            <span className="badge bg-light text-dark border">{r.connectionState}</span>
                          </div>
                        </label>
                      ))
                    )}
                  </div>
                  <div className="small text-secondary">
                    {selectedTargetRobotIds.length} robot selezionati come destinatari.
                  </div>
                </>
              )}
            </div>
          )}

          {/* ============================================================ */}
          {/* PASSO 4: Cartella di Destinazione & Selettore Modale (§8) */}
          {/* ============================================================ */}
          {step === 4 && (
            <div>
              <h4 className="h6 fw-bold mb-2">4. Scegli le Cartelle di Destinazione:</h4>
              <div className="p-3 bg-light border rounded mb-3">
                <div className="mb-3">
                  <label className="form-label small fw-semibold">Cartella comune per tutti i destinatari:</label>
                  <div className="d-flex gap-2">
                    <input
                      type="text"
                      className="form-control form-control-sm font-monospace"
                      value={commonDirectory}
                      onChange={(e) => setCommonDirectory(e.target.value)}
                    />
                    <button
                      type="button"
                      id="btn-open-folder-picker"
                      className="btn btn-outline-primary btn-sm"
                      onClick={() => {
                        setFolderPickerTargetRobotId(selectedTargetRobotIds[0]);
                        setIsFolderPickerOpen(true);
                      }}
                    >
                      Scegli Cartella...
                    </button>
                  </div>
                </div>

                {selectedTargetRobotIds.length > 1 && (
                  <div className="mt-3">
                    <div className="small fw-semibold mb-2">Oppure personalizza per singolo robot:</div>
                    <div style={{ maxHeight: "140px", overflowY: "auto" }}>
                      {selectedTargetRobotIds.map((rId) => {
                        const robot = robots.find((r) => r.id === rId);
                        return (
                          <div key={rId} className="d-flex align-items-center gap-2 mb-1 small">
                            <span style={{ width: "160px" }} className="text-truncate">
                              {robot?.displayName || rId}:
                            </span>
                            <input
                              type="text"
                              className="form-control form-control-sm font-monospace py-0"
                              value={individualDirectories[rId] || commonDirectory}
                              onChange={(e) => {
                                const val = e.target.value;
                                setIndividualDirectories((prev) => ({ ...prev, [rId]: val }));
                              }}
                            />
                            <button
                              type="button"
                              className="btn btn-outline-secondary btn-sm py-0"
                              onClick={() => {
                                setFolderPickerTargetRobotId(rId);
                                setIsFolderPickerOpen(true);
                              }}
                            >
                              Sfoglia
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ============================================================ */}
          {/* PASSO 5: Riepilogo, Opzioni & Esecuzione (§6 Copia/Sposta) */}
          {/* ============================================================ */}
          {step === 5 && (
            <div>
              <h4 className="h6 fw-bold mb-2">5. Riepilogo ed Esecuzione:</h4>
              <div className="p-3 bg-light border rounded mb-3 small">
                <div className="row mb-2">
                  <div className="col-4 text-secondary">Sorgente:</div>
                  <div className="col-8 fw-semibold">
                    {sourceType === "computer" && "File dal Computer"}
                    {sourceType === "general" && "Archivio Generale Server"}
                    {sourceType === "server_robot" && `Archivio Server Robot (${sourceRobotId})`}
                    {sourceType === "remote_robot" && `Robot Remoto (${sourceRobotId})`}
                  </div>
                </div>
                <div className="row mb-2">
                  <div className="col-4 text-secondary">File da trasferire:</div>
                  <div className="col-8">
                    {sourceType === "computer"
                      ? `${computerFiles.length} file selezionati (${computerFiles.map((f) => f.name).join(", ")})`
                      : `${selectedServerFiles.length} file selezionati`}
                  </div>
                </div>
                <div className="row mb-2">
                  <div className="col-4 text-secondary">Destinatari:</div>
                  <div className="col-8">
                    {destType === "general"
                      ? "Archivio Generale Server"
                      : `${selectedTargetRobotIds.length} robot selezionati`}
                  </div>
                </div>
                <div className="row mb-2">
                  <div className="col-4 text-secondary">Cartella comune:</div>
                  <div className="col-8 font-monospace">{commonDirectory}</div>
                </div>

                {/* Opzioni avanzate */}
                <hr className="my-2" />
                {sourceType === "remote_robot" && (
                  <div className="mb-2">
                    <div className="fw-semibold mb-1">Modalità Operazione:</div>
                    <div className="d-flex gap-3 mb-2">
                      <label className="cursor-pointer">
                        <input
                          type="radio"
                          name="moveCopy"
                          checked={!isMove}
                          onChange={() => setIsMove(false)}
                          className="me-1"
                        />
                        Copia (preserva file sorgente)
                      </label>
                      <label className="cursor-pointer text-danger fw-semibold">
                        <input
                          type="radio"
                          name="moveCopy"
                          checked={isMove}
                          onChange={() => setIsMove(true)}
                          className="me-1"
                        />
                        Sposta (elimina sorgente dopo verifica)
                      </label>
                    </div>

                    {isMove && (
                      <div className="alert alert-warning p-2 small">
                        <label className="d-flex align-items-center gap-2 cursor-pointer mb-0">
                          <input
                            type="checkbox"
                            checked={moveConfirmation}
                            onChange={(e) => setMoveConfirmation(e.target.checked)}
                          />
                          <span>
                            Confermo la rimozione del file sorgente solo dopo l'avvenuta verifica di integrità su tutti i destinatari (§6).
                          </span>
                        </label>
                      </div>
                    )}
                  </div>
                )}

                <div className="form-check">
                  <input
                    type="checkbox"
                    className="form-check-input"
                    id="bulk-overwrite-check"
                    checked={overwrite}
                    onChange={(e) => setOverwrite(e.target.checked)}
                  />
                  <label htmlFor="bulk-overwrite-check" className="form-check-label">
                    Sovrascrivi se già esistente sulla destinazione
                  </label>
                </div>
              </div>

              {/* Barra di avanzamento */}
              {isTransferring && (
                <div className="p-3 bg-light border rounded mb-3">
                  <div className="d-flex justify-content-between small mb-1">
                    <span>Trasferimento in corso...</span>
                    <span>{progress}%</span>
                  </div>
                  <div className="progress" style={{ height: "10px" }}>
                    <div
                      className="progress-bar progress-bar-striped progress-bar-animated bg-primary"
                      style={{ width: `${progress}%` }}
                    />
                  </div>
                </div>
              )}

              {/* Risultati */}
              {results && (
                <div className="border rounded p-3 mb-3 bg-white">
                  <h5 className="h6 fw-bold mb-2">Esito Trasferimento:</h5>
                  {results.map((res, i) => (
                    <div key={i} className="small mb-1">
                      <span className={res.success ? "badge bg-success me-1" : "badge bg-danger me-1"}>
                        {res.success ? "Riuscito" : "Fallito"}
                      </span>
                      <strong>{res.targetName}</strong>: {res.transferredFiles.length} file completati
                      {res.failedFiles.length > 0 && ` (${res.failedFiles.length} errori)`}
                    </div>
                  ))}
                </div>
              )}

              {robotToRobotSummary && (
                <div className="border rounded p-3 mb-3 bg-white small">
                  <h5 className="h6 fw-bold mb-2">Esito Robot &rarr; Robot:</h5>
                  <div>
                    Stato:{" "}
                    <strong className={robotToRobotSummary.allTargetsSucceeded ? "text-success" : "text-danger"}>
                      {robotToRobotSummary.allTargetsSucceeded ? "Completato con successo" : "Completato parzialmente"}
                    </strong>
                  </div>
                  {robotToRobotSummary.isMove && (
                    <div>
                      Sorgente eliminata:{" "}
                      <strong>{robotToRobotSummary.sourceDeleted ? "Sì" : "No"}</strong>
                      {robotToRobotSummary.sourceDeleteError && (
                        <div className="text-danger small">{robotToRobotSummary.sourceDeleteError}</div>
                      )}
                    </div>
                  )}
                  <ul className="mt-2 mb-0 ps-3">
                    {robotToRobotSummary.results?.map((r: any) => (
                      <li key={r.robotId}>
                        Robot <code>{r.robotId}</code>:{" "}
                        <span className={r.success ? "text-success" : "text-danger"}>
                          {r.success ? "OK" : `Errore (${r.error})`}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          {/* Errore */}
          {error && (
            <div className="alert alert-danger p-2 small mb-3" role="alert">
              {error}
            </div>
          )}
        </div>

        {/* Footer con bottoni di navigazione */}
        <div className="modal-footer d-flex justify-content-between">
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={onClose}
          >
            Chiudi
          </button>

          <div className="d-flex gap-2">
            {step > 1 && (
              <button
                type="button"
                className="btn btn-outline-secondary btn-sm"
                onClick={handlePrev}
                disabled={isTransferring}
              >
                &larr; Indietro
              </button>
            )}

            {step < 5 ? (
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={handleNext}
              >
                Avanti &rarr;
              </button>
            ) : (
              <DoubleSubmitButton
                type="button"
                className="btn btn-primary btn-sm"
                id="btn-start-bulk-upload"
                onClick={handleExecute}
                disabled={isTransferring || (isMove && !moveConfirmation)}
                pendingText="Trasferimento in corso..."
              >
                Avvia Trasferimento Massivo
              </DoubleSubmitButton>
            )}
          </div>
        </div>
      </div>

      {/* Finestrella Selettore Cartelle (§8) */}
      <FolderPickerModal
        isOpen={isFolderPickerOpen}
        scope={destType === "general" ? "general" : destType === "server_robots" ? "server" : "remote"}
        robotId={folderPickerTargetRobotId}
        initialPath={commonDirectory}
        onClose={() => setIsFolderPickerOpen(false)}
        onSelectFolder={(selectedPath) => {
          if (folderPickerTargetRobotId) {
            setIndividualDirectories((prev) => ({
              ...prev,
              [folderPickerTargetRobotId]: selectedPath,
            }));
          }
          setCommonDirectory(selectedPath);
        }}
      />
    </div>
  );
};
