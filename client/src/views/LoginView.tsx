import React, { useRef } from "react";
import { DoubleSubmitButton } from "../components/common/DoubleSubmitButton.tsx";

interface LoginViewProps {
  onLogin: (username: string, password: string) => Promise<boolean>;
  error: string | null;
}

export const LoginView: React.FC<LoginViewProps> = ({ onLogin, error }) => {
  const usernameRef = useRef<HTMLInputElement | null>(null);
  const passwordRef = useRef<HTMLInputElement | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const currentUsername = usernameRef.current?.value.trim() || "";
    const currentPassword = passwordRef.current?.value || "";
    // RNF-SEC-002: pulizia immediata della password dal campo form all'invio
    if (passwordRef.current) {
      passwordRef.current.value = "";
    }

    await onLogin(currentUsername, currentPassword);
  };

  return (
    <section id="login-section" className="card">
      <div className="header">
        <h1>Moliris Maintenance Webapp</h1>
        <p className="subtitle">Accesso autorizzato alla flotta robot mobili</p>
      </div>

      <form id="login-form" onSubmit={handleSubmit}>
        <div className="form-group">
          <label htmlFor="username">Username:</label>
          <input
            type="text"
            id="username"
            name="username"
            ref={usernameRef}
            required
            autoComplete="username"
            autoFocus
            defaultValue=""
          />
        </div>

        <div className="form-group">
          <label htmlFor="password">Password:</label>
          <input
            type="password"
            id="password"
            name="password"
            ref={passwordRef}
            required
            autoComplete="current-password"
            defaultValue=""
          />
        </div>

        <DoubleSubmitButton
          type="submit"
          id="btn-login"
          className="btn btn-primary"
          pendingText="Accesso in corso..."
        >
          Accedi
        </DoubleSubmitButton>
      </form>

      <div
        id="login-error"
        className={`error-message ${error ? "" : "hidden"}`}
        role="alert"
      >
        {error}
      </div>
    </section>
  );
};
