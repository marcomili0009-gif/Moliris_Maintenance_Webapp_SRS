# Registro delle Decisioni Architetturali, Parametri di Configurazione e Scelte Aperte (SRS v1.0)

Il presente registro documenta in modo esaustivo tutte le variabili di configurazione dell'applicazione, le decisioni baseline confermate dal committente, la classificazione dei requisiti aperti della Sezione 11 (isolati e configurabili, §§11.1..11.7) e l'elenco formale delle proposte introdotte durante le attività correttive per colmare lacune di sicurezza e robustezza, contrassegnate come **PROPOSTA DA CONFERMARE**.

---

## 1. Tabella Unica di Configurazione del Sistema (`MOLIRIS_*`)

Tutti i parametri di runtime del sistema sono centralizzati nelle variabili d'ambiente `MOLIRIS_*`. I parametri obbligatori operano in modalità fail-closed all'avvio dell'applicazione (`loadAndValidateConfig`); i parametri facoltativi adottano valori di default improntati alla massima sicurezza e prudenza.

| Variabile | Tipo | Valore di Riferimento / Default | Sorgente | Vincoli e Comportamento Fail-Closed | Riferimento SRS |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `MOLIRIS_FS_ROOT` | string | `/var/lib/moliris/server-fs` | Variabile d'ambiente | Obbligatoria. Percorso assoluto su filesystem locale. All'avvio in produzione (`NODE_ENV=production`), se i permessi sono più aperti di 0750 l'avvio fallisce in modalità fail-closed. | RF-SRVFS-001, RNF-MNT-001, §11.1 |
| `MOLIRIS_POLLING_INTERVAL_SEC` | number | `60` (disabilitato se `<= 0`) | Variabile d'ambiente | Obbligatoria. Intervallo in secondi per il ciclo di interrogazione telemetria flotta. Se non configurata o `<= 0`, il polling periodico non viene avviato (fail-closed, CA-MON-002). | RF-MON-003, RNF-PERF-004, §11.4 |
| `MOLIRIS_SSH_TIMEOUT_MS` | number | `10000` | Variabile d'ambiente | Obbligatoria. Timeout in millisecondi per handshake e connessioni SSH/SFTP verso i robot. Se assente o non numerico, avvio bloccato. | RF-TRF-013, RNF-MNT-001, §11.2 |
| `MOLIRIS_SSH_CONNECTION_TIMEOUT_MS` | number | `10000` | Variabile d'ambiente | Opzionale. Alias compatibile di `MOLIRIS_SSH_TIMEOUT_MS` per timeout di connessione SSH/SFTP. | RF-TRF-013, RNF-MNT-001, §11.2 |
| `MOLIRIS_MAX_TRF_PER_USER` | number | `2` | Variabile d'ambiente | Obbligatoria. Intero positivo `>= 1`. Limite di trasferimenti contemporanei per singolo utente. Al superamento scatta rifiuto immediato o coda. | RF-TRF-012, RNF-PERF-003, §11.5 |
| `MOLIRIS_MAX_TRF_PER_ROBOT` | number | `2` | Variabile d'ambiente | Obbligatoria. Intero positivo `>= 1`. Limite di trasferimenti contemporanei verso lo stesso robot. Previene sovraccarichi hardware. | RF-TRF-012, RNF-PERF-003, §11.5 |
| `MOLIRIS_MAX_TRF_SERVER` | number | `5` | Variabile d'ambiente | Obbligatoria. Intero positivo `>= 1`. Limite globale di trasferimenti contemporanei gestiti dal server. Previene esaurimento banda e I/O. | RF-TRF-012, RNF-PERF-003, §11.5 |
| `MOLIRIS_TEMP_RETENTION_MIN` | number | `60` | Variabile d'ambiente | Obbligatoria. Intero positivo `>= 1`. Periodo di ritenzione prima della bonifica dei file orfani temporanei (.tmp) sul server. | RF-TRF-009, RNF-REL-004, RNF-REL-005, §11.5 |
| `MOLIRIS_STATE_FILE_PATHS` | string | `/PERCORSO/DA/DEFINIRE/status.txt` | Variabile d'ambiente | Obbligatoria. Percorsi separati da virgola interrogati in sequenza sul robot; i percorsi del singolo robot hanno priorità di sostituzione. | RF-MON-001, §11.4 |
| `MOLIRIS_STATE_FILE_FORMAT` | enum | `"auto"` (`"json"` \| `"keyvalue"`) | Variabile d'ambiente | Opzionale. Formato del file di stato: "auto" analizza il payload; "json" o "keyvalue" forzano il parser corrispondente. | RF-MON-002, §11.4 |
| `MOLIRIS_STATE_FILE_SCHEMA` | string | `undefined` | Variabile d'ambiente | Opzionale. Percorso a schema JSON formale per validazione aggiuntiva del file di stato. | RF-MON-002, §11.4 |
| `MOLIRIS_SESSION_TIMEOUT_MIN` | number | `30` | Variabile d'ambiente | Obbligatoria. Intero positivo `>= 1`. Minuti di inattività prima della scadenza della sessione utente. | RF-AUTH-006, RNF-SEC-004, §11.6 |
| `MOLIRIS_SESSION_ABSOLUTE_MAX_MIN` | number | `undefined` | Variabile d'ambiente | Opzionale. Tetto massimo di durata assoluta della sessione indipendente dall'attività. Se configurato deve essere intero positivo. | RF-AUTH-006, §11.6 |
| `MOLIRIS_TLS_CERT_PATH` | string | `/etc/moliris/certs/server.crt` | Variabile d'ambiente | Obbligatoria. Percorso al certificato X.509 valido per terminazione TLS/HTTPS e WSS. Avvio bloccato se il file non esiste. | RNF-SEC-001, §2.4 vincolo 3, §5.1 |
| `MOLIRIS_TLS_KEY_PATH` | string | `/etc/moliris/certs/server.key` | Variabile d'ambiente | Obbligatoria. Percorso alla chiave privata TLS. Avvio bloccato se il file non esiste. Nessun segreto memorizzato in configurazione. | RNF-SEC-001, §2.4 vincolo 3, §5.1 |
| `MOLIRIS_AUDIT_RETENTION_DAYS` | number | `365` | Variabile d'ambiente | Obbligatoria. Intero positivo `>= 1`. Durata conservazione log di audit in MongoDB tramite indice TTL dinamico su `timestamp`. | §10.4, RNF-SEC-009, §11.1 |
| `MOLIRIS_REGISTRATION_MODE` | enum | `"rigorosa"` (`"differita"`) | Variabile d'ambiente | Obbligatoria. In modalità rigorosa il robot deve superare i 5 passi SSH; in differita viene registrato con stato `ssh_non_verificata`. | §8.1, §11.3, RF-ROB-006, RF-ROB-007 |
| `MOLIRIS_ROBOT_USERNAME_UNIQUENESS` | enum | `"per_host"` (`"globale"`) | Variabile d'ambiente | Opzionale. Regola di unicità account robot. "per_host" ammette stesso username su host differenti; "globale" impone unicità assoluta. | §8.2, §11.3, RF-ROB-006 |
| `MOLIRIS_CREDENTIAL_PROVIDER` | enum | `"mongo"` (`"in-memory"`) | Variabile d'ambiente | Opzionale. In ambiente di produzione (`NODE_ENV=production`) l'uso di "in-memory" è categoricamente vietato e blocca l'avvio. | RNF-SEC-002, §11.2 |
| `MOLIRIS_MASTER_KEY_FILE` | string | `/etc/moliris/master.key` | Variabile d'ambiente | Obbligatoria se provider="mongo". File contenente chiave AES-256 a 32 byte con permessi POSIX 0600 di proprietà del processo. | RNF-SEC-002, §11.2 |
| `MOLIRIS_MAX_FILE_SIZE_BYTES` | number | `undefined` | Variabile d'ambiente | Opzionale. Dimensione massima per singolo file trasferito. Se non configurato, nessun limite arbitrario imposto (supporto file >1 GB). | RF-TRF-004, §11.1, §11.5 |
| `MOLIRIS_QUOTA_PER_ROBOT_BYTES` | number | `undefined` | Variabile d'ambiente | Opzionale. Quota disco massima per la cartella di ciascun robot. Se non configurata, nessuna quota arbitraria imposta. | RF-TRF-014, §11.1, §11.5 |
| `MOLIRIS_STANDARD_SUBDIRS` | string | `"logs,configs,backups"` | Variabile d'ambiente | Opzionale. Nomi di sottodirectory standard create in modo idempotente all'atto della registrazione. Finalità da definire dal committente. | RF-ROB-009, RF-SRVFS-007, §11.1 |
| `MOLIRIS_DIR_PERMISSIONS` | string | `"0750"` | Variabile d'ambiente | Opzionale. Permessi POSIX applicati alla directory del robot e alle sottodirectory (permessi stretti, proprietario servizio). | RNF-FS-001, §11.1 |
| `MOLIRIS_ALLOWED_SSH_AUTH_METHODS` | string | `"key,password"` | Variabile d'ambiente | Opzionale. Metodi di autenticazione SSH ammessi (sottoinsieme di "key", "password"). | RF-ROB-005, §11.2 |
| `MOLIRIS_ALLOWED_DESTINATIONS` | string | `undefined` (tutte) | Variabile d'ambiente | Opzionale. Whitelist separata da virgola di subnet IP / FQDN ammessi per la registrazione dei robot (misura anti-abuso). | RNF-SEC-006, §11.2 |
| `MOLIRIS_MAX_REG_VERIFICATIONS` | number | `5` | Variabile d'ambiente | Opzionale. Limite massimo di verifiche di connessione simultanee durante le registrazioni. | RNF-SEC-006, §11.2 |
| `MOLIRIS_EXISTING_DIR_POLICY` | enum | `"accetta"` (`"rifiuta"`) | Variabile d'ambiente | Opzionale. "accetta" adotta la cartella preesistente senza cancellare file; "rifiuta" blocca la registrazione se la cartella esiste già. | RF-ROB-009, RF-SRVFS-006, §11.3 |
| `MOLIRIS_ON_DISABLE_SESSION_POLICY` | enum | `"chiudi_immediatamente"` (`"lascia_terminare"`) | Variabile d'ambiente | Opzionale. "chiudi_immediatamente" termina subito terminali e trasferimenti attivi alla disabilitazione del robot. | §8.4, §11.3 |
| `MOLIRIS_STALE_DATA_THRESHOLD_SEC` | number | `30` | Variabile d'ambiente | Opzionale. Soglia in secondi per contrassegnare i dati di stato come `isStale: true` con badge grafico `[Non più verificato]`. | RF-MON-005, RF-MON-006, §11.4 |
| `MOLIRIS_TERMINAL_SESSION_TIMEOUT_MIN` | number | `15` | Variabile d'ambiente | Opzionale. Minuti di inattività della sessione terminale remota prima della chiusura automatica. | RF-SSH-005, §6.4, §11.6 |
| `MOLIRIS_MAX_TERMINAL_SESSIONS_SERVER` | number | `20` | Variabile d'ambiente | Opzionale. Limite globale massimo di sessioni terminale contemporanee sul server (max 20 per specifica §10.3). | RNF-PERF-003, §10.3, §11.7 |
| `MOLIRIS_MAX_TERMINAL_SESSIONS_PER_USER` | number | `5` | Variabile d'ambiente | Opzionale. Limite massimo di sessioni terminale contemporanee per singolo operatore. | RNF-PERF-003, §11.7 |
| `MOLIRIS_MAX_TERMINAL_SESSIONS_PER_ROBOT` | number | `3` | Variabile d'ambiente | Opzionale. Limite massimo di sessioni terminale contemporanee verso lo stesso robot. | RNF-PERF-003, §11.7 |
| `MOLIRIS_TERMINAL_DISCONNECT_POLICY` | enum | `"chiudi_immediatamente"` | Variabile d'ambiente | Opzionale. Unico valore ammesso. L'opzione insicura "mantieni_in_background" è rimossa e blocca l'avvio in modalità fail-closed. | §6.4 passo 7, §11.6, RF-SSH-005 |
| `MOLIRIS_WS_PING_INTERVAL_MS` | number | `30000` (0 disabilita) | Variabile d'ambiente | Opzionale. Intervallo heartbeat ping/pong WebSocket per rilevamento tempestivo cadute silenziose. | RF-SSH-004, RF-SSH-005, RNF-REL-005 |
| `MOLIRIS_WS_PING_TIMEOUT_MS` | number | `10000` | Variabile d'ambiente | Opzionale. Timeout attesa pong WebSocket prima di forzare la chiusura ordinata del processo PTY e connessione SSH. | RF-SSH-004, RF-SSH-005, RNF-REL-005 |
| `MOLIRIS_REMOTE_FS_INITIAL_PATH` | string | `undefined` (realpath ".") | Variabile d'ambiente | Opzionale. Percorso iniziale di navigazione SFTP. In assenza, viene utilizzato l'home directory naturale dell'account remoto. | RF-FS-001, §11.5 |
| `MOLIRIS_REMOTE_FS_ALLOWED_PATHS` | string | `undefined` (nessun blocco) | Variabile d'ambiente | Opzionale. Percorsi consentiti separati da virgola per navigazione/download SFTP. Previene accessi a directory sensibili. | RF-FS-001, RF-FS-007, §11.5 |
| `MOLIRIS_REMOTE_FS_MAX_ENTRIES` | number | `200` | Variabile d'ambiente | Opzionale. Limite massimo di elementi restituiti per singola cartella remota. Oltre il limite, espone `isTruncated: true`. | RNF-PERF-002, §11.7 |
| `MOLIRIS_REMOTE_FS_OVERWRITE_POLICY` | enum | `"rifiuta"` (`"sovrascrivi"`) | Variabile d'ambiente | Opzionale. Politica sovrascrittura file remoto durante navigazione filesystem. | §11.5 |
| `MOLIRIS_REMOTE_FS_IDLE_TIMEOUT_MS` | number | `30000` | Variabile d'ambiente | Opzionale. Timeout in millisecondi per rilascio automatico della sessione SFTP di navigazione inattiva. | RNF-PERF-003, RNF-REL-005, §11.7 |
| `MOLIRIS_TRANSFER_CHUNK_SIZE_BYTES` | number | `2097152` (2 MB) | Variabile d'ambiente | Opzionale. Dimensione blocchi di lettura/scrittura streaming con contropressione (Heap delta costante < 3 MB su file >1 GB). | RF-TRF-004, RNF-PERF-001, §11.5 |
| `MOLIRIS_TRANSFER_CHECKSUM_ALGO` | enum | `"sha256"` (`"md5"`) | Variabile d'ambiente | Opzionale. Algoritmo di checksum per verifica di integrità. Se impostato a "md5" viene emesso avviso di sicurezza nei log all'avvio. | RF-TRF-008, §11.5 |
| `MOLIRIS_TRANSFER_OVERWRITE_POLICY` | enum | `"richiedi_conferma"` (`"rifiuta"` \| `"sovrascrivi"`) | Variabile d'ambiente | Opzionale. Se "rifiuta", impedisce tassativamente ogni overwrite; se "richiedi_conferma", richiede `overwrite: true` esplicito. | RF-TRF-011, RNF-FS-003, §11.5 |
| `MOLIRIS_TRANSFER_RESUME_ENABLED` | boolean | `false` | Variabile d'ambiente | Opzionale. Ripresa dei trasferimenti interrotti previa verifica compatibilità dimensione/offset prima della ripresa. | RF-TRF-010, §11.5 |
| `MOLIRIS_TRANSFER_CONCURRENCY_POLICY` | enum | `"rifiuta"` (`"coda"`) | Variabile d'ambiente | Opzionale. "rifiuta" restituisce immediatamente HTTP 429 con messaggio chiaro; "coda" sospende la richiesta in attesa di slot. | RF-TRF-012, §11.5 |
| `MOLIRIS_TRANSFER_IDLE_TIMEOUT_MS` | number | `60000` | Variabile d'ambiente | Opzionale. Timeout di assenza dati durante lo streaming del trasferimento prima dell'interruzione con codice di errore formale §9. | RF-TRF-013, §11.5 |
| `MOLIRIS_TRANSFER_VERIFY_MODE` | enum | `"stream"` (`"readback"`) | Variabile d'ambiente | Opzionale. "stream" calcola digest in streaming e verifica dimensione finale con stat; "readback" rilegge il file temporaneo prima del rename. | §9, RF-TRF-008, §11.5 |
| `MOLIRIS_ROBOT_NONATOMIC_REPLACE` | boolean | `false` | Variabile d'ambiente | Opzionale. In assenza di `posix-rename@openssh.com` sul robot, se `false` rifiuta per preservare il file valido preesistente; se `true` cancella e rinomina. | RNF-REL-004, RF-TRF-011 |
| `MOLIRIS_TRANSFER_SPACE_MARGIN_MB` | number | `0` | Variabile d'ambiente | Opzionale. Margine di sicurezza in MB richiesto in aggiunta alla dimensione del file per il controllo preventivo spazio (`statfs`/`statvfs`). | RF-TRF-014, §11.5 |
| `MOLIRIS_DEFAULT_SSH_PORT` | number | `22` | Variabile d'ambiente | Opzionale. Porta SSH predefinita (unica porta ammessa di default dalla SRS RF-ROB-005). | RF-ROB-005 |
| `MOLIRIS_MONGODB_URI` | string | `mongodb://127.0.0.1:27017/moliris` | Variabile d'ambiente | Opzionale. Stringa di connessione all'istanza MongoDB (collezioni robot, audit, credenziali cifrate). | §2.3 |
| `MOLIRIS_MONGO_URI` | string | `mongodb://127.0.0.1:27017/moliris` | Variabile d'ambiente | Opzionale. Alias compatibile per la stringa di connessione all'istanza MongoDB. | §2.3 |
| `MOLIRIS_DB_NAME` | string | `"moliris"` | Variabile d'ambiente | Opzionale. Nome del database MongoDB. | §2.3 |
| `MOLIRIS_SERVER_HOST` | string | `"0.0.0.0"` | Variabile d'ambiente | Opzionale. Indirizzo IP o hostname di ascolto del server HTTPS Fastify. | §5.1 |
| `MOLIRIS_SERVER_PORT` | number | `8443` | Variabile d'ambiente | Opzionale. Porta TCP di ascolto del server HTTPS Fastify. | §5.1 |
| `MOLIRIS_INITIAL_ADMIN_PASSWORD` | string | `undefined` | Variabile d'ambiente | Opzionale. Password iniziale per l'utente amministratore (utilizzata unicamente da `scripts/seed-users.ts` se non fornito file protetto). | RF-AUTH-001 |
| `MOLIRIS_INITIAL_OPERATOR_PASSWORD` | string | `undefined` | Variabile d'ambiente | Opzionale. Password iniziale per l'utente operatore (utilizzata unicamente da `scripts/seed-users.ts` se non fornito file protetto). | RF-AUTH-001 |
| `MOLIRIS_TRANSFER_POLL_INTERVAL_MS` | number | `1000` | Variabile globale browser | Opzionale. Configurazione frontend (`window.MOLIRIS_TRANSFER_POLL_INTERVAL_MS`) per la frequenza di polling dello stato dei trasferimenti attivi. | RF-TRF-006, §5.1 |
| `MOLIRIS_MAX_BULK_UPLOAD_FILES` | number | `20` | Variabile d'ambiente | Opzionale. Intero positivo `>= 1`. Limite massimo di file caricabili simultaneamente per singola richiesta massiva. | RF-TRF-001, RNF-MNT-001, RNF-PERF-003 |
| `MOLIRIS_DEFAULT_OPERATOR_ALLOWED_PATHS` | string | `"/upload,/shared,/logs,/backups"` | Variabile d'ambiente | Opzionale. Percorsi/pattern consentiti per il ruolo Operatore sul filesystem server e remoto (jail RBAC fail-closed). | RF-AUTH-005, RF-SRVFS-005, RNF-SEC-004, RNF-SEC-005 |

