// Requisiti soddisfatti: Prompt Correttivo #3 (Parte B), RF-AUTH-005, RF-SRVFS-005, RF-FS-001, RF-FS-007, RNF-SEC-004, RNF-SEC-005, §10.1, §10.4

import path from "path";
import { type AuthorizedContext } from "./session-manager.ts";
import { type UserEntity } from "./user-models.ts";
import { type AuditRepository } from "../../storage/audit-repository.ts";
import { AuditOperation } from "../../storage/audit-models.ts";
import { MolirisAppError, ErrorCode } from "../../errors/app-errors.ts";

/**
 * Valida sintatticamente e normalizza un percorso POSIX.
 * Rifiuta byte nulli, caratteri di controllo, percorsi vuoti e sequenze di attraversamento ('..').
 */
export function validateAndNormalizePath(rawPath: string): string {
  if (typeof rawPath !== "string" || rawPath.trim() === "") {
    throw new MolirisAppError(
      ErrorCode.INSUFFICIENT_PERMISSIONS,
      "Percorso non specificato o vuoto.",
      "Il percorso richiesto non può essere vuoto."
    );
  }

  const trimmed = rawPath.trim();

  // Rifiuto categorico byte nulli o caratteri di controllo ASCII non stampabili (RNF-SEC-005)
  if (trimmed.includes("\0") || /[\x00-\x1F\x7F]/.test(trimmed)) {
    throw new MolirisAppError(
      ErrorCode.INSUFFICIENT_PERMISSIONS,
      "Percorso contenente byte nulli o caratteri di controllo non ammessi.",
      "Il percorso contiene caratteri non ammessi."
    );
  }

  // Limite lunghezza massima di sicurezza
  if (trimmed.length > 4096) {
    throw new MolirisAppError(
      ErrorCode.INSUFFICIENT_PERMISSIONS,
      "Lunghezza del percorso superiore al limite consentito di 4096 caratteri.",
      "La lunghezza del percorso supera il limite massimo consentito."
    );
  }

  // Rifiuto categorico sequenze di attraversamento ('..')
  if (/(?:^|[\\/])\.\.(?:[\\/]|$)/.test(trimmed) || /%2e%2e/i.test(trimmed)) {
    throw new MolirisAppError(
      ErrorCode.INSUFFICIENT_PERMISSIONS,
      "Tentativo di attraversamento directory ('..') non consentito.",
      "Attraversamento directory non consentito."
    );
  }

  // Normalizzazione POSIX standard
  let normalized = path.posix.normalize(trimmed.replace(/\\/g, "/"));
  if (normalized.length > 1 && normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }

  return normalized;
}

/**
 * Normalizza un percorso assicurando che abbia sempre un prefisso '/' per il confronto per segmenti.
 */
export function toCanonicalPosixPath(p: string): string {
  const norm = validateAndNormalizePath(p);
  return norm.startsWith("/") ? norm : "/" + norm;
}

/**
 * Suddivide un percorso canonico in segmenti/componenti atomici non vuoti.
 * Es. "/data/logs" -> ["data", "logs"]
 * Es. "/" -> []
 */
export function getPathSegments(canonicalPath: string): string[] {
  return canonicalPath.split("/").filter(Boolean);
}

/**
 * Verifica se un percorso candidato ricade all'interno di una delle radici autorizzate.
 * Il confronto avviene STRETTAMENTE per componenti/segmenti di percorso.
 * PREVIENE collisioni parziali: "/data/a" NON autorizza "/data/ab".
 */
