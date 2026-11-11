// Requisiti soddisfatti: RNF-MNT-001, RNF-SEC-001..009, §11, §8.1..8.4, §10.3
// Test di coerenza configurazione: zero drift tra codice e tabella DECISIONS.md, assenza riferimenti inesistenti §11.8 e §5.7

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "../..");

console.log("--> Esecuzione test suite di Coerenza della Configurazione (DECISIONS.md vs Codice)...");

// 1. Lettura e parsing della tabella parametri in DECISIONS.md
const decisionsPath = path.join(rootDir, "DECISIONS.md");
assert.ok(fs.existsSync(decisionsPath), "DECISIONS.md deve esistere");
const decisionsContent = fs.readFileSync(decisionsPath, "utf-8");

// Estrazione di tutte le righe della tabella dei parametri in DECISIONS.md
const tableRowRegex = /\|\s*`(MOLIRIS_[A-Z0-9_]+)`\s*\|\s*([^|]+)\|\s*([^|]+)\|\s*([^|]+)\|\s*([^|]+)\|\s*([^|]+)\|/g;
const decisionsVars = new Set<string>();
let match: RegExpExecArray | null;
while ((match = tableRowRegex.exec(decisionsContent)) !== null) {
  decisionsVars.add(match[1]);
}

assert.ok(decisionsVars.size >= 40, `La tabella DECISIONS.md deve contenere tutte le variabili di sistema (trovate: ${decisionsVars.size})`);
console.log(`  PASS: Tabella DECISIONS.md estratta con successo (${decisionsVars.size} variabili documentate).`);

// 2. Scansione variabili usate nel codice sorgente e in .env.example
function findMolirisVarsInFile(filePath: string): string[] {
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, "utf-8");
  const matches = content.match(/MOLIRIS_[A-Z0-9_]+/g) || [];
  return matches.filter(v => !v.includes("FILE_NOT_FOUND")); // esclude sentinelle
}

function findMolirisVarsInDir(dirPath: string): string[] {
  let results: string[] = [];
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules" && entry.name !== "backup-imports") {
      results = results.concat(findMolirisVarsInDir(fullPath));
    } else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".js") || entry.name.endsWith(".example"))) {
      results = results.concat(findMolirisVarsInFile(fullPath));
    }
  }
  return results;
}

const codeVars = new Set<string>();
const scanDirs = ["config", "backend", "storage", "scripts", "client"];
for (const dir of scanDirs) {
  const dirPath = path.join(rootDir, dir);
  if (fs.existsSync(dirPath)) {
    for (const v of findMolirisVarsInDir(dirPath)) {
      codeVars.add(v);
    }
  }
}
for (const v of findMolirisVarsInFile(path.join(rootDir, ".env.example"))) {
  codeVars.add(v);
}

// 3. Verifica: ogni variabile presente nel codice deve essere documentata nella tabella di DECISIONS.md
const missingInDecisions: string[] = [];
for (const v of codeVars) {
  if (!decisionsVars.has(v)) {
    missingInDecisions.push(v);
  }
}
assert.strictEqual(
  missingInDecisions.length,
  0,
  `Variabili presenti nel codice ma assenti nella tabella DECISIONS.md: ${missingInDecisions.join(", ")}`
);
console.log("  PASS: Zero drift codice -> DECISIONS.md: tutte le variabili usate nel codice sono presenti nella tabella.");

// 4. Verifica: ogni variabile presente in DECISIONS.md deve esistere nel codice
const unusedInCode: string[] = [];
for (const v of decisionsVars) {
  if (!codeVars.has(v)) {
    unusedInCode.push(v);
  }
}
assert.strictEqual(
  unusedInCode.length,
  0,
  `Variabili documentate in DECISIONS.md ma non presenti nel codice: ${unusedInCode.join(", ")}`
);
console.log("  PASS: Zero drift DECISIONS.md -> codice: tutte le variabili documentate sono effettivamente utilizzate.");

// 5. Verifica assenza categorica di riferimenti inesistenti §11.8 e §5.7
const traceabilityPath = path.join(rootDir, "TRACEABILITY.md");
const traceabilityContent = fs.readFileSync(traceabilityPath, "utf-8");

assert.ok(!decisionsContent.includes("§11.8") && !decisionsContent.includes("11.8"), "DECISIONS.md non deve contenere riferimenti alla sezione inesistente §11.8");
assert.ok(!decisionsContent.includes("§5.7"), "DECISIONS.md non deve contenere riferimenti alla sezione inesistente §5.7");
assert.ok(!traceabilityContent.includes("§11.8"), "TRACEABILITY.md non deve contenere riferimenti alla sezione inesistente §11.8");
assert.ok(!traceabilityContent.includes("§5.7"), "TRACEABILITY.md non deve contenere riferimenti alla sezione inesistente §5.7");

console.log("  PASS: Nessun riferimento spurio a sezioni inesistenti (§11.8 o §5.7) in DECISIONS.md e TRACEABILITY.md.");

// 6. Verifica documentazione esplicita della relazione di concorrenza 25 utenti (§11.2) vs 20 terminali (§10.3 / RNF-PERF-003)
assert.ok(
  decisionsContent.includes("25 utenti") && decisionsContent.includes("20 sessioni terminale"),
  "DECISIONS.md deve spiegare la coerenza tra il limite di 25 utenti simultanei (§11.2) e 20 sessioni terminali (§10.3 / RNF-PERF-003)"
);
console.log("  PASS: Relazione tra 25 utenti simultanei (§11.2) e 20 terminali massimi (§10.3) formalizzata ed esplicitata.");

console.log("PASS: Tutti i test di coerenza della configurazione completati con successo.");