---

## 2. Coerenza dei Limiti di Concorrenza (§11.2, §10.3, RNF-PERF-003)

La specifica SRS v1.0 presenta due requisiti quantitativi distinti relativi alla concorrenza di carico:
1. **SRS §11.2 / Capacità Utenti**: fino a **25 utenti simultaneamente connessi** alla piattaforma web.
2. **SRS §10.3 / RNF-PERF-003**: fino a **20 sessioni terminale interattive simultanee** gestite complessivamente dal server (`MOLIRIS_MAX_TERMINAL_SESSIONS_SERVER`).

Questi due requisiti sono **pienamente coerenti e complementari**:
- La Web Application Moliris accoglie fino a 25 manutentori contemporaneamente autenticati che navigano la lista flotta, controllano lo stato di telemetria, consultano file sul filesystem server o avviano trasferimenti dati.
- L'apertura di un terminale interattivo Linux PTY comporta l'allocazione di un processo pseudoterminale, canali WebSocket bidirezionali e connessione SSH dedicata persistente: per profilo architetturale e consumo di risorse hardware, non tutti gli operatori attivi aprono una shell remota simultaneamente. Il limite server massimo di 20 sessioni PTY assicura la stabilità e la responsività del sistema entro i margini di sicurezza hardware definiti.

