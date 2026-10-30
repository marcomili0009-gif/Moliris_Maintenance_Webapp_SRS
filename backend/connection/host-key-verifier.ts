// Requisiti soddisfatti: RNF-SEC-003, RF-ROB-005, SRS §9, §11.2

import crypto from "crypto";
import { type HostKeyVerificationParams } from "../../storage/robot-models.ts";

/**
 * Esito strutturato della verifica crittografica della chiave host SSH (RNF-SEC-003, §9).
 */
export interface HostKeyVerificationResult {
  matched: boolean;
  expectedFingerprint: string;
  receivedFingerprint: string;
}

/**
 * Interfaccia per la verifica dell'identità crittografica del server SSH remoto (RNF-SEC-003).
 */
export interface HostKeyVerifier {
  verify(
    host: string,
    port: number,
    serverHostKey: Buffer,
    params: HostKeyVerificationParams
  ): HostKeyVerificationResult;
}

/**
 * Calcola l'impronta crittografica SHA256 della chiave host in formati standard (RNF-SEC-003).
 */
export function computeHostKeyFingerprint(key: Buffer): {
  sha256Hex: string;
  sha256Base64: string;
  openSshFormat: string;
} {
  const hash = crypto.createHash("sha256").update(key);
  const sha256Hex = hash.digest("hex");
  const sha256Base64 = crypto.createHash("sha256").update(key).digest("base64");
  const openSshFormat = `SHA256:${sha256Base64.replace(/=+$/, "")}`;

  return { sha256Hex, sha256Base64, openSshFormat };
}

/**
 * Valida la sintassi dell'impronta digitale SHA-256 (OpenSSH base64 o esadecimale a 64 caratteri).
 */
export function isValidSha256Fingerprint(fingerprint: string): boolean {
  if (!fingerprint || typeof fingerprint !== "string") return false;
  const trimmed = fingerprint.trim();
  // Formato OpenSSH standard: "SHA256:[base64 di 43 o 44 caratteri]"
  if (/^SHA256:[A-Za-z0-9+/]{43}={0,2}$/.test(trimmed)) {
    return true;
  }
  // Formato esadecimale a 64 caratteri (case-insensitive)
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return true;
  }
  return false;
}

/**
 * Implementazione predefinita della verifica chiave host (RNF-SEC-003, RF-ROB-005).
 * REQUISITI FONDAMENTALI:
 * 1. Solo fingerprint SHA-256 in anagrafica: il fingerprint è OBBLIGATORIO.
 * 2. Il percorso di fiducia knownHostsPath è stato rimosso per garantire univocità crittografica.
 * 3. Il confronto OpenSSH (SHA256:base64) è rigorosamente CASE-SENSITIVE per la componente base64.
 * 4. Non disabilita MAI la verifica e blocca categoricamente qualsiasi mismatch (fail-closed).
 */
export class DefaultHostKeyVerifier implements HostKeyVerifier {
  public verify(
    host: string,
    port: number,
    serverHostKey: Buffer,
    params: HostKeyVerificationParams
  ): HostKeyVerificationResult {
    const { sha256Hex, sha256Base64, openSshFormat } = computeHostKeyFingerprint(serverHostKey || Buffer.alloc(0));

    const expected = (params?.fingerprint || "").trim();

    // In anagrafica il fingerprint SHA-256 è obbligatorio
    if (!expected) {
      return {
        matched: false,
        expectedFingerprint: "",
        receivedFingerprint: openSshFormat,
      };
    }

    if (!serverHostKey || serverHostKey.length === 0) {
      return {
        matched: false,
        expectedFingerprint: expected,
        receivedFingerprint: "",
      };
    }

    let matched = false;

    // Confronto rigoroso:
    // Formato OpenSSH: "SHA256:" seguito da base64 CASE-SENSITIVE
    if (expected.startsWith("SHA256:") || expected.startsWith("sha256:")) {
      const cleanExpected = expected.replace(/^SHA256:/i, "").replace(/=+$/, "");
      const cleanReceived = sha256Base64.replace(/=+$/, "");
      // CASE-SENSITIVE: nessun toLowerCase() sul base64!
      if (cleanExpected === cleanReceived) {
        matched = true;
      }
    } else if (/^[0-9a-fA-F]{64}$/.test(expected)) {
      // Formato esadecimale: confronto case-insensitive
      if (expected.toLowerCase() === sha256Hex.toLowerCase()) {
        matched = true;
      }
    } else {
      // Base64 nudo senza prefisso: case-sensitive
      if (expected.replace(/=+$/, "") === sha256Base64.replace(/=+$/, "")) {
        matched = true;
      }
    }

    return {
      matched,
      expectedFingerprint: expected,
      receivedFingerprint: openSshFormat,
    };
  }
}
