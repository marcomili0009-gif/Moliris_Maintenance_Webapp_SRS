// Requisiti soddisfatti: RNF-SEC-002, RNF-SEC-009, §10.4, §11.1

import { redactSensitiveData } from "../logging/logger.ts";

/**
 * Tipi di operazione soggetti ad audit (§10.4, RNF-SEC-009)
 * Coprono tassativamente tutti gli eventi prescritti dalla specifica:
 * - login e logout
 * - registrazione e modifica dei robot
 * - disabilitazione e rimozione dei robot
 * - apertura e chiusura delle sessioni terminale
 * - avvio, completamento e fallimento dei trasferimenti
 * - errori significativi di autorizzazione o sicurezza
 */
export const AuditOperation = {
  AUTH_LOGIN: "AUTH_LOGIN",
  AUTH_LOGOUT: "AUTH_LOGOUT",
  ROBOT_REGISTRATION: "ROBOT_REGISTRATION",
  ROBOT_UPDATE: "ROBOT_UPDATE",
  ROBOT_DISABLE: "ROBOT_DISABLE",
  ROBOT_REMOVAL: "ROBOT_REMOVAL",
  ROBOT_CONNECTION_VERIFY: "ROBOT_CONNECTION_VERIFY",
  TERMINAL_OPEN: "TERMINAL_OPEN",
  TERMINAL_CLOSE: "TERMINAL_CLOSE",
  TRANSFER_START: "TRANSFER_START",
  TRANSFER_COMPLETE: "TRANSFER_COMPLETE",
  TRANSFER_FAILURE: "TRANSFER_FAILURE",
  SECURITY_AUTHORIZATION_ERROR: "SECURITY_AUTHORIZATION_ERROR",
  SECURITY_BREACH_ATTEMPT: "SECURITY_BREACH_ATTEMPT",
} as const;

export type AuditOperation = typeof AuditOperation[keyof typeof AuditOperation];

/**
 * Schema del documento di Audit (§10.4, RNF-SEC-009)
 */
export interface AuditEventDocument {
  id?: string;
  userId: string;
  operation: AuditOperation;
  robotId?: string;
  outcome: "SUCCESS" | "FAILURE";
  timestamp: Date;
  details?: Record<string, unknown>;
}

/**
 * Sanitizza l'evento prima della persistenza, garantendo che nessun segreto
 * (password, chiavi private, token di sessione) finisca nel database (RNF-SEC-002, §10.4).
 */
export function sanitizeAuditEvent(event: AuditEventDocument): AuditEventDocument {
  let sanitizedDetails: Record<string, unknown> | undefined = undefined;
  if (event.details) {
    const rawJson = JSON.stringify(event.details);
    const redactedJson = redactSensitiveData(rawJson);
    sanitizedDetails = JSON.parse(redactedJson);
  }

  return {
    ...event,
    details: sanitizedDetails,
  };
}
