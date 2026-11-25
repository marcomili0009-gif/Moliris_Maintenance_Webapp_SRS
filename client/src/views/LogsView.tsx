import React, { useState, useEffect, useCallback, useMemo } from "react";
import { apiClient } from "../services/api-client.ts";
import type { User } from "../types/auth.ts";

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
  isBulkItem?: boolean;
  batchId?: string;
  timestamp?: string;
  filename?: string;
  username?: string;
  direction?: string;
  outcome?: string;
  details?: string;
}

const ACCESS_LINE_REGEX =
  /^\[(.*?)\]\s+EVENT:\s*(.*?)\s*\|\s*Utente:\s*(.*?)\s*\|\s*Ruolo:\s*(.*?)\s*\|\s*Esito:\s*(.*?)(?:\s*\|\s*Dettagli:\s*(.*))?$/i;

const TRANSFER_STANDARD_REGEX =
  /^\[(.*?)\]\s+File:\s*(.*?)\s*\|\s*Utente:\s*(.*?)\s*\|\s*Direzione:\s*(.*?)\s*\|\s*Esito:\s*(.*?)(?:\s*\|\s*Dettagli:\s*(.*))?$/i;

const BULK_HEADER_REGEX =
  /^=== INIZIO CARICAMENTO MASSIVO === \[batchId:\s*(.*?)\] \((\d+) file\)\s+Utente:\s*(.*?)\s*\|\s*Data:\s*(.*?)\s*\|\s*Ora:\s*(.*?) ===$/i;

const BULK_FOOTER_REGEX =
  /^=== CARICAMENTO MASSIVO TERMINATO === \[batchId:\s*(.*?)\]\s+-\s*Esito:\s*(.*?) \(Completati:\s*(.*?)\/(.*?), Annullati:\s*(.*?), Falliti:\s*(.*?)\)\s*\|\s*Data:\s*(.*?)\s*\|\s*Ora:\s*(.*?) ===$/i;

