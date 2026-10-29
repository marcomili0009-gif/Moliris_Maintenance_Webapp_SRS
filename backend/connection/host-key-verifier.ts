// Requisiti soddisfatti: RNF-SEC-003, RF-ROB-005, SRS §9, §11.2

import crypto from "crypto";
import fs from "fs";
import { type HostKeyVerificationParams } from "../../storage/robot-models.ts";
import { MolirisAppError, ErrorCode } from "../../errors/app-errors.ts";

/**
 * Interfaccia per la verifica dell'identità crittografica del server SSH remoto (RNF-SEC-003).
 */
export interface HostKeyVerifier {
  verify(
    host: string,
    port: number,
    serverHostKey: Buffer,
    params: HostKeyVerificationParams
  ): boolean;
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
 * Implementazione predefinita della verifica chiave host (RNF-SEC-003, RF-ROB-005).
 * REQUISITO FONDAMENTALE: Non disabilita MAI automaticamente la verifica e NON accetta
 * chiavi sconosciute per convenienza o fallback. Niente opzioni "accetta tutto".
 */
export class DefaultHostKeyVerifier implements HostKeyVerifier {
  public verify(
    host: string,
    port: number,
    serverHostKey: Buffer,
    params: HostKeyVerificationParams
  ): boolean {
    if (!serverHostKey || serverHostKey.length === 0) {
      return false;
    }

    const { sha256Hex, sha256Base64, openSshFormat } = computeHostKeyFingerprint(serverHostKey);

    // 1. Verifica tramite Fingerprint configurato per il robot
    if (params.fingerprint && params.fingerprint.trim() !== "") {
      const expected = params.fingerprint.trim();
      const cleanExpected = expected.replace(/^SHA256:/i, "").replace(/=+$/, "");

      if (
        cleanExpected.toLowerCase() === sha256Hex.toLowerCase() ||
        cleanExpected === sha256Base64.replace(/=+$/, "") ||
        expected.toLowerCase() === openSshFormat.toLowerCase()
      ) {
        return true;
      }
      return false;
    }

    // 2. Verifica tramite file known_hosts se configurato
    if (params.knownHostsPath && fs.existsSync(params.knownHostsPath)) {
      try {
        const content = fs.readFileSync(params.knownHostsPath, "utf8");
        const lines = content.split("\n");
        const hostToken = port === 22 ? host : `[${host}]:${port}`;

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith("#")) continue;
          const parts = trimmed.split(/\s+/);
          if (parts.length >= 3) {
            const hostPart = parts[0];
            const keyPart = parts[2];
            if (hostPart.split(",").includes(hostToken)) {
              if (keyPart === serverHostKey.toString("base64")) {
                return true;
              }
            }
          }
        }
      } catch {
        return false;
      }
      return false;
    }

    // Se non è configurato né fingerprint né known_hosts valido:
    // RNF-SEC-003 vieta esplicitamente l'accettazione fiduciaria di chiavi host sconosciute
    return false;
  }
}
