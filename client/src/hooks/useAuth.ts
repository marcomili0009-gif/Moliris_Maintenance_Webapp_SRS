import { useState, useEffect, useCallback, useRef } from "react";
import { apiClient } from "../services/api-client.ts";
import { ErrorPresenter } from "../services/error-presenter.ts";
import type { User } from "../types/auth.ts";

export function useAuth() {
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(true);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [idleWarning, setIdleWarning] = useState<string | null>(null);

  const lastActivityRef = useRef<number>(Date.now());
  const idleCheckIntervalRef = useRef<NodeJS.Timeout | null>(null);

  const checkCurrentUser = useCallback(async () => {
    try {
      const res = await apiClient.get("/api/auth/me");
      if (res.ok) {
        const data = await res.json();
        setCurrentUser(data.user);
        setIsAuthenticated(true);
      } else {
        setCurrentUser(null);
        setIsAuthenticated(false);
      }
    } catch {
      setCurrentUser(null);
      setIsAuthenticated(false);
    } finally {
      setLoading(false);
    }
  }, []);

  const login = async (username: string, password: string): Promise<boolean> => {
    setLoginError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });

      const data = await res.json();

      if (!res.ok) {
        const formatted = ErrorPresenter.formatError(data);
        setLoginError(formatted.userMessage);
        return false;
      }

      setCurrentUser(data.user);
      setIsAuthenticated(true);
      lastActivityRef.current = Date.now();
      return true;
    } catch (err: any) {
      const formatted = ErrorPresenter.formatError(err);
      setLoginError(formatted.userMessage);
      return false;
    }
  };

  const logout = async (): Promise<void> => {
    try {
      await apiClient.post("/api/auth/logout", {});
    } catch {}
    setCurrentUser(null);
    setIsAuthenticated(false);
    setIdleWarning(null);
  };

  const dismissIdleWarning = () => {
    setIdleWarning(null);
  };

  // Qualified activity updates
  const touchActivity = useCallback(() => {
    lastActivityRef.current = Date.now();
  }, []);

  useEffect(() => {
    apiClient.onSessionExpired(() => {
      setCurrentUser(null);
      setIsAuthenticated(false);
    });

    apiClient.onQualifiedActivity(() => {
      touchActivity();
    });

    checkCurrentUser();
  }, [checkCurrentUser, touchActivity]);

  // Watchdog timer inattività (SRS §2, §6.1, RF-AUTH-006)
  useEffect(() => {
    if (!isAuthenticated) {
      if (idleCheckIntervalRef.current) clearInterval(idleCheckIntervalRef.current);
      return;
    }

    // Controlla ogni minuto
    idleCheckIntervalRef.current = setInterval(() => {
      const now = Date.now();
      const elapsedMinutes = (now - lastActivityRef.current) / (1000 * 60);

      // A 25 minuti di inattività mostra avviso (session timeout default: 30 min)
      if (elapsedMinutes >= 25 && elapsedMinutes < 30) {
        const remainingMinutes = Math.max(1, Math.round(30 - elapsedMinutes));
        setIdleWarning(
          `La sessione scadrà per inattività tra ${remainingMinutes} minuto/i. Eseguire un'azione per mantenerla attiva.`
        );
      } else if (elapsedMinutes >= 30) {
        apiClient.notifySessionExpired();
        setIdleWarning(null);
      }
    }, 60000);

    return () => {
      if (idleCheckIntervalRef.current) clearInterval(idleCheckIntervalRef.current);
    };
  }, [isAuthenticated]);

  const isAdmin = currentUser?.roles.includes("amministratore") ?? false;
  const isOperator = currentUser?.roles.includes("operatore") ?? false;

  return {
    currentUser,
    isAuthenticated,
    loading,
    loginError,
    idleWarning,
    isAdmin,
    isOperator,
    login,
    logout,
    dismissIdleWarning,
    touchActivity,
  };
}
