// Requisiti soddisfatti: SRS §10.2, RF-ROB-014, RF-MON-005, RF-MON-006, RNF-REL-002, CA-ROB-012

/**
 * Modulo riutilizzabile per la rappresentazione rigorosa e separata dei 3 stati:
 * 1. Stato anagrafico (§10.2)
 * 2. Stato di connessione (§10.2, §8.1)
 * 3. Stato operativo interpretato con data/ora dell'ultimo aggiornamento valido (§10.2, RF-MON-005/006)
 *
 * Regole ferree:
 * - Mai un unico indicatore ambiguo.
 * - L'assenza di dati non viene MAI interpretata o mostrata come uno stato operativo (RF-MON-005).
 * - Un dato non più verificato è marcato con badge esplicito [Non più verificato] e mostrato con l'errore dell'ultimo tentativo.
 * - Un robot registrato ma irraggiungibile resta visibile con lo stato di connessione 'non_raggiungibile' (CA-ROB-012).
 */
export class StateFormatter {
  static formatDate(isoDate) {
    if (!isoDate) return "-";
    const d = new Date(isoDate);
    if (isNaN(d.getTime())) return "-";
    return d.toLocaleString("it-IT");
  }

  static formatBytes(bytes) {
    if (bytes === null || bytes === undefined) return "-";
    if (bytes < 1024) return `${bytes} B`;
    const kb = bytes / 1024;
    if (kb < 1024) return `${kb.toFixed(1)} KB`;
    const mb = kb / 1024;
    if (mb < 1024) return `${mb.toFixed(1)} MB`;
    const gb = mb / 1024;
    return `${gb.toFixed(2)} GB`;
  }

  static escapeHtml(str) {
    if (!str) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  /**
   * 1. Stato Anagrafico: attivo | disabilitato | rimosso
   */
  static renderAnagraphicBadge(state) {
    const s = state || "attivo";
    let badgeClass = "badge-disabilitato";
    if (s === "attivo") badgeClass = "badge-attivo";
    return `<span class="badge-status ${badgeClass}">${this.escapeHtml(s)}</span>`;
  }

  /**
   * 2. Stato Connessione: non_verificato | raggiungibile | non_raggiungibile | errore | avviso
   */
  static renderConnectionBadge(state) {
    const s = state || "non_verificato";
    let badgeClass = "badge-non_verificato";
    if (s === "raggiungibile") badgeClass = "badge-raggiungibile";
    else if (s === "non_raggiungibile") badgeClass = "badge-non_raggiungibile";
    else if (s === "errore") badgeClass = "badge-errore";
    else if (s === "avviso") badgeClass = "badge-avviso";

    const label = s.replace(/_/g, " ");
    return `<span class="badge-status ${badgeClass}">${this.escapeHtml(label)}</span>`;
  }

  /**
   * 3. Stato Operativo Interpretato (RF-MON-005, RF-MON-006):
   * Se non presente: "dato non disponibile (RF-MON-005)"
   * Se stale: aggiunge il badge [Non più verificato]
   */
  static renderOperationalState(operationalState, isStale = false) {
    if (!operationalState) {
      return `<span class="badge-status badge-nodata">dato non disponibile (RF-MON-005)</span>`;
    }

    let html = `<code>${this.escapeHtml(JSON.stringify(operationalState))}</code>`;
    if (isStale) {
      html += ` <span class="badge-status badge-avviso" title="Dato non aggiornato oltre la soglia temporale o ultimo tentativo fallito">[Non più verificato]</span>`;
    }
    return html;
  }

  /**
   * 4. Esito Ultimo Tentativo di Interrogazione (RF-MON-006, RNF-REL-002)
   */
  static renderLastAttemptOutcome(outcome) {
    if (!outcome) return "-";
    const ts = this.formatDate(outcome.timestamp);
    if (outcome.success) {
      return `<span class="badge-status badge-attivo">Riuscito (${ts})</span>`;
    }
    const reason = outcome.diagnosticMessage || outcome.errorCode || "Anomalia rilevata";
    return `<span class="badge-status badge-errore">Fallito (${ts}): ${this.escapeHtml(reason)}</span>`;
  }

  /**
   * Scheda unificata di tutti gli stati per il dettaglio del robot
   */
  static renderRobotStateCard(robot) {
    return `
      <div class="states-summary-card">
        <div class="state-row">
          <span class="state-label">Stato Anagrafico (§10.2):</span>
          <span class="state-value">${this.renderAnagraphicBadge(robot.anagraphicState)}</span>
        </div>
        <div class="state-row">
          <span class="state-label">Stato Connessione (§10.2):</span>
          <span class="state-value">${this.renderConnectionBadge(robot.connectionState)}</span>
        </div>
        <div class="state-row">
          <span class="state-label">Stato Operativo Interpretato (§10.2):</span>
          <span class="state-value">${this.renderOperationalState(robot.operationalState, robot.isStale)}</span>
        </div>
        <div class="state-row">
          <span class="state-label">Ultimo Aggiornamento Valido:</span>
          <span class="state-value">${this.formatDate(robot.lastValidUpdateAt)}</span>
        </div>
        <div class="state-row">
          <span class="state-label">Esito Ultimo Tentativo Monitoraggio:</span>
          <span class="state-value">${this.renderLastAttemptOutcome(robot.lastAttemptOutcome)}</span>
        </div>
      </div>
    `;
  }
}