export function isPathAllowedByComponents(
  candidatePath: string,
  allowedRoots: string[]
): boolean {
  if (!allowedRoots || allowedRoots.length === 0) {
    return false;
  }

  const candidateCanonical = toCanonicalPosixPath(candidatePath);
  const candidateSegments = getPathSegments(candidateCanonical);

  for (const root of allowedRoots) {
    if (!root || root.trim() === "") continue;
    const rootCanonical = toCanonicalPosixPath(root);
    const rootSegments = getPathSegments(rootCanonical);

    // Se la radice autorizzata è "/" (0 segmenti), autorizza l'intero albero
    if (rootSegments.length === 0) {
      return true;
    }

    // Il candidato deve avere almeno lo stesso numero di segmenti della radice
    if (candidateSegments.length < rootSegments.length) {
      continue;
    }

    // Tutti i segmenti della radice devono coincidere esattamente con i primi segmenti del candidato
    let matches = true;
    for (let i = 0; i < rootSegments.length; i++) {
      if (candidateSegments[i] !== rootSegments[i]) {
        matches = false;
        break;
      }
    }

    if (matches) {
      return true;
    }
  }

  return false;
}

/**
 * Pulisce, valida e ottimizza una lista di radici autorizzate (ad es. da CLI seed-users o configurazione):
 * - Rifiuta byte nulli, traversal ('..') e percorsi non assoluti
 * - Normalizza in formato POSIX canonico
 * - Deduplica percorsi identici
 * - Rimuove sottocartelle ridondanti già coperte da radici superiori (es. se c'è '/' elimina tutto il resto, se c'è '/data' elimina '/data/logs')
 */
export function sanitizeAndValidateAllowedRoots(rawRoots: string[]): string[] {
  const validRoots: string[] = [];

  for (const raw of rawRoots) {
    const trimmed = raw.trim();
    if (!trimmed) continue;

    if (!trimmed.startsWith("/")) {
      throw new Error(`Percorso autorizzato non valido: '${trimmed}'. Deve essere un percorso assoluto che inizia con '/'.`);
    }

    const canonical = toCanonicalPosixPath(trimmed);
    validRoots.push(canonical);
  }

  // Deduplica
  const unique = Array.from(new Set(validRoots));

  // Se contiene '/', l'accesso è totale su tutta la radice
  if (unique.includes("/")) {
    return ["/"];
  }

  // Ordina per numero di segmenti crescente per eliminare ridondanze
  unique.sort((a, b) => getPathSegments(a).length - getPathSegments(b).length);

  const nonRedundant: string[] = [];
  for (const candidate of unique) {
    if (!isPathAllowedByComponents(candidate, nonRedundant)) {
      nonRedundant.push(candidate);
    }
  }

  return nonRedundant;
}

let globalAuditRepo: AuditRepository | null = null;

export function setPathAuthorizationAuditRepository(repo: AuditRepository): void {
  globalAuditRepo = repo;
}

/**
 * REQUISITO #3 — Config Governance & Operator Path ACL.
 * Guardia centralizzata richiesta dall'SRS Moliris v1.0.
 * Normalizza il percorso, blocca byte nulli, caratteri di controllo e traversamento '..'.
 * Se l'utente ha ruolo 'operatore', verifica che il percorso ricada strettamente in user.allowedPaths (fail-closed).
 * In caso di violazione, registra audit SECURITY_AUTHORIZATION_ERROR e solleva MolirisAppError (HTTP 403).
 */
