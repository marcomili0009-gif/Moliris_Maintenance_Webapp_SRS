import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { Modal } from "../components/common/Modal.tsx";
import { apiClient } from "../services/api-client.ts";
import { StateFormatter } from "../services/state-formatter.ts";
import type { User } from "../types/auth.ts";
import type { TransferLogRecord } from "../types/transfer.ts";
import {
  DIRECTION_LABELS,
  formatSpeed,
  formatTransferEndpoints,
  isGeneralArchiveTransfer,
} from "../utils/transfer-format.ts";

export interface LogsViewProps {
  user: User;
}

interface ParsedAccessLog {
  raw: string;
  timestamp?: string;
  event?: string;
  username?: string;
  role?: string;
  outcome?: string;
  details?: string;
}

interface ParsedTransferLog {
  raw: string;
  isBulkHeader?: boolean;
  isBulkFooter?: boolean;
  bulkSummary?: { label: string; badgeClass: string };
  isBulkItem?: boolean;
  batchId?: string;
  source?: string;
  destination?: string;
  transferId?: string;
  timestamp?: string;
  filename?: string;
  username?: string;
  direction?: string;
  outcome?: string;
  details?: string;
}

const ACCESS_LINE_REGEX =
  /^\[(.*?)\]\s+EVENT:\s*(.*?)\s*\|\s*Utente:\s*(.*?)(?:\s*\|\s*Ruolo:\s*(.*?))?\s*\|\s*Esito:\s*(.*?)(?:\s*\|\s*Dettagli:\s*(.*))?$/i;

const TRANSFER_STANDARD_REGEX =
  /^\[(.*?)\] File: (.*?) \| Utente: (.*?) \| Direzione: (.*?) \| Esito: ([\p{L}_]+)(?: \| Sorgente: (.*?))?(?: \| Destinazione: (.*?))?(?: \| Batch: (.*?))?(?: \| ID: (.*?))?(?: \| Dettagli: (.*))?$/iu;

const LEGACY_TRANSFER_REGEX =
  /^\[(.*?)\]\s+File:\s*(.*?)\s*\|\s*Utente:\s*(.*?)\s*\|\s*Direzione:\s*(.*?)\s*\|\s*Esito:\s*(.*?)(?:\s*\|\s*Dettagli:\s*(.*))?$/i;

function normalizeTransferOutcome(raw?: string): string | undefined {
  const outcome = raw?.trim().toUpperCase();
  if (outcome === "OK" || outcome === "COMPLETED") return "SUCCESSO";
  if (outcome === "FALLITO" || outcome === "FAILED") return "FALLIMENTO";
  if (outcome === "CANCELLED") return "ANNULLATO";
  return outcome;
}

const BULK_HEADER_REGEX =
  /^=== INIZIO CARICAMENTO MASSIVO === \[batchId:\s*(.*?)\] \((\d+) file\)\s+Utente:\s*(.*?)\s*\|\s*Data:\s*(.*?)\s*\|\s*Ora:\s*(.*?) ===$/i;

const BULK_FOOTER_REGEX =
  /^=== CARICAMENTO MASSIVO TERMINATO === \[batchId:\s*(.*?)\]\s+-\s*Esito:\s*(.*?) \(Completati:\s*(.*?)\/(.*?), Annullati:\s*(.*?), Falliti:\s*(.*?)\)\s*\|\s*Data:\s*(.*?)\s*\|\s*Ora:\s*(.*?) ===$/i;

const BULK_ITEM_REGEX =
  /^\[batchId:\s*(.*?)\]\s+\[FILE\s*(\d+)\/(\d+)\]\s+File\s+\d+:\s*(.*?)\s*\|\s*Esito:\s*(.*?)(?:\s+\((.*?)\))?\s*\|\s*Direzione:\s*(.*?)\s*\|\s*Dettagli:\s*(.*)$/i;

function getBulkSummary(completed: number, total: number, cancelled: number, failed: number) {
  if (total <= 0 || completed + cancelled + failed !== total ||
      [completed, total, cancelled, failed].some((count) => !Number.isSafeInteger(count) || count < 0)) {
    return { label: "Concluso", badgeClass: "text-bg-secondary" };
  }
  if (completed === total) return { label: "Completato", badgeClass: "text-bg-success" };
  if (failed === total) return { label: "Fallito", badgeClass: "text-bg-danger" };
  if (cancelled === total) return { label: "Annullato", badgeClass: "transfer-log-badge-orange" };
  return {
    label: failed > 0 ? "Concluso con errori" : "Concluso con annullamenti",
    badgeClass: "transfer-log-badge-orange",
  };
}

const transferOutcomeBadgeClasses: Partial<Record<string, string>> = {
  SUCCESSO: "text-bg-success",
  FALLIMENTO: "text-bg-danger",
  ANNULLATO: "transfer-log-badge-orange",
};

const romeLogFormatter = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Europe/Rome",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function formatLogTime(timestamp: string): string {
  // Il formato storico dei file non contiene la sigla UTC.
  const value = timestamp.trim();
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? value.replace(" ", "T") + "Z"
    : value;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(iso)) return value;
  const instant = new Date(iso);
  return Number.isNaN(instant.getTime()) ? value : romeLogFormatter.format(instant);
}

