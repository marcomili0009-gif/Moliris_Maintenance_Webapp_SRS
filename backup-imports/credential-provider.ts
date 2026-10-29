// Requisiti soddisfatti: Vincoli 2.4 punti 1–2, RNF-SEC-002, RF-ROB-005, SRS §11.2

import { MolirisAppError, ErrorCode } from "../../errors/app-errors.ts";
import { redactSensitiveData } from "../../logging/logger.ts";

/**
 * Materiale di autenticazione per connessioni SSH/SFTP (RNF-SEC-002, RF-ROB-005)
 * Esiste ed è accessibile ESCLUSIVAMENTE lato server durante l'apertura della sessione.
 */
export type AuthenticationMaterial =
  | { method: "key"; privateKey: string; passphrase?: string }
  | { method: "password"; password: string };

/**
 * Interfaccia del fornitore di credenziali (Vincoli 2.4 punti 1-2, RNF-SEC-002, §11.2).
 * Dato un riferimento sicuro (es. URI Vault o id segreto), restituisce il materiale di autenticazione.
 */
export interface CredentialProvider {
  getCredentials(
    credentialReference: string,
    requestedMethod: "key" | "password"
  ): Promise<AuthenticationMaterial>;
}

/**
 * Implementazione iniziale minima del fornitore di credenziali (§11.2).
 * NOTA SRS §11.2: L'archivio concreto dei segreti (KMS, HashiCorp Vault, chiavi su file system protetto)
 * è lasciato aperto dalla specifica. Questa implementazione funge da fornitore iniziale in-memory
 * per consentire lo sviluppo e il collaudo sicuro, isolando la dipendenza dietro interfaccia.
 */
export class InMemoryCredentialProvider implements CredentialProvider {
  private secrets: Map<string, AuthenticationMaterial> = new Map();
  private allowedMethods?: ("key" | "password")[];

  constructor(allowedMethods?: ("key" | "password")[]) {
    this.allowedMethods = allowedMethods;
  }

  /**
   * Registra un segreto associato a un riferimento sicuro (strumento di bootstrap/test).
   */
  public registerSecret(reference: string, material: AuthenticationMaterial): void {
    if (!reference || reference.trim() === "") {
      throw new Error("Il riferimento sicuro alla credenziale non può essere vuoto.");
    }
    this.secrets.set(reference.trim(), structuredClone(material));
  }

  public async getCredentials(
    credentialReference: string,
    requestedMethod: "key" | "password"
  ): Promise<AuthenticationMaterial> {
    // Verifica restrizioni di configurazione (§11.2)
    if (this.allowedMethods && !this.allowedMethods.includes(requestedMethod)) {
      throw new MolirisAppError(
        ErrorCode.SSH_AUTH_FAILED,
        `Metodo di autenticazione SSH '${requestedMethod}' non abilitato dalla configurazione di sistema.`
      );
    }

    const secret = this.secrets.get(credentialReference.trim());
    if (!secret) {
      throw new MolirisAppError(
        ErrorCode.SSH_AUTH_FAILED,
        `Riferimento sicuro credenziale non trovato o non accessibile: ${redactSensitiveData(credentialReference)}`
      );
    }

    if (secret.method !== requestedMethod) {
      throw new MolirisAppError(
        ErrorCode.SSH_AUTH_FAILED,
        `Discrepanza metodo autenticazione: richiesto '${requestedMethod}', configurato '${secret.method}'.`
      );
    }

    return structuredClone(secret);
  }
}
