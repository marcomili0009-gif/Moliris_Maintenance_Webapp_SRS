import React, { useState } from "react";
import type { User } from "../types/auth.ts";
import type { RobotSummaryDto, RegistrationOutcome } from "../types/fleet.ts";
import type { BulkConflict } from "../types/transfer.ts";
import { FleetTable } from "../components/fleet/FleetTable.tsx";
import { RobotDetailModal } from "../components/fleet/RobotDetailModal.tsx";
import { RobotRegisterModal } from "../components/fleet/RobotRegisterModal.tsx";
import { RobotEditModal } from "../components/fleet/RobotEditModal.tsx";
import { RegistrationOutcomeModal } from "../components/fleet/RegistrationOutcomeModal.tsx";
import { FsBrowserSection } from "../components/filesystem/FsBrowserSection.tsx";
import { TerminalModal } from "../components/terminal/TerminalModal.tsx";
import { BulkUploadModal } from "../components/bulk/BulkUploadModal.tsx";
import { BulkConflictsModal } from "../components/bulk/BulkConflictsModal.tsx";
import { ConfirmDialog } from "../components/common/ConfirmDialog.tsx";
import { NotificationBanner } from "../components/common/NotificationBanner.tsx";
import { Modal } from "../components/common/Modal.tsx";
import { FleetFilterBar } from "../components/fleet/FleetFilterBar.tsx";

import { useFleet } from "../hooks/useFleet.ts";
import { useFilesystem } from "../hooks/useFilesystem.ts";
import { useTransfers } from "../hooks/useTransfers.ts";
import { useTerminal } from "../hooks/useTerminal.ts";

interface DashboardViewProps {
  user: User;
  onLogout: () => Promise<void>;
  idleWarning: string | null;
  onDismissIdleWarning: () => void;
  goHomeTrigger?: number;
  activeMainView?: "fleet" | "files";
  onActiveMainViewChange?: (view: "fleet" | "files") => void;
}

