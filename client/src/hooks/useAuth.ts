import { useState, useEffect, useCallback, useRef } from "react";
import { apiClient } from "../services/api-client.ts";
import { ErrorPresenter } from "../services/error-presenter.ts";
import type { User } from "../types/auth.ts";

export function useAuth() {
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(true);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [sessionConflict, setSessionConflict] = useState<string | null>(null);
  const [idleWarning, setIdleWarning] = useState<string | null>(null);
  const [sessionTimeoutMinutes, setSessionTimeoutMinutes] = useState(30);

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
    setSessionConflict(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });

      const data = await res.json();

      if (!res.ok) {
        if (data.code === "SESSION_ALREADY_ACTIVE") {
          setSessionConflict(
            "È già presente una sessione attiva per questo account su un altro dispositivo o finestra del browser. Disconnetti l'altra sessione prima di accedere."
          );
          return false;
        }
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

  useEffect(() => {
    let cancelled = false;

    const loadPublicConfig = async () => {
      try {
        const response = await apiClient.get("/api/config/public");
        if (!response.ok) {
          throw new Error(`Il server ha rifiutato la configurazione pubblica (${response.status}).`);
        }

        const config: unknown = await response.json();
        if (
          typeof config !== "object" ||
          config === null ||
          !("sessionInactivityTimeoutMinutes" in config) ||
          typeof config.sessionInactivityTimeoutMinutes !== "number" ||
          !Number.isInteger(config.sessionInactivityTimeoutMinutes) ||
          config.sessionInactivityTimeoutMinutes < 1
        ) {
          throw new Error("La configurazione pubblica contiene un timeout sessione non valido.");
        }

        if (!cancelled) {
          setSessionTimeoutMinutes(config.sessionInactivityTimeoutMinutes);
        }
      } catch (error) {
        if (!cancelled) {
          console.error("Impossibile caricare la configurazione pubblica della sessione.", error);
        }
      }
    };

    void loadPublicConfig();
    return () => {
      cancelled = true;
    };
  }, []);

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

      const warningAtMinutes = Math.max(0, sessionTimeoutMinutes - 5);
      if (elapsedMinutes >= warningAtMinutes && elapsedMinutes < sessionTimeoutMinutes) {
        const remainingMinutes = Math.max(1, Math.ceil(sessionTimeoutMinutes - elapsedMinutes));
        setIdleWarning(
          `La sessione scadrà per inattività tra ${remainingMinutes} minuto/i. Eseguire un'azione per mantenerla attiva.`
        );
      } else if (elapsedMinutes >= sessionTimeoutMinutes) {
        apiClient.notifySessionExpired();
        setIdleWarning(null);
      }
    }, 60000);

    return () => {
      if (idleCheckIntervalRef.current) clearInterval(idleCheckIntervalRef.current);
    };
  }, [isAuthenticated, sessionTimeoutMinutes]);

  const isAdmin = currentUser?.roles.includes("amministratore") ?? false;
  const isOperator = currentUser?.roles.includes("operatore") ?? false;

  return {
    currentUser,
    isAuthenticated,
    loading,
    loginError,
    sessionConflict,
    idleWarning,
    isAdmin,
    isOperator,
    login,
    logout,
    dismissIdleWarning,
    dismissSessionConflict: () => {
      setSessionConflict(null);
      setLoginError(null);
    },
    touchActivity,
  };
}