---

## 3. Decisioni Baseline Confermate (Immutabili)

Le scelte lasciate aperte dalla SRS (§11) sono state formalizzate nelle seguenti decisioni baseline immutabili:

1. **Modalità di Registrazione Predefinita (§8.1)**:
   - **Stato**: CONFERMATO (DECISIONE BASELINE)
   - **Decisione**: Modalità Rigorosa (`MOLIRIS_REGISTRATION_MODE="rigorosa"`): il robot deve essere raggiungibile, la porta aperta, la chiave host verificata, l'autenticazione riuscita e le risorse accessibili via SSH prima di completare la registrazione. La modalità Differita (`"differita"`) è selezionabile da configurazione e registra il robot con stato `ssh_non_verificata`.

2. **Naming Cartella Server e Unicità Username Robot (§8.2, §11.3)**:
   - **Stato**: CONFERMATO (DECISIONE BASELINE)
   - **Decisione**:
     - Naming della directory sul server: `<username>_<id>`, dove username è lo username remoto del robot e id è il suo identificativo univoco (es. `operator_amr01`, `operator_amr02`). La cartella è collocata dentro `MOLIRIS_FS_ROOT` (`/var/lib/moliris/server-fs`). L'algoritmo è incapsulato esclusivamente nella classe `StandardRobotDirectoryNamingPolicy`.
     - Ambito di unicità username: parametro `MOLIRIS_ROBOT_USERNAME_UNIQUENESS` con valore di default `"per_host"` (lo stesso account remoto può esistere su host o porte differenti). L'alternativa `"globale"` impone l'unicità in tutta la flotta.
     - Vincoli a livello storage:
       - `id`: univoco su TUTTI i record, compresi quelli in stato `rimosso`.
       - `serverDirectoryPath`: univoco su TUTTI i record, compresi quelli in stato `rimosso`.
       - Combinazione `(host, sshPort, remoteUsername)`: univoca SOLO per i robot non rimossi (`anagraphicState` in `attivo`, `disabilitato`).
     - Non-retroattività: la regola di naming si applica esclusivamente alle nuove registrazioni; a runtime ogni operazione utilizza tassativamente il percorso persistito nel record (`robot.serverDirectoryPath`), senza mai ricalcolarlo al volo.

