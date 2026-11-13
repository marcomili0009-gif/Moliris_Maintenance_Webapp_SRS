import React, { useState } from "react";
import { ServerFsPanel } from "./ServerFsPanel.tsx";
import { GeneralFsPanel } from "./GeneralFsPanel.tsx";
import { RemoteFsPanel } from "./RemoteFsPanel.tsx";
import { TransfersPanel } from "./TransfersPanel.tsx";
import type { DirectoryListing } from "../../types/filesystem.ts";
import type { TransferProgress } from "../../types/transfer.ts";
import type { FormattedError } from "../../types/error.ts";
import type { RobotSummaryDto } from "../../types/fleet.ts";

export type FsSubTab = "server" | "general" | "remote" | "transfers";

interface FsBrowserSectionProps {
  robots?: RobotSummaryDto[];
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
  onCreateServerFolder?: (name: string) => Promise<{ success: boolean; error?: string }>;
  onServerUpload: (file: File) => void;
  onServerDownload: (fileName: string) => void;
  onServerTransferToRemote: (fileName: string) => void;
  onServerDelete: (fileName: string) => void;

  // General Server Archive
  generalPath?: string;
  generalListing?: DirectoryListing | null;
  generalLoading?: boolean;
  generalError?: FormattedError | null;
  onLoadGeneral?: (path?: string) => void;
  onGeneralUp?: () => void;
  onGeneralNavigateDir?: (dirName: string) => void;
  onCreateGeneralFolder?: (name: string) => Promise<{ success: boolean; error?: string }>;
  onGeneralUpload?: (file: File) => void;
  onGeneralDownload?: (fileName: string) => void;
  onGeneralDelete?: (fileName: string) => void;

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
  onRemoteUpload: (file: File) => void;
  onRemoteDownload: (fileName: string) => void;
  onRemoteTransferToServer: (fileName: string) => void;
  onRemoteDelete: (fileName: string) => void;

  // Transfers
  transfers: TransferProgress[];
  transfersLoading: boolean;
  activeTransfersCount: number;
  onRefreshTransfers: () => void;
  onCancelTransfer: (id: string) => void;
}

export const FsBrowserSection: React.FC<FsBrowserSectionProps> = ({
  robots = [],
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
  onCreateServerFolder,
  onServerUpload,
  onServerDownload,
  onServerTransferToRemote,
  onServerDelete,

  generalPath = "/",
  generalListing = null,
  generalLoading = false,
  generalError = null,
  onLoadGeneral = () => {},
  onGeneralUp = () => {},
  onGeneralNavigateDir = () => {},
  onCreateGeneralFolder = async () => ({ success: false, error: "Non supportato" }),
  onGeneralUpload = () => {},
  onGeneralDownload = () => {},
  onGeneralDelete = () => {},

  remoteRobotId,
  onRemoteRobotIdChange,
  remotePath,
  remoteListing,
  remoteLoading,
  remoteError,
  onLoadRemote,
  onRemoteUp,
  onRemoteNavigateDir,
  onRemoteUpload,
  onRemoteDownload,
  onRemoteTransferToServer,
  onRemoteDelete,

  transfers,
  transfersLoading,
  activeTransfersCount,
  onRefreshTransfers,
  onCancelTransfer,
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

      {/* 2. Tab di navigazione */}
      <div className="fs-tab-bar mb-3 d-flex flex-wrap gap-2">
        <button
          type="button"
          id="btn-tab-fs-server"
          data-view="server"
          className={`fs-tab-btn ${currentTab === "server" ? "active" : ""}`}
          onClick={() => handleTabClick("server")}
        >
          File sul Server (Archivio Locale)
        </button>

        <button
          type="button"
          id="btn-tab-general"
          data-view="general"
          className={`fs-tab-btn ${currentTab === "general" ? "active" : ""}`}
          onClick={() => handleTabClick("general")}
        >
          Archivio Generale Server
        </button>

        <button
          type="button"
          id="btn-tab-fs-remote"
          data-view="remote"
          className={`fs-tab-btn ${currentTab === "remote" ? "active" : ""}`}
          onClick={() => handleTabClick("remote")}
        >
          File sul Robot (Filesystem Remoto SFTP)
        </button>

        <button
          type="button"
          id="btn-tab-transfers"
          data-view="transfers"
          className={`fs-tab-btn ${currentTab === "transfers" ? "active" : ""}`}
          onClick={() => handleTabClick("transfers")}
        >
          Gestione Trasferimenti (<span id="transfers-active-count">{activeTransfersCount}</span> attivi)
        </button>
      </div>

      <div style={{ display: currentTab === "server" ? "block" : "none" }}>
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
          onCreateFolder={onCreateServerFolder}
          onUpload={onServerUpload}
          onDownload={onServerDownload}
          onTransferToRemote={onServerTransferToRemote}
          onDelete={onServerDelete}
        />
      </div>

      <div style={{ display: currentTab === "general" ? "block" : "none" }}>
        <GeneralFsPanel
          currentPath={generalPath}
          listing={generalListing}
          loading={generalLoading}
          error={generalError}
          onLoad={onLoadGeneral}
          onUp={onGeneralUp}
          onNavigateDir={onGeneralNavigateDir}
          onCreateFolder={onCreateGeneralFolder}
          onUpload={onGeneralUpload}
          onDownload={onGeneralDownload}
          onDelete={onGeneralDelete}
        />
      </div>

      <div style={{ display: currentTab === "remote" ? "block" : "none" }}>
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
          onUpload={onRemoteUpload}
          onDownload={onRemoteDownload}
          onTransferToServer={onRemoteTransferToServer}
          onDelete={onRemoteDelete}
        />
      </div>

      <div style={{ display: currentTab === "transfers" ? "block" : "none" }}>
        <TransfersPanel
          transfers={transfers}
          loading={transfersLoading}
          onRefresh={onRefreshTransfers}
          onCancelTransfer={onCancelTransfer}
        />
      </div>
    </section>
  );
};
