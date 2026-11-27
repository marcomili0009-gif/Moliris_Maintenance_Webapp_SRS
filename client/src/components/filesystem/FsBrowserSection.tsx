import React, { useState } from "react";
import { ServerFsPanel } from "./ServerFsPanel.tsx";
import { GeneralFsPanel } from "./GeneralFsPanel.tsx";
import { RemoteFsPanel } from "./RemoteFsPanel.tsx";
import { TransfersPanel } from "./TransfersPanel.tsx";
import { FsTabBar, type FsSubTab } from "./FsTabBar.tsx";
import type { DirectoryListing, FsEntry } from "../../types/filesystem.ts";
import type { TransferProgress } from "../../types/transfer.ts";
import type { FormattedError } from "../../types/error.ts";
import type { RobotSummaryDto } from "../../types/fleet.ts";

export type { FsSubTab };

interface FsBrowserSectionProps {
  robots?: RobotSummaryDto[];
  isAdmin?: boolean;
  activeSubTab?: FsSubTab;
  onSubTabChange?: (tab: FsSubTab) => void;
  onOpenBulkUpload?: () => void;

  // Server (Robot Dedicated)
  serverRobotId: string;
  onServerRobotIdChange: (id: string) => void;
  serverPath: string;
  serverListing: DirectoryListing | null;
  serverLoading: boolean;
  serverError: FormattedError | null;
  onLoadServer: () => void;
  onServerUp: () => void;
  onServerNavigateDir: (dirName: string) => void;
  onServerNavigatePath?: (path: string) => void;
  onCreateServerFolder?: (name: string) => Promise<{ success: boolean; error?: string }>;
  onServerUpload: (file: File) => void;
  onServerDownload: (fileName: string) => void;
  onServerTransferToRemote: (fileName: string, entry?: FsEntry) => void;
  onServerDelete: (fileName: string) => void;
  onServerDeleteFolder?: (folderName: string) => void;

  // General Server Archive
  generalPath?: string;
  generalListing?: DirectoryListing | null;
  generalLoading?: boolean;
  generalError?: FormattedError | null;
  deletedRobotFolder?: string | null;
  onLoadGeneral?: (path?: string) => void;
  onGeneralUp?: () => void;
  onGeneralNavigateDir?: (dirName: string) => void;
  onGeneralNavigatePath?: (path: string) => void;
  onGeneralOpenRobot?: (robotId: string) => void;
  onGeneralOpenDeletedRobot?: (folderName: string) => void;
  onGeneralDeleteDeletedRobot?: (folderName: string) => void;
  onCreateGeneralFolder?: (name: string) => Promise<{ success: boolean; error?: string }>;
  onGeneralUpload?: (file: File) => void;
  onGeneralDownload?: (fileName: string) => void;
  onGeneralDelete?: (fileName: string) => void;
  onGeneralDeleteFolder?: (folderName: string) => void;

  // Remote
  remoteRobotId: string;
  onRemoteRobotIdChange: (id: string) => void;
  remotePath: string;
  remoteListing: DirectoryListing | null;
  remoteLoading: boolean;
  remoteError: FormattedError | null;
  onLoadRemote: () => void;
  onRemoteUp: () => void;
  onRemoteNavigateDir: (dirName: string) => void;
  onRemoteNavigatePath?: (path: string) => void;
  onCreateRemoteFolder?: (name: string) => Promise<{ success: boolean; error?: string }>;
  onRemoteUpload: (file: File) => void;
  onRemoteDownload: (fileName: string) => void;
  onRemoteTransferToServer: (fileName: string, entry?: FsEntry) => void;
  onRemoteDelete: (fileName: string) => void;
  onRemoteDeleteFolder?: (folderName: string) => void;

  // Transfers
  transfers: TransferProgress[];
  transfersLoading: boolean;
  activeTransfersCount: number;
  onRefreshTransfers: () => void;
  onCancelTransfer: (id: string) => void | Promise<unknown>;
  onPauseTransfer?: (id: string) => void | Promise<unknown>;
  onResumeTransfer?: (id: string) => void | Promise<unknown>;
  onCancelBatch?: (batchId: string) => void | Promise<unknown>;
  onRetryTransfer?: (id: string) => void | Promise<unknown>;
  onRemoveTransfer?: (id: string) => void | Promise<unknown>;
  onClearTransfers?: () => void | Promise<unknown>;
}

