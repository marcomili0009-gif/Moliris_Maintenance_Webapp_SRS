// Requisiti soddisfatti: RF-FS-001, RF-FS-002, RF-FS-003, RF-FS-004, RF-FS-005, RF-FS-006, RF-FS-007,
// RNF-SEC-004, RNF-SEC-005, RNF-PERF-001, RNF-PERF-002, SRS §5.5, §10.3, CA-FS-001

import { type Readable, type Writable } from "stream";

/**
 * Tipologia dell'elemento nel filesystem remoto (RF-FS-002).
 * Rilevata dai metadati del protocollo SFTP senza inventare categorie non documentate.
 */
export type RemoteFileItemType = "directory" | "file" | "link" | "special";

/**
 * Metadati di un elemento del filesystem remoto restituiti dall'API (RF-FS-002).
 * Mostra: nome, tipologia, dimensione quando applicabile, data di modifica quando disponibile.
 * Nessun campo inventato (nessun proprietario, permessi unix o attributi estranei alla SRS).
 */
export interface RemoteFileItemDto {
  name: string;
  type: RemoteFileItemType;
  size: number | null; // Dimensione in byte per file, null se non applicabile (directory) o non disponibile
  modifiedAt: string | null; // Data ISO-8601 o null se non disponibile nel protocollo
}

/**
 * Risultato dell'elenco di una directory remota (RF-FS-001, RF-FS-002, RF-FS-003, CA-FS-001)
 */
export interface RemoteDirectoryListingDto {
  robotId: string;
  currentPath: string;
  parentPath: string | null; // null se alla radice del filesystem remoto
  items: RemoteFileItemDto[];
  totalCount: number;
  truncated: boolean; // true se il numero di elementi ha superato il limite di sicurezza configurato (RNF-PERF-002)
  isTruncated: boolean; // Flag semantico esplicito di troncamento per il frontend (Problema C2)
}

/**
 * Opzioni per l'apertura di flussi di scrittura verso il robot (RF-FS-005, Prompt 10)
 */
export interface RemoteWriteStreamOptions {
  overwrite?: boolean; // Se false e il file esiste, l'operazione viene rifiutata (politica aperta §11.5)
}

/**
 * Flusso in lettura dal filesystem remoto con rilascio garantito delle risorse (RF-FS-004, RNF-REL-005)
 */
export interface RemoteReadStreamHandle {
  stream: Readable;
  cleanup: () => Promise<void>;
}

/**
 * Flusso in scrittura verso il filesystem remoto con rilascio garantito delle risorse (RF-FS-005, RNF-REL-005)
 */
export interface RemoteWriteStreamHandle {
  stream: Writable;
  cleanup: () => Promise<void>;
}
