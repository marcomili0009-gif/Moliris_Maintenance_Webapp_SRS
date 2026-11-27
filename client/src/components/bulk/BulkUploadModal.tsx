import React, { useState, useEffect, useMemo, useRef } from "react";
import { Trash2 } from "lucide-react";
import type { RobotSummaryDto } from "../../types/fleet.ts";
import {
  buildBulkTargets,
  hasBulkSourceSelection,
  type BulkConflict,
  type BulkDestinations,
  type BulkUploadTargetResult,
} from "../../types/transfer.ts";
import type { FormattedError } from "../../types/error.ts";
import { DoubleSubmitButton } from "../common/DoubleSubmitButton.tsx";
import { FolderPickerModal } from "../common/FolderPickerModal.tsx";
import { apiClient } from "../../services/api-client.ts";
import { fetchPublicConfig } from "../../services/public-config.ts";
import { ErrorPresenter } from "../../services/error-presenter.ts";

function formatByteLimit(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) {
    const gb = bytes / (1024 * 1024 * 1024);
    return `${Number.isInteger(gb) ? gb : gb.toFixed(1)} GB`;
  }
  if (bytes >= 1024 * 1024) {
    const mb = bytes / (1024 * 1024);
    return `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB`;
  }
  return `${Math.round(bytes / 1024)} KB`;
}
import { isPathAllowedForOperator } from "../../utils/path-authorization.ts";

export type BulkSourceType = "computer" | "general" | "server_robot" | "remote_robot";
export type BulkDestType = "general" | "server_robots" | "remote_robots";
type RobotFolderScope = "server" | "remote";

