import React from "react";
import type { FormattedError } from "../../types/error.ts";

interface NotificationBannerProps {
  message?: string | null;
  error?: FormattedError | null;
  onDismiss?: () => void;
}

export const NotificationBanner: React.FC<NotificationBannerProps> = ({
  message,
  error,
  onDismiss,
}) => {
  if (!message && !error) return <div id="notification-banner" className="banner hidden" role="alert"></div>;

  const isError = Boolean(error);
  const isCritical = error?.classification === "richiede_intervento_amministrativo";

  let bannerClass = "banner-info";
  if (isError) {
    bannerClass = isCritical ? "banner-danger" : "banner-warning";
  }

  return (
    <div id="notification-banner" className={`banner ${bannerClass}`} role="alert">
      <div className="banner-content">
        {error ? (
          <div>
            <div className="banner-title font-semibold">
              {isCritical ? "Richiesto Intervento Amministrativo" : "Errore Operativo"} (Codice: {error.code})
            </div>
            <div className="banner-message">{error.userMessage}</div>
          </div>
        ) : (
          <div className="banner-message">{message}</div>
        )}
      </div>
      {onDismiss && (
        <button
          type="button"
          className="btn-dismiss-banner ml-auto"
          onClick={onDismiss}
          aria-label="Chiudi notifica"
        >
          &times;
        </button>
      )}
    </div>
  );
};
