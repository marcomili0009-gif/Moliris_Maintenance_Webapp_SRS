import React from "react";
import type { RobotDetailDto } from "../../types/fleet.ts";
import { StatusBadge } from "../common/StatusBadge.tsx";
import { StateFormatter } from "../../services/state-formatter.ts";

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
              <h4>Stati di Sistema (§10.2)</h4>
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
                <span
                  dangerouslySetInnerHTML={{
                    __html: StateFormatter.renderLastAttemptOutcome(robot.lastAttemptOutcome),
                  }}
                />
              </p>
            </div>
          </div>

          <div className="features-section mt-4">
            <h4>Funzionalità del Robot (RF-ROB-011)</h4>
            <div className="features-grid" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: "0.5rem", marginTop: "0.5rem" }}>
              {robot.features ? (
                Object.entries(robot.features).map(([key, val]) => (
                  <div
                    key={key}
                    className={`feature-item p-2 rounded border ${
                      val.available ? "bg-green-50 border-green-200" : "bg-gray-50 border-gray-200"
                    }`}
                  >
                    <div className="font-semibold text-sm">
                      {val.available ? "✅ " : "❌ "}
                      {key.toUpperCase()}
                    </div>
                    {!val.available && val.reason && (
                      <small className="text-gray-500 block text-xs mt-1">
                        {val.reason}
                      </small>
                    )}
                  </div>
                ))
              ) : (
                <p className="text-gray-500 text-sm">Matrice funzionalità disponibile</p>
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