interface BulkUploadModalProps {
  isOpen: boolean;
  onClose: () => void;
  robots: RobotSummaryDto[];
  isOperator?: boolean;
  allowedPaths?: string[];
  onPreCheck: (
    files: string[],
    destinations: BulkDestinations
  ) => Promise<{ hasConflicts: boolean; conflicts: BulkConflict[]; error?: FormattedError }>;
  onExecuteUpload: (
    files: File[],
    destinations: BulkDestinations,
    overwrite?: boolean,
    onProgress?: (percentage: number) => void
  ) => Promise<{ success: boolean; results?: BulkUploadTargetResult[]; error?: FormattedError }>;
  onConflictsDetected: (
    conflicts: BulkConflict[],
    files: File[],
    destinations: BulkDestinations
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
  isOperator = false,
  allowedPaths,
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
  const [sourceAvailableDirs, setSourceAvailableDirs] = useState<ServerSourceFile[]>([]);
  const [sourceAvailableFiles, setSourceAvailableFiles] = useState<ServerSourceFile[]>([]);
  const [selectedServerFiles, setSelectedServerFiles] = useState<string[]>([]);
  const [loadingSourceFiles, setLoadingSourceFiles] = useState<boolean>(false);
  const [sourceDirCurrent, setSourceDirCurrent] = useState<string>("/");
  const [sourceDirDisplay, setSourceDirDisplay] = useState<string>("/");

  // Passo 2: Tipo destinazione (ISS-010: selezione multipla combinabile)
  const [selectedDestTypes, setSelectedDestTypes] = useState<BulkDestType[]>(["remote_robots"]);
  const hasRemoteDest = selectedDestTypes.includes("remote_robots");
  const hasServerRobotDest = selectedDestTypes.includes("server_robots");
  const hasGeneralDest = selectedDestTypes.includes("general");
  const robotFolderScopes = (["server", "remote"] as const).filter((scope) =>
    scope === "server" ? hasServerRobotDest : hasRemoteDest
  );
  const requiresRobotSelection = robotFolderScopes.length > 0;

  // Passo 3: Destinatari e filtri
  const [robotSearchFilter, setRobotSearchFilter] = useState<string>("");
  const [selectedTargetRobotIds, setSelectedTargetRobotIds] = useState<string[]>([]);

  // Passo 4: Cartella di destinazione
  const [commonServerDirectory, setCommonServerDirectory] = useState<string>("/upload");
  const [generalDirectory, setGeneralDirectory] = useState<string>("/");
  const [individualDirectories, setIndividualDirectories] = useState<Record<RobotFolderScope, Record<string, string>>>({
    server: {},
    remote: {},
  });
  const [isFolderPickerOpen, setIsFolderPickerOpen] = useState<boolean>(false);
  const [folderPickerScope, setFolderPickerScope] = useState<"general" | "server" | "remote">("remote");
  const [folderPickerTargetRobotId, setFolderPickerTargetRobotId] = useState<string | undefined>(undefined);
  const [folderPickerIndividual, setFolderPickerIndividual] = useState(false);

  const defaultOperatorDir =
    isOperator && Array.isArray(allowedPaths) && allowedPaths.length > 0 ? allowedPaths[0] : undefined;
  const folderFor = (scope: RobotFolderScope, robotId: string) =>
    individualDirectories[scope][robotId] ??
    (scope === "server" ? commonServerDirectory : (defaultOperatorDir ?? "/upload"));
  const setRobotFolder = (scope: RobotFolderScope, robotId: string, directory: string) => {
    setIndividualDirectories((prev) => ({ ...prev, [scope]: { ...prev[scope], [robotId]: directory } }));
  };

  // Passo 5: Opzioni trasferimento & Esecuzione
  const [isMove, setIsMove] = useState<boolean>(false);
  const [moveConfirmation, setMoveConfirmation] = useState<boolean>(false);
  const [overwrite, setOverwrite] = useState<boolean>(false);

  const [progress, setProgress] = useState<number>(0);
  const [isTransferring, setIsTransferring] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<BulkUploadTargetResult[] | null>(null);
  const [robotToRobotSummary, setRobotToRobotSummary] = useState<any | null>(null);
  const [maxConcurrentFiles, setMaxConcurrentFiles] = useState<number>(20);
  const [maxFileUploadBytes, setMaxFileUploadBytes] = useState<number>(3 * 1024 * 1024 * 1024);
  const [hoveredRobot, setHoveredRobot] = useState<{
    robot: RobotSummaryDto;
    x: number;
    y: number;
  } | null>(null);

  const robotsById = useMemo(() => {
    const map = new Map<string, RobotSummaryDto>();
    for (const r of robots) map.set(r.id, r);
    return map;
  }, [robots]);

  const showRobotHoverCard = (robotId: string, targetEl: HTMLElement) => {
    const robot = robotsById.get(robotId);
    if (!robot) return;
    const rect = targetEl.getBoundingClientRect();
    const cardWidth = 310;
    const cardHeight = 165;
    const viewportW = typeof window !== "undefined" ? window.innerWidth : 1280;
    const viewportH = typeof window !== "undefined" ? window.innerHeight : 800;
    const left = Math.max(12, Math.min(rect.left, viewportW - cardWidth - 12));
    const top =
      rect.bottom + 8 + cardHeight <= viewportH
        ? rect.bottom + 8
        : Math.max(12, rect.top - cardHeight - 8);
    setHoveredRobot({ robot, x: left, y: top });
  };

  const hideRobotHoverCard = () => setHoveredRobot(null);

  // Reset solo alla reale apertura del modal. L'array robots non è una dipendenza:
  // un refresh della flotta non deve più riportare la sorgente al primo pulsante.
  const prevIsOpenRef = useRef<boolean>(false);
  useEffect(() => {
    if (isOpen && !prevIsOpenRef.current) {
      setStep(1);
      setSourceType("computer");
      setComputerFiles([]);
      setSourceRobotId("");
      setSelectedServerFiles([]);
      setSourceAvailableDirs([]);
      setSourceAvailableFiles([]);
      setSourceDirCurrent("/");
      setSourceDirDisplay("/");
      setSelectedDestTypes(["remote_robots"]);
      setRobotSearchFilter("");
      setSelectedTargetRobotIds([]);
      setCommonServerDirectory(defaultOperatorDir ?? "/upload");
      setGeneralDirectory(defaultOperatorDir ?? "/");
      setIndividualDirectories({ server: {}, remote: {} });
      setIsMove(false);
      setMoveConfirmation(false);
      setOverwrite(false);
      setProgress(0);
      setIsTransferring(false);
      setError(null);
      setResults(null);
      setRobotToRobotSummary(null);
      setHoveredRobot(null);
    }
    prevIsOpenRef.current = isOpen;
  }, [isOpen]);

  useEffect(() => {
    setHoveredRobot(null);
  }, [step, isFolderPickerOpen, isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    fetchPublicConfig()
      .then((cfg) => {
        if (cancelled) return;
        const cfgMaxFiles = cfg.bulkUploadConfig?.maxConcurrentFiles;
        if (typeof cfgMaxFiles === "number" && cfgMaxFiles >= 1) {
          setMaxConcurrentFiles(cfgMaxFiles);
        }
        if (typeof cfg.maxFileUploadBytes === "number" && cfg.maxFileUploadBytes >= 1) {
          setMaxFileUploadBytes(cfg.maxFileUploadBytes);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  // Il robot predefinito è inizializzato solo se manca; non sovrascrive una scelta utente.
  useEffect(() => {
    if (isOpen && !sourceRobotId && robots[0]?.id) {
      setSourceRobotId(robots[0].id);
    }
  }, [isOpen, robots, sourceRobotId]);

  // Caricamento file e sottocartelle per sorgenti server o robot
  useEffect(() => {
    if (!isOpen || sourceType === "computer") return;

    let cancelled = false;
    const loadFiles = async () => {
      setLoadingSourceFiles(true);
      setError(null);
      try {
        let endpoint = "";
        if (sourceType === "general") {
          endpoint = `/api/fs/general/list?path=${encodeURIComponent(sourceDirCurrent || "/")}`;
        } else if (sourceType === "server_robot") {
          if (!sourceRobotId) {
            setLoadingSourceFiles(false);
            return;
          }
          endpoint = `/api/robots/${encodeURIComponent(sourceRobotId)}/fs/server/list?path=${encodeURIComponent(sourceDirCurrent || "/")}`;
        } else if (sourceType === "remote_robot") {
          if (!sourceRobotId) {
            setLoadingSourceFiles(false);
            return;
          }
          endpoint = sourceDirCurrent
            ? `/api/robots/${encodeURIComponent(sourceRobotId)}/fs/remote/list?path=${encodeURIComponent(sourceDirCurrent)}`
            : `/api/robots/${encodeURIComponent(sourceRobotId)}/fs/remote/list`;
        }

        const res = await apiClient.get(endpoint);
        const data = await res.json();
        if (cancelled) return;
        if (res.ok) {
          const resolvedDir: string = data.path || data.currentPath || sourceDirCurrent || "/";
          setSourceDirDisplay(resolvedDir);
          const rawEntries: any[] = Array.isArray(data.entries) ? data.entries : (data.items || []);
          const joinDirPath = (name: string) =>
            resolvedDir.endsWith("/") ? `${resolvedDir}${name}` : `${resolvedDir}/${name}`;

          const dirs: ServerSourceFile[] = rawEntries
            .filter((e) => e.type === "directory")
            .filter((e) => sourceType !== "general" || (e.scope !== "robot" && e.scope !== "deleted_robot"))
            .map((e) => ({
              name: e.name,
              path: joinDirPath(e.name),
            }));
          const files: ServerSourceFile[] = rawEntries
            .filter((e) => e.type === "file")
            .map((e) => ({
              name: e.name,
              path: joinDirPath(e.name),
              size: e.size,
            }));
          setSourceAvailableDirs(dirs);
          setSourceAvailableFiles(files);
        } else {
          setSourceAvailableDirs([]);
          setSourceAvailableFiles([]);
          setError(data.message || "Impossibile caricare i file della sorgente.");
        }
      } catch (err: any) {
        if (cancelled) return;
        setSourceAvailableDirs([]);
        setSourceAvailableFiles([]);
        setError(err?.message || "Errore durante il caricamento dei file della sorgente.");
      } finally {
        if (!cancelled) setLoadingSourceFiles(false);
      }
    };

    void loadFiles();
    return () => {
      cancelled = true;
    };
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

  const getUploadLimitViolation = (files: File[], serverCount: number): string | null => {
    if (sourceType === "computer") {
      if (files.length > maxConcurrentFiles) {
        return `Selezionati ${files.length} file: il limite massimo consentito è ${maxConcurrentFiles} file per caricamento massivo.`;
      }
      let totalBytes = 0;
      for (const f of files) {
        if (f.size > maxFileUploadBytes) {
          return `Il file '${f.name}' supera la dimensione massima consentita (${formatByteLimit(maxFileUploadBytes)}).`;
        }
        totalBytes += f.size;
      }
      if (totalBytes > maxFileUploadBytes) {
        return `La dimensione totale dei file selezionati (${formatByteLimit(totalBytes)}) supera il limite massimo consentito (${formatByteLimit(maxFileUploadBytes)}).`;
      }
    } else if (serverCount > maxConcurrentFiles) {
      return `Selezionati ${serverCount} file: il limite massimo consentito è ${maxConcurrentFiles} file per caricamento massivo.`;
    }
    return null;
  };

  const step1LimitViolation = getUploadLimitViolation(computerFiles, selectedServerFiles.length);

  // Validazione prima di avanzare di passo
  const canProceedFromStep1 =
    hasBulkSourceSelection(sourceType, computerFiles, selectedServerFiles) &&
    !step1LimitViolation;

  const canProceedFromStep2 = selectedDestTypes.length > 0;

  const canProceedFromStep3 =
    !requiresRobotSelection || selectedTargetRobotIds.length > 0;

  const toggleDestType = (type: BulkDestType) => {
    setSelectedDestTypes((prev) =>
      prev.includes(type) ? prev.filter((t) => t !== type) : [...prev, type]
    );
  };

  const handleNext = () => {
    setError(null);
    if (step === 1 && step1LimitViolation) {
      setError(step1LimitViolation);
      return;
    }
    if (step === 1 && !canProceedFromStep1) {
      setError("Selezionare almeno un file sorgente per continuare.");
      return;
    }
    if (step === 2 && !canProceedFromStep2) {
      setError("Selezionare almeno un tipo di destinazione per continuare.");
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

    const destinations: BulkDestinations = {
      general: hasGeneralDest ? { subPath: generalDirectory } : undefined,
      servers: hasServerRobotDest
        ? selectedTargetRobotIds.map((id) => ({
            robotId: id,
            subPath: folderFor("server", id),
          }))
        : undefined,
      robots: hasRemoteDest
        ? selectedTargetRobotIds.map((id) => ({
            robotId: id,
            remotePath: folderFor("remote", id),
          }))
        : undefined,
    };

    if (isOperator) {
      const pathsToCheck: string[] = [];
      if (sourceType !== "computer") {
        pathsToCheck.push(...selectedServerFiles);
      }
      if (destinations.general?.subPath !== undefined) {
        pathsToCheck.push(destinations.general.subPath);
      }
      if (destinations.servers) {
        pathsToCheck.push(...destinations.servers.map((s) => s.subPath));
      }
      if (destinations.robots) {
        pathsToCheck.push(...destinations.robots.map((r) => r.remotePath));
      }
      const unauthorized = pathsToCheck.find((p) => !isPathAllowedForOperator(p, allowedPaths));
      if (unauthorized !== undefined) {
        setIsTransferring(false);
        setError(
          `Accesso non consentito: il percorso '${unauthorized || "/"}' è esterno ai percorsi autorizzati per l'operatore.`
        );
        return;
      }
    }

    try {
      // Flusso A: File dal computer (ISS-010: supporta combinazione Robot + Server Robot + Archivio Generale)
      if (sourceType === "computer") {
        const filenames = computerFiles.map((f) => f.name);

        if (!overwrite) {
          const preCheck = await onPreCheck(filenames, destinations);
          if (preCheck.error) {
            setIsTransferring(false);
            setError(preCheck.error.userMessage);
            return;
          }
          if (preCheck.hasConflicts) {
            setIsTransferring(false);
            onConflictsDetected(preCheck.conflicts, computerFiles, destinations);
            return;
          }
        }

        const res = await onExecuteUpload(computerFiles, destinations, overwrite, (p) => setProgress(p));
        if (res.results && res.results.length > 0) {
          setResults(res.results);
          setProgress(100);
        }
        if (!res.success) {
          const firstFailed = res.results?.flatMap((r) => r.failedFiles)[0];
          setError(
            res.error?.userMessage ||
              (firstFailed
                ? `Trasferimento non riuscito (${firstFailed.filename}): ${firstFailed.reason}`
                : "Una o più destinazioni non sono state completate.")
          );
        }
      }

      // Flusso B: File già sul server (Archivio Generale o Robot Server) (§5, §7, ISS-010)
      else if (sourceType === "general" || sourceType === "server_robot") {
        const targets = buildBulkTargets(destinations);

        const res = await apiClient.post("/api/transfers/bulk/server-source", {
          sourceScope: sourceType === "general" ? "general" : "server",
          sourceRobotId: sourceType === "server_robot" ? sourceRobotId : undefined,
          sourcePaths: selectedServerFiles,
          targets,
          overwrite,
        });

        const data = await res.json();
        if (res.ok) {
          const mappedResults: BulkUploadTargetResult[] = (data.results || []).flatMap((fileResult: any) =>
            (fileResult.targets || []).map((targetResult: any) => {
              const targetType =
                targetResult.target?.type === "general"
                  ? "general"
                  : targetResult.target?.type === "server"
                  ? "server"
                  : "robot";
              return {
                targetType,
                targetId: targetResult.target?.robotId || (targetType === "general" ? "general" : ""),
                targetName:
                  targetType === "general"
                    ? "Archivio Generale Server"
                    : targetResult.target?.robotId || "Destinazione",
                success: Boolean(targetResult.success),
                transferredFiles: targetResult.success ? [fileResult.filename] : [],
                failedFiles: targetResult.success
                  ? []
                  : [{ filename: fileResult.filename, reason: targetResult.error || "Errore" }],
              };
            })
          );
          setResults(mappedResults);
          setProgress(100);
          const firstFailed = mappedResults.flatMap((r) => r.failedFiles)[0];
          if (data.success === false || firstFailed) {
            setError(
              firstFailed
                ? `Trasferimento non riuscito (${firstFailed.filename}): ${firstFailed.reason}`
                : "Una o più destinazioni non sono state completate."
            );
          }
        } else {
          setError(data.message || "Errore durante il trasferimento dei file dal server.");
        }
      }

      // Flusso C: Copia / Spostamento Robot -> Robot (§6)
      else if (sourceType === "remote_robot") {
        const logBatchId = crypto.randomUUID();
        const remoteTargetPaths = Object.fromEntries(
          selectedTargetRobotIds.map((id) => [id, folderFor("remote", id)])
        );
        for (const filePath of selectedServerFiles) {
          const res = await apiClient.post("/api/transfers/robot-robot", {
            logBatchId,
            sourceRobotId,
            sourceRemotePath: filePath,
            targetRobotIds: selectedTargetRobotIds,
            targetRemotePaths: remoteTargetPaths,
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
                  onClick={() => {
                    setSourceType("computer");
                    setError(null);
                  }}
                >
                  File dal Computer
                </button>
                <button
                  type="button"
                  className={`btn btn-sm ${sourceType === "general" ? "btn-primary" : "btn-outline-secondary"}`}
                  onClick={() => {
                    setSourceType("general");
                    setSourceDirCurrent("/");
                    setSourceDirDisplay("/");
                    setSelectedServerFiles([]);
                    setError(null);
                  }}
                >
                  Archivio Generale Server
                </button>
                <button
                  type="button"
                  className={`btn btn-sm ${sourceType === "server_robot" ? "btn-primary" : "btn-outline-secondary"}`}
                  onClick={() => {
                    setSourceType("server_robot");
                    setSourceDirCurrent("/");
                    setSourceDirDisplay("/");
                    setSelectedServerFiles([]);
                    setError(null);
                  }}
                >
                  Archivio Server Robot
                </button>
                <button
                  type="button"
                  className={`btn btn-sm ${sourceType === "remote_robot" ? "btn-primary" : "btn-outline-secondary"}`}
                  onClick={() => {
                    setSourceType("remote_robot");
                    setSourceDirCurrent("");
                    setSourceDirDisplay("/");
                    setSelectedServerFiles([]);
                    setSelectedDestTypes(["remote_robots"]);
                    setError(null);
                  }}
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
                      if (e.target.files && e.target.files.length > 0) {
                        const newFiles = Array.from(e.target.files);
                        const existing = new Set(computerFiles.map((f) => f.name));
                        const merged = [...computerFiles, ...newFiles.filter((f) => !existing.has(f.name))];
                        setComputerFiles(merged);
                        setError(getUploadLimitViolation(merged, selectedServerFiles.length));
                      }
                    }}
                  />
                  <div className="small text-muted mt-1" id="bulk-upload-limits-hint">
                    Limite configurato: massimo {maxConcurrentFiles} file per lotto · dimensione massima {formatByteLimit(maxFileUploadBytes)}.
                  </div>
                  <div className="small text-secondary mt-2">
                    {computerFiles.length === 0
                      ? "Nessun file selezionato."
                      : `${computerFiles.length} file selezionati:`}
                  </div>
                  {computerFiles.length > 0 && (
                    <ul className="list-group list-group-flush small mt-2 mb-0 border rounded bg-white" style={{ maxHeight: "140px", overflowY: "auto" }}>
                      {computerFiles.map((f, i) => (
                        <li key={`${f.name}-${i}`} className="list-group-item d-flex justify-content-between align-items-center py-1 px-3">
                          <span className="text-truncate me-2" title={f.name}>{f.name}</span>
                          <div className="d-flex align-items-center gap-2 flex-shrink-0">
                            <span className="text-muted small">
                              {Math.round(f.size / 1024) > 0 ? `${Math.round(f.size / 1024)} KB` : `${f.size} B`}
                            </span>
                            <button
                              type="button"
                              className="btn btn-sm btn-link text-danger p-0 ms-1"
                              title="Rimuovi file"
                              onClick={() => {
                                const nextFiles = computerFiles.filter((_, idx) => idx !== i);
                                setComputerFiles(nextFiles);
                                setError(getUploadLimitViolation(nextFiles, selectedServerFiles.length));
                              }}
                            >
                              <Trash2 size={14} />
                            </button>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}

              {sourceType !== "computer" && (
                <div className="p-3 bg-light border rounded mb-3">
                  {sourceType !== "general" && (
                    <div className="mb-2">
                      <label className="form-label small fw-semibold d-flex align-items-center gap-2">
                        <span>Seleziona Robot Sorgente:</span>
                        {sourceRobotId && (
                          <span
                            className="font-monospace text-primary"
                            data-robot-hover-id={sourceRobotId}
                            tabIndex={0}
                            style={{ borderBottom: "1px dotted currentColor", cursor: "help" }}
                            onMouseEnter={(e) => showRobotHoverCard(sourceRobotId, e.currentTarget)}
                            onMouseLeave={hideRobotHoverCard}
                            onFocus={(e) => showRobotHoverCard(sourceRobotId, e.currentTarget)}
                            onBlur={hideRobotHoverCard}
                          >
                            {sourceRobotId}
                          </span>
                        )}
                      </label>
                      <select
                        className="form-select form-select-sm font-monospace"
                        value={sourceRobotId}
                        onChange={(e) => {
                          setSourceRobotId(e.target.value);
                          setSourceDirCurrent(sourceType === "remote_robot" ? "" : "/");
                          setSourceDirDisplay("/");
                          setSelectedServerFiles([]);
                        }}
                      >
                        {robots.map((r) => (
                          <option key={r.id} value={r.id}>
                            {r.id}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}

                  <div className="d-flex justify-content-between align-items-center mb-1 gap-2 flex-wrap">
                    <div className="fw-semibold small">
                      Sorgente (<code className="text-dark">{sourceDirDisplay}</code>):
                    </div>
                    {sourceDirDisplay && sourceDirDisplay !== "/" && (
                      <button
                        type="button"
                        className="btn btn-outline-secondary btn-sm py-0 px-2"
                        onClick={() => {
                          const parts = sourceDirDisplay.split("/").filter(Boolean);
                          parts.pop();
                          const parent = parts.length > 0 ? `/${parts.join("/")}` : "/";
                          setSourceDirCurrent(parent);
                        }}
                      >
                        &uarr; Cartella superiore
                      </button>
                    )}
                  </div>
                  {loadingSourceFiles ? (
                    <div className="text-secondary small p-2">Caricamento file sorgente...</div>
                  ) : sourceAvailableDirs.length === 0 && sourceAvailableFiles.length === 0 ? (
                    <div className="text-secondary small p-2">Nessun file o cartella presente nella directory sorgente.</div>
                  ) : (
                    <div className="border rounded bg-white p-2" style={{ maxHeight: "180px", overflowY: "auto" }}>
                      {sourceAvailableDirs.map((dir) => (
                        <div key={`dir-${dir.path}`} className="mb-1">
                          <button
                            type="button"
                            className="btn btn-link btn-sm p-0 text-decoration-none fw-semibold text-start"
                            onClick={() => setSourceDirCurrent(dir.path)}
                          >
                            [Cartella] {dir.name}
                          </button>
                        </div>
                      ))}
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
                  {selectedServerFiles.length > 0 && (
                    <div className="small text-primary mt-1">
                      {selectedServerFiles.length} file selezionati per il trasferimento.
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* ============================================================ */}
          {/* PASSO 2: Tipo Destinazione (selezione multipla combinabile - ISS-010) */}
          {/* ============================================================ */}
          {step === 2 && (
            <div>
              <h4 className="h6 fw-bold mb-1">2. Scegli una o più Destinazioni:</h4>
              <p className="small text-secondary mb-2">
                {sourceType === "remote_robot"
                  ? "Il trasferimento Robot → Robot supporta uno o più robot destinatari."
                  : "Puoi combinare più destinazioni (es. Robot Remoti + Server) nella stessa operazione."}
              </p>
              <div className="list-group mb-3">
                <label className={`list-group-item list-group-item-action d-flex align-items-center gap-3 ${hasRemoteDest ? "active" : ""}`}>
                  <input
                    type="checkbox"
                    checked={hasRemoteDest}
                    onChange={() => {
                      if (sourceType === "remote_robot") {
                        setSelectedDestTypes(["remote_robots"]);
                      } else {
                        toggleDestType("remote_robots");
                      }
                    }}
                  />
                  <div>
                    <strong>Uno o più Robot Remoti (SFTP Diretto)</strong>
                    <div className="small opacity-75">
                      Invia i file direttamente nel filesystem operativo dei robot selezionati.
                    </div>
                  </div>
                </label>

                {sourceType !== "remote_robot" && (
                  <label className={`list-group-item list-group-item-action d-flex align-items-center gap-3 ${hasServerRobotDest ? "active" : ""}`}>
                    <input
                      type="checkbox"
                      checked={hasServerRobotDest}
                      onChange={() => toggleDestType("server_robots")}
                    />
                    <div>
                      <strong>Directory Server Associate ai Robot</strong>
                      <div className="small opacity-75">
                        Archivia i file sul server locale nelle cartelle dedicate a ciascun robot selezionato.
                      </div>
                    </div>
                  </label>
                )}

                {sourceType !== "remote_robot" && (
                  <label className={`list-group-item list-group-item-action d-flex align-items-center gap-3 ${hasGeneralDest ? "active" : ""}`}>
                    <input
                      type="checkbox"
                      checked={hasGeneralDest}
                      onChange={() => toggleDestType("general")}
                    />
                    <div>
                      <strong>Archivio Generale Server</strong>
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
              {!requiresRobotSelection ? (
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
                            <span
                              className="fw-semibold font-monospace"
                              data-robot-hover-id={r.id}
                              tabIndex={0}
                              style={{ borderBottom: "1px dotted currentColor", cursor: "help" }}
                              onMouseEnter={(e) => showRobotHoverCard(r.id, e.currentTarget)}
                              onMouseLeave={hideRobotHoverCard}
                              onFocus={(e) => showRobotHoverCard(r.id, e.currentTarget)}
                              onBlur={hideRobotHoverCard}
                            >
                              {r.id}
                            </span>
                          </div>
                          <div className="text-secondary small">
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
                {hasGeneralDest && (
                  <div className="mb-3">
                    <label className="form-label small fw-semibold">
                      Cartella in Archivio Generale Server:
                    </label>
                    <div className="d-flex gap-2">
                      <input
                        type="text"
                        className="form-control form-control-sm font-monospace"
                        value={generalDirectory}
                        onChange={(e) => setGeneralDirectory(e.target.value)}
                      />
                      <button
                        type="button"
                        id="btn-open-folder-picker-general"
                        className="btn btn-outline-primary btn-sm"
                        onClick={() => {
                          setFolderPickerScope("general");
                          setFolderPickerTargetRobotId(undefined);
                          setFolderPickerIndividual(false);
                          setIsFolderPickerOpen(true);
                        }}
                      >
                        Scegli Cartella...
                      </button>
                    </div>
                  </div>
                )}

                {hasServerRobotDest && (
                  <div className="mb-3">
                    <label htmlFor="bulk-directory-server" className="form-label small fw-semibold">
                      Cartella comune negli archivi server dei robot
                    </label>
                    <div className="d-flex gap-2">
                      <input
                        id="bulk-directory-server"
                        type="text"
                        className="form-control form-control-sm font-monospace"
                        placeholder="es. /upload"
                        value={commonServerDirectory}
                        onChange={(e) => setCommonServerDirectory(e.target.value)}
                      />
                      <button
                        type="button"
                        id="btn-open-folder-picker-server"
                        className="btn btn-outline-primary btn-sm"
                        onClick={() => {
                          setFolderPickerScope("server");
                          setFolderPickerTargetRobotId(selectedTargetRobotIds[0]);
                          setFolderPickerIndividual(false);
                          setIsFolderPickerOpen(true);
                        }}
                      >
                        Scegli Cartella...
                      </button>
                    </div>

                    {selectedTargetRobotIds.length > 1 && (
                      <div className="mt-3">
                        <div className="small fw-semibold mb-2">Personalizza per singolo robot</div>
                        <div style={{ maxHeight: "140px", overflowY: "auto" }}>
                          {selectedTargetRobotIds.map((robotId) => (
                            <div key={robotId} className="d-flex align-items-center gap-2 mb-1 small">
                              <label
                                htmlFor={`bulk-directory-server-${robotId}`}
                                style={{ width: "160px" }}
                                className="text-truncate font-monospace fw-semibold"
                              >
                                <span
                                  data-robot-hover-id={robotId}
                                  tabIndex={0}
                                  style={{ borderBottom: "1px dotted currentColor", cursor: "help" }}
                                  onMouseEnter={(e) => showRobotHoverCard(robotId, e.currentTarget)}
                                  onMouseLeave={hideRobotHoverCard}
                                  onFocus={(e) => showRobotHoverCard(robotId, e.currentTarget)}
                                  onBlur={hideRobotHoverCard}
                                >
                                  {robotId}
                                </span>
                              </label>
                              <input
                                id={`bulk-directory-server-${robotId}`}
                                type="text"
                                className="form-control form-control-sm font-monospace py-0"
                                value={folderFor("server", robotId)}
                                onChange={(e) => setRobotFolder("server", robotId, e.target.value)}
                              />
                              <button
                                type="button"
                                id={`btn-browse-server-${robotId}`}
                                className="btn btn-outline-secondary btn-sm py-0"
                                onClick={() => {
                                  setFolderPickerScope("server");
                                  setFolderPickerTargetRobotId(robotId);
                                  setFolderPickerIndividual(true);
                                  setIsFolderPickerOpen(true);
                                }}
                              >
                                Sfoglia
                              </button>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {hasRemoteDest && (
                  <div className="mb-3">
                    <div className="form-label small fw-semibold mb-2">Cartelle sui robot remoti</div>
                    <div style={{ maxHeight: "180px", overflowY: "auto" }}>
                      {selectedTargetRobotIds.map((robotId) => (
                        <div key={robotId} className="d-flex align-items-center gap-2 mb-1 small">
                          <label
                            htmlFor={`bulk-directory-remote-${robotId}`}
                            style={{ width: "160px" }}
                            className="text-truncate font-monospace fw-semibold"
                          >
                            <span
                              data-robot-hover-id={robotId}
                              tabIndex={0}
                              style={{ borderBottom: "1px dotted currentColor", cursor: "help" }}
                              onMouseEnter={(e) => showRobotHoverCard(robotId, e.currentTarget)}
                              onMouseLeave={hideRobotHoverCard}
                              onFocus={(e) => showRobotHoverCard(robotId, e.currentTarget)}
                              onBlur={hideRobotHoverCard}
                            >
                              {robotId}
                            </span>
                          </label>
                          <input
                            id={`bulk-directory-remote-${robotId}`}
                            type="text"
                            className="form-control form-control-sm font-monospace py-0"
                            placeholder="es. /home/robot, TEST oppure ~/TEST"
                            value={folderFor("remote", robotId)}
                            onChange={(e) => setRobotFolder("remote", robotId, e.target.value)}
                          />
                          <button
                            type="button"
                            id={`btn-browse-remote-${robotId}`}
                            className="btn btn-outline-secondary btn-sm py-0"
                            onClick={() => {
                              setFolderPickerScope("remote");
                              setFolderPickerTargetRobotId(robotId);
                              setFolderPickerIndividual(true);
                              setIsFolderPickerOpen(true);
                            }}
                          >
                            Sfoglia
                          </button>
                        </div>
                      ))}
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
                    {[
                      hasGeneralDest ? `Archivio Generale Server (${generalDirectory})` : null,
                      hasServerRobotDest ? `Directory Server di ${selectedTargetRobotIds.length} robot` : null,
                      hasRemoteDest ? `${selectedTargetRobotIds.length} robot remoti (SFTP)` : null,
                    ]
                      .filter(Boolean)
                      .join(" + ")}
                  </div>
                </div>
                {robotFolderScopes.map((scope) => (
                  <div key={scope} className="row mb-2">
                    <div className="col-4 text-secondary">{scope === "server" ? "Cartelle server" : "Cartelle remote"}</div>
                    <ul className="col-8 font-monospace list-unstyled mb-0">
                      {selectedTargetRobotIds.map((robotId) => (
                        <li key={robotId}>
                          <span
                            className="fw-semibold"
                            data-robot-hover-id={robotId}
                            tabIndex={0}
                            style={{ borderBottom: "1px dotted currentColor", cursor: "help" }}
                            onMouseEnter={(e) => showRobotHoverCard(robotId, e.currentTarget)}
                            onMouseLeave={hideRobotHoverCard}
                            onFocus={(e) => showRobotHoverCard(robotId, e.currentTarget)}
                            onBlur={hideRobotHoverCard}
                          >
                            {robotId}
                          </span>{" "}
                          → {folderFor(scope, robotId)}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}

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
                      <strong>
                        {res.targetType === "server" && "Server · "}
                        {res.targetType === "robot" && "SFTP · "}
                        {res.targetName}
                      </strong>
                      {" · "}{res.transferredFiles.length} file completati
                      {res.failedFiles.length > 0 && (
                        <ul className="mb-0 mt-1 ps-4 text-danger">
                          {res.failedFiles.map((f, j) => (
                            <li key={`${f.filename}-${j}`}>
                              <code>{f.filename}</code>: {f.reason}
                            </li>
                          ))}
                        </ul>
                      )}
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
                id="btn-bulk-next"
                onClick={handleNext}
                disabled={
                  (step === 1 && !canProceedFromStep1) ||
                  (step === 2 && !canProceedFromStep2) ||
                  (step === 3 && !canProceedFromStep3) ||
                  isTransferring
                }
              >
                Avanti &rarr;
              </button>
            ) : (
              <DoubleSubmitButton
                type="button"
                className="btn btn-primary btn-sm"
                id="btn-start-bulk-upload"
                onAsyncClick={handleExecute}
                disabled={isTransferring || (isMove && !moveConfirmation)}
                pendingText="Trasferimento in corso..."
              >
                Avvia Trasferimento Massivo
              </DoubleSubmitButton>
            )}
          </div>
        </div>
      </div>

      {/* Finestrella dettagli robot al passaggio del cursore sull'ID */}
      {hoveredRobot && (
        <div
          id="bulk-robot-hover-card"
          role="tooltip"
          className="card shadow-lg border bg-white text-dark p-2 small"
          style={{
            position: "fixed",
            left: `${hoveredRobot.x}px`,
            top: `${hoveredRobot.y}px`,
            width: "310px",
            zIndex: 1085,
            pointerEvents: "none",
          }}
        >
          <div className="d-grid gap-1" style={{ gridTemplateColumns: "125px 1fr" }}>
            <span className="text-secondary fw-semibold">Cliente</span>
            <span className="text-break">{hoveredRobot.robot.customerName || "—"}</span>
            <span className="text-secondary fw-semibold">Impianto</span>
            <span className="text-break">{hoveredRobot.robot.plantName || "—"}</span>
            <span className="text-secondary fw-semibold">Nome Robot</span>
            <span className="text-break">{hoveredRobot.robot.displayName || "—"}</span>
            <span className="text-secondary fw-semibold">ID</span>
            <span className="font-monospace fw-semibold text-break">{hoveredRobot.robot.id}</span>
            <span className="text-secondary fw-semibold">Username Remoto</span>
            <span className="font-monospace text-break">{hoveredRobot.robot.remoteUsername || "—"}</span>
          </div>
        </div>
      )}

      {/* Finestrella Selettore Cartelle (§8) */}
      <FolderPickerModal
        isOpen={isFolderPickerOpen}
        scope={folderPickerScope}
        robotId={folderPickerTargetRobotId}
        isOperator={isOperator}
        allowedPaths={allowedPaths}
        robotName={folderPickerTargetRobotId}
        initialPath={folderPickerScope === "general"
          ? generalDirectory
          : folderPickerScope === "remote" && folderPickerTargetRobotId
            ? folderFor("remote", folderPickerTargetRobotId)
            : folderPickerIndividual && folderPickerTargetRobotId
              ? folderFor("server", folderPickerTargetRobotId)
              : commonServerDirectory}
        onClose={() => setIsFolderPickerOpen(false)}
        onSelectFolder={(selectedPath) => {
          if (folderPickerScope === "general") {
            setGeneralDirectory(selectedPath);
            return;
          }
          if (folderPickerScope === "remote" && folderPickerTargetRobotId) {
            setRobotFolder("remote", folderPickerTargetRobotId, selectedPath);
          } else if (folderPickerIndividual && folderPickerTargetRobotId) {
            setRobotFolder("server", folderPickerTargetRobotId, selectedPath);
          } else {
            setCommonServerDirectory(selectedPath);
          }
        }}
      />
    </div>
  );
};
