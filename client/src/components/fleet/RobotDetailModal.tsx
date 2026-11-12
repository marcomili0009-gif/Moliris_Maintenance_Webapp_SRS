import React from "react";
import type { RobotDetailDto } from "../../types/fleet.ts";
import { StatusBadge } from "../common/StatusBadge.tsx";
import { StateFormatter } from "../../services/state-formatter.ts";

const FEATURE_LABELS: Record<string, string> = {
  monitoring: "Monitoraggio Stato",
  terminal: "Terminale Remoto PTY",
  remoteFs: "Filesystem Remoto SFTP",
  serverFs: "Archivio Server Dedicato",
  transfer: "Trasferimenti File",
  statusRefresh: "Aggiornamento Stato",
  configure: "Configurazione",
  disable: "Disabilitazione",
  enable: "Abilitazione",
  remove: "Rimozione",
};

interface RobotDetailModalProps {
  robot: RobotDetailDto | null;
  isOpen: boolean;
  onClose: () => void;
}

export const RobotDetailModal: React.FC<RobotDetailModalProps> = ({
  robot,
  isOpen,
  onClose,
}) => {
  if (!isOpen || !robot) return null;

  return (
    <div id="modal-robot-detail" className="modal" role="dialog" aria-modal="true">
      <div className="modal-content modal-large">
        <div className="modal-header">
          <h3 id="detail-title">Dettaglio Robot: {robot.displayName}</h3>
          <button
            type="button"
            className="btn-close"
            id="btn-close-detail"
            onClick={onClose}
          >
            &times;
          </button>
        </div>

        <div className="modal-body" id="detail-body">
          <div className="detail-grid" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem" }}>
            <div className="detail-card card">
              <h4>Anagrafica e Connessione</h4>
              <p><strong>Identificativo (ID):</strong> <code>{robot.id}</code></p>
              <p><strong>Nome Visualizzato:</strong> {robot.displayName}</p>
              <p><strong>Host / IP:</strong> {robot.host}</p>
              <p><strong>Porta SSH:</strong> {robot.sshPort}</p>
              <p><strong>Username Remoto:</strong> {robot.remoteUsername}</p>
              <p><strong>Metodo Autenticazione:</strong> {robot.sshAuthMethod}</p>
              <p><strong>Directory Server Dedicata:</strong> <code>{robot.serverDirectoryPath}</code></p>
            </div>

            <div className="detail-card card">
              <h4>Stati di Sistema</h4>
              <p>
                <strong>Stato Anagrafico:</strong>{" "}
                <StatusBadge type="anagraphic" state={robot.anagraphicState} />
              </p>
              <p>
                <strong>Stato Connessione:</strong>{" "}
                <StatusBadge type="connection" state={robot.connectionState} />
              </p>
              <p>
                <strong>Stato Operativo:</strong>{" "}
                <StatusBadge
                  type="operational"
                  operationalData={robot.operationalState}
                  isStale={robot.isStale}
                />
              </p>
              <p>
                <strong>Ultimo Aggiornamento Valido:</strong>{" "}
                {StateFormatter.formatDate(robot.lastValidUpdateAt)}
              </p>
              <p>
                <strong>Esito Ultimo Tentativo:</strong>{" "}
                {robot.lastAttemptOutcome ? (
                  <span className={`badge-status ${robot.lastAttemptOutcome.success ? "badge-attivo" : "badge-errore"}`}>
                    {robot.lastAttemptOutcome.success ? "Riuscito" : "Fallito"} (
                    {StateFormatter.formatDate(robot.lastAttemptOutcome.timestamp)})
                    {!robot.lastAttemptOutcome.success &&
                      `: ${robot.lastAttemptOutcome.diagnosticMessage || robot.lastAttemptOutcome.errorCode || "Anomalia rilevata"}`}
                  </span>
                ) : (
                  "-"
                )}
              </p>
            </div>
          </div>

          <div className="features-section mt-4">
            <h4>Funzionalità del Robot</h4>
            <div className="features-grid">
              {robot.features ? (
                Object.entries(robot.features).map(([key, val]) => (
                  <div
                    key={key}
                    className={`feature-card ${val.available ? "feature-enabled" : "feature-disabled"}`}
                  >
                    <div className="feature-title">
                      <span>{FEATURE_LABELS[key] || key.toUpperCase()}</span>
                      <span className={`badge-status ${val.available ? "badge-attivo" : "badge-errore"}`}>
                        {val.available ? "Disponibile" : "Non disponibile"}
                      </span>
                    </div>
                    {!val.available && val.reason && (
                      <div className="feature-reason">
                        {val.reason}
                      </div>
                    )}
                  </div>
                ))
              ) : (
                <p className="text-muted small">Nessuna informazione sulle funzionalità disponibile.</p>
              )}
            </div>
          </div>
        </div>

        <div className="modal-footer">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Chiudi
          </button>
        </div>
      </div>
    </div>
  );
};
