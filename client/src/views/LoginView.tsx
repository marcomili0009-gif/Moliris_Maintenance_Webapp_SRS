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
    <main className="container py-5">
      <div className="row justify-content-center">
        <div className="col-12 col-md-7 col-lg-5">
          <section id="login-section" className="card shadow-sm border p-4 bg-white">
            <div className="header mb-4 text-center">
              <h1 className="h3 mb-2 text-dark fw-bold">MOLIRIS Ground Control Station</h1>
              <p className="subtitle text-muted mb-0">Accesso autorizzato alla flotta robot mobili</p>
            </div>

            <form id="login-form" onSubmit={handleSubmit}>
              <div className="form-group mb-3">
                <label htmlFor="username" className="form-label fw-semibold">
                  Username:
                </label>
                <input
                  type="text"
                  className="form-control"
                  id="username"
                  name="username"
                  ref={usernameRef}
                  required
                  autoComplete="username"
                  autoFocus
                  defaultValue=""
                />
              </div>

              <div className="form-group mb-4">
                <label htmlFor="password" className="form-label fw-semibold">
                  Password:
                </label>
                <input
                  type="password"
                  className="form-control"
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
                className="btn btn-success w-100 py-2 fw-semibold"
                pendingText="Accesso in corso..."
              >
                Login
              </DoubleSubmitButton>
            </form>

            <div
              id="login-error"
              className={`alert alert-danger mt-3 mb-0 text-center ${error ? "" : "d-none"}`}
              role="alert"
            >
              {error}
            </div>
          </section>
        </div>
      </div>
    </main>
  );
};
