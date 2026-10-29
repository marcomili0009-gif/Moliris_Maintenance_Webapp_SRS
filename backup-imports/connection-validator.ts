// Requisiti soddisfatti: RNF-SEC-006, RF-ROB-005, RF-ROB-006, SRS §11.2

import net from "net";
import { MolirisAppError, ErrorCode } from "../../errors/app-errors.ts";

export interface HostPortValidationResult {
  valid: boolean;
  normalizedHost: string;
  normalizedPort: number;
}

/**
 * Valida la sintassi di un hostname o indirizzo IPv4/IPv6 e numero di porta (RF-ROB-005, RF-ROB-006).
 */
export function validateHostAndPort(rawHost: string, rawPort?: number): HostPortValidationResult {
  if (!rawHost || typeof rawHost !== "string" || rawHost.trim() === "") {
    throw new MolirisAppError(ErrorCode.MISSING_ROBOT_PARAMS, "Hostname o indirizzo IP non valido o mancante.");
  }

  const host = rawHost.trim();

  // Rifiuto di caratteri di controllo, spazi o sequenze non valide
  if (/[\s\0\\/'"`$;&|<>]/g.test(host)) {
    throw new MolirisAppError(ErrorCode.MISSING_ROBOT_PARAMS, "Hostname o indirizzo IP contiene caratteri non consentiti.");
  }

  // Verifica che sia un IP valido o un hostname RFC 1123 valido
  const isIp = net.isIP(host) !== 0;
  const isHostname = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/.test(host);

  if (!isIp && !isHostname) {
    throw new MolirisAppError(ErrorCode.MISSING_ROBOT_PARAMS, "Formato hostname o indirizzo IP non conforme.");
  }

  // L'unico default ammesso dalla SRS è la porta SSH 22 (RF-ROB-005)
  const port = rawPort !== undefined ? Number(rawPort) : 22;

  if (isNaN(port) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new MolirisAppError(ErrorCode.MISSING_ROBOT_PARAMS, `Numero di porta SSH non valido: ${rawPort}. Valori ammessi: 1-65535.`);
  }

  return {
    valid: true,
    normalizedHost: host,
    normalizedPort: port,
  };
}

/**
 * Valida le misure di sicurezza per verifiche in fase di registrazione (RNF-SEC-006, §11.2).
 */
export class DestinationValidator {
  private allowedDestinations?: string[];
  private activeVerifications = 0;
  private maxConcurrentVerifications: number;

  constructor(allowedDestinations?: string[], maxConcurrentVerifications = 5) {
    this.allowedDestinations = allowedDestinations && allowedDestinations.length > 0 ? allowedDestinations : undefined;
    this.maxConcurrentVerifications = maxConcurrentVerifications;
  }

  /**
   * Verifica se l'host è consentito dalla whitelist di configurazione (se impostata, RNF-SEC-006).
   */
  public isDestinationAllowed(host: string): boolean {
    if (!this.allowedDestinations) {
      // Se non specificata alcuna whitelist, tutte le destinazioni sintatticamente valide sono ammesse
      return true;
    }
    const normalized = host.toLowerCase();
    return this.allowedDestinations.some(d => d.toLowerCase() === normalized);
  }

  /**
   * Acquisisce uno slot per una verifica di connessione pre-registrazione (controllo anti-abuso, RNF-SEC-006).
   */
  public acquireVerificationSlot(): void {
    if (this.activeVerifications >= this.maxConcurrentVerifications) {
      throw new MolirisAppError(
        ErrorCode.TIMEOUT_ERROR,
        "Troppe verifiche di connessione simultanee in corso. Riprovare tra qualche istante."
      );
    }
    this.activeVerifications++;
  }

  public releaseVerificationSlot(): void {
    if (this.activeVerifications > 0) {
      this.activeVerifications--;
    }
  }
}
