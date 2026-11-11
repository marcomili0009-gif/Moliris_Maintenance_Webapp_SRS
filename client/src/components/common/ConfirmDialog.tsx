import React from "react";
import { Modal } from "./Modal.tsx";
import { DoubleSubmitButton } from "./DoubleSubmitButton.tsx";

interface ConfirmDialogProps {
  id?: string;
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => Promise<void> | void;
  title: string;
  targetDescription?: string;
  warningNote?: string;
  cancelText?: string;
  confirmText?: string;
  isDestructive?: boolean;
  confirmBtnId?: string;
  cancelBtnId?: string;
}

export const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  id,
  isOpen,
  onClose,
  onConfirm,
  title,
  targetDescription,
  warningNote,
  cancelText = "Annulla",
  confirmText = "Conferma",
  isDestructive = true,
  confirmBtnId,
  cancelBtnId,
}) => {
  return (
    <Modal
      id={id}
      isOpen={isOpen}
      onClose={onClose}
      title={<h3 style={{ color: isDestructive ? "#b91c1c" : "inherit" }}>{title}</h3>}
      footer={
        <>
          <button
            type="button"
            id={cancelBtnId}
            className="btn btn-secondary"
            onClick={onClose}
          >
            {cancelText}
          </button>
          <DoubleSubmitButton
            type="button"
            id={confirmBtnId}
            className={`btn ${isDestructive ? "btn-danger" : "btn-primary"}`}
            onAsyncClick={async () => {
              await onConfirm();
              onClose();
            }}
          >
            {confirmText}
          </DoubleSubmitButton>
        </>
      }
    >
      {targetDescription && (
        <div
          style={{
            background: "#fef2f2",
            border: "1px solid #f87171",
            borderRadius: "6px",
            padding: "0.75rem",
            margin: "0.5rem 0",
            fontFamily: "monospace",
          }}
        >
          {targetDescription}
        </div>
      )}
      {warningNote && (
        <div className="alert-box alert-warning mt-3">
          {warningNote}
        </div>
      )}
    </Modal>
  );
};
