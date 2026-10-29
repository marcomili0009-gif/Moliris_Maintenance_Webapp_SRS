# Registro delle Decisioni Architetturali e Scelte Aperte (SRS v1.0)

Il presente registro traccia le decisioni progettuali aperte, delegate alla configurazione o in attesa di definizione conforme alle regole del progetto (§11, §§8.1, 8.2).

---

## 1. Stack Tecnologico di Progetto (Step 1)
- **Stato**: CONFERMATO
- **Decisione**:
  - Backend: Node.js (TypeScript) con Fastify, `ssh2`, WebSocket (`@fastify/websocket`) e stream nativi con backpressure.
  - Database: MongoDB (documentale, come indicato esemplificativamente in SRS §2.3, isolato dietro interfaccia repository).
  - Frontend: React con TypeScript, Vite e `@xterm/xterm` per emulazione terminale in Google Chrome (§2.5).
  - Canale di comunicazione: HTTPS e WSS verso il browser; SSH v2 e SFTP v3 verso i robot.
- **Requisiti correlati**: §2.3, §2.4 (vincoli 3-5), §2.5, RF-SSH-004, RF-TRF-004/005, RNF-PERF-001..003.

---

## 2. Modalità di Registrazione Predefinita (§8.1)
- **Stato**: CONFERMATO
- **Decisione**: Modalità Rigorosa (il robot deve essere raggiungibile e verificato via SSH prima di completare la registrazione). La modalità Differita rimane selezionabile da configurazione.
- **Requisiti correlati**: §8.1, RF-ROB-006, RF-ROB-007, RF-ROB-012, CA-ROB-003.

---

## 3. Gestione Stesso Username con Host Differenti (§8.2, §11.3)
- **Stato**: APERTA
- **Decisione**: [Valore da definire: convenzione definitiva per evitare collisioni sul filesystem quando due robot hanno lo stesso username remoto su host diversi. Implementata nel codice l'interfaccia `RobotDirectoryNamingPolicy` e l'implementazione predefinita `StandardRobotDirectoryNamingPolicy` che usa lo username con validazione di unicità sul DB per bloccare assegnazioni duplicate della stessa directory].
- **Requisiti correlati**: §8.2, §11.3, RF-ROB-006, RF-ROB-008, RF-SRVFS-001, CA-ROB-006.

---

