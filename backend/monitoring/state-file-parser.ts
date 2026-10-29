// Requisiti soddisfatti: RF-MON-002, RF-MON-005, §11.4, RNF-REL-002, CA-MON-001

export type StateParseFailureSubType = "empty" | "incomplete" | "malformed";

export type ParseResult =
  | { success: true; data: Record<string, unknown> }
  | { success: false; subType: StateParseFailureSubType; errorMessage: string };

/**
 * Interfaccia sostituibile per il parsing dei file di stato (RF-MON-002, §11.4).
 * Isola completamente la logica di decodifica dal servizio di monitoraggio.
 */
export interface StateFileParser {
  parse(content: string, filePath: string): ParseResult;
}

/**
 * Parser provvisorio di sviluppo (RF-MON-002, §11.4).
 * STATO: DA CONFERMARE (vedi STATUS_FILE_FORMAT.md e DECISIONS.md §11.4).
 * Supporta formati Key-Value (line-oriented) e JSON standard.
 * Riconosce esplicitamente i sottotipi di errore: empty, incomplete, malformed.
 */
export class ProvisionalDevelopmentStateFileParser implements StateFileParser {
  public parse(content: string, _filePath: string): ParseResult {
    // 1. Controllo file vuoto
    if (content === undefined || content === null || content.length === 0 || content.trim().length === 0) {
      return {
        success: false,
        subType: "empty",
        errorMessage: "Il file di stato è vuoto o contiene solo spazi bianchi.",
      };
    }

    const trimmed = content.trim();

    // 2. Controllo caratteri binari o null byte (malformed immediato)
    if (/[\x00-\x08\x0E-\x1F]/.test(content)) {
      return {
        success: false,
        subType: "malformed",
        errorMessage: "Il file contiene caratteri binari o caratteri di controllo non validi.",
      };
    }

    // 3. Tentativo parsing JSON se inizia con '{'
    if (trimmed.startsWith("{")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          return {
            success: false,
            subType: "malformed",
            errorMessage: "Il contenuto JSON non è un oggetto di stato valido (atteso record strutturato).",
          };
        }

        const keys = Object.keys(parsed);
        if (keys.length === 0) {
          return {
            success: false,
            subType: "incomplete",
            errorMessage: "L'oggetto JSON di stato è incompleto: nessuna proprietà presente.",
          };
        }

        return {
          success: true,
          data: parsed as Record<string, unknown>,
        };
      } catch (jsonErr: any) {
        const msg = jsonErr?.message || "";
        // Se il JSON è troncato (es. chiusura mancante) -> incomplete
        if (msg.includes("Unexpected end of JSON") || msg.includes("unterminated")) {
          return {
            success: false,
            subType: "incomplete",
            errorMessage: `Contenuto JSON troncato o incompleto: ${msg}`,
          };
        }
        return {
          success: false,
          subType: "malformed",
          errorMessage: `Sintassi JSON non valida: ${msg}`,
        };
      }
    }

    // 4. Parsing formato Key-Value (line-oriented)
    const lines = trimmed.split(/\r?\n/);
    const result: Record<string, unknown> = {};
    let validPairCount = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      // Ignora righe vuote e commenti (# o //)
      if (line.length === 0 || line.startsWith("#") || line.startsWith("//")) {
        continue;
      }

      // Separatore '=' o ':'
      const sepIndex = line.search(/[=:]/);
      if (sepIndex === -1) {
        return {
          success: false,
          subType: "malformed",
          errorMessage: `Riga ${i + 1} non interpretabile: separatore '=' o ':' assente ('${line}').`,
        };
      }

      const rawKey = line.substring(0, sepIndex).trim();
      const rawVal = line.substring(sepIndex + 1).trim();

      if (rawKey.length === 0) {
        return {
          success: false,
          subType: "malformed",
          errorMessage: `Riga ${i + 1} non valida: chiave mancante.`,
        };
      }

      if (rawVal.length === 0) {
        // Valore assente su chiave -> incomplete
        return {
          success: false,
          subType: "incomplete",
          errorMessage: `Riga ${i + 1} incompleta: valore assente per la chiave '${rawKey}'.`,
        };
      }

      // Conversione automatica tipi primitivi
      let parsedVal: unknown = rawVal;
      if (rawVal.toLowerCase() === "true" || rawVal.toLowerCase() === "yes") {
        parsedVal = true;
      } else if (rawVal.toLowerCase() === "false" || rawVal.toLowerCase() === "no") {
        parsedVal = false;
      } else if (!isNaN(Number(rawVal)) && !rawVal.startsWith("0x")) {
        parsedVal = Number(rawVal);
      }

      result[rawKey] = parsedVal;
      validPairCount++;
    }

    if (validPairCount === 0) {
      return {
        success: false,
        subType: "empty",
        errorMessage: "Nessuna riga di stato valida trovata nel file.",
      };
    }

    return {
      success: true,
      data: result,
    };
  }
}