3. **Immutabilità di Username e ID del Robot (§8.3)**:
   - **Stato**: CONFERMATO (DECISIONE BASELINE)
   - **Decisione**: Username e identificativo applicativo (`id`) sono rigorosamente immutabili dopo la registrazione. Per cambiarli occorre disabilitare/rimuovere il robot e procedere a nuova registrazione.

4. **Politica Cartella Già Esistente (§11.3, RF-ROB-009, RF-SRVFS-006)**:
   - **Stato**: CONFERMATO (DECISIONE BASELINE)
   - **Decisione**: Politica `"accetta"` (`MOLIRIS_EXISTING_DIR_POLICY="accetta"`): sempre idempotente e MAI distruttiva. I file preesistenti vengono interamente preservati.

5. **Politica Disconnessione Terminale (§6.4 passo 7, §11.6)**:
   - **Stato**: CONFERMATO (DECISIONE BASELINE)
   - **Decisione**: Unico valore ammesso: `"chiudi_immediatamente"`. L'opzione insicura `mantieni_in_background` è rimossa dal codice e blocca l'avvio in modalità fail-closed.

---

## 4. Sezione 11 – Requisiti da Definire in Fase di Progettazione (§§11.1..11.7)

### 11.1 Organizzazione del Filesystem Server
- **Percorso assoluto della root**: CONFERMATO. Requisiti: RF-SRVFS-001, RNF-MNT-001. Caricato all'avvio fail-closed tramite `MOLIRIS_FS_ROOT` (default `/var/lib/moliris/server-fs`).
- **Nomi e finalità delle sottodirectory standard**: CONFERMATO / APERTA. Requisiti: RF-ROB-009, RF-SRVFS-007, §11.1. Create in modo idempotente `logs`, `configs`, `backups` (`MOLIRIS_STANDARD_SUBDIRS`). La specifica finalità applicativa è: **DA DEFINIRE DAL COMMITTENTE** (nessuna presunzione di utilizzo nel codice).
- **Permessi di accesso alle directory**: CONFERMATO. Requisiti: RNF-FS-001, RNF-SEC-005. Permessi `0750` (`MOLIRIS_DIR_PERMISSIONS`) per root e cartelle robot. In produzione l'avvio fallisce se i permessi sono più aperti di 0750.
- **Directory temporanea riservata (.tmp)**: CONFERMATO. Requisiti: RNF-SEC-008, RF-TRF-009. Directory `.tmp` interna a ciascun robot con permessi `0700`. Esclusa dagli elenchi utente e inaccessibile da percorsi o symlink.
- **Politica di conservazione dei file**: APERTA. Requisiti: §10.3, RNF-MNT-001. Nessuna cancellazione o retention automatica dei file utente è implementata nel codice.
- **Quote per robot o per utente**: APERTA. Requisiti: RF-TRF-014, RNF-MNT-001. Supportata configurazione opzionale tramite `MOLIRIS_MAX_FILE_SIZE_BYTES` e `MOLIRIS_QUOTA_PER_ROBOT_BYTES`; nessuna quota arbitraria imposta nel codice.

