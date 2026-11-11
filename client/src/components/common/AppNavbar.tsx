import React from "react";
import logo from "@/assets/Moliris_white.png";

export interface AppNavbarProps {
  /** Chiamato quando l'utente clicca sul logo (Home). Il componente evita il reload della pagina. */
  onGoHome?: () => void;
}

/**
 * Navbar superiore sticky della Moliris Ground Control Station (SRS §5.1, RNF-UX-001..004).
 *
 * Layout:
 * - Barra scura a tutta larghezza (navbar navbar-expand-lg navbar-dark bg-dark sticky-top).
 * - Contiene SOLO il logo Moliris a sinistra come link verso la Home (vista Flotta).
 * - Utente, ruoli e logout risiedono nell'header di DashboardView.
 * - Le 4 viste applicative sono tab nav-pills sotto la navbar.
 */
export const AppNavbar: React.FC<AppNavbarProps> = ({ onGoHome }) => {
  return (
    <nav
      className="navbar navbar-expand-lg navbar-dark bg-dark sticky-top"
      aria-label="Barra principale Moliris"
    >
      <div className="container-fluid">
        <a
          className="navbar-brand"
          href="/"
          aria-label="Torna alla Home"
          id="app-logo-link"
          onClick={(event) => {
            // Evita il reload della pagina e attiva la navigazione client-side verso Flotta
            event.preventDefault();
            if (onGoHome) {
              onGoHome();
            }
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
      </div>
    </nav>
  );
};
