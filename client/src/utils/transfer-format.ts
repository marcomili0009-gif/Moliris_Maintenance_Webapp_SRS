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
  PAUSED: "In pausa",
  INTEGRITY_CHECKING: "Verifica integrità",
  COMPLETED: "Completato",
  FAILED: "Fallito",
  CANCELLED: "Annullato",
  INTEGRITY_FAILED: "Errore integrità",
};

export function isActiveStatus(status: TransferStatus): boolean {
  return (
    status === "QUEUED" ||
    status === "IN_PROGRESS" ||
    status === "PAUSED" ||
    status === "INTEGRITY_CHECKING"
  );
}

export function isErrorStatus(status: TransferStatus): boolean {
  return status === "FAILED" || status === "INTEGRITY_FAILED";
}

/** Determina se la direzione rappresenta un upload (↑) o un download (↓). */
export function isUploadDirection(direction: string): boolean {
  return (
    direction === "CLIENT_TO_SERVER" ||
    direction === "CLIENT_TO_ROBOT" ||
    direction === "SERVER_TO_ROBOT" ||
    direction === "ROBOT_TO_ROBOT"
  );
}

export function getDirectionArrow(direction: string): "↑" | "↓" {
  return isUploadDirection(direction) ? "↑" : "↓";
}

/** Direzioni che il backend sa riavviare da solo (il corpo del file client non è conservato). */
export function isRetryableDirection(direction: string): boolean {
  return direction === "SERVER_TO_ROBOT" || direction === "ROBOT_TO_SERVER";
}

/** Velocità leggibile: B/s, KB/s, MB/s, GB/s (2 decimali per unità >= KB/s). */
export function formatSpeed(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return "0 B/s";
  const units = ["B/s", "KB/s", "MB/s", "GB/s"];
  let value = bytesPerSecond;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? Math.round(value) : value.toFixed(2)} ${units[unit]}`;
}

/** Formatta velocità con freccia direzionale (↑ upload, ↓ download). */
export function formatSpeedWithArrow(
  direction: string,
  bytesPerSecond: number | null | undefined
): string {
  if (bytesPerSecond === null || bytesPerSecond === undefined || !Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) {
    return "—";
  }
  return `${getDirectionArrow(direction)} ${formatSpeed(bytesPerSecond)}`;
}

/** Formatta durata in millisecondi in modo compatto e leggibile. */
export function formatDurationMs(durationMs: number | null | undefined): string {
  if (durationMs === null || durationMs === undefined || !Number.isFinite(durationMs) || durationMs < 0) {
    return "—";
  }
  if (durationMs < 1000) return `${Math.round(durationMs)} ms`;
  const totalSec = durationMs / 1000;
  if (totalSec < 60) return `${totalSec.toFixed(2)} s`;
  const mins = Math.floor(totalSec / 60);
  const secs = Math.round(totalSec % 60);
  return `${mins}m ${String(secs).padStart(2, "0")}s`;
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

/** Verifica se il trasferimento riguarda l'Archivio Generale Server anziché un robot specifico. */
export function isGeneralArchiveTransfer(
  trf: Pick<TransferProgress, "robotId" | "sourcePath" | "destinationPath">
): boolean {
  const rid = (trf.robotId || "").trim().toLowerCase();
  if (!rid || rid === "server" || rid === "general" || rid === "__general__") {
    return true;
  }
  return false;
}

function extractRobotIdFromTaggedPath(rawPath?: string): string | null {
  if (!rawPath) return null;
  const match = rawPath.match(/^robot:([^:]+):/i);
  return match?.[1]?.trim() || null;
}

/**
 * Restituisce origine e destinazione in formato compatto privo di path e senza ripetere il nome file:
 * - Verso robot: Computer → Robot (robot-vm-02) / Server → Robot (robot-vm-02)
 * - Da robot: Robot (robot-vm-02) → Computer / Robot (robot-vm-02) → Server
 * - Robot → Robot: Robot (robot-vm-01) → Robot (robot-vm-02)
 * - Verso directory server di un robot: Computer → Server (robot-vm-02)
 * - Verso archivio generale server: Computer → Archivio Generale Server
 */
export function formatTransferEndpoints(
  trf: Pick<TransferProgress, "direction" | "robotId" | "sourcePath" | "destinationPath">
): { source: string; destination: string; label: string } {
  const rid = (trf.robotId || "").trim();
  const isGeneral = isGeneralArchiveTransfer(trf);
  const robotLabel = rid && !isGeneral ? `Robot (${rid})` : "Robot";
  const serverLabel = isGeneral ? "Archivio Generale Server" : `Server (${rid})`;

  switch (trf.direction) {
    case "CLIENT_TO_ROBOT":
      return { source: "Computer", destination: robotLabel, label: `Computer → ${robotLabel}` };
    case "SERVER_TO_ROBOT":
      return { source: "Server", destination: robotLabel, label: `Server → ${robotLabel}` };
    case "ROBOT_TO_CLIENT":
      return { source: robotLabel, destination: "Computer", label: `${robotLabel} → Computer` };
    case "ROBOT_TO_SERVER":
      return { source: robotLabel, destination: "Server", label: `${robotLabel} → Server` };
    case "ROBOT_TO_ROBOT": {
      const sourceRobotId = extractRobotIdFromTaggedPath(trf.sourcePath);
      const destRobotId = extractRobotIdFromTaggedPath(trf.destinationPath) || (rid && !isGeneral ? rid : null);
      const srcLabel = sourceRobotId ? `Robot (${sourceRobotId})` : "Robot";
      const dstLabel = destRobotId ? `Robot (${destRobotId})` : "Robot";
      return { source: srcLabel, destination: dstLabel, label: `${srcLabel} → ${dstLabel}` };
    }
    case "CLIENT_TO_SERVER":
      return { source: "Computer", destination: serverLabel, label: `Computer → ${serverLabel}` };
    case "SERVER_TO_CLIENT":
      return { source: serverLabel, destination: "Computer", label: `${serverLabel} → Computer` };
    default: {
      const label = DIRECTION_LABELS[trf.direction as TransferDirection] || String(trf.direction);
      return { source: label, destination: "", label };
    }
  }
}

/** Riga "Sorgente → Destinazione" con i percorsi reali (mantenuta per diagnostica/retrocompatibilità). */
export function describeRoute(
  trf: Pick<TransferProgress, "direction" | "sourcePath" | "destinationPath" | "filename">
): { source: string; destination: string } {
  return { source: describeEndpoint("source", trf), destination: describeEndpoint("destination", trf) };
}

export function formatProgressBytes(trf: Pick<TransferProgress, "transferredBytes" | "totalBytes">): string {
  const total = trf.totalBytes > 0 ? StateFormatter.formatBytes(trf.totalBytes) : "—";
  return `${StateFormatter.formatBytes(trf.transferredBytes)} / ${total}`;
}
