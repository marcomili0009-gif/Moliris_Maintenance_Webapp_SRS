import React from "react";

export interface StatusBadgeProps {
  type: "anagraphic" | "connection" | "operational" | "classification";
  state?: string;
  operationalData?: unknown;
  isStale?: boolean;
  className?: string;
}

/**
 * Badge di stato conforme alla palette semantica Bootstrap (SRS §5.1):
 * - attivo/raggiungibile -> text-bg-success
 * - disabilitato -> text-bg-secondary
 * - rimosso/errore/non_raggiungibile -> text-bg-danger
 * - avviso/stale -> text-bg-warning
 * - non_verificato -> text-bg-info
 */
export const StatusBadge: React.FC<StatusBadgeProps> = ({
  type,
  state,
  operationalData,
  isStale = false,
  className = "",
}) => {
  if (type === "anagraphic") {
    const s = state || "attivo";
    const bgClass =
      s === "attivo"
        ? "text-bg-success"
        : s === "rimosso"
        ? "text-bg-danger"
        : "text-bg-secondary";
    return <span className={`badge ${bgClass} badge-status ${className}`}>{s}</span>;
  }

  if (type === "connection") {
    const s = state || "non_verificato";
    let bgClass = "text-bg-info"; // non_verificato -> info
    if (s === "raggiungibile") bgClass = "text-bg-success";
    else if (s === "non_raggiungibile" || s === "errore") bgClass = "text-bg-danger";
    else if (s === "avviso") bgClass = "text-bg-warning";

    return (
      <span className={`badge ${bgClass} badge-status ${className}`}>
        {s.replace(/_/g, " ")}
      </span>
    );
  }

  if (type === "operational") {
    if (!operationalData) {
      return (
        <span className={`badge text-bg-danger badge-status badge-nodata ${className}`}>
          dato non disponibile (RF-MON-005)
        </span>
      );
    }

    return (
      <span className="operational-container">
        <code>{JSON.stringify(operationalData)}</code>
        {isStale && (
          <span
            className="badge text-bg-warning badge-status badge-avviso ms-2"
            title="Dato non aggiornato oltre la soglia temporale o ultimo tentativo fallito"
          >
            [Non più verificato]
          </span>
        )}
      </span>
    );
  }

  if (type === "classification") {
    const isCritical = state === "richiede_intervento_amministrativo";
    const bgClass = isCritical ? "text-bg-danger" : "text-bg-warning";
    const text = isCritical ? "Intervento Amministrativo" : "Errore Recuperabile";
    return <span className={`badge ${bgClass} badge-status ${className}`}>{text}</span>;
  }

  return <span className={`badge text-bg-secondary badge-status ${className}`}>{state || "-"}</span>;
};