### 11.2 Autenticazione SSH
- **Supporto chiavi SSH o password**: APERTA. Requisiti: RF-ROB-005, RNF-SEC-002. Astrazione `AuthenticationMaterial` e provider `CredentialProvider` configurabile via `MOLIRIS_ALLOWED_SSH_AUTH_METHODS` ("key", "password").
- **Archivio sicuro di segreti (Vault/KMS)**: CONFERMATO / CONFIGURABILE (`MOLIRIS_CREDENTIAL_PROVIDER="mongo"`). Crittografia AES-256-GCM con IV a 96 bit casuale per record, AAD vincolato a `${robotId}|${keyVersion}`, e master key protetta 0600 (`MOLIRIS_MASTER_KEY_FILE`).
- **Modalità di distribuzione e aggiornamento chiavi**: APERTA. Requisiti: RNF-SEC-002. Demandate all'archivio sicuro; il DB memorizza riferimenti sicuri opachi.
- **Politica di verifica e aggiornamento chiavi host**: CONFERMATO. Requisiti: RF-ROB-005, RNF-SEC-003, RF-ROB-014, §9. Fingerprint SHA-256 obbligatorio (`SHA256:...`). Confronto RFC 4648 case-sensitive. Errore formale `SSH_HOST_KEY_INVALID` su mismatch e audit trail.
- **Restrizioni sugli account remoti**: APERTA. Requisiti: RF-SSH-008, RF-FS-007. Sessioni SSH/SFTP confinate ai privilegi Linux dell'account configurato (nessuna elevazione automatica).
- **Misure di sicurezza e destinazioni consentite in registrazione**: APERTA. Requisiti: RNF-SEC-006, RF-ROB-006. Validazione RFC 1123 / IP, rate limiting verifiche simultanee (`MOLIRIS_MAX_REG_VERIFICATIONS`) e whitelist opzionale `MOLIRIS_ALLOWED_DESTINATIONS`.

### 11.3 Registrazione dei Robot
- **Obbligatorietà verifica SSH**: CONFERMATO. Requisiti: §8.1, RF-ROB-007. Configurazione fail-closed `MOLIRIS_REGISTRATION_MODE` ("rigorosa" default).
- **Regole unicità robot**: CONFERMATO (DECISIONE BASELINE). Directory server `<username>_<id>` univoca assoluta; ID univoco assoluto; combinazione (host, porta, username) univoca sui robot attivi/disabilitati.
- **Caratteri ammessi per lo username**: CONFERMATO (DECISIONE BASELINE). Whitelist `^[a-z_][a-z0-9_-]{1,31}$` (2-32 caratteri, minuscole, cifre, trattino e underscore).
- **Politica directory già esistente**: CONFERMATO (DECISIONE BASELINE). Politica `"accetta"`, idempotente e non distruttiva.
- **Protocollo registrazione a 2 fasi e rollback**: CONFERMATO. Requisiti: RF-ROB-007..012, RNF-FS-004. Persistenza stato preliminare con flag `directoryPreexisting`, creazione cartella e finalizzazione DB. Rollback rimuove la cartella solo se creata dall'operazione corrente e vuota.
- **Politica disabilitazione e rimozione**: CONFERMATO. Requisiti: RF-ROB-013, §8.4. Disabilitazione blocca nuove connessioni. Rimozione richiede autorizzazione `ROBOT_REMOVE` e conferma esplicita; file e cartelle su server NON vengono cancellati (RNF-FS-003).
- **Eliminazione dati sul server alla rimozione**: APERTA (NON IMPLEMENTATA). Requisiti: RF-ROB-013, §8.4 punto 2 ("se implementata"). Lasciata non implementata per prevenire cancellazioni irreversibili.

### 11.4 File di Stato
- **Percorsi dei file di testo**: APERTA. Requisiti: RF-MON-001, RNF-MNT-001. Configurabili a livello di sistema via `MOLIRIS_STATE_FILE_PATHS` e a livello di singolo robot tramite `stateFilePaths`. I percorsi specifici del robot SOSTITUISCONO la lista comune.
- **Formato e struttura dei contenuti**: APERTA. Requisiti: RF-MON-002. Parser isolato dietro interfaccia `StateFileParser`. Implementazione `ProvisionalDevelopmentStateFileParser` che supporta formati Key-Value e JSON con parametro `MOLIRIS_STATE_FILE_FORMAT` e schema opzionale `MOLIRIS_STATE_FILE_SCHEMA`.
- **Frequenza di polling**: APERTA. Requisiti: RF-MON-003, RNF-PERF-004. Configurabile tramite `MOLIRIS_POLLING_INTERVAL_SEC`. Se `<= 0`, polling periodico disattivato fail-closed (CA-MON-002) e refresh disponibile solo su richiesta manuale.
- **Regole di interpretazione degli stati**: APERTA. Requisiti: RF-MON-002, RF-MON-006. Dati estratti salvati come record opaco (`Record<string, unknown>`). Nessun enum o macchina a stati rigida cablata nel codice.
- **Gestione dati non validi o obsoleti**: APERTA. Requisiti: RF-MON-005, RNF-REL-002. Separazione netta tra ultimo dato valido (`operationalState`, `lastValidUpdateAt`) ed esito dell'ultimo ciclo (`lastAttemptOutcome` con array dettagliato `attempts`). Un fallimento non cancella l'ultimo dato valido. Se l'ultimo tentativo fallisce o l'età supera `MOLIRIS_STALE_DATA_THRESHOLD_SEC`, il dato viene marcato `isStale: true` con badge visivo `[Non più verificato]`.
- **Meccanismo di aggiornamento frontend**: APERTA. Requisiti: RF-MON-006, §5.1, §5.3. Pulsante manuale "Aggiorna Stato" e refresh all'apertura del dettaglio. Polling periodico con frequenza configurabile (`MOLIRIS_TRANSFER_POLL_INTERVAL_MS`).

