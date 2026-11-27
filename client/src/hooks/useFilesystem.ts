import { useState, useCallback } from "react";
import { apiClient } from "../services/api-client.ts";
import { ErrorPresenter } from "../services/error-presenter.ts";
import { triggerStreamingDownload } from "../utils/download.ts";
import type { DirectoryListing, FsEntry } from "../types/filesystem.ts";
import type { FormattedError } from "../types/error.ts";
import type { TransferStartResult } from "../types/transfer.ts";

export type UploadOutcome = "ok" | "conflict" | "error";

function isOverwriteConflictResponse(status: number, errData: any): boolean {
  const msg = typeof errData?.message === "string" ? errData.message.toLowerCase() : "";
  if (msg.includes("categoricamente")) return false;
  return status === 409 || msg.includes("già esistente") || msg.includes("esiste già");
}

function normalizeDirectoryListing(data: any, fallbackPath = "/"): DirectoryListing {
  if (!data) {
    return {
      path: fallbackPath,
      entries: [],
      totalCount: 0,
      isTruncated: false,
    };
  }

  const rawList = Array.isArray(data.entries)
    ? data.entries
    : Array.isArray(data.items)
    ? data.items
    : [];

  const entries: FsEntry[] = rawList.map((it: any) => ({
    name: it.name,
    type: it.type === "directory" ? "directory" : (it.type === "link" || it.type === "symlink" ? "symlink" : "file"),
    size: typeof it.size === "number" ? it.size : 0,
    mtime: it.mtime || it.modifiedAt || new Date().toISOString(),
    modifiedAt: it.modifiedAt || it.mtime || new Date().toISOString(),
    permissions: it.permissions,
    target: it.target,
    scope:
      it.scope === "deleted_robot"
        ? "deleted_robot"
        : it.scope === "robot"
        ? "robot"
        : it.scope === "general"
        ? "general"
        : undefined,
    robotId: typeof it.robotId === "string" ? it.robotId : undefined,
    displayName: typeof it.displayName === "string" ? it.displayName : undefined,
    exists: typeof it.exists === "boolean" ? it.exists : undefined,
    isDeletedRobot: Boolean(it.isDeletedRobot || it.scope === "deleted_robot"),
  }));

  return {
    path: data.path || data.currentPath || fallbackPath,
    currentPath: data.currentPath || data.path || fallbackPath,
    robotId: data.robotId,
    entries,
    items: data.items,
    totalCount: typeof data.totalCount === "number" ? data.totalCount : entries.length,
    isTruncated: Boolean(data.isTruncated || data.truncated),
  };
}

