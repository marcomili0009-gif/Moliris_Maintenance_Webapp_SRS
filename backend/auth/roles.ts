// Requisiti soddisfatti: RF-AUTH-005, RNF-SEC-004, PDF Tecnico §2 (ruoli Admin / Operatore)
//
// ISS-020: i soli ruoli canonici sono `admin` e `operatore`. L'alias storico
// `amministratore` viene normalizzato SOLO ai confini (lettura da repository,
// migrazione DB) e non è più accettato come ruolo nel codice applicativo.

export const ROLE_ADMIN = "admin";
export const ROLE_OPERATOR = "operatore";

/** Converte un ruolo (anche legacy) nella forma canonica. */
export function normalizeRole(role: string): string {
  const lower = (role || "").trim().toLowerCase();
  if (lower === "amministratore") return ROLE_ADMIN; // alias legacy migrato
  return lower;
}

export function normalizeRoles(roles?: readonly string[] | null): string[] {
  if (!Array.isArray(roles)) return [];
  return Array.from(new Set(roles.map(normalizeRole).filter(Boolean)));
}

export function hasAdminRole(roles?: readonly string[] | null): boolean {
  return normalizeRoles(roles).includes(ROLE_ADMIN);
}
