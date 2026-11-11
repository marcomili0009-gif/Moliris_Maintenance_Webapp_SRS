// Requisiti soddisfatti: SRS §9, RF-SSH-007, RF-FS-006, RF-TRF-007, RNF-UX-002, RNF-SEC-002

/**
 * Catalogo centralizzato degli errori conformi alla sezione 9 della SRS.
 * Assicura che nessun dettaglio tecnico interno, segreto o stack trace venga mai mostrato all'utente.
 */
export const ERROR_CATALOG = {
  AUTH_INVALID_CREDENTIALS: {
    code: "AUTH_INVALID_CREDENTIALS",
    userMessage: "Credenziali di accesso non valide.",
    classification: "recuperabile",
  },
  AUTH_INSUFFICIENT_PERMISSIONS: {
    code: "AUTH_INSUFFICIENT_PERMISSIONS",
    userMessage: "Operazione non consentita: autorizzazioni insufficienti.",
    classification: "recuperabile",
  },
  ROBOT_PARAMS_INVALID: {
    code: "ROBOT_PARAMS_INVALID",
    userMessage: "Parametri del robot mancanti o non conformi.",
    classification: "recuperabile",
  },
  NET_HOST_UNREACHABLE: {
    code: "NET_HOST_UNREACHABLE",
    userMessage: "Dispositivo remoto non raggiungibile. Verificare lo stato di rete e la connessione.",
    classification: "recuperabile",
  },
  NET_PORT_UNAVAILABLE: {
    code: "NET_PORT_UNAVAILABLE",
    userMessage: "Servizio di connessione remota non disponibile sulla porta specificata.",
    classification: "recuperabile",
  },
  SSH_AUTH_FAILED: {
    code: "SSH_AUTH_FAILED",
    userMessage: "Autenticazione remota verso il dispositivo fallita.",
    classification: "recuperabile",
  },
  SSH_HOST_KEY_INVALID: {
    code: "SSH_HOST_KEY_INVALID",
    userMessage: "Verifica di sicurezza dell'host fallita: chiave non riconosciuta o non valida.",
    classification: "richiede_intervento_amministrativo",
  },
  MON_STATE_FILE_ERROR: {
    code: "MON_STATE_FILE_ERROR",
    userMessage: "Informazioni di stato del dispositivo non disponibili o non interpretabili.",
    classification: "recuperabile",
  },
  TERM_SESSION_ERROR: {
    code: "TERM_SESSION_ERROR",
    userMessage: "Errore durante la gestione della sessione di terminale.",
    classification: "recuperabile",
  },
  REMOTE_FS_IO_ERROR: {
    code: "REMOTE_FS_IO_ERROR",
    userMessage: "Impossibile completare l'operazione sul filesystem del robot.",
    classification: "recuperabile",
  },
  SERVER_DIR_INACCESSIBLE: {
    code: "SERVER_DIR_INACCESSIBLE",
    userMessage: "Archivio server non accessibile. Contattare l'amministratore.",
    classification: "richiede_intervento_amministrativo",
  },
  STORAGE_INSUFFICIENT_SPACE: {
    code: "STORAGE_INSUFFICIENT_SPACE",
    userMessage: "Spazio di archiviazione insufficiente per completare l'operazione.",
    classification: "recuperabile",
  },
  TRF_TRANSFER_INTERRUPTED: {
    code: "TRF_TRANSFER_INTERRUPTED",
    userMessage: "Trasferimento file interrotto prima del completamento.",
    classification: "recuperabile",
  },
  OPERATION_TIMEOUT: {
    code: "OPERATION_TIMEOUT",
    userMessage: "L'operazione richiesta ha superato il tempo massimo di attesa consentito.",
    classification: "recuperabile",
  },
  TRF_INTEGRITY_FAILED: {
    code: "TRF_INTEGRITY_FAILED",
    userMessage: "Verifica di integrità del file trasferito fallita.",
    classification: "recuperabile",
  },
  DB_PERSISTENCE_ERROR: {
    code: "DB_PERSISTENCE_ERROR",
    userMessage: "Errore durante il salvataggio dei dati applicativi. Riprovare o contattare l'amministratore.",
    classification: "richiede_intervento_amministrativo",
  },
  DB_FS_SYNC_ERROR: {
    code: "DB_FS_SYNC_ERROR",
    userMessage: "Incoerenza rilevata tra anagrafica e archivio dati. Richiesto intervento di ripristino.",
    classification: "richiede_intervento_amministrativo",
  },
};

