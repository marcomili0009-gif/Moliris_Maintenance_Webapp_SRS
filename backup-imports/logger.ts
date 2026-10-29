// Requisiti soddisfatti: RNF-SEC-002, RNF-SEC-009, RNF-MNT-003, §10.4

export interface AuditEvent {
  timestamp: string;
  userId: string;
  operation: string;
  robotId?: string;
  outcome: "SUCCESS" | "FAILURE";
  details?: Record<string, unknown>;
}

const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gi,
  /(password["']?\s*[:=]\s*["']?)([^"'&\s]+)/gi,
  /(token["']?\s*[:=]\s*["']?)([^"'&\s]+)/gi,
  /(bearer\s+)([A-Za-z0-9\-._~+/]+=*)/gi,
  /(secret["']?\s*[:=]\s*["']?)([^"'&\s]+)/gi,
  /(session[_-]?id["']?\s*[:=]\s*["']?)([^"'&\s]+)/gi,
  /(authorization["']?\s*[:=]\s*["']?)([^"'&\s]+)/gi,
];

export function redactSensitiveData(input: string): string {
  let redacted = input;
  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, "$1[REDACTED]");
  }
  return redacted;
}

export class MolirisLogger {
  public info(message: string, meta?: Record<string, unknown>): void {
    const sanitizedMeta = meta ? JSON.parse(redactSensitiveData(JSON.stringify(meta))) : undefined;
    console.log(JSON.stringify({
      level: "INFO",
      timestamp: new Date().toISOString(),
      message: redactSensitiveData(message),
      meta: sanitizedMeta,
    }));
  }

  public error(message: string, diagnosticDetail?: string, meta?: Record<string, unknown>): void {
    const sanitizedMeta = meta ? JSON.parse(redactSensitiveData(JSON.stringify(meta))) : undefined;
    console.error(JSON.stringify({
      level: "ERROR",
      timestamp: new Date().toISOString(),
      message: redactSensitiveData(message),
      diagnosticDetail: diagnosticDetail ? redactSensitiveData(diagnosticDetail) : undefined,
      meta: sanitizedMeta,
    }));
  }

  // Predisposizione per gli eventi di audit (§10.4, RNF-SEC-009)
  public audit(event: AuditEvent): void {
    const sanitizedEvent = JSON.parse(redactSensitiveData(JSON.stringify(event)));
    console.log(JSON.stringify({
      type: "AUDIT_EVENT",
      ...sanitizedEvent,
    }));
  }
}
