// Requisiti testati: RF-MON-002, RF-MON-005, CA-MON-001, §11.4, STATUS_FILE_FORMAT.md

import assert from "assert";
import fs from "fs";
import path from "path";
import os from "os";
import { MolirisStateFileParser, ProvisionalDevelopmentStateFileParser } from "./state-file-parser.ts";

console.log("--> Esecuzione test suite MolirisStateFileParser (RF-MON-002)...");

// Test 1: Retrocompatibilità alias export
assert.strictEqual(
  MolirisStateFileParser,
  ProvisionalDevelopmentStateFileParser,
  "ProvisionalDevelopmentStateFileParser deve essere un alias identico di MolirisStateFileParser"
);

// Test 2: Modalità 'auto' con contenuto JSON valido
{
  const parser = new MolirisStateFileParser("auto");
  const jsonContent = JSON.stringify({
    battery_level: 95,
    operation_mode: "navigating",
    safety_stop: false,
    temperature: 36.5,
  });

  const res = parser.parse(jsonContent, "/var/log/status.json");
  assert.strictEqual(res.success, true);
  if (res.success) {
    assert.strictEqual(res.data.battery_level, 95);
    assert.strictEqual(res.data.operation_mode, "navigating");
    assert.strictEqual(res.data.safety_stop, false);
    assert.strictEqual(res.data.temperature, 36.5);
  }
}

// Test 3: Modalità 'auto' con contenuto Key-Value valido
{
  const parser = new MolirisStateFileParser("auto");
  const kvContent = `
    # Commento di intestazione
    battery_level=87
    operation_mode=patrol
    safety_stop=false
    active_alarm=no
    voltage=24.8
    // Altro commento
    location: zone_b
  `;

  const res = parser.parse(kvContent, "/var/log/status.kv");
  assert.strictEqual(res.success, true);
  if (res.success) {
    assert.strictEqual(res.data.battery_level, 87);
    assert.strictEqual(res.data.operation_mode, "patrol");
    assert.strictEqual(res.data.safety_stop, false);
    assert.strictEqual(res.data.active_alarm, false);
    assert.strictEqual(res.data.voltage, 24.8);
    assert.strictEqual(res.data.location, "zone_b");
  }
}

// Test 4: Modalità 'json' forzata
{
  const jsonParser = new MolirisStateFileParser("json");

  // Accetta JSON valido
  const validJson = jsonParser.parse('{"status":"ok","code":10}', "status.txt");
  assert.strictEqual(validJson.success, true);

  // Rifiuta formato key-value con errore malformed
  const invalidKv = jsonParser.parse("status=ok\ncode=10", "status.txt");
  assert.strictEqual(invalidKv.success, false);
  if (!invalidKv.success) {
    assert.strictEqual(invalidKv.subType, "malformed");
  }
}

// Test 5: Modalità 'keyvalue' forzata
{
  const kvParser = new MolirisStateFileParser("keyvalue");

  // Accetta Key-Value valido
  const validKv = kvParser.parse("status=ok\ncode=10", "status.txt");
  assert.strictEqual(validKv.success, true);

  // Rifiuta JSON con errore malformed
  const invalidJson = kvParser.parse('{"status":"ok"}', "status.txt");
  assert.strictEqual(invalidJson.success, false);
  if (!invalidJson.success) {
    assert.strictEqual(invalidJson.subType, "malformed");
  }
}

// Test 6: Gestione file vuoto e solo spazi
{
  const parser = new MolirisStateFileParser("auto");
  const resEmpty = parser.parse("", "status.txt");
  assert.strictEqual(resEmpty.success, false);
  if (!resEmpty.success) {
    assert.strictEqual(resEmpty.subType, "empty");
  }

  const resWhitespace = parser.parse("   \n\t  \r\n", "status.txt");
  assert.strictEqual(resWhitespace.success, false);
  if (!resWhitespace.success) {
    assert.strictEqual(resWhitespace.subType, "empty");
  }
}

// Test 7: Caratteri binari / null byte
{
  const parser = new MolirisStateFileParser("auto");
  const resBinary = parser.parse("status=ok\x00corrupted", "status.txt");
  assert.strictEqual(resBinary.success, false);
  if (!resBinary.success) {
    assert.strictEqual(resBinary.subType, "malformed");
  }
}

// Test 8: JSON malformato e troncato (incomplete)
{
  const parser = new MolirisStateFileParser("auto");

  // Sintassi JSON non valida
  const resMalformed = parser.parse('{"status": "ok",}', "status.json");
  assert.strictEqual(resMalformed.success, false);
  if (!resMalformed.success) {
    assert.strictEqual(resMalformed.subType, "malformed");
  }

  // JSON troncato (incomplete)
  const resTruncated = parser.parse('{"status": "ok", "battery": 90', "status.json");
  assert.strictEqual(resTruncated.success, false);
  if (!resTruncated.success) {
    assert.strictEqual(resTruncated.subType, "incomplete");
  }

  // Oggetto JSON vuoto (incomplete)
  const resEmptyObj = parser.parse("{}", "status.json");
  assert.strictEqual(resEmptyObj.success, false);
  if (!resEmptyObj.success) {
    assert.strictEqual(resEmptyObj.subType, "incomplete");
  }
}

// Test 9: Key-Value malformato e incompleto
{
  const parser = new MolirisStateFileParser("auto");

  // Separatore assente
  const resNoSep = parser.parse("riga_senza_separatore", "status.kv");
  assert.strictEqual(resNoSep.success, false);
  if (!resNoSep.success) {
    assert.strictEqual(resNoSep.subType, "malformed");
  }

  // Valore mancante
  const resNoVal = parser.parse("battery_level=", "status.kv");
  assert.strictEqual(resNoVal.success, false);
  if (!resNoVal.success) {
    assert.strictEqual(resNoVal.subType, "incomplete");
  }
}

// Test 10: Validazione schema opzionale se configurato
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "moliris-parser-test-"));
  const schemaPath = path.join(tmpDir, "schema.json");
  fs.writeFileSync(schemaPath, JSON.stringify({ required: ["battery", "mode"] }));

  try {
    const parserWithSchema = new MolirisStateFileParser("json", schemaPath);

    // Conforme allo schema
    const validSchema = parserWithSchema.parse('{"battery": 80, "mode": "idle"}', "status.json");
    assert.strictEqual(validSchema.success, true);

    // Non conforme: campo obbligatorio 'mode' mancante
    const invalidSchema = parserWithSchema.parse('{"battery": 80}', "status.json");
    assert.strictEqual(invalidSchema.success, false);
    if (!invalidSchema.success) {
      assert.strictEqual(invalidSchema.subType, "incomplete");
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

console.log("PASS: Tutti i test della suite MolirisStateFileParser superati con successo.");
