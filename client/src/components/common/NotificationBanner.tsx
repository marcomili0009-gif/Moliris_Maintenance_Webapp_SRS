import React from "react";
import type { FormattedError } from "../../types/error.ts";
import { ErrorModal } from "./ErrorModal.tsx";

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
  return (
    <>
      {message ? (
        <div id="notification-banner" className="banner banner-info" role="status">
          <div className="banner-content">
            <div className="banner-message">{message}</div>
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
      ) : (
        <div id="notification-banner" className="banner hidden" role="status" style={{ display: "none" }} />
      )}

      {/* Pop-up modale ATTENZIONE: sostituisce il banner inline per garantire massima visibilità */}
      {error && (
        <ErrorModal
          isOpen={Boolean(error)}
          error={error}
          onClose={onDismiss || (() => {})}
        />
      )}
    </>
  );
};
