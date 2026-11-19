import React, { useState, useEffect, useRef, useCallback } from "react";
import type { User } from "../../types/auth.ts";
import { apiClient } from "../../services/api-client.ts";
import { ErrorPresenter } from "../../services/error-presenter.ts";
import { StateFormatter } from "../../services/state-formatter.ts";
import type { DirectoryItem, PathVerificationResult } from "../../types/filesystem.ts";
import type { TransferStartResult } from "../../types/transfer.ts";

export interface FileManagementModalProps {
  user?: User | null;
  isOpen: boolean;
  onClose: () => void;
  /** Avvia il trasferimento verso la cartella scelta; la modale si chiude solo se `ok`. */
  onConfirm: (destinationPath: string, options: { overwrite: boolean }) => Promise<TransferStartResult>;
  sourceFileName: string;
  sourceFileSize?: number;
  sourceType: "server" | "remote"; // "server" -> destinazione Robot; "remote" -> destinazione Server
  robotId: string;
  robotName?: string;
  /** Percorso iniziale; vuoto = home dell'utente SSH (robot) o radice (server). */
  initialPath?: string;
  /** Utente con ruolo operatore: limitato a `allowedPaths`. */
  isOperator?: boolean;
  allowedPaths?: string[];
}

// Confronto componenti percorso per controllo client-side operatore
const isPathAllowedForUser = (candidate: string, allowedRoots: string[]): boolean => {
  const normCandidate = "/" + candidate.replace(/^[/\\]+/, "").replace(/\/+$/, "");
  const candSegs = normCandidate.split("/").filter(Boolean);
  return allowedRoots.some((root) => {
    const normRoot = "/" + root.replace(/^[/\\]+/, "").replace(/\/+$/, "");
    const rootSegs = normRoot.split("/").filter(Boolean);
    if (rootSegs.length === 0) return true;
    if (candSegs.length < rootSegs.length) return false;
    return rootSegs.every((seg, i) => candSegs[i] === seg);
  });
};

const normalizeClientPath = (raw: string): string => {
  let p = (raw || "/").trim().replace(/\\/g, "/");
  if (!p) return "/";
  if (!p.startsWith("/")) p = "/" + p;
  p = p.replace(/\/\.(?=\/|$)/g, "").replace(/\/+/g, "/");
  if (p.length > 1) p = p.replace(/\/+$/, "");
  return p || "/";
};

