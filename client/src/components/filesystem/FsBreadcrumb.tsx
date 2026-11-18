import React from "react";
import { ChevronRight, HardDrive } from "lucide-react";

interface FsBreadcrumbProps {
  path: string;
  rootLabel?: string;
  ariaLabel?: string;
  id?: string;
  currentPathId?: string;
  onNavigate: (path: string) => void;
  /** Se definito, il click sulla radice esegue questa azione (es. torna all'Archivio Generale). */
  onRootClick?: () => void;
}

/**
 * Breadcrumb navigabile per i filesystem della sezione File e Trasferimenti.
 * Ogni segmento intermedio è cliccabile; l'ultimo rappresenta il percorso corrente.
 */
export const FsBreadcrumb: React.FC<FsBreadcrumbProps> = ({
  path,
  rootLabel = "Radice",
  ariaLabel = "Percorso corrente",
  id,
  currentPathId,
  onNavigate,
  onRootClick,
}) => {
  const normalizedPath = path && path !== "/" ? path.replace(/\\/g, "/").replace(/\/+$/, "") : "";
  const segments = normalizedPath.split("/").filter(Boolean);

  const navigateToSegment = (index: number) => {
    const target = `/${segments.slice(0, index + 1).join("/")}`;
    onNavigate(target);
  };

  const handleRootClick = () => {
    if (onRootClick) {
      onRootClick();
    } else {
      onNavigate("/");
    }
  };

  return (
    <nav id={id} className="fs-breadcrumb" aria-label={ariaLabel}>
      <button
        type="button"
        className="fs-crumb fs-crumb-root"
        onClick={handleRootClick}
        title={onRootClick ? `${rootLabel} - torna indietro` : `Vai a ${rootLabel}`}
      >
        <HardDrive size={14} strokeWidth={2} aria-hidden="true" />
        <span>{rootLabel}</span>
      </button>

      {segments.map((segment, index) => {
        const isLast = index === segments.length - 1;
        const targetPath = `/${segments.slice(0, index + 1).join("/")}`;

        return (
          <React.Fragment key={targetPath}>
            <ChevronRight className="fs-crumb-separator" size={13} aria-hidden="true" />
            {isLast ? (
              <span
                id={currentPathId}
                className="fs-crumb fs-crumb-current"
                aria-current="page"
                title={targetPath}
              >
                {segment}
              </span>
            ) : (
              <button
                type="button"
                className="fs-crumb"
                onClick={() => navigateToSegment(index)}
                title={`Vai a ${targetPath}`}
              >
                {segment}
              </button>
            )}
          </React.Fragment>
        );
      })}

      {segments.length === 0 && currentPathId && (
        <span id={currentPathId} className="fs-crumb fs-crumb-current" aria-current="page">
          /
        </span>
      )}
    </nav>
  );
};
