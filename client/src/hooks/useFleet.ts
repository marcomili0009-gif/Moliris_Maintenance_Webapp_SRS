import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { apiClient } from "../services/api-client.ts";
import { ErrorPresenter } from "../services/error-presenter.ts";
import type {
  RobotSummaryDto,
  RobotDetailDto,
  RegisterRobotPayload,
  RegistrationOutcome,
  EditRobotPayload,
} from "../types/fleet.ts";
import type { FormattedError } from "../types/error.ts";

export function useFleet(isAuthenticated: boolean) {
  const [robots, setRobots] = useState<RobotSummaryDto[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<FormattedError | null>(null);

  const [selectedRobot, setSelectedRobot] = useState<RobotDetailDto | null>(null);
  const selectedRobotRef = useRef<RobotDetailDto | null>(selectedRobot);
  selectedRobotRef.current = selectedRobot;

  const [loadingDetail, setLoadingDetail] = useState<boolean>(false);

  const loadFleet = useCallback(async () => {
    if (!isAuthenticated) return;
    setLoading(true);
    setError(null);
    try {
      const res = await apiClient.get("/api/robots");
      if (res.ok) {
        const data = await res.json();
        setRobots(data.robots || []);
      } else {
        const errData = await res.json().catch(() => ({}));
        setError(ErrorPresenter.formatError(errData));
      }
    } catch (err) {
      setError(ErrorPresenter.formatError(err));
    } finally {
      setLoading(false);
    }
  }, [isAuthenticated]);

  const loadRobotDetail = useCallback(async (robotId: string): Promise<RobotDetailDto | null> => {
    setLoadingDetail(true);
    try {
      const res = await apiClient.get(`/api/robots/${encodeURIComponent(robotId)}`);
      if (res.ok) {
        const data = await res.json();
        const detail: RobotDetailDto = {
          ...data.robot,
          features: data.robot?.features || (data.availableFeatures ? {
            monitoring: {
              available: data.availableFeatures.monitoring,
              reason: data.availableFeatures.reasons?.monitoring,
            },
            terminal: {
              available: data.availableFeatures.terminal,
              reason: data.availableFeatures.reasons?.terminal,
            },
            remoteFs: {
              available: data.availableFeatures.remoteFs,
              reason: data.availableFeatures.reasons?.remoteFs,
            },
            serverFs: {
              available: data.availableFeatures.serverFs,
              reason: data.availableFeatures.reasons?.serverFs,
            },
            transfer: {
              available: data.availableFeatures.transfers,
              reason: data.availableFeatures.reasons?.transfers,
            },
          } : undefined),
        };
        setSelectedRobot(detail);
        return detail;
      } else {
        const errData = await res.json().catch(() => ({}));
        setError(ErrorPresenter.formatError(errData));
        return null;
      }
    } catch (err) {
      setError(ErrorPresenter.formatError(err));
      return null;
    } finally {
      setLoadingDetail(false);
    }
  }, []);

  const normalizeRobotPayload = (raw: any) => {
    const { fingerprint, knownHostsPath, strictHostKeyChecking, ...rest } = raw;
    if (rest.hostKeyVerification) return rest;
    if (fingerprint || knownHostsPath) {
      return {
        ...rest,
        hostKeyVerification: {
          ...(fingerprint ? { fingerprint } : {}),
          ...(knownHostsPath ? { knownHostsPath } : {}),
          strictHostKeyChecking: strictHostKeyChecking ?? true,
        },
      };
    }
    return rest;
  };

  const registerRobot = useCallback(async (
    payload: RegisterRobotPayload
  ): Promise<{ outcome?: RegistrationOutcome; error?: FormattedError; fieldErrors?: Record<string, string> }> => {
    try {
      const res = await apiClient.post("/api/robots", normalizeRobotPayload(payload));
      const data = await res.json();

      if (res.ok && data.outcome) {
        await loadFleet();
        return { outcome: typeof data.outcome === "string" ? data : data.outcome };
      } else {
        const fieldErrors = data.fieldErrors || data.validationErrors;
        if (fieldErrors) {
          return { fieldErrors, error: ErrorPresenter.formatError(data) };
        }
        return { error: ErrorPresenter.formatError(data) };
      }
    } catch (err) {
      return { error: ErrorPresenter.formatError(err) };
    }
  }, [loadFleet]);

  const updateRobot = useCallback(async (robotId: string, payload: EditRobotPayload): Promise<boolean> => {
    try {
      const res = await apiClient.put(`/api/robots/${encodeURIComponent(robotId)}/configuration`, normalizeRobotPayload(payload));
      if (res.ok) {
        await loadFleet();
        if (selectedRobotRef.current?.id === robotId) {
          await loadRobotDetail(robotId);
        }
        return true;
      } else {
        const errData = await res.json().catch(() => ({}));
        setError(ErrorPresenter.formatError(errData));
        return false;
      }
    } catch (err) {
      setError(ErrorPresenter.formatError(err));
      return false;
    }
  }, [loadFleet, loadRobotDetail]);

  const refreshStatus = useCallback(async (robotId: string): Promise<boolean> => {
    try {
      const res = await apiClient.post(`/api/robots/${encodeURIComponent(robotId)}/status/refresh`, {});
      if (res.ok) {
        await loadFleet();
        if (selectedRobotRef.current?.id === robotId) {
          await loadRobotDetail(robotId);
        }
        return true;
      } else {
        const errData = await res.json().catch(() => ({}));
        setError(ErrorPresenter.formatError(errData));
        return false;
      }
    } catch (err) {
      setError(ErrorPresenter.formatError(err));
      return false;
    }
  }, [loadFleet, loadRobotDetail]);

  const verifyConnection = useCallback(async (robotId: string): Promise<boolean> => {
    try {
      const res = await apiClient.post(`/api/robots/${encodeURIComponent(robotId)}/verify-connection`, {});
      if (res.ok) {
        await loadFleet();
        if (selectedRobotRef.current?.id === robotId) {
          await loadRobotDetail(robotId);
        }
        return true;
      } else {
        const errData = await res.json().catch(() => ({}));
        setError(ErrorPresenter.formatError(errData));
        return false;
      }
    } catch (err) {
      setError(ErrorPresenter.formatError(err));
      return false;
    }
  }, [loadFleet, loadRobotDetail]);

  const repairRobot = useCallback(async (robotId: string): Promise<boolean> => {
    try {
      const res = await apiClient.post(`/api/robots/${encodeURIComponent(robotId)}/repair`, {});
      if (res.ok) {
        await loadFleet();
        return true;
      } else {
        const errData = await res.json().catch(() => ({}));
        setError(ErrorPresenter.formatError(errData));
        return false;
      }
    } catch (err) {
      setError(ErrorPresenter.formatError(err));
      return false;
    }
  }, [loadFleet]);

  const toggleEnableDisable = useCallback(async (robotId: string, currentStatus: string): Promise<boolean> => {
    const action = currentStatus === "attivo" ? "disable" : "enable";
    try {
      const res = await apiClient.post(`/api/robots/${encodeURIComponent(robotId)}/${action}`, {});
      if (res.ok) {
        await loadFleet();
        if (selectedRobotRef.current?.id === robotId) {
          await loadRobotDetail(robotId);
        }
        return true;
      } else {
        const errData = await res.json().catch(() => ({}));
        setError(ErrorPresenter.formatError(errData));
        return false;
      }
    } catch (err) {
      setError(ErrorPresenter.formatError(err));
      return false;
    }
  }, [loadFleet, loadRobotDetail]);

  const removeRobot = useCallback(async (robotId: string): Promise<boolean> => {
    try {
      const res = await apiClient.post(`/api/robots/${encodeURIComponent(robotId)}/remove`, { confirmation: true });
      if (res.ok) {
        await loadFleet();
        setSelectedRobot(null);
        return true;
      } else {
        const errData = await res.json().catch(() => ({}));
        setError(ErrorPresenter.formatError(errData));
        return false;
      }
    } catch (err) {
      setError(ErrorPresenter.formatError(err));
      return false;
    }
  }, [loadFleet]);

  const deleteServerData = useCallback(async (robotId: string): Promise<boolean> => {
    try {
      const res = await apiClient.delete(`/api/robots/${encodeURIComponent(robotId)}/server-data`, {
        body: JSON.stringify({ confirmation: true }),
        headers: { "Content-Type": "application/json" },
      });
      if (res.ok) {
        await loadFleet();
        return true;
      } else {
        const errData = await res.json().catch(() => ({}));
        setError(ErrorPresenter.formatError(errData));
        return false;
      }
    } catch (err) {
      setError(ErrorPresenter.formatError(err));
      return false;
    }
  }, [loadFleet]);

  const refreshFleet = useCallback(async (): Promise<boolean> => {
    setLoading(true);
    setError(null);
    try {
      await apiClient.post("/api/fleet/status/refresh", {}).catch(() => {});
      await loadFleet();
      return true;
    } catch (err) {
      setError(ErrorPresenter.formatError(err));
      return false;
    } finally {
      setLoading(false);
    }
  }, [loadFleet]);

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  useEffect(() => {
    if (!isAuthenticated) {
      setRobots([]);
      setSelectedRobot(null);
      return;
    }

    loadFleet();

    // Polling automatico della flotta: intervallo letto da fleetPollingIntervalSeconds
    // in /api/config/public (fallback 5 s; 0 = polling disattivato) (§16)
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | undefined;

    const resolvePollIntervalMs = async (): Promise<number> => {
      const fallbackSeconds = 5;
      try {
        const res = await apiClient.get("/api/config/public");
        if (res.ok) {
          const cfg = await res.json();
          const seconds = Number(cfg?.fleetPollingIntervalSeconds);
          if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
        }
      } catch {
        // Configurazione non raggiungibile: si usa il fallback
      }
      return fallbackSeconds * 1000;
    };

    void resolvePollIntervalMs().then((pollIntervalMs) => {
      if (cancelled || pollIntervalMs <= 0) return;
      timer = setInterval(() => {
        // Aggiornamento silenzioso dei dati senza flickering dello spinner
        apiClient
          .get("/api/robots")
          .then(async (res) => {
            if (res.ok) {
              const data = await res.json();
              setRobots(data.robots || []);
            }
          })
          .catch(() => {});
      }, pollIntervalMs);
    });

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [isAuthenticated, loadFleet]);

  return useMemo(
    () => ({
      robots,
      loading,
      error,
      selectedRobot,
      loadingDetail,
      loadFleet,
      refreshFleet,
      loadRobotDetail,
      setSelectedRobot,
      registerRobot,
      updateRobot,
      refreshStatus,
      verifyConnection,
      repairRobot,
      toggleEnableDisable,
      removeRobot,
      deleteServerData,
      clearError,
    }),
    [
      robots,
      loading,
      error,
      selectedRobot,
      loadingDetail,
      loadFleet,
      refreshFleet,
      loadRobotDetail,
      setSelectedRobot,
      registerRobot,
      updateRobot,
      refreshStatus,
      verifyConnection,
      repairRobot,
      toggleEnableDisable,
      removeRobot,
      deleteServerData,
      clearError,
    ]
  );
}
