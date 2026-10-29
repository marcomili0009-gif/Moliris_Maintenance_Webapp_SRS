// Requisiti soddisfatti: RF-TRF-008, CA-TRF-004, RNF-PERF-001, SRS §6.5 passo 6, §6.6 passo 6, §6.7 passo 6, §11.5

import crypto from "crypto";
import { Transform, type TransformCallback } from "stream";
import { type IChecksumAlgorithm } from "./transfer-models.ts";

/**
 * Algoritmo SHA-256 (§11.5)
 */
export class Sha256ChecksumAlgorithm implements IChecksumAlgorithm {
  public readonly name = "sha256";

  public createHasher() {
    const hash = crypto.createHash("sha256");
    return {
      update(chunk: Buffer) {
        hash.update(chunk);
      },
      digest(): string {
        return hash.digest("hex");
      },
    };
  }
}

/**
 * Algoritmo MD5 (§11.5)
 */
export class Md5ChecksumAlgorithm implements IChecksumAlgorithm {
  public readonly name = "md5";

  public createHasher() {
    const hash = crypto.createHash("md5");
    return {
      update(chunk: Buffer) {
        hash.update(chunk);
      },
      digest(): string {
        return hash.digest("hex");
      },
    };
  }
}

/**
 * Risolve l'algoritmo di checksum da configurazione senza deciderlo rigidamente (§11.5).
 * Se omesso o non supportato, adotta SHA-256.
 */
export function resolveChecksumAlgorithm(algoName?: string): IChecksumAlgorithm {
  const norm = (algoName || "").trim().toLowerCase();
  if (norm === "md5") {
    return new Md5ChecksumAlgorithm();
  }
  return new Sha256ChecksumAlgorithm();
}

/**
 * Stream di trasformazione che calcola il digest in transito senza caricare l'intero file in memoria (RNF-PERF-001, RF-TRF-008).
 * Gestisce la contropressione in modo nativo.
 */
export class ChecksumTransformStream extends Transform {
  private hasher: { update(chunk: Buffer): void; digest(): string };
  private digestResult: string | null = null;
  public readonly algorithmName: string;

  constructor(algorithm: IChecksumAlgorithm) {
    super();
    this.algorithmName = algorithm.name;
    this.hasher = algorithm.createHasher();
  }

  public _transform(chunk: any, encoding: BufferEncoding, callback: TransformCallback): void {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
    try {
      this.hasher.update(buf);
      this.push(buf);
      callback();
    } catch (err: any) {
      callback(err);
    }
  }

  public _flush(callback: TransformCallback): void {
    try {
      this.digestResult = this.hasher.digest();
      this.emit("checksum", this.digestResult);
      callback();
    } catch (err: any) {
      callback(err);
    }
  }

  public getDigest(): string | null {
    return this.digestResult;
  }
}
