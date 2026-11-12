import React from "react";
import { createPortal } from "react-dom";
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
  const [dropdownPosition, setDropdownPosition] = React.useState<{
    top: number;
    left: number;
    placement: "bottom" | "top";
  } | null>(null);
  const activeTriggerRef = React.useRef<HTMLButtonElement | null>(null);
  const dropdownMenuRef = React.useRef<HTMLDivElement | null>(null);

  const closeDropdown = React.useCallback((restoreFocus = false) => {
    setOpenDropdownId(null);
    setDropdownPosition(null);
    if (restoreFocus && activeTriggerRef.current) {
      activeTriggerRef.current.focus();
    }
  }, []);

  React.useEffect(() => {
    if (!openDropdownId) return;

    const handleOutsideClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        dropdownMenuRef.current &&
        !dropdownMenuRef.current.contains(target) &&
        activeTriggerRef.current &&
        !activeTriggerRef.current.contains(target)
      ) {
        closeDropdown(false);
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        closeDropdown(true);
      }
    };

    const handleScrollOrResize = () => {
      closeDropdown(false);
    };

    document.addEventListener("mousedown", handleOutsideClick);
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener("scroll", handleScrollOrResize, true);
    window.addEventListener("resize", handleScrollOrResize);

    return () => {
      document.removeEventListener("mousedown", handleOutsideClick);
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("scroll", handleScrollOrResize, true);
      window.removeEventListener("resize", handleScrollOrResize);
    };
  }, [openDropdownId, closeDropdown]);

  const handleToggleDropdown = (robotId: string, buttonEl: HTMLButtonElement) => {
    if (openDropdownId === robotId) {
      closeDropdown(false);
      return;
    }

    const rect = buttonEl.getBoundingClientRect();
    const menuWidth = 180;
    const estimatedMenuHeight = isAdmin ? 220 : 60;
    const spaceBelow = window.innerHeight - rect.bottom;
    const spaceAbove = rect.top;

    const shouldFlipTop = spaceBelow < estimatedMenuHeight && spaceAbove > spaceBelow;

    let left = rect.right - menuWidth;
    if (left < 10) left = 10;
    if (left + menuWidth > window.innerWidth - 10) {
      left = window.innerWidth - menuWidth - 10;
    }

    const top = shouldFlipTop ? rect.top - 4 : rect.bottom + 4;

    activeTriggerRef.current = buttonEl;
    setOpenDropdownId(robotId);
    setDropdownPosition({
      top,
      left,
      placement: shouldFlipTop ? "top" : "bottom",
    });
  };

  const activeRobot = openDropdownId ? robots.find((r) => r.id === openDropdownId) : null;
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

                        <div className="action-dropdown-container">
                          <button
                            type="button"
                            className="btn btn-outline-secondary btn-sm px-2 py-1 dropdown-toggle"
                            id={`btn-actions-${robot.id}`}
                            aria-expanded={openDropdownId === robot.id}
                            title="Altre azioni sul robot"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleToggleDropdown(robot.id, e.currentTarget);
                            }}
                          >
                            Altre
                          </button>
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

      {openDropdownId && dropdownPosition && activeRobot && createPortal(
        <div
          ref={dropdownMenuRef}
          className="dropdown-menu show shadow-sm"
          style={{
            position: "fixed",
            top: dropdownPosition.top,
            left: dropdownPosition.left,
            transform: dropdownPosition.placement === "top" ? "translateY(-100%)" : "none",
            zIndex: 1040,
            minWidth: "180px",
            margin: 0,
          }}
        >
          <button
            type="button"
            className="dropdown-item py-1"
            disabled={activeRobot.anagraphicState === "disabilitato"}
            onClick={() => {
              closeDropdown(false);
              onRefreshStatus(activeRobot.id);
            }}
          >
            Aggiorna Stato
          </button>

          {isAdmin && (
            <>
              <button
                type="button"
                className="dropdown-item py-1"
                onClick={() => {
                  closeDropdown(false);
                  onOpenEdit(activeRobot);
                }}
              >
                Configura
              </button>

              <button
                type="button"
                className="dropdown-item py-1"
                onClick={() => {
                  closeDropdown(false);
                  onRepairRobot(activeRobot.id);
                }}
              >
                Ripara Directory
              </button>

              <button
                type="button"
                className="dropdown-item py-1 text-warning"
                onClick={() => {
                  closeDropdown(false);
                  onToggleStatus(activeRobot.id, activeRobot.anagraphicState);
                }}
              >
                {activeRobot.anagraphicState === "disabilitato" ? "Abilita Robot" : "Disabilita Robot"}
              </button>

              <div className="dropdown-divider my-1" />

              <button
                type="button"
                className="dropdown-item py-1 text-danger"
                onClick={() => {
                  closeDropdown(false);
                  onOpenRemove(activeRobot);
                }}
              >
                Rimuovi Robot
              </button>
            </>
          )}
        </div>,
        document.body
      )}
    </section>
  );
};
