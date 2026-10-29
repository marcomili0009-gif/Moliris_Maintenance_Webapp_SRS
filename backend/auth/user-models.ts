// Requisiti soddisfatti: RF-AUTH-001, RNF-SEC-002, SRS §2.2, §10.4

import crypto from "crypto";

/**
 * Entità Utente del sistema (RF-AUTH-001, RNF-SEC-002)
 */
export interface UserEntity {
  id: string;
  username: string;
  passwordHash: string; // Gestita secondo pratiche sicure: hash crittografico memory-hard (RNF-SEC-002)
  roles: string[];      // Categorie logiche / ruoli dell'utente (§2.2)
  enabled: boolean;     // Stato abilitato/disabilitato dell'account
  permissions?: string[]; // Permessi globali aggiuntivi
  robotPermissions?: Record<string, string[]>; // Permessi specifici per robot: robotId -> permissions[] (CA-SSH-005)
  createdAt: Date;
  updatedAt: Date;
}

/**
 * DTO sicuro dell'utente per risposte API (RNF-SEC-002)
 * Esclude tassativamente passwordHash e campi sensibili.
 */
export interface UserProfileDto {
  id: string;
  username: string;
  roles: string[];
  permissions: string[];
  robotPermissions: Record<string, string[]>;
}

/**
 * Parametri di derivazione della chiave scrypt per hashing sicuro delle password (RNF-SEC-002).
 * Conforme a NIST SP 800-63B e OWASP Password Storage Guidelines:
 * algoritmo memory-hard, resistente contro attacchi brute-force con GPU e ASIC.
 */
const SCRYPT_KEYLEN = 64;
const SCRYPT_COST = 16384;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELIZATION = 1;

/**
 * Calcola l'hash sicuro della password utilizzando scrypt e un salt crittografico casuale (RNF-SEC-002).
 * Formato restituito: "saltHex:hashHex"
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16).toString("hex");
  return new Promise((resolve, reject) => {
    crypto.scrypt(
      password,
      salt,
      SCRYPT_KEYLEN,
      { N: SCRYPT_COST, r: SCRYPT_BLOCK_SIZE, p: SCRYPT_PARALLELIZATION },
      (err, derivedKey) => {
        if (err) return reject(err);
        resolve(`${salt}:${derivedKey.toString("hex")}`);
      }
    );
  });
}

/**
 * Verifica la password rispetto all'hash memorizzato in tempo costante (timing-safe) (RNF-SEC-002).
 */
export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const parts = storedHash.split(":");
  if (parts.length !== 2) {
    return false;
  }
  const [salt, expectedHashHex] = parts;
  const expectedBuffer = Buffer.from(expectedHashHex, "hex");

  return new Promise((resolve) => {
    crypto.scrypt(
      password,
      salt,
      expectedBuffer.length,
      { N: SCRYPT_COST, r: SCRYPT_BLOCK_SIZE, p: SCRYPT_PARALLELIZATION },
      (err, derivedKey) => {
        if (err) return resolve(false);
        try {
          const match = crypto.timingSafeEqual(expectedBuffer, derivedKey);
          resolve(match);
        } catch {
          resolve(false);
        }
      }
    );
  });
}

/**
 * Converte l'entità utente nel DTO sicuro (RNF-SEC-002)
 */
export function toUserProfileDto(user: UserEntity): UserProfileDto {
  return {
    id: user.id,
    username: user.username,
    roles: [...user.roles],
    permissions: user.permissions ? [...user.permissions] : [],
    robotPermissions: user.robotPermissions ? { ...user.robotPermissions } : {},
  };
}
