import React, { useMemo, useState, useEffect } from "react";
import { Search } from "lucide-react";
import type { RobotSummaryDto } from "../../types/fleet.ts";
import { filterRobots, type RobotFilterField } from "../../utils/filterRobots.ts";

export interface FleetFilterBarProps {
  robots: RobotSummaryDto[];
  /** Chiamato quando la lista filtrata o lo stato del filtro cambiano. */
  onFilteredChange: (filtered: RobotSummaryDto[], isFilterActive: boolean) => void;
  /** Trigger esterno numerico per forzare l'azzeramento dei filtri (es. click su Home). */
  resetTrigger?: number;
}

const FIELD_OPTIONS: Array<{ value: RobotFilterField; label: string }> = [
  { value: "tutti", label: "Tutti i campi" },
  { value: "cliente", label: "Cliente" },
  { value: "impianto", label: "Impianto" },
  { value: "nome_robot", label: "Nome Robot" },
  { value: "id_robot", label: "ID Robot" },
];

/**
 * Barra di ricerca e filtri della flotta robot (SRS §5.1).
 * Implementa filtro client-side puro con debounce ~250ms, rimozione accenti e case-insensitivity.
 */
export const FleetFilterBar: React.FC<FleetFilterBarProps> = ({
  robots,
  onFilteredChange,
  resetTrigger,
}) => {
  const [query, setQuery] = useState<string>("");
  const [field, setField] = useState<RobotFilterField>("tutti");
  const [debouncedQuery, setDebouncedQuery] = useState<string>("");

  // Debounce di ~250 ms sulla digitazione dell'utente
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedQuery(query);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [query]);

  // Gestione reset forzato da prop (es. click sul logo Home della navbar)
  useEffect(() => {
    if (resetTrigger !== undefined && resetTrigger > 0) {
      setQuery("");
      setField("tutti");
      setDebouncedQuery("");
    }
  }, [resetTrigger]);

  const isFilterActive = debouncedQuery.trim().length > 0;

  // Filtraggio con useMemo: nessuna nuova chiamata API, calcolo solo sull'array locale
  const filtered = useMemo(
    () => filterRobots(robots, debouncedQuery, field),
    [robots, debouncedQuery, field]
  );

  useEffect(() => {
    onFilteredChange(filtered, isFilterActive);
  }, [filtered, isFilterActive, onFilteredChange]);

  const handleReset = (): void => {
    setQuery("");
    setField("tutti");
    setDebouncedQuery("");
  };

  return (
    <div className="fleet-filter-bar mb-3" id="fleet-filter-bar">
      <div className="row g-2 align-items-center">
        <div className="col-12 col-md-8 col-lg-7">
          <div className="input-group">
            <span className="input-group-text bg-white" aria-hidden="true">
              <Search size={18} aria-hidden="true" />
            </span>
            <label htmlFor="fleet-filter-query" className="visually-hidden">
              Cerca robot
            </label>
            <input
              type="search"
              className="form-control"
              id="fleet-filter-query"
              aria-label="Cerca per Nome Cliente, Nome Impianto, Nome Robot o ID Robot"
              placeholder="Cerca per Nome Cliente, Nome Impianto, Nome Robot o ID Robot…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <label htmlFor="fleet-filter-field" className="visually-hidden">
              Filtra per campo
            </label>
            <select
              className="form-select flex-grow-0"
              style={{ width: "auto" }}
              id="fleet-filter-field"
              aria-label="Campo di ricerca"
              value={field}
              onChange={(e) => setField(e.target.value as RobotFilterField)}
            >
              {FIELD_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
            {isFilterActive && (
              <button
                type="button"
                className="btn btn-outline-secondary"
                id="btn-clear-filters"
                onClick={handleReset}
              >
                Azzera filtri
              </button>
            )}
          </div>
        </div>

        <div className="col-12 col-md-4 col-lg-5 text-md-end">
          <span
            className="fleet-count text-muted small"
            id="fleet-count"
            role="status"
          >
            Totale robot registrati: <strong>{filtered.length} di {robots.length} robot</strong>
          </span>
        </div>
      </div>
    </div>
  );
};
