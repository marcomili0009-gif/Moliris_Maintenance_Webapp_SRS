import React, { useState, useRef, useEffect, useCallback } from "react";
import type { User } from "../types/auth.ts";
import type { RobotSummaryDto, RegistrationOutcome } from "../types/fleet.ts";
import type { BulkConflict, BulkDestinations } from "../types/transfer.ts";
import { FleetTable } from "../components/fleet/FleetTable.tsx";
import { RobotDetailModal } from "../components/fleet/RobotDetailModal.tsx";
import { RobotRegisterModal } from "../components/fleet/RobotRegisterModal.tsx";
import { RobotEditModal } from "../components/fleet/RobotEditModal.tsx";
import { RegistrationOutcomeModal } from "../components/fleet/RegistrationOutcomeModal.tsx";
import { FsBrowserSection } from "../components/filesystem/FsBrowserSection.tsx";
import { FileManagementModal } from "../components/filesystem/FileManagementModal.tsx";
import { TerminalModal } from "../components/terminal/TerminalModal.tsx";
import { BulkUploadModal } from "../components/bulk/BulkUploadModal.tsx";
import { BulkConflictsModal } from "../components/bulk/BulkConflictsModal.tsx";
import { ConfirmDialog } from "../components/common/ConfirmDialog.tsx";
import { DeleteFolderModal, type DeleteFolderTarget } from "../components/common/DeleteFolderModal.tsx";
import { NotificationBanner } from "../components/common/NotificationBanner.tsx";
import { Modal } from "../components/common/Modal.tsx";
import { ToastHost, type ToastMessage } from "../components/common/ToastHost.tsx";
import { IdleWarningModal } from "../components/common/IdleWarningModal.tsx";
import { FleetFilterBar } from "../components/fleet/FleetFilterBar.tsx";

import { useFleet } from "../hooks/useFleet.ts";
import { useFilesystem } from "../hooks/useFilesystem.ts";
import { useTransfers } from "../hooks/useTransfers.ts";
import { useTerminal } from "../hooks/useTerminal.ts";

interface DashboardViewProps {
  user: User;
  onLogout: (context?: "sessione" | "terminale") => Promise<void>;
  isSessionWarningOpen: boolean;
  onConfirmSession?: () => Promise<void>;
  setActiveTransfersCount?: (count: number) => void;
  goHomeTrigger?: number;
  onGoHomeHandled?: () => void;
  activeMainView?: "fleet" | "files";
  onActiveMainViewChange?: (view: "fleet" | "files") => void;
}

