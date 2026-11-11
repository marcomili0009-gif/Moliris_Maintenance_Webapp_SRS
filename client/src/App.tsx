import React from "react";
import { useAuth } from "./hooks/useAuth.ts";
import { LoginView } from "./views/LoginView.tsx";
import { DashboardView } from "./views/DashboardView.tsx";
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

  if (loading) {
    return (
      <div id="app" className="flex items-center justify-center p-8">
        <div className="card text-center p-6">
          <p className="text-gray-600">Verifica sessione in corso...</p>
        </div>
      </div>
    );
  }

  return (
    <div id="app">
      {!isAuthenticated || !currentUser ? (
        <LoginView onLogin={login} error={loginError} />
      ) : (
        <DashboardView
          user={currentUser}
          onLogout={logout}
          idleWarning={idleWarning}
          onDismissIdleWarning={dismissIdleWarning}
        />
      )}
    </div>
  );
};