function compactErrorMessage(rawMessage: string): string {
  const cleaned = rawMessage
    .replace(/^(?:Fallito|Annullato)\s*\([^)]*\)\s*:\s*/i, "")
    .trim();
  const mkdirMatch = cleaned.match(
    /^Impossibile creare la directory remota '([^']+)' sul robot '([^']+)':\s*(.+)$/i
  );
  if (mkdirMatch) {
    return `Impossibile creare '${mkdirMatch[1]}' su ${mkdirMatch[2]} (permessi o percorso non valido)`;
  }
  return cleaned || rawMessage;
}

interface FormattedLogDetails {
  summary: string;
  technical?: string;
}

function formatCompactLogEndpoint(rawEndpoint?: string): string | null {
  const value = (rawEndpoint || "").trim();
  if (!value) return null;
  const location = value.split("·")[0]?.trim() || value;

  if (/^Computer$/i.test(location)) return "Computer";
  if (/^Archivio generale$/i.test(location)) return "Archivio Generale Server";
  if (/^Ricezione temporanea sul server$/i.test(location)) return "Server";

  const sftpRobot = location.match(/^SFTP robot\s+(.+)$/i);
  if (sftpRobot?.[1]) return `Robot (${sftpRobot[1].trim()})`;

  const serverRobot = location.match(/^Archivio server robot\s+(.+)$/i);
  if (serverRobot?.[1]) return `Server (${serverRobot[1].trim()})`;

  return null;
}

function formatLogDirection(
  item: ParsedTransferLog,
  recordByTransferId: Map<string, TransferLogRecord>
): string | null {
  const srcLabel = formatCompactLogEndpoint(item.source);
  const dstLabel = formatCompactLogEndpoint(item.destination);
  if (srcLabel && dstLabel) {
    return `${srcLabel} → ${dstLabel}`;
  }

  const transferId =
    item.transferId || (item.details || "").match(/transferId:\s*([0-9a-f-]{8,})/i)?.[1];
  const matchedRec = transferId ? recordByTransferId.get(transferId) : undefined;
  if (matchedRec) {
    return formatTransferEndpoints({
      direction: matchedRec.direction,
      robotId: matchedRec.robotId,
      sourcePath: matchedRec.sourcePath,
      destinationPath: matchedRec.destinationPath,
    }).label;
  }

  const rawDirection = (item.direction || "").trim().toUpperCase();
  if (!rawDirection) return null;
  if (rawDirection === "SERVER_TO_SERVER") return "Server → Server";
  return DIRECTION_LABELS[rawDirection as keyof typeof DIRECTION_LABELS] || item.direction || null;
}

function formatCompactTransferLogDetails(
  rawDetails: string | undefined,
  outcome: string | undefined,
  recordByTransferId: Map<string, TransferLogRecord>
): FormattedLogDetails {
  const text = (rawDetails || "").trim();
  if (!text) return { summary: "—" };

  const transferIdMatch = text.match(/transferId:\s*([0-9a-f-]{8,})/i);
  const batchIdMatch = text.match(/batchId:\s*([0-9a-f-]{8,})/i);
  const checksumMatch = text.match(/checksum:\s*([0-9a-f]{16,128})/i);
  const speedMatch = text.match(/media:\s*(\d+(?:\.\d+)?)\s*B\/s/i);
  const bytesMatch = text.match(/(\d+)(?:\/(\d+))?\s*byte/i);

  const transferId = transferIdMatch?.[1];
  const batchId = batchIdMatch?.[1];
  const checksum = checksumMatch?.[1];
  const matchedRec = transferId ? recordByTransferId.get(transferId) : undefined;

  const techParts: string[] = [];
  if (transferId) techParts.push(`Transfer ID: ${transferId}`);
  if (batchId) techParts.push(`Batch ID: ${batchId}`);
  if (checksum) techParts.push(`SHA-256: ${checksum}`);
  const technical = techParts.length > 0 ? techParts.join(" | ") : undefined;

  const upperOutcome = (outcome || "").toUpperCase();
  const isSuccess =
    upperOutcome === "SUCCESSO" ||
    upperOutcome === "COMPLETED" ||
    upperOutcome === "OK" ||
    /^Completato\b/i.test(text);

  if (isSuccess && (bytesMatch || speedMatch || checksumMatch)) {
    const parts: string[] = [];
    if (bytesMatch) {
      const byteCount = Number(bytesMatch[2] || bytesMatch[1]);
      if (Number.isFinite(byteCount) && byteCount >= 0) {
        parts.push(StateFormatter.formatBytes(byteCount));
      }
    }
    if (speedMatch) {
      const bps = Number(speedMatch[1]);
      if (Number.isFinite(bps) && bps > 0) {
        parts.push(formatSpeed(bps));
      }
    }
    if (checksum) {
      parts.push("Checksum verificato");
    }
    if (matchedRec) {
      const isGeneral = isGeneralArchiveTransfer(matchedRec);
      if (matchedRec.direction === "CLIENT_TO_ROBOT" || matchedRec.direction === "SERVER_TO_ROBOT" || matchedRec.direction === "ROBOT_TO_ROBOT") {
        parts.push(`→ ${matchedRec.robotId}`);
      } else if (matchedRec.direction === "CLIENT_TO_SERVER") {
        parts.push(isGeneral ? "→ Archivio Generale" : `→ Server (${matchedRec.robotId})`);
      }
    }
    return {
      summary: parts.length > 0 ? parts.join(" · ") : "Completato",
      technical,
    };
  }

  if (!isSuccess || /^(?:Fallito|Annullato)\b/i.test(text)) {
    return {
      summary: compactErrorMessage(text),
      technical,
    };
  }

  return { summary: text, technical };
}

