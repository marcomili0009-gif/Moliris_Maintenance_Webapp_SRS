import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Archive, ArrowLeftRight, Radio, Server } from "lucide-react";

export type FsSubTab = "server" | "general" | "remote" | "transfers";

interface FsTabDefinition {
  id: FsSubTab;
  label: string;
  icon: React.ElementType;
}

const TABS: FsTabDefinition[] = [
  { id: "general", label: "Archivio Generale Server", icon: Archive },
  { id: "server", label: "File sul Server (Robot)", icon: Server },
  { id: "remote", label: "File sul Robot", icon: Radio },
  { id: "transfers", label: "Gestione Trasferimenti", icon: ArrowLeftRight },
];

interface FsTabBarProps {
  activeTab: FsSubTab;
  onChange: (tab: FsSubTab) => void;
  activeTransfersCount?: number;
}

interface IndicatorState {
  left: number;
  width: number;
  visible: boolean;
}

/**
 * Barra dei tab della sezione File e Trasferimenti.
 * L'indicatore (pill) segue l'hover e si sposta in modo fluido sul tab attivo.
 */
export const FsTabBar: React.FC<FsTabBarProps> = ({ activeTab, onChange, activeTransfersCount = 0 }) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const buttonRefs = useRef<Partial<Record<FsSubTab, HTMLButtonElement | null>>>({});
  const [hoveredTab, setHoveredTab] = useState<FsSubTab | null>(null);
  const [indicator, setIndicator] = useState<IndicatorState>({ left: 0, width: 0, visible: false });

  const previewTab = hoveredTab ?? activeTab;

  const measure = useCallback((tab: FsSubTab) => {
    const container = containerRef.current;
    const target = buttonRefs.current[tab];
    if (!container || !target) return;

    const containerRect = container.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    if (targetRect.width === 0) return;

    setIndicator({
      left: targetRect.left - containerRect.left + container.scrollLeft,
      width: targetRect.width,
      visible: true,
    });
  }, []);

  useLayoutEffect(() => {
    measure(previewTab);
  }, [previewTab, measure]);

  useLayoutEffect(() => {
    const handleResize = () => measure(previewTab);
    window.addEventListener("resize", handleResize);

    // Il caricamento dei font può modificare la larghezza delle etichette.
    const fonts = (document as any).fonts;
    if (fonts?.ready?.then) {
      fonts.ready.then(handleResize).catch(() => {});
    }
    const raf = window.requestAnimationFrame(handleResize);

    return () => {
      window.removeEventListener("resize", handleResize);
      window.cancelAnimationFrame(raf);
    };
  }, [measure, previewTab]);

  // Mantiene visibile il tab attivo quando la barra va in overflow orizzontale.
  useEffect(() => {
    const container = containerRef.current;
    const target = buttonRefs.current[activeTab];
    if (!container || !target) return;

    const left = target.offsetLeft;
    const right = left + target.offsetWidth;
    const margin = 12;

    if (left < container.scrollLeft + margin) {
      container.scrollTo({ left: Math.max(0, left - margin), behavior: "smooth" });
    } else if (right > container.scrollLeft + container.clientWidth - margin) {
      container.scrollTo({
        left: right - container.clientWidth + margin,
        behavior: "smooth",
      });
    }
  }, [activeTab, indicator.width]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const currentIndex = TABS.findIndex((tab) => tab.id === activeTab);
    let nextIndex = currentIndex;

    if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % TABS.length;
    else if (event.key === "ArrowLeft") nextIndex = (currentIndex - 1 + TABS.length) % TABS.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = TABS.length - 1;
    else return;

    event.preventDefault();
    const nextTab = TABS[nextIndex];
    onChange(nextTab.id);
    buttonRefs.current[nextTab.id]?.focus();
  };

  return (
    <div
      ref={containerRef}
      className="fs-tab-bar"
      role="tablist"
      aria-label="Sezioni Gestione File e Trasferimenti"
      onKeyDown={handleKeyDown}
      onMouseLeave={() => setHoveredTab(null)}
    >
      <span
        className="fs-tab-indicator"
        aria-hidden="true"
        style={{
          transform: `translateX(${indicator.left}px)`,
          width: `${indicator.width}px`,
          opacity: indicator.visible ? 1 : 0,
        }}
      />

      {TABS.map((tab) => {
        const Icon = tab.icon;
        const isActive = tab.id === activeTab;

        return (
          <button
            key={tab.id}
            ref={(element) => {
              buttonRefs.current[tab.id] = element;
            }}
            type="button"
            role="tab"
            id={`btn-tab-${tab.id === "server" ? "fs-server" : tab.id === "remote" ? "fs-remote" : tab.id}`}
            data-view={tab.id}
            aria-selected={isActive}
            tabIndex={isActive ? 0 : -1}
            className={`fs-tab-btn ${isActive ? "active" : ""}`}
            onMouseEnter={() => setHoveredTab(tab.id)}
            onFocus={() => setHoveredTab(tab.id)}
            onBlur={() => setHoveredTab(null)}
            onClick={() => onChange(tab.id)}
          >
            <Icon size={16} strokeWidth={2} aria-hidden="true" />
            <span className="fs-tab-label">
              {tab.label}
              {tab.id === "transfers" && (
                <>
                  <span className="fs-tab-count" id="transfers-active-count">
                    {activeTransfersCount}
                  </span>
                  {activeTransfersCount > 0 && (
                    <span className="fs-tab-active-text ms-1" id="transfers-active-text">
                      ({activeTransfersCount} attivi)
                    </span>
                  )}
                </>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
};
