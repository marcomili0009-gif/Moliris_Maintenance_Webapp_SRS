import React from "react";
import type { RobotSummaryDto } from "../../types/fleet.ts";
import { StatusBadge } from "../common/StatusBadge.tsx";

interface FleetTableProps {
  robots: RobotSummaryDto[];
  totalRobotsCount?: number;
  isFilterActive?: boolean;
  onResetFilters?: () => void;
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
  totalRobotsCount = 0,
  isFilterActive = false,
  onResetFilters,
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
  const [openDropdownId, setOpenDropdownId] = React.useState<string | null>(null);

  React.useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest(".action-dropdown-container")) {
        setOpenDropdownId(null);
      }
    };
    document.addEventListener("click", handleOutsideClick);
    return () => document.removeEventListener("click", handleOutsideClick);
  }, []);
  return (
    <section className="fleet-section">
      <h3>Flotta Robot Registrati</h3>

      <div className="table-responsive">
        <table className="data-table table table-hover table-striped align-middle" id="fleet-table">
          <thead>
            <tr>
              <th>Cliente</th>
              <th>Impianto</th>
              <th>Nome Robot</th>
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
                <td colSpan={10} className="text-center py-4">
                  Caricamento flotta in corso...
                </td>
              </tr>
            ) : robots.length === 0 ? (
              <tr>
                <td colSpan={10} className="text-center py-4" id="fleet-empty-cell">
                  {isFilterActive ? (
                    <span>
                      Nessun robot corrisponde ai filtri.
                      {onResetFilters && (
                        <button
                          type="button"
                          className="btn btn-link btn-sm ms-2"
                          id="btn-reset-filters-table"
                          onClick={onResetFilters}
                        >
                          Azzera filtri
                        </button>
                      )}
                    </span>
                  ) : (
                    <span>Nessun robot registrato nella flotta.</span>
                  )}
                </td>
              </tr>
            ) : (
              robots.map((robot) => {
                const isOnline = robot.connectionState === "raggiungibile";
                const isDisabled = robot.anagraphicState === "disabilitato";

                return (
                  <tr key={robot.id} data-robot-id={robot.id}>
                    <td>{robot.customerName || "—"}</td>
                    <td>{robot.plantName || "—"}</td>
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
                        lastUpdate={robot.lastValidUpdateAt}
                      />
                    </td>
                    <td>
                      <div className="action-buttons-cell d-flex align-items-center gap-1" style={{ whiteSpace: "nowrap" }}>
                        <button
                          type="button"
                          className="btn btn-primary btn-sm px-2 py-1"
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
                          className="btn btn-outline-secondary btn-sm px-2 py-1"
                          title="Visualizza scheda dettaglio completa"
                          onClick={() => onOpenDetail(robot.id)}
                        >
                          Dettaglio
                        </button>

                        <div className="position-relative action-dropdown-container">
                          <button
                            type="button"
                            className="btn btn-outline-secondary btn-sm px-2 py-1 dropdown-toggle"
                            id={`btn-actions-${robot.id}`}
                            aria-expanded={openDropdownId === robot.id}
                            title="Altre azioni sul robot"
                            onClick={(e) => {
                              e.stopPropagation();
                              setOpenDropdownId(openDropdownId === robot.id ? null : robot.id);
                            }}
                          >
                            Altre
                          </button>

                          {openDropdownId === robot.id && (
                            <div
                              className="dropdown-menu show shadow-sm end-0 position-absolute"
                              style={{
                                zIndex: 1050,
                                minWidth: "160px",
                                top: "100%",
                                right: 0,
                              }}
                            >
                              <button
                                type="button"
                                className="dropdown-item py-1"
                                disabled={isDisabled}
                                onClick={() => {
                                  setOpenDropdownId(null);
                                  onRefreshStatus(robot.id);
                                }}
                              >
                                🔄 Aggiorna Stato
                              </button>

                              {isAdmin && (
                                <>
                                  <button
                                    type="button"
                                    className="dropdown-item py-1"
                                    onClick={() => {
                                      setOpenDropdownId(null);
                                      onOpenEdit(robot);
                                    }}
                                  >
                                    ⚙️ Configura
                                  </button>

                                  <button
                                    type="button"
                                    className="dropdown-item py-1"
                                    onClick={() => {
                                      setOpenDropdownId(null);
                                      onRepairRobot(robot.id);
                                    }}
                                  >
                                    🛠️ Ripara Directory
                                  </button>

                                  <button
                                    type="button"
                                    className="dropdown-item py-1 text-warning"
                                    onClick={() => {
                                      setOpenDropdownId(null);
                                      onToggleStatus(robot.id, robot.anagraphicState);
                                    }}
                                  >
                                    {isDisabled ? "✅ Abilita Robot" : "⏸️ Disabilita Robot"}
                                  </button>

                                  <div className="dropdown-divider my-1" />

                                  <button
                                    type="button"
                                    className="dropdown-item py-1 text-danger"
                                    onClick={() => {
                                      setOpenDropdownId(null);
                                      onOpenRemove(robot);
                                    }}
                                  >
                                    🗑️ Rimuovi Robot
                                  </button>
                                </>
                              )}
                            </div>
                          )}
                        </div>
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
