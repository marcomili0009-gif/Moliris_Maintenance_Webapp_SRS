import React, { useLayoutEffect, useRef, useState } from "react";
import { useAuth } from "./hooks/useAuth.ts";
import { LoginView } from "./views/LoginView.tsx";
import { DashboardView } from "./views/DashboardView.tsx";
import { LogsView } from "./views/LogsView.tsx";
import { AppNavbar } from "./components/common/AppNavbar.tsx";
import { IdleWarningModal } from "./components/common/IdleWarningModal.tsx";
import "./styles.css";

type MainView = "fleet" | "files" | "logs";

function readMainView(): MainView {
  switch (window.location.hash) {
    case "#files": return "files";
    case "#logs": return "logs";
    default: return "fleet";
  }
}

function writeMainView(view: MainView, replace = false): void {
  const url = new URL(window.location.href);
  url.hash = view === "fleet" ? "" : view;
  if (url.href === window.location.href) return;
  if (replace) {
    window.history.replaceState(window.history.state, "", url);
  } else {
    window.history.pushState(null, "", url);
  }
}

export const App: React.FC = () => {
  const {
    currentUser,
    isAuthenticated,
    isAdmin,
    loading,
    loginError,
    logoutStatus,
    sessionConflict,
    idleWarning,
    idleWarningInfo,
    isIdleWarningOpen,
    idleRemainingMinutes,
    login,
    logout,
    retryLogout,
    confirmActivity,
    confirmSession,
    dismissSessionConflict,
    setActiveTransfersCount,
  } = useAuth();

  const [requestedView, setRequestedView] = useState<MainView>(readMainView);
  const [goHomeTrigger, setGoHomeTrigger] = useState<number>(0);
  const wasAuthenticated = useRef(false);
  const canViewLogs = isAuthenticated && isAdmin;
  const activeMainView = requestedView === "logs" && !canViewLogs ? "fleet" : requestedView;
  const isSessionWarningOpen = isIdleWarningOpen || Boolean(idleWarningInfo?.active || idleWarning);

  useLayoutEffect(() => {
    const syncFromLocation = () => setRequestedView(readMainView());
    window.addEventListener("hashchange", syncFromLocation);
    return () => window.removeEventListener("hashchange", syncFromLocation);
  }, []);

  useLayoutEffect(() => {
    if (loading) return;

    const signedOut = wasAuthenticated.current && !isAuthenticated;
    wasAuthenticated.current = isAuthenticated;
    if (signedOut || (isAuthenticated && requestedView !== activeMainView)) {
      writeMainView("fleet", true);
      setRequestedView("fleet");
    }
  }, [activeMainView, isAuthenticated, loading, requestedView]);

  const handleMainViewChange = (view: MainView): void => {
    const target = view === "logs" && !canViewLogs ? "fleet" : view;
    writeMainView(target);
    setRequestedView(target);
  };

  const handleGoHome = (): void => {
    handleMainViewChange("fleet");
    setGoHomeTrigger((prev) => prev + 1);
  };

  const handleResetGoHomeTrigger = React.useCallback(() => {
    setGoHomeTrigger(0);
  }, []);

  if (loading) {
    return (
      <div id="app">
        <AppNavbar
          onGoHome={handleGoHome}
          user={null}
          activeView="fleet"
          onViewChange={handleMainViewChange}
        />
        <main className="container py-5 text-center">
          <div className="card shadow-sm p-4 mx-auto" style={{ maxWidth: 480 }}>
            <div className="spinner-border text-primary mx-auto mb-3" role="status">
              <span className="visually-hidden">Caricamento in corso...</span>
            </div>
            <p className="text-muted mb-0">Verifica sessione in corso...</p>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div id="app">
      <AppNavbar
        onGoHome={handleGoHome}
        user={isAuthenticated ? currentUser : null}
        onLogout={logout}
        canViewLogs={canViewLogs}
        activeView={activeMainView}
        onViewChange={handleMainViewChange}
      />
      {!isAuthenticated || !currentUser ? (
        <LoginView
          onLogin={login}
          error={loginError}
          logoutStatus={logoutStatus}
          onRetryLogout={retryLogout}
          sessionConflict={sessionConflict}
          onDismissSessionConflict={dismissSessionConflict}
        />
      ) : activeMainView === "logs" ? (
        <LogsView user={currentUser} />
      ) : (
        <DashboardView
          user={currentUser}
          onLogout={logout}
          isSessionWarningOpen={isSessionWarningOpen}
          onConfirmSession={confirmActivity || confirmSession}
          setActiveTransfersCount={setActiveTransfersCount}
          goHomeTrigger={goHomeTrigger}
          onGoHomeHandled={handleResetGoHomeTrigger}
          activeMainView={activeMainView}
          onActiveMainViewChange={handleMainViewChange}
        />
      )}
      {isAuthenticated && isSessionWarningOpen && (
        <IdleWarningModal
          isOpen={isSessionWarningOpen}
          context="sessione"
          remainingSeconds={
            idleWarningInfo?.remainingSeconds ?? (idleRemainingMinutes * 60)
          }
          message={idleWarningInfo?.message || idleWarning || undefined}
          onConfirm={confirmActivity || confirmSession}
          onLogout={logout}
        />
      )}
    </div>
  );
};
