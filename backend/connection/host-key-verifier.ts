// Requisiti soddisfatti: RNF-SEC-003, RF-ROB-005, SRS §9, §11.2

import crypto from "crypto";
import fs from "fs";
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
 * Verifica l'impronta o la chiave pubblica dell'host all'interno di un file known_hosts di OpenSSH (RNF-SEC-003).
 */
export function verifyAgainstKnownHosts(
  filePath: string,
  host: string,
  port: number,
  serverHostKey: Buffer
): { matched: boolean; expectedFingerprint: string } {
  const trimmedPath = filePath.trim();
  if (!fs.existsSync(trimmedPath)) {
    return { matched: false, expectedFingerprint: `File known_hosts '${trimmedPath}' non trovato` };
  }

  try {
    const content = fs.readFileSync(trimmedPath, "utf-8");
    const lines = content.split("\n");
    const portSuffix = port !== 22 ? `:${port}` : "";
    const targetPatterns = [
      host,
      `[${host}]:${port}`,
      port !== 22 ? `[${host}]${portSuffix}` : host,
    ];

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const parts = line.split(/\s+/);
      if (parts.length < 3) continue;

      const hostPart = parts[0];
      const keyBase64 = parts[2];
      const hostsInLine = hostPart.split(",");

      const hostMatches = hostsInLine.some(
        (h) => targetPatterns.includes(h) || h === host || h === `[${host}]:${port}`
      );

      if (hostMatches) {
        try {
          const entryKeyBuffer = Buffer.from(keyBase64, "base64");
          if (entryKeyBuffer.equals(serverHostKey)) {
            const fp = computeHostKeyFingerprint(entryKeyBuffer);
            return { matched: true, expectedFingerprint: fp.openSshFormat };
          }
        } catch {
          // Riga non valida, continua
        }
      }
    }

    return {
      matched: false,
      expectedFingerprint: `Nessuna chiave valida corrispondente per ${host}:${port} nel file '${trimmedPath}'`,
    };
  } catch (err: any) {
    return {
      matched: false,
      expectedFingerprint: `Errore durante la lettura del file '${trimmedPath}': ${err.message}`,
    };
  }
}

/**
 * Implementazione predefinita della verifica chiave host (RNF-SEC-003, RF-ROB-005).
 * Supporta la verifica sia tramite fingerprint SHA-256 diretto sia tramite file known_hosts locale.
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
    const knownHostsPath = (params?.knownHostsPath || "").trim();

    // 1. Se è specificato un file known_hosts e non c'è fingerprint diretto
    if (!expected && knownHostsPath) {
      const knownHostsRes = verifyAgainstKnownHosts(knownHostsPath, host, port, serverHostKey);
      return {
        matched: knownHostsRes.matched,
        expectedFingerprint: knownHostsRes.expectedFingerprint,
        receivedFingerprint: openSshFormat,
      };
    }

    // 2. Se non è specificata né impronta né known_hosts
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
