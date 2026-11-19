import React from "react";

export interface ToastMessage {
  id: number;
  kind: "info" | "success" | "error";
  text: string;
}

interface ToastHostProps {
  toasts: ToastMessage[];
  onDismiss: (id: number) => void;
}

/** Contenitore di notifiche non bloccanti (non intercetta il focus né i click sul resto della UI). */
export const ToastHost: React.FC<ToastHostProps> = ({ toasts, onDismiss }) => (
  <div className="toast-host" id="toast-host" aria-live="polite" aria-atomic="false">
    {toasts.map((t) => (
      <div key={t.id} className={`toast-item toast-${t.kind}`} role={t.kind === "error" ? "alert" : "status"}>
        <span style={{ flex: 1 }}>{t.text}</span>
        <button type="button" aria-label="Chiudi notifica" onClick={() => onDismiss(t.id)}>
          ✕
        </button>
      </div>
    ))}
  </div>
);
