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

import { useFleet } from "../hooks/useFleet.ts";
import { useFilesystem } from "../hooks/useFilesystem.ts";
import { useTransfers } from "../hooks/useTransfers.ts";
import { useTerminal } from "../hooks/useTerminal.ts";

interface DashboardViewProps {
  user: User;
  onLogout: () => Promise<void>;
  idleWarning: string | null;
  onDismissIdleWarning: () => void;
}

export const DashboardView: React.FC<DashboardViewProps> = ({
  user,
  onLogout,
  idleWarning,
  onDismissIdleWarning,
}) => {
  const isAdmin = user.roles.includes("amministratore");
  const [activeMainView, setActiveMainView] = useState<"fleet" | "server" | "remote" | "transfers">("fleet");

  // Hooks
  const fleet = useFleet(true);
  const fs = useFilesystem();
  const transfers = useTransfers(true);
  const terminal = useTerminal();

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
    isServer: boolean;
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

  // Navigation handlers
  const handleNavClick = (view: "fleet" | "server" | "remote" | "transfers") => {
    setActiveMainView(view);
  };

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
      if (deleteTarget.isServer) {
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
    <section id="dashboard-section" className="card">
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

      <header className="dashboard-header">
        <div>
          <h2>Pannello di Gestione Flotta</h2>
          <div className="user-info">
            Utente: <span id="current-username" className="badge">{user.username}</span>
            Ruoli: <span id="current-roles" className="badge">{user.roles.join(", ")}</span>
          </div>
        </div>
        <button id="btn-logout" className="btn btn-secondary" onClick={onLogout}>
          Disconnetti (Logout)
        </button>
      </header>

      <nav className="main-nav" aria-label="Navigazione principale">
        <button
          type="button"
          className={`main-nav-btn ${activeMainView === "fleet" ? "active" : ""}`}
          data-view="fleet"
          onClick={() => handleNavClick("fleet")}
        >
          Flotta
        </button>
        <button
          type="button"
          className={`main-nav-btn ${activeMainView === "server" ? "active" : ""}`}
          data-view="server"
          onClick={() => handleNavClick("server")}
        >
          File sul server
        </button>
        <button
          type="button"
          className={`main-nav-btn ${activeMainView === "remote" ? "active" : ""}`}
          data-view="remote"
          onClick={() => handleNavClick("remote")}
        >
          File sul robot
        </button>
        <button
          type="button"
          className={`main-nav-btn ${activeMainView === "transfers" ? "active" : ""}`}
          data-view="transfers"
          onClick={() => handleNavClick("transfers")}
        >
          Trasferimenti
        </button>
      </nav>

      <main className="dashboard-content">
        {/* Barra Azioni Flotta */}
        <div className="actions-bar">
          {isAdmin && (
            <button
              id="btn-register-robot"
              className="btn btn-accent"
              onClick={() => setIsRegisterOpen(true)}
            >
              ＋ Registra Nuovo Robot
            </button>
          )}
          <button
            id="btn-bulk-upload-open"
            className="btn btn-primary"
            onClick={() => setIsBulkUploadOpen(true)}
          >
            📦 Caricamento Massivo Multi-Target
          </button>
          <button
            id="btn-refresh-fleet"
            className="btn btn-secondary"
            onClick={() => fleet.loadFleet()}
          >
            🔄 Aggiorna Flotta
          </button>
        </div>

        {/* Vista Flotta */}
        {activeMainView === "fleet" && (
          <FleetTable
            robots={fleet.robots}
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
        )}

        {/* Vista Filesystem (Server, Remote, Transfers) */}
        {activeMainView !== "fleet" && (
          <FsBrowserSection
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
            onServerUpload={(file) => {
              fs.uploadToServer(file, fs.serverPath);
            }}
            onServerDownload={fs.downloadFromServer}
            onServerTransferToRemote={(fileName) => fs.transferServerToRemote(fileName)}
            onServerDelete={(fileName) => setDeleteTarget({ fileName, isServer: true })}

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
            onRemoteDelete={(fileName) => setDeleteTarget({ fileName, isServer: false })}
            onRemotePurgeTemp={() => fs.cleanupRobotTemp(fs.remoteRobotId)}

            transfers={transfers.transfers}
            transfersLoading={transfers.loading}
            activeTransfersCount={transfers.activeCount}
            onRefreshTransfers={() => transfers.loadTransfers()}
            onPurgeAllTemp={transfers.cleanupAllTemp}
            onCancelTransfer={transfers.cancelTransfer}
          />
        )}
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
        warningNote="La rimozione esclude il robot dalle operazioni attive ma NON cancella i file e le cartelle archiviati sul filesystem del server né l'anagrafica storica (RF-ROB-013, CA-ROB-011)."
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
        warningNote="La sovrascrittura cancellerà definitivamente la versione preesistente sostituendola con i dati trasferiti (RNF-FS-003)."
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
        warningNote="L'eliminazione rimuoverà il file dal filesystem in modo irreversibile (RNF-FS-003)."
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
