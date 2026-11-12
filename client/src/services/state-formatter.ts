// Requisiti soddisfatti: SRS §10.2, RF-ROB-014, RF-MON-005, RF-MON-006, RNF-REL-002, CA-ROB-012

export class StateFormatter {
  public static formatDate(isoDate?: string | null): string {
    if (!isoDate) return "-";
    const d = new Date(isoDate);
    if (isNaN(d.getTime())) return "-";
    return d.toLocaleString("it-IT");
  }

  public static formatBytes(bytes?: number | null): string {
    if (bytes === null || bytes === undefined) return "-";
    if (bytes < 1024) return `${bytes} B`;
    const kb = bytes / 1024;
    if (kb < 1024) return `${kb.toFixed(1)} KB`;
    const mb = kb / 1024;
    if (mb < 1024) return `${mb.toFixed(1)} MB`;
    const gb = mb / 1024;
    return `${gb.toFixed(2)} GB`;
  }

  public static escapeHtml(str: unknown): string {
    if (!str) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  public static renderAnagraphicBadge(state?: string): string {
    const s = state || "attivo";
    let badgeClass = "badge-disabilitato";
    if (s === "attivo") badgeClass = "badge-attivo";
    return `<span class="badge-status ${badgeClass}">${this.escapeHtml(s)}</span>`;
  }

  public static renderConnectionBadge(state?: string): string {
    const s = state || "non_verificato";
    let badgeClass = "badge-non_verificato";
    if (s === "raggiungibile") badgeClass = "badge-raggiungibile";
    else if (s === "non_raggiungibile") badgeClass = "badge-non_raggiungibile";
    else if (s === "errore") badgeClass = "badge-errore";
    else if (s === "avviso") badgeClass = "badge-avviso";

    const label = s.replace(/_/g, " ");
    return `<span class="badge-status ${badgeClass}">${this.escapeHtml(label)}</span>`;
  }

  public static renderOperationalState(operationalState?: unknown, isStale = false): string {
    if (!operationalState) {
      return `<span class="badge-status badge-nodata">dato non disponibile (RF-MON-005)</span>`;
    }

    let html = `<code>${this.escapeHtml(JSON.stringify(operationalState))}</code>`;
    if (isStale) {
      html += ` <span class="badge-status badge-avviso" title="Dato non aggiornato oltre la soglia temporale o ultimo tentativo fallito">[Non più verificato]</span>`;
    }
    return html;
  }

}
