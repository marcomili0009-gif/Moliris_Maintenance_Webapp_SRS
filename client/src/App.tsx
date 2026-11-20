import React, { useState } from "react";
import { useAuth } from "./hooks/useAuth.ts";
import { LoginView } from "./views/LoginView.tsx";
import { DashboardView } from "./views/DashboardView.tsx";
import { LogsView } from "./views/LogsView.tsx";
import { AppNavbar } from "./components/common/AppNavbar.tsx";
import { IdleWarningModal } from "./components/common/IdleWarningModal.tsx";
import "./styles.css";

export const App: React.FC = () => {
  const {
    currentUser,
    isAuthenticated,
    loading,
    loginError,
    sessionConflict,
    idleWarning,
    idleWarningInfo,
    isIdleWarningOpen,
    idleRemainingMinutes,
    login,
    logout,
    confirmActivity,
    confirmSession,
    dismissSessionConflict,
    setActiveTransfersCount,
  } = useAuth();

  const [activeMainView, setActiveMainView] = useState<"fleet" | "files" | "logs">("fleet");
  const [goHomeTrigger, setGoHomeTrigger] = useState<number>(0);
  const isSessionWarningOpen = isIdleWarningOpen || Boolean(idleWarningInfo?.active || idleWarning);

  const handleGoHome = (): void => {
    setActiveMainView("fleet");
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
          onViewChange={setActiveMainView}
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
        activeView={activeMainView}
        onViewChange={setActiveMainView}
      />
      {!isAuthenticated || !currentUser ? (
        <LoginView
          onLogin={login}
          error={loginError}
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
          onActiveMainViewChange={(v) => setActiveMainView(v)}
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
