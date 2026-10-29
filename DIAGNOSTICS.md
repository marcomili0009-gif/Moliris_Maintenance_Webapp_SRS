# Manuale di Diagnostica, Logging e Gestione degli Errori

Il presente documento descrive l'architettura diagnostica, il sistema di audit trail e la classificazione degli errori di **Moliris Maintenance Webapp**, conforme a **SRS v1.0 §9, §10.4, RNF-SEC-002, RNF-SEC-009, RNF-MNT-003**.

---

## 1. Modello di Logging Applicativo e Redazione Segreti (RNF-SEC-002)

Il logger dell'applicazione (`logging/logger.ts`) produce output strutturato in formato JSON su `stdout`/`stderr` (catturato automaticamente da `systemd-journald`):

```json
{
  "level": "INFO|WARN|ERROR",
  "timestamp": "2026-10-29T15:00:00.000Z",
  "message": "Descrizione dell'evento",
  "diagnosticDetail": "Dettaglio per l'amministratore",
  "meta": { "robotId": "robot_01", "userId": "admin" }
}
```

### Regole di Redazione Automatica dei Segreti
Ogni messaggio, eccezione e metadato transita attraverso il filtro `redactSensitiveData(...)`:
1. **Password**: qualsiasi campo denominato `password`, `passphrase`, `token`, `secret` viene automaticamente sostituito con `"[REDACTED]"`.
2. **Chiavi Private OpenSSH / RSA**: qualsiasi blocco contenente header crittografici (`-----BEGIN ... PRIVATE KEY-----`) viene troncato e redatto con `"[REDACTED_PRIVATE_KEY]"`.
3. **Cookie e Sessioni**: token di sessione e cookie `moliris_session` sono esclusi dai messaggi diagnostici visibili all'utente.

---

## 2. Audit Trail e Tracciamento delle Operazioni (§10.4, RNF-SEC-009)

Tutte le operazioni rilevanti sono registrate in modo immutabile nella collezione di audit (MongoDB o memoria) con la struttura:
- `timestamp`: data e ora ISO 8601 dell'operazione.
- `userId`: identificativo dell'utente esecutore (o `"anonymous"`).
- `operation`: tipologia formale dell'operazione (`AuditOperation`).
- `robotId`: robot target (se applicabile).
- `outcome`: esito (`"SUCCESS"` | `"FAILURE"`).
- `details`: record strutturato opaco contenente i parametri dell'operazione con tutti i segreti redatti.

### Catalogo Operazioni Tracciate (`AuditOperation`)
- `LOGIN_SUCCESS` / `LOGIN_FAILURE`: tentativi di accesso.
- `USER_LOGOUT`: chiusura esplicita sessione.
- `USER_SESSION_EXPIRED`: scadenza temporale per inattività.
- `ROBOT_REGISTRATION`: registrazione nuovo dispositivo.
- `ROBOT_CONFIG_UPDATE`: modifica parametri o indirizzi del robot.
- `ROBOT_DISABLE` / `ROBOT_ENABLE`: cambio stato anagrafico.
- `ROBOT_REMOVE`: eliminazione dall'anagrafica attiva.
- `STATUS_REFRESH_MANUAL`: refresh telemetria su richiesta.
- `TERMINAL_OPEN` / `TERMINAL_CLOSE`: apertura/chiusura sessione interattiva PTY.
- `FS_REMOTE_NAVIGATE`: elencazione directory remota SFTP.
- `FILE_TRANSFER_START` / `FILE_TRANSFER_COMPLETE` / `FILE_TRANSFER_CANCEL` / `FILE_TRANSFER_FAIL`: ciclo di vita trasferimenti.
- `SECURITY_AUTHORIZATION_ERROR` / `SECURITY_PATH_TRAVERSAL`: violazioni o anomalie di sicurezza.

### Politica di Conservazione (Purging)
I record di audit più vecchi di `MOLIRIS_AUDIT_RETENTION_DAYS` (default 90 giorni) vengono epurati periodicamente tramite `auditRepo.purgeOlderThanDays(...)`.

---

## 3. Catalogo degli Errori e Classificazione di Severità (§9)

In conformità al capitolo 9 della SRS, tutti gli errori applicativi sono catalogati con codice univoco, messaggio utente sicuro (senza informazioni tecniche interne) e classificazione di severità:

