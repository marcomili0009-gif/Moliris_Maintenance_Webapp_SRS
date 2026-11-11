import React, { useEffect } from "react";

interface ModalProps {
  id?: string;
  isOpen: boolean;
  onClose: () => void;
  title: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  size?: "normal" | "large" | "terminal";
  role?: "dialog" | "alertdialog";
  ariaLabelledBy?: string;
}

export const Modal: React.FC<ModalProps> = ({
  id,
  isOpen,
  onClose,
  title,
  children,
  footer,
  size = "normal",
  role = "dialog",
  ariaLabelledBy,
}) => {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isOpen) {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  let sizeClass = "";
  if (size === "large") sizeClass = "modal-large";
  else if (size === "terminal") sizeClass = "modal-terminal-window";

  return (
    <div
      id={id}
      className="modal"
      role={role}
      aria-modal="true"
      aria-labelledby={ariaLabelledBy}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className={`modal-content ${sizeClass}`}>
        <div className="modal-header">
          {typeof title === "string" ? <h3 id={ariaLabelledBy}>{title}</h3> : title}
          <button
            type="button"
            className="btn-close"
            onClick={onClose}
            aria-label="Chiudi finestra"
          >
            &times;
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  );
};