const FALLBACK_ERROR = {
  code: "UNKNOWN_ERROR",
  userMessage: "Si è verificato un errore durante l'elaborazione della richiesta.",
  classification: "recuperabile",
};

const NETWORK_ERROR = {
  code: "NETWORK_DISCONNECTED",
  userMessage: "Applicazione non raggiungibile. Verificare la connessione di rete e l'accesso alla VPN Moliris.",
  classification: "recuperabile",
};

/**
 * Traduttore centralizzato e sicuro degli errori.
 */
export class ErrorPresenter {
  /**
   * Converte qualsiasi errore, risposta JSON o eccezione in una definizione sicura conforme a §9.
   */
  static formatError(errOrPayload) {
    if (!errOrPayload) {
      return { ...FALLBACK_ERROR, isRecoverable: true };
    }

    // Se è un errore di rete del browser (es. assenza connessione o VPN non attiva)
    if (errOrPayload instanceof TypeError && errOrPayload.message && errOrPayload.message.includes("fetch")) {
      return { ...NETWORK_ERROR, isRecoverable: true };
    }

    // Se è già un errore standard con codice
    const code = errOrPayload.code || (errOrPayload.error && typeof errOrPayload.error === "string" ? errOrPayload.error : null);
    if (code && ERROR_CATALOG[code]) {
      const entry = ERROR_CATALOG[code];
      const classification = errOrPayload.classification || entry.classification;
      return {
        code: entry.code,
        userMessage: errOrPayload.message || entry.userMessage,
        classification,
        isRecoverable: classification === "recuperabile",
      };
    }

    // Messaggio sicuro di fallback se il backend ha fornito solo un messaggio
    if (errOrPayload.message && typeof errOrPayload.message === "string") {
      const isSensitive = /password|secret|key|stack|trace|sql|mongo|internal|at Object|at async/i.test(errOrPayload.message);
      if (!isSensitive) {
        const classification = errOrPayload.classification === "richiede_intervento_amministrativo"
          ? "richiede_intervento_amministrativo"
          : "recuperabile";
        return {
          code: code || "APPLICATION_ERROR",
          userMessage: errOrPayload.message,
          classification,
          isRecoverable: classification === "recuperabile",
        };
      }
    }

    return { ...FALLBACK_ERROR, isRecoverable: true };
  }

  /**
   * Genera il frammento HTML sicuro per visualizzare l'errore, distinguendo visivamente la classificazione.
   */
  static renderAlert(errOrPayload) {
    const formatted = this.formatError(errOrPayload);
    const badgeClass = formatted.isRecoverable ? "badge-recuperabile" : "badge-amministrativo";
    const badgeLabel = formatted.isRecoverable
      ? "Errore recuperabile (puoi riprovare)"
      : "Richiede intervento dell'amministratore";
    const alertBoxClass = formatted.isRecoverable ? "alert-warning" : "alert-danger";

    return `
      <div class="alert-box ${alertBoxClass}" role="alert">
        <div class="alert-header">
          <span class="badge-classification ${badgeClass}">${badgeLabel}</span>
          <span class="error-code-badge">${this.escapeHtml(formatted.code)}</span>
        </div>
        <div class="alert-message" style="margin-top: 0.5rem;">
          ${this.escapeHtml(formatted.userMessage)}
        </div>
      </div>
    `;
  }

  /**
   * Associa gli errori di validazione puntuali ai rispettivi campi del form (RF-ROB-006).
   */
  static renderValidationErrors(formElement, validationErrors) {
    this.clearValidationErrors(formElement);
    if (!validationErrors || typeof validationErrors !== "object") return;

    for (const [field, message] of Object.entries(validationErrors)) {
      const errorDiv = formElement.querySelector(`#err-${field}`);
      if (errorDiv) {
        errorDiv.textContent = typeof message === "string" ? message : "Valore non valido.";
        errorDiv.classList.remove("hidden");
      }
      const inputEl = formElement.querySelector(`[name="${field}"]`) || formElement.querySelector(`#reg-${field}`);
      if (inputEl) {
        inputEl.classList.add("input-invalid");
      }
    }
  }

  /**
   * Rimuove i messaggi di errore e i bordi rossi dai campi del form.
   */
  static clearValidationErrors(formElement) {
    if (!formElement) return;
    const errorEls = formElement.querySelectorAll(".field-error");
    errorEls.forEach((el) => {
      el.textContent = "";
      el.classList.add("hidden");
    });
    const inputs = formElement.querySelectorAll(".input-invalid");
    inputs.forEach((el) => el.classList.remove("input-invalid"));
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
}
