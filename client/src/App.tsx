import React, { useState } from "react";
import { useAuth } from "./hooks/useAuth.ts";
import { LoginView } from "./views/LoginView.tsx";
import { DashboardView } from "./views/DashboardView.tsx";
import { AppNavbar } from "./components/common/AppNavbar.tsx";
import "./styles.css";

export const App: React.FC = () => {
  const {
    currentUser,
    isAuthenticated,
    loading,
    loginError,
    idleWarning,
    login,
    logout,
    dismissIdleWarning,
  } = useAuth();

  const [activeMainView, setActiveMainView] = useState<"fleet" | "files">("fleet");
  const [goHomeTrigger, setGoHomeTrigger] = useState<number>(0);

  const handleGoHome = (): void => {
    setActiveMainView("fleet");
    setGoHomeTrigger((prev) => prev + 1);
  };

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
        <LoginView onLogin={login} error={loginError} />
      ) : (
        <DashboardView
          user={currentUser}
          onLogout={logout}
          idleWarning={idleWarning}
          onDismissIdleWarning={dismissIdleWarning}
          goHomeTrigger={goHomeTrigger}
          activeMainView={activeMainView}
          onActiveMainViewChange={setActiveMainView}
        />
      )}
    </div>
  );
};