export async function authorizeOperatorPath(
  user: UserEntity | AuthorizedContext,
  targetType: "server" | "remote",
  robotId?: string,
  requestedPath: string = "",
  auditRepo?: AuditRepository,
  options?: { isListingRootAllowed?: boolean }
): Promise<void> {
  const rawPath = typeof requestedPath === "string" ? requestedPath.trim() : "";
  const pathToValidate = rawPath === "" || rawPath === "." ? "/" : rawPath;
  const normalized = validateAndNormalizePath(pathToValidate);

  const roles = (user as any).roles || [];
  const isAdmin = roles.some((r: string) => {
    const lower = (r || "").toLowerCase();
    return lower === "amministratore" || lower === "admin";
  });

  if (isAdmin) {
    return;
  }

  const isOperator = roles.some((r: string) => {
    const lower = (r || "").toLowerCase();
    return lower === "operatore" || lower === "operator";
  });

  if (!isOperator) {
    return;
  }

  const allowedPaths = (user as any).allowedPaths;
  const hasAllowedRoots = Array.isArray(allowedPaths) && allowedPaths.length > 0;
  const isRootListing = Boolean(options?.isListingRootAllowed && (normalized === "/" || normalized === ""));

  const isAllowed =
    hasAllowedRoots &&
    (isRootListing || isPathAllowedByComponents(normalized, allowedPaths));

  if (!isAllowed) {
    const canonicalReq = toCanonicalPosixPath(normalized);
    const repo = auditRepo || globalAuditRepo;
    const username = (user as any).username || (user as any).userId || "unknown";

    if (repo) {
      try {
        await repo.record({
          userId: username,
          operation: AuditOperation.SECURITY_AUTHORIZATION_ERROR,
          robotId: robotId || (targetType === "server" ? "server" : undefined),
          outcome: "FAILURE",
          timestamp: new Date(),
          details: {
            reason: "OPERATOR_PATH_ACCESS_DENIED",
            targetType,
            robotId,
            requestedPath: canonicalReq,
            allowedPaths: allowedPaths || [],
          },
        });
      } catch {}
    }

    throw new MolirisAppError(
      ErrorCode.INSUFFICIENT_PERMISSIONS,
      `Operazione non consentita (${targetType}): il percorso '${canonicalReq}' è esterno ai percorsi autorizzati per l'operatore.`,
      "Accesso non consentito: la cartella richiesta è esterna ai percorsi autorizzati per l'operatore."
    );
  }
}

export interface PathAuthorizationOptions {
  robotId?: string;
  auditRepo?: AuditRepository;
  operation?: string;
}

/**
 * Controllo centralizzato di autorizzazione percorsi per l'utente in sessione.
 * - Ruolo Amministratore: accesso illimitato consentito dall'SRS.
 * - Ruolo Operatore: limitato rigorosamente alle sole radici autorizzate associate all'utente.
 * In caso di violazione: registra audit log SECURITY_AUTHORIZATION_ERROR e solleva MolirisAppError (HTTP 403).
 */
export async function assertPathAuthorized(
  context: AuthorizedContext,
  requestedPath: string,
  options: PathAuthorizationOptions = {}
): Promise<void> {
  const roles = context.roles || [];
  const isAdmin = roles.some((r) => {
    const lower = r.toLowerCase();
    return lower === "amministratore" || lower === "admin";
  });

  if (isAdmin) {
    // Gli amministratori mantengono il pieno accesso previsto dall'SRS
    return;
  }

  const allowedPaths = context.allowedPaths;

  // Politica fail-closed: se l'operatore non ha radici autorizzate o l'elenco è vuoto, nessun percorso è accessibile
  const isAllowed = allowedPaths && allowedPaths.length > 0 && isPathAllowedByComponents(requestedPath, allowedPaths);

  if (!isAllowed) {
    const canonicalReq = toCanonicalPosixPath(requestedPath);
    const operationName = options.operation || "ACCESSO_FILESYSTEM";

    if (options.auditRepo) {
      try {
        await options.auditRepo.record({
          userId: context.username,
          operation: AuditOperation.SECURITY_AUTHORIZATION_ERROR,
          robotId: options.robotId,
          outcome: "FAILURE",
          timestamp: new Date(),
          details: {
            reason: "PATH_OUTSIDE_ALLOWED_RESTRICTIONS",
            requestedPath: canonicalReq,
            allowedPaths: allowedPaths || [],
            operation: operationName,
          },
        });
      } catch {
        // La registrazione dell'audit non deve mascherare l'errore di sicurezza
      }
    }

    throw new MolirisAppError(
      ErrorCode.INSUFFICIENT_PERMISSIONS,
      `Operazione '${operationName}' non consentita: il percorso '${canonicalReq}' è esterno ai percorsi autorizzati per l'operatore.`,
      "Accesso non consentito: la cartella richiesta è esterna ai percorsi autorizzati per l'operatore."
    );
  }
}
