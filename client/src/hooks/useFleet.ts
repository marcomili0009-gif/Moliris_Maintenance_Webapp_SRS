import { useState, useCallback, useEffect } from "react";
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

  const loadRobotDetail = async (robotId: string): Promise<RobotDetailDto | null> => {
    setLoadingDetail(true);
    try {
      const res = await apiClient.get(`/api/robots/${encodeURIComponent(robotId)}`);
      if (res.ok) {
        const data = await res.json();
        const detail: RobotDetailDto = data.robot;
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
  };

  const registerRobot = async (
    payload: RegisterRobotPayload
  ): Promise<{ outcome?: RegistrationOutcome; error?: FormattedError; fieldErrors?: Record<string, string> }> => {
    try {
      const res = await apiClient.post("/api/robots", payload);
      const data = await res.json();

      if (res.ok && data.outcome) {
        await loadFleet();
        return { outcome: data.outcome };
      } else {
        if (data.fieldErrors) {
          return { fieldErrors: data.fieldErrors, error: ErrorPresenter.formatError(data) };
        }
        return { error: ErrorPresenter.formatError(data) };
      }
    } catch (err) {
      return { error: ErrorPresenter.formatError(err) };
    }
  };

  const updateRobot = async (robotId: string, payload: EditRobotPayload): Promise<boolean> => {
    try {
      const res = await apiClient.put(`/api/robots/${encodeURIComponent(robotId)}/configuration`, payload);
      if (res.ok) {
        await loadFleet();
        if (selectedRobot?.id === robotId) {
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
  };

  const refreshStatus = async (robotId: string): Promise<boolean> => {
    try {
      const res = await apiClient.post(`/api/robots/${encodeURIComponent(robotId)}/status/refresh`, {});
      if (res.ok) {
        await loadFleet();
        if (selectedRobot?.id === robotId) {
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
  };

  const verifyConnection = async (robotId: string): Promise<boolean> => {
    try {
      const res = await apiClient.post(`/api/robots/${encodeURIComponent(robotId)}/verify-connection`, {});
      if (res.ok) {
        await loadFleet();
        if (selectedRobot?.id === robotId) {
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
  };

  const repairRobot = async (robotId: string): Promise<boolean> => {
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
  };

  const toggleEnableDisable = async (robotId: string, currentStatus: string): Promise<boolean> => {
    const action = currentStatus === "attivo" ? "disable" : "enable";
    try {
      const res = await apiClient.post(`/api/robots/${encodeURIComponent(robotId)}/${action}`, {});
      if (res.ok) {
        await loadFleet();
        if (selectedRobot?.id === robotId) {
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
  };

  const removeRobot = async (robotId: string): Promise<boolean> => {
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
  };

  useEffect(() => {
    if (isAuthenticated) {
      loadFleet();
    } else {
      setRobots([]);
      setSelectedRobot(null);
    }
  }, [isAuthenticated, loadFleet]);

  return {
    robots,
    loading,
    error,
    selectedRobot,
    loadingDetail,
    loadFleet,
    loadRobotDetail,
    setSelectedRobot,
    registerRobot,
    updateRobot,
    refreshStatus,
    verifyConnection,
    repairRobot,
    toggleEnableDisable,
    removeRobot,
    clearError: () => setError(null),
  };
}
