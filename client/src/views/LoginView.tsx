import React, { useRef, useState, useEffect } from "react";
import { AlertCircle } from "lucide-react";
import { DoubleSubmitButton } from "../components/common/DoubleSubmitButton.tsx";
import { Modal } from "../components/common/Modal.tsx";

interface LoginViewProps {
  onLogin: (username: string, password: string) => Promise<boolean>;
  error: string | null;
  sessionConflict?: string | null;
  onDismissSessionConflict?: () => void;
}

export const LoginView: React.FC<LoginViewProps> = ({
  onLogin,
  error,
  sessionConflict,
  onDismissSessionConflict,
}) => {
  const usernameRef = useRef<HTMLInputElement | null>(null);
  const passwordRef = useRef<HTMLInputElement | null>(null);
  const [isConflictOpen, setIsConflictOpen] = useState<boolean>(false);

  useEffect(() => {
    if (sessionConflict) {
      setIsConflictOpen(true);
    }
  }, [sessionConflict]);

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

  const handleCloseConflict = () => {
    setIsConflictOpen(false);
    if (usernameRef.current) {
      usernameRef.current.value = "";
    }
    if (passwordRef.current) {
      passwordRef.current.value = "";
    }
    if (onDismissSessionConflict) {
      onDismissSessionConflict();
    }
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

      <Modal
        id="modal-session-conflict"
        isOpen={isConflictOpen}
        onClose={handleCloseConflict}
        role="alertdialog"
        ariaLabelledBy="session-conflict-title"
        title={
          <div className="d-flex align-items-center gap-2 text-danger">
            <AlertCircle size={20} />
            <h3 id="session-conflict-title" className="h5 mb-0 fw-bold">
              Accesso non consentito
            </h3>
          </div>
        }
        footer={
          <button
            type="button"
            id="btn-close-session-conflict"
            className="btn btn-primary"
            onClick={handleCloseConflict}
          >
            Ho capito
          </button>
        }
      >
        <div className="alert alert-danger d-flex align-items-start gap-2 mb-0" role="alert">
          <AlertCircle className="flex-shrink-0 text-danger mt-1" size={20} />
          <div>
            <p className="mb-0 small">
              {sessionConflict ||
                "È già presente una sessione attiva per questo account su un altro dispositivo o finestra del browser. Disconnetti l'altra sessione prima di accedere."}
            </p>
          </div>
        </div>
      </Modal>
    </main>
  );
};