export function useFilesystem() {
  // Server state
  const [serverRobotId, setServerRobotIdState] = useState<string>("");
  const [serverPath, setServerPath] = useState<string>("/");
  const [serverListing, setServerListing] = useState<DirectoryListing | null>(null);
  const [serverLoading, setServerLoading] = useState<boolean>(false);
  const [serverError, setServerError] = useState<FormattedError | null>(null);

  // Remote SFTP state
  const [remoteRobotId, setRemoteRobotIdState] = useState<string>("");
  // Vuoto = directory iniziale dell'account SFTP (home), risolta dal backend.
  // Evita di operare sulla radice "/" dove l'utente robot non ha permessi di scrittura.
  const [remotePath, setRemotePath] = useState<string>("");
  const [remoteListing, setRemoteListing] = useState<DirectoryListing | null>(null);
  const [remoteLoading, setRemoteLoading] = useState<boolean>(false);
  const [remoteError, setRemoteError] = useState<FormattedError | null>(null);

  // General Server Archive state (§3) + Deleted Robot Archive state (ISS-017)
  const [generalPath, setGeneralPath] = useState<string>("/");
  const [generalListing, setGeneralListing] = useState<DirectoryListing | null>(null);
  const [generalLoading, setGeneralLoading] = useState<boolean>(false);
  const [generalError, setGeneralError] = useState<FormattedError | null>(null);
  const [deletedRobotFolder, setDeletedRobotFolder] = useState<string | null>(null);
  const [deletedRobotSubPath, setDeletedRobotSubPath] = useState<string>("/");

  const setServerRobotId = useCallback((id: string) => {
    setServerRobotIdState(id);
    setServerListing(null);
    setServerError(null);
    setServerPath("/");
  }, []);

  const setRemoteRobotId = useCallback((id: string) => {
    setRemoteRobotIdState(id);
    setRemoteListing(null);
    setRemoteError(null);
    setRemotePath("");
  }, []);

  // Load Server Directory
  const loadServerDirectory = useCallback(async (robotId: string, path = "/", options?: { silent?: boolean }) => {
    if (!robotId) return;
    const silent = options?.silent === true;
    // In modalità silent (aggiornamento dopo un'operazione) l'elenco non viene sostituito da un loader.
    if (!silent) {
      setServerLoading(true);
      setServerError(null);
    }
    try {
      const url = `/api/robots/${encodeURIComponent(robotId)}/fs/server/list?path=${encodeURIComponent(path)}`;
      const res = await apiClient.get(url);
      if (res.ok) {
        const data = await res.json();
        const normalized = normalizeDirectoryListing(data, path);
        setServerListing(normalized);
        setServerPath(normalized.path);
        setServerRobotIdState(robotId);
      } else {
        const errData = await res.json().catch(() => ({}));
        if (!silent) setServerError(ErrorPresenter.formatError(errData));
      }
    } catch (err) {
      if (!silent) setServerError(ErrorPresenter.formatError(err));
    } finally {
      if (!silent) setServerLoading(false);
    }
  }, []);

  // Load Remote SFTP Directory
  const loadRemoteDirectory = useCallback(async (robotId: string, path = "", options?: { silent?: boolean }) => {
    if (!robotId) return;
    const silent = options?.silent === true;
    if (!silent) {
      setRemoteLoading(true);
      setRemoteError(null);
    }
    try {
      const url = `/api/robots/${encodeURIComponent(robotId)}/fs/remote/list?path=${encodeURIComponent(path)}`;
      const res = await apiClient.get(url);
      if (res.ok) {
        const data = await res.json();
        const normalized = normalizeDirectoryListing(data, path);
        setRemoteListing(normalized);
        setRemotePath(normalized.path);
        setRemoteRobotIdState(robotId);
      } else {
        const errData = await res.json().catch(() => ({}));
        if (!silent) setRemoteError(ErrorPresenter.formatError(errData));
      }
    } catch (err) {
      if (!silent) setRemoteError(ErrorPresenter.formatError(err));
    } finally {
      if (!silent) setRemoteLoading(false);
    }
  }, []);

  // Navigate Up Server
  const navigateServerUp = () => {
    if (!serverRobotId || serverPath === "/" || !serverPath) return;
    const parts = serverPath.split("/").filter(Boolean);
    parts.pop();
    const parentPath = parts.length > 0 ? `/${parts.join("/")}` : "/";
    loadServerDirectory(serverRobotId, parentPath);
  };

  // Navigate Up Remote
  const navigateRemoteUp = () => {
    if (!remoteRobotId || remotePath === "/" || !remotePath) return;
    const parts = remotePath.split("/").filter(Boolean);
    parts.pop();
    const parentPath = parts.length > 0 ? `/${parts.join("/")}` : "/";
    loadRemoteDirectory(remoteRobotId, parentPath);
  };

  // Load General Server Directory (§3)
  const loadGeneralDirectory = useCallback(async (path = "/") => {
    setDeletedRobotFolder(null);
    setDeletedRobotSubPath("/");
    setGeneralLoading(true);
    setGeneralError(null);
    try {
      const url = `/api/fs/general/list?path=${encodeURIComponent(path)}`;
      const res = await apiClient.get(url);
      if (res.ok) {
        const data = await res.json();
        const normalized = normalizeDirectoryListing(data, path);
        setGeneralListing(normalized);
        setGeneralPath(normalized.path);
      } else {
        const errData = await res.json().catch(() => ({}));
        setGeneralError(ErrorPresenter.formatError(errData));
      }
    } catch (err) {
      setGeneralError(ErrorPresenter.formatError(err));
    } finally {
      setGeneralLoading(false);
    }
  }, []);

  // Load Deleted Robot Server Directory (ISS-017, Decisione #3)
  const loadDeletedRobotDirectory = useCallback(async (folderName: string, subPath = "/") => {
    setGeneralLoading(true);
    setGeneralError(null);
    try {
      const cleanSub = !subPath || subPath === "/" ? "/" : subPath.startsWith("/") ? subPath : `/${subPath}`;
      const url = `/api/fs/deleted-robots/${encodeURIComponent(folderName)}/list?path=${encodeURIComponent(cleanSub)}`;
      const res = await apiClient.get(url);
      if (res.ok) {
        const data = await res.json();
        const normalized = normalizeDirectoryListing(data, cleanSub);
        setDeletedRobotFolder(folderName);
        setDeletedRobotSubPath(normalized.path);
        setGeneralListing(normalized);
        setGeneralPath(normalized.path === "/" ? `/${folderName}` : `/${folderName}${normalized.path}`);
      } else {
        const errData = await res.json().catch(() => ({}));
        setGeneralError(ErrorPresenter.formatError(errData));
      }
    } catch (err) {
      setGeneralError(ErrorPresenter.formatError(err));
    } finally {
      setGeneralLoading(false);
    }
  }, []);

  // Navigate Up General (§3 + ISS-017 deleted robot support)
  const navigateGeneralUp = () => {
    if (deletedRobotFolder) {
      if (!deletedRobotSubPath || deletedRobotSubPath === "/") {
        void loadGeneralDirectory("/");
        return;
      }
      const parts = deletedRobotSubPath.split("/").filter(Boolean);
      parts.pop();
      const parentSub = parts.length > 0 ? `/${parts.join("/")}` : "/";
      void loadDeletedRobotDirectory(deletedRobotFolder, parentSub);
      return;
    }
    if (generalPath === "/" || !generalPath) return;
    const parts = generalPath.split("/").filter(Boolean);
    parts.pop();
    const parentPath = parts.length > 0 ? `/${parts.join("/")}` : "/";
    loadGeneralDirectory(parentPath);
  };

  // Navigate Directory in General (handles both general archive and deleted robot folder)
  const navigateGeneralDir = (dirName: string) => {
    if (deletedRobotFolder) {
      const nextSub = deletedRobotSubPath.endsWith("/")
        ? `${deletedRobotSubPath}${dirName}`
        : `${deletedRobotSubPath}/${dirName}`;
      void loadDeletedRobotDirectory(deletedRobotFolder, nextSub);
      return;
    }
    const newPath = generalPath.endsWith("/") ? `${generalPath}${dirName}` : `${generalPath}/${dirName}`;
    void loadGeneralDirectory(newPath);
  };

  // Navigate Path in General (breadcrumb)
  const navigateGeneralPath = (targetPath: string) => {
    if (!targetPath || targetPath === "/") {
      void loadGeneralDirectory("/");
      return;
    }
    if (deletedRobotFolder) {
      const prefix = `/${deletedRobotFolder}`;
      if (targetPath === prefix) {
        void loadDeletedRobotDirectory(deletedRobotFolder, "/");
        return;
      }
      if (targetPath.startsWith(`${prefix}/`)) {
        void loadDeletedRobotDirectory(deletedRobotFolder, targetPath.slice(prefix.length));
        return;
      }
    }
    void loadGeneralDirectory(targetPath);
  };

  // Delete Deleted Robot Folder permanently (admin-only, ISS-017)
  const deleteDeletedRobotFolder = async (
    folderName: string,
    expectedFileCount = 0,
    expectedDirectoryCount = 0
  ): Promise<boolean> => {
    try {
      const res = await apiClient.delete(
        `/api/fs/deleted-robots/${encodeURIComponent(folderName)}?expectedFileCount=${expectedFileCount}&expectedDirectoryCount=${expectedDirectoryCount}`
      );
      if (res.ok) {
        await loadGeneralDirectory("/");
        return true;
      }
      const errData = await res.json().catch(() => ({}));
      setGeneralError(ErrorPresenter.formatError(errData));
      return false;
    } catch (err) {
      setGeneralError(ErrorPresenter.formatError(err));
      return false;
    }
  };

  // Create Folder in Remote SFTP Directory (ISS-023)
  const createRemoteFolder = async (
    robotId: string,
    folderName: string,
    parentPath: string = remotePath
  ): Promise<{ success: boolean; error?: string }> => {
    if (!robotId) return { success: false, error: "Nessun robot selezionato." };
    try {
      const res = await apiClient.post(`/api/robots/${encodeURIComponent(robotId)}/fs/remote/mkdir`, {
        name: folderName,
        path: parentPath,
      });
      if (res.ok) {
        await loadRemoteDirectory(robotId, parentPath);
        return { success: true };
      }
      const errData = await res.json().catch(() => ({}));
      return { success: false, error: errData.message || "Errore nella creazione della cartella sul robot." };
    } catch (err: any) {
      return { success: false, error: err.message || "Errore di connessione." };
    }
  };

  // Create Folder in Dedicated Robot Server Directory (§4)
  const createRobotServerFolder = async (
    robotId: string,
    folderName: string,
    parentPath: string = serverPath
  ): Promise<{ success: boolean; error?: string }> => {
    if (!robotId) return { success: false, error: "Nessun robot selezionato." };
    try {
      const res = await apiClient.post(`/api/robots/${encodeURIComponent(robotId)}/fs/server/mkdir`, {
        name: folderName,
        path: parentPath,
      });
      if (res.ok) {
        await loadServerDirectory(robotId, parentPath);
        return { success: true };
      } else {
        const errData = await res.json().catch(() => ({}));
        return { success: false, error: errData.message || "Errore nella creazione della cartella." };
      }
    } catch (err: any) {
      return { success: false, error: err.message || "Errore di connessione." };
    }
  };

  // Create Folder in General Server Archive (§3, §4)
  const createGeneralFolder = async (
    folderName: string,
    parentPath: string = generalPath
  ): Promise<{ success: boolean; error?: string }> => {
    try {
      const res = await apiClient.post(`/api/fs/general/mkdir`, {
        name: folderName,
        path: parentPath,
      });
      if (res.ok) {
        await loadGeneralDirectory(parentPath);
        return { success: true };
      } else {
        const errData = await res.json().catch(() => ({}));
        return { success: false, error: errData.message || "Errore nella creazione della cartella." };
      }
    } catch (err: any) {
      return { success: false, error: err.message || "Errore di connessione." };
    }
  };

  // Upload to General Server Archive (§3, ISS-008)
  const uploadToGeneral = async (file: File, targetPath: string, overwrite = false): Promise<UploadOutcome> => {
    try {
      const cleanSubPath = targetPath === "/" ? "" : targetPath.replace(/^\//, "");
      const url = `/api/fs/general/upload?filename=${encodeURIComponent(file.name)}&path=${encodeURIComponent(cleanSubPath)}${overwrite ? "&overwrite=true" : ""}`;
      const res = await apiClient.request(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          "x-filename": file.name,
          "x-subpath": cleanSubPath,
          ...(overwrite ? { "x-overwrite": "true" } : {}),
        },
        body: file,
      });
      if (res.ok) {
        await loadGeneralDirectory(generalPath);
        return "ok";
      } else {
        const errData = await res.json().catch(() => ({}));
        if (!overwrite && isOverwriteConflictResponse(res.status, errData)) {
          return "conflict";
        }
        setGeneralError(ErrorPresenter.formatError(errData));
        return "error";
      }
    } catch (err) {
      setGeneralError(ErrorPresenter.formatError(err));
      return "error";
    }
  };

  // Download from General Server Archive (§3 + ISS-017 deleted robot support)
  const downloadFromGeneral = async (fileName: string) => {
    try {
      let url = "";
      if (deletedRobotFolder) {
        const fileSubPath = deletedRobotSubPath.endsWith("/")
          ? `${deletedRobotSubPath}${fileName}`
          : `${deletedRobotSubPath}/${fileName}`;
        url = `/api/fs/deleted-robots/${encodeURIComponent(deletedRobotFolder)}/download?path=${encodeURIComponent(fileSubPath)}`;
      } else {
        const filePath = generalPath.endsWith("/") ? `${generalPath}${fileName}` : `${generalPath}/${fileName}`;
        url = `/api/fs/general/download?path=${encodeURIComponent(filePath)}`;
      }
      apiClient.assertLocalBackendEndpoint(url);
      const preflight = await apiClient.get(`${url}&preflight=1`);
      if (!preflight.ok) {
        const errData = await preflight.json().catch(() => ({}));
        setGeneralError(ErrorPresenter.formatError(errData));
        return;
      }
      // Download progressivo: il browser scrive direttamente su disco, senza
      // caricare l'intero file in memoria (file fino a 3 GB).
      triggerStreamingDownload(url);
    } catch (err) {
      setGeneralError(ErrorPresenter.formatError(err));
    }
  };

  // Delete from General Server Archive (§3)
  const deleteFromGeneral = async (fileName: string): Promise<boolean> => {
    const filePath = generalPath.endsWith("/") ? `${generalPath}${fileName}` : `${generalPath}/${fileName}`;
    try {
      const res = await apiClient.delete(
        `/api/fs/general/file?path=${encodeURIComponent(filePath)}`
      );
      if (res.ok) {
        await loadGeneralDirectory(generalPath);
        return true;
      } else {
        const errData = await res.json().catch(() => ({}));
        setGeneralError(ErrorPresenter.formatError(errData));
        return false;
      }
    } catch (err) {
      setGeneralError(ErrorPresenter.formatError(err));
      return false;
    }
  };

  // Delete folder from General Server Archive with preflight-bound recursive support
  const deleteGeneralFolder = async (
    folderNameOrPath: string,
    recursive = true,
    expectedFileCount = 0,
    expectedDirectoryCount = 0
  ): Promise<boolean> => {
    const targetPath = folderNameOrPath.startsWith("/")
      ? folderNameOrPath
      : generalPath.endsWith("/")
      ? `${generalPath}${folderNameOrPath}`
      : `${generalPath}/${folderNameOrPath}`;
    try {
      const res = await apiClient.delete(
        `/api/fs/general/folder?path=${encodeURIComponent(targetPath)}&recursive=${recursive ? "true" : "false"}&expectedFileCount=${expectedFileCount}&expectedDirectoryCount=${expectedDirectoryCount}`
      );
      if (res.ok) {
        await loadGeneralDirectory(generalPath);
        return true;
      }
      const errData = await res.json().catch(() => ({}));
      setGeneralError(ErrorPresenter.formatError(errData));
      return false;
    } catch (err) {
      setGeneralError(ErrorPresenter.formatError(err));
      return false;
    }
  };

  // Upload to Server (ISS-008)
  const uploadToServer = async (file: File, targetPath: string, overwrite = false): Promise<UploadOutcome> => {
    if (!serverRobotId) return "error";
    try {
      const cleanSubPath = targetPath === "/" ? "" : targetPath.replace(/^\//, "");
      const url = `/api/robots/${encodeURIComponent(serverRobotId)}/transfers/client-server/upload?filename=${encodeURIComponent(file.name)}&subPath=${encodeURIComponent(cleanSubPath)}${overwrite ? "&overwrite=true" : ""}`;
      const res = await apiClient.request(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          "x-filename": file.name,
          "x-subpath": cleanSubPath,
          ...(overwrite ? { "x-overwrite": "true" } : {}),
        },
        body: file,
      });
      if (res.ok) {
        await loadServerDirectory(serverRobotId, serverPath);
        return "ok";
      } else {
        const errData = await res.json().catch(() => ({}));
        if (!overwrite && isOverwriteConflictResponse(res.status, errData)) {
          return "conflict";
        }
        setServerError(ErrorPresenter.formatError(errData));
        return "error";
      }
    } catch (err) {
      setServerError(ErrorPresenter.formatError(err));
      return "error";
    }
  };

  // Upload to Remote SFTP (ISS-008)
  const uploadToRemote = async (file: File, targetPath: string, overwrite = false): Promise<UploadOutcome> => {
    if (!remoteRobotId) return "error";
    try {
      const url = `/api/robots/${encodeURIComponent(remoteRobotId)}/transfers/client-robot/upload?filename=${encodeURIComponent(file.name)}&remoteDirectory=${encodeURIComponent(targetPath)}${overwrite ? "&overwrite=true" : ""}`;
      const res = await apiClient.request(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          "x-filename": file.name,
          "x-remote-dir": targetPath,
          ...(overwrite ? { "x-overwrite": "true" } : {}),
        },
        body: file,
      });
      if (res.ok) {
        await loadRemoteDirectory(remoteRobotId, remotePath);
        return "ok";
      } else {
        const errData = await res.json().catch(() => ({}));
        if (!overwrite && isOverwriteConflictResponse(res.status, errData)) {
          return "conflict";
        }
        setRemoteError(ErrorPresenter.formatError(errData));
        return "error";
      }
    } catch (err) {
      setRemoteError(ErrorPresenter.formatError(err));
      return "error";
    }
  };

  // Download from Server
  const downloadFromServer = async (fileName: string) => {
    if (!serverRobotId) return;
    const filePath = serverPath.endsWith("/") ? `${serverPath}${fileName}` : `${serverPath}/${fileName}`;
    try {
      const url = `/api/robots/${encodeURIComponent(serverRobotId)}/transfers/client-server/download?path=${encodeURIComponent(filePath)}`;
      apiClient.assertLocalBackendEndpoint(url);
      const preflight = await apiClient.get(`${url}&preflight=1`);
      if (!preflight.ok) {
        const errData = await preflight.json().catch(() => ({}));
        setServerError(ErrorPresenter.formatError(errData));
        return;
      }
      triggerStreamingDownload(url);
    } catch (err) {
      setServerError(ErrorPresenter.formatError(err));
    }
  };

  // Download from Remote SFTP
  const downloadFromRemote = async (fileName: string) => {
    if (!remoteRobotId) return;
    const filePath = remotePath
      ? (remotePath.endsWith("/") ? `${remotePath}${fileName}` : `${remotePath}/${fileName}`)
      : fileName;
    try {
      const url = `/api/robots/${encodeURIComponent(remoteRobotId)}/transfers/client-robot/download?path=${encodeURIComponent(filePath)}`;
      apiClient.assertLocalBackendEndpoint(url);
      const preflight = await apiClient.get(`${url}&preflight=1`);
      if (!preflight.ok) {
        const errData = await preflight.json().catch(() => ({}));
        setRemoteError(ErrorPresenter.formatError(errData));
        return;
      }
      triggerStreamingDownload(url);
    } catch (err) {
      setRemoteError(ErrorPresenter.formatError(err));
    }
  };

  // Delete from Server
  const deleteFromServer = async (fileName: string): Promise<boolean> => {
    if (!serverRobotId) return false;
    const filePath = serverPath.endsWith("/") ? `${serverPath}${fileName}` : `${serverPath}/${fileName}`;
    try {
      const res = await apiClient.delete(
        `/api/robots/${encodeURIComponent(serverRobotId)}/fs/server/file?path=${encodeURIComponent(filePath)}`
      );
      if (res.ok) {
        await loadServerDirectory(serverRobotId, serverPath);
        return true;
      } else {
        const errData = await res.json().catch(() => ({}));
        setServerError(ErrorPresenter.formatError(errData));
        return false;
      }
    } catch (err) {
      setServerError(ErrorPresenter.formatError(err));
      return false;
    }
  };

  // Delete folder from Server with preflight-bound recursive support
  const deleteServerFolder = async (
    robotId: string,
    folderNameOrPath: string,
    recursive = true,
    expectedFileCount = 0,
    expectedDirectoryCount = 0
  ): Promise<boolean> => {
    if (!robotId) return false;
    const targetPath = folderNameOrPath.startsWith("/")
      ? folderNameOrPath
      : serverPath.endsWith("/")
      ? `${serverPath}${folderNameOrPath}`
      : `${serverPath}/${folderNameOrPath}`;
    try {
      const res = await apiClient.delete(
        `/api/robots/${encodeURIComponent(robotId)}/fs/server/folder?path=${encodeURIComponent(targetPath)}&recursive=${recursive ? "true" : "false"}&expectedFileCount=${expectedFileCount}&expectedDirectoryCount=${expectedDirectoryCount}`
      );
      if (res.ok) {
        await loadServerDirectory(robotId, serverPath);
        return true;
      }
      const errData = await res.json().catch(() => ({}));
      setServerError(ErrorPresenter.formatError(errData));
      return false;
    } catch (err) {
      setServerError(ErrorPresenter.formatError(err));
      return false;
    }
  };

  // Delete from Remote SFTP
  const deleteFromRemote = async (fileName: string): Promise<boolean> => {
    if (!remoteRobotId) return false;
    const filePath = remotePath
      ? (remotePath.endsWith("/") ? `${remotePath}${fileName}` : `${remotePath}/${fileName}`)
      : fileName;
    try {
      const res = await apiClient.delete(
        `/api/robots/${encodeURIComponent(remoteRobotId)}/fs/remote/file?path=${encodeURIComponent(filePath)}`
      );
      if (res.ok) {
        await loadRemoteDirectory(remoteRobotId, remotePath);
        return true;
      } else {
        const errData = await res.json().catch(() => ({}));
        setRemoteError(ErrorPresenter.formatError(errData));
        return false;
      }
    } catch (err) {
      setRemoteError(ErrorPresenter.formatError(err));
      return false;
    }
  };

  // Delete folder from Remote SFTP with preflight-bound recursive support
  const deleteRemoteFolder = async (
    robotId: string,
    folderNameOrPath: string,
    recursive = true,
    expectedFileCount = 0,
    expectedDirectoryCount = 0
  ): Promise<boolean> => {
    if (!robotId) return false;
    const targetPath = folderNameOrPath.startsWith("/")
      ? folderNameOrPath
      : remotePath
      ? (remotePath.endsWith("/") ? `${remotePath}${folderNameOrPath}` : `${remotePath}/${folderNameOrPath}`)
      : folderNameOrPath;
    try {
      const res = await apiClient.delete(
        `/api/robots/${encodeURIComponent(robotId)}/fs/remote/folder?path=${encodeURIComponent(targetPath)}&recursive=${recursive ? "true" : "false"}&expectedFileCount=${expectedFileCount}&expectedDirectoryCount=${expectedDirectoryCount}`
      );
      if (res.ok) {
        await loadRemoteDirectory(robotId, remotePath);
        return true;
      }
      const errData = await res.json().catch(() => ({}));
      setRemoteError(ErrorPresenter.formatError(errData));
      return false;
    } catch (err) {
      setRemoteError(ErrorPresenter.formatError(err));
      return false;
    }
  };

  /** Unisce cartella di destinazione e nome file senza doppi slash. */
  const joinDestination = (directory: string | undefined, fileName: string): string => {
    if (!directory) return fileName;
    return directory.endsWith("/") ? `${directory}${fileName}` : `${directory}/${fileName}`;
  };

  /** Sorgente relativa alla cartella del robot sul server (senza slash iniziale). */
  const serverRelative = (directory: string | undefined, fileName: string): string => {
    const clean = !directory || directory === "/" ? "" : directory.replace(/^\/+/, "").replace(/\/+$/, "");
    return clean ? `${clean}/${fileName}` : fileName;
  };

  // Transfer Server -> Remote SFTP: il backend risponde 202 appena il trasferimento è preso in carico
  const transferServerToRemote = async (
    fileName: string,
    targetRemoteDirectory?: string,
    overwrite = false
  ): Promise<TransferStartResult> => {
    if (!serverRobotId) return { ok: false };
    const serverRelativePath = serverRelative(serverPath, fileName);
    const remoteDestination = joinDestination(targetRemoteDirectory, fileName);
    try {
      const res = await apiClient.post(
        `/api/robots/${encodeURIComponent(serverRobotId)}/transfers/server-robot`,
        { direction: "SERVER_TO_ROBOT", serverRelativePath, remotePath: remoteDestination, overwrite, background: true }
      );
      if (res.ok) {
        const dto = await res.json().catch(() => ({}));
        return { ok: true, transferId: dto?.transferId };
      }
      const errData = await res.json().catch(() => ({}));
      const formatted = ErrorPresenter.formatError(errData);
      return { ok: false, error: formatted.userMessage };
    } catch (err) {
      return { ok: false, error: ErrorPresenter.formatError(err).userMessage };
    }
  };

  // Transfer Remote SFTP -> Server
  const transferRemoteToServer = async (
    fileName: string,
    targetServerDirectory?: string,
    overwrite = false
  ): Promise<TransferStartResult> => {
    if (!remoteRobotId) return { ok: false };
    const remotePathClean = joinDestination(remotePath, fileName);
    const serverRelativePath = serverRelative(targetServerDirectory ?? serverPath, fileName);
    try {
      const res = await apiClient.post(
        `/api/robots/${encodeURIComponent(remoteRobotId)}/transfers/server-robot`,
        { direction: "ROBOT_TO_SERVER", serverRelativePath, remotePath: remotePathClean, overwrite, background: true }
      );
      if (res.ok) {
        const dto = await res.json().catch(() => ({}));
        return { ok: true, transferId: dto?.transferId };
      }
      const errData = await res.json().catch(() => ({}));
      const formatted = ErrorPresenter.formatError(errData);
      return { ok: false, error: formatted.userMessage };
    } catch (err) {
      return { ok: false, error: ErrorPresenter.formatError(err).userMessage };
    }
  };

  // Cleanup Temp on Robot
  const cleanupRobotTemp = async (robotId: string): Promise<boolean> => {
    try {
      const res = await apiClient.post(`/api/robots/${encodeURIComponent(robotId)}/fs/cleanup-temp`, {});
      return res.ok;
    } catch {
      return false;
    }
  };

  return {
    serverRobotId,
    setServerRobotId,
    serverPath,
    serverListing,
    serverLoading,
    serverError,
    loadServerDirectory,
    navigateServerUp,
    createRobotServerFolder,
    uploadToServer,
    downloadFromServer,
    deleteFromServer,
    deleteServerFolder,
    transferServerToRemote,

    generalPath,
    setGeneralPath,
    generalListing,
    generalLoading,
    generalError,
    deletedRobotFolder,
    loadGeneralDirectory,
    loadDeletedRobotDirectory,
    navigateGeneralUp,
    navigateGeneralDir,
    navigateGeneralPath,
    createGeneralFolder,
    uploadToGeneral,
    downloadFromGeneral,
    deleteFromGeneral,
    deleteGeneralFolder,
    deleteDeletedRobotFolder,
    clearGeneralError: () => setGeneralError(null),

    remoteRobotId,
    setRemoteRobotId,
    remotePath,
    remoteListing,
    remoteLoading,
    remoteError,
    loadRemoteDirectory,
    navigateRemoteUp,
    createRemoteFolder,
    uploadToRemote,
    downloadFromRemote,
    deleteFromRemote,
    deleteRemoteFolder,
    transferRemoteToServer,
    cleanupRobotTemp,

    clearServerError: () => setServerError(null),
    clearRemoteError: () => setRemoteError(null),
  };
}
