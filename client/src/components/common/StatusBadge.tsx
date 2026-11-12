import React from "react";

export interface StatusBadgeProps {
  type: "anagraphic" | "connection" | "operational" | "classification";
  state?: string;
  operationalData?: unknown;
  isStale?: boolean;
  lastUpdate?: string | Date | null;
  className?: string;
}

function formatOperationalSummary(data: unknown): string {
  if (data === null || data === undefined) return "";
  if (typeof data === "string") return data.replace(/^"|"$/g, "");
  if (typeof data === "number" || typeof data === "boolean") return String(data);
  if (typeof data === "object") {
    const obj = data as Record<string, unknown>;
    if (typeof obj.PRETTY_NAME === "string") {
      return obj.PRETTY_NAME.replace(/^"|"$/g, "");
    }
    if (typeof obj.VERSION === "string") {
      return obj.VERSION.replace(/^"|"$/g, "");
    }
    if (typeof obj.status === "string") {
      return obj.status;
    }
    if (typeof obj.state === "string") {
      return obj.state;
    }
    const entries = Object.entries(obj).filter(([_, v]) => v !== undefined && v !== null);
    if (entries.length > 0) {
      return entries
        .slice(0, 2)
        .map(([k, v]) => `${k}: ${typeof v === "string" ? v.replace(/^"|"$/g, "") : String(v)}`)
        .join(", ");
    }
    return "Operativo";
  }
  return String(data);
}

function formatLastUpdate(dateVal?: string | Date | null): string {
  if (!dateVal) return "";
  try {
    const d = typeof dateVal === "string" ? new Date(dateVal) : dateVal;
    if (isNaN(d.getTime())) return "";
    return d.toLocaleString("it-IT", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return "";
  }
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
  lastUpdate,
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

    const summary = formatOperationalSummary(operationalData);
    const lastUpdateFormatted = formatLastUpdate(lastUpdate);
    const fullJson = typeof operationalData === "object" ? JSON.stringify(operationalData, null, 2) : String(operationalData);

    return (
      <div className={`operational-container ${className}`} style={{ maxWidth: "230px" }}>
        <div className="d-flex align-items-center flex-wrap gap-1">
          <span
            className="badge text-bg-light border text-truncate"
            style={{ maxWidth: "160px" }}
            title={fullJson}
          >
            {summary}
          </span>
          {isStale && (
            <span
              className="badge text-bg-warning badge-status badge-avviso"
              title="Dato non aggiornato oltre la soglia temporale o ultimo tentativo fallito"
            >
              [Non più verificato]
            </span>
          )}
        </div>
        {lastUpdateFormatted && (
          <div className="text-muted small mt-1" style={{ fontSize: "0.72rem", lineHeight: 1.2 }}>
            Agg: {lastUpdateFormatted}
          </div>
        )}
      </div>
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
