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

  public static formatConnectionState(state?: string): string {
    const s = state || "non_verificato";
    return s.replace(/_/g, " ");
  }

  public static formatOperationalState(operationalState?: unknown, isStale = false): string {
    if (!operationalState) {
      return "dato non disponibile (RF-MON-005)";
    }

    const data = JSON.stringify(operationalState);
    return isStale ? `${data} [Non più verificato]` : data;
  }

}
