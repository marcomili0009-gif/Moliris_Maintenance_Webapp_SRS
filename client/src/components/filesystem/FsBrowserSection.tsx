import React, { useState } from "react";
import { ServerFsPanel } from "./ServerFsPanel.tsx";
import { RemoteFsPanel } from "./RemoteFsPanel.tsx";
import { TransfersPanel } from "./TransfersPanel.tsx";
import type { DirectoryListing } from "../../types/filesystem.ts";
import type { TransferProgress } from "../../types/transfer.ts";
import type { FormattedError } from "../../types/error.ts";
import type { RobotSummaryDto } from "../../types/fleet.ts";

interface FsBrowserSectionProps {
  robots?: RobotSummaryDto[];
  activeSubTab?: "server" | "remote" | "transfers";
  onSubTabChange?: (tab: "server" | "remote" | "transfers") => void;

  // Server
  serverRobotId: string;
  onServerRobotIdChange: (id: string) => void;
  serverPath: string;
  serverListing: DirectoryListing | null;
  serverLoading: boolean;
  serverError: FormattedError | null;
  onLoadServer: () => void;
  onServerUp: () => void;
  onServerNavigateDir: (dirName: string) => void;
  onServerUpload: (file: File) => void;
  onServerDownload: (fileName: string) => void;
  onServerTransferToRemote: (fileName: string) => void;
  onServerDelete: (fileName: string) => void;

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
  onRemotePurgeTemp: () => void;

  // Transfers
  transfers: TransferProgress[];
  transfersLoading: boolean;
  activeTransfersCount: number;
  onRefreshTransfers: () => void;
  onPurgeAllTemp: () => void;
  onCancelTransfer: (id: string) => void;
}

export const FsBrowserSection: React.FC<FsBrowserSectionProps> = ({
  robots = [],
  activeSubTab,
  onSubTabChange,

  serverRobotId,
  onServerRobotIdChange,
  serverPath,
  serverListing,
  serverLoading,
  serverError,
  onLoadServer,
  onServerUp,
  onServerNavigateDir,
  onServerUpload,
  onServerDownload,
  onServerTransferToRemote,
  onServerDelete,

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
  onRemotePurgeTemp,

  transfers,
  transfersLoading,
  activeTransfersCount,
  onRefreshTransfers,
  onPurgeAllTemp,
  onCancelTransfer,
}) => {
  const [internalTab, setInternalTab] = useState<"server" | "remote" | "transfers">("server");
  const currentTab = activeSubTab ?? internalTab;

  const handleTabClick = (tab: "server" | "remote" | "transfers") => {
    setInternalTab(tab);
    if (onSubTabChange) {
      onSubTabChange(tab);
    }
  };

  return (
    <section id="fs-browser-section" className="fs-browser-card p-3">
      <div className="fs-tab-bar mb-3">
        <button
          type="button"
          id="btn-tab-fs-server"
          data-view="server"
          className={`fs-tab-btn ${currentTab === "server" ? "active" : ""}`}
          onClick={() => handleTabClick("server")}
        >
          📁 File sul Server (Archivio Locale)
        </button>

        <button
          type="button"
          id="btn-tab-fs-remote"
          data-view="remote"
          className={`fs-tab-btn ${currentTab === "remote" ? "active" : ""}`}
          onClick={() => handleTabClick("remote")}
        >
          🤖 File sul Robot (Filesystem Remoto SFTP)
        </button>

        <button
          type="button"
          id="btn-tab-transfers"
          data-view="transfers"
          className={`fs-tab-btn ${currentTab === "transfers" ? "active" : ""}`}
          onClick={() => handleTabClick("transfers")}
        >
          ⚡ Gestione Trasferimenti (<span id="transfers-active-count">{activeTransfersCount}</span> attivi)
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
          onUpload={onServerUpload}
          onDownload={onServerDownload}
          onTransferToRemote={onServerTransferToRemote}
          onDelete={onServerDelete}
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
          onPurgeTemp={onRemotePurgeTemp}
        />
      </div>

      <div style={{ display: currentTab === "transfers" ? "block" : "none" }}>
        <TransfersPanel
          transfers={transfers}
          loading={transfersLoading}
          onRefresh={onRefreshTransfers}
          onPurgeTemp={onPurgeAllTemp}
          onCancelTransfer={onCancelTransfer}
        />
      </div>
    </section>
  );
};