### 11.5 Trasferimenti e Filesystem Remoto
- **Dimensione massima file e quote**: APERTA. Requisiti: RF-TRF-004, RF-TRF-014, §11.1, §11.5. Nessun limite rigido imposto (supporto file > 1 GB). Parametri opzionali `MOLIRIS_MAX_FILE_SIZE_BYTES` e `MOLIRIS_QUOTA_PER_ROBOT_BYTES`.
- **Numero massimo trasferimenti simultanei**: APERTA. Requisiti: RF-TRF-012, RNF-PERF-003. Parametri a 3 livelli: `MOLIRIS_MAX_TRF_PER_USER`, `MOLIRIS_MAX_TRF_PER_ROBOT`, `MOLIRIS_MAX_TRF_SERVER`.
- **Comportamento al raggiungimento del limite**: APERTA. Requisiti: RF-TRF-012, §11.5. Parametro `MOLIRIS_TRANSFER_CONCURRENCY_POLICY` ("rifiuta" default, "coda"). Rifiuto tempestivo senza blocco del thread.
- **Politica di sovrascrittura**: APERTA. Requisiti: RF-TRF-011, RNF-FS-003, §11.5. Parametro `MOLIRIS_TRANSFER_OVERWRITE_POLICY` ("rifiuta" \| "richiedi_conferma" default \| "sovrascrivi"). Rifiuto categorico anti-corsa TOCTOU verificato sia prima che al momento della promozione.
- **Percorso iniziale e restrizioni navigazione robot**: APERTA. Requisiti: RF-FS-001, RF-FS-003, §10.3, §11.5. Parametri `MOLIRIS_REMOTE_FS_INITIAL_PATH` e `MOLIRIS_REMOTE_FS_ALLOWED_PATHS`. In assenza, home directory naturale SFTP e permessi Linux dell'account configurato.
- **Gestione collegamenti simbolici e file speciali**: APERTA. Requisiti: RF-FS-002. Tipi restituiti nativi SFTP ("file", "directory", "link", "special"). Download di symlink consentito SOLO se il target è un file regolare e ricade dentro `MOLIRIS_REMOTE_FS_ALLOWED_PATHS`. Device, socket e FIFO non sono mai scaricabili. Navigazione rigorosamente in sola lettura.
- **Politica ripresa trasferimenti**: APERTA. Requisiti: RF-TRF-010. Parametro `MOLIRIS_TRANSFER_RESUME_ENABLED` (default `false`).
- **Algoritmo di checksum e integrità a due livelli**: APERTA. Requisiti: RF-TRF-008, §9. Parametro `MOLIRIS_TRANSFER_CHECKSUM_ALGO` ("sha256" default, "md5"). Integrità verificata sia durante lo streaming sorgente che con `stat` su dimensione finale prima della promozione. Modalità estesa `MOLIRIS_TRANSFER_VERIFY_MODE` ("stream" default, "readback" proposta da confermare).
- **Durata conservazione file temporanei e pulizia orfani**: APERTA. Requisiti: RF-TRF-009, RNF-REL-004, RNF-REL-005, CA-TRF-005. Parametro `MOLIRIS_TEMP_RETENTION_MIN` (default 60 min). Pulizia oraria automatica server e tentativi di bonifica remota su disconnessione (`pendingCleanups`) ritentati per 60 min.
- **Controllo preventivo spazio disco**: APERTA. Requisiti: RF-TRF-014. Controllo `fs.statfs` su server e `statvfs@openssh.com` su robot, con margine configurabile `MOLIRIS_TRANSFER_SPACE_MARGIN_MB`. Se statvfs non è supportata, skip con avviso e cattura runtime di `INSUFFICIENT_STORAGE`.
- **Dimensione blocchi e buffering**: APERTA. Requisiti: RF-TRF-004, RNF-PERF-001. Parametro `MOLIRIS_TRANSFER_CHUNK_SIZE_BYTES` (default 2 MB / 2097152 B). Streaming nativo con contropressione Node.js a memoria costante per file > 1 GB.

### 11.6 Utenti e Autorizzazioni
- **Ruoli definitivi**: APERTA. Requisiti: §2.2, RF-AUTH-005. Due categorie SRS ("operatore" e "amministratore") con mapping disaccoppiato `RolePermissionMapping`.
- **Permessi per terminale, monitoraggio e trasferimenti**: APERTA. Requisiti: RF-AUTH-005, RF-SSH-008. Supporto a permessi globali e puntuali per singolo robot.
- **Politica timeout e scadenza sessioni utente**: CONFERMATO / CONFIGURABILE. Requisiti: RF-AUTH-006, RNF-SEC-004. Parametro `MOLIRIS_SESSION_TIMEOUT_MIN` fail-closed e tetto assoluto `MOLIRIS_SESSION_ABSOLUTE_MAX_MIN`. Solo richieste operative qualificano l'aggiornamento dell'attività (il polling passivo non estende la sessione).
- **Politica timeout e chiusura sessione terminale**: CONFERMATO. Requisiti: RF-SSH-005, §6.4 passo 7. Parametro `MOLIRIS_TERMINAL_SESSION_TIMEOUT_MIN`. Rilascio a zero risorse residue per tutte le 7 cause di chiusura.
- **Condivisione sessioni terminale**: APERTA. Requisiti: RF-SSH-006, RNF-SEC-007. Politica fail-closed `DefaultDenyTerminalSessionSharingPolicy` che nega qualsiasi accesso a sessioni altrui e registra l'evento nell'audit.
- **Tecnologia canale tempo reale**: CONFERMATA. Requisiti: RF-SSH-004, §5.4. WebSocket su HTTPS (WSS) con autenticazione preliminare del cookie di sessione.
- **Libreria terminale frontend**: CONFERMATA. Requisiti: RF-SSH-003, RNF-UX-004. `@xterm/xterm` v5.3.0 e addon fit in locale offline per Google Chrome.
- **Provisioning utenti**: APERTA (PROPOSTA DA CONFERMARE). Requisiti: RF-AUTH-001, RNF-SEC-002. Script `scripts/seed-users.ts` con file password 0600 o integrazione systemd `LoadCredential=`. Zero password di default nel codice.

### 11.7 Prestazioni e Capacità
- **Numero iniziale e massimo robot**: APERTA. Requisiti: RNF-PERF-005. Architettura scalabile senza modifiche al codice.
- **Numero massimo utenti simultanei**: APERTA. Requisiti: RNF-PERF-003, §11.2. Fino a 25 utenti contemporanei.
- **Numero sessioni terminale contemporanee**: APERTA. Requisiti: RNF-PERF-003, §10.3, §11.7. Parametro `MOLIRIS_MAX_TERMINAL_SESSIONS_SERVER` (max 20), `MOLIRIS_MAX_TERMINAL_SESSIONS_PER_USER`, `MOLIRIS_MAX_TERMINAL_SESSIONS_PER_ROBOT`.
- **Limite elementi directory remota**: APERTA. Requisiti: RNF-PERF-002, §11.7. Parametro `MOLIRIS_REMOTE_FS_MAX_ENTRIES` con flag `isTruncated: true` e avviso nel frontend.
- **Strategia connessioni SFTP**: CONFERMATA. Connessioni acquisite tramite `RobotConnectionManager` con rilascio garantito nel `finally` e timeout di inattività `MOLIRIS_REMOTE_FS_IDLE_TIMEOUT_MS`.

---

## 5. Elenco Formale delle Proposte da Confermare (Manutenzione Correttiva e Hardening)

Le seguenti scelte sono state introdotte per completare in sicurezza i requisiti e colmare le lacune della specifica:

1. **`SEED_USERS_PASSWORD_FILE` e `LoadCredential=` per il Provisioning**:
   - **Stato**: PROPOSTA DA CONFERMARE
   - **Descrizione**: Lo script `scripts/seed-users.ts` richiede l'acquisizione delle password per gli utenti iniziali da un file con permessi POSIX 0600 (`stat.mode & 0o177 === 0` e appartenenza allo stesso `process.getuid()`), specificabile tramite `--password-file` o `SEED_USERS_PASSWORD_FILE`, o da integrazione systemd `LoadCredential=` (`${CREDENTIALS_DIRECTORY}`). Eliminate tutte le password hardcoded di fallback.
   - **Requisiti correlati**: RF-AUTH-001, RNF-SEC-002.