| Codice Errore | Messaggio Utente Sicuro | Classificazione | Causa Tipica e Azione di Recupero |
| :--- | :--- | :--- | :--- |
| `AUTH_INVALID_CREDENTIALS` | Credenziali di accesso non valide. | `recuperabile` | Username o password errati. Ripetere il login. |
| `AUTH_INSUFFICIENT_PERMISSIONS` | Operazione non consentita: autorizzazioni insufficienti. | `recuperabile` | Profilo utente non abilitato all'azione richiesta per il robot. |
| `ROBOT_PARAMS_INVALID` | Parametri del robot mancanti o non conformi. | `recuperabile` | Errore formattazione campi. Correggere i dati evidenziati. |
| `NET_HOST_UNREACHABLE` | Dispositivo remoto non raggiungibile. Verificare lo stato di rete e la connessione. | `recuperabile` | Robot spento o problemi di routing/VPN. Verificare connettività fisica. |
| `NET_PORT_UNAVAILABLE` | Servizio di connessione remota non disponibile sulla porta specificata. | `recuperabile` | Daemon SSH non in ascolto sulla porta indicata. Verificare `sshd`. |
| `SSH_AUTH_FAILED` | Autenticazione SSH verso il robot non riuscita. Verificare credenziali o chiave. | `recuperabile` | Chiave privata o password remota errata o rifiutata dal robot. |
| `SSH_HOST_KEY_INVALID` | Chiave host del robot non valida o non riconosciuta. | `richiede_intervento_amministrativo` | Possibile violazione di sicurezza o cambio host key senza aggiornamento. |
| `MON_STATE_FILE_ERROR` | File di stato non disponibile o formato non interpretabile. | `recuperabile` | File mancante o corrotto. L'ultimo stato valido è preservato. |
| `TERM_SESSION_ERROR` | Errore durante l'apertura o la gestione della sessione di terminale. | `recuperabile` | Connessione interrotta o limite concorrenza raggiunto. Riaprire terminale. |
| `REMOTE_FS_IO_ERROR` | Errore di lettura o scrittura sul filesystem remoto del robot. | `recuperabile` | File inesistente o permessi insufficienti sul robot. |
| `SERVER_DIR_INACCESSIBLE` | Accesso alla cartella del robot sul server non riuscito o sovrascrittura vietata. | `richiede_intervento_amministrativo` | Permessi disco server errati o sovrascrittura non autorizzata. |
| `STORAGE_INSUFFICIENT_SPACE` | Spazio su disco insufficiente per completare l'operazione. | `richiede_intervento_amministrativo` | Disco server o disco robot pieno. Liberare spazio. |
| `TRF_TRANSFER_INTERRUPTED` | Trasferimento file interrotto prima del completamento. | `recuperabile` | Caduta di rete o cancellazione. Il file parziale è eliminato. |
| `OPERATION_TIMEOUT` | Operazione interrotta per superamento del tempo massimo consentito. | `recuperabile` | Rete lenta o host non responsivo. Ripetere l'operazione. |
| `TRF_INTEGRITY_FAILED` | Verifica di integrità del file trasferito fallita. | `recuperabile` | Checksum non corrispondente. Il file corrotto è scartato. |
| `DB_PERSISTENCE_ERROR` | Errore durante il salvataggio dei dati applicativi. | `richiede_intervento_amministrativo` | Fallimento di scrittura su MongoDB. Verificare lo stato del DB. |
| `DB_FS_SYNC_ERROR` | Incoerenza tra database e filesystem rilevata. | `richiede_intervento_amministrativo` | Directory creata ma registrazione DB fallita (CA-ROB-008). |

---

## 4. Guida al Troubleshooting Rapido

### Scenario 1: Un robot compare con stato "ssh_non_verificata"
- **Diagnosi**: Il robot è stato registrato in modalità differita mentre era offline (§8.1, CA-ROB-003).
- **Risoluzione**: Quando il robot torna in rete, un amministratore accede alla scheda del robot e clicca **"Ripeti verifica connessione"** (`POST /api/robots/:robotId/verify-connection`). Al superamento del controllo a 5 passi, lo stato di registrazione passa a `registrazione_completata` e le funzionalità operative si sbloccano.

### Scenario 2: Il dato di telemetria è contrassegnato con badge "[Non più verificato]"
- **Diagnosi**: Il robot non risponde al polling oppure il file di stato non è leggibile da oltre `MOLIRIS_STALE_DATA_THRESHOLD_SEC` secondi (§10.2, RF-MON-006). L'ultimo dato valido acquisito è preservato intatto (CA-MON-004).
- **Risoluzione**: Cliccare sul pulsante **"Aggiorna Stato"** per forzare una lettura manuale on-demand e consultare il dettaglio dell'anomalia visualizzato nel pannello.

### Scenario 3: Il trasferimento di un file fallisce con "Spazio su disco insufficiente"
- **Diagnosi**: La partizione del filesystem server o del robot non dispone dei byte necessari (`STORAGE_INSUFFICIENT_SPACE`, CA-TRF-006).
- **Risoluzione**: Verificare lo spazio disponibile tramite `df -h /var/lib/moliris/server-fs` sul server o tramite terminale PTY sul robot.
