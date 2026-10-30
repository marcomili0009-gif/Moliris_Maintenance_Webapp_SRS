// Requisiti soddisfatti: RNF-SEC-002, RNF-SEC-004, RF-ROB-005, SRS §11.2

import crypto from "crypto";
import { type Db, type Collection } from "mongodb";
import {
  type CredentialProvider,
  type AuthenticationMaterial,
} from "./credential-provider.ts";
import { MolirisAppError, ErrorCode } from "../../errors/app-errors.ts";
import { redactSensitiveData } from "../../logging/logger.ts";

export interface EncryptedCredentialDocument {
  robotId: string;
  credentialReference: string;
  encryptedSecret: string; // hex
  iv: string; // hex
  authTag: string; // hex
  keyVersion: number;
  updatedAt: Date;
}

/**
 * Provider persistente di credenziali su MongoDB con cifratura AES-256-GCM a riposo (RNF-SEC-002, RNF-SEC-004, §11.2).
 * Protegge i segreti dei robot memorizzati nel database.
 * - IV casuale a 96 bit (12 byte) generato per ogni singola cifratura
 * - Additional Authenticated Data (AAD): indissolubilmente legato a `${robotId}|${keyVersion}`
 * - Autenticazione crittografica e integrità verificate all'atto della decifratura
 */
export class MongoCredentialProvider implements CredentialProvider {
  private collection: Collection<EncryptedCredentialDocument>;
  private masterKey: Buffer;
  private allowedMethods?: ("key" | "password")[];

  constructor(
    db: Db,
    masterKey: Buffer,
    allowedMethods?: ("key" | "password")[],
    collectionName = "robot_credentials"
  ) {
    if (!masterKey || masterKey.length !== 32) {
      throw new Error("Master key AES-256 non valida: richiesta chiave di esattamente 32 byte (256 bit).");
    }
    this.collection = db.collection<EncryptedCredentialDocument>(collectionName);
    this.masterKey = masterKey;
    this.allowedMethods = allowedMethods;
  }

  public async initIndexes(): Promise<void> {
    await this.collection.createIndex({ robotId: 1 }, { unique: true });
    await this.collection.createIndex({ credentialReference: 1 }, { unique: true });
  }

  public async store(
    robotId: string,
    material: AuthenticationMaterial,
    keyVersion = 1
  ): Promise<string> {
    if (!robotId || robotId.trim() === "") {
      throw new Error("robotId non può essere vuoto");
    }
    const cleanRobotId = robotId.trim();
    const credentialReference = `vault://robots/${cleanRobotId}`;

    const encrypted = this.encryptMaterial(cleanRobotId, material, keyVersion, this.masterKey);

    await this.collection.updateOne(
      { robotId: cleanRobotId },
      {
        $set: {
          robotId: cleanRobotId,
          credentialReference,
          encryptedSecret: encrypted.encryptedSecret,
          iv: encrypted.iv,
          authTag: encrypted.authTag,
          keyVersion,
          updatedAt: new Date(),
        },
      },
      { upsert: true }
    );

    return credentialReference;
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
    await this.collection.deleteOne({ robotId: robotId.trim() });
  }

  public async getCredentials(
    credentialReference: string,
    requestedMethod: "key" | "password"
  ): Promise<AuthenticationMaterial> {
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

    const ref = credentialReference.trim();
    const doc = await this.collection.findOne({
      $or: [
        { credentialReference: ref },
        { robotId: ref.replace(/^vault:\/\/robots\//, "") },
      ],
    });

    if (!doc) {
      throw new MolirisAppError(
        ErrorCode.SSH_AUTH_FAILED,
        `Riferimento sicuro credenziale non trovato o non accessibile: ${redactSensitiveData(ref)}`
      );
    }

    const material = this.decryptMaterial(doc, this.masterKey);

    if (material.method !== requestedMethod) {
      throw new MolirisAppError(
        ErrorCode.SSH_AUTH_FAILED,
        `Discrepanza metodo autenticazione: richiesto '${requestedMethod}', configurato '${material.method}'.`
      );
    }

    return structuredClone(material);
  }

  /**
   * Cifra il materiale di autenticazione in AES-256-GCM con IV a 96 bit e AAD 'robotId|keyVersion'.
   */
  public encryptMaterial(
    robotId: string,
    material: AuthenticationMaterial,
    keyVersion: number,
    key: Buffer
  ): { encryptedSecret: string; iv: string; authTag: string } {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);

    const aad = Buffer.from(`${robotId}|${keyVersion}`, "utf8");
    cipher.setAAD(aad);

    const plaintext = JSON.stringify(material);
    let ciphertext = cipher.update(plaintext, "utf8", "hex");
    ciphertext += cipher.final("hex");
    const authTag = cipher.getAuthTag().toString("hex");

    return {
      encryptedSecret: ciphertext,
      iv: iv.toString("hex"),
      authTag,
    };
  }

  /**
   * Decifra il documento con verifica dell'autenticità GCM e AAD.
   */
  public decryptMaterial(
    doc: EncryptedCredentialDocument,
    key: Buffer
  ): AuthenticationMaterial {
    try {
      const iv = Buffer.from(doc.iv, "hex");
      const authTag = Buffer.from(doc.authTag, "hex");
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);

      const aad = Buffer.from(`${doc.robotId}|${doc.keyVersion}`, "utf8");
      decipher.setAAD(aad);
      decipher.setAuthTag(authTag);

      let decrypted = decipher.update(doc.encryptedSecret, "hex", "utf8");
      decrypted += decipher.final("utf8");

      return JSON.parse(decrypted) as AuthenticationMaterial;
    } catch {
      throw new MolirisAppError(
        ErrorCode.SSH_AUTH_FAILED,
        "Decifratura credenziali fallita: integrità, autenticazione o AAD non validi (RNF-SEC-002, RNF-SEC-004)."
      );
    }
  }
}