export const DashboardView: React.FC<DashboardViewProps> = ({
  user,
  onLogout,
  isSessionWarningOpen,
  onConfirmSession,
  setActiveTransfersCount,
  goHomeTrigger,
  onGoHomeHandled,
  activeMainView,
  onActiveMainViewChange,
}) => {
  const isAdmin = user.roles.includes("admin");

  // Navigazione principale ("fleet" o "files")
  const [internalActiveView, setInternalActiveView] = useState<"fleet" | "files">("fleet");
  const effectiveView = activeMainView ?? internalActiveView;
  const handleViewChange = React.useCallback(
    (view: "fleet" | "files") => {
      setInternalActiveView(view);
      if (onActiveMainViewChange) {
        onActiveMainViewChange(view);
      }
    },
    [onActiveMainViewChange]
  );

  // Sotto-tab vista unificata file ("server" | "general" | "remote" | "transfers")
  const [activeSubTab, setActiveSubTab] = useState<"server" | "general" | "remote" | "transfers">("server");
  // Hooks di dominio
  const fleet = useFleet(true);
  const fs = useFilesystem();
  const transfers = useTransfers(true);
  const terminal = useTerminal();

  // Toast non bloccanti
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const toastSeq = useRef(0);
  const dismissToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);
  const pushToast = useCallback((kind: ToastMessage["kind"], text: string) => {
    const id = ++toastSeq.current;
    setToasts((prev) => [...prev.slice(-3), { id, kind, text }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), kind === "error" ? 9000 : 5000);
  }, []);

  // Trasferimenti avviati da questa sessione UI: al completamento aggiornano la cartella di destinazione
  // (senza loader né reload) e segnalano l'esito.
  const watchedTransfers = useRef(
    new Map<string, { destination: "server" | "robot"; robotId: string; label: string }>()
  );
  const fsRef = useRef(fs);
  fsRef.current = fs;
  useEffect(() => {
    if (watchedTransfers.current.size === 0) return;
    for (const dto of transfers.transfers) {
      const watch = watchedTransfers.current.get(dto.transferId);
      if (!watch) continue;
      if (dto.status === "COMPLETED") {
        watchedTransfers.current.delete(dto.transferId);
        const cur = fsRef.current;
        if (watch.destination === "server") {
          if (cur.serverRobotId === watch.robotId) {
            void cur.loadServerDirectory(watch.robotId, cur.serverPath || "/", { silent: true });
          }
        } else if (cur.remoteRobotId === watch.robotId) {
          void cur.loadRemoteDirectory(watch.robotId, cur.remotePath, { silent: true });
        }
        pushToast("success", `Trasferimento completato: ${dto.filename} → ${watch.label}`);
      } else if (dto.status === "FAILED" || dto.status === "INTEGRITY_FAILED" || dto.status === "CANCELLED") {
        watchedTransfers.current.delete(dto.transferId);
        if (dto.status !== "CANCELLED") {
          pushToast("error", `Trasferimento non riuscito: ${dto.filename}${dto.errorMessage ? ` – ${dto.errorMessage}` : ""}`);
        }
      }
    }
  }, [transfers.transfers, pushToast]);

  // Dopo un caricamento massivo aggiorna silenziosamente le cartelle visibili e la lista trasferimenti
  const handleBulkExecute: typeof transfers.executeBulkUpload = async (...args) => {
    const result = await transfers.executeBulkUpload(...args);
    const cur = fsRef.current;
    if (cur.serverRobotId) void cur.loadServerDirectory(cur.serverRobotId, cur.serverPath || "/", { silent: true });
    if (cur.remoteRobotId) void cur.loadRemoteDirectory(cur.remoteRobotId, cur.remotePath, { silent: true });
    void cur.loadGeneralDirectory(cur.generalPath || "/");
    void transfers.syncNow();
    return result;
  };

  // Notifica contatore trasferimenti attivi a useAuth per la sospensione dell'inattività (Prompt #4)
  React.useEffect(() => {
    setActiveTransfersCount?.(transfers.activeCount);
  }, [transfers.activeCount, setActiveTransfersCount]);

  // Apre il filesystem dedicato di un robot elencato nella root aggregata dell'Archivio Generale.
  const handleOpenRobotFromGeneral = (robotId: string) => {
    if (!robotId) return;
    setActiveSubTab("server");
    if (effectiveView !== "files") handleViewChange("files");
    fs.setServerRobotId(robotId);
    fs.loadServerDirectory(robotId, "/");
  };

  // "Torna su" dal filesystem server: dalla root del robot si torna all'Archivio Generale.
  const handleServerUp = () => {
    if (!fs.serverPath || fs.serverPath === "/") {
      setActiveSubTab("general");
      if (effectiveView !== "files") handleViewChange("files");
      fs.loadGeneralDirectory("/");
      return;
    }
    fs.navigateServerUp();
  };

  // Cambio tab della sezione file: mantiene la vista coerente e refresha l'archivio generale.
  const handleSubTabChange = (tab: "server" | "general" | "remote" | "transfers") => {
    setActiveSubTab(tab);
    if (effectiveView !== "files") handleViewChange("files");
    if (tab === "general") {
      fs.loadGeneralDirectory(fs.generalPath || "/");
    }
  };

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

  const { setSelectedRobot } = fleet;

  const handleGoHome = React.useCallback(() => {
    handleViewChange("fleet");
    handleResetFilters();
    setSelectedRobot(null);
    setEditingRobot(null);
    setIsRegisterOpen(false);
    setIsBulkUploadOpen(false);
    setRegistrationOutcome(null);
    setRemovingRobot(null);
    setOverwriteTarget(null);
    setDeleteTarget(null);
    setDeleteFolderTarget(null);
    setBulkConflicts(null);
    setFileManagementTarget(null);
    // Rimuove eventuali classi o stili residui sul body per garantire piena interattività
    if (typeof document !== "undefined") {
      document.body.classList.remove("modal-open");
      document.body.style.removeProperty("overflow");
      document.body.style.removeProperty("pointer-events");
      document.querySelectorAll(".modal-backdrop").forEach((el) => el.remove());
    }
    // Preserva intatti i trasferimenti attivi e la sessione terminale aperta
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, [handleViewChange, handleResetFilters, setSelectedRobot]);

  const lastHandledGoHomeTrigger = React.useRef(0);

  React.useEffect(() => {
    if (goHomeTrigger === 0) {
      lastHandledGoHomeTrigger.current = 0;
      return;
    }
    if (goHomeTrigger !== undefined && goHomeTrigger > 0 && goHomeTrigger > lastHandledGoHomeTrigger.current) {
      lastHandledGoHomeTrigger.current = goHomeTrigger;
      handleGoHome();
      if (onGoHomeHandled) {
        onGoHomeHandled();
      }
    }
  }, [goHomeTrigger, handleGoHome, onGoHomeHandled]);

  // Modals state
  const [isRegisterOpen, setIsRegisterOpen] = useState<boolean>(false);
  const [registrationOutcome, setRegistrationOutcome] = useState<RegistrationOutcome | null>(null);
  const [editingRobot, setEditingRobot] = useState<RobotSummaryDto | null>(null);
  const [removingRobot, setRemovingRobot] = useState<RobotSummaryDto | null>(null);
  const [isBulkUploadOpen, setIsBulkUploadOpen] = useState<boolean>(false);

  // Overwrite confirm modal state (ISS-008)
  const [overwriteTarget, setOverwriteTarget] = useState<{
    file: File;
    targetPath: string;
    scope: "server" | "general" | "remote";
  } | null>(null);

  // Delete confirm modal state
  const [deleteTarget, setDeleteTarget] = useState<{
    fileName: string;
    isServer?: boolean;
    targetType?: "server" | "general" | "remote";
  } | null>(null);

  // Delete folder confirm modal state with backend inspection
  const [deleteFolderTarget, setDeleteFolderTarget] = useState<DeleteFolderTarget | null>(null);

  // File management transfer modal state (Prompt Correttivo #2)
  const [fileManagementTarget, setFileManagementTarget] = useState<{
    fileName: string;
    fileSize?: number;
    sourceType: "server" | "remote";
    robotId: string;
    robotName?: string;
    initialPath: string;
  } | null>(null);

  // Bulk conflicts state
  const [bulkConflicts, setBulkConflicts] = useState<{
    conflicts: BulkConflict[];
    files: File[];
    destinations: BulkDestinations;
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
      if (overwriteTarget.scope === "server") {
        await fs.uploadToServer(overwriteTarget.file, overwriteTarget.targetPath, true);
      } else if (overwriteTarget.scope === "general") {
        await fs.uploadToGeneral(overwriteTarget.file, overwriteTarget.targetPath, true);
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

  const handleConfirmDeleteFolder = async (
    target: DeleteFolderTarget,
    recursive: boolean,
    expectedFileCount: number,
    expectedDirectoryCount: number
  ) => {
    let ok = false;
    if (target.scope === "server" && target.robotId) {
      ok = await fs.deleteServerFolder(target.robotId, target.folderPath, recursive, expectedFileCount, expectedDirectoryCount);
    } else if (target.scope === "general") {
      ok = await fs.deleteGeneralFolder(target.folderPath, recursive, expectedFileCount, expectedDirectoryCount);
    } else if (target.scope === "remote" && target.robotId) {
      ok = await fs.deleteRemoteFolder(target.robotId, target.folderPath, recursive, expectedFileCount, expectedDirectoryCount);
    } else if (target.scope === "deleted_robot") {
      ok = await fs.deleteDeletedRobotFolder(target.folderName, expectedFileCount, expectedDirectoryCount);
      if (ok) {
        pushToast("success", `Cartella '${target.folderName}' del robot eliminato rimossa definitivamente dal server.`);
      }
    }
    setDeleteFolderTarget(null);
    return ok;
  };

  const handleConfirmBulkOverwrite = async () => {
    if (bulkConflicts) {
      const res = await handleBulkExecute(
        bulkConflicts.files,
        bulkConflicts.destinations,
        true
      );
      setBulkConflicts(null);
      if (res.success) {
        setIsBulkUploadOpen(false);
        setGlobalMessage("Caricamento massivo completato con sovrascrittura.");
      } else {
        const firstFailure = res.results?.flatMap((r) => r.failedFiles)[0];
        const completed = res.results?.filter((item) => item.success).length ?? 0;
        const failed = res.results?.filter((item) => !item.success).length ?? 0;
        pushToast(
          "error",
          res.error?.userMessage ||
            (firstFailure
              ? `Sovrascrittura non riuscita (${firstFailure.filename}): ${firstFailure.reason}`
              : `Caricamento massivo incompleto. Invii riusciti: ${completed}. Invii falliti: ${failed}.`)
        );
      }
    }
  };

  const handleConfirmTerminalIdle = async (): Promise<void> => {
    terminal.confirmTerminalIdle();
    if (onConfirmSession) {
      await onConfirmSession();
    }
  };

  const handleLogoutTerminalIdle = async (): Promise<void> => {
    await onLogout("terminale");
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

      <IdleWarningModal
        isOpen={!isSessionWarningOpen && Boolean(terminal.terminalIdleWarning)}
        context="terminale"
        targetName={terminal.activeTerminal?.robotName}
        remainingSeconds={terminal.terminalIdleWarning?.remainingSeconds ?? 300}
        message={terminal.terminalIdleWarning?.message}
        onConfirm={handleConfirmTerminalIdle}
        onLogout={handleLogoutTerminalIdle}
      />

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
            isAdmin={isAdmin}
            activeSubTab={activeSubTab}
            onSubTabChange={handleSubTabChange}
            onOpenBulkUpload={() => setIsBulkUploadOpen(true)}
            serverRobotId={fs.serverRobotId}
            onServerRobotIdChange={fs.setServerRobotId}
            serverPath={fs.serverPath}
            serverListing={fs.serverListing}
            serverLoading={fs.serverLoading}
            serverError={fs.serverError}
            onLoadServer={() => fs.loadServerDirectory(fs.serverRobotId, fs.serverPath)}
            onServerUp={handleServerUp}
            onServerNavigateDir={(d) => {
              const newPath = fs.serverPath.endsWith("/") ? `${fs.serverPath}${d}` : `${fs.serverPath}/${d}`;
              fs.loadServerDirectory(fs.serverRobotId, newPath);
            }}
            onServerNavigatePath={(path) => fs.loadServerDirectory(fs.serverRobotId, path)}
            onCreateServerFolder={(name) => fs.createRobotServerFolder(fs.serverRobotId, name, fs.serverPath)}
            onServerUpload={async (file) => {
              const existsInView = fs.serverListing?.entries.some(
                (entry) => entry.type === "file" && entry.name === file.name
              );
              if (existsInView) {
                setOverwriteTarget({ file, targetPath: fs.serverPath, scope: "server" });
                return;
              }
              const outcome = await fs.uploadToServer(file, fs.serverPath);
              if (outcome === "conflict") {
                setOverwriteTarget({ file, targetPath: fs.serverPath, scope: "server" });
              }
            }}
            onServerDownload={fs.downloadFromServer}
            onServerTransferToRemote={(fileName, entry) => {
              const r = fleet.robots.find((item) => item.id === fs.serverRobotId);
              setFileManagementTarget({
                fileName,
                fileSize: entry?.size,
                sourceType: "server",
                robotId: fs.serverRobotId,
                robotName: r?.displayName,
                initialPath: "/",
              });
            }}
            onServerDelete={(fileName) => setDeleteTarget({ fileName, targetType: "server" })}
            onServerDeleteFolder={(folderName) =>
              setDeleteFolderTarget({
                folderName,
                folderPath: fs.serverPath.endsWith("/") ? `${fs.serverPath}${folderName}` : `${fs.serverPath}/${folderName}`,
                scope: "server",
                robotId: fs.serverRobotId,
              })
            }

            generalPath={fs.generalPath}
            generalListing={fs.generalListing}
            generalLoading={fs.generalLoading}
            generalError={fs.generalError}
            deletedRobotFolder={fs.deletedRobotFolder}
            onLoadGeneral={(p) => {
              if (fs.deletedRobotFolder && (!p || p === fs.generalPath)) {
                void fs.loadDeletedRobotDirectory(fs.deletedRobotFolder, "/");
              } else {
                void fs.loadGeneralDirectory(p || "/");
              }
            }}
            onGeneralUp={fs.navigateGeneralUp}
            onGeneralNavigateDir={fs.navigateGeneralDir}
            onGeneralNavigatePath={fs.navigateGeneralPath}
            onGeneralOpenRobot={handleOpenRobotFromGeneral}
            onGeneralOpenDeletedRobot={(folderName) => void fs.loadDeletedRobotDirectory(folderName, "/")}
            onGeneralDeleteDeletedRobot={
              isAdmin
                ? (folderName) =>
                    setDeleteFolderTarget({
                      folderName,
                      folderPath: `/${folderName}`,
                      scope: "deleted_robot",
                    })
                : undefined
            }
            onCreateGeneralFolder={(name) => fs.createGeneralFolder(name, fs.generalPath)}
            onGeneralUpload={async (file) => {
              const existsInView = fs.generalListing?.entries.some(
                (entry) => entry.type === "file" && entry.name === file.name
              );
              if (existsInView) {
                setOverwriteTarget({ file, targetPath: fs.generalPath, scope: "general" });
                return;
              }
              const outcome = await fs.uploadToGeneral(file, fs.generalPath);
              if (outcome === "conflict") {
                setOverwriteTarget({ file, targetPath: fs.generalPath, scope: "general" });
              }
            }}
            onGeneralDownload={fs.downloadFromGeneral}
            onGeneralDelete={(fileName) => setDeleteTarget({ fileName, targetType: "general" })}
            onGeneralDeleteFolder={(folderName) =>
              setDeleteFolderTarget({
                folderName,
                folderPath: fs.generalPath.endsWith("/") ? `${fs.generalPath}${folderName}` : `${fs.generalPath}/${folderName}`,
                scope: "general",
              })
            }

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
            onRemoteNavigatePath={(path) => fs.loadRemoteDirectory(fs.remoteRobotId, path)}
            onCreateRemoteFolder={(name) => fs.createRemoteFolder(fs.remoteRobotId, name, fs.remotePath)}
            onRemoteUpload={async (file) => {
              const existsInView = fs.remoteListing?.entries.some(
                (entry) => entry.type === "file" && entry.name === file.name
              );
              if (existsInView) {
                setOverwriteTarget({ file, targetPath: fs.remotePath, scope: "remote" });
                return;
              }
              const outcome = await fs.uploadToRemote(file, fs.remotePath);
              if (outcome === "conflict") {
                setOverwriteTarget({ file, targetPath: fs.remotePath, scope: "remote" });
              }
            }}
            onRemoteDownload={fs.downloadFromRemote}
            onRemoteTransferToServer={(fileName, entry) => {
              const r = fleet.robots.find((item) => item.id === fs.remoteRobotId);
              setFileManagementTarget({
                fileName,
                fileSize: entry?.size,
                sourceType: "remote",
                robotId: fs.remoteRobotId,
                robotName: r?.displayName,
                initialPath: "/",
              });
            }}
            onRemoteDelete={(fileName) => setDeleteTarget({ fileName, targetType: "remote" })}
            onRemoteDeleteFolder={(folderName) =>
              setDeleteFolderTarget({
                folderName,
                folderPath: fs.remotePath
                  ? fs.remotePath.endsWith("/")
                    ? `${fs.remotePath}${folderName}`
                    : `${fs.remotePath}/${folderName}`
                  : folderName,
                scope: "remote",
                robotId: fs.remoteRobotId,
              })
            }

            transfers={transfers.transfers}
            transfersLoading={transfers.loading}
            activeTransfersCount={transfers.activeCount}
            onRefreshTransfers={() => transfers.loadTransfers()}
            onCancelTransfer={transfers.cancelTransfer}
            onPauseTransfer={transfers.pauseTransfer}
            onResumeTransfer={transfers.resumeTransfer}
            onCancelBatch={transfers.cancelBatch}
            onRetryTransfer={transfers.retryTransfer}
            onRemoveTransfer={transfers.removeTransfer}
            onClearTransfers={transfers.clearTransfers}
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
        isAdmin={isAdmin}
        onDeleteServerData={fleet.deleteServerData}
      />

      {/* Modal Conferma Rimozione Robot */}
      <ConfirmDialog
        id="modal-confirm-remove"
        isOpen={Boolean(removingRobot)}
        onClose={() => setRemovingRobot(null)}
        onConfirm={handleConfirmRemove}
        title="Conferma Rimozione Robot"
        targetDescription={removingRobot ? `Robot: ${removingRobot.displayName} (${removingRobot.id})` : ""}
        warningNote="Il robot verrà rimosso definitivamente dalla flotta attiva (potrai registrare nuovamente un robot con lo stesso nome o ID). La sua cartella e tutti i file sul server resteranno intatti e consultabili nell'Archivio Generale Server con l'etichetta «Eliminato»."
        confirmText="Conferma Rimozione"
        confirmBtnId="btn-confirm-remove"
        cancelBtnId="btn-cancel-remove"
      />

      {/* Modal Terminale PTY */}
      {terminal.terminals.map((session) => (
        <TerminalModal
          key={session.target}
          terminalState={session}
          isOpen={terminal.activeTerminal?.target === session.target}
          onHide={terminal.hideTerminal}
          onDisconnect={terminal.disconnectTerminal}
          onLoadError={terminal.handleLoadError}
          onAttachWebSocket={terminal.attachWebSocket}
          onSendInput={terminal.sendInput}
          onResize={terminal.resize}
        />
      ))}

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
        onExecuteUpload={handleBulkExecute}
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

      {/* Modal Conferma Eliminazione Cartella con Ispezione */}
      <DeleteFolderModal
        isOpen={Boolean(deleteFolderTarget)}
        target={deleteFolderTarget}
        onClose={() => setDeleteFolderTarget(null)}
        onConfirm={handleConfirmDeleteFolder}
      />

      {/* Modal Gestione File - Selezione Percorso Trasferimento (Prompt Correttivo #2) */}
      {fileManagementTarget && (
        <FileManagementModal
          user={user}
          isOpen={Boolean(fileManagementTarget)}
          onClose={() => setFileManagementTarget(null)}
          sourceFileName={fileManagementTarget.fileName}
          sourceFileSize={fileManagementTarget.fileSize}
          sourceType={fileManagementTarget.sourceType}
          robotId={fileManagementTarget.robotId}
          robotName={fileManagementTarget.robotName}
          initialPath={fileManagementTarget.initialPath}
          isOperator={user.roles.includes("operatore") && !isAdmin}
          allowedPaths={user.allowedPaths}
          onConfirm={async (destinationPath, { overwrite }) => {
            const target = fileManagementTarget;
            const result =
              target.sourceType === "server"
                ? await fs.transferServerToRemote(target.fileName, destinationPath, overwrite)
                : await fs.transferRemoteToServer(target.fileName, destinationPath, overwrite);
            if (result.ok) {
              const label = target.sourceType === "server" ? `Robot (${destinationPath})` : `Server (${destinationPath})`;
              if (result.transferId) {
                watchedTransfers.current.set(result.transferId, {
                  destination: target.sourceType === "server" ? "robot" : "server",
                  robotId: target.robotId,
                  label,
                });
              }
              pushToast("info", `Trasferimento avviato verso ${label}`);
              void transfers.syncNow();
            }
            return result;
          }}
        />
      )}
      <ToastHost toasts={toasts} onDismiss={dismissToast} />
    </section>
  );
};