## 4. Valori Ammessi per lo Stato di Connessione (§10.2, RF-ROB-014)
- **Stato**: APERTA (in attesa di conferma dall'utente)
- **Decisione**: [Valori modellati secondo i requisiti SRS: `non_verificato` (CA-ROB-003), `raggiungibile` (RF-ROB-001), `non_raggiungibile` (RF-ROB-001), `errore` (CA-ROB-012, RF-ROB-014), `avviso` (RF-ROB-014). Da confermare se la lista deve includere ulteriori sotto-stati].
- **Requisiti correlati**: §10.2, RF-ROB-001, RF-ROB-014, CA-ROB-003, CA-ROB-012.

---

## 5. Politica di Conservazione dei Log di Audit (§10.4, §11.1)
- **Stato**: APERTA (in attesa di conferma dall'utente)
- **Decisione**: [Valore da definire: parametro reso configurabile all'avvio fail-closed tramite `MOLIRIS_AUDIT_RETENTION_DAYS` (in giorni) senza valore predefinito inventato].
- **Requisiti correlati**: §10.4, RNF-SEC-009, RNF-MNT-001, §11.1.

---

## 6. Sezione 11 – Requisiti da Definire in Fase di Progettazione

### 11.1 Organizzazione del Filesystem Server
- **Percorso assoluto della root**: APERTA. Requisiti: RF-SRVFS-001, RNF-MNT-001. Decisione: [Valore da definire: caricato obbligatoriamente all'avvio fail-closed tramite la variabile di configurazione `MOLIRIS_FS_ROOT` senza alcun default inventato].
- **Nomi e finalità delle sottodirectory standard**: APERTA. Requisiti: RF-ROB-009, RF-SRVFS-007. Decisione: [Valore da definire: rese configurabili tramite `MOLIRIS_STANDARD_SUBDIRS` con default vuoto per non creare sottodirectory non volute].
- **Permessi di accesso alle directory**: APERTA. Requisiti: RNF-FS-001, RNF-SEC-005. Decisione: [Valore da definire: parametro reso configurabile tramite `MOLIRIS_DIR_PERMISSIONS` (es. `0750` o `0700`); in assenza si applicano i permessi predefiniti del sistema operativo Ubuntu senza forzature arbitrarie].
- **Politica di conservazione dei file**: APERTA. Requisiti: §10.3, RNF-MNT-001. Decisione: [Valore da definire].
- **Eventuali quote per robot o per utente**: APERTA. Requisiti: RF-TRF-014, RNF-MNT-001. Decisione: [Valore da definire].

### 11.2 Autenticazione SSH
- **Supporto esclusivo delle chiavi SSH o anche password**: APERTA. Requisiti: RF-ROB-005, RNF-SEC-002. Decisione: [Valore da definire: implementata l'astrazione `AuthenticationMaterial` e `CredentialProvider` con supporto a entrambi i metodi ("key" e "password"), abilitabili e restringibili tramite configurazione `MOLIRIS_ALLOWED_SSH_AUTH_METHODS` senza forzare un default rigido].
- **Eventuale uso di un archivio sicuro di segreti (Vault/KMS)**: APERTA. Requisiti: RNF-SEC-002. Decisione: [Valore da definire: il recupero credenziali è isolato dietro l'interfaccia `CredentialProvider`; fornita implementazione minima iniziale `InMemoryCredentialProvider` dichiarata provvisoria per sviluppo e collaudo].
- **Modalità di distribuzione e aggiornamento delle chiavi**: APERTA. Requisiti: RNF-SEC-002. Decisione: [Valore da definire: demandate all'archivio sicuro di segreti; il database memorizza esclusivamente stringhe di riferimento sicuro URI/ID].
- **Politica di verifica e aggiornamento chiavi host**: APERTA. Requisiti: RF-ROB-005, RNF-SEC-003. Decisione: [Valore da definire: implementata interfaccia `HostKeyVerifier` con confronto deterministico su fingerprint SHA256 o file known_hosts; vietato qualunque meccanismo di bypass o accettazione automatica di chiavi sconosciute].
- **Eventuali restrizioni sugli account remoti**: APERTA. Requisiti: RF-SSH-008, RF-FS-007. Decisione: [Valore da definire: tutte le sessioni SSH e SFTP operano rigorosamente con i privilegi dell'account remoto specificato, senza alcuna elevazione automatica (no sudo)].
- **Misure di sicurezza e destinazioni consentite in registrazione**: APERTA. Requisiti: RNF-SEC-006, RF-ROB-006. Decisione: [Valore da definire: implementata autorizzazione `ROBOT_REGISTER`, validazione sintattica RFC 1123 / IP, rate limiting concorrenza e parametro opzionale `MOLIRIS_ALLOWED_DESTINATIONS` per whitelist].

### 11.3 Registrazione dei Robot
- **Obbligatorietà della verifica SSH**: APERTA. Requisiti: §8.1, RF-ROB-007. Decisione: [Valore da definire: modalità di registrazione resa obbligatoriamente configurabile all'avvio fail-closed tramite `MOLIRIS_REGISTRATION_MODE` ("rigorosa" vs "differita") senza default arbitrari; in modalità differita il robot viene registrato con stato esplicito `ssh_non_verificata` e le funzionalità che richiedono connessione sono disabilitate fino a una verifica successiva tramite operazione protetta `POST /api/robots/:robotId/verify-connection`].
- **Regole definitive per l'unicità dei robot**: APERTA. Requisiti: RF-ROB-006, §8.2. Decisione: [Valore da definire: garantita unicità categorica di identificativo univoco `id` e `remoteUsername`; la casistica "stesso username su host diverso" è isolata dietro `RobotDirectoryNamingPolicy` per impedire categoricamente che due robot condividano la medesima cartella server].
- **Politica in caso di directory già esistente**: APERTA. Requisiti: RF-ROB-009, RF-SRVFS-006, RNF-FS-004. Decisione: [Valore da definire: comportamento reso configurabile tramite `MOLIRIS_EXISTING_DIR_POLICY` ("accetta" | "rifiuta"); in entrambi i casi non viene mai sovrascritto, cancellato o svuotato alcun file preesistente].
- **Caratteri ammessi per lo username**: APERTA. Requisiti: RF-ROB-005, RNF-SEC-005. Decisione: [Valore da definire: la SRS non prescrive un set ristretto di caratteri; la sicurezza del filesystem e l'assenza di injection/traversal è garantita da `resolveRobotPath`].
- **Gestione del cambio di username**: APERTA. Requisiti: §8.3. Decisione: [Valore da definire: la SRS non definisce la semantica di ridenominazione della directory server associata; il campo username remoto è immutabile in aggiornamento configurazione].
- **Politica di disabilitazione e rimozione**: APERTA. Requisiti: RF-ROB-013, §8.4. Decisione: [Valore da definire: la disabilitazione blocca categoricamente nuove connessioni operative; il comportamento verso connessioni già aperte è configurabile tramite `MOLIRIS_ON_DISABLE_SESSION_POLICY` ("chiudi_immediatamente" | "lascia_terminare"); la rimozione dall'anagrafica attiva richiede conferma esplicita e preserva intatti directory e file sul server].
- **Eliminazione dei dati sul server**: APERTA. Requisiti: RF-ROB-013, §8.4 punto 2. Decisione: [Valore da definire: la SRS recita "se implementata"; non implementata in questo prompt come da vincoli; definito il permesso dedicato `FS_SERVER_DELETE` nel catalogo RBAC].

### 11.4 File di Stato
- **Percorsi dei file di testo**: APERTA. Requisiti: RF-MON-001, RNF-MNT-001. Decisione: [Valore da definire: resi configurabili sia a livello di intero sistema tramite `MOLIRIS_STATE_FILE_PATHS` (es. `/var/log/moliris/status.txt`), sia a livello di singolo robot tramite il campo `stateFilePaths` dell'anagrafica; la lettura dà priorità ai percorsi specifici del robot e ricade sui percorsi comuni in loro assenza].
- **Formato e struttura dei contenuti**: APERTA. Requisiti: RF-MON-002. Decisione: [Valore da definire: la logica di interpretazione è completamente isolata dietro l'interfaccia sostituibile `StateFileParser`. È fornita l'implementazione `ProvisionalDevelopmentStateFileParser` che supporta formati Key-Value (`chiave=valore` / `chiave: valore`) e JSON standard, dichiarata provvisoria e documentata in dettaglio in `STATUS_FILE_FORMAT.md` in attesa delle specifiche definitive del firmware robot].
- **Frequenza di polling**: APERTA. Requisiti: RF-MON-003, RNF-PERF-004. Decisione: [Valore da definire: resa configurabile tramite `MOLIRIS_POLLING_INTERVAL_SEC`. Se non configurata o con valore <= 0, il servizio di polling periodico non viene avviato (fail-closed, CA-MON-002) e il monitoraggio è disponibile esclusivamente su richiesta manuale].
- **Regole di interpretazione degli stati**: APERTA. Requisiti: RF-MON-002, RF-MON-006. Decisione: [Valore da definire: i dati estratti dal file di stato vengono registrati come record strutturato opaco (`Record<string, unknown>`). Nessun enum rigido o macchina a stati non documentata è imposta nel codice; l'assenza di dati non viene mai interpretata come stato operativo specifico (RF-MON-005)].
- **Gestione dei dati non validi o obsoleti**: APERTA. Requisiti: RF-MON-005, RNF-REL-002. Decisione: [Valore da definire: separazione categorica tra l'ultimo dato valido acquisito (`operationalState`, `lastValidUpdateAt`) e l'esito dell'ultimo tentativo (`lastAttemptOutcome`). Un fallimento di lettura o parsing non sovrascrive né cancella l'ultimo stato valido, ma aggiorna l'esito dell'ultimo tentativo con classificazione formale dell'anomalia (`missing`, `empty`, `incomplete`, `malformed`, `timeout`, `connection_error`, `read_error`). È supportata la soglia configurabile `MOLIRIS_STALE_DATA_THRESHOLD_SEC` che, se superata o in presenza di ultimo tentativo fallito, contrassegna il dato come `isStale: true` con badge grafico `[Non più verificato]` (RF-MON-006)].
- **Meccanismo di aggiornamento del frontend**: APERTA. Requisiti: RF-MON-006, §5.1, §5.3. Decisione: [Valore da definire: aggiornamento on-demand tramite pulsante dedicato "Aggiorna Stato" e rinfresco ad ogni apertura del modal di dettaglio; intervallo di polling lato client configurabile in `app.js` in attesa di eventuale WebSocket per telemetria push].

### 11.5 Trasferimenti e Filesystem Remoto
- **Dimensione massima dei file, se prevista**: APERTA. Requisiti: RF-TRF-004, RNF-MNT-001, §11.1. Decisione: [Valore da definire: supportata la configurazione opzionale tramite `MOLIRIS_MAX_FILE_SIZE_BYTES` e `MOLIRIS_QUOTA_PER_ROBOT_BYTES` se previste; nessun limite cablato nel codice in conformità al vincolo "se previsti"].
- **Numero massimo di trasferimenti simultanei**: APERTA. Requisiti: RF-TRF-012, RNF-PERF-003. Decisione: [Valore da definire: reso configurabile all'avvio su 3 livelli fail-closed tramite `MOLIRIS_MAX_TRF_PER_USER`, `MOLIRIS_MAX_TRF_PER_ROBOT` e `MOLIRIS_MAX_TRF_SERVER`].
- **Comportamento al raggiungimento del limite di trasferimenti simultanei**: APERTA. Requisiti: RF-TRF-012, §11.5. Decisione: [Valore da definire: reso configurabile tramite `MOLIRIS_TRANSFER_CONCURRENCY_POLICY` ("rifiuta" | "coda"); il comportamento predefinito prudente è il rifiuto tempestivo con messaggio chiaro senza bloccare il thread].
- **Politica di sovrascrittura (server e remoto)**: APERTA. Requisiti: RF-TRF-011, RNF-FS-003, §11.5. Decisione: [Valore da definire: resa configurabile tramite `MOLIRIS_TRANSFER_OVERWRITE_POLICY` ("rifiuta" | "richiedi_conferma" | "sovrascrivi"); il comportamento predefinito prudente rifiuta la sovrascrittura se non esplicitamente confermata dall'utente con `overwrite: true`].
- **Percorso iniziale e restrizioni di navigazione sul robot**: APERTA. Requisiti: RF-FS-001, RF-FS-003, §10.3, §11.5. Decisione: [Valore da definire: resi configurabili all'avvio tramite `MOLIRIS_REMOTE_FS_INITIAL_PATH` (percorso iniziale) e `MOLIRIS_REMOTE_FS_ALLOWED_PATHS` (lista percorsi ammessi); in assenza di configurazione viene impiegato il punto di partenza naturale restituito da SFTP per l'account remoto (`sftp.realpath(".")`) senza inventare una finta root: l'ambito effettivo dell'accesso è delimitato dai permessi Linux dell'account configurato (RF-FS-007)].
- **Gestione dei collegamenti simbolici e file speciali**: APERTA. Requisiti: RF-FS-002. Decisione: [Valore da definire: la SRS non menziona collegamenti simbolici né file speciali; la tipologia restituita è quella nativa del protocollo SFTP ("link", "special") senza logiche o espansioni non documentate].
- **Politica di ripresa dei trasferimenti**: APERTA. Requisiti: RF-TRF-010. Decisione: [Valore da definire: resa configurabile tramite `MOLIRIS_TRANSFER_RESUME_ENABLED` (default `false`); quando attiva richiede la preventiva verifica di compatibilità di dimensione/offset tra sorgente e file parziale prima di procedere].
- **Algoritmo di checksum (SHA256, MD5)**: APERTA. Requisiti: RF-TRF-008. Decisione: [Valore da definire: isolato dietro l'interfaccia `IChecksumAlgorithm` e reso configurabile tramite `MOLIRIS_TRANSFER_CHECKSUM_ALGO` ("sha256" | "md5"); il calcolo avviene progressivamente in transito durante lo stream a blocchi senza caricamento in RAM].
- **Durata di conservazione dei file temporanei**: APERTA. Requisiti: RF-TRF-009, RNF-REL-005. Decisione: [Valore da definire: reso configurabile tramite `MOLIRIS_TEMP_RETENTION_MIN`; rilascio ed eliminazione immediata garantita dei file temporanei in caso di errore, annullamento, timeout o chiusura sessione, con preservazione totale dei file di destinazione validi preesistenti].
- **Limiti di timeout e quote di spazio**: APERTA. Requisiti: RF-TRF-013, RF-TRF-014. Decisione: [Valore da definire: timeout di inattività configurabile tramite `MOLIRIS_TRANSFER_IDLE_TIMEOUT_MS`; controllo preventivo spazio disponibile con `fs.statfs` ove supportato e gestione runtime degli errori di disco pieno mappati in `INSUFFICIENT_STORAGE`].
- **Dimensione dei blocchi (chunk size) e buffering**: APERTA. Requisiti: RF-TRF-004, RNF-PERF-001, §11.5. Decisione: [Valore da definire: reso configurabile all'avvio tramite `MOLIRIS_TRANSFER_CHUNK_SIZE_BYTES` (default 64 KB); streaming gestito con contropressione nativa dei flussi Node.js a memoria costante indipendente dalla dimensione del file (supporto file >1 GB)].

### 11.6 Utenti e Autorizzazioni
- **Ruoli definitivi**: APERTA. Requisiti: §2.2, RF-AUTH-005. Decisione: [Valore da definire: implementate le 2 categorie logiche di §2.2 ("operatore" / Utente autorizzato e "amministratore" / Gestore flotta) con mapping configurabile `RolePermissionMapping` senza ruoli cablati rigidamente nel codice].
- **Permessi per terminale, monitoraggio e trasferimenti**: APERTA. Requisiti: RF-AUTH-005, RF-SSH-008. Decisione: [Valore da definire: modellato il catalogo tassativo dei permessi operativi previsti dalla SRS, con supporto sia a permessi globali sia a permessi associati a singoli robot (CA-SSH-005); implementato permesso specifico `TERMINAL_OPEN` verificato lato server prima dell'apertura del PTY].
- **Permessi per registrazione, modifica e rimozione robot**: APERTA. Requisiti: §2.2, §8.4. Decisione: [Valore da definire: assegnazione configurabile tramite `RolePermissionMapping` a runtime, con default assegnato al profilo amministratore].
- **Politica di timeout e scadenza delle sessioni utente**: APERTA. Requisiti: RF-AUTH-006. Decisione: [Valore da definire: parametro reso configurabile all'avvio fail-closed tramite `MOLIRIS_SESSION_TIMEOUT_MIN` (in minuti) senza alcun default inventato].
- **Politica di timeout e chiusura della sessione terminale**: APERTA. Requisiti: RF-SSH-005, §6.4 passo 7. Decisione: [Valore da definire: timeout di inattività terminale reso configurabile all'avvio tramite `MOLIRIS_TERMINAL_SESSION_TIMEOUT_MIN`. Rilascio completo e garantito a zero risorse residue per tutte le 7 cause di chiusura: esplicita utente, disconnessione client/WebSocket, idle timeout, logout/scadenza sessione utente, disconnessione robot, chiusura shell remota exit/Ctrl+D, arresto del servizio].
- **Comportamento alla disconnessione del browser**: APERTA. Requisiti: §6.4 passo 7, §11.6. Decisione: [Valore da definire: reso configurabile all'avvio tramite `MOLIRIS_TERMINAL_DISCONNECT_POLICY` ("chiudi_immediatamente" | "mantieni_in_background") con default sicuro di chiusura ordinata e rilascio immediato delle risorse; non sono state inventate logiche di persistenza o multiplexing non descritte].
- **Condivisione e supervisione delle sessioni terminale**: APERTA. Requisiti: RF-SSH-006, RNF-SEC-007. Decisione: [Valore da definire: la SRS prescrive "Un utente non può accedere alla sessione di un altro utente senza un'autorizzazione esplicita", senza definire alcun meccanismo di autorizzazione o supervisione. È implementato il punto di estensione `TerminalSessionSharingPolicy` con implementazione predefinita `DefaultDenyTerminalSessionSharingPolicy` che nega tassativamente ogni accesso a sessioni altrui e registra l'evento come violazione di sicurezza nell'audit].
- **Eventuali meccanismi amministrativi separati ed esplicitamente autorizzati**: APERTA. Requisiti: RF-SSH-008. Decisione: [Valore da definire: la SRS cita tali meccanismi senza descriverli; pertanto nessuna logica di sudo, cambio utente o scorciatoia di amministrazione automatica è implementata. Le sessioni operano tassativamente ed esclusivamente con i permessi dell'account SSH remoto configurato].
- **Tecnologia del canale bidirezionale in tempo reale**: CONFERMATA. Requisiti: RF-SSH-004, §5.4. Decisione: WebSocket su HTTPS (WSS) con autenticazione server-side preventiva tramite cookie di sessione HTTPS e verifica RBAC; implementato tramite libreria `@fastify/websocket` integrata nell'HTTPS server Fastify esistente.
- **Libreria di emulazione terminale frontend**: CONFERMATA. Requisiti: RF-SSH-003, RNF-UX-004. Decisione: `xterm.js` v5.3.0 e `xterm-addon-fit` v0.8.0, standard de facto open-source conforme a sequenze ANSI/escape, UTF-8, PTY resize e caratteri di controllo, caricata in modalità locale/offline senza dipendenze CDN esterne per compatibilità esclusiva Google Chrome.
- **Eventuali requisiti di autenticazione aggiuntiva (MFA)**: APERTA. Requisiti: RNF-SEC-002. Decisione: [Valore da definire: MFA non implementata in quanto scelta aperta; architettura pronta ad accogliere fattori aggiuntivi].
- **Meccanismo di provisioning e gestione del ciclo di vita utenti**: APERTA. Requisiti: RF-AUTH-001, RNF-SEC-002. Decisione: [Valore da definire: la SRS non descrive interfacce né API di creazione/modifica utenti; predisposto esclusivamente lo script CLI di provisioning iniziale per sviluppo e collaudo `scripts/seed-users.ts`].

### 11.7 Prestazioni e Capacità
- **Numero iniziale e massimo previsto di robot**: APERTA. Requisiti: RNF-PERF-005. Decisione: [Valore da definire].
- **Numero massimo di utenti simultanei**: APERTA. Requisiti: RNF-PERF-003. Decisione: [Valore da definire].
- **Numero di sessioni terminale contemporanee**: APERTA. Requisiti: RNF-PERF-003, §11.7. Decisione: [Valore da definire: reso configurabile su 3 livelli tramite `MOLIRIS_MAX_TERMINAL_SESSIONS_SERVER` (limite globale server), `MOLIRIS_MAX_TERMINAL_SESSIONS_PER_USER` (limite per utente) e `MOLIRIS_MAX_TERMINAL_SESSIONS_PER_ROBOT` (limite per robot); al superamento di qualunque limite viene restituito un messaggio chiaro di rifiuto temporaneo].
- **Limite elementi directory e paginazione filesystem remoto**: APERTA. Requisiti: RNF-PERF-002, §11.7. Decisione: [Valore da definire: la SRS non fissa limiti numerici alle directory con molti elementi; reso configurabile tramite `MOLIRIS_REMOTE_FS_MAX_ENTRIES` senza valori fissi inventati, con indicatore di elenco parziale/troncato se superato per evitare sovraccarichi].
- **Strategia delle connessioni SFTP per la navigazione remota**: CONFERMATA/CONFIGURABILE. Requisiti: RNF-PERF-003, RNF-REL-005. Decisione: [Acquisizione connessione gestita tramite `RobotConnectionManager` per ciascuna operazione di navigazione con rilascio immediato garantito all'uscita; supportato inoltre timeout di inattività configurabile tramite `MOLIRIS_REMOTE_FS_IDLE_TIMEOUT_MS` e rispetto rigoroso dei limiti di connessione simultanea per utente, per robot e globali].
- **Volume e frequenza dei trasferimenti**: APERTA. Requisiti: RNF-PERF-001/002. Decisione: [Valore da definire].
- **Requisiti di disponibilità e ripristino**: APERTA. Requisiti: RNF-REL-001/003. Decisione: [Valore da definire].

### 11.8 Interfaccia Utente, Compatibilità Browser e Ambiente Operativo (§2.5, §5.1, RNF-UX-001..004)
- **Browser supportati oltre a Google Chrome**: APERTA (Confermato solo Google Chrome). Requisiti: §2.5, RNF-UX-003, RNF-UX-004. Decisione: [La specifica §2.5 elenca esclusivamente "Google Chrome (ultima versione stabile)". Sebbene RNF-UX-003 menzioni genericamente "browser moderni definiti come supportati dal progetto", nessun altro browser è documentato. L'applicazione opera ed è verificata esclusivamente su Google Chrome senza richiedere componenti o plugin aggiuntivi sul client dell'utente (RNF-UX-004). L'estensione del supporto ad altri browser rimane aperta in attesa di decisione del committente].
- **Ambiente multimediale e funzioni sonore**: APERTA (Nessuna funzione audio implementata). Requisiti: §2.5. Decisione: [Il §2.5 cita "altoparlante" nella dotazione minima hardware dell'utente, ma la specifica SRS v1.0 non descrive né richiede alcuna emissione sonora, allarme acustico o feedback audio. In conformità alla regola di non inventare comportamenti, non è stata implementata alcuna funzione sonora].
- **Meccanismo di aggiornamento in tempo reale del frontend**: CONFERMATO / CONFIGURABILE. Requisiti: §5.1, RF-MON-006, RF-TRF-006, RF-SSH-004. Decisione: [Adottato canale WebSocket (WSS) per il terminale remoto PTY (RF-SSH-004); polling adattivo client a intervallo breve (1.5s) per il monitoraggio dei trasferimenti streaming attivo unicamente in presenza di trasferimenti in corso (RF-TRF-006); aggiornamento su richiesta manuale e refresh contestuale all'apertura del dettaglio per lo stato di monitoraggio della flotta (CA-MON-003), con polling di background server-side controllato da `MOLIRIS_POLLING_INTERVAL_SEC`].
- **Architettura modulare frontend e presentazione errori**: CONFERMATA. Requisiti: §5.1, §9, RNF-MNT-002, RNF-UX-002. Decisione: [Disaccoppiamento in moduli ES6 (`api-client.js`, `error-presenter.js`, `state-formatter.js`, `double-submit.js`, `app.js`). Unico livello centralizzato di traduzione errori conforme al catalogo §9 con distinzione visiva tra errori recuperabili ed errori che richiedono intervento amministrativo, ed esclusione categorica di dettagli tecnici interni o credenziali].
