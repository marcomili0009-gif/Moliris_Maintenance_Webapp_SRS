import type { TransferDirection, TransferProgress, TransferStatus } from "../types/transfer.ts";
import { StateFormatter } from "../services/state-formatter.ts";

export const DIRECTION_LABELS: Record<TransferDirection | "ROBOT_TO_ROBOT", string> = {
  CLIENT_TO_SERVER: "Computer → Server",
  SERVER_TO_CLIENT: "Server → Computer",
  SERVER_TO_ROBOT: "Server → Robot",
  ROBOT_TO_SERVER: "Robot → Server",
  CLIENT_TO_ROBOT: "Computer → Robot",
  ROBOT_TO_CLIENT: "Robot → Computer",
  ROBOT_TO_ROBOT: "Robot → Robot",
};

export const STATUS_LABELS: Record<TransferStatus, string> = {
  QUEUED: "In coda",
  IN_PROGRESS: "In corso",
  INTEGRITY_CHECKING: "Verifica integrità",
  COMPLETED: "Completato",
  FAILED: "Errore",
  CANCELLED: "Annullato",
  INTEGRITY_FAILED: "Errore",
};

export function isActiveStatus(status: TransferStatus): boolean {
  return status === "QUEUED" || status === "IN_PROGRESS" || status === "INTEGRITY_CHECKING";
}

export function isErrorStatus(status: TransferStatus): boolean {
  return status === "FAILED" || status === "INTEGRITY_FAILED";
}

/** Direzioni che il backend sa riavviare da solo (il corpo del file client non è conservato). */
export function isRetryableDirection(direction: string): boolean {
  return direction === "SERVER_TO_ROBOT" || direction === "ROBOT_TO_SERVER";
}

/** Velocità leggibile: B/s, KB/s, MB/s, GB/s. */
export function formatSpeed(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return "0 B/s";
  const units = ["B/s", "KB/s", "MB/s", "GB/s"];
  let value = bytesPerSecond;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** ETA in formato mm:ss oppure hh:mm:ss. */
export function formatEta(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return "—";
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function describeEndpoint(
  side: "source" | "destination",
  trf: Pick<TransferProgress, "direction" | "sourcePath" | "destinationPath" | "filename">
): string {
  const path = side === "source" ? trf.sourcePath : trf.destinationPath;
  const [from, to] = String(trf.direction).split("_TO_");
  const kind = side === "source" ? from : to;
  const absolute = (value: string) => (value.startsWith("/") ? value : `/${value}`);
  if (kind === "CLIENT") return `Computer (${side === "source" ? trf.filename : "download del browser"})`;
  if (kind === "SERVER") return `Server (${absolute(path || trf.filename)})`;
  return `Robot (${path || trf.filename})`;
}

/** Riga "Sorgente → Destinazione" con i percorsi reali. */
export function describeRoute(
  trf: Pick<TransferProgress, "direction" | "sourcePath" | "destinationPath" | "filename">
): { source: string; destination: string } {
  return { source: describeEndpoint("source", trf), destination: describeEndpoint("destination", trf) };
}

export function formatProgressBytes(trf: Pick<TransferProgress, "transferredBytes" | "totalBytes">): string {
  const total = trf.totalBytes > 0 ? StateFormatter.formatBytes(trf.totalBytes) : "—";
  return `${StateFormatter.formatBytes(trf.transferredBytes)} / ${total}`;
}
