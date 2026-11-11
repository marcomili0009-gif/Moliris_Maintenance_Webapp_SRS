# Specifiche del Formato dei File di Stato dei Robot

> [!WARNING]
> **ESEMPIO ILLUSTRATIVO — DA CONFERMARE (SRS v1.0 §11.4)**
> Il presente formato, i percorsi e le relative regole di interpretazione sono adottati a titolo di **ESEMPIO ILLUSTRATIVO — DA CONFERMARE** per consentire lo sviluppo, il collaudo e l'integrazione del sottosistema di monitoraggio (§5.3). La specifica definitiva del formato, dei percorsi e delle chiavi operative è lasciata aperta dalla SRS v1.0 (sezione 11.4) e dovrà essere confermata dal team firmware Moliris.
> **Nessun enum di stato operativo è cablato nel codice**: i dati operativi sono gestiti come struttura opaca `Record<string, unknown>`.

---

## 1. Principi Architetturali (SRS §5.3, §10.2, §11.4, RF-MON-002, RF-MON-005)

1. **Astrazione e Sostituibilità**: Il parsing del contenuto dei file di stato è isolato dietro l'interfaccia `StateFileParser`. L'implementazione configurabile (`ProvisionalDevelopmentStateFileParser`) è gestita tramite parametri di configurazione ed è completamente intercambiabile senza impattare il resto dell'applicazione.
2. **Nessun Enum Rigido Cablato**: I campi estratti dal file di stato vengono registrati come record strutturato opaco (`Record<string, unknown>`). Il backend non impone enum o macchine a stati arbitrarie non documentate nella SRS.
3. **Divieto di Deduzione di Stati da Assenza di Dati (RF-MON-005)**: L'assenza di dati (file non trovato, host irraggiungibile, errore di lettura) **non deve mai** essere interpretata come stato operativo specifico (es. non dedurre arbitrariamente "offline" o "spento" come stato operativo del robot).
4. **Separazione Rigida tra Ultimo Dato Valido ed Esito Ultimo Tentativo (RF-MON-005, CA-MON-004, RNF-REL-002)**: Il dato operativo valido precedentemente letto viene mantenuto inalterato anche in caso di fallimenti successivi; l'esito dell'ultimo tentativo e l'errore vengono registrati a parte (`lastAttemptOutcome`).
5. **Percorsi del Robot**: Se un robot ha percorsi di stato configurati specificamente nella sua anagrafica (`stateFilePaths`), questi **SOSTITUISCONO** interamente la lista comune globale. La lettura avviene in sequenza finché uno dei file non viene letto E interpretato con successo.

---

## 2. Configurazione del Formato e Schema (Problema B1)

Il formato di parsing e la validazione sono governati da variabili d'ambiente:

| Variabile | Valori Ammessi | Default | Descrizione |
|---|---|---|---|
| `MOLIRIS_STATE_FILE_FORMAT` | `auto`, `json`, `keyvalue` | `auto` | Formato atteso per il file di stato. Con `auto` il parser rileva automaticamente la sintassi; con `json` o `keyvalue` impone il formato e scarta contenuti non conformi come `malformed`. |
| `MOLIRIS_STATE_FILE_SCHEMA` | Percorso a file JSON Schema | _non definito_ | Percorso opzionale sul server a uno schema JSON per la validazione della struttura dei dati operativi. |
| `MOLIRIS_STATE_FILE_PATHS` | Lista separata da virgola | `/PERCORSO/DA/DEFINIRE/stato_robot.json,/PERCORSO/DA/DEFINIRE/status.kv` | Percorsi candidati comuni sul filesystem del robot. |

---

## 3. Formati Supportati dal Parser Provvisorio

### 3.1 Formato Chiave-Valore (Line-Oriented)
- Righe vuote e spazi bianchi all'inizio/fine di riga vengono ignorati.
- Righe che iniziano con `#` sono considerate commenti e ignorate.
- Ogni riga operativa ha la sintassi `chiave=valore` oppure `chiave: valore`.
- I valori numerici ("123", "45.6") vengono convertiti in numeri (`number`).
- I valori booleani ("true", "false", "yes", "no") vengono convertiti in booleani (`boolean`).
- Tutti gli altri valori rimangono stringhe (`string`).

**Esempio illustrativo di file chiave-valore (ESEMPIO ILLUSTRATIVO — DA CONFERMARE):**
```ini
# ESEMPIO ILLUSTRATIVO — DA CONFERMARE (percorso tipo: /PERCORSO/DA/DEFINIRE/status.kv)
battery_level=87
battery_voltage=24.8
operation_mode=navigating
current_task=patrol_area_3
safety_stop=false
cpu_temperature=42.1
```

### 3.2 Formato JSON
- Se il contenuto del file (privo di spazi iniziali) inizia con `{`, viene parsato come oggetto JSON standard.
- Deve rappresentare un oggetto JSON (`{ ... }`), non un array né un tipo primitivo scalare.

**Esempio illustrativo di file JSON (ESEMPIO ILLUSTRATIVO — DA CONFERMARE):**
```json
{
  "_comment": "ESEMPIO ILLUSTRATIVO — DA CONFERMARE (percorso tipo: /PERCORSO/DA/DEFINIRE/stato_robot.json)",
  "battery_level": 87,
  "battery_voltage": 24.8,
  "operation_mode": "navigating",
  "current_task": "patrol_area_3",
  "safety_stop": false,
  "cpu_temperature": 42.1
}
```

---

## 4. Gestione e Tipizzazione delle Anomalie (SRS §9, CA-MON-001, CA-MON-004)

In caso di anomalia durante la lettura o il parsing del file di stato, il parser e il servizio di monitoraggio registrano ogni singolo tentativo nella cronologia `attempts` di `lastAttemptOutcome` e classificano l'errore:

| Sottotipo Anomalia | Descrizione | Codice Errore SRS §9 |
|---|---|---|
| `missing` | Il file di stato non esiste sul filesystem remoto del robot (nessun file trovato nel percorso tentato). | `MON_STATE_FILE_ERROR` |
| `empty` | Il file esiste ma la sua dimensione è pari a 0 byte (nessun contenuto leggibile). | `MON_STATE_FILE_ERROR` |
| `incomplete` | Il file contiene dati incompleti, troncati o non valorizzati. | `MON_STATE_FILE_ERROR` |
| `malformed` | Il contenuto non rispetta la sintassi JSON né chiave-valore, o non rispetta `MOLIRIS_STATE_FILE_FORMAT` o lo schema configurato. | `MON_STATE_FILE_ERROR` |
| `timeout` | La lettura remota via SSH ha superato il tempo massimo di timeout configurato. | `OPERATION_TIMEOUT` |
| `connection_error` | Connessione SSH non stabilita (host irraggiungibile, porta non disponibile, autenticazione fallita). | Rispettivo codice §9 |
| `read_error` | Errore generico di I/O remoto sul canale SSH/SFTP durante la lettura del file. | `REMOTE_FS_ERROR` |

Se nessun file candidato è letto E interpretato con successo, viene restituito l'errore diagnostico `"file di stato assente o non interpretabile"`, preservando inalterato l'ultimo dato operativo valido precedentemente memorizzato.