const BULK_ITEM_REGEX =
  /^\[batchId:\s*(.*?)\]\s+\[FILE\s*(\d+)\/(\d+)\]\s+File\s+\d+:\s*(.*?)\s*\|\s*Esito:\s*(.*?)(?:\s+\((.*?)\))?\s*\|\s*Direzione:\s*(.*?)\s*\|\s*Dettagli:\s*(.*)$/i;

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
  const [transferLoading, setTransferLoading] = useState<boolean>(false);
  const [transferError, setTransferError] = useState<string | null>(null);
  const [transferUserFilter, setTransferUserFilter] = useState<string>("");
  const [transferOutcomeFilter, setTransferOutcomeFilter] = useState<string>("ALL");
  const [transferFileFilter, setTransferFileFilter] = useState<string>("");

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

  const loadTransferLogs = useCallback(async () => {
    setTransferLoading(true);
    setTransferError(null);
    try {
      const res = await apiClient.get("/api/logs/transfers?limit=500");
      if (!res.ok) {
        throw new Error(`Errore caricamento log trasferimenti (${res.status})`);
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
            typeof item === "string" ? item : `[${item.timestamp || ""}] File: ${item.filename || ""} | Utente: ${item.user || item.username || ""} | Direzione: ${item.direction || ""} | Esito: ${item.outcome || ""} | Dettagli: ${item.details || ""}`
          );
        } else {
          lines = textOrJson.split("\n").filter((l) => l.trim().length > 0);
        }
      } catch {
        lines = textOrJson.split("\n").filter((l) => l.trim().length > 0);
      }
      // Ordine cronologico decrescente (i più recenti in cima)
      setRawTransferLogs([...lines].reverse());
    } catch (err: any) {
      setTransferError(err.message || "Impossibile recuperare i log dei trasferimenti.");
    } finally {
      setTransferLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isAdmin) {
      loadAccessLogs();
      loadTransferLogs();
    }
  }, [isAdmin, loadAccessLogs, loadTransferLogs]);

  // Parse and filter Access Logs
  const parsedAccessLogs = useMemo<ParsedAccessLog[]>(() => {
    return rawAccessLogs.map((line) => {
      const match = line.match(ACCESS_LINE_REGEX);
      if (match) {
        return {
          raw: line,
          timestamp: match[1]?.trim(),
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
          timestamp: `${bulkHeaderMatch[4]?.trim()} ${bulkHeaderMatch[5]?.trim()}`,
        };
      }
      const bulkFooterMatch = line.match(BULK_FOOTER_REGEX);
      if (bulkFooterMatch) {
        return {
          raw: line,
          isBulkFooter: true,
          batchId: bulkFooterMatch[1]?.trim(),
          outcome: bulkFooterMatch[2]?.trim().toUpperCase(),
          details: `Completati: ${bulkFooterMatch[3]?.trim()}/${bulkFooterMatch[4]?.trim()} (Annullati: ${bulkFooterMatch[5]?.trim()}, Falliti: ${bulkFooterMatch[6]?.trim()})`,
          timestamp: `${bulkFooterMatch[7]?.trim()} ${bulkFooterMatch[8]?.trim()}`,
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
          outcome: bulkItemMatch[5]?.trim().toUpperCase(),
          direction: bulkItemMatch[7]?.trim(),
          details: `[FILE ${itemIndex}/${itemTotal}]${reason ? ` (${reason})` : ""}${extraDetails ? ` ${extraDetails}` : ""}`,
        };
      }
      const stdMatch = line.match(TRANSFER_STANDARD_REGEX);
      if (stdMatch) {
        return {
          raw: line,
          timestamp: stdMatch[1]?.trim(),
          filename: stdMatch[2]?.trim(),
          username: stdMatch[3]?.trim(),
          direction: stdMatch[4]?.trim(),
          outcome: stdMatch[5]?.trim().toUpperCase(),
          details: stdMatch[6]?.trim(),
        };
      }
      return { raw: line };
    });
  }, [rawTransferLogs]);

  const filteredTransferLogs = useMemo(() => {
    return parsedTransferLogs.filter((entry) => {
      if (transferUserFilter.trim() && entry.username) {
        if (!entry.username.toLowerCase().includes(transferUserFilter.toLowerCase().trim())) {
          return false;
        }
      }
      if (transferFileFilter.trim() && entry.filename) {
        if (!entry.filename.toLowerCase().includes(transferFileFilter.toLowerCase().trim())) {
          return false;
        }
      }
      if (transferOutcomeFilter !== "ALL" && entry.outcome) {
        if (!entry.outcome.includes(transferOutcomeFilter)) return false;
      }
      return true;
    });
  }, [parsedTransferLogs, transferUserFilter, transferFileFilter, transferOutcomeFilter]);

  if (!isAdmin) {
    return (
      <main className="container py-5 text-center">
        <div className="alert alert-danger shadow-sm">
          <h4 className="alert-heading fw-bold">Accesso Riservato</h4>
          <p className="mb-0">
            La visualizzazione dei log fisici di sistema è consentita esclusivamente agli utenti con ruolo Amministratore.
          </p>
        </div>
      </main>
    );
  }

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
                        {accessLoading ? "Caricamento log in corso..." : "Nessun evento di accesso trovato."}
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
                <div className="col-12 col-md-4">
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
                <div className="col-6 col-md-3">
                  <select
                    id="filter-transfer-outcome"
                    className="form-select form-select-sm"
                    value={transferOutcomeFilter}
                    onChange={(e) => setTransferOutcomeFilter(e.target.value)}
                  >
                    <option value="ALL">Tutti gli esiti</option>
                    <option value="SUCCESSO">SUCCESSO</option>
                    <option value="FALLIMENTO">FALLIMENTO</option>
                  </select>
                </div>
                <div className="col-6 col-md-2 text-md-end">
                  <button
                    type="button"
                    className="btn btn-sm btn-outline-secondary w-100"
                    onClick={() => {
                      setTransferUserFilter("");
                      setTransferFileFilter("");
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
                    <th scope="col" style={{ width: "160px" }}>Direzione / Tipo</th>
                    <th scope="col" style={{ width: "120px" }}>Esito</th>
                    <th scope="col">Dettagli</th>
                  </tr>
                </thead>
                <tbody className="small">
                  {filteredTransferLogs.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="text-center py-4 text-muted">
                        {transferLoading ? "Caricamento log in corso..." : "Nessun log di trasferimento trovato."}
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
                        return (
                          <tr key={idx} className="table-secondary fw-semibold">
                            <td className="text-monospace">{item.timestamp || "—"}</td>
                            <td colSpan={3}>
                              <span className="badge text-bg-dark me-2">Fine Caricamento Massivo</span>
                              Batch ID: <code>{item.batchId}</code>
                            </td>
                            <td>
                              <span className="badge text-bg-success">Concluso</span>
                            </td>
                            <td>{item.details}</td>
                          </tr>
                        );
                      }
                      return (
                        <tr
                          key={idx}
                          className={item.isBulkItem ? "border-start border-3 border-primary ps-2 bg-light-subtle" : ""}
                        >
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
                            {item.direction ? (
                              <span className="badge text-bg-secondary">{item.direction}</span>
                            ) : (
                              item.details || "—"
                            )}
                          </td>
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
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </main>
  );
};
