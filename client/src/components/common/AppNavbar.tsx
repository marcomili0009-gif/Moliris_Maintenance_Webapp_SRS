import React from "react";
import logo from "@/assets/Moliris_white.png";
import type { User } from "../../types/auth.ts";

export interface AppNavbarProps {
  /** Chiamato quando l'utente clicca sul logo (Home). Il componente evita il reload della pagina. */
  onGoHome?: () => void;
  user?: User | null;
  onLogout?: () => Promise<void>;
  activeView?: "fleet" | "files";
  onViewChange?: (view: "fleet" | "files") => void;
}

/**
 * Navbar superiore sticky della Moliris Ground Control Station (SRS §5.1, RNF-UX-001..004).
 *
 * Layout conforme alle specifiche:
 * - Logo Moliris a sinistra come link verso la Home (vista Flotta).
 * - I 2 soli pulsanti di navigazione principale: 'Flotta' e 'Gestione file/trasferimenti'.
 * - Info utente e pulsante Disconnetti (Logout) allineati sulla destra.
 */
export const AppNavbar: React.FC<AppNavbarProps> = ({
  onGoHome,
  user,
  onLogout,
  activeView = "fleet",
  onViewChange,
}) => {
  return (
    <nav
      className="navbar navbar-expand navbar-dark bg-dark sticky-top px-3 py-2"
      aria-label="Barra principale Moliris"
    >
      <div className="container-fluid d-flex align-items-center justify-content-between p-0">
        {/* Sinistra: Logo e Navigazione Principale */}
        <div className="d-flex align-items-center gap-3">
          <a
            className="navbar-brand me-3 p-0 d-flex align-items-center"
            href="/"
            aria-label="Torna alla Home"
            id="app-logo-link"
            onClick={(event) => {
              event.preventDefault();
              if (onViewChange) onViewChange("fleet");
              if (onGoHome) onGoHome();
            }}
          >
            <img
              src={logo}
              width="100"
              height="auto"
              alt="Logo Moliris"
              className="d-inline-block align-text-top"
            />
          </a>

          {user && (
            <ul className="navbar-nav d-flex flex-row gap-2" role="menubar">
              <li className="nav-item">
                <button
                  type="button"
                  id="nav-fleet"
                  data-view="fleet"
                  className={`nav-link btn btn-link text-decoration-none ${
                    activeView === "fleet" ? "active" : ""
                  }`}
                  aria-current={activeView === "fleet" ? "page" : undefined}
                  onClick={() => {
                    if (onViewChange) onViewChange("fleet");
                  }}
                >
                  Flotta
                </button>
              </li>
              <li className="nav-item">
                <button
                  type="button"
                  id="nav-files"
                  data-view="server"
                  className={`nav-link btn btn-link text-decoration-none ${
                    activeView === "files" ? "active" : ""
                  }`}
                  aria-current={activeView === "files" ? "page" : undefined}
                  onClick={() => {
                    if (onViewChange) onViewChange("files");
                  }}
                >
                  Gestione file/trasferimenti
                </button>
              </li>
            </ul>
          )}
        </div>

        {/* Destra: Info Utente e Logout */}
        {user && (
          <div className="d-flex align-items-center gap-3">
            <div className="user-info text-light small d-none d-sm-block">
              Utente:{" "}
              <span id="current-username" className="badge text-bg-secondary me-2">
                {user.username}
              </span>
              Ruoli:{" "}
              <span id="current-roles" className="badge text-bg-info">
                {user.roles.join(", ")}
              </span>
            </div>
            {onLogout && (
              <button
                id="btn-logout"
                type="button"
                className="btn btn-outline-danger btn-sm"
                onClick={onLogout}
              >
                Disconnetti (Logout)
              </button>
            )}
          </div>
        )}
      </div>
    </nav>
  );
};