export const FsBrowserSection: React.FC<FsBrowserSectionProps> = ({
  robots = [],
  isAdmin = false,
  activeSubTab,
  onSubTabChange,
  onOpenBulkUpload,

  serverRobotId,
  onServerRobotIdChange,
  serverPath,
  serverListing,
  serverLoading,
  serverError,
  onLoadServer,
  onServerUp,
  onServerNavigateDir,
  onServerNavigatePath,
  onCreateServerFolder,
  onServerUpload,
  onServerDownload,
  onServerTransferToRemote,
  onServerDelete,
  onServerDeleteFolder,

  generalPath = "/",
  generalListing = null,
  generalLoading = false,
  generalError = null,
  deletedRobotFolder = null,
  onLoadGeneral = () => {},
  onGeneralUp = () => {},
  onGeneralNavigateDir = () => {},
  onGeneralNavigatePath,
  onGeneralOpenRobot,
  onGeneralOpenDeletedRobot,
  onGeneralDeleteDeletedRobot,
  onCreateGeneralFolder = async () => ({ success: false, error: "Non supportato" }),
  onGeneralUpload = () => {},
  onGeneralDownload = () => {},
  onGeneralDelete = () => {},
  onGeneralDeleteFolder,

  remoteRobotId,
  onRemoteRobotIdChange,
  remotePath,
  remoteListing,
  remoteLoading,
  remoteError,
  onLoadRemote,
  onRemoteUp,
  onRemoteNavigateDir,
  onRemoteNavigatePath,
  onCreateRemoteFolder,
  onRemoteUpload,
  onRemoteDownload,
  onRemoteTransferToServer,
  onRemoteDelete,
  onRemoteDeleteFolder,

  transfers,
  transfersLoading,
  activeTransfersCount,
  onRefreshTransfers,
  onCancelTransfer,
  onPauseTransfer,
  onResumeTransfer,
  onCancelBatch,
  onRetryTransfer,
  onRemoveTransfer,
  onClearTransfers,
}) => {
  const [internalTab, setInternalTab] = useState<FsSubTab>("server");
  const currentTab = activeSubTab ?? internalTab;

  const handleTabClick = (tab: FsSubTab) => {
    setInternalTab(tab);
    if (onSubTabChange) {
      onSubTabChange(tab);
    }
  };

  return (
    <section id="fs-browser-section" className="fs-browser-card p-3">
      {/* 1. Barra superiore di sezione con pulsante Caricamento Massivo */}
      <div className="fs-section-toolbar d-flex justify-content-between align-items-center mb-3 pb-2 border-bottom flex-wrap gap-2">
        <div>
          <h2 className="h4 fw-bold mb-0">Gestione File e Trasferimenti</h2>
          <small className="text-secondary">
            Archiviazione su server locale e navigazione remota SFTP sui robot
          </small>
        </div>
        <div>
          <button
            type="button"
            id="btn-bulk-upload-open"
            className="btn btn-primary"
            onClick={onOpenBulkUpload}
          >
            Caricamento Massivo
          </button>
        </div>
      </div>

      {/* 2. Tab di navigazione con indicatore animato */}
      <FsTabBar
        activeTab={currentTab}
        onChange={handleTabClick}
        activeTransfersCount={activeTransfersCount}
      />

      <div
        role="tabpanel"
        aria-hidden={currentTab !== "server"}
        style={{ display: currentTab === "server" ? "block" : "none" }}
      >
        <ServerFsPanel
          robotId={serverRobotId}
          onRobotIdChange={onServerRobotIdChange}
          robots={robots}
          currentPath={serverPath}
          listing={serverListing}
          loading={serverLoading}
          error={serverError}
          onLoad={onLoadServer}
          onUp={onServerUp}
          onNavigateDir={onServerNavigateDir}
          onNavigatePath={onServerNavigatePath}
          onCreateFolder={onCreateServerFolder}
          onUpload={onServerUpload}
          onDownload={onServerDownload}
          onTransferToRemote={onServerTransferToRemote}
          onDelete={onServerDelete}
          onDeleteFolder={onServerDeleteFolder}
        />
      </div>

      <div
        role="tabpanel"
        aria-hidden={currentTab !== "general"}
        style={{ display: currentTab === "general" ? "block" : "none" }}
      >
        <GeneralFsPanel
          currentPath={generalPath}
          listing={generalListing}
          loading={generalLoading}
          error={generalError}
          isAdmin={isAdmin}
          deletedRobotFolder={deletedRobotFolder}
          onLoad={onLoadGeneral}
          onUp={onGeneralUp}
          onNavigateDir={onGeneralNavigateDir}
          onNavigatePath={onGeneralNavigatePath}
          onOpenRobot={onGeneralOpenRobot}
          onOpenDeletedRobot={onGeneralOpenDeletedRobot}
          onDeleteDeletedRobot={onGeneralDeleteDeletedRobot}
          onCreateFolder={onCreateGeneralFolder}
          onUpload={onGeneralUpload}
          onDownload={onGeneralDownload}
          onDelete={onGeneralDelete}
          onDeleteFolder={onGeneralDeleteFolder}
        />
      </div>

      <div
        role="tabpanel"
        aria-hidden={currentTab !== "remote"}
        style={{ display: currentTab === "remote" ? "block" : "none" }}
      >
        <RemoteFsPanel
          robotId={remoteRobotId}
          onRobotIdChange={onRemoteRobotIdChange}
          robots={robots}
          currentPath={remotePath}
          listing={remoteListing}
          loading={remoteLoading}
          error={remoteError}
          onLoad={onLoadRemote}
          onUp={onRemoteUp}
          onNavigateDir={onRemoteNavigateDir}
          onNavigatePath={onRemoteNavigatePath}
          onCreateFolder={onCreateRemoteFolder}
          onUpload={onRemoteUpload}
          onDownload={onRemoteDownload}
          onTransferToServer={onRemoteTransferToServer}
          onDelete={onRemoteDelete}
          onDeleteFolder={onRemoteDeleteFolder}
        />
      </div>

      <div
        role="tabpanel"
        aria-hidden={currentTab !== "transfers"}
        style={{ display: currentTab === "transfers" ? "block" : "none" }}
      >
        <TransfersPanel
          transfers={transfers}
          loading={transfersLoading}
          onRefresh={onRefreshTransfers}
          onCancelTransfer={onCancelTransfer}
          onPauseTransfer={onPauseTransfer}
          onResumeTransfer={onResumeTransfer}
          onCancelBatch={onCancelBatch}
          onRetryTransfer={onRetryTransfer}
          onRemoveTransfer={onRemoveTransfer}
          onClearTransfers={onClearTransfers}
        />
      </div>
    </section>
  );
};
