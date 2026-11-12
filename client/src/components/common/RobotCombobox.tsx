import React, { useState, useRef, useEffect, useMemo } from "react";
import type { RobotSummaryDto } from "../../types/fleet.ts";

export interface RobotComboboxProps {
  id: string;
  name?: string;
  value: string;
  onChange: (id: string) => void;
  onSubmit?: () => void;
  robots?: RobotSummaryDto[];
  loading?: boolean;
  placeholder?: string;
  disabled?: boolean;
}

export const RobotCombobox: React.FC<RobotComboboxProps> = ({
  id,
  name,
  value,
  onChange,
  onSubmit,
  robots = [],
  loading = false,
  placeholder = "es. robot_01",
  disabled = false,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState<number>(-1);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Filtro in tempo reale su: ID, Nome, Cliente, Impianto
  const filteredRobots = useMemo(() => {
    const q = (value || "").toLowerCase().trim();
    if (!q) return robots;

    return robots.filter((r) => {
      const matchId = (r.id || "").toLowerCase().includes(q);
      const matchName = (r.displayName || "").toLowerCase().includes(q);
      const matchCustomer = (r.customerName || "").toLowerCase().includes(q);
      const matchPlant = (r.plantName || "").toLowerCase().includes(q);
      return matchId || matchName || matchCustomer || matchPlant;
    });
  }, [robots, value]);

  // Chiudi al click esterno
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
        setHighlightedIndex(-1);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, []);

  const handleSelectRobot = (robotId: string) => {
    onChange(robotId);
    setIsOpen(false);
    setHighlightedIndex(-1);
    inputRef.current?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (disabled) return;

    if (!isOpen) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setIsOpen(true);
        setHighlightedIndex(0);
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        if (onSubmit) onSubmit();
        return;
      }
      return;
    }

    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setHighlightedIndex((prev) =>
          prev < filteredRobots.length - 1 ? prev + 1 : 0
        );
        break;

      case "ArrowUp":
        e.preventDefault();
        setHighlightedIndex((prev) =>
          prev > 0 ? prev - 1 : filteredRobots.length - 1
        );
        break;

      case "Enter":
        e.preventDefault();
        if (highlightedIndex >= 0 && highlightedIndex < filteredRobots.length) {
          handleSelectRobot(filteredRobots[highlightedIndex].id);
        } else {
          setIsOpen(false);
          if (onSubmit) onSubmit();
        }
        break;

      case "Escape":
        e.preventDefault();
        setIsOpen(false);
        setHighlightedIndex(-1);
        break;

      case "Tab":
        setIsOpen(false);
        setHighlightedIndex(-1);
        break;

      default:
        break;
    }
  };

  return (
    <div
      ref={containerRef}
      className="position-relative d-inline-block"
      style={{ minWidth: 260, maxWidth: 380, flex: "1 1 260px" }}
    >
      <input
        ref={inputRef}
        type="text"
        id={id}
        name={name || id}
        className="form-control form-control-sm"
        placeholder={placeholder}
        value={value}
        disabled={disabled}
        autoComplete="off"
        role="combobox"
        aria-expanded={isOpen}
        aria-autocomplete="list"
        aria-controls={`${id}-popup-list`}
        onClick={() => {
          if (!disabled) setIsOpen(true);
        }}
        onFocus={() => {
          if (!disabled) setIsOpen(true);
        }}
        onChange={(e) => {
          onChange(e.target.value);
          setIsOpen(true);
          setHighlightedIndex(0);
        }}
        onKeyDown={handleKeyDown}
      />

      {isOpen && (
        <div
          id={`${id}-popup-list`}
          className="dropdown-menu show shadow-sm w-100 p-0 mt-1 border"
          style={{
            position: "absolute",
            top: "100%",
            left: 0,
            zIndex: 1050,
            maxHeight: 280,
            overflowY: "auto",
            backgroundColor: "var(--card-bg, #ffffff)",
          }}
          role="listbox"
        >
          {loading ? (
            <div className="p-3 text-center text-muted small">
              <span className="spinner-border spinner-border-sm me-2" role="status" />
              Caricamento robot in corso...
            </div>
          ) : filteredRobots.length === 0 ? (
            <div className="p-3 text-center text-muted small">
              {robots.length === 0 ? "Nessun robot registrato" : "Nessun robot trovato"}
            </div>
          ) : (
            filteredRobots.map((robot, index) => {
              const isHighlighted = index === highlightedIndex;
              const isSelected = robot.id === value;

              return (
                <div
                  key={robot.id}
                  role="option"
                  aria-selected={isSelected}
                  className={`px-3 py-2 border-bottom text-start cursor-pointer ${
                    isHighlighted ? "bg-light" : ""
                  }`}
                  style={{
                    cursor: "pointer",
                    backgroundColor: isHighlighted ? "var(--bs-light, #f8f9fa)" : "transparent",
                  }}
                  onMouseDown={(e) => {
                    // Evita il blur prima del click
                    e.preventDefault();
                    handleSelectRobot(robot.id);
                  }}
                  onMouseEnter={() => setHighlightedIndex(index)}
                >
                  <div className="d-flex justify-content-between align-items-center">
                    <strong className="text-truncate me-2" style={{ maxWidth: 200 }}>
                      {robot.displayName || robot.id}
                    </strong>
                    <code className="text-muted small">{robot.id}</code>
                  </div>
                  <div className="small text-secondary text-truncate" style={{ fontSize: "0.8rem" }}>
                    Cliente: {robot.customerName || "—"} · Impianto: {robot.plantName || "—"}
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
};
