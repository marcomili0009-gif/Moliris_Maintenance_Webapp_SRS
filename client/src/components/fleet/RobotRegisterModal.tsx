import React, { useState } from "react";
import type { RegisterRobotPayload, RegistrationOutcome } from "../../types/fleet.ts";
import type { FormattedError } from "../../types/error.ts";
import { DoubleSubmitButton } from "../common/DoubleSubmitButton.tsx";

interface RobotRegisterModalProps {
  isOpen: boolean;
  onClose: () => void;
  onRegister: (
    payload: RegisterRobotPayload
  ) => Promise<{ outcome?: RegistrationOutcome; error?: FormattedError; fieldErrors?: Record<string, string> }>;
  onRegistrationSuccess: (outcome: RegistrationOutcome) => void;
}

export const RobotRegisterModal: React.FC<RobotRegisterModalProps> = ({
  isOpen,
  onClose,
  onRegister,
  onRegistrationSuccess,
}) => {
  const [displayName, setDisplayName] = useState<string>("");
  const [id, setId] = useState<string>("");
  const [remoteUsername, setRemoteUsername] = useState<string>("");
  const [host, setHost] = useState<string>("");
  const [sshPort, setSshPort] = useState<number>(22);
  const [sshAuthMethod, setSshAuthMethod] = useState<"password" | "key">("password");
  const [password, setPassword] = useState<string>("");
  const [privateKey, setPrivateKey] = useState<string>("");
  const [passphrase, setPassphrase] = useState<string>("");
  const [fingerprint, setFingerprint] = useState<string>("");
  const [knownHostsPath, setKnownHostsPath] = useState<string>("");
  const [customerName, setCustomerName] = useState<string>("");
  const [plantName, setPlantName] = useState<string>("");
  const [remoteMonitoringPath, setRemoteMonitoringPath] = useState<string>("");
  const [sftpHost, setSftpHost] = useState<string>("");
  const [sftpPort, setSftpPort] = useState<string>("");
  const [sftpUser, setSftpUser] = useState<string>("");

  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [generalError, setGeneralError] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFieldErrors({});
    setGeneralError(null);

    // Validazione client preventiva obbligatoria (RF-ROB-005)
    const errors: Record<string, string> = {};
    if (!displayName.trim()) errors["displayName"] = "Il nome visualizzato è obbligatorio.";
    if (!id.trim()) errors["id"] = "L'identificativo interno è obbligatorio.";
    if (id.includes("_")) errors["id"] = "L'ID non può contenere il carattere underscore (_).";
    if (!remoteUsername.trim()) errors["remoteUsername"] = "Lo username remoto è obbligatorio.";
    if (!host.trim()) errors["host"] = "L'hostname o indirizzo IP è obbligatorio.";
    if (!sshPort || sshPort < 1 || sshPort > 65535) errors["sshPort"] = "La porta SSH deve essere compresa tra 1 e 65535.";

    if (sshAuthMethod === "password" && !password) {
      errors["password"] = "La password è obbligatoria per il metodo password.";
    }
    if (sshAuthMethod === "key" && !privateKey.trim()) {
      errors["privateKey"] = "La chiave privata SSH (PEM) è obbligatoria per il metodo chiave.";
    }

    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      return;
    }

    const payload: RegisterRobotPayload = {
      displayName: displayName.trim(),
      id: id.trim(),
      remoteUsername: remoteUsername.trim(),
      host: host.trim(),
      sshPort: Number(sshPort),
      sshAuthMethod,
      customerName: customerName.trim() || undefined,
      plantName: plantName.trim() || undefined,
      password: sshAuthMethod === "password" ? password : undefined,
      privateKey: sshAuthMethod === "key" ? privateKey : undefined,
      passphrase: sshAuthMethod === "key" && passphrase ? passphrase : undefined,
      fingerprint: fingerprint.trim() || undefined,
      knownHostsPath: knownHostsPath.trim() || undefined,
      strictHostKeyChecking: true,
      remoteMonitoringPath: remoteMonitoringPath.trim() || undefined,
      sftpHost: sftpHost.trim() || undefined,
      sftpPort: sftpPort ? Number(sftpPort) : undefined,
      sftpUser: sftpUser.trim() || undefined,
    };

    const res = await onRegister(payload);
    if (res.outcome) {
      onClose();
      onRegistrationSuccess(res.outcome);
    } else {
      if (res.fieldErrors) {
        setFieldErrors(res.fieldErrors);
      }
      if (res.error) {
        setGeneralError(res.error.userMessage);
      }
    }
  };

  return (
    <div id="modal-robot-register" className="modal" role="dialog" aria-modal="true">
      <div className="modal-content modal-large">
        <div className="modal-header">
          <h3>Registrazione Nuovo Robot</h3>
          <button
            type="button"
            className="btn-close"
            id="btn-close-register"
            onClick={onClose}
          >
            &times;
          </button>
        </div>

        <div className="modal-body">
          {generalError && (
            <div className="error-message mb-4" role="alert">
              {generalError}
            </div>
          )}

          <form id="form-register-robot" onSubmit={handleSubmit}>
            <div className="form-grid">
              <div className="form-group">
                <label htmlFor="reg-displayName">
                  Nome visualizzato <span className="required">*</span>:
                </label>
                <input
                  type="text"
                  id="reg-displayName"
                  name="displayName"
                  required
                  placeholder="es. Robot Ispettivo 1"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                />
                <div className="field-error" id="err-displayName">
                  {fieldErrors["displayName"]}
                </div>
              </div>

              <div className="form-group">
                <label htmlFor="reg-id">
                  Identificativo interno univoco <span className="required">*</span>:
                </label>
                <input
                  type="text"
                  id="reg-id"
                  name="id"
                  required
                  placeholder="es. robot-01"
                  value={id}
                  onChange={(e) => setId(e.target.value)}
                />
                <div className="field-error" id="err-id">
                  {fieldErrors["id"]}
                </div>
              </div>

              <div className="form-group">
                <label htmlFor="reg-remoteUsername">
                  Username remoto <span className="required">*</span>:
                </label>
                <input
                  type="text"
                  id="reg-remoteUsername"
                  name="remoteUsername"
                  required
                  placeholder="es. moliris_op"
                  value={remoteUsername}
                  onChange={(e) => setRemoteUsername(e.target.value)}
                />
                <div className="field-error" id="err-remoteUsername">
                  {fieldErrors["remoteUsername"]}
                </div>
              </div>

              <div className="form-group">
                <label htmlFor="reg-customerName">Nome Cliente (opzionale):</label>
                <input
                  type="text"
                  id="reg-customerName"
                  name="customerName"
                  placeholder="es. Acme Industries"
                  value={customerName}
                  onChange={(e) => setCustomerName(e.target.value)}
                />
              </div>

              <div className="form-group">
                <label htmlFor="reg-plantName">Nome Impianto (opzionale):</label>
                <input
                  type="text"
                  id="reg-plantName"
                  name="plantName"
                  placeholder="es. Milano HQ"
                  value={plantName}
                  onChange={(e) => setPlantName(e.target.value)}
                />
              </div>

              <div className="form-group">
                <label htmlFor="reg-host">
                  Hostname o Indirizzo IP <span className="required">*</span>:
                </label>
                <input
                  type="text"
                  id="reg-host"
                  name="host"
                  required
                  placeholder="es. 192.168.1.10 o robot1.local"
                  value={host}
                  onChange={(e) => setHost(e.target.value)}
                />
                <div className="field-error" id="err-host">
                  {fieldErrors["host"]}
                </div>
              </div>

              <div className="form-group">
                <label htmlFor="reg-sshPort">
                  Porta SSH <span className="required">*</span> (default 22):
                </label>
                <input
                  type="number"
                  id="reg-sshPort"
                  name="sshPort"
                  required
                  min="1"
                  max="65535"
                  value={sshPort}
                  onChange={(e) => setSshPort(Number(e.target.value))}
                />
                <div className="field-error" id="err-sshPort">
                  {fieldErrors["sshPort"]}
                </div>
              </div>

              <div className="form-group">
                <label htmlFor="reg-sshAuthMethod">
                  Metodo di autenticazione SSH <span className="required">*</span>:
                </label>
                <select
                  id="reg-sshAuthMethod"
                  name="sshAuthMethod"
                  required
                  value={sshAuthMethod}
                  onChange={(e) => setSshAuthMethod(e.target.value as "password" | "key")}
                >
                  <option value="password">Password</option>
                  <option value="key">Chiave Privata SSH</option>
                </select>
                <div className="field-error" id="err-sshAuthMethod">
                  {fieldErrors["sshAuthMethod"]}
                </div>
              </div>

              {/* Dynamic Credentials */}
              {sshAuthMethod === "password" ? (
                <div className="form-group full-width" id="group-password">
                  <label htmlFor="reg-password">
                    Password di accesso remoto <span className="required">*</span>:
                  </label>
                  <input
                    type="password"
                    id="reg-password"
                    name="password"
                    autoComplete="new-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                  <div className="field-error" id="err-password">
                    {fieldErrors["password"]}
                  </div>
                </div>
              ) : (
                <div className="form-group full-width" id="group-key">
                  <label htmlFor="reg-privateKey">
                    Chiave privata SSH (PEM) <span className="required">*</span>:
                  </label>
                  <textarea
                    id="reg-privateKey"
                    name="privateKey"
                    rows={4}
                    placeholder="-----BEGIN OPENSSH PRIVATE KEY-----..."
                    value={privateKey}
                    onChange={(e) => setPrivateKey(e.target.value)}
                  />
                  <label htmlFor="reg-passphrase" style={{ marginTop: "0.5rem", display: "block" }}>
                    Passphrase chiave (opzionale):
                  </label>
                  <input
                    type="password"
                    id="reg-passphrase"
                    name="passphrase"
                    autoComplete="new-password"
                    value={passphrase}
                    onChange={(e) => setPassphrase(e.target.value)}
                  />
                  <div className="field-error" id="err-privateKey">
                    {fieldErrors["privateKey"]}
                  </div>
                </div>
              )}

              {/* Host Key Verification */}
              <div className="form-group full-width">
                <fieldset className="form-fieldset">
                  <legend>Verifica crittografica chiave host SSH (RNF-SEC-003) <span className="required">*</span></legend>
                  <div className="form-group">
                    <label htmlFor="reg-fingerprint">Impronta crittografica SHA256 attesa:</label>
                    <input
                      type="text"
                      id="reg-fingerprint"
                      name="fingerprint"
                      placeholder="es. SHA256:4y+0w... o esadecimale"
                      value={fingerprint}
                      onChange={(e) => setFingerprint(e.target.value)}
                    />
                    <small className="field-hint">Necessaria per la verifica rigorosa senza fidarsi di host sconosciuti.</small>
                    <div className="field-error" id="err-hostKeyVerification">
                      {fieldErrors["hostKeyVerification"] || fieldErrors["fingerprint"]}
                    </div>
                  </div>

                  <div className="form-group">
                    <label htmlFor="reg-knownHosts">Percorso file known_hosts locale al server (alternativo):</label>
                    <input
                      type="text"
                      id="reg-knownHosts"
                      name="knownHostsPath"
                      placeholder="/etc/moliris/known_hosts"
                      value={knownHostsPath}
                      onChange={(e) => setKnownHostsPath(e.target.value)}
                    />
                  </div>

                  <div className="form-check">
                    <input
                      type="checkbox"
                      id="reg-strictHostKey"
                      name="strictHostKeyChecking"
                      checked
                      disabled
                    />
                    <label htmlFor="reg-strictHostKey">
                      StrictHostKeyChecking (Sempre attivo, RNF-SEC-003 vieta bypass)
                    </label>
                  </div>
                </fieldset>
              </div>

              {/* Monitoring Path */}
              <div className="form-group full-width">
                <label htmlFor="reg-remoteMonitoringPath">Percorso remoto file di stato del robot (opzionale):</label>
                <input
                  type="text"
                  id="reg-remoteMonitoringPath"
                  name="remoteMonitoringPath"
                  placeholder="es. /opt/moliris/status/robot.txt"
                  value={remoteMonitoringPath}
                  onChange={(e) => setRemoteMonitoringPath(e.target.value)}
                />
                <div className="field-error" id="err-remoteMonitoringPath">
                  {fieldErrors["remoteMonitoringPath"]}
                </div>
              </div>

              {/* SFTP Parameters */}
              <div className="form-group full-width">
                <details>
                  <summary style={{ cursor: "pointer", fontWeight: 500, marginBottom: "0.5rem" }}>
                    Parametri di accesso SFTP (SOLO se differenti da SSH)
                  </summary>
                  <div className="sftp-subgrid">
                    <div className="form-group">
                      <label htmlFor="reg-sftpHost">Host SFTP:</label>
                      <input
                        type="text"
                        id="reg-sftpHost"
                        name="sftpHost"
                        placeholder="Lasciare vuoto se uguale a SSH"
                        value={sftpHost}
                        onChange={(e) => setSftpHost(e.target.value)}
                      />
                    </div>
                    <div className="form-group">
                      <label htmlFor="reg-sftpPort">Porta SFTP:</label>
                      <input
                        type="number"
                        id="reg-sftpPort"
                        name="sftpPort"
                        placeholder="Lasciare vuoto se uguale a SSH"
                        value={sftpPort}
                        onChange={(e) => setSftpPort(e.target.value)}
                      />
                    </div>
                    <div className="form-group">
                      <label htmlFor="reg-sftpUser">Username SFTP:</label>
                      <input
                        type="text"
                        id="reg-sftpUser"
                        name="sftpUser"
                        placeholder="Lasciare vuoto se uguale a SSH"
                        value={sftpUser}
                        onChange={(e) => setSftpUser(e.target.value)}
                      />
                    </div>
                  </div>
                </details>
              </div>
            </div>

            <div className="modal-footer">
              <button
                type="button"
                className="btn btn-secondary"
                id="btn-cancel-register"
                onClick={onClose}
              >
                Annulla
              </button>
              <DoubleSubmitButton
                type="submit"
                className="btn btn-primary"
                id="btn-submit-register"
                pendingText="Registrazione..."
              >
                Registra Robot
              </DoubleSubmitButton>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
};