2. **Parametri di Heartbeat WebSocket Terminale**:
   - **Stato**: PROPOSTA DA CONFERMARE
   - **Descrizione**: Variabili `MOLIRIS_WS_PING_INTERVAL_MS` (default 30000ms, 0 per disabilitare) e `MOLIRIS_WS_PING_TIMEOUT_MS` (default 10000ms) per rilevare cadute silenziose del socket e chiudere tempestivamente PTY e connessione SSH a zero risorse residue.
   - **Requisiti correlati**: RF-SSH-004, RF-SSH-005, RNF-REL-005.

3. **Provider Credenziali MongoDB come Default di Sistema**:
   - **Stato**: PROPOSTA DA CONFERMARE
   - **Descrizione**: Default `MOLIRIS_CREDENTIAL_PROVIDER="mongo"`. Cifratura AES-256-GCM con IV casuale a 96 bit e AAD legato a `${robotId}|${keyVersion}`, caricando la chiave master a 256 bit da file con permessi 0600 (`MOLIRIS_MASTER_KEY_FILE`). In produzione l'uso di provider volatili in-memory blocca l'avvio fail-closed.
   - **Requisiti correlati**: RF-ROB-005, RNF-SEC-002.

4. **Rimozione Categorica Password Hardcoded nel Seed**:
   - **Stato**: PROPOSTA DA CONFERMARE
   - **Descrizione**: `scripts/seed-users.ts` fallisce con errore fatale immediato se non sono fornite credenziali sicure invece di ricadere su password di default predefinite (`operator123` / `admin123`).
   - **Requisiti correlati**: RF-AUTH-001, RNF-SEC-002.

5. **Conservazione dei Segreti Cifrati dopo Rimozione Robot**:
   - **Stato**: PROPOSTA DA CONFERMARE
   - **Descrizione**: In conformità a §8.4 ("se implementata"), la cancellazione logica del robot dall'anagrafica attiva non elimina automaticamente le credenziali archiviate nella collezione del provider credenziali, preservando la cronologia di cifratura/audit a meno di un comando esplicito di bonifica amministrativa.
   - **Requisiti correlati**: RF-ROB-013, §8.4, RNF-SEC-002.

6. **Caratteri Ammessi e Lunghezza Massima dell'Identificativo Robot (`id`)**:
   - **Stato**: PROPOSTA DA CONFERMARE
   - **Descrizione**: L'identificativo univoco del robot è validato rigorosamente con regex `^[a-z0-9-]+$` e lunghezza massima di 32 caratteri. La totale esclusione del carattere underscore `_` dall'ID garantisce l'assenza di collisioni sintattiche o combinazioni ambigue nel nome della directory server `<username>_<id>` (dove l'ultimo `_` funge in modo univoco e deterministico da separatore tra username e id).
   - **Requisiti correlati**: RF-ROB-006, RF-ROB-008, §8.2.

7. **Verifica Permessi Root Filesystem Server all'Avvio e Bit di Esecuzione**:
   - **Stato**: PROPOSTA DA CONFERMARE
   - **Descrizione**: All'avvio del server viene verificata la conformità dei permessi di `MOLIRIS_FS_ROOT` rispetto a `MOLIRIS_DIR_PERMISSIONS` (predefinito `0750`). In produzione (`NODE_ENV=production`) l'avvio fallisce in modalità fail-closed se la directory ha permessi più aperti di 0750. I bit di esecuzione sui file archiviati NON sono richiesti dalla SRS e non vengono applicati arbitrariamente.
   - **Requisiti correlati**: RNF-FS-001, RNF-SEC-005.

8. **Finalità delle Sottodirectory Standard (`logs`, `configs`, `backups`)**:
   - **Stato**: PROPOSTA DA CONFERMARE / IN ATTESA DI DEFINIZIONE
   - **Descrizione**: Le sottodirectory standard create in ciascuna cartella robot (`logs`, `configs`, `backups`) sono predisposte in modo idempotente. In conformità al §11.1 che prescrive di definire "nomi e finalità", le relative finalità rimangono esplicitamente registrate come "DA DEFINIRE DAL COMMITTENTE", evitando di assegnare ruoli applicativi arbitrari non documentati nella specifica SRS v1.0.
   - **Requisiti correlati**: RF-ROB-009, RF-SRVFS-007, §11.1.

9. **Modalità Verifica Integrità Trasferimenti (`MOLIRIS_TRANSFER_VERIFY_MODE`)**:
   - **Stato**: PROPOSTA DA CONFERMARE
   - **Descrizione**: Aggiunta della variabile `MOLIRIS_TRANSFER_VERIFY_MODE` ("stream" default baseline, "readback" proposta da confermare). In modalità "stream", viene verificato il digest in transito e la dimensione finale tramite stat prima della promozione atomica; in modalità estesa "readback", prima della promozione il server rilegge integralmente il file temporaneo tramite SFTP calcolandone il digest per confrontarlo con la sorgente.
   - **Requisiti correlati**: RF-TRF-008, §9, §11.5.

10. **File Temporaneo sul Robot nella Stessa Directory di Destinazione**:
    - **Stato**: PROPOSTA DA CONFERMARE
    - **Descrizione**: Durante i trasferimenti verso il robot, il file temporaneo viene allocato nella stessa directory del file di destinazione con nome univoco `.tmp_moliris_${transferId}.tmp`. Questa scelta garantisce che il rename/promozione finale avvenga all'interno dello stesso filesystem (stesso punto di mount), scongiurando fallimenti cross-device link (EXDEV) tipici dell'uso di `/tmp`.
    - **Requisiti correlati**: RF-TRF-009, RNF-REL-004, §11.5.

11. **Opzione Sostituzione Non Atomica sul Robot (`MOLIRIS_ROBOT_NONATOMIC_REPLACE`)**:
    - **Stato**: PROPOSTA DA CONFERMARE
    - **Descrizione**: Se un server SFTP remoto sul robot non supporta l'estensione OpenSSH `posix-rename@openssh.com` e il file di destinazione esiste già, per impostazione predefinita prudente (`MOLIRIS_ROBOT_NONATOMIC_REPLACE=false`) il trasferimento fallisce esplicitamente per non rischiare di cancellare il file valido senza garanzia di promozione. Se l'amministratore imposta esplicitamente `MOLIRIS_ROBOT_NONATOMIC_REPLACE=true`, il sistema esegue unlink preventivo e rename standard emettendo un avviso di sicurezza nei log.
    - **Requisiti correlati**: RNF-REL-004, RF-TRF-011.

