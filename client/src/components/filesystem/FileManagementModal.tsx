import React, { useState, useEffect, useRef, useCallback } from "react";
import { apiClient } from "../../services/api-client.ts";
import { ErrorPresenter } from "../../services/error-presenter.ts";
import { StateFormatter } from "../../services/state-formatter.ts";
import type { DirectoryItem, PathVerificationResult } from "../../types/filesystem.ts";

export interface FileManagementModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (destinationPath: string) => Promise<boolean | void>;
  sourceFileName: string;
  sourceFileSize?: number;
  sourceType: "server" | "remote"; // "server" -> destinazione Robot; "remote" -> destinazione Server
  robotId: string;
  robotName?: string;
  initialPath?: string;
}

export const FileManagementModal: React.FC<FileManagementModalProps> = ({
  isOpen,
  onClose,
  onConfirm,
  sourceFileName,
  sourceFileSize,
  sourceType,
  robotId,
  robotName,
  initialPath = "/",
}) => {
  const modalRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Navigazione browser
  const [currentBrowserPath, setCurrentBrowserPath] = useState<string>(initialPath || "/");
  const [directories, setDirectories] = useState<DirectoryItem[]>([]);
  const [parentPath, setParentPath] = useState<string | null>(null);
  const [isLoadingDirs, setIsLoadingDirs] = useState<boolean>(false);
  const [browserError, setBrowserError] = useState<string | null>(null);

  // Inserimento manuale path & verifica
  const [manualPath, setManualPath] = useState<string>(initialPath || "/");
  const [clientValidationError, setClientValidationError] = useState<string | null>(null);
  const [verificationResult, setVerificationResult] = useState<PathVerificationResult | null>(null);
  const [isVerifying, setIsVerifying] = useState<boolean>(false);

  // Stato submit (anti-doppio clic)
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Normalizza percorso lato client
  const normalizeClientPath = (raw: string): string => {
    let p = raw.trim();
    if (!p) return "/";
    p = p.replace(/\\/g, "/");
    if (!p.startsWith("/")) p = "/" + p;
    // Rimuovi /./ e // multipli
    p = p.replace(/\/\.\//g, "/");
    p = p.replace(/\/+/g, "/");
    return p;
  };

  // Validazione sintattica client-side
  const validateSyntax = (p: string): string | null => {
    if (!p || p.trim() === "") {
      return "Il percorso non può essere vuoto.";
    }
    if (p.includes("\0")) {
      return "Il percorso contiene byte nulli o caratteri non consentiti.";
    }
    if (p.length > 4096) {
      return "La lunghezza del percorso supera il limite di 4096 caratteri.";
    }
    if (!p.trim().startsWith("/")) {
      return "Il percorso deve essere assoluto e iniziare con '/'.";
    }
    if (/(?:^|[\\/])\.\.(?:[\\/]|$)/.test(p) || /%2e%2e/i.test(p)) {
      return "Attraversamento directory ('..') non consentito.";
    }
    return null;
  };

  // Caricamento elenco sole directory dal server/robot
  const fetchDirectories = useCallback(
    async (pathParam: string) => {
      setIsLoadingDirs(true);
      setBrowserError(null);
      try {
        const endpoint =
          sourceType === "server"
            ? `/api/robots/${encodeURIComponent(robotId)}/fs/remote/directories?path=${encodeURIComponent(pathParam)}`
            : `/api/robots/${encodeURIComponent(robotId)}/fs/server/directories?path=${encodeURIComponent(pathParam)}`;

        const res = await apiClient.get(endpoint);
        const data = await res.json();
        if (res.ok) {
          setCurrentBrowserPath(data.currentPath || pathParam);
          setParentPath(data.parentPath !== undefined ? data.parentPath : null);
          setDirectories(Array.isArray(data.directories) ? data.directories : []);
        } else {
          const errFormatted = ErrorPresenter.formatError(data);
          setBrowserError(errFormatted.userMessage || "Impossibile caricare le directory.");
          setDirectories([]);
        }
      } catch (err: any) {
        const errFormatted = ErrorPresenter.formatError(err);
        setBrowserError(errFormatted.userMessage || "Errore di connessione durante la lettura delle cartelle.");
        setDirectories([]);
      } finally {
        setIsLoadingDirs(false);
      }
    },
    [sourceType, robotId]
  );

  // Verifica esistenza e scrivibilità lato server del percorso
  const verifyPathOnServer = useCallback(
    async (candidate: string) => {
      const syntaxErr = validateSyntax(candidate);
      if (syntaxErr) {
        setClientValidationError(syntaxErr);
        setVerificationResult(null);
        return;
      }
      setClientValidationError(null);
      setIsVerifying(true);

      try {
        const endpoint =
          sourceType === "server"
            ? `/api/robots/${encodeURIComponent(robotId)}/fs/remote/verify-path`
            : `/api/robots/${encodeURIComponent(robotId)}/fs/server/verify-path`;

        const res = await apiClient.post(endpoint, { path: candidate });
        const data = await res.json();
        if (res.ok) {
          setVerificationResult(data);
        } else {
          setVerificationResult({
            valid: false,
            exists: false,
            isDirectory: false,
            isWritable: false,
            resolvedPath: candidate,
            error: data.message || "Percorso non valido o non verificabile.",
          });
        }
      } catch (err: any) {
        setVerificationResult({
          valid: false,
          exists: false,
          isDirectory: false,
          isWritable: false,
          resolvedPath: candidate,
          error: "Errore di comunicazione durante la verifica del percorso.",
        });
      } finally {
        setIsVerifying(false);
      }
    },
    [sourceType, robotId]
  );

  // Inizializzazione all'apertura
  useEffect(() => {
    if (isOpen) {
      const startPath = initialPath || "/";
      setCurrentBrowserPath(startPath);
      setManualPath(startPath);
      setSubmitError(null);
      setIsSubmitting(false);
      fetchDirectories(startPath);
      verifyPathOnServer(startPath);
    }
  }, [isOpen, initialPath, fetchDirectories, verifyPathOnServer]);

  // Gestione focus trap e tasto Escape
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (!isSubmitting) onClose();
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
    // Focus automatico sul campo input
    setTimeout(() => inputRef.current?.focus(), 50);

    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, isSubmitting, onClose]);

  // Debounce per verifica manuale
  useEffect(() => {
    if (!isOpen) return;
    const timer = setTimeout(() => {
      if (manualPath.trim()) {
        verifyPathOnServer(manualPath.trim());
      }
    }, 350);
    return () => clearTimeout(timer);
  }, [manualPath, isOpen, verifyPathOnServer]);

  // Navigazione a una sottocartella tramite browser
  const handleNavigateSubfolder = (folderPath: string) => {
    const norm = normalizeClientPath(folderPath);
    setCurrentBrowserPath(norm);
    setManualPath(norm);
    fetchDirectories(norm);
    verifyPathOnServer(norm);
  };

  // Navigazione livello superiore
  const handleNavigateUp = () => {
    if (parentPath !== null) {
      const target = parentPath || "/";
      setCurrentBrowserPath(target);
      setManualPath(target);
      fetchDirectories(target);
      verifyPathOnServer(target);
    }
  };

  // Selezione esplicita della cartella corrente visualizzata nel browser
  const handleSelectCurrentBrowserFolder = () => {
    setManualPath(currentBrowserPath);
    verifyPathOnServer(currentBrowserPath);
  };

  // Modifica manuale del testo del percorso
  const handleManualPathChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setManualPath(val);
    const syntaxErr = validateSyntax(val);
    setClientValidationError(syntaxErr);
  };

  // Sincronizzazione da manuale verso browser al tasto Invio o blur
  const handleManualPathCommit = () => {
    if (!clientValidationError && manualPath.trim()) {
      const norm = normalizeClientPath(manualPath);
      setCurrentBrowserPath(norm);
      fetchDirectories(norm);
    }
  };

  // Conferma trasferimento
  const handleConfirm = async () => {
    if (isSubmitting) return;

    const syntaxErr = validateSyntax(manualPath);
    if (syntaxErr) {
      setClientValidationError(syntaxErr);
      return;
    }

    if (!verificationResult || !verificationResult.valid || !verificationResult.exists || !verificationResult.isWritable) {
      setSubmitError("Selezionare o inserire una cartella di destinazione valida ed esistente con permessi di scrittura.");
      return;
    }

    setIsSubmitting(true);
    setSubmitError(null);
    try {
      const outcome = await onConfirm(verificationResult.resolvedPath || manualPath.trim());
      if (outcome !== false) {
        onClose();
      }
    } catch (err: any) {
      const errFormatted = ErrorPresenter.formatError(err);
      setSubmitError(errFormatted.userMessage || "Errore durante l'avvio del trasferimento.");
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!isOpen) return null;

  const targetDescription =
    sourceType === "server"
      ? `Robot: ${robotName ? `${robotName} (${robotId})` : robotId} (Filesystem Remoto SFTP)`
      : `Server: Cartella associata al robot ${robotName ? `${robotName} (${robotId})` : robotId}`;

  const isConfirmDisabled =
    isSubmitting ||
    Boolean(clientValidationError) ||
    isVerifying ||
    !verificationResult ||
    !verificationResult.valid ||
    !verificationResult.exists ||
    !verificationResult.isDirectory ||
    !verificationResult.isWritable;

  // Costruzione segmenti breadcrumb
  const breadcrumbSegments = currentBrowserPath
    .split("/")
    .filter(Boolean)
    .reduce<Array<{ name: string; fullPath: string }>>((acc, seg, idx, arr) => {
      const fullPath = "/" + arr.slice(0, idx + 1).join("/");
      acc.push({ name: seg, fullPath });
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
        {/* Header */}
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

        {/* Body */}
        <div className="modal-body">
          {/* 1. Scheda dettagli file e destinazione */}
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
                  <span id="file-mgmt-target-desc" className="badge badge-info p-2 text-wrap text-start">
                    {targetDescription}
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* 2. Campo di testo inserimento manuale con validazione real-time */}
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
                  clientValidationError || (verificationResult && !verificationResult.isWritable)
                    ? "is-invalid"
                    : verificationResult?.isWritable
                    ? "is-valid"
                    : ""
                }`}
                placeholder="/es. cartella/destinazione"
                value={manualPath}
                onChange={handleManualPathChange}
                onBlur={handleManualPathCommit}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    handleManualPathCommit();
                  }
                }}
                disabled={isSubmitting}
                aria-describedby="manual-path-feedback"
              />
              <button
                type="button"
                className="btn btn-outline-secondary"
                id="btn-sync-browser-to-manual"
                title="Sincronizza browser sulla cartella digitata"
                onClick={handleManualPathCommit}
                disabled={isSubmitting || Boolean(clientValidationError)}
              >
                Esplora
              </button>
            </div>

            {/* Feedback di validazione sintattica e verifica server */}
            <div id="manual-path-feedback" className="mt-1 small">
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
              {!isVerifying && verificationResult && !clientValidationError && (
                <div>
                  {verificationResult.valid && verificationResult.exists && verificationResult.isWritable ? (
                    <div className="text-success fw-semibold" id="feedback-valid-path">
                      Cartella valida, esistente e scrivibile.
                    </div>
                  ) : (
                    <div className="text-danger fw-semibold" id="feedback-server-error">
                      {verificationResult.error || "Percorso non valido o privo di permessi di scrittura."}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* 3. Browser visivo di selezione cartelle */}
          <div className="card border">
            <div className="card-header bg-white d-flex align-items-center justify-content-between p-2 flex-wrap gap-2">
              <div className="d-flex align-items-center gap-2 flex-grow-1">
                <button
                  type="button"
                  id="btn-browser-up"
                  className="btn btn-outline-secondary btn-sm"
                  onClick={handleNavigateUp}
                  disabled={isSubmitting || parentPath === null || currentBrowserPath === "/"}
                  title="Torna alla cartella superiore"
                >
                  Livello superiore (..)
                </button>
                <nav aria-label="Percorso cartella" className="ms-1">
                  <ol className="breadcrumb mb-0 py-1 px-2 bg-light rounded" style={{ fontSize: "0.85rem" }}>
                    <li className={`breadcrumb-item ${breadcrumbSegments.length === 0 ? "active" : ""}`}>
                      {breadcrumbSegments.length === 0 ? (
                        <strong>/ (root)</strong>
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
                onClick={handleSelectCurrentBrowserFolder}
                disabled={isSubmitting}
              >
                Seleziona questa cartella
              </button>
            </div>

            {/* Lista directory caricate */}
            <div
              className="card-body p-0"
              style={{ maxHeight: 220, minHeight: 140, overflowY: "auto", position: "relative" }}
            >
              {isLoadingDirs ? (
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
                  Nessuna sottocartella presente in questo percorso.
                </div>
              ) : (
                <ul className="list-group list-group-flush mb-0" id="browser-dirs-list">
                  {directories.map((dir) => (
                    <li
                      key={dir.path}
                      className="list-group-item list-group-item-action d-flex align-items-center justify-content-between py-2 px-3"
                      style={{ cursor: "pointer" }}
                      onClick={() => handleNavigateSubfolder(dir.path)}
                    >
                      <div className="d-flex align-items-center gap-2">
                        <span className="badge badge-info" aria-hidden="true">
                          Dir
                        </span>
                        <span className="fw-semibold text-primary">{dir.name}/</span>
                      </div>
                      <span className="small text-muted">Apri</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          {/* Messaggio errore finale submit */}
          {submitError && (
            <div className="alert alert-danger mt-3 mb-0 p-2" role="alert" id="file-mgmt-submit-error">
              {submitError}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="modal-footer d-flex justify-content-between">
          <small className="text-muted">
            Il file verrà salvato nella cartella specificata.
          </small>
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
                  Trasferimento in corso...
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
