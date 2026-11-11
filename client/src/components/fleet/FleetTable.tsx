import React from "react";
import type { RobotSummaryDto } from "../../types/fleet.ts";
import { StatusBadge } from "../common/StatusBadge.tsx";

interface FleetTableProps {
  robots: RobotSummaryDto[];
  loading: boolean;
  onOpenDetail: (robotId: string) => void;
  onOpenEdit: (robot: RobotSummaryDto) => void;
  onOpenTerminal: (robotId: string, robotName: string) => void;
  onToggleStatus: (robotId: string, currentStatus: string) => void;
  onOpenRemove: (robot: RobotSummaryDto) => void;
  onRefreshStatus: (robotId: string) => void;
  onRepairRobot: (robotId: string) => void;
  isAdmin: boolean;
}

export const FleetTable: React.FC<FleetTableProps> = ({
  robots,
  loading,
  onOpenDetail,
  onOpenEdit,
  onOpenTerminal,
  onToggleStatus,
  onOpenRemove,
  onRefreshStatus,
  onRepairRobot,
  isAdmin,
}) => {
  return (
    <section className="fleet-section">
      <h3>Flotta Robot Registrati</h3>
      <p id="fleet-count" className="fleet-count">
        {loading
          ? "Caricamento flotta in corso..."
          : `Totale robot registrati: ${robots.length}`}
      </p>

      <div className="table-responsive">
        <table className="data-table" id="fleet-table">
          <thead>
            <tr>
              <th>Nome Visualizzato</th>
              <th>ID</th>
              <th>Host : Porta</th>
              <th>Username Remoto</th>
              <th>Stato Anagrafico</th>
              <th>Stato Connessione</th>
              <th>Stato Operativo</th>
              <th>Azioni</th>
            </tr>
          </thead>
          <tbody id="fleet-table-body">
            {loading && robots.length === 0 ? (
              <tr>
                <td colSpan={8} className="text-center py-4">
                  Caricamento flotta in corso...
                </td>
              </tr>
            ) : robots.length === 0 ? (
              <tr>
                <td colSpan={8} className="text-center py-4">
                  Nessun robot registrato nella flotta.
                </td>
              </tr>
            ) : (
              robots.map((robot) => {
                const isOnline = robot.connectionState === "raggiungibile";
                const isDisabled = robot.anagraphicState === "disabilitato";

                return (
                  <tr key={robot.id} data-robot-id={robot.id}>
                    <td>
                      <strong>{robot.displayName}</strong>
                    </td>
                    <td>
                      <code>{robot.id}</code>
                    </td>
                    <td>
                      {robot.host}:{robot.sshPort}
                    </td>
                    <td>{robot.remoteUsername}</td>
                    <td>
                      <StatusBadge type="anagraphic" state={robot.anagraphicState} />
                    </td>
                    <td>
                      <StatusBadge type="connection" state={robot.connectionState} />
                    </td>
                    <td>
                      <StatusBadge
                        type="operational"
                        operationalData={robot.operationalState}
                        isStale={robot.isStale}
                      />
                    </td>
                    <td>
                      <div className="action-buttons-cell" style={{ display: "flex", gap: "0.25rem", flexWrap: "wrap" }}>
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          title="Visualizza scheda dettaglio completa"
                          onClick={() => onOpenDetail(robot.id)}
                        >
                          Dettaglio
                        </button>

                        <button
                          type="button"
                          className="btn btn-primary btn-sm"
                          title={
                            isOnline && !isDisabled
                              ? "Apri terminale SSH remoto PTY"
                              : "Terminale non disponibile per robot offline o disabilitato"
                          }
                          disabled={!isOnline || isDisabled}
                          onClick={() => onOpenTerminal(robot.id, robot.displayName)}
                        >
                          Terminale
                        </button>

                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          title="Aggiorna stato operativo dal dispositivo"
                          disabled={isDisabled}
                          onClick={() => onRefreshStatus(robot.id)}
                        >
                          Aggiorna
                        </button>

                        {isAdmin && (
                          <>
                            <button
                              type="button"
                              className="btn btn-secondary btn-sm"
                              title="Modifica parametri di connessione e autenticazione"
                              onClick={() => onOpenEdit(robot)}
                            >
                              Configura
                            </button>

                            <button
                              type="button"
                              className="btn btn-secondary btn-sm"
                              title="Sincronizza e ripara directory server mancanti"
                              onClick={() => onRepairRobot(robot.id)}
                            >
                              Ripara
                            </button>

                            <button
                              type="button"
                              className="btn btn-warning btn-sm"
                              title={
                                isDisabled
                                  ? "Abilita il robot alle operazioni"
                                  : "Disabilita il robot"
                              }
                              onClick={() => onToggleStatus(robot.id, robot.anagraphicState)}
                            >
                              {isDisabled ? "Abilita" : "Disabilita"}
                            </button>

                            <button
                              type="button"
                              className="btn btn-danger btn-sm"
                              title="Rimuovi il robot dall'anagrafica attiva (preserva file server)"
                              onClick={() => onOpenRemove(robot)}
                            >
                              Rimuovi
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
};
