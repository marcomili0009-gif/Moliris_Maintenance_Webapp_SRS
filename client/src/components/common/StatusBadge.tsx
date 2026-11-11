import React from "react";

interface StatusBadgeProps {
  type: "anagraphic" | "connection" | "operational" | "outcome" | "classification";
  state?: string | null;
  operationalData?: Record<string, unknown> | null;
  isStale?: boolean;
  className?: string;
}

export const StatusBadge: React.FC<StatusBadgeProps> = ({
  type,
  state,
  operationalData,
  isStale = false,
  className = "",
}) => {
  if (type === "anagraphic") {
    const s = state || "attivo";
    const badgeClass = s === "attivo" ? "badge-attivo" : "badge-disabilitato";
    return <span className={`badge-status ${badgeClass} ${className}`}>{s}</span>;
  }

  if (type === "connection") {
    const s = state || "non_verificato";
    let badgeClass = "badge-non_verificato";
    if (s === "raggiungibile") badgeClass = "badge-raggiungibile";
    else if (s === "non_raggiungibile") badgeClass = "badge-non_raggiungibile";
    else if (s === "errore") badgeClass = "badge-errore";
    else if (s === "avviso") badgeClass = "badge-avviso";

    return (
      <span className={`badge-status ${badgeClass} ${className}`}>
        {s.replace(/_/g, " ")}
      </span>
    );
  }

  if (type === "operational") {
    if (!operationalData) {
      return (
        <span className={`badge-status badge-nodata ${className}`}>
          dato non disponibile (RF-MON-005)
        </span>
      );
    }

    return (
      <span className={`operational-state-container ${className}`}>
        <code>{JSON.stringify(operationalData)}</code>
        {isStale && (
          <span
            className="badge-status badge-avviso ml-1.5"
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
    const badgeClass = isCritical ? "badge-amministrativo" : "badge-recuperabile";
    const text = isCritical ? "Intervento Amministrativo" : "Errore Recuperabile";
    return <span className={`badge-status ${badgeClass} ${className}`}>{text}</span>;
  }

  return <span className={`badge-status ${className}`}>{state || "-"}</span>;
};
