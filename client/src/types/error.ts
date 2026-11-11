export type ErrorClassification = "recuperabile" | "richiede_intervento_amministrativo";

export interface FormattedError {
  code: string;
  userMessage: string;
  classification: ErrorClassification;
  details?: Record<string, unknown>;
}

export interface ApiErrorResponse {
  code?: string;
  message?: string;
  classification?: ErrorClassification;
  diagnosticDetail?: string;
  meta?: Record<string, unknown>;
}
