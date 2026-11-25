import React, { useEffect, useRef } from "react";
import { Info } from "lucide-react";
import type { FormattedError } from "../../types/error.ts";
import { ErrorModal } from "./ErrorModal.tsx";
import { Modal } from "./Modal.tsx";

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
  const closeInfoBtnRef = useRef<HTMLButtonElement | null>(null);
  const handleClose = onDismiss || (() => {});

  useEffect(() => {
    if (message && !error) {
      const timer = setTimeout(() => {
        closeInfoBtnRef.current?.focus();
      }, 50);
      return () => clearTimeout(timer);
    }
  }, [message, error]);

  return (
    <>
      {/* Nessun banner inline: tutte le notifiche appaiono come pop-up modale a schermo */}
      <div id="notification-banner" className="banner hidden" role="status" style={{ display: "none" }} />

      {message && !error && (
        <Modal
          id="modal-notification-info"
          isOpen={Boolean(message)}
          onClose={handleClose}
          role="dialog"
          ariaLabelledBy="notification-modal-title"
          title={
            <h3 id="notification-modal-title" className="d-flex align-items-center gap-2 text-primary m-0 fw-bold fs-5">
              <Info size={22} className="text-primary flex-shrink-0" />
              <span>Notifica</span>
            </h3>
          }
          footer={
            <button
              type="button"
              ref={closeInfoBtnRef}
              id="btn-notification-modal-close"
              className="btn btn-primary px-4 fw-semibold"
              onClick={handleClose}
            >
              OK
            </button>
          }
        >
          <div className="p-3 rounded border bg-light">
            <div className="fs-6 text-dark fw-medium lh-base">{message}</div>
          </div>
        </Modal>
      )}

      {/* Pop-up modale ATTENZIONE per gli errori operativi */}
      {error && (
        <ErrorModal
          isOpen={Boolean(error)}
          error={error}
          onClose={handleClose}
        />
      )}
    </>
  );
};
