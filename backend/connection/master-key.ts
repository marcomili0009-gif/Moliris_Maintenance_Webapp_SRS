// Requisiti soddisfatti: RNF-SEC-002, RNF-SEC-004, SRS §11.2

import fs from "fs";

/**
 * Carica e valida la chiave master AES-256 da file con verifica fail-closed dei permessi.
 * Rifiuta se:
 * - Il file non esiste o non è un file regolare
 * - Su sistemi POSIX: mode & 0o177 !== 0 (nessun permesso per group o other, nessun bit speciale)
 * - Su sistemi POSIX: stat.uid !== process.getuid() (proprietario diverso dall'utente del servizio)
 * - La lunghezza della chiave non è esattamente 32 byte (256 bit binari o 64 esadecimali)
 */
export function loadMasterKeyFromFile(filePath: string): Buffer {
  if (!filePath || filePath.trim() === "") {
    throw new Error("Percorso file master key non specificato (MOLIRIS_MASTER_KEY_FILE).");
  }

  const cleanPath = filePath.trim();
  if (!fs.existsSync(cleanPath)) {
    throw new Error(`File master key non trovato: '${cleanPath}'`);
  }

  const stat = fs.statSync(cleanPath);
  if (!stat.isFile()) {
    throw new Error(`Il percorso specificato per la master key non è un file regolare: '${cleanPath}'`);
  }

  if (process.platform !== "win32") {
    // Fail-closed rigoroso: mode & 0o177 !== 0 (nessun permesso group o other, no setuid/setgid)
    if ((stat.mode & 0o177) !== 0) {
      throw new Error(
        `Permessi non conformi sul file master key '${cleanPath}' (${(stat.mode & 0o777).toString(8)}). Richiesti permessi restrittivi 0600 (mode & 0o177 === 0: accesso negato a group e other).`
      );
    }

    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      throw new Error(
        `Proprietario del file master key non conforme: UID file (${stat.uid}) non corrisponde all'UID del processo di servizio (${process.getuid()}).`
      );
    }
  }

  const raw = fs.readFileSync(cleanPath);

  // 1. Esattamente 32 byte binari
  if (raw.length === 32) {
    return raw;
  }

  // 2. Stringa esadecimale a 64 caratteri
  const trimmed = raw.toString("utf8").trim();
  if (trimmed.length === 64 && /^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, "hex");
  }

  // 3. Stringa UTF-8 di 32 byte
  if (Buffer.from(trimmed, "utf8").length === 32) {
    return Buffer.from(trimmed, "utf8");
  }

  throw new Error(
    `Dimensione della master key non valida in '${cleanPath}'. La chiave AES-256 deve essere di esattamente 32 byte (o 64 caratteri esadecimali).`
  );
}
