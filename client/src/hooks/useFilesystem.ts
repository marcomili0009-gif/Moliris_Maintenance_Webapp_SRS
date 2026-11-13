import { useState, useCallback } from "react";
import { apiClient } from "../services/api-client.ts";
import { ErrorPresenter } from "../services/error-presenter.ts";
import { triggerDownload } from "../utils/download.ts";
import type { DirectoryListing, FsEntry } from "../types/filesystem.ts";
import type { FormattedError } from "../types/error.ts";

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
  const [remotePath, setRemotePath] = useState<string>("/");
  const [remoteListing, setRemoteListing] = useState<DirectoryListing | null>(null);
  const [remoteLoading, setRemoteLoading] = useState<boolean>(false);
  const [remoteError, setRemoteError] = useState<FormattedError | null>(null);

  // General Server Archive state (§3)
  const [generalPath, setGeneralPath] = useState<string>("/");
  const [generalListing, setGeneralListing] = useState<DirectoryListing | null>(null);
  const [generalLoading, setGeneralLoading] = useState<boolean>(false);
  const [generalError, setGeneralError] = useState<FormattedError | null>(null);

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
    setRemotePath("/");
  }, []);

  // Load Server Directory
  const loadServerDirectory = useCallback(async (robotId: string, path = "/") => {
    if (!robotId) return;
    setServerLoading(true);
    setServerError(null);
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
        setServerError(ErrorPresenter.formatError(errData));
      }
    } catch (err) {
      setServerError(ErrorPresenter.formatError(err));
    } finally {
      setServerLoading(false);
    }
  }, []);

  // Load Remote SFTP Directory
  const loadRemoteDirectory = useCallback(async (robotId: string, path = "/") => {
    if (!robotId) return;
    setRemoteLoading(true);
    setRemoteError(null);
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
        setRemoteError(ErrorPresenter.formatError(errData));
      }
    } catch (err) {
      setRemoteError(ErrorPresenter.formatError(err));
    } finally {
      setRemoteLoading(false);
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

  // Navigate Up General (§3)
  const navigateGeneralUp = () => {
    if (generalPath === "/" || !generalPath) return;
    const parts = generalPath.split("/").filter(Boolean);
    parts.pop();
    const parentPath = parts.length > 0 ? `/${parts.join("/")}` : "/";
    loadGeneralDirectory(parentPath);
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

  // Upload to General Server Archive (§3)
  const uploadToGeneral = async (file: File, targetPath: string, overwrite = false): Promise<boolean> => {
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

  // Download from General Server Archive (§3)
  const downloadFromGeneral = async (fileName: string) => {
    const filePath = generalPath.endsWith("/") ? `${generalPath}${fileName}` : `${generalPath}/${fileName}`;
    try {
      const res = await apiClient.get(
        `/api/fs/general/download?path=${encodeURIComponent(filePath)}`
      );
      if (res.ok) {
        triggerDownload(await res.blob(), fileName);
      } else {
        const errData = await res.json().catch(() => ({}));
        setGeneralError(ErrorPresenter.formatError(errData));
      }
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

  // Upload to Server
  const uploadToServer = async (file: File, targetPath: string, overwrite = false): Promise<boolean> => {
    if (!serverRobotId) return false;
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

  // Upload to Remote SFTP
  const uploadToRemote = async (file: File, targetPath: string, overwrite = false): Promise<boolean> => {
    if (!remoteRobotId) return false;
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

  // Download from Server
  const downloadFromServer = async (fileName: string) => {
    if (!serverRobotId) return;
    const filePath = serverPath.endsWith("/") ? `${serverPath}${fileName}` : `${serverPath}/${fileName}`;
    try {
      const res = await apiClient.get(
        `/api/robots/${encodeURIComponent(serverRobotId)}/transfers/client-server/download?path=${encodeURIComponent(filePath)}`
      );
      if (res.ok) {
        triggerDownload(await res.blob(), fileName);
      } else {
        const errData = await res.json().catch(() => ({}));
        setServerError(ErrorPresenter.formatError(errData));
      }
    } catch (err) {
      setServerError(ErrorPresenter.formatError(err));
    }
  };

  // Download from Remote SFTP
  const downloadFromRemote = async (fileName: string) => {
    if (!remoteRobotId) return;
    const filePath = remotePath.endsWith("/") ? `${remotePath}${fileName}` : `${remotePath}/${fileName}`;
    try {
      const res = await apiClient.get(
        `/api/robots/${encodeURIComponent(remoteRobotId)}/transfers/client-robot/download?path=${encodeURIComponent(filePath)}`
      );
      if (res.ok) {
        triggerDownload(await res.blob(), fileName);
      } else {
        const errData = await res.json().catch(() => ({}));
        setRemoteError(ErrorPresenter.formatError(errData));
      }
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

  // Delete from Remote SFTP
  const deleteFromRemote = async (fileName: string): Promise<boolean> => {
    if (!remoteRobotId) return false;
    const filePath = remotePath.endsWith("/") ? `${remotePath}${fileName}` : `${remotePath}/${fileName}`;
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

  // Transfer Server -> Remote SFTP
  const transferServerToRemote = async (fileName: string, overwrite = false): Promise<boolean> => {
    if (!serverRobotId) return false;
    const cleanServerPath = serverPath === "/" ? "" : serverPath.replace(/^\//, "");
    const serverRelativePath = cleanServerPath ? `${cleanServerPath}/${fileName}` : fileName;
    const remotePath = `/${fileName}`;
    try {
      const res = await apiClient.post(
        `/api/robots/${encodeURIComponent(serverRobotId)}/transfers/server-robot`,
        { direction: "SERVER_TO_ROBOT", serverRelativePath, remotePath, overwrite }
      );
      if (res.ok) {
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

  // Transfer Remote SFTP -> Server
  const transferRemoteToServer = async (fileName: string, overwrite = false): Promise<boolean> => {
    if (!remoteRobotId) return false;
    const remotePathClean = remotePath.endsWith("/") ? `${remotePath}${fileName}` : `${remotePath}/${fileName}`;
    const cleanServerPath = serverPath === "/" ? "" : serverPath.replace(/^\//, "");
    const serverRelativePath = cleanServerPath ? `${cleanServerPath}/${fileName}` : fileName;
    try {
      const res = await apiClient.post(
        `/api/robots/${encodeURIComponent(remoteRobotId)}/transfers/server-robot`,
        { direction: "ROBOT_TO_SERVER", serverRelativePath, remotePath: remotePathClean, overwrite }
      );
      if (res.ok) {
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
    transferServerToRemote,

    generalPath,
    setGeneralPath,
    generalListing,
    generalLoading,
    generalError,
    loadGeneralDirectory,
    navigateGeneralUp,
    createGeneralFolder,
    uploadToGeneral,
    downloadFromGeneral,
    deleteFromGeneral,
    clearGeneralError: () => setGeneralError(null),

    remoteRobotId,
    setRemoteRobotId,
    remotePath,
    remoteListing,
    remoteLoading,
    remoteError,
    loadRemoteDirectory,
    navigateRemoteUp,
    uploadToRemote,
    downloadFromRemote,
    deleteFromRemote,
    transferRemoteToServer,
    cleanupRobotTemp,

    clearServerError: () => setServerError(null),
    clearRemoteError: () => setRemoteError(null),
  };
}
