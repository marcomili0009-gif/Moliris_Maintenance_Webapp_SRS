import { useState, useCallback } from "react";
import { apiClient } from "../services/api-client.ts";
import { ErrorPresenter } from "../services/error-presenter.ts";
import type { DirectoryListing } from "../types/filesystem.ts";
import type { FormattedError } from "../types/error.ts";

export function useFilesystem() {
  // Server state
  const [serverRobotId, setServerRobotId] = useState<string>("");
  const [serverPath, setServerPath] = useState<string>("/");
  const [serverListing, setServerListing] = useState<DirectoryListing | null>(null);
  const [serverLoading, setServerLoading] = useState<boolean>(false);
  const [serverError, setServerError] = useState<FormattedError | null>(null);

  // Remote SFTP state
  const [remoteRobotId, setRemoteRobotId] = useState<string>("");
  const [remotePath, setRemotePath] = useState<string>("/");
  const [remoteListing, setRemoteListing] = useState<DirectoryListing | null>(null);
  const [remoteLoading, setRemoteLoading] = useState<boolean>(false);
  const [remoteError, setRemoteError] = useState<FormattedError | null>(null);

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
        setServerListing(data);
        setServerPath(data.path || path);
        setServerRobotId(robotId);
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
        setRemoteListing(data);
        setRemotePath(data.path || path);
        setRemoteRobotId(robotId);
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

  // Upload to Server
  const uploadToServer = async (file: File, targetPath: string, overwrite = false): Promise<boolean> => {
    if (!serverRobotId) return false;
    const formData = new FormData();
    formData.append("file", file);
    formData.append("path", targetPath);
    if (overwrite) formData.append("overwrite", "true");

    try {
      const res = await apiClient.post(
        `/api/robots/${encodeURIComponent(serverRobotId)}/fs/server/upload`,
        formData
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

  // Upload to Remote SFTP
  const uploadToRemote = async (file: File, targetPath: string, overwrite = false): Promise<boolean> => {
    if (!remoteRobotId) return false;
    const formData = new FormData();
    formData.append("file", file);
    formData.append("path", targetPath);
    if (overwrite) formData.append("overwrite", "true");

    try {
      const res = await apiClient.post(
        `/api/robots/${encodeURIComponent(remoteRobotId)}/fs/remote/upload`,
        formData
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

  // Download from Server
  const downloadFromServer = async (fileName: string) => {
    if (!serverRobotId) return;
    const filePath = serverPath.endsWith("/") ? `${serverPath}${fileName}` : `${serverPath}/${fileName}`;
    try {
      const res = await apiClient.get(
        `/api/robots/${encodeURIComponent(serverRobotId)}/fs/server/download?path=${encodeURIComponent(filePath)}`
      );
      if (res.ok) {
        const blob = await res.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        a.remove();
        window.URL.revokeObjectURL(url);
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
        `/api/robots/${encodeURIComponent(remoteRobotId)}/fs/remote/download?path=${encodeURIComponent(filePath)}`
      );
      if (res.ok) {
        const blob = await res.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        a.remove();
        window.URL.revokeObjectURL(url);
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
    const sourcePath = serverPath.endsWith("/") ? `${serverPath}${fileName}` : `${serverPath}/${fileName}`;
    const targetPath = `/${fileName}`;
    try {
      const res = await apiClient.post(
        `/api/robots/${encodeURIComponent(serverRobotId)}/fs/transfer-to-remote`,
        { sourcePath, targetPath, overwrite }
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
    const sourcePath = remotePath.endsWith("/") ? `${remotePath}${fileName}` : `${remotePath}/${fileName}`;
    const targetPath = `/${fileName}`;
    try {
      const res = await apiClient.post(
        `/api/robots/${encodeURIComponent(remoteRobotId)}/fs/transfer-to-server`,
        { sourcePath, targetPath, overwrite }
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
    uploadToServer,
    downloadFromServer,
    deleteFromServer,
    transferServerToRemote,

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
