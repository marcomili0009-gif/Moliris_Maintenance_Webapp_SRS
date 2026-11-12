import React, { useState, useEffect } from "react";
import type { RobotSummaryDto, EditRobotPayload } from "../../types/fleet.ts";
import { DoubleSubmitButton } from "../common/DoubleSubmitButton.tsx";

interface RobotEditModalProps {
  robot: RobotSummaryDto | null;
  isOpen: boolean;
  onClose: () => void;
  onUpdate: (robotId: string, payload: EditRobotPayload) => Promise<boolean>;
}

export const RobotEditModal: React.FC<RobotEditModalProps> = ({
  robot,
  isOpen,
  onClose,
  onUpdate,
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

  useEffect(() => {
    if (robot) {
      setDisplayName(robot.displayName);
      setHost(robot.host);
      setSshPort(robot.sshPort);
      setPassword("");
      setPrivateKey("");
      setFingerprint("");
      setRemoteMonitoringPath("");
      setCustomerName(robot.customerName ?? "");
      setPlantName(robot.plantName ?? "");
      setError(null);
    }
  }, [robot]);

  if (!isOpen || !robot) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const payload: EditRobotPayload = {
      displayName: displayName.trim(),
      host: host.trim(),
      sshPort: Number(sshPort),
      sshAuthMethod,
      customerName: customerName.trim() || undefined,
      plantName: plantName.trim() || undefined,
      password: password ? password : undefined,
      privateKey: privateKey.trim() ? privateKey.trim() : undefined,
      fingerprint: fingerprint.trim() ? fingerprint.trim() : undefined,
      remoteMonitoringPath: remoteMonitoringPath.trim() ? remoteMonitoringPath.trim() : undefined,
    };

    const success = await onUpdate(robot.id, payload);
    if (success) {
      onClose();
    } else {
      setError("Impossibile aggiornare la configurazione del robot.");
    }
  };

  return (
    <div id="modal-robot-edit" className="modal" role="dialog" aria-modal="true">
      <div className="modal-content modal-large">
        <div className="modal-header">
          <h3>Modifica Configurazione Robot</h3>
          <button
            type="button"
            className="btn-close"
            id="btn-close-edit"
            onClick={onClose}
          >
            &times;
          </button>
        </div>

        <div className="modal-body">
          {error && <div className="error-message mb-3">{error}</div>}

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
                <label htmlFor="edit-customerName">Nome Cliente (opzionale):</label>
                <input
                  type="text"
                  id="edit-customerName"
                  name="customerName"
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
                  value={remoteMonitoringPath}
                  onChange={(e) => setRemoteMonitoringPath(e.target.value)}
                />
              </div>
            </div>

            <div className="modal-footer">
              <button
                type="button"
                className="btn btn-secondary"
                id="btn-cancel-edit"
                onClick={onClose}
              >
                Annulla
              </button>
              <DoubleSubmitButton
                type="submit"
                className="btn btn-primary"
                id="btn-submit-edit"
                pendingText="Salvataggio..."
              >
                Salva Modifiche
              </DoubleSubmitButton>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
};
