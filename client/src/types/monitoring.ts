export interface LastAttemptOutcome {
  success: boolean;
  timestamp: string;
  diagnosticMessage?: string;
  errorCode?: string;
}

export interface InterpretedState {
  anagraphicState: "attivo" | "disabilitato" | "rimosso";
  connectionState: "non_verificato" | "raggiungibile" | "non_raggiungibile" | "errore" | "avviso";
  operationalState: Record<string, unknown> | null;
  lastValidUpdateAt: string | null;
  lastAttemptOutcome: LastAttemptOutcome | null;
  isStale?: boolean;
  hasWarningsOrErrors?: boolean;
}
