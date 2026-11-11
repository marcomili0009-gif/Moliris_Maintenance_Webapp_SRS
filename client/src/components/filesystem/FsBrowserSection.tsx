import React, { useState } from "react";
import { ServerFsPanel } from "./ServerFsPanel.tsx";
import { RemoteFsPanel } from "./RemoteFsPanel.tsx";
import { TransfersPanel } from "./TransfersPanel.tsx";
import type { DirectoryListing } from "../../types/filesystem.ts";
import type { TransferProgress } from "../../types/transfer.ts";
import type { FormattedError } from "../../types/error.ts";

interface FsBrowserSectionProps {
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
  const [activeTab, setActiveTab] = useState<"server" | "remote" | "transfers">("server");

  return (
    <section id="fs-browser-section" className="fs-browser-card">
      <div className="fs-tab-bar">
        <button
          type="button"
          id="btn-tab-fs-server"
          className={`fs-tab-btn ${activeTab === "server" ? "active" : ""}`}
          onClick={() => setActiveTab("server")}
        >
          File sul Server (Archivio Locale)
        </button>

        <button
          type="button"
          id="btn-tab-fs-remote"
          className={`fs-tab-btn ${activeTab === "remote" ? "active" : ""}`}
          onClick={() => setActiveTab("remote")}
        >
          File sul Robot (Filesystem Remoto SFTP)
        </button>

        <button
          type="button"
          id="btn-tab-transfers"
          className={`fs-tab-btn ${activeTab === "transfers" ? "active" : ""}`}
          onClick={() => setActiveTab("transfers")}
        >
          Gestione Trasferimenti (<span id="transfers-active-count">{activeTransfersCount}</span> attivi)
        </button>
      </div>

      <div style={{ display: activeTab === "server" ? "block" : "none" }}>
        <ServerFsPanel
          robotId={serverRobotId}
          onRobotIdChange={onServerRobotIdChange}
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

      <div style={{ display: activeTab === "remote" ? "block" : "none" }}>
        <RemoteFsPanel
          robotId={remoteRobotId}
          onRobotIdChange={onRemoteRobotIdChange}
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

      <div style={{ display: activeTab === "transfers" ? "block" : "none" }}>
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
