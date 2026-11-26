import React, { useState, useEffect, useLayoutEffect, useRef } from "react";
import type { RobotSummaryDto, EditRobotPayload } from "../../types/fleet.ts";

interface RobotEditModalProps {
  robot: RobotSummaryDto | null;
  isOpen: boolean;
  onClose: () => void;
  onUpdate: (robotId: string, payload: EditRobotPayload) => Promise<boolean>;
  isAdmin?: boolean;
  onDeleteServerData?: (robotId: string) => Promise<boolean>;
}

export const RobotEditModal: React.FC<RobotEditModalProps> = ({
  robot,
  isOpen,
  onClose,
  onUpdate,
  isAdmin = false,
  onDeleteServerData,
}) => {
  const [displayName, setDisplayName] = useState<string>("");
  const [host, setHost] = useState<string>("");
  const [sshPort, setSshPort] = useState<number>(22);
  const [sshAuthMethod, setSshAuthMethod] = useState<"password" | "key">("password");
  const [password, setPassword] = useState<string>("");
  const [privateKey, setPrivateKey] = useState<string>("");
  const [fingerprint, setFingerprint] = useState<string>("");
  const [remoteMonitoringPath, setRemoteMonitoringPath] = useState<string>("");
  const [customerName, setCustomerName] = useState<string>("");
  const [plantName, setPlantName] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [showDeleteServerDataConfirm, setShowDeleteServerDataConfirm] = useState<boolean>(false);
  const [deletingServerData, setDeletingServerData] = useState<boolean>(false);
  const [deleteServerDataSuccess, setDeleteServerDataSuccess] = useState<string | null>(null);

  const dialogRef = useRef<HTMLDivElement>(null);
  const firstInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (robot) {
      setDisplayName(robot.displayName);
      setHost(robot.host);
      setSshPort(robot.sshPort);
      setSshAuthMethod(robot.sshAuthMethod || "password");
      setPassword("");
      setPrivateKey("");
      setFingerprint("");
      setRemoteMonitoringPath(
        (robot as any).remoteMonitoringPath || ((robot as any).stateFilePaths?.[0] ?? "")
      );
      setCustomerName(robot.customerName ?? "");
      setPlantName(robot.plantName ?? "");
      setError(null);
      setIsSubmitting(false);
      setShowDeleteServerDataConfirm(false);
      setDeletingServerData(false);
      setDeleteServerDataSuccess(null);
    }
  }, [robot]);

  useLayoutEffect(() => {
    if (!isOpen || !robot) return;
    const previous = document.activeElement;
    firstInputRef.current?.focus({ preventScroll: true });
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) {
        previous.focus({ preventScroll: true });
      }
    };
  }, [isOpen, robot]);

  useEffect(() => {
    if (!isOpen || !robot) return undefined;
    const onKeyDown = (ev: KeyboardEvent) => {
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusedDialog = ev.target instanceof Element ? ev.target.closest(".modal") : null;
      if (focusedDialog && focusedDialog !== dialog) return;
      if (ev.key === "Escape" && !isSubmitting) {
        ev.preventDefault();
        onClose();
      }
      if (ev.key !== "Tab" || ev.defaultPrevented) return;
      const controls = Array.from(dialog.querySelectorAll<HTMLElement>(
        "button:not(:disabled), input:not(:disabled):not([type=hidden]), select:not(:disabled), textarea:not(:disabled), a[href], summary, [tabindex]"
      )).filter((element) => {
        if (element.tabIndex < 0 || !element.getClientRects().length) return false;
        const collapsed = element.closest("details:not([open])");
        return !collapsed || collapsed.querySelector(":scope > summary") === element;
      });
      const first = controls[0];
      const last = controls.at(-1);
      const active = document.activeElement;
      if (!controls.some((control) => control === active) || active === (ev.shiftKey ? first : last)) {
        ev.preventDefault();
        (ev.shiftKey ? last : first)?.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isOpen, robot, isSubmitting, onClose]);

  if (!isOpen || !robot) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;
    setError(null);

    const trimmedCustomer = customerName.trim();
    if (!trimmedCustomer) {
      setError("Il Nome Cliente è obbligatorio.");
      return;
    }

    const payload: EditRobotPayload = {
      displayName: displayName.trim(),
      host: host.trim(),
      sshPort: Number(sshPort),
      sshAuthMethod,
      customerName: trimmedCustomer,
      plantName: plantName.trim(),
      password: password ? password : undefined,
      privateKey: privateKey.trim() ? privateKey.trim() : undefined,
      hostKeyVerification: fingerprint.trim()
        ? {
            fingerprint: fingerprint.trim(),
            strictHostKeyChecking: true,
          }
        : undefined,
      remoteMonitoringPath: remoteMonitoringPath.trim() ? remoteMonitoringPath.trim() : undefined,
    };

    setIsSubmitting(true);
    let success = false;
    try {
      success = await onUpdate(robot.id, payload);
    } finally {
      setIsSubmitting(false);
    }
    if (success) {
      onClose();
    } else {
      setError("Impossibile aggiornare la configurazione del robot.");
    }
  };

  return (
    <div ref={dialogRef} id="modal-robot-edit" className="modal" role="dialog" aria-modal="true" aria-labelledby="edit-robot-title">
      <div className="modal-content modal-large modal-register">
        <div className="modal-header modal-register-header">
          <h3 id="edit-robot-title">Modifica Configurazione Robot</h3>
          <div className="modal-register-actions">
            <button
              type="submit"
              form="form-edit-robot"
              className="btn btn-primary"
              id="btn-submit-edit"
              disabled={isSubmitting}
              aria-busy={isSubmitting}
              data-pending={isSubmitting ? "true" : undefined}
            >
              {isSubmitting ? (
                <>
                  <span className="btn-spinner" aria-hidden="true" /> Salvataggio...
                </>
              ) : (
                "Salva Modifiche"
              )}
            </button>
            <button
              type="button"
              className="btn-close"
              id="btn-close-edit"
              onClick={onClose}
              disabled={isSubmitting}
              aria-label="Annulla"
            />
          </div>
        </div>

        <div className="modal-body modal-register-body">
          {error && (
            <div className="error-message mb-4" role="alert">
              {error}
            </div>
          )}

          <form id="form-edit-robot" onSubmit={handleSubmit}>
            <input type="hidden" id="edit-robotId" name="editRobotId" value={robot.id} />
            <div className="form-grid">
              <div className="form-group">
                <label htmlFor="edit-displayName">
                  Nome visualizzato <span className="required">*</span>:
                </label>
                <input
                  type="text"
                  id="edit-displayName"
                  ref={firstInputRef}
                  name="displayName"
                  required
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                />
              </div>

              <div className="form-group">
                <label htmlFor="edit-remoteUsername">
                  Username remoto (Immutabile):
                </label>
                <input
                  type="text"
                  id="edit-remoteUsername"
                  name="remoteUsername"
                  disabled
                  value={robot.remoteUsername}
                  title="Il cambio di username remoto non è consentito perché associato alla directory del server"
                />
              </div>

              <div className="form-group">
                <label htmlFor="edit-customerName">
                  Nome Cliente <span className="required">*</span>:
                </label>
                <input
                  type="text"
                  id="edit-customerName"
                  name="customerName"
                  required
                  placeholder="es. Acme Industries"
                  value={customerName}
                  onChange={(e) => setCustomerName(e.target.value)}
                />
              </div>

              <div className="form-group">
                <label htmlFor="edit-plantName">Nome Impianto (opzionale):</label>
                <input
                  type="text"
                  id="edit-plantName"
                  name="plantName"
                  placeholder="es. Milano HQ"
                  value={plantName}
                  onChange={(e) => setPlantName(e.target.value)}
                />
              </div>

              <div className="form-group">
                <label htmlFor="edit-host">
                  Hostname o IP <span className="required">*</span>:
                </label>
                <input
                  type="text"
                  id="edit-host"
                  name="host"
                  required
                  value={host}
                  onChange={(e) => setHost(e.target.value)}
                />
              </div>

              <div className="form-group">
                <label htmlFor="edit-sshPort">
                  Porta SSH <span className="required">*</span>:
                </label>
                <input
                  type="number"
                  id="edit-sshPort"
                  name="sshPort"
                  required
                  min="1"
                  max="65535"
                  value={sshPort}
                  onChange={(e) => setSshPort(Number(e.target.value))}
                />
              </div>

              <div className="form-group">
                <label htmlFor="edit-sshAuthMethod">Metodo SSH:</label>
                <select
                  id="edit-sshAuthMethod"
                  name="sshAuthMethod"
                  value={sshAuthMethod}
                  onChange={(e) => setSshAuthMethod(e.target.value as "password" | "key")}
                >
                  <option value="password">Password</option>
                  <option value="key">Chiave Privata</option>
                </select>
              </div>

              {sshAuthMethod === "password" ? (
                <div className="form-group" id="edit-group-password">
                  <label htmlFor="edit-password">
                    Nuova password (lasciare vuoto per mantenere):
                  </label>
                  <input
                    type="password"
                    id="edit-password"
                    name="password"
                    autoComplete="new-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </div>
              ) : (
                <div className="form-group full-width" id="edit-group-key">
                  <label htmlFor="edit-privateKey">
                    Nuova chiave privata (lasciare vuoto per mantenere):
                  </label>
                  <textarea
                    id="edit-privateKey"
                    name="privateKey"
                    rows={3}
                    value={privateKey}
                    onChange={(e) => setPrivateKey(e.target.value)}
                  />
                </div>
              )}

              <div className="form-group full-width">
                <label htmlFor="edit-fingerprint">
                  Impronta crittografica SHA256 attesa:
                </label>
                <input
                  type="text"
                  id="edit-fingerprint"
                  name="fingerprint"
                  value={fingerprint}
                  onChange={(e) => setFingerprint(e.target.value)}
                />
              </div>

              <div className="form-group full-width">
                <label htmlFor="edit-monitoringPath">
                  Percorso file di stato:
                </label>
                <input
                  type="text"
                  id="edit-monitoringPath"
                  name="remoteMonitoringPath"
                  placeholder="es. /etc/os-release"
                  value={remoteMonitoringPath}
                  onChange={(e) => setRemoteMonitoringPath(e.target.value)}
                />
              </div>
            </div>

            {isAdmin && onDeleteServerData && (
              <div className="card mt-4 border-danger p-3 bg-light" id="section-delete-server-data">
                <h5 className="text-danger mb-2">Eliminazione Dati Server (RF-ROB-013)</h5>
                <p className="small text-muted mb-3">
                  Elimina definitivamente l'intera cartella e tutti i file archiviati sul filesystem del server per questo robot.
                  Questa operazione è irreversibile e riservata esclusivamente agli amministratori.
                </p>
                {deleteServerDataSuccess && (
                  <div className="alert alert-success py-2 mb-2" id="alert-server-data-deleted">
                    {deleteServerDataSuccess}
                  </div>
                )}
                {!showDeleteServerDataConfirm ? (
                  <button
                    type="button"
                    className="btn btn-outline-danger btn-sm"
                    id="btn-delete-server-data"
                    onClick={() => setShowDeleteServerDataConfirm(true)}
                  >
                    Elimina dati sul server
                  </button>
                ) : (
                  <div className="p-2 border border-danger rounded bg-white">
                    <p className="text-danger fw-bold small mb-2">
                      Confermi l'eliminazione definitiva di tutti i dati del robot sul server?
                    </p>
                    <div className="d-flex gap-2">
                      <button
                        type="button"
                        className="btn btn-danger btn-sm"
                        id="btn-confirm-delete-server-data"
                        disabled={deletingServerData}
                        onClick={async () => {
                          setDeletingServerData(true);
                          try {
                            const ok = await onDeleteServerData(robot.id);
                            if (ok) {
                              setDeleteServerDataSuccess("Dati server del robot eliminati con successo.");
                              setShowDeleteServerDataConfirm(false);
                            } else {
                              setError("Errore durante l'eliminazione dei dati server.");
                            }
                          } finally {
                            setDeletingServerData(false);
                          }
                        }}
                      >
                        {deletingServerData ? "Eliminazione..." : "Conferma Eliminazione Dati Server"}
                      </button>
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        id="btn-cancel-delete-server-data"
                        disabled={deletingServerData}
                        onClick={() => setShowDeleteServerDataConfirm(false)}
                      >
                        Annulla
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </form>
        </div>
      </div>
    </div>
  );
};
