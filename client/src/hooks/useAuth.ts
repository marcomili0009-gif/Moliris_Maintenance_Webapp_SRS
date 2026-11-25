import { useState, useEffect, useCallback, useRef } from "react";
import { flushSync } from "react-dom";
import { apiClient } from "../services/api-client.ts";
import { ErrorPresenter } from "../services/error-presenter.ts";
import type { User, IdleWarningInfo } from "../types/auth.ts";

type LogoutContext = "sessione" | "terminale";
type LogoutStatus = "pending" | "failed" | null;
const pendingLogoutKey = "moliris_pending_logout";
const logoutTimeoutMs = 5_000;

async function withAuthCookieLock<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  // Login e logout scrivono lo stesso cookie, condiviso tra le schede.
  return navigator.locks
    ? navigator.locks.request("moliris-auth-cookie", { signal }, operation)
    : operation();
}

export function useAuth(activeTransfersOrOptions: number | { activeTransfersCount?: number } = 0) {
  const initialTransfersCount =
    typeof activeTransfersOrOptions === "number"
      ? activeTransfersOrOptions
      : activeTransfersOrOptions?.activeTransfersCount ?? 0;

  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(true);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [logoutStatus, setLogoutStatus] = useState<LogoutStatus>(null);
  const [sessionConflict, setSessionConflict] = useState<string | null>(null);
  const [idleWarning, setIdleWarning] = useState<string | null>(null);
  const [idleWarningInfo, setIdleWarningInfo] = useState<IdleWarningInfo | null>(null);
  const [isIdleWarningOpen, setIsIdleWarningOpen] = useState<boolean>(false);
  const [idleRemainingMinutes, setIdleRemainingMinutes] = useState<number>(5);
  const [sessionTimeoutMinutes, setSessionTimeoutMinutes] = useState(30);
  const [sessionWarningMinutes, setSessionWarningMinutes] = useState(5);
  const [internalActiveTransfers, setInternalActiveTransfers] = useState<number>(initialTransfersCount);

  const activeTransfersRef = useRef<number>(initialTransfersCount);
  activeTransfersRef.current = initialTransfersCount;

  const lastActivityRef = useRef<number>(Date.now());
  const idleCheckIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const hasReportedWarningRef = useRef<boolean>(false);
  const logoutInProgressRef = useRef(false);
  const inMemoryLogoutRef = useRef<LogoutContext | null>(null);
  const effectiveActiveTransfers = Math.max(initialTransfersCount, internalActiveTransfers);
  const activeTransfersCountRef = useRef<number>(effectiveActiveTransfers);
  activeTransfersCountRef.current = effectiveActiveTransfers;

  const clearLocalSession = useCallback(() => {
    apiClient.invalidateSession();
    setCurrentUser(null);
    setIsAuthenticated(false);
    setIdleWarning(null);
    setIdleWarningInfo(null);
    setIsIdleWarningOpen(false);
    setInternalActiveTransfers(0);
    hasReportedWarningRef.current = false;
    if (idleCheckIntervalRef.current) {
      clearInterval(idleCheckIntervalRef.current);
      idleCheckIntervalRef.current = null;
    }
  }, []);

  const getPendingLogout = useCallback((): LogoutContext | null => {
    if (inMemoryLogoutRef.current) return inMemoryLogoutRef.current;
    try {
      const context = localStorage.getItem(pendingLogoutKey);
      return context === "sessione" || context === "terminale" ? context : null;
    } catch {
      return null;
    }
  }, []);

  const retryLogout = useCallback(async (): Promise<void> => {
    if (logoutInProgressRef.current || !getPendingLogout()) return;
    logoutInProgressRef.current = true;
    setLogoutStatus("pending");
    // Un unico limite per l'attesa del lock, gli header e la lettura della risposta.
    const signal = AbortSignal.timeout(logoutTimeoutMs);
    try {
      await withAuthCookieLock(async () => {
        const context = getPendingLogout();
        if (context) {
          const response = await apiClient.post("/api/auth/logout", {
            context,
            reason: "MANUAL_LOGOUT",
          }, { cache: "no-store", redirect: "error", signal });
          if (!response.ok || (await response.json()).status !== "LOGGED_OUT") {
            throw new Error("Logout non confermato dal server");
          }

          try { localStorage.removeItem(pendingLogoutKey); } catch {}
          inMemoryLogoutRef.current = null;
        }
        setLogoutStatus(null);
      }, signal);
    } catch {
      setLogoutStatus("failed");
    } finally {
      logoutInProgressRef.current = false;
    }
  }, [getPendingLogout]);

  const checkCurrentUser = useCallback(async (signal?: AbortSignal) => {
    if (getPendingLogout()) {
      clearLocalSession();
      setLoading(false);
      void retryLogout();
      return;
    }

    const generation = apiClient.sessionGeneration;
    let user: User | null = null;
    try {
      const response = await fetch("/api/auth/me", { cache: "no-store", signal });
      if (response.ok) user = (await response.json()).user;
    } catch {}
    if (signal?.aborted || generation !== apiClient.sessionGeneration) return;
    setCurrentUser(user);
    setIsAuthenticated(Boolean(user));
    setLoading(false);
  }, [clearLocalSession, getPendingLogout, retryLogout]);

  const login = async (username: string, password: string): Promise<boolean> => withAuthCookieLock(async () => {
    if (getPendingLogout() || logoutInProgressRef.current) return false;
    setLoginError(null);
    setSessionConflict(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });

      const data = await res.json();
      if (getPendingLogout()) return false;

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

      apiClient.invalidateSession();
      setCurrentUser(data.user);
      setIsAuthenticated(true);
      lastActivityRef.current = Date.now();
      hasReportedWarningRef.current = false;
      try {
        localStorage.setItem("moliris_last_activity", String(Date.now()));
      } catch {}
      return true;
    } catch (err: any) {
      const formatted = ErrorPresenter.formatError(err);
      setLoginError(formatted.userMessage);
      return false;
    }
  });

  const logout = useCallback(async (contextOrEvent?: unknown): Promise<void> => {
    if (logoutInProgressRef.current || getPendingLogout()) return;
    const context = contextOrEvent === "terminale" ? "terminale" : "sessione";
    clearLocalSession();
    setLoginError(null);
    setSessionConflict(null);
    setLoading(false);
    try {
      localStorage.setItem(pendingLogoutKey, context);
      localStorage.removeItem("moliris_last_activity");
      localStorage.removeItem("moliris_idle_action");
    } catch {
      inMemoryLogoutRef.current = context;
    }
    await retryLogout();
  }, [clearLocalSession, getPendingLogout, retryLogout]);

  const confirmActivity = useCallback(async (): Promise<void> => {
    const generation = apiClient.sessionGeneration;
    try {
      await apiClient.post("/api/auth/heartbeat", {});
    } catch {
      if (generation !== apiClient.sessionGeneration) return;
      try {
        await apiClient.post("/api/auth/session/confirm", { context: "sessione" });
      } catch {}
    }
    if (generation !== apiClient.sessionGeneration) return;
    lastActivityRef.current = Date.now();
    hasReportedWarningRef.current = false;
    setIdleWarning(null);
    setIdleWarningInfo(null);
    setIsIdleWarningOpen(false);
    try {
      localStorage.setItem("moliris_last_activity", String(Date.now()));
      localStorage.setItem(
        "moliris_idle_action",
        JSON.stringify({ type: "CONFIRM", timestamp: Date.now() })
      );
    } catch {}
  }, []);

  const confirmSession = confirmActivity;

  const dismissIdleWarning = () => {
    setIdleWarning(null);
    setIdleWarningInfo(null);
    setIsIdleWarningOpen(false);
  };

  const setActiveTransfersCount = (count: number) => {
    setInternalActiveTransfers(count);
    activeTransfersCountRef.current = count;
    if (count > 0) {
      lastActivityRef.current = Date.now();
      setIsIdleWarningOpen(false);
      setIdleWarning(null);
      setIdleWarningInfo(null);
      hasReportedWarningRef.current = false;
    }
  };

  // Qualified activity updates
  const touchActivity = useCallback(() => {
    lastActivityRef.current = Date.now();
    if (hasReportedWarningRef.current) {
      hasReportedWarningRef.current = false;
      setIdleWarning(null);
      setIdleWarningInfo(null);
    }
  }, []);

  // Monitoraggio transizione trasferimenti attivi (Prompt #4)
  // Al termine del trasferimento (successo, errore o annullamento) il timer riparte dal valore predefinito
  const prevActiveTransfersRef = useRef<number>(effectiveActiveTransfers);
  useEffect(() => {
    if (!isAuthenticated) {
      prevActiveTransfersRef.current = effectiveActiveTransfers;
      return;
    }
    if (prevActiveTransfersRef.current > 0 && effectiveActiveTransfers === 0) {
      lastActivityRef.current = Date.now();
      hasReportedWarningRef.current = false;
      setIdleWarning(null);
      setIdleWarningInfo(null);
      try {
        localStorage.setItem("moliris_last_activity", String(Date.now()));
      } catch {}
    } else if (effectiveActiveTransfers > 0) {
      lastActivityRef.current = Date.now();
      setIdleWarning(null);
      setIdleWarningInfo(null);
      hasReportedWarningRef.current = false;
    }
    prevActiveTransfersRef.current = effectiveActiveTransfers;
  }, [effectiveActiveTransfers, isAuthenticated]);

  useEffect(() => {
    const controller = new AbortController();
    const unsubscribeExpired = apiClient.onSessionExpired(clearLocalSession);
    const unsubscribeActivity = apiClient.onQualifiedActivity(touchActivity);
    void checkCurrentUser(controller.signal);

    const handlePageHide = (event: PageTransitionEvent) => {
      if (event.persisted) {
        // Il browser può ripristinare il DOM senza ricaricare la pagina.
        flushSync(() => {
          clearLocalSession();
          setLoading(true);
        });
      }
    };
    const handlePageShow = (event: PageTransitionEvent) => {
      if (event.persisted) void checkCurrentUser(controller.signal);
    };
    const handleOnline = () => { void retryLogout(); };
    window.addEventListener("pagehide", handlePageHide);
    window.addEventListener("pageshow", handlePageShow);
    window.addEventListener("online", handleOnline);
    return () => {
      controller.abort();
      unsubscribeExpired();
      unsubscribeActivity();
      window.removeEventListener("pagehide", handlePageHide);
      window.removeEventListener("pageshow", handlePageShow);
      window.removeEventListener("online", handleOnline);
    };
  }, [checkCurrentUser, clearLocalSession, retryLogout, touchActivity]);

  // Sincronizzazione multi-scheda via StorageEvent (Prompt #4)
  useEffect(() => {
    const handleStorage = (e: StorageEvent) => {
      if (e.key === pendingLogoutKey) {
        if (e.newValue) {
          clearLocalSession();
          setLoading(false);
          void retryLogout();
        } else if (!getPendingLogout()) {
          setLogoutStatus(null);
        }
      } else if (e.key === "moliris_idle_action" && e.newValue) {
        try {
          const action = JSON.parse(e.newValue);
          if (action.type === "CONFIRM") {
            lastActivityRef.current = Date.now();
            hasReportedWarningRef.current = false;
            setIdleWarning(null);
            setIdleWarningInfo(null);
          }
        } catch {}
      } else if (e.key === "moliris_last_activity" && e.newValue) {
        const val = Number(e.newValue);
        if (!isNaN(val) && val > lastActivityRef.current) {
          lastActivityRef.current = val;
          const timeoutMs = sessionTimeoutMinutes * 60 * 1000;
          const warningWindowMs = sessionWarningMinutes * 60 * 1000;
          if (Date.now() - val < timeoutMs - warningWindowMs) {
            setIdleWarning(null);
            setIdleWarningInfo(null);
            hasReportedWarningRef.current = false;
          }
        }
      }
    };

    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, [clearLocalSession, getPendingLogout, retryLogout, sessionTimeoutMinutes, sessionWarningMinutes]);

  // Gestione scheda in background / visibilità (Prompt #4)
  useEffect(() => {
    const handleVisibilityOrFocus = () => {
      if (!isAuthenticated) return;
      const now = Date.now();
      if (activeTransfersCountRef.current > 0) {
        lastActivityRef.current = now;
        return;
      }
      const timeoutMs = sessionTimeoutMinutes * 60 * 1000;
      const warningWindowMs = sessionWarningMinutes * 60 * 1000;
      const elapsedMs = now - lastActivityRef.current;

      if (elapsedMs >= timeoutMs) {
        apiClient.notifySessionExpired();
        setIdleWarning(null);
        setIdleWarningInfo(null);
      } else if (elapsedMs >= timeoutMs - warningWindowMs) {
        const remainingSeconds = Math.max(1, Math.ceil((timeoutMs - elapsedMs) / 1000));
        const remainingMinutes = Math.max(1, Math.ceil(remainingSeconds / 60));
        setIdleWarning(
          `La sessione scadrà per inattività tra ${remainingMinutes} minuto/i. Eseguire un'azione per mantenerla attiva.`
        );
        setIdleWarningInfo({
          active: true,
          context: "sessione",
          remainingSeconds,
          message: `La sessione applicativa scadrà per inattività tra ${remainingMinutes} minut${remainingMinutes === 1 ? "o" : "i"}.`,
        });
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityOrFocus);
    window.addEventListener("focus", handleVisibilityOrFocus);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityOrFocus);
      window.removeEventListener("focus", handleVisibilityOrFocus);
    };
  }, [isAuthenticated, sessionTimeoutMinutes, sessionWarningMinutes]);

  // Tracciamento interazioni utente per attività qualificata (throttled)
  useEffect(() => {
    if (!isAuthenticated) return;
    let lastThrottledTime = 0;
    const handleUserInteraction = () => {
      // Non considerare interazioni sul modale di avviso inattività come attività qualificata
      if (document.querySelector("#modal-idle-warning")) {
        return;
      }
      const now = Date.now();
      if (now - lastThrottledTime > 5000) {
        lastThrottledTime = now;
        touchActivity();
        try {
          localStorage.setItem("moliris_last_activity", String(now));
        } catch {}
      }
    };

    window.addEventListener("mousedown", handleUserInteraction);
    window.addEventListener("keydown", handleUserInteraction);
    window.addEventListener("touchstart", handleUserInteraction);
    window.addEventListener("scroll", handleUserInteraction);

    return () => {
      window.removeEventListener("mousedown", handleUserInteraction);
      window.removeEventListener("keydown", handleUserInteraction);
      window.removeEventListener("touchstart", handleUserInteraction);
      window.removeEventListener("scroll", handleUserInteraction);
    };
  }, [isAuthenticated, touchActivity]);

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
          typeof (config as any).sessionInactivityTimeoutMinutes !== "number" ||
          !Number.isInteger((config as any).sessionInactivityTimeoutMinutes) ||
          (config as any).sessionInactivityTimeoutMinutes < 1
        ) {
          throw new Error("La configurazione pubblica contiene un timeout sessione non valido.");
        }

        if (!cancelled) {
          const cfg = config as any;
          setSessionTimeoutMinutes(cfg.sessionInactivityTimeoutMinutes);
          if (typeof cfg.sessionInactivityWarningMinutes === "number" && cfg.sessionInactivityWarningMinutes > 0) {
            setSessionWarningMinutes(cfg.sessionInactivityWarningMinutes);
          }
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

  // Watchdog timer inattività (SRS §2, §6.1, RF-AUTH-006, Prompt #4)
  useEffect(() => {
    if (!isAuthenticated) {
      if (idleCheckIntervalRef.current) clearInterval(idleCheckIntervalRef.current);
      return;
    }

    const runIdleCheck = () => {
      if (getPendingLogout()) return;
      const now = Date.now();
      // Sospensione inattività se vi sono trasferimenti in corso (Prompt #4)
      if (activeTransfersCountRef.current > 0) {
        lastActivityRef.current = now;
        setIdleWarning(null);
        setIdleWarningInfo(null);
        setIsIdleWarningOpen(false);
        hasReportedWarningRef.current = false;
        return;
      }

      const timeoutMs = sessionTimeoutMinutes * 60 * 1000;
      const warningWindowMs = sessionWarningMinutes * 60 * 1000;
      const elapsedMs = now - lastActivityRef.current;

      if (elapsedMs >= timeoutMs) {
        apiClient.notifySessionExpired();
        setIdleWarning(null);
        setIdleWarningInfo(null);
        setIsIdleWarningOpen(false);
        hasReportedWarningRef.current = false;
      } else if (elapsedMs >= timeoutMs - warningWindowMs) {
        const remainingSeconds = Math.max(1, Math.ceil((timeoutMs - elapsedMs) / 1000));
        const remainingMinutes = Math.max(1, Math.ceil(remainingSeconds / 60));
        setIdleRemainingMinutes(remainingMinutes);
        setIsIdleWarningOpen(true);
        setIdleWarning(
          `La sessione scadrà per inattività tra ${remainingMinutes} minuto/i. Eseguire un'azione per mantenerla attiva.`
        );
        setIdleWarningInfo({
          active: true,
          context: "sessione",
          remainingSeconds,
          message: `La sessione applicativa scadrà per inattività tra ${remainingMinutes} minut${remainingMinutes === 1 ? "o" : "i"}.`,
        });

        if (!hasReportedWarningRef.current) {
          hasReportedWarningRef.current = true;
          void apiClient.post("/api/auth/session/warning", {
            context: "sessione",
            remainingSeconds,
          }).catch(() => undefined);
        }
      } else {
        if (idleWarningInfo || isIdleWarningOpen) {
          setIdleWarning(null);
          setIdleWarningInfo(null);
          setIsIdleWarningOpen(false);
          hasReportedWarningRef.current = false;
        }
      }
    };

    if (typeof window !== "undefined") {
      (window as any)._molirisSimulateInactivity = (inactiveMinutes: number) => {
        lastActivityRef.current = Date.now() - inactiveMinutes * 60 * 1000;
        runIdleCheck();
      };
    }

    const checkIntervalMs =
      typeof window !== "undefined" && (window as any).MOLIRIS_IDLE_CHECK_INTERVAL_MS
        ? (window as any).MOLIRIS_IDLE_CHECK_INTERVAL_MS
        : 1000;

    idleCheckIntervalRef.current = setInterval(runIdleCheck, checkIntervalMs);

    return () => {
      if (idleCheckIntervalRef.current) clearInterval(idleCheckIntervalRef.current);
    };
  }, [getPendingLogout, isAuthenticated, sessionTimeoutMinutes, sessionWarningMinutes, idleWarningInfo, isIdleWarningOpen]);

  const isAdmin = currentUser?.roles.includes("amministratore") ?? false;
  const isOperator = currentUser?.roles.includes("operatore") ?? false;

  return {
    currentUser,
    isAuthenticated,
    loading,
    loginError,
    logoutStatus,
    sessionConflict,
    idleWarning,
    idleWarningInfo,
    isIdleWarningOpen,
    idleRemainingMinutes,
    isAdmin,
    isOperator,
    login,
    logout,
    retryLogout,
    confirmActivity,
    confirmSession,
    dismissIdleWarning,
    setActiveTransfersCount,
    dismissSessionConflict: () => {
      setSessionConflict(null);
      setLoginError(null);
    },
    touchActivity,
  };
}