export const DashboardView: React.FC<DashboardViewProps> = ({
  user,
  onLogout: _onLogout,
  idleWarning,
  onDismissIdleWarning,
  goHomeTrigger,
  activeMainView,
  onActiveMainViewChange,
}) => {
  const isAdmin = user.roles.includes("amministratore");

  // Navigazione principale ("fleet" o "files")
  const [internalActiveView, setInternalActiveView] = useState<"fleet" | "files">("fleet");
  const effectiveView = activeMainView ?? internalActiveView;
  const handleViewChange = (view: "fleet" | "files") => {
    setInternalActiveView(view);
    if (onActiveMainViewChange) {
      onActiveMainViewChange(view);
    }
  };

  // Sotto-tab vista unificata file ("server" | "general" | "remote" | "transfers")
  const [activeSubTab, setActiveSubTab] = useState<"server" | "general" | "remote" | "transfers">("server");

  // Hooks di dominio
  const fleet = useFleet(true);
  const fs = useFilesystem();
  const transfers = useTransfers(true);
  const terminal = useTerminal();

  // Fleet Filter State
  const [filteredRobots, setFilteredRobots] = useState<RobotSummaryDto[]>(fleet.robots);
  const [isFilterActive, setIsFilterActive] = useState<boolean>(false);
  const [filterResetTrigger, setFilterResetTrigger] = useState<number>(0);

  const handleFilteredChange = React.useCallback(
    (filtered: RobotSummaryDto[], active: boolean) => {
      setFilteredRobots(filtered);
      setIsFilterActive(active);
    },
    []
  );

  const handleResetFilters = React.useCallback(() => {
    setFilterResetTrigger((prev) => prev + 1);
  }, []);

  const handleGoHome = React.useCallback(() => {
    handleViewChange("fleet");
    handleResetFilters();
    fleet.setSelectedRobot(null);
    setEditingRobot(null);
    setIsRegisterOpen(false);
    setIsBulkUploadOpen(false);
    setRegistrationOutcome(null);
    setRemovingRobot(null);
    setOverwriteTarget(null);
    setDeleteTarget(null);
    setBulkConflicts(null);
    // Rimuove eventuali classi o stili residui sul body per garantire piena interattività
    if (typeof document !== "undefined") {
      document.body.classList.remove("modal-open");
      document.body.style.removeProperty("overflow");
      document.body.style.removeProperty("pointer-events");
      document.querySelectorAll(".modal-backdrop").forEach((el) => el.remove());
    }
    // Preserva intatti i trasferimenti attivi e la sessione terminale aperta
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, [fleet, handleResetFilters]);

  React.useEffect(() => {
    if (goHomeTrigger !== undefined && goHomeTrigger > 0) {
      handleGoHome();
    }
  }, [goHomeTrigger, handleGoHome]);

  // Modals state
  const [isRegisterOpen, setIsRegisterOpen] = useState<boolean>(false);
  const [registrationOutcome, setRegistrationOutcome] = useState<RegistrationOutcome | null>(null);
  const [editingRobot, setEditingRobot] = useState<RobotSummaryDto | null>(null);
  const [removingRobot, setRemovingRobot] = useState<RobotSummaryDto | null>(null);
  const [isBulkUploadOpen, setIsBulkUploadOpen] = useState<boolean>(false);

  // Overwrite confirm modal state
  const [overwriteTarget, setOverwriteTarget] = useState<{
    file: File;
    targetPath: string;
    isServer: boolean;
  } | null>(null);

  // Delete confirm modal state
  const [deleteTarget, setDeleteTarget] = useState<{
    fileName: string;
    isServer?: boolean;
    targetType?: "server" | "general" | "remote";
  } | null>(null);

  // Bulk conflicts state
  const [bulkConflicts, setBulkConflicts] = useState<{
    conflicts: BulkConflict[];
    files: File[];
    destinations: {
      server?: { robotId: string; subPath: string };
      robots?: Array<{ robotId: string; remotePath: string }>;
    };
  } | null>(null);

  // Global banner notification message
  const [globalMessage, setGlobalMessage] = useState<string | null>(null);

  const handleOpenDetail = async (robotId: string) => {
    await fleet.loadRobotDetail(robotId);
  };

  const handleCloseDetail = () => {
    fleet.setSelectedRobot(null);
  };

  const handleOpenTerminal = (robotId: string, robotName: string) => {
    terminal.openTerminal(robotId, robotName);
  };

  const handleOpenRemove = (robot: RobotSummaryDto) => {
    setRemovingRobot(robot);
  };

  const handleConfirmRemove = async () => {
    if (removingRobot) {
      const ok = await fleet.removeRobot(removingRobot.id);
      if (ok) {
        setGlobalMessage(`Robot '${removingRobot.displayName}' rimosso dall'anagrafica attiva.`);
      }
    }
  };

  const handleConfirmOverwrite = async () => {
    if (overwriteTarget) {
      if (overwriteTarget.isServer) {
        await fs.uploadToServer(overwriteTarget.file, overwriteTarget.targetPath, true);
      } else {
        await fs.uploadToRemote(overwriteTarget.file, overwriteTarget.targetPath, true);
      }
      setOverwriteTarget(null);
    }
  };

  const handleConfirmDelete = async () => {
    if (deleteTarget) {
      if (deleteTarget.targetType === "general") {
        await fs.deleteFromGeneral(deleteTarget.fileName);
      } else if (deleteTarget.targetType === "server" || deleteTarget.isServer) {
        await fs.deleteFromServer(deleteTarget.fileName);
      } else {
        await fs.deleteFromRemote(deleteTarget.fileName);
      }
      setDeleteTarget(null);
    }
  };

  const handleConfirmBulkOverwrite = async () => {
    if (bulkConflicts) {
      await transfers.executeBulkUpload(
        bulkConflicts.files,
        bulkConflicts.destinations,
        true
      );
      setBulkConflicts(null);
      setIsBulkUploadOpen(false);
      setGlobalMessage("Caricamento massivo completato con sovrascrittura.");
    }
  };

  return (
    <section id="dashboard-section" className="card border-0 shadow-none p-3">
      <NotificationBanner
        message={globalMessage}
        error={fleet.error || fs.serverError || fs.remoteError || transfers.error}
        onDismiss={() => {
          setGlobalMessage(null);
          fleet.clearError();
          fs.clearServerError();
          fs.clearRemoteError();
          transfers.clearError();
        }}
      />

      {/* Avviso inattività modale */}
      <Modal
        id="modal-idle-warning"
        isOpen={Boolean(idleWarning)}
        onClose={onDismissIdleWarning}
        title="Avviso di scadenza"
        role="alertdialog"
        ariaLabelledBy="idle-warning-title"
        footer={
          <button
            type="button"
            id="btn-dismiss-idle-warning"
            className="btn btn-primary"
            onClick={onDismissIdleWarning}
          >
            OK
          </button>
        }
      >
        <p id="idle-warning-message">{idleWarning}</p>
      </Modal>

      <main className="dashboard-content">
        {/* Vista Flotta */}
        <div id="fleet-view-container" style={{ display: effectiveView === "fleet" ? "block" : "none" }}>
          {/* Barra Azioni Flotta */}
          <div className="actions-bar d-flex gap-2 mb-3 flex-wrap">
            {isAdmin && (
              <button
                id="btn-register-robot"
                className="btn btn-primary"
                onClick={() => setIsRegisterOpen(true)}
              >
                Registra Nuovo Robot
              </button>
            )}
            {isAdmin && (
              <button
                type="button"
                id="btn-server-terminal"
                className="btn btn-outline-dark"
                onClick={() => terminal.openServerTerminal()}
                title="Apre una sessione terminale interattiva sul server Moliris"
              >
                Terminale Server
              </button>
            )}
            <button
              type="button"
              id="btn-refresh-fleet"
              className="btn btn-outline-secondary"
              onClick={() => fleet.refreshFleet()}
              disabled={fleet.loading}
            >
              {fleet.loading ? "Aggiornamento in corso..." : "Aggiorna Flotta"}
            </button>
          </div>

          <FleetFilterBar
            robots={fleet.robots}
            onFilteredChange={handleFilteredChange}
            resetTrigger={filterResetTrigger}
          />
          <FleetTable
            robots={filteredRobots}
            totalRobotsCount={fleet.robots.length}
            isFilterActive={isFilterActive}
            onResetFilters={handleResetFilters}
            loading={fleet.loading}
            onOpenDetail={handleOpenDetail}
            onOpenEdit={(r) => setEditingRobot(r)}
            onOpenTerminal={handleOpenTerminal}
            onToggleStatus={(id, s) => fleet.toggleEnableDisable(id, s)}
            onOpenRemove={handleOpenRemove}
            onRefreshStatus={(id) => fleet.refreshStatus(id)}
            onRepairRobot={(id) => fleet.repairRobot(id)}
            isAdmin={isAdmin}
          />
        </div>

        {/* Vista Unificata Filesystem (Server, Remote, Transfers) */}
        <div id="files-view-container" style={{ display: effectiveView === "files" ? "block" : "none" }}>
          <FsBrowserSection
            robots={fleet.robots}
            activeSubTab={activeSubTab}
            onSubTabChange={(tab) => {
              setActiveSubTab(tab);
              if (effectiveView !== "files") {
                handleViewChange("files");
              }
            }}
            onOpenBulkUpload={() => setIsBulkUploadOpen(true)}
            serverRobotId={fs.serverRobotId}
            onServerRobotIdChange={fs.setServerRobotId}
            serverPath={fs.serverPath}
            serverListing={fs.serverListing}
            serverLoading={fs.serverLoading}
            serverError={fs.serverError}
            onLoadServer={() => fs.loadServerDirectory(fs.serverRobotId, fs.serverPath)}
            onServerUp={fs.navigateServerUp}
            onServerNavigateDir={(d) => {
              const newPath = fs.serverPath.endsWith("/") ? `${fs.serverPath}${d}` : `${fs.serverPath}/${d}`;
              fs.loadServerDirectory(fs.serverRobotId, newPath);
            }}
            onCreateServerFolder={(name) => fs.createRobotServerFolder(fs.serverRobotId, name, fs.serverPath)}
            onServerUpload={(file) => {
              fs.uploadToServer(file, fs.serverPath);
            }}
            onServerDownload={fs.downloadFromServer}
            onServerTransferToRemote={(fileName) => fs.transferServerToRemote(fileName)}
            onServerDelete={(fileName) => setDeleteTarget({ fileName, targetType: "server" })}

            generalPath={fs.generalPath}
            generalListing={fs.generalListing}
            generalLoading={fs.generalLoading}
            generalError={fs.generalError}
            onLoadGeneral={(p) => fs.loadGeneralDirectory(p || fs.generalPath)}
            onGeneralUp={fs.navigateGeneralUp}
            onGeneralNavigateDir={(d) => {
              const newPath = fs.generalPath.endsWith("/") ? `${fs.generalPath}${d}` : `${fs.generalPath}/${d}`;
              fs.loadGeneralDirectory(newPath);
            }}
            onCreateGeneralFolder={(name) => fs.createGeneralFolder(name, fs.generalPath)}
            onGeneralUpload={(file) => fs.uploadToGeneral(file, fs.generalPath)}
            onGeneralDownload={fs.downloadFromGeneral}
            onGeneralDelete={(fileName) => setDeleteTarget({ fileName, targetType: "general" })}

            remoteRobotId={fs.remoteRobotId}
            onRemoteRobotIdChange={fs.setRemoteRobotId}
            remotePath={fs.remotePath}
            remoteListing={fs.remoteListing}
            remoteLoading={fs.remoteLoading}
            remoteError={fs.remoteError}
            onLoadRemote={() => fs.loadRemoteDirectory(fs.remoteRobotId, fs.remotePath)}
            onRemoteUp={fs.navigateRemoteUp}
            onRemoteNavigateDir={(d) => {
              const newPath = fs.remotePath.endsWith("/") ? `${fs.remotePath}${d}` : `${fs.remotePath}/${d}`;
              fs.loadRemoteDirectory(fs.remoteRobotId, newPath);
            }}
            onRemoteUpload={(file) => {
              fs.uploadToRemote(file, fs.remotePath);
            }}
            onRemoteDownload={fs.downloadFromRemote}
            onRemoteTransferToServer={(fileName) => fs.transferRemoteToServer(fileName)}
            onRemoteDelete={(fileName) => setDeleteTarget({ fileName, targetType: "remote" })}

            transfers={transfers.transfers}
            transfersLoading={transfers.loading}
            activeTransfersCount={transfers.activeCount}
            onRefreshTransfers={() => transfers.loadTransfers()}
            onCancelTransfer={transfers.cancelTransfer}
          />
        </div>
      </main>

      {/* Modali */}
      <RobotDetailModal
        robot={fleet.selectedRobot}
        isOpen={Boolean(fleet.selectedRobot)}
        onClose={handleCloseDetail}
      />

      <RobotRegisterModal
        isOpen={isRegisterOpen}
        onClose={() => setIsRegisterOpen(false)}
        onRegister={fleet.registerRobot}
        onRegistrationSuccess={(outcome) => setRegistrationOutcome(outcome)}
      />

      <RegistrationOutcomeModal
        outcome={registrationOutcome}
        isOpen={Boolean(registrationOutcome)}
        onClose={() => setRegistrationOutcome(null)}
      />

      <RobotEditModal
        robot={editingRobot}
        isOpen={Boolean(editingRobot)}
        onClose={() => setEditingRobot(null)}
        onUpdate={fleet.updateRobot}
      />

      {/* Modal Conferma Rimozione Robot */}
      <ConfirmDialog
        id="modal-confirm-remove"
        isOpen={Boolean(removingRobot)}
        onClose={() => setRemovingRobot(null)}
        onConfirm={handleConfirmRemove}
        title="Conferma Rimozione Robot"
        targetDescription={removingRobot ? `Robot: ${removingRobot.displayName} (${removingRobot.id})` : ""}
        warningNote="La rimozione esclude il robot dalle operazioni attive ma non cancella i file e le cartelle archiviati sul filesystem del server né l'anagrafica storica."
        confirmText="Conferma Rimozione"
        confirmBtnId="btn-confirm-remove"
        cancelBtnId="btn-cancel-remove"
      />

      {/* Modal Terminale PTY */}
      <TerminalModal
        terminalState={terminal.terminalState}
        onClose={terminal.closeTerminal}
        onAttachWebSocket={terminal.attachWebSocket}
        onSendInput={terminal.sendInput}
        onResize={terminal.resize}
      />

      {/* Modal Conferma Sovrascrittura */}
      <ConfirmDialog
        id="modal-confirm-overwrite"
        isOpen={Boolean(overwriteTarget)}
        onClose={() => setOverwriteTarget(null)}
        onConfirm={handleConfirmOverwrite}
        title="Avviso: Conferma Sovrascrittura File"
        targetDescription={overwriteTarget?.file.name}
        warningNote="La sovrascrittura cancellerà definitivamente la versione preesistente sostituendola con i dati trasferiti."
        confirmText="Sovrascrivi File Esistente"
        confirmBtnId="btn-confirm-overwrite"
        cancelBtnId="btn-cancel-overwrite"
      />

      {/* Modal Conferma Eliminazione File */}
      <ConfirmDialog
        id="modal-confirm-delete"
        isOpen={Boolean(deleteTarget)}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleConfirmDelete}
        title="Conferma Eliminazione File"
        targetDescription={deleteTarget?.fileName}
        warningNote="L'eliminazione rimuoverà il file dal filesystem in modo irreversibile."
        confirmText="Elimina Definitivamente"
        confirmBtnId="btn-confirm-delete"
        cancelBtnId="btn-cancel-delete"
      />

      {/* Modal Caricamento Massivo Multi-Target */}
      <BulkUploadModal
        isOpen={isBulkUploadOpen}
        onClose={() => setIsBulkUploadOpen(false)}
        robots={fleet.robots.filter((r) => r.anagraphicState === "attivo")}
        onPreCheck={transfers.preCheckBulkUpload}
        onExecuteUpload={transfers.executeBulkUpload}
        onConflictsDetected={(conflicts, files, destinations) => {
          setBulkConflicts({ conflicts, files, destinations });
        }}
      />

      {/* Modal Conflitti Sovrascrittura Bulk */}
      <BulkConflictsModal
        isOpen={Boolean(bulkConflicts)}
        conflicts={bulkConflicts?.conflicts || []}
        onClose={() => setBulkConflicts(null)}
        onConfirmOverwrite={handleConfirmBulkOverwrite}
      />
    </section>
  );
};