12. **Margine di Sicurezza Spazio Disco (`MOLIRIS_TRANSFER_SPACE_MARGIN_MB`)**:
    - **Stato**: PROPOSTA DA CONFERMARE
    - **Descrizione**: Parametro configurabile `MOLIRIS_TRANSFER_SPACE_MARGIN_MB` (default 0 MB) che impone una riserva di spazio aggiuntiva oltre alla dimensione del file durante i controlli preventivi (`statfs` sul server e `statvfs@openssh.com` sul robot). Se il robot non supporta `statvfs`, il controllo preventivo viene saltato con avviso diagnostico e l'errore di disco pieno viene intercettato a runtime mappandolo in `INSUFFICIENT_STORAGE`.
    - **Requisiti correlati**: RF-TRF-014, §11.5.

13. **Nome File Registrato nell'Audit Log dei Trasferimenti**:
    - **Stato**: PROPOSTA DA CONFERMARE
    - **Descrizione**: L'audit log dei trasferimenti registra: identificativo utente, identificativo robot, direzione del trasferimento, timestamp, esito formale e nome del file trasferito (basename/percorso relativo). In conformità a RNF-SEC-002, nessun contenuto di file, byte trasferito o credenziale viene mai inserito nei log di audit.
    - **Requisiti correlati**: RF-TRF-001..003, RNF-SEC-009, §10.4.

14. **Intervallo Polling Trasferimenti e Flotta nel Frontend (`MOLIRIS_TRANSFER_POLL_INTERVAL_MS`)**:
    - **Stato**: PROPOSTA DA CONFERMARE
    - **Descrizione**: Il frontend interroga periodicamente lo stato dei trasferimenti attivi e della flotta. La frequenza è resa configurabile tramite `window.MOLIRIS_TRANSFER_POLL_INTERVAL_MS` (default 1000ms), disattivandosi automaticamente quando non vi sono trasferimenti in corso.
    - **Requisiti correlati**: RF-TRF-006, RF-MON-006, §5.1.

15. **Politica di Conservazione Credenziali e Chiavi Host dopo Rimozione Robot**:
    - **Stato**: PROPOSTA DA CONFERMARE
    - **Descrizione**: Alla rimozione logica del robot dall'anagrafica, i record di autenticazione cifrati rimangono archiviati nel provider con stato non agganciabile a sessioni attive, per preservare la tracciabilità delle operazioni storiche e permettere eventuali verifiche post-mortem senza perdere chiavi crittografiche.
    - **Requisiti correlati**: RF-ROB-013, §8.4, RNF-SEC-002.

16. **Spiegazione `RestartSec=5` in `moliris.service`**:
    - **Stato**: PROPOSTA DA CONFERMARE
    - **Descrizione**: La direttiva `RestartSec=5` nel file del servizio systemd rappresenta il tempo di pausa/attesa che il demone attende prima di lanciare il processo dopo un crash imprevisto, per prevenire loop di crash ad alta frequenza. Non costituisce una garanzia temporale rigida che il servizio sia pienamente operativo entro 5 secondi (il tempo effettivo dipende dall'inizializzazione del database e dal caricamento dei certificati).
    - **Requisiti correlati**: RNF-REL-005, §10.3.

17. **Eliminazione Controllata di File sul Filesystem Server (`FS_SERVER_DELETE`)**:
    - **Stato**: PROPOSTA DA CONFERMARE
    - **Descrizione**: Implementata l'operazione esplicita e controllata di eliminazione file sul Filesystem Server del robot (`DELETE /api/robots/:robotId/fs/server/file?path=...`) protetta dal permesso dedicato `AppPermission.FS_SERVER_DELETE`. In conformità a RNF-FS-003, RF-ROB-013 e §8.4, l'eliminazione è applicabile esclusivamente a singoli file regolari (escludendo directory per evitare cancellazioni massive accidentali), verifica l'isolamento della root del robot e il blocco anti-traversal, e richiede dal frontend una conferma modale esplicita da parte dell'utente prima dell'esecuzione.
    - **Requisiti correlati**: RNF-FS-003, RF-ROB-013, RF-SRVFS-005, §8.4.

18. **Protezione CSRF e Gestione Token di Autenticazione**:
    - **Stato**: CONFERMATA
    - **Descrizione**: L'architettura adotta l'autenticazione mista con cookie di sessione dotati di flag `SameSite=Strict`, `HttpOnly` e `Secure` (in HTTPS), affiancati dall'header `Authorization: Bearer <sessionId>` inviato esplicitamente dal frontend per tutte le chiamate API REST mutanti (POST, PUT, DELETE). Poiché i browser non allegano header `Authorization` personalizzati nelle richieste cross-origin involontarie (drive-by / cross-site requests), e i cookie SameSite=Strict non vengono inviati su navigazioni cross-origin, l'applicazione è intrinsecamente protetta da attacchi CSRF senza richiedere doppi token ridondanti.
    - **Requisiti correlati**: RF-AUTH-002, RF-AUTH-003, RNF-SEC-001, §6.1.

19. **Archiviazione Volatile delle Sessioni in Memoria (RNF-REL)**:
    - **Stato**: CONFERMATA
    - **Descrizione**: In stretta aderenza al requisito di affidabilità e sicurezza RNF-REL-005 e RNF-SEC-002, lo stato delle sessioni attive è mantenuto in memoria RAM (`SessionManager`) e non persistito su disco o database. In questo modo, in caso di arresto anomalo, riavvio del demone systemd o failover, nessuna credenziale temporanea, materiale crittografico effimero o socket pendente rischia di rimanere orfano su storage permanente. Gli utenti dovranno effettuare un nuovo login trasparente garantendo il fail-closed.
    - **Requisiti correlati**: RF-AUTH-003, RF-AUTH-006, RNF-REL-005, RNF-SEC-002.

20. **Accessibilità Filesystem Server con Robot nello Stato "Disabilitato" (§8.4)**:
    - **Stato**: CONFERMATA
    - **Descrizione**: In conformità alla tabella degli stati e delle funzionalità ammesse (§8.4), quando un robot si trova nello stato anagrafico "disabilitato" tutte le funzionalità operative e interattive remote verso la macchina fisica (sessioni di terminale SSH/PTY, esplorazione filesystem remoto SFTP, polling di stato e avvio trasferimenti) sono categoricamente bloccate con codice d'errore dedicato. Tuttavia, la consultazione e la visualizzazione della directory del robot residente sul server (`serverFs`, `FS_SERVER_NAVIGATE`) rimangono consentite agli utenti autorizzati per permettere l'ispezione diagnostica, l'audit dei file archiviati e la consultazione storica offline senza alcuna apertura di canali verso il robot.
    - **Requisiti correlati**: RF-ROB-013, RF-SRVFS-001..007, §8.4.
