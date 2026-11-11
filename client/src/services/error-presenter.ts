// Requisiti soddisfatti: SRS §9, RF-SSH-007, RF-FS-006, RF-TRF-007, RNF-UX-002, RNF-SEC-002
import type { FormattedError, ErrorClassification } from "../types/error.ts";

export const ERROR_CATALOG: Record<string, { code: string; userMessage: string; classification: ErrorClassification }> = {
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
  classification: "recuperabile" as ErrorClassification,
};

export class ErrorPresenter {
  public static sanitizeString(str: unknown): string {
    if (!str) return "";
    let s = String(str);
    s = s.replace(/-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/g, "[REDACTED_KEY]");
    s = s.replace(/(password|secret|passphrase|token|key)=[^&\s]+/gi, "$1=[REDACTED]");
    s = s.replace(/at\s+[\w$./\\-]+\s+\([^)]+\)/g, "");
    s = s.replace(/\s{2,}/g, " ").trim();
    return s;
  }

  public static formatError(error: unknown): FormattedError {
    if (!error) return { ...FALLBACK_ERROR };

    const errObj = error as any;
    const code = errObj.code || (errObj.errorCode as string) || "";
    if (code && ERROR_CATALOG[code]) {
      const def = ERROR_CATALOG[code];
      return {
        code: def.code,
        userMessage: def.userMessage,
        classification: def.classification,
        details: errObj.details || errObj.meta,
      };
    }

    if (
      code === "NETWORK_DISCONNECTED" ||
      (errObj instanceof TypeError && errObj.message && errObj.message.includes("fetch")) ||
      (errObj.message && typeof errObj.message === "string" && (errObj.message.includes("VPN") || errObj.message.includes("fetch")))
    ) {
      return {
        code: "NETWORK_DISCONNECTED",
        userMessage: "Applicazione non raggiungibile. Verificare la connessione di rete e l'accesso alla VPN Moliris.",
        classification: "recuperabile",
      };
    }

    if (errObj.userMessage) {
      return {
        code: code || FALLBACK_ERROR.code,
        userMessage: this.sanitizeString(errObj.userMessage),
        classification: errObj.classification || FALLBACK_ERROR.classification,
      };
    }

    if (errObj.message && typeof errObj.message === "string") {
      const sanitized = this.sanitizeString(errObj.message);
      if (!/exception|error at|syntaxerror|typeerror|failed to fetch/i.test(sanitized)) {
        return {
          code: code || FALLBACK_ERROR.code,
          userMessage: sanitized,
          classification: (errObj.classification as ErrorClassification) || FALLBACK_ERROR.classification,
        };
      }
    }

    return { ...FALLBACK_ERROR };
  }

  public static renderAlert(error: unknown): string {
    const formatted = this.formatError(error);
    const isCritical = formatted.classification === "richiede_intervento_amministrativo";
    const badgeClass = isCritical ? "badge-amministrativo" : "badge-recuperabile";
    const alertClass = isCritical ? "alert-danger" : "alert-warning";
    const badgeText = isCritical ? "Intervento Amministrativo" : "Errore Recuperabile";

    return `
      <div class="alert-box ${alertClass}" role="alert">
        <div class="alert-header">
          <span class="badge-status ${badgeClass}">${badgeText}</span>
          <span class="error-code">Codice: ${formatted.code}</span>
        </div>
        <div class="alert-message">${formatted.userMessage}</div>
      </div>
    `;
  }
}