export const LogsView: React.FC<LogsViewProps> = ({ user }) => {
  const isAdmin = user.roles.some(
    (r) => r.toLowerCase() === "admin"
  );

  const [activeTab, setActiveTab] = useState<"access" | "transfers">("access");

  // Access Logs State
  const [rawAccessLogs, setRawAccessLogs] = useState<string[]>([]);
  const [accessLoading, setAccessLoading] = useState<boolean>(false);
  const [accessError, setAccessError] = useState<string | null>(null);
  const [accessUserFilter, setAccessUserFilter] = useState<string>("");
  const [accessEventFilter, setAccessEventFilter] = useState<string>("ALL");
  const [accessOutcomeFilter, setAccessOutcomeFilter] = useState<string>("ALL");

  // Transfer Logs State
  const [rawTransferLogs, setRawTransferLogs] = useState<string[]>([]);
  const [transferRecords, setTransferRecords] = useState<TransferLogRecord[]>([]);
  const [transferLoading, setTransferLoading] = useState<boolean>(false);
  const [transferError, setTransferError] = useState<string | null>(null);
  const [transferUserFilter, setTransferUserFilter] = useState<string>("");
  const [transferOutcomeFilter, setTransferOutcomeFilter] = useState<string>("ALL");
  const [transferFileFilter, setTransferFileFilter] = useState<string>("");
  const [transferBatchFilter, setTransferBatchFilter] = useState<string>("");
  const [expandedLogRows, setExpandedLogRows] = useState<Set<number>>(() => new Set());
  const [confirmClearTarget, setConfirmClearTarget] = useState<"access" | "transfers" | null>(null);
  const [clearingLogType, setClearingLogType] = useState<"access" | "transfers" | null>(null);

  const toggleLogRowTech = useCallback((idx: number) => {
    setExpandedLogRows((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  }, []);

  const recordByTransferId = useMemo(() => {
    const map = new Map<string, TransferLogRecord>();
    for (const rec of transferRecords) {
      map.set(rec.transferId, rec);
    }
    return map;
  }, [transferRecords]);

  const loadAccessLogs = useCallback(async () => {
    setAccessLoading(true);
    setAccessError(null);
    try {
      const res = await apiClient.get("/api/logs/access?limit=500");
      if (!res.ok) {
        throw new Error(`Errore caricamento log di accesso (${res.status})`);
      }
      const textOrJson = await res.text();
      let lines: string[] = [];
      try {
        const parsed = JSON.parse(textOrJson);
        if (Array.isArray(parsed)) {
          lines = parsed.map((item) => (typeof item === "string" ? item : JSON.stringify(item)));
        } else if (parsed && Array.isArray(parsed.logs)) {
          lines = parsed.logs;
        } else if (parsed && Array.isArray(parsed.lines)) {
          lines = parsed.lines;
        } else if (parsed && Array.isArray(parsed.entries)) {
          lines = parsed.entries.map((item: any) =>
            typeof item === "string" ? item : `[${item.timestamp || ""}] EVENT: ${item.event || ""} | Utente: ${item.user || item.username || ""} | Ruolo: ${item.role || ""} | Esito: ${item.outcome || ""} | Dettagli: ${item.details || ""}`
          );
        } else {
          lines = textOrJson.split("\n").filter((l) => l.trim().length > 0);
        }
      } catch {
        lines = textOrJson.split("\n").filter((l) => l.trim().length > 0);
      }
      // Ordine cronologico decrescente (i più recenti in cima)
      setRawAccessLogs([...lines].reverse());
    } catch (err: any) {
      setAccessError(err.message || "Impossibile recuperare i log di accesso.");
    } finally {
      setAccessLoading(false);
    }
  }, []);

  const transferLogRequest = useRef(0);

  const loadTransferLogs = useCallback(async () => {
    const requestId = ++transferLogRequest.current;
    setTransferLoading(true);
    setTransferError(null);
    try {
      const params = new URLSearchParams({ limit: "500" });
      if (transferOutcomeFilter !== "ALL") params.set("outcome", transferOutcomeFilter);
      const res = await apiClient.get(`/api/logs/transfers?${params}`);
      if (!res.ok) {
        throw new Error(`Errore caricamento log trasferimenti (${res.status})`);
      }
      const textOrJson = await res.text();
      let lines: string[] = [];
      let records: TransferLogRecord[] = [];
      try {
        const parsed = JSON.parse(textOrJson);
        if (Array.isArray(parsed)) {
          lines = parsed.map((item) => (typeof item === "string" ? item : JSON.stringify(item)));
        } else {
          if (parsed && Array.isArray(parsed.records)) {
            records = parsed.records;
          }
          if (parsed && Array.isArray(parsed.logs)) {
            lines = parsed.logs;
          } else if (parsed && Array.isArray(parsed.lines)) {
            lines = parsed.lines;
          } else if (parsed && Array.isArray(parsed.entries)) {
            lines = parsed.entries.map((item: any) =>
              typeof item === "string" ? item : `[${item.timestamp || ""}] File: ${item.filename || ""} | Utente: ${item.user || item.username || ""} | Direzione: ${item.direction || ""} | Esito: ${item.outcome || ""} | Dettagli: ${item.details || ""}`
            );
          } else if (!Array.isArray(parsed?.records)) {
            lines = textOrJson.split("\n").filter((l) => l.trim().length > 0);
          }
        }
      } catch {
        lines = textOrJson.split("\n").filter((l) => l.trim().length > 0);
      }
      // Ordine cronologico decrescente (i più recenti in cima)
      if (requestId === transferLogRequest.current) {
        setRawTransferLogs([...lines].reverse());
        setTransferRecords(records);
      }
    } catch (err: any) {
      if (requestId === transferLogRequest.current) {
        setTransferError(err.message || "Impossibile recuperare i log dei trasferimenti.");
      }
    } finally {
      if (requestId === transferLogRequest.current) setTransferLoading(false);
    }
  }, [transferOutcomeFilter]);

  useEffect(() => {
    if (isAdmin) void loadAccessLogs();
  }, [isAdmin, loadAccessLogs]);

  useEffect(() => {
    if (isAdmin && activeTab === "transfers") void loadTransferLogs();
    return () => { transferLogRequest.current += 1; };
  }, [isAdmin, activeTab, loadTransferLogs]);

  const handleConfirmClearLogs = useCallback(async () => {
    if (!confirmClearTarget || clearingLogType) return;
    const target = confirmClearTarget;
    setClearingLogType(target);
    if (target === "access") setAccessError(null);
    else setTransferError(null);

    try {
      const res = await apiClient.delete(`/api/logs/${target}`);
      if (!res.ok) {
        let serverMessage = "";
        try {
          const payload = await res.json();
          if (payload && typeof payload.message === "string") {
            serverMessage = payload.message;
          }
        } catch {}
        throw new Error(
          serverMessage ||
            (target === "access"
              ? `Impossibile eliminare il registro Log di Accesso (${res.status}).`
              : `Impossibile eliminare il registro Log trasferimenti (${res.status}).`)
        );
      }

      setConfirmClearTarget(null);
      if (target === "access") {
        await loadAccessLogs();
      } else {
        setExpandedLogRows(new Set());
        await loadTransferLogs();
      }
    } catch (err: any) {
      setConfirmClearTarget(null);
      const fallback =
        target === "access"
          ? "Impossibile eliminare il registro Log di Accesso."
          : "Impossibile eliminare il registro Log trasferimenti.";
      if (target === "access") {
        setAccessError(err?.message || fallback);
      } else {
        setTransferError(err?.message || fallback);
      }
    } finally {
      setClearingLogType(null);
    }
  }, [confirmClearTarget, clearingLogType, loadAccessLogs, loadTransferLogs]);

  // Parse and filter Access Logs
  const parsedAccessLogs = useMemo<ParsedAccessLog[]>(() => {
    return rawAccessLogs.map((line) => {
      const match = line.match(ACCESS_LINE_REGEX);
      if (match) {
        return {
          raw: line,
          timestamp: formatLogTime(match[1]),
          event: match[2]?.trim().toUpperCase(),
          username: match[3]?.trim(),
          role: match[4]?.trim(),
          outcome: match[5]?.trim().toUpperCase(),
          details: match[6]?.trim(),
        };
      }
      return { raw: line };
    });
  }, [rawAccessLogs]);

  const filteredAccessLogs = useMemo(() => {
    return parsedAccessLogs.filter((entry) => {
      if (accessUserFilter.trim() && entry.username) {
        if (!entry.username.toLowerCase().includes(accessUserFilter.toLowerCase().trim())) {
          return false;
        }
      }
      if (accessEventFilter !== "ALL" && entry.event) {
        if (!entry.event.includes(accessEventFilter)) return false;
      }
      if (accessOutcomeFilter !== "ALL" && entry.outcome) {
        if (!entry.outcome.includes(accessOutcomeFilter)) return false;
      }
      return true;
    });
  }, [parsedAccessLogs, accessUserFilter, accessEventFilter, accessOutcomeFilter]);

  // Parse and filter Transfer Logs
  const parsedTransferLogs = useMemo<ParsedTransferLog[]>(() => {
    return rawTransferLogs.map((line) => {
      const bulkHeaderMatch = line.match(BULK_HEADER_REGEX);
      if (bulkHeaderMatch) {
        return {
          raw: line,
          isBulkHeader: true,
          batchId: bulkHeaderMatch[1]?.trim(),
          details: `Inizio caricamento massivo: ${bulkHeaderMatch[2]?.trim()} file`,
          username: bulkHeaderMatch[3]?.trim(),
          timestamp: formatLogTime(`${bulkHeaderMatch[4].trim()} ${bulkHeaderMatch[5].trim()}`),
        };
      }
      const bulkFooterMatch = line.match(BULK_FOOTER_REGEX);
      if (bulkFooterMatch) {
        const doneCount = bulkFooterMatch[3]?.trim() || "0";
        const totalCount = bulkFooterMatch[4]?.trim() || "0";
        const cancelledCount = Number(bulkFooterMatch[5]?.trim() || "0");
        const failedCount = Number(bulkFooterMatch[6]?.trim() || "0");
        const summaryParts = [`Completati: ${doneCount}/${totalCount}`];
        if (cancelledCount > 0) summaryParts.push(`Annullati: ${cancelledCount}`);
        if (failedCount > 0) summaryParts.push(`Falliti: ${failedCount}`);
        return {
          raw: line,
          isBulkFooter: true,
          bulkSummary: getBulkSummary(
            Number(bulkFooterMatch[3]), Number(bulkFooterMatch[4]),
            Number(bulkFooterMatch[5]), Number(bulkFooterMatch[6]),
          ),
          batchId: bulkFooterMatch[1]?.trim(),
          outcome: bulkFooterMatch[2]?.trim().toUpperCase(),
          details: summaryParts.join(" · "),
          timestamp: formatLogTime(`${bulkFooterMatch[7].trim()} ${bulkFooterMatch[8].trim()}`),
        };
      }
      const bulkItemMatch = line.match(BULK_ITEM_REGEX);
      if (bulkItemMatch) {
        const itemIndex = bulkItemMatch[2]?.trim();
        const itemTotal = bulkItemMatch[3]?.trim();
        const reason = bulkItemMatch[6]?.trim();
        const extraDetails = bulkItemMatch[8]?.trim();
        return {
          raw: line,
          isBulkItem: true,
          batchId: bulkItemMatch[1]?.trim(),
          filename: bulkItemMatch[4]?.trim(),
          outcome: normalizeTransferOutcome(bulkItemMatch[5]),
          direction: bulkItemMatch[7]?.trim(),
          details: `[FILE ${itemIndex}/${itemTotal}]${reason ? ` (${reason})` : ""}${extraDetails ? ` ${extraDetails}` : ""}`,
        };
      }
      const stdMatch = line.match(TRANSFER_STANDARD_REGEX);
      if (stdMatch) {
        return {
          raw: line,
          timestamp: formatLogTime(stdMatch[1]),
          filename: stdMatch[2]?.trim(),
          username: stdMatch[3]?.trim(),
          direction: stdMatch[4]?.trim(),
          outcome: normalizeTransferOutcome(stdMatch[5]),
          source: stdMatch[6]?.trim(),
          destination: stdMatch[7]?.trim(),
          batchId: stdMatch[8]?.trim(),
          isBulkItem: Boolean(stdMatch[8]),
          transferId: stdMatch[9]?.trim(),
          details: stdMatch[10]?.trim(),
        };
      }
      const legacy = line.match(LEGACY_TRANSFER_REGEX);
      if (legacy) {
        return {
          raw: line,
          timestamp: formatLogTime(legacy[1]),
          filename: legacy[2]?.trim(),
          username: legacy[3]?.trim(),
          direction: legacy[4]?.trim(),
          outcome: normalizeTransferOutcome(legacy[5]),
          details: legacy[6]?.trim(),
        };
      }
      return { raw: line };
    });
  }, [rawTransferLogs]);

  const filteredTransferLogs = useMemo(() => {
    const userNeedle = transferUserFilter.trim().toLowerCase();
    const fileNeedle = transferFileFilter.trim().toLowerCase();
    const batchNeedle = transferBatchFilter.trim().toLowerCase();
    return parsedTransferLogs.filter((entry) => {
      if (userNeedle && !entry.username?.toLowerCase().includes(userNeedle)) {
        return false;
      }
      if (fileNeedle && !entry.filename?.toLowerCase().includes(fileNeedle)) {
        return false;
      }
      if (batchNeedle) {
        if (!(entry.batchId || "").toLowerCase().includes(batchNeedle) && !entry.raw.toLowerCase().includes(batchNeedle)) {
          return false;
        }
      }
      if (transferOutcomeFilter !== "ALL") {
        if (entry.isBulkHeader || entry.isBulkFooter || !entry.outcome) {
          return false;
        }
        const up = entry.outcome.toUpperCase();
        if (transferOutcomeFilter === "SUCCESSO" || transferOutcomeFilter === "COMPLETED") {
          if (up !== "SUCCESSO" && up !== "COMPLETED" && up !== "OK") return false;
        } else if (transferOutcomeFilter === "FALLIMENTO" || transferOutcomeFilter === "FAILED") {
          if (
            !up.includes("FALLIMENT") &&
            !up.includes("FALLIT") &&
            !up.includes("FAIL") &&
            !up.includes("PARZIAL") &&
            !up.includes("ERRORE")
          ) {
            return false;
          }
        } else if (transferOutcomeFilter === "ANNULLATO" || transferOutcomeFilter === "CANCELLED") {
          if (!up.includes("ANNULLAT") && !up.includes("CANCEL")) return false;
        } else if (!up.includes(transferOutcomeFilter)) {
          return false;
        }
      }
      return true;
    });
  }, [parsedTransferLogs, transferUserFilter, transferFileFilter, transferBatchFilter, transferOutcomeFilter]);

  if (!isAdmin) return null;

  return (
    <main className="container-fluid px-4 py-4" id="logs-view-container">
      <div className="d-flex justify-content-between align-items-center mb-4 flex-wrap gap-2">
        <div>
          <h1 className="h3 fw-bold mb-1">Registro e Log di Sistema</h1>
          <p className="text-secondary small mb-0">
            Tracciamento delle sessioni di autenticazione e delle operazioni di trasferimento file su disco persistente.
          </p>
        </div>
        <div className="d-flex align-items-center gap-2">
          {activeTab === "access" ? (
            <>
              <button
                type="button"
                id="btn-refresh-access-logs"
                className="btn btn-outline-primary btn-sm"
                onClick={loadAccessLogs}
                disabled={accessLoading}
              >
                {accessLoading ? "Aggiornamento..." : "Aggiorna Log Accesso"}
              </button>
              <a
                id="btn-download-access-logs"
                href="/api/logs/download/access"
                download="access.log"
                className="btn btn-outline-secondary btn-sm"
              >
                Scarica access.log
              </a>
              <button
                type="button"
                id="btn-clear-access-logs"
                className="btn btn-outline-danger btn-sm"
                onClick={() => setConfirmClearTarget("access")}
                disabled={accessLoading || clearingLogType === "access"}
              >
                Elimina log
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                id="btn-refresh-transfer-logs"
                className="btn btn-outline-primary btn-sm"
                onClick={loadTransferLogs}
                disabled={transferLoading}
              >
                {transferLoading ? "Aggiornamento..." : "Aggiorna Log Trasferimenti"}
              </button>
              <a
                id="btn-download-transfer-logs"
                href="/api/logs/download/transfers"
                download="transfers.log"
                className="btn btn-outline-secondary btn-sm"
              >
                Scarica transfers.log
              </a>
              <button
                type="button"
                id="btn-clear-transfer-logs"
                className="btn btn-outline-danger btn-sm"
                onClick={() => setConfirmClearTarget("transfers")}
                disabled={transferLoading || clearingLogType === "transfers"}
              >
                Elimina log
              </button>
            </>
          )}
        </div>
      </div>

      {/* Schede di Navigazione Log */}
      <ul className="nav nav-tabs mb-3" role="tablist">
        <li className="nav-item" role="presentation">
          <button
            type="button"
            className={`nav-link fw-semibold ${activeTab === "access" ? "active" : ""}`}
            id="tab-access-logs"
            onClick={() => setActiveTab("access")}
            role="tab"
            aria-selected={activeTab === "access"}
          >
            Log di Accesso ({filteredAccessLogs.length})
          </button>
        </li>
        <li className="nav-item" role="presentation">
          <button
            type="button"
            className={`nav-link fw-semibold ${activeTab === "transfers" ? "active" : ""}`}
            id="tab-transfer-logs"
            onClick={() => setActiveTab("transfers")}
            role="tab"
            aria-selected={activeTab === "transfers"}
          >
            Log Trasferimenti File ({filteredTransferLogs.length})
          </button>
        </li>
      </ul>

      {/* SCHEDA 1: LOG DI ACCESSO */}
      {activeTab === "access" && (
        <div id="panel-access-logs">
          {/* Barra Filtri Accesso */}
          <div className="card shadow-sm mb-3 border-0 bg-light">
            <div className="card-body py-2">
              <div className="row g-2 align-items-center">
                <div className="col-12 col-md-4">
                  <input
                    type="text"
                    id="filter-access-user"
                    className="form-control form-control-sm"
                    placeholder="Filtra per utente..."
                    value={accessUserFilter}
                    onChange={(e) => setAccessUserFilter(e.target.value)}
                  />
                </div>
                <div className="col-6 col-md-3">
                  <select
                    id="filter-access-event"
                    className="form-select form-select-sm"
                    value={accessEventFilter}
                    onChange={(e) => setAccessEventFilter(e.target.value)}
                  >
                    <option value="ALL">Tutti gli eventi</option>
                    <option value="LOGIN">LOGIN</option>
                    <option value="LOGOUT">LOGOUT</option>
                    <option value="INACTIVITY">INACTIVITY_LOGOUT</option>
                  </select>
                </div>
                <div className="col-6 col-md-3">
                  <select
                    id="filter-access-outcome"
                    className="form-select form-select-sm"
                    value={accessOutcomeFilter}
                    onChange={(e) => setAccessOutcomeFilter(e.target.value)}
                  >
                    <option value="ALL">Tutti gli esiti</option>
                    <option value="SUCCESSO">SUCCESSO</option>
                    <option value="FALLIMENTO">FALLIMENTO</option>
                  </select>
                </div>
                <div className="col-12 col-md-2 text-md-end">
                  <button
                    type="button"
                    className="btn btn-sm btn-outline-secondary w-100"
                    onClick={() => {
                      setAccessUserFilter("");
                      setAccessEventFilter("ALL");
                      setAccessOutcomeFilter("ALL");
                    }}
                  >
                    Azzera Filtri
                  </button>
                </div>
              </div>
            </div>
          </div>

          {accessError && (
            <div className="alert alert-danger" role="alert">
              {accessError}
            </div>
          )}

          <div className="card shadow-sm border-0">
            <div className="table-responsive">
              <table className="table table-hover align-middle mb-0" id="table-access-logs">
                <thead className="table-light small">
                  <tr>
                    <th scope="col" style={{ width: "180px" }}>Data / Ora</th>
                    <th scope="col" style={{ width: "140px" }}>Evento</th>
                    <th scope="col" style={{ width: "160px" }}>Utente</th>
                    <th scope="col" style={{ width: "140px" }}>Ruolo</th>
                    <th scope="col" style={{ width: "120px" }}>Esito</th>
                    <th scope="col">Dettagli</th>
                  </tr>
                </thead>
                <tbody className="small">
                  {filteredAccessLogs.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="text-center py-4 text-muted">
                        {accessLoading
                          ? "Caricamento log in corso..."
                          : rawAccessLogs.length === 0
                          ? "Nessun log disponibile"
                          : "Nessun evento di accesso corrisponde ai filtri selezionati."}
                      </td>
                    </tr>
                  ) : (
                    filteredAccessLogs.map((item, idx) => (
                      <tr key={idx}>
                        <td className="text-monospace text-secondary">{item.timestamp || "—"}</td>
                        <td>
                          {item.event ? (
                            <span
                              className={`badge ${
                                item.event.includes("LOGIN")
                                  ? "text-bg-primary"
                                  : item.event.includes("INACTIVITY")
                                  ? "text-bg-warning"
                                  : "text-bg-secondary"
                              }`}
                            >
                              {item.event}
                            </span>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td className="fw-semibold">{item.username || "—"}</td>
                        <td>{item.role || "—"}</td>
                        <td>
                          {item.outcome ? (
                            <span
                              className={`badge ${
                                item.outcome === "SUCCESSO" ? "text-bg-success" : "text-bg-danger"
                              }`}
                            >
                              {item.outcome}
                            </span>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td className="text-break">{item.details || item.raw}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* SCHEDA 2: LOG TRASFERIMENTI FILE */}
      {activeTab === "transfers" && (
        <div id="panel-transfer-logs">
          {/* Barra Filtri Trasferimenti */}
          <div className="card shadow-sm mb-3 border-0 bg-light">
            <div className="card-body py-2">
              <div className="row g-2 align-items-center">
                <div className="col-12 col-md-2">
                  <input
                    type="text"
                    id="filter-transfer-user"
                    className="form-control form-control-sm"
                    placeholder="Filtra per utente..."
                    value={transferUserFilter}
                    onChange={(e) => setTransferUserFilter(e.target.value)}
                  />
                </div>
                <div className="col-12 col-md-3">
                  <input
                    type="text"
                    id="filter-transfer-file"
                    className="form-control form-control-sm"
                    placeholder="Filtra per nome file..."
                    value={transferFileFilter}
                    onChange={(e) => setTransferFileFilter(e.target.value)}
                  />
                </div>
                <div className="col-12 col-md-3">
                  <input
                    type="text"
                    id="filter-transfer-batch"
                    className="form-control form-control-sm"
                    placeholder="Filtra per Batch ID..."
                    value={transferBatchFilter}
                    onChange={(e) => setTransferBatchFilter(e.target.value)}
                  />
                </div>
                <div className="col-6 col-md-2">
                  <select
                    id="filter-transfer-outcome"
                    className="form-select form-select-sm"
                    value={transferOutcomeFilter}
                    onChange={(e) => setTransferOutcomeFilter(e.target.value)}
                  >
                    <option value="ALL">Tutti gli esiti</option>
                    <option value="SUCCESSO">SUCCESSO</option>
                    <option value="FALLIMENTO">FALLIMENTO</option>
                    <option value="ANNULLATO">ANNULLATO</option>
                  </select>
                </div>
                <div className="col-6 col-md-2 text-md-end">
                  <button
                    type="button"
                    className="btn btn-sm btn-outline-secondary w-100"
                    onClick={() => {
                      setTransferUserFilter("");
                      setTransferFileFilter("");
                      setTransferBatchFilter("");
                      setTransferOutcomeFilter("ALL");
                    }}
                  >
                    Azzera Filtri
                  </button>
                </div>
              </div>
            </div>
          </div>

          {transferError && (
            <div className="alert alert-danger" role="alert">
              {transferError}
            </div>
          )}

          <div className="card shadow-sm border-0">
            <div className="table-responsive">
              <table className="table table-hover align-middle mb-0" id="table-transfer-logs">
                <thead className="table-light small">
                  <tr>
                    <th scope="col" style={{ width: "180px" }}>Data / Ora</th>
                    <th scope="col" style={{ width: "220px" }}>File</th>
                    <th scope="col" style={{ width: "140px" }}>Utente</th>
                    <th scope="col" style={{ width: "220px" }}>Direzione / Tipo</th>
                    <th scope="col" style={{ width: "120px" }}>Esito</th>
                    <th scope="col">Dettagli</th>
                  </tr>
                </thead>
                <tbody className="small">
                  {filteredTransferLogs.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="text-center py-4 text-muted">
                        {transferLoading
                          ? "Caricamento log in corso..."
                          : rawTransferLogs.length === 0
                          ? "Nessun log disponibile"
                          : "Nessun log di trasferimento corrisponde ai filtri selezionati."}
                      </td>
                    </tr>
                  ) : (
                    filteredTransferLogs.map((item, idx) => {
                      if (item.isBulkHeader) {
                        return (
                          <tr key={idx} className="table-primary fw-semibold">
                            <td className="text-monospace">{item.timestamp || "—"}</td>
                            <td colSpan={3}>
                              <span className="badge text-bg-primary me-2">Caricamento Massivo</span>
                              Batch ID: <code>{item.batchId}</code> · Utente: {item.username}
                            </td>
                            <td>
                              <span className="badge text-bg-info">Avviato</span>
                            </td>
                            <td>{item.details}</td>
                          </tr>
                        );
                      }
                      if (item.isBulkFooter) {
                        const footerOutcome = (item.outcome || "").toUpperCase();
                        const footerSuccess = footerOutcome === "SUCCESSO" || footerOutcome === "COMPLETED";
                        const footerPartial = footerOutcome.includes("PARZIAL");
                        const footerCancelled = footerOutcome.includes("ANNULLAT") || footerOutcome.includes("CANCEL");
                        const footerBadgeClass = footerSuccess
                          ? "text-bg-success"
                          : footerPartial
                          ? "text-bg-warning text-dark"
                          : footerCancelled
                          ? "text-bg-secondary"
                          : "text-bg-danger";
                        const footerLabel = footerSuccess
                          ? "Completato"
                          : footerPartial
                          ? "Parziale"
                          : footerCancelled
                          ? "Annullato"
                          : "Fallito";
                        return (
                          <tr key={idx} className={footerSuccess ? "table-secondary fw-semibold" : "table-danger fw-semibold"}>
                            <td className="text-monospace">{item.timestamp || "—"}</td>
                            <td colSpan={3}>
                              <span className="badge text-bg-dark me-2">Fine Caricamento Massivo</span>
                              Batch ID: <code>{item.batchId}</code>
                            </td>
                            <td>
                              {item.bulkSummary ? (
                                <span className={`badge ${item.bulkSummary.badgeClass}`}>{item.bulkSummary.label}</span>
                              ) : (
                                <span className={`badge ${footerBadgeClass}`}>{footerLabel}</span>
                              )}
                            </td>
                            <td>{item.details}</td>
                          </tr>
                        );
                      }
                      const entryOutcome = (item.outcome || "").toUpperCase();
                      const isSuccessEntry = entryOutcome === "SUCCESSO" || entryOutcome === "COMPLETED" || entryOutcome === "OK";
                      const formattedDetails = formatCompactTransferLogDetails(
                        item.details || item.raw,
                        item.outcome,
                        recordByTransferId
                      );
                      const isTechExpanded = expandedLogRows.has(idx);
                      const directionLabel = formatLogDirection(item, recordByTransferId);
                      return (
                        <tr key={idx}>
                          <td className="text-monospace text-secondary">{item.timestamp || "—"}</td>
                          <td className="fw-semibold text-break">
                            {item.isBulkItem && (
                              <span className="badge text-bg-info text-dark me-1" style={{ fontSize: "10px" }}>
                                Bulk
                              </span>
                            )}
                            {item.filename || "—"}
                          </td>
                          <td>{item.username || "—"}</td>
                          <td>
                            {directionLabel ? (
                              <span className="transfer-direction-badge text-wrap text-start">
                                {directionLabel}
                              </span>
                            ) : (
                              "—"
                            )}
                          </td>
                          <td>
                            {item.outcome ? (
                              <span
                                className={`badge ${
                                  transferOutcomeBadgeClasses[item.outcome] ?? (isSuccessEntry ? "text-bg-success" : "text-bg-danger")
                                }`}
                              >
                                {item.outcome}
                              </span>
                            ) : (
                              "—"
                            )}
                          </td>
                          <td className="text-break" title={formattedDetails.technical}>
                            {(item.source || item.destination) && (
                              <div className="small text-secondary">
                                {item.source || "—"} → {item.destination || "—"}
                              </div>
                            )}
                            {item.batchId && (
                              <div className="small text-secondary">
                                Batch ID: <code>{item.batchId}</code>
                              </div>
                            )}
                            <span className={entryOutcome === "FALLIMENTO" ? "text-danger fw-semibold" : ""}>
                              {formattedDetails.summary}
                            </span>
                            {formattedDetails.technical && (
                              <>
                                {" "}
                                <button
                                  type="button"
                                  className="btn btn-link btn-sm p-0 align-baseline text-secondary text-decoration-none"
                                  style={{ fontSize: "11px" }}
                                  onClick={() => toggleLogRowTech(idx)}
                                  aria-expanded={isTechExpanded}
                                >
                                  {isTechExpanded ? "[nascondi]" : "[dettagli]"}
                                </button>
                                {isTechExpanded && (
                                  <div className="text-muted font-monospace mt-1" style={{ fontSize: "11px" }}>
                                    {formattedDetails.technical}
                                  </div>
                                )}
                              </>
                            )}
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      <Modal
        id="clear-logs-modal"
        isOpen={confirmClearTarget !== null}
        onClose={() => {
          if (!clearingLogType) setConfirmClearTarget(null);
        }}
        title="Conferma eliminazione log"
        role="alertdialog"
        ariaLabelledBy="clear-logs-modal-title"
        disableDismiss={clearingLogType !== null}
        footer={
          <>
            <button
              type="button"
              id="btn-cancel-clear-logs"
              className="btn btn-secondary btn-sm"
              onClick={() => setConfirmClearTarget(null)}
              disabled={clearingLogType !== null}
            >
              Annulla
            </button>
            <button
              type="button"
              id="btn-confirm-clear-logs"
              className="btn btn-danger btn-sm"
              onClick={() => void handleConfirmClearLogs()}
              disabled={clearingLogType !== null}
            >
              {clearingLogType !== null ? "Eliminazione..." : "Elimina"}
            </button>
          </>
        }
      >
        <p className="mb-0">
          {confirmClearTarget === "access"
            ? "Sei sicuro di voler svuotare il registro Log accessi? Tutti gli eventi di accesso salvati sul server verranno eliminati definitivamente. Il registro Log trasferimenti non verrà modificato."
            : "Sei sicuro di voler svuotare il registro Log trasferimenti? Tutte le voci del registro trasferimenti salvate sul server verranno eliminate definitivamente. Il registro Log accessi non verrà modificato."}
        </p>
      </Modal>
    </main>
  );
};