export const FileManagementModal: React.FC<FileManagementModalProps> = ({
  user,
  isOpen,
  onClose,
  onConfirm,
  sourceFileName,
  sourceFileSize,
  sourceType,
  robotId,
  robotName,
  initialPath = "/",
  isOperator = false,
  allowedPaths,
}) => {
  const effectiveIsOperator = isOperator || (user?.roles.includes("operatore") ?? false);
  const effectiveAllowedPaths = allowedPaths ?? user?.allowedPaths;
  const modalRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Valori "volatili" letti solo all'apertura: non devono rilanciare il caricamento se cambiano.
  const initialPathRef = useRef(initialPath);
  initialPathRef.current = initialPath;
  const operatorRootsRef = useRef<string[] | undefined>(effectiveIsOperator ? effectiveAllowedPaths : undefined);
  operatorRootsRef.current = effectiveIsOperator ? effectiveAllowedPaths : undefined;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Anti-race: solo l'ultima richiesta di navigazione/verifica può aggiornare lo stato.
  const navRequestId = useRef(0);
  const verifyRequestId = useRef(0);

  const [currentBrowserPath, setCurrentBrowserPath] = useState<string>("");
  const [directories, setDirectories] = useState<DirectoryItem[]>([]);
  const [parentPath, setParentPath] = useState<string | null>(null);
  const [isLoadingDirs, setIsLoadingDirs] = useState<boolean>(false);
  const [browserError, setBrowserError] = useState<string | null>(null);

  const [manualPath, setManualPath] = useState<string>("");
  const [clientValidationError, setClientValidationError] = useState<string | null>(null);
  const [verification, setVerification] = useState<{ path: string; result: PathVerificationResult } | null>(null);
  const [isVerifying, setIsVerifying] = useState<boolean>(false);

  const [overwrite, setOverwrite] = useState<boolean>(false);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const submittingRef = useRef(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const validateSyntax = useCallback((p: string): string | null => {
    if (!p || p.trim() === "") return "Il percorso non può essere vuoto.";
    if (p.includes("\0")) return "Il percorso contiene byte nulli o caratteri non consentiti.";
    if (p.length > 4096) return "La lunghezza del percorso supera il limite di 4096 caratteri.";
    if (!p.trim().startsWith("/")) {
      return "Il percorso deve essere assoluto (iniziare con '/').";
    }
    if (/(?:^|[\\/])\.\.(?:[\\/]|$)/.test(p) || /%2e%2e/i.test(p)) {
      return "Attraversamento directory ('..') non consentito.";
    }
    const roots = operatorRootsRef.current;
    if (roots && roots.length > 0 && !isPathAllowedForUser(p, roots)) {
      return "Accesso non consentito: la cartella richiesta è esterna ai percorsi autorizzati per l'operatore.";
    }
    return null;
  }, []);

  /** Verifica esistenza, tipo e permessi di scrittura reali (SFTP stat / probe di scrittura). */
  const verifyPath = useCallback(
    async (candidate: string): Promise<PathVerificationResult | null> => {
      const reqId = ++verifyRequestId.current;
      const syntaxErr = validateSyntax(candidate);
      if (syntaxErr) {
        setClientValidationError(syntaxErr);
        setVerification(null);
        setIsVerifying(false);
        return null;
      }
      setClientValidationError(null);
      setIsVerifying(true);
      let result: PathVerificationResult;
      try {
        const endpoint =
          sourceType === "server"
            ? `/api/robots/${encodeURIComponent(robotId)}/sftp/validate-path`
            : `/api/robots/${encodeURIComponent(robotId)}/fs/server/verify-path`;
        const res = await apiClient.post(endpoint, { path: candidate });
        const data = await res.json().catch(() => ({}));
        result = res.ok
          ? (data as PathVerificationResult)
          : {
              valid: false,
              exists: false,
              isDirectory: false,
              isWritable: false,
              resolvedPath: candidate,
              error: ErrorPresenter.formatError(data).userMessage || "Percorso non valido o non verificabile.",
            };
      } catch {
        result = {
          valid: false,
          exists: false,
          isDirectory: false,
          isWritable: false,
          resolvedPath: candidate,
          error: "Errore di comunicazione durante la verifica del percorso.",
        };
      }
      if (reqId !== verifyRequestId.current) return null; // risposta superata
      setVerification({ path: candidate, result });
      setIsVerifying(false);
      return result;
    },
    [sourceType, robotId, validateSyntax]
  );

  /**
   * Naviga (e verifica) una cartella. Unico punto di caricamento dell'elenco: viene chiamato solo da
   * azioni esplicite (apertura, click riga/breadcrumb/Livello superiore, Invio/Esplora).
   * Un percorso vuoto = cartella di partenza (home SSH per il robot).
   */
  const navigateTo = useCallback(
    async (pathParam: string) => {
      const reqId = ++navRequestId.current;
      setIsLoadingDirs(true);
      setBrowserError(null);
      let resolved = pathParam;
      try {
        const query = pathParam ? `?path=${encodeURIComponent(pathParam)}` : "";
        const endpoint =
          sourceType === "server"
            ? `/api/robots/${encodeURIComponent(robotId)}/fs/remote/directories${query}`
            : `/api/robots/${encodeURIComponent(robotId)}/fs/server/directories${query}`;
        const res = await apiClient.get(endpoint);
        const data = await res.json().catch(() => ({}));
        if (reqId !== navRequestId.current) return;
        if (res.ok) {
          resolved = data.currentPath || pathParam || "/";
          setCurrentBrowserPath(resolved);
          setParentPath(data.parentPath !== undefined ? data.parentPath : null);
          setDirectories(Array.isArray(data.directories) ? data.directories : []);
        } else {
          setBrowserError(ErrorPresenter.formatError(data).userMessage || "Impossibile caricare le directory.");
          setDirectories([]);
        }
      } catch (err) {
        if (reqId !== navRequestId.current) return;
        setBrowserError(
          ErrorPresenter.formatError(err).userMessage || "Errore di connessione durante la lettura delle cartelle."
        );
        setDirectories([]);
      } finally {
        if (reqId === navRequestId.current) setIsLoadingDirs(false);
      }
      if (reqId !== navRequestId.current) return;
      if (resolved) {
        setManualPath(resolved);
        await verifyPath(resolved);
      }
    },
    [sourceType, robotId, verifyPath]
  );

  // Caricamento iniziale: SOLO all'apertura (o cambio robot/direzione), mai per re-render del padre.
  useEffect(() => {
    if (!isOpen) return;
    let startPath = normalizeClientPath(initialPathRef.current);
    const roots = operatorRootsRef.current;
    if (roots && roots.length > 0 && (!startPath || !isPathAllowedForUser(startPath, roots))) {
      startPath = normalizeClientPath(roots[0]);
    }
    setCurrentBrowserPath(startPath);
    setManualPath(startPath);
    setVerification(null);
    setClientValidationError(null);
    setSubmitError(null);
    setOverwrite(false);
    setIsSubmitting(false);
    submittingRef.current = false;
    void navigateTo(startPath);
    return () => {
      // Invalida eventuali risposte in volo alla chiusura.
      navRequestId.current++;
      verifyRequestId.current++;
    };
  }, [isOpen, robotId, sourceType, navigateTo]);

  // Focus trap e tasto Escape (listener registrato una volta per apertura)
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (!submittingRef.current) onCloseRef.current();
        return;
      }
      if (e.key === "Tab" && modalRef.current) {
        const focusable = modalRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        );
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          last.focus();
          e.preventDefault();
        } else if (!e.shiftKey && document.activeElement === last) {
          first.focus();
          e.preventDefault();
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    inputRef.current?.focus();
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen]);

  const handleNavigateSubfolder = (folderPath: string) => {
    if (isSubmitting) return;
    const norm = normalizeClientPath(folderPath) || "/";
    const err = validateSyntax(norm);
    if (err) {
      setClientValidationError(err);
      return;
    }
    setManualPath(norm);
    void navigateTo(norm);
  };

  const handleNavigateUp = () => {
    if (isSubmitting || parentPath === null) return;
    handleNavigateSubfolder(parentPath || "/");
  };

  // Invio / pulsante Esplora: sincronizza browser e verifica sul percorso digitato
  const handleManualPathCommit = () => {
    if (isSubmitting) return;
    const norm = normalizeClientPath(manualPath);
    const err = validateSyntax(norm);
    if (err) {
      setClientValidationError(err);
      return;
    }
    setClientValidationError(null);
    setManualPath(norm);
    void navigateTo(norm);
  };

  const handleManualPathChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setManualPath(val);
    setSubmitError(null);
    setClientValidationError(validateSyntax(val));
  };

  const manualNormalized = normalizeClientPath(manualPath);
  const verificationForCurrent =
    verification && verification.path === manualNormalized ? verification.result : null;
  const isNotWritable =
    verificationForCurrent !== null &&
    (!verificationForCurrent.valid ||
      !verificationForCurrent.exists ||
      !verificationForCurrent.isDirectory ||
      !verificationForCurrent.isWritable);

  const handleConfirm = async () => {
    if (submittingRef.current) return;
    const candidate = manualNormalized;
    const syntaxErr = validateSyntax(candidate);
    if (syntaxErr) {
      setClientValidationError(syntaxErr);
      return;
    }
    submittingRef.current = true;
    setIsSubmitting(true);
    setSubmitError(null);
    try {
      let result = verificationForCurrent;
      if (!result) result = await verifyPath(candidate);
      if (!result || !result.valid || !result.exists || !result.isDirectory || !result.isWritable) {
        setSubmitError(
          "Selezionare una cartella di destinazione esistente con permessi di scrittura per l'utente SSH."
        );
        return;
      }
      const outcome = await onConfirm(result.resolvedPath || candidate, { overwrite });
      if (outcome.ok) {
        onCloseRef.current();
      } else {
        setSubmitError(outcome.error || "Impossibile avviare il trasferimento.");
      }
    } catch (err) {
      setSubmitError(ErrorPresenter.formatError(err).userMessage || "Errore durante l'avvio del trasferimento.");
    } finally {
      submittingRef.current = false;
      setIsSubmitting(false);
    }
  };

  if (!isOpen) return null;

  const targetDescription =
    sourceType === "server"
      ? `Robot: ${robotName ? `${robotName} (${robotId})` : robotId} (Filesystem Remoto SFTP)`
      : `Server: Cartella associata al robot ${robotName ? `${robotName} (${robotId})` : robotId}`;

  const isConfirmDisabled =
    isSubmitting || isVerifying || isLoadingDirs || Boolean(clientValidationError) || !manualNormalized || isNotWritable;

  const breadcrumbSegments = currentBrowserPath
    .split("/")
    .filter(Boolean)
    .reduce<Array<{ name: string; fullPath: string }>>((acc, seg, idx, arr) => {
      acc.push({ name: seg, fullPath: "/" + arr.slice(0, idx + 1).join("/") });
      return acc;
    }, []);

  return (
    <div
      id="modal-file-management"
      className="modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="file-management-title"
      ref={modalRef}
      onClick={(e) => {
        if (e.target === e.currentTarget && !isSubmitting) onClose();
      }}
    >
      <div className="modal-content modal-large" style={{ maxWidth: 760 }}>
        <div className="modal-header">
          <h3 id="file-management-title" className="h5 fw-bold mb-0">
            Gestione File – Percorso di Trasferimento
          </h3>
          <button
            type="button"
            className="btn-close"
            onClick={onClose}
            disabled={isSubmitting}
            aria-label="Chiudi finestra Gestione File"
            id="btn-file-management-close"
          />
        </div>

        <div className="modal-body">
          <div className="card mb-3 bg-light border">
            <div className="card-body p-3">
              <div className="row g-2">
                <div className="col-12 col-md-6">
                  <span className="text-secondary small d-block">Nome File Selezionato:</span>
                  <strong id="file-mgmt-source-name" className="text-break">
                    {sourceFileName}
                  </strong>
                </div>
                <div className="col-12 col-md-6">
                  <span className="text-secondary small d-block">Dimensione File:</span>
                  <span id="file-mgmt-source-size">
                    {typeof sourceFileSize === "number" ? StateFormatter.formatBytes(sourceFileSize) : "N/D"}
                  </span>
                </div>
                <div className="col-12 mt-2">
                  <span className="text-secondary small d-block">Destinazione Trasferimento:</span>
                  <span id="file-mgmt-target-desc" className="fm-target-badge">
                    {targetDescription}
                  </span>
                </div>
              </div>
            </div>
          </div>

          <div className="mb-3">
            <label htmlFor="input-manual-path" className="form-label fw-bold mb-1">
              Percorso di Destinazione (Path):
            </label>
            <div className="input-group">
              <input
                ref={inputRef}
                type="text"
                id="input-manual-path"
                name="manualPath"
                className={`form-control ${
                  clientValidationError || isNotWritable ? "is-invalid" : verificationForCurrent ? "is-valid" : ""
                }`}
                placeholder="/home/utente/cartella"
                value={manualPath}
                onChange={handleManualPathChange}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    handleManualPathCommit();
                  }
                }}
                disabled={isSubmitting}
                aria-describedby="manual-path-feedback"
                autoComplete="off"
                spellCheck={false}
              />
              <button
                type="button"
                className="btn btn-outline-secondary"
                id="btn-sync-browser-to-manual"
                title="Apri nel browser la cartella digitata e verificane i permessi"
                onClick={handleManualPathCommit}
                disabled={isSubmitting || isLoadingDirs || Boolean(clientValidationError)}
              >
                Esplora
              </button>
            </div>

            <div id="manual-path-feedback" className="mt-1 small" aria-live="polite">
              {clientValidationError && (
                <div className="text-danger fw-semibold" id="feedback-client-error">
                  {clientValidationError}
                </div>
              )}
              {isVerifying && !clientValidationError && (
                <div className="text-muted" id="feedback-verifying">
                  <span className="spinner-border spinner-border-sm me-1" role="status" aria-hidden="true" />
                  Verifica esistenza e permessi del percorso in corso...
                </div>
              )}
              {!isVerifying && !clientValidationError && verificationForCurrent && (
                verificationForCurrent.valid &&
                verificationForCurrent.exists &&
                verificationForCurrent.isDirectory &&
                verificationForCurrent.isWritable ? (
                  <div className="text-success fw-semibold" id="feedback-valid-path">
                    Cartella valida, esistente e scrivibile.
                  </div>
                ) : (
                  <div className="fm-warning" id="feedback-server-error" role="alert">
                    {verificationForCurrent.exists && verificationForCurrent.isDirectory
                      ? "Directory di sola lettura o permessi insufficienti per l'utente SSH: seleziona una cartella scrivibile come /home/<utente>."
                      : verificationForCurrent.error || "Percorso non valido o inesistente."}
                  </div>
                )
              )}
              {!isVerifying && !clientValidationError && !verificationForCurrent && manualNormalized && (
                <div className="text-muted" id="feedback-pending">
                  Premi Invio o Esplora per aprire e verificare la cartella.
                </div>
              )}
            </div>
          </div>

          <div className="card border">
            <div className="card-header bg-white d-flex align-items-center justify-content-between p-2 flex-wrap gap-2">
              <div className="d-flex align-items-center gap-2 flex-grow-1">
                <button
                  type="button"
                  id="btn-browser-up"
                  className="btn btn-outline-secondary btn-sm"
                  onClick={handleNavigateUp}
                  disabled={isSubmitting || isLoadingDirs || parentPath === null}
                  title="Torna alla cartella superiore"
                >
                  Livello superiore (..)
                </button>
                <nav aria-label="Percorso cartella" className="ms-1">
                  <ol className="breadcrumb mb-0 py-1 px-2 bg-light rounded" style={{ fontSize: "0.85rem" }}>
                    <li className={`breadcrumb-item ${breadcrumbSegments.length === 0 ? "active" : ""}`}>
                      {breadcrumbSegments.length === 0 ? (
                        <strong>/</strong>
                      ) : (
                        <button
                          type="button"
                          className="btn-link p-0 border-0 bg-transparent text-primary"
                          onClick={() => handleNavigateSubfolder("/")}
                        >
                          /
                        </button>
                      )}
                    </li>
                    {breadcrumbSegments.map((seg, idx) => {
                      const isLast = idx === breadcrumbSegments.length - 1;
                      return (
                        <li key={seg.fullPath} className={`breadcrumb-item ${isLast ? "active" : ""}`}>
                          {isLast ? (
                            <strong>{seg.name}</strong>
                          ) : (
                            <button
                              type="button"
                              className="btn-link p-0 border-0 bg-transparent text-primary"
                              onClick={() => handleNavigateSubfolder(seg.fullPath)}
                            >
                              {seg.name}
                            </button>
                          )}
                        </li>
                      );
                    })}
                  </ol>
                </nav>
              </div>
              <button
                type="button"
                id="btn-select-current-dir"
                className="btn btn-outline-primary btn-sm"
                title="Seleziona la cartella attualmente visualizzata nel browser"
                onClick={() => currentBrowserPath && handleNavigateSubfolder(currentBrowserPath)}
                disabled={isSubmitting || isLoadingDirs || !currentBrowserPath}
              >
                Seleziona questa cartella
              </button>
            </div>

            <div className="card-body p-0" style={{ maxHeight: 220, minHeight: 140, overflowY: "auto", position: "relative" }}>
              {isLoadingDirs && directories.length === 0 && !browserError ? (
                <div className="p-4 text-center text-muted">
                  <div className="spinner-border spinner-border-sm mb-2" role="status" />
                  <div>Caricamento elenco directory...</div>
                </div>
              ) : browserError ? (
                <div className="p-3 text-danger" role="alert" id="browser-error-msg">
                  <strong>Errore esplorazione:</strong> {browserError}
                </div>
              ) : directories.length === 0 ? (
                <div className="p-4 text-center text-muted" id="browser-empty-msg">
                  Cartella vuota: nessuna sottocartella in questo percorso.
                </div>
              ) : (
                <ul
                  className="list-group list-group-flush mb-0"
                  id="browser-dirs-list"
                  style={{ opacity: isLoadingDirs ? 0.55 : 1 }}
                >
                  {directories.map((dir) => (
                    <li
                      key={dir.path}
                      className="list-group-item list-group-item-action d-flex align-items-center justify-content-between py-2 px-3"
                      style={{ cursor: "pointer" }}
                      role="button"
                      tabIndex={0}
                      onClick={() => handleNavigateSubfolder(dir.path)}
                      onDoubleClick={() => handleNavigateSubfolder(dir.path)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          handleNavigateSubfolder(dir.path);
                        }
                      }}
                    >
                      <div className="d-flex align-items-center gap-2">
                        <span className="fm-dir-tag" aria-hidden="true">
                          Dir
                        </span>
                        <span className="fw-semibold text-primary">{dir.name}/</span>
                      </div>
                      <button
                        type="button"
                        className="btn btn-outline-secondary btn-sm"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleNavigateSubfolder(dir.path);
                        }}
                      >
                        Apri
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          <div className="form-check mt-3">
            <input
              id="chk-overwrite"
              type="checkbox"
              className="form-check-input"
              checked={overwrite}
              onChange={(e) => setOverwrite(e.target.checked)}
              disabled={isSubmitting}
            />
            <label htmlFor="chk-overwrite" className="form-check-label small">
              Sovrascrivi il file se esiste già nella cartella di destinazione
            </label>
          </div>

          {submitError && (
            <div className="alert alert-danger mt-3 mb-0 p-2" role="alert" id="file-mgmt-submit-error">
              {submitError}
            </div>
          )}
        </div>

        <div className="modal-footer d-flex justify-content-between">
          <small className="text-muted">Il file verrà salvato nella cartella specificata.</small>
          <div className="d-flex gap-2">
            <button
              type="button"
              id="btn-file-management-cancel"
              className="btn btn-secondary"
              onClick={onClose}
              disabled={isSubmitting}
            >
              Annulla
            </button>
            <button
              type="button"
              id="btn-file-management-confirm"
              className="btn btn-primary"
              onClick={handleConfirm}
              disabled={isConfirmDisabled}
            >
              {isSubmitting ? (
                <>
                  <span className="spinner-border spinner-border-sm me-1" role="status" aria-hidden="true" />
                  Avvio in corso...
                </>
              ) : (
                "Conferma"
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
