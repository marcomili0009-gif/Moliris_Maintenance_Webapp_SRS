// Requisiti soddisfatti: Vincoli 2.4 punti 1–2, RNF-SEC-002, RNF-SEC-004, RF-ROB-005, SRS §11.2

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
 * Interfaccia del fornitore di credenziali (Vincoli 2.4 punti 1-2, RNF-SEC-002, RNF-SEC-004, §11.2).
 * Fornisce operazioni per memorizzare, sostituire, rimuovere e recuperare il materiale di autenticazione
 * senza alterare la firma di getCredentials per i chiamanti esistenti.
 */
export interface CredentialProvider {
  getCredentials(
    credentialReference: string,
    requestedMethod: "key" | "password"
  ): Promise<AuthenticationMaterial>;

  store(
    robotId: string,
    material: AuthenticationMaterial,
    keyVersion?: number
  ): Promise<string>;

  replace(
    robotId: string,
    material: AuthenticationMaterial,
    keyVersion?: number
  ): Promise<string>;

  remove(robotId: string): Promise<void>;
}

/**
 * Implementazione in-memory del fornitore di credenziali (§11.2).
 * Utilizzabile in ambienti di sviluppo e test (fail-closed in produzione se NODE_ENV=production).
 */
export class InMemoryCredentialProvider implements CredentialProvider {
  private secrets: Map<string, { robotId: string; reference: string; material: AuthenticationMaterial; keyVersion: number }> = new Map();
  private allowedMethods?: ("key" | "password")[];

  constructor(allowedMethods?: ("key" | "password")[]) {
    this.allowedMethods = allowedMethods;
  }

  /**
   * Registra un segreto associato a un riferimento sicuro (metodo di compatibilità).
   */
  public registerSecret(reference: string, material: AuthenticationMaterial): void {
    if (!reference || reference.trim() === "") {
      throw new Error("Il riferimento sicuro alla credenziale non può essere vuoto.");
    }
    const cleanRef = reference.trim();
    const robotId = cleanRef.replace(/^vault:\/\/robots\//, "");
    this.secrets.set(cleanRef, {
      robotId,
      reference: cleanRef,
      material: structuredClone(material),
      keyVersion: 1,
    });
  }

  public async store(
    robotId: string,
    material: AuthenticationMaterial,
    keyVersion = 1
  ): Promise<string> {
    if (!robotId || robotId.trim() === "") {
      throw new Error("robotId non può essere vuoto");
    }
    const cleanId = robotId.trim();
    const reference = `vault://robots/${cleanId}`;
    this.secrets.set(reference, {
      robotId: cleanId,
      reference,
      material: structuredClone(material),
      keyVersion,
    });
    return reference;
  }

  public async replace(
    robotId: string,
    material: AuthenticationMaterial,
    keyVersion = 1
  ): Promise<string> {
    return this.store(robotId, material, keyVersion);
  }

  public async remove(robotId: string): Promise<void> {
    if (!robotId) return;
    const cleanId = robotId.trim();
    const reference = `vault://robots/${cleanId}`;
    this.secrets.delete(reference);
    for (const [k, v] of this.secrets.entries()) {
      if (v.robotId === cleanId) {
        this.secrets.delete(k);
      }
    }
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

    if (!credentialReference || credentialReference.trim() === "") {
      throw new MolirisAppError(
        ErrorCode.SSH_AUTH_FAILED,
        "Riferimento credenziale non specificato."
      );
    }

    const cleanRef = credentialReference.trim();
    let entry = this.secrets.get(cleanRef);
    if (!entry) {
      // Ricerca per robotId se il riferimento è nel formato robotId
      for (const val of this.secrets.values()) {
        if (val.robotId === cleanRef) {
          entry = val;
          break;
        }
      }
    }

    if (!entry) {
      throw new MolirisAppError(
        ErrorCode.SSH_AUTH_FAILED,
        `Riferimento sicuro credenziale non trovato o non accessibile: ${redactSensitiveData(cleanRef)}`
      );
    }

    if (entry.material.method !== requestedMethod) {
      throw new MolirisAppError(
        ErrorCode.SSH_AUTH_FAILED,
        `Discrepanza metodo autenticazione: richiesto '${requestedMethod}', configurato '${entry.material.method}'.`
      );
    }

    return structuredClone(entry.material);
  }
}
