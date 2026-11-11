// Requisiti soddisfatti: RF-MON-002, RF-MON-005, §11.4, RNF-REL-002, CA-MON-001

import fs from "fs";

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
 * Supporta configurazione di formato MOLIRIS_STATE_FILE_FORMAT ("auto", "json", "keyvalue").
 * Se impostato "json" o "keyvalue", un formato differente viene classificato come "malformed" (non conforme).
 * Riconosce esplicitamente i sottotipi di errore: empty, incomplete, malformed.
 * Non cabla alcun enum o valore operativo ("operativo", "navigating", ecc.): dati trattati come record opaco.
 */
export class ProvisionalDevelopmentStateFileParser implements StateFileParser {
  private format: "auto" | "json" | "keyvalue";
  private schemaPath?: string;

  constructor(format: "auto" | "json" | "keyvalue" = "auto", schemaPath?: string) {
    this.format = format;
    this.schemaPath = schemaPath;
  }

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

    // 3. Verifica formato forzato da configurazione (Problema B1 punto c)
    if (this.format === "json" && !trimmed.startsWith("{")) {
      return {
        success: false,
        subType: "malformed",
        errorMessage: "Contenuto non conforme: atteso formato JSON configurato (MOLIRIS_STATE_FILE_FORMAT=json).",
      };
    }

    if (this.format === "keyvalue" && trimmed.startsWith("{")) {
      return {
        success: false,
        subType: "malformed",
        errorMessage: "Contenuto non conforme: atteso formato Key-Value configurato (MOLIRIS_STATE_FILE_FORMAT=keyvalue).",
      };
    }

    // 4. Parsing formato JSON
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

        // Validazione schema facoltativo se configurato (Problema B1)
        if (this.schemaPath && fs.existsSync(this.schemaPath)) {
          try {
            const schemaContent = fs.readFileSync(this.schemaPath, "utf-8");
            const schema = JSON.parse(schemaContent);
            if (schema && typeof schema === "object" && schema.required && Array.isArray(schema.required)) {
              for (const reqField of schema.required) {
                if (!(reqField in parsed)) {
                  return {
                    success: false,
                    subType: "incomplete",
                    errorMessage: `Contenuto JSON non conforme allo schema configurato: campo obbligatorio '${reqField}' mancante.`,
                  };
                }
              }
            }
          } catch (schemaErr: any) {
            return {
              success: false,
              subType: "malformed",
              errorMessage: `Errore validazione schema file di stato: ${schemaErr.message}`,
            };
          }
        }

        return {
          success: true,
          data: parsed as Record<string, unknown>,
        };
      } catch (jsonErr: any) {
        const msg = jsonErr?.message || "";
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

    // 5. Parsing formato Key-Value (line-oriented)
    const lines = trimmed.split(/\r?\n/);
    const result: Record<string, unknown> = {};
    let validPairCount = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      if (line.length === 0 || line.startsWith("#") || line.startsWith("//")) {
        continue;
      }

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
        return {
          success: false,
          subType: "incomplete",
          errorMessage: `Riga ${i + 1} incompleta: valore assente per la chiave '${rawKey}'.`,
        };
      }

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
