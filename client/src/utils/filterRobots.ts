import type { RobotSummaryDto } from "../types/fleet.ts";

export type RobotFilterField =
  | "tutti"
  | "cliente"
  | "impianto"
  | "nome_robot"
  | "id_robot";

/**
 * Pulisce una stringa per il matching case-insensitive e accent-insensitive:
 * trim, lowercase, rimozione dei caratteri diacritici (blocco Unicode U+0300-U+036F) e spazi multipli.
 */
export function normalizeFilterText(s?: string | null): string {
  return (s ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

/**
 * Filtra l'elenco dei robot lato client in base a una query libera e al campo selezionato (SRS §5.1).
 *
 * Requisiti soddisfatti:
 * - Case-insensitive e rimozione accenti (es. 'citta' trova 'Città').
 * - Match substring 'contiene' su customerName, plantName, displayName, id.
 * - Query vuota o con soli spazi: restituisce la lista completa inalterata.
 * - Resilienza su dati mancanti: campi undefined o null trattati con `?? ""` senza errori.
 *
 * @param robots Elenco dei robot da filtrare
 * @param query Stringa di ricerca digitata dall'utente
 * @param field Campo su cui limitare il filtro ("tutti", "cliente", "impianto", "nome_robot", "id_robot")
 * @returns Array di robot che soddisfano il criterio di ricerca
 */
export function filterRobots(
  robots: RobotSummaryDto[],
  query?: string,
  field: RobotFilterField = "tutti"
): RobotSummaryDto[] {
  if (!Array.isArray(robots)) return [];
  const trimmed = (query ?? "").trim();
  if (trimmed.length === 0) {
    return robots;
  }

  const needle = normalizeFilterText(trimmed);

  return robots.filter((robot) => {
    const fieldsToCheck: string[] = [];

    if (field === "tutti" || field === "cliente") {
      fieldsToCheck.push(robot.customerName ?? "");
    }
    if (field === "tutti" || field === "impianto") {
      fieldsToCheck.push(robot.plantName ?? "");
    }
    if (field === "tutti" || field === "nome_robot") {
      fieldsToCheck.push(robot.displayName ?? "");
    }
    if (field === "tutti" || field === "id_robot") {
      fieldsToCheck.push(robot.id ?? "");
    }

    return fieldsToCheck.some((val) => normalizeFilterText(val).includes(needle));
  });
}
