# Specifiche del Formato dei File di Stato dei Robot

> **STATO: FORMATO PROVVISORIO DI SVILUPPO - DA CONFERMARE (SRS v1.0 §11.4)**
> Il presente formato e le relative regole di interpretazione sono adottati a titolo puramente provvisorio per consentire lo sviluppo, il collaudo e l'integrazione del sottosistema di monitoraggio (§5.3). La specifica definitiva del formato e delle chiavi operative è lasciata aperta dalla SRS v1.0 (sezione 11.4) e dovrà essere confermata dal team firmware Moliris.

---

## 1. Principi Architetturali (SRS §5.3, §10.2, §11.4, RF-MON-002, RF-MON-005)

1. **Astrazione e Sostituibilità**: Il parsing del contenuto dei file di stato è isolato dietro l'interfaccia `StateFileParser`. L'implementazione predefinita fornita (`ProvisionalDevelopmentStateFileParser`) è completamente intercambiabile senza impattare il resto dell'applicazione.
2. **Nessun Enum Rigido Inventato**: I campi estratti dal file di stato vengono registrati come record strutturato opaco (`Record<string, unknown>`). Il backend non impone enum o macchine a stati arbitrarie non documentate nella SRS.
3. **Divieto di Deduzione di Stati da Assenza di Dati (RF-MON-005)**: L'assenza di dati (file non trovato, host irraggiungibile, errore di lettura) **non deve mai** essere interpretata come stato operativo specifico (es. non dedurre arbitrariamente "offline" o "spento" come stato operativo del robot).
4. **Separazione Rigida tra Ultimo Dato Valido ed Esito Ultimo Tentativo (RF-MON-005, CA-MON-004, RNF-REL-002)**: Il dato operativo valido precedentemente letto viene mantenuto inalterato anche in caso di fallimenti successivi; l'esito dell'ultimo tentativo e l'errore vengono registrati a parte.

---

## 2. Formati Supportati dal Parser Provvisorio

Il parser provvisorio (`ProvisionalDevelopmentStateFileParser`) supporta in modo trasparente due formati testuali standard:

### 2.1 Formato Chiave-Valore (Line-Oriented)
- Righe vuote e spazi bianchi all'inizio/fine di riga vengono ignorati.
- Righe che iniziano con `#` sono considerate commenti e ignorate.
- Ogni riga operativa ha la sintassi `chiave=valore` oppure `chiave: valore`.
- I valori numerici ("123", "45.6") vengono convertiti in numeri (`number`).
- I valori booleani ("true", "false", "yes", "no") vengono convertiti in booleani (`boolean`).
- Tutti gli altri valori rimangono stringhe (`string`).

**Esempio di file chiave-valore:**
```ini
# Stato operativo provvisorio robot
battery_level=87
battery_voltage=24.8
operation_mode=navigating
current_task=patrol_area_3
safety_stop=false
cpu_temperature=42.1
```

### 2.2 Formato JSON
- Se il contenuto del file (privo di spazi iniziali) inizia con `{`, viene parsato come oggetto JSON standard.
- Deve rappresentare un oggetto JSON (`{ ... }`), non un array né un tipo primitivo scalare.

**Esempio di file JSON:**
```json
{
  "battery_level": 87,
  "battery_voltage": 24.8,
  "operation_mode": "navigating",
  "current_task": "patrol_area_3",
  "safety_stop": false,
  "cpu_temperature": 42.1
}
```

---

## 3. Gestione e Tipizzazione delle Anomalie (SRS §9, CA-MON-001, CA-MON-004)

In caso di anomalia durante la lettura o il parsing del file di stato, il parser e il servizio di monitoraggio classificano l'errore secondo i sottotipi formali previsti:

| Sottotipo Anomalia | Descrizione | Codice Errore SRS §9 |
|---|---|---|
| `missing` | Il file di stato configurato non esiste sul filesystem remoto del robot (codice uscita comando non zero, o file non trovato). | `MON_STATE_FILE_ERROR` |
| `empty` | Il file esiste ma la sua dimensione è pari a 0 byte (nessun contenuto leggibile). | `MON_STATE_FILE_ERROR` |
| `incomplete` | Il file contiene dati incompleti, troncati o non valorizzati. | `MON_STATE_FILE_ERROR` |
| `malformed` | Il contenuto non rispetta né la sintassi JSON né la sintassi chiave-valore (dati binari, caratteri non validi). | `MON_STATE_FILE_ERROR` |
| `timeout` | La lettura remota via SSH ha superato il tempo massimo di timeout configurato. | `OPERATION_TIMEOUT` |
| `connection_error` | Connessione SSH non stabilita (host irraggiungibile, porta non disponibile, autenticazione fallita). | Rispettivo codice §9 |
| `read_error` | Errore generico di I/O remoto sul canale SSH durante l'esecuzione del comando di lettura. | `REMOTE_FS_ERROR` |

---

## 4. Modalità di Aggiornamento della Specifica

Quando il team firmware fornirà le specifiche definitive, sarà sufficiente:
1. Creare una nuova classe implementante `StateFileParser` in `backend/monitoring/`.
2. Aggiornare l'istanza iniettata in `backend/server.ts`.
3. Aggiornare il presente documento marcandolo come "DEFINITIVO" e rimuovere il flag provvisorio da `DECISIONS.md`.
