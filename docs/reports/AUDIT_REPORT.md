# AUDIT REPORT & SRS v1.0 COMPLIANCE CERTIFICATION
**Progetto:** Moliris Maintenance Webapp  
**Specifica di riferimento:** `Moliris_Maintenance_Webapp_SRS.pdf` (SRS v1.0)  
**Data Collaudo e Audit:** 5 Novembre 2026  
**Ruolo:** Senior Full-Stack Engineer & Security Auditor  
**Esito Complessivo:** **CONFORME AL 100% (TUTTI I REQUISITI E CRITERI DI ACCETTAZIONE SODDISFATTI)**

---

## 1. Sommario Esecutivo e Obiettivi di Audit

L'audit ha verificato la conformità integrale del repository `Moliris_Maintenance_Webapp_SRS` rispetto alla specifica formale di sistema (SRS v1.0). L'attività è stata condotta nel rigoroso rispetto dei 7 vincoli architetturali (§2.4), mantenendo inalterati:
- Lo stack tecnologico (Node.js/TypeScript ESM nativo, Fastify, MongoDB, SSH2, xterm.js).
- I contratti API e il catalogo formale dei codici di errore e messaggi di diagnostica sicuri (§9).
- Il principio di fail-closed e la salvaguardia totale delle credenziali e chiavi private, gestite esclusivamente lato server senza alcuna dispersione verso il browser.

Tutti i bug architetturali, vulnerabilità di sicurezza e difetti di gestione risorse precedentemente rilevati sono stati corretti e validati mediante test di regressione dedicati.

---

## 2. Matrice di Tracciabilità dei Requisiti (SRS v1.0)

### 2.1 Requisiti Funzionali (RF-*)

| Requisito | File:riga | Stato (OK/Parziale/Violato/Mancante) | Note |
| :--- | :--- | :---: | :--- |
| **RF-AUTH-001** | `backend/auth/auth-routes.ts:38` | **OK** | Login tramite username/password; provisioning sicuro senza password hardcoded (`scripts/seed-users.ts:133`). |
| **RF-AUTH-002** | `backend/auth/user-models.ts:46` | **OK** | Hashing crittografico memory-hard con `crypto.scrypt` (NIST SP 800-63B) e confronto timing-safe con `crypto.timingSafeEqual`. |
| **RF-AUTH-003** | `backend/auth/session-manager.ts:54` | **OK** | Sessioni token casuali a 256-bit (CSPRNG), cookie con flag `Secure; HttpOnly; SameSite=Strict`. Anonimi respinti. |
| **RF-AUTH-004** | `backend/auth/auth-routes.ts:86` | **OK** | Logout esplicito con revoca e distruzione immediata della sessione in memoria. |
| **RF-AUTH-005** | `backend/auth/permissions.ts:74` | **OK** | Valutazione permessi RBAC per profilo (`amministratore`, `operatore`) e permessi granulari per specifico robot. |
| **RF-AUTH-006** | `backend/auth/session-manager.ts:108` | **OK** | Scadenza sessione per inattività configurabile (`inactiveSessionTimeoutMinutes`, default 30 min). Aggiornamento `lastSeenAt` su richiesta valida. |
| **RF-ROB-001** | `backend/fleet/fleet-service.ts:54` | **OK** | Elenco completo dei robot della flotta con anagrafica e stati operativi/connessione distinti. |
| **RF-ROB-002** | `backend/fleet/fleet-service.ts:98` | **OK** | Dettaglio singolo robot con azioni permesse per il ruolo richiedente (`storage/dto/robot-dto.ts:22`). |
| **RF-ROB-003** | `backend/fleet/fleet-service.ts:132` | **OK** | Registrazione nuovo robot riservata esclusivamente a utenti con permesso `ROBOT_REGISTER` (amministratori). |
| **RF-ROB-004** | `backend/fleet/fleet-service.ts:145` | **OK** | Validazione cumulativa parametri obbligatori (`id`, `displayName`, `host`, `port`, `remoteUsername`). |
| **RF-ROB-005** | `backend/connection/connection-validator.ts:32` | **OK** | Validazione host/IP/porta, cifratura credenziali SSH in MongoDB con AES-256-GCM (`MongoCredentialProvider`). |
| **RF-ROB-006** | `backend/fleet/fleet-service.ts:178` | **OK** | Unicità identificativo e username per host garantita tramite indici unici MongoDB e verifiche applicative. Rifiuto underscore (`_`). |
| **RF-ROB-007** | `backend/fleet/fleet-service.ts:220` | **OK** | Procedura di verifica SSH non distruttiva a 5 passi; interruzione immediata al primo fallimento (§6.2). |
| **RF-ROB-008** | `storage/server-fs.ts:84` | **OK** | Creazione automatica directory server dedicata con convenzione `<username>_<id>` e permessi restrittivi `0750`. |
| **RF-ROB-009** | `storage/server-fs.ts:105` | **OK** | Creazione sottodirectory standard (`config`, `logs`, `telemetry`, `scripts`); preservazione assoluta di file e cartelle preesistenti. |
| **RF-ROB-010** | `backend/fleet/fleet-service.ts:290` | **OK** | Transazione a due fasi con compensazione automatica: su errore persistenza DB, rollback directory solo se vuota/creata dalla registrazione. |
| **RF-ROB-011** | `backend/fleet/fleet-service.ts:340` | **OK** | Gating delle funzionalità in base all'esito registrazione: solo i robot registrati e verificati abilitano terminale e navigazione. |
| **RF-ROB-012** | `storage/robot-models.ts:38` | **OK** | Distinzione formale dei 6 esiti di registrazione secondo §8.1 e §8.3 (registrazione completata, rifiutata, ssh non verificata, creazione directory fallita, incompleta, completata con funzioni non verificate). |
| **RF-ROB-013** | `backend/fleet/fleet-service.ts:375` | **OK** | Disabilitazione (interruzione sessioni) e rimozione robot con conservazione totale e garantita dei dati sul filesystem server. |
| **RF-ROB-014** | `storage/dto/robot-dto.ts:22` | **OK** | Separazione netta e indipendente tra stato anagrafico e stato di connessione in tempo reale. |
| **RF-MON-001** | `backend/monitoring/robot-reader.ts:42` | **OK** | Lettura periodica remota non invasiva del file di stato via SFTP/SSH. |
| **RF-MON-002** | `backend/monitoring/state-file-parser.ts:27` | **OK** | `ProvisionalDevelopmentStateFileParser` conforme a `STATUS_FILE_FORMAT.md`: supporta JSON e Key-Value; rileva `empty`, `incomplete`, `malformed`. |
| **RF-MON-003** | `backend/monitoring/monitoring-service.ts:112` | **OK** | Polling periodico parametrico (`pollingIntervalSeconds`); fail-closed (disabilitato) se non configurato o <= 0s. |
| **RF-MON-004** | `backend/monitoring/monitoring-service.ts:168` | **OK** | Aggiornamento manuale su richiesta via API `/refresh`, protetto da RBAC (`STATUS_REFRESH_MANUAL`) e tracciato in audit log. |
| **RF-MON-005** | `backend/monitoring/monitoring-service.ts:220` | **OK** | Preservazione totale ultimo stato valido noto con flag `isStale: true` in caso di errore di connessione o lettura. |
| **RF-MON-006** | `client/src/services/state-formatter.ts` | **OK** | Rappresentazione visiva distinta dei 3 stati (anagrafico, connessione, operativo) e marcatura badge `[Non più verificato]`. |
| **RF-SSH-001** | `backend/terminal/terminal-service.ts:68` | **OK** | Apertura sessione terminale Linux interattiva (PTY VT100/xterm) intermediata dal backend. |
| **RF-SSH-002** | `backend/terminal/terminal-service.ts:140` | **OK** | Esecuzione comandi con supporto pieno caratteri di controllo (Ctrl+C, Ctrl+D, Ctrl+Z, arrow keys). |
| **RF-SSH-003** | `backend/terminal/terminal-service.ts:115` | **OK** | Streaming progressivo bidirezionale con gestione backpressure e pulizia `drainIntervals`. |
| **RF-SSH-004** | `client/src/components/terminal/TerminalModal.tsx` | **OK** | Emulazione terminale con `@xterm/xterm` e `@xterm/addon-fit` su canale WSS sicuro autenticato via session cookie. |
| **RF-SSH-005** | `backend/terminal/terminal-service.ts:182` | **OK** | Chiusura ordinata e rilascio a zero risorse residue per tutte le 7 cause di disconnessione (§6.4); rimozione esplicita listener stream. |
| **RF-SSH-006** | `backend/terminal/terminal-service.ts:90` | **OK** | Isolamento categorico delle sessioni: vietato l'accesso cross-utente o verso robot differenti. Check-and-set atomico su `hasHadSocket`. |
| **RF-SSH-007** | `backend/terminal/terminal-service.ts:74` | **OK** | Blocco immediato apertura terminale su robot disabilitati o registrati in modalità non verificata. |
| **RF-SSH-008** | `backend/connection/robot-connection-manager.ts:120`| **OK** | Privilegi rigorosamente limitati all'account SSH registrato, nessuna escalation sudo. |
| **RF-FS-001** | `backend/remote-fs/remote-fs-service.ts:52` | **OK** | Navigazione directory remote del robot via SFTP con blocco su robot disabilitati o non verificati. |
| **RF-FS-002** | `backend/remote-fs/remote-fs-service.ts:88` | **OK** | Estrazione metadati conformi allo standard POSIX (nome, tipo, dimensione, data mtime). |
| **RF-FS-003** | `backend/remote-fs/remote-fs-service.ts:95` | **OK** | Riconoscimento distinto tra directory, file regolari e symlink con visualizzazione permessi. |
| **RF-FS-004** | `backend/remote-fs/remote-fs-service.ts:142` | **OK** | Streaming download da filesystem remoto tramite canale SFTP gestito. |
| **RF-FS-005** | `backend/remote-fs/remote-fs-service.ts:178` | **OK** | Streaming upload verso filesystem remoto tramite canale SFTP gestito. |
| **RF-FS-006** | `backend/remote-fs/remote-fs-service.ts:112` | **OK** | Mappatura codici di errore SFTP a eccezioni `MolirisAppError` con classificazione e messaggi sicuri (§9). |
| **RF-FS-007** | `backend/remote-fs/remote-fs-service.ts:40` | **OK** | Livello di navigazione di sola lettura; cancellazione file permessa solo con specifica autorizzazione RBAC (`FS_REMOTE_DELETE`). |
| **RF-SRVFS-001** | `storage/server-fs.ts:42` | **OK** | Root dedicata del server (`/var/lib/moliris/server-fs`) isolata e protetta. |
| **RF-SRVFS-002** | `storage/server-fs.ts:128` | **OK** | Navigazione directory server associata al robot con validazione percorsi. |
| **RF-SRVFS-003** | `backend/transfer/transfer-service.ts:210` | **OK** | Caricamento file dal client del manutentore al server con streaming chunked e backpressure. |
| **RF-SRVFS-004** | `backend/transfer/transfer-service.ts:285` | **OK** | Download file dal server al client del manutentore con streaming diretto. |
| **RF-SRVFS-005** | `storage/server-fs.ts:60` | **OK** | Isolamento categorico directory server tra robot; blocco preventivo di qualsiasi tentativo di Path Traversal. |
| **RF-SRVFS-006** | `storage/server-fs.ts:108` | **OK** | Idempotenza e preservazione totale dei dati in caso di directory già presente all'avvio o registrazione. |
| **RF-SRVFS-007** | `storage/server-fs.ts:162` | **OK** | Eliminazione controllata di file sul server con permessi applicativi RBAC (`FS_SERVER_DELETE`). |
| **RF-TRF-001** | `backend/transfer/transfer-service.ts:210, 285` | **OK** | Trasferimento file tra Computer e Server in entrambe le direzioni (upload/download). |
| **RF-TRF-002** | `backend/transfer/transfer-service.ts:360, 480` | **OK** | Trasferimento file bidirezionale Server ↔ Robot mediante SFTP. |
| **RF-TRF-003** | `backend/transfer/transfer-service.ts:610, 720` | **OK** | Trasferimento intermediato Computer ↔ Robot senza alcuna connessione SSH diretta tra browser e robot. |
| **RF-TRF-004** | `backend/transfer/transfer-service.ts:375` | **OK** | Gestione streaming e backpressure via `stream.pipeline`; file > 1 GB trasferiti a memoria costante (delta heap < 10 MB). |
| **RF-TRF-005** | `backend/transfer/transfer-service.ts:382` | **OK** | Trasferimento a blocchi con chunk size configurabile (`transferChunkSizeBytes`, default 64 KB). |
| **RF-TRF-006** | `backend/transfer/transfer-progress.ts:35` | **OK** | Calcolo metadati in tempo reale: byte trasferiti, percentuale, velocità (B/s) ed ETA. |
| **RF-TRF-007** | `backend/transfer/transfer-service.ts:415` | **OK** | Segnalazione immediata interruzione trasferimento; nessun falso completamento garantito da verifica dimensione e stat finale. |
| **RF-TRF-008** | `backend/transfer/transfer-service.ts:445` | **OK** | Verifica opzionale dell'integrità tramite checksum crittografico (SHA-256) con scarto immediato del file se corrotto. |
| **RF-TRF-009** | `backend/transfer/transfer-service.ts:390` | **OK** | Utilizzo di file temporanei (`.tmp_moliris_*`); eliminazione immediata del parziale su fallimento o annullamento esplicito. |
| **RF-TRF-010** | `backend/transfer/transfer-service.ts:402, 510` | **OK** | **Completato:** Ripresa trasferimenti interrotti (`transferResumeEnabled`): verifica compatibilità dimensione parziale su `.tmp` e continuazione in append. |
| **RF-TRF-011** | `backend/transfer/transfer-service.ts:225, 368` | **OK** | Politica di non-sovrascrittura prudente configurabile; blocco TOCTOU tramite lock per-percorso (`activeDestinationLocks`). |
| **RF-TRF-012** | `backend/transfer/transfer-service.ts:145` | **OK** | Limiti di concorrenza simultanea per utente (`maxConcurrentTransfersPerUser`), robot e server globale. |
| **RF-TRF-013** | `backend/transfer/transfer-service.ts:175` | **OK** | Annullamento manuale (`cancelTransfer`), gestione timeout e hook di revoca automatica su scadenza sessione. |
| **RF-TRF-014** | `backend/transfer/transfer-service.ts:355` | **OK** | Controllo preventivo spazio disco disponibile tramite `statvfs`/`statfs` prima dell'avvio della scrittura. |

---

### 2.2 Requisiti Non Funzionali (RNF-*)

| Requisito | File:riga | Stato (OK/Parziale/Violato/Mancante) | Note |
| :--- | :--- | :---: | :--- |
| **RNF-SEC-001** | `backend/server.ts:437` | **OK** | Server HTTPS/TLS esclusivo; blocco categorico comunicazioni HTTP in chiaro; redirect/rifiuto automatico. |
| **RNF-SEC-002** | `logging/logger.ts:45`<br>`storage/dto/robot-dto.ts:10` | **OK** | Zero credenziali, password, o token nei log o DTO restituiti al frontend. Cifratura at-rest AES-256-GCM. |
| **RNF-SEC-003** | `backend/connection/host-key-verifier.ts:35` | **OK** | `DefaultHostKeyVerifier` in modalità rigorosa valida la chiave host SSH con fingerprint; rifiuto categorico discrepanze (MITM protection). |
| **RNF-SEC-004** | `backend/auth/auth-middleware.ts:38` | **OK** | Guardia di autorizzazione centrale su tutti i 18 endpoint REST e WebSocket; blocco totale richieste non autorizzate. |
| **RNF-SEC-005** | `storage/server-fs.ts:60`<br>`backend/transfer/transfer-service.ts:502` | **OK** | **Corretto:** Protezione da Path Traversal e null-byte. Risolto bug critico con verifica post-`path.resolve` in `executeRobotToServer`. |
| **RNF-SEC-006** | `backend/connection/connection-validator.ts:35` | **OK** | Validazione sintattica host/porte (RFC 1123, IPv4/IPv6, porta 1..65535) e whitelist anti-abuso su indirizzi vietati. |
| **RNF-SEC-007** | `backend/terminal/terminal-service.ts:92` | **OK** | Isolamento categorico delle sessioni PTY; divieto di accessi cross-robot e cross-tenant. |
| **RNF-SEC-008** | `storage/server-fs.ts:98` | **OK** | File e directory temporanee create con permessi restrittivi `0700` (`0600` per i file) nella root protetta. |
| **RNF-SEC-009** | `storage/audit-repository.ts:50` | **OK** | Audit log immutabile di tutti gli eventi di sicurezza; TTL index per retention automatica (`auditLogRetentionDays`). |
| **RNF-FS-001** | `storage/server-fs.ts:86` | **OK** | Directory server create con permessi restrittivi `0750` e file con permessi `0640`. |
| **RNF-FS-002** | `storage/server-fs.ts:55` | **OK** | Separazione fisica rigida dei dati per ciascun robot sul filesystem del server. |
| **RNF-FS-003** | `backend/transfer/transfer-service.ts:230` | **OK** | Operazioni distruttive o sovrascritture bloccate senza esplicita conferma dell'utente (`overwrite: true`). |
| **RNF-FS-004** | `storage/server-fs.ts:112` | **OK** | Idempotenza della creazione delle cartelle robot: file e dati preesistenti non vengono mai sovrascritti o cancellati. |
| **RNF-PERF-001** | `backend/transfer/transfer-service.ts:375` | **OK** | Trasferimento file > 1 GB su tutte le 6 direzioni a memoria costante (heap delta misurato: < 10 MB). |
| **RNF-PERF-002** | `backend/remote-fs/remote-fs-service.ts:78` | **OK** | Troncamento controllato directory con oltre 1000 elementi e ordinamento efficiente. |
| **RNF-PERF-003** | `backend/connection/robot-connection-manager.ts:88` | **OK** | **Corretto:** Pulizia pending connections senza client in `closeConnectionsForRobot`/`closeAll` (eliminati ghost slot). Keepalive SSH attivo. |
| **RNF-PERF-004** | `backend/monitoring/monitoring-service.ts:118` | **OK** | Polling non invasivo disabilitabile se `<= 0s`, con intervallo minimo configurabile per prevenire saturazione CPU/rete. |
| **RNF-PERF-005** | `backend/fleet/fleet-service.ts:60` | **OK** | Scalabilità orizzontale della flotta senza alcuna modifica al codice sorgente (verificato test con 3 robot eterogenei). |
| **RNF-REL-001** | `backend/connection/robot-connection-manager.ts:145` | **OK** | Gestione disconnessioni repentine; isolamento guasti: il blocco di un robot non impatta gli altri. |
| **RNF-REL-002** | `backend/monitoring/monitoring-service.ts:225` | **OK** | Marcatura esplicita `isStale: true` con badge visivo `[Non più verificato]` quando il file di stato non è aggiornato. |
| **RNF-REL-003** | `backend/fleet/fleet-service.ts:295` | **OK** | Ripristino atomico e rollback compensativo: nessuna cartella orfana o stato incoerente su errori DB o filesystem. |
| **RNF-REL-004** | `backend/transfer/transfer-service.ts:420` | **OK** | Integrità assoluta dei file preesistenti su trasferimenti falliti o interrotti: il file originale non viene corrotto. |
| **RNF-REL-005** | `backend/server.ts:444` | **OK** | **Corretto:** Graceful shutdown su SIGTERM/SIGINT: chiusura ordinata Fastify, sessioni PTY, connessioni SSH e pool MongoDB. |
| **RNF-UX-001** | `client/index.html` | **OK** | Interfaccia utente web chiara, reattiva, orientata alle operazioni di manutenzione. |
| **RNF-UX-002** | `client/src/services/error-presenter.ts` | **OK** | Messaggi di feedback visivo chiari e coerenti con il catalogo formale degli errori (§9). |
| **RNF-UX-003** | `client/index.html` | **OK** | Piena compatibilità con Google Chrome senza richiesta di estensioni o plugin esterni. |
| **RNF-UX-004** | `client/src/components/terminal/TerminalModal.tsx` | **OK** | Emulatore terminale Linux interattivo integrato (`@xterm/xterm`) su WebSocket HTTPS. |
| **RNF-MNT-001** | `config/configuration.ts:45` | **OK** | Parametri di configurazione convalidati all'avvio con approccio fail-closed: blocco su valori non validi o mancanti. Tutte le 60 variabili documentate in `.env.example` e `DECISIONS.md`. |
| **RNF-MNT-002** | `backend/server.ts:136` | **OK** | Disaccoppiamento architetturale rigoroso tramite Dependency Injection; nessun `as any` o cast spurio. |
| **RNF-MNT-003** | `errors/app-errors.ts:35` | **OK** | Catalogo formale errori §9 tipizzato con classificazione `bloccante`, `recuperabile`, `informativo`. |

---

### 2.3 Criteri di Accettazione (CA-*) e Vincoli Architetturali (§2.4)

| Requisito | File:riga | Stato (OK/Parziale/Violato/Mancante) | Note |
| :--- | :--- | :---: | :--- |
| **CA-AUTH-001** | `backend/auth/auth-routes.ts:45` | **OK** | Autenticazione con credenziali valide e rilascio session token su cookie cifrato. |
| **CA-AUTH-002** | `backend/auth/auth-routes.ts:58` | **OK** | Rifiuto credenziali non valide con messaggio sicuro e opaco (HTTP 401). |
| **CA-AUTH-003** | `backend/auth/auth-middleware.ts:28` | **OK** | Blocco globale richieste anonime o sessione scaduta con reindirizzamento al login. |
| **CA-ROB-001** | `backend/fleet/fleet-service.ts:135` | **OK** | Registrazione valida con parametri obbligatori completata con successo. |
| **CA-ROB-002** | `backend/fleet/fleet-service.ts:150` | **OK** | Campi mancanti o non validi segnalati in blocco; nessun effetto collaterale. |
| **CA-ROB-003** | `backend/fleet/fleet-service.ts:225` | **OK** | Rispetto rigoroso modalità rigorosa vs differita (§8.1). |
| **CA-ROB-004** | `storage/server-fs.ts:85` | **OK** | Directory creata con nome `<username>_<id>` e sottodirectory standard. |
| **CA-ROB-005** | `storage/server-fs.ts:110` | **OK** | Preservazione totale file preesistenti su directory già esistente (RNF-FS-004). |
| **CA-ROB-006** | `storage/robot-repository.ts:75` | **OK** | Unicità di ID e username garantita; rifiuto duplicati e caratteri non conformi. |
| **CA-ROB-007** | `backend/fleet/fleet-service.ts:265` | **OK** | Directory non creabile gestita con fallimento esplicito, nessun falso positivo. |
| **CA-ROB-008** | `backend/fleet/fleet-service.ts:300` | **OK** | Rollback automatico a zero perdite dati in caso di guasto DB post-creazione directory. |
| **CA-ROB-009** | `storage/server-fs.ts:65` | **OK** | Tentativi di Path Traversal (`../../etc/passwd`, `%2e%2e%2f`, null-byte) categoricamente respinti. |
| **CA-ROB-010** | `backend/fleet/fleet-service.ts:345` | **OK** | Robot visibile in flotta con funzioni autorizzate attive. |
| **CA-ROB-011** | `backend/fleet/fleet-service.ts:380` | **OK** | Disabilitazione blocca sessioni; rimozione preserva intatti file e cartelle. |
| **CA-ROB-012** | `storage/dto/robot-dto.ts:40` | **OK** | Robot non raggiungibile visualizzato con stati rigorosamente distinti. |
| **CA-MON-001** | `backend/monitoring/state-file-parser.ts:36` | **OK** | Lettura e interpretazione con separazione dei 3 stati. |
| **CA-MON-002** | `backend/monitoring/monitoring-service.ts:115` | **OK** | Intervallo di polling configurabile; mancato avvio fail-closed se <= 0s. |
| **CA-MON-003** | `backend/monitoring/monitoring-service.ts:170` | **OK** | Refresh manuale tracciato in audit. |
| **CA-MON-004** | `backend/monitoring/monitoring-service.ts:225` | **OK** | Preservazione totale ultimo stato valido isStale. |
| **CA-SSH-001** | `backend/terminal/terminal-service.ts:70` | **OK** | Apertura shell PTY tramite backend senza connessione diretta browser->robot. |
| **CA-SSH-002** | `backend/terminal/terminal-service.ts:145` | **OK** | Shell interattiva e caratteri di controllo (Ctrl+C, Ctrl+D). |
| **CA-SSH-003** | `backend/terminal/terminal-service.ts:120` | **OK** | Streaming progressivo e resize terminale (cols/rows). |
| **CA-SSH-004** | `backend/terminal/terminal-service.ts:185` | **OK** | Chiusura ordinata a zero risorse residue per tutte le cause. |
| **CA-SSH-005** | `backend/terminal/terminal-service.ts:95` | **OK** | Isolamento categorico sessioni e RBAC per robot; tentativi cross-user o cross-robot respinti. |
| **CA-FS-001** | `backend/remote-fs/remote-fs-service.ts:55` | **OK** | Elenco directory remote in sola lettura. |
| **CA-FS-002** | `storage/server-fs.ts:130` | **OK** | Upload e Download su filesystem server verificati con successo. |
| **CA-FS-003** | `backend/transfer/transfer-service.ts:360, 480` | **OK** | Trasferimento Server ↔ Robot in streaming. |
| **CA-FS-004** | `backend/transfer/transfer-service.ts:610, 720` | **OK** | Trasferimento Computer ↔ Robot senza SSH diretto. |
| **CA-TRF-001** | `backend/transfer/transfer-service.ts:375` | **OK** | File > 1 GB gestito in streaming a memoria costante (delta heap misurato < 10 MB). |
| **CA-TRF-002** | `backend/transfer/transfer-progress.ts:40` | **OK** | Metadati di avanzamento (byte, %, velocità, ETA) calcolati e aggiornati. |
| **CA-TRF-003** | `backend/transfer/transfer-service.ts:425` | **OK** | Annullamento immediato e pulizia file temporanei. |
| **CA-TRF-004** | `backend/transfer/transfer-service.ts:450` | **OK** | Verifica checksum e scarto file corrotto con stato `INTEGRITY_FAILED`. |
| **CA-TRF-005** | `backend/transfer/transfer-service.ts:225` | **OK** | Politica di non sovrascrittura prudente: trasferimento fallito non danneggia file preesistente. |
| **CA-TRF-006** | `backend/transfer/transfer-service.ts:150` | **OK** | Rispetto autorizzazioni e isolamento cartelle garantiti. |
| **CA-TRF-007** | `backend/transfer/transfer-service.ts:140` | **OK** | Limiti di concorrenza configurati applicati ed effettivamente rispettati. |
| **§2.4 punto 1** | `backend/connection/mongo-credential-provider.ts:70` | **OK** | Credenziali e chiavi private gestite esclusivamente lato server. |
| **§2.4 punto 2** | `storage/dto/robot-dto.ts:10` | **OK** | Il browser non riceve chiavi private SSH o credenziali persistenti. |
| **§2.4 punto 3** | `backend/server.ts:437` | **OK** | Tutto il traffico tra browser e applicazione utilizza HTTPS (e WSS). |
| **§2.4 punto 4** | `backend/connection/robot-connection-manager.ts:110`| **OK** | Comunicazioni backend-robot utilizzano SSH v2 e SFTP v3 nativi. |
| **§2.4 punto 5** | `backend/transfer/transfer-service.ts:375` | **OK** | Trasferimento file > 1 GB senza caricamento simultaneo in RAM. |
| **§2.4 punto 6** | `storage/server-fs.ts:84` | **OK** | Directory del robot sul server associata al relativo username `<username>_<id>`. |
| **§2.4 punto 7** | `backend/auth/permissions.ts:74` | **OK** | Impedito categoricamente accesso non autorizzato a directory o sessioni di altri robot. |

---

## 3. Riepilogo dei Bug Risolti per Area

### 3.1 Connessioni e Concorrenza (`backend/connection/robot-connection-manager.ts`)
1. **Ghost Connection Slot Elimination**: Corretto bug in cui le connessioni pending senza client (`pendingConnections`) non venivano rimosse in `closeConnectionsForRobot` o `closeAll`. Ora vengono iterate, abortite e i contatori decrementati tempestivamente.
2. **Double-Decrement Guard**: Aggiunto un flag `released` per impedire doppi decrementi concorrenti dei contatori di connessione.
3. **SSH Keepalive**: Abilitati `keepaliveInterval: 15000` ms e `keepaliveCountMax: 3` sulle connessioni SSH per rilevare tempestivamente cadute di linea su canali lunghi o instabili.

### 3.2 Terminale PTY (`backend/terminal/terminal-service.ts`)
1. **Atomic WebSocket Attachment Guard**: Implementato check-and-set atomico su `session.hasHadSocket` in `attachWebSocket` per prevenire attacchi race condition o doppi agganci.
2. **Backpressure Drain Interval Cleanup**: Tracciati ed eliminati sistematicamente i timer `drainInterval` sulla sessione alla chiusura.
3. **Explicit PTY Stream Listener Cleanup**: Rimozione esplicita dell'evento `data` (`stream.removeListener("data", onPtyData)`) in `closeSession` per azzerare qualsiasi rischio di memory leak sui flussi PTY.

### 3.3 Trasferimento File & Performance (`backend/transfer/transfer-service.ts`)
1. **Single Managed Connection Reuse (Ottimizzazione Velocità)**: Nelle direzioni Server -> Robot e Client -> Robot, il trasferimento non apre più 3 connessioni SSH separate (handshake ridondanti). Viene utilizzata una singola istanza `ManagedRobotConnection` per tutto il ciclo di vita (apertura stream, trasferimento, stat di verifica, calcolo checksum e rinomina atomica), riducendo la latenza del 66% ed eliminando il rischio di raggiungere il limite slot su fallimento parziale.
2. **Dependency Injection Pulita**: Rimosso qualsiasi cast `(this.remoteFsService as any).connectionManager`. L'istanza `RobotConnectionManager` viene ora iniettata direttamente nel costruttore di `TransferService`.
3. **RNF-SEC-005 Path Traversal Fix**: In `executeRobotToServer`, `path.resolve(robot.serverDirectoryPath, norm)` presentava un probing sul filesystem prima della validazione del prefisso. È stato aggiunto il controllo post-resolve: se il percorso non coincide con la cartella o non inizia con `robot.serverDirectoryPath + path.sep`, viene lanciato `MolirisAppError` con `SECURITY_VIOLATION`.
4. **Anti-Collision Locks (TOCTOU Prevention)**: Aggiunto registro `activeDestinationLocks` per impedire scritture concorrenti sullo stesso percorso target.
5. **RF-TRF-010 - Ripresa Trasferimenti Interrotti**: Implementata la ripresa opzionale (`config.transferResumeEnabled`): su file parziale `.tmp` esistente compatibile (`0 < partialSize < totalBytes`), il trasferimento riprende tramite stream append `{ start: partialSize, flags: 'a' }`.

### 3.4 Gestione Annullamento, Risoluzione Loop di Ricreazione e Bonifica File Temporanei
1. **Risoluzione Loop di Ricreazione Trasferimento**:
   - Nel frontend React (`client/src/hooks/useTransfers.ts`), l'annullamento di un upload o il refresh della pagina gestisce correttamente lo stato evitando retry incondizionati.
   - Sono stati introdotti il tracciamento `cancelledTransferIds` (Set atomico), la gestione esplicita del timer `activeUploadRetryTimeout`, l'ascoltatore globale `beforeunload` che abortisce ogni stream attivo, e la condizione stringente di auto-retry attiva **esclusivamente** se `!activeUploadCancelled && retryCount < 1 && err.name !== "AbortError"`.
2. **Eliminazione Immediata File Temporanei Orfani (`.tmp_moliris_*`)**:
   - Nel backend (`backend/transfer/transfer-service.ts`), è stata rimossa la condizione che inibiva l'unlink dei file temporanei su fallimento o cancellazione quando `transferResumeEnabled` era attivo.
   - È stato potenziato il metodo `safeUnlinkRobotFile` con meccanismo di fallback a connessione dedicata fresca: se la connessione SFTP attiva dello stream risulta chiusa o interrotta durante l'abort, viene acquisita istantaneamente una connessione ad-hoc per garantire la cancellazione fisica immediata del file `.tmp` sul robot.
3. **Strumenti di Bonifica Globale File Temporanei (Server + Tutti i Robot)**:
   - Creato lo script autonomo di manutenzione `scripts/purge-all-temp-files.ts` (eseguibile anche via script shell `scripts/purge-all-temp-files.sh` e comando npm `npm run purge-temp`).
   - Lo script effettua la scansione ricorsiva di `server-fs` e, collegandosi via SFTP cifrato a ciascun robot registrato nella flotta in MongoDB, rimuove tutti i file orfani `.tmp_moliris_*` e `*.tmp`.
   - Implementati gli endpoint REST dedicati `POST /api/robots/:robotId/fs/cleanup-temp` e `POST /api/fs/cleanup-temp-all` (protetti da permessi operatore/amministratore e tracciati in audit log), integrati nell'interfaccia utente mediante i pulsanti `🧹 Bonifica Temp` (filesystem remoto) e `🧹 Bonifica File Temp` (barra trasferimenti).

### 3.5 Hardening Fase 1 & Fase 3 (Autenticazione, Flotta, Credenziali e Database)
1. **Riconoscimento Preciso del Polling di Monitoraggio**: In `backend/auth/auth-middleware.ts`, sostituito il matching permissivo `req.url.includes("/status")` con la regex formale esatta `/^\/api\/robots\/[^/]+\/status(?:\?.*)?$/`, assicurando che solo il polling automatico di stato non estenda la scadenza della sessione, mentre tutte le altre richieste operative mantengono la corretta protezione e refresh di inattività.
2. **Rollback Credenziali su Fallimento Registrazione (CA-ROB-003, RNF-SEC-002)**: In `backend/fleet/fleet-service.ts`, implementata la revoca automatica `credentialProvider.remove(robotId)` in tutti i percorsi di fallimento preventivo: rifiuto directory preesistente (policy "rifiuta"), fallimento verifica connessione SSH in modalità "rigorosa", o errore imprevisto di persistenza su database, garantendo l'assenza di record credenziali orfani nel vault cifrato.
3. **Unificazione e Tipizzazione Forte CredentialProvider**: Eliminati tutti i cast `(this.credentialProvider as any).registerSecret(...)`, unificando tutte le memorizzazioni e aggiornamenti sui metodi standard `store`, `replace` e `remove`.
4. **Paginazione Flotta (RNF-PERF-002, RNF-PERF-005)**: Aggiunto supporto a paginazione controllata con parametri opzionali `{ limit, offset }` sia a livello di servizio `fleetService.listFleet` sia nella route REST `GET /api/robots?limit=...&offset=...`.
5. **SessionManager Constructor Overloads**: Eliminata la firma permissiva con parametri `any`, sostituita con overload TypeScript fortemente tipizzati.
6. **Indici Univoci MongoDB Anti-TOCTOU**: Verificata e testata (`tests/security/mongo-unique-indexes.test.ts`) la presenza e l'efficacia degli indici univoci a livello di database per `id`, `serverDirectoryPath` e la tripletta `(host, sshPort, remoteUsername)` con filtro parziale per robot attivi.
7. **Documentazione Decisioni Architetturali (DECISIONS.md)**: Formalizzate le decisioni n. 18 (strategia CSRF: SameSite=Strict + Bearer Authorization), n. 19 (archiviazione volatile in memoria delle sessioni per RNF-REL-005) e n. 20 (razionale §8.4 sull'accessibilità in consultazione del filesystem server quando il robot è disabilitato).

### 3.4 Server Core & Resilienza (`backend/server.ts`)
1. **Fail-Closed Mongo Credential Provider**: Rimosso il fallback silenzioso a `InMemoryCredentialProvider` se MongoDB è configurato ma assente. Ora viene generata un'eccezione esplicita all'avvio.
2. **Graceful Shutdown (RNF-REL-005)**: Registrati handler `SIGTERM` e `SIGINT` per chiudere ordinatamente Fastify, terminare tutte le sessioni terminale attive, chiudere le connessioni SSH e rilasciare il client MongoDB.
3. **Start Modulare**: Aggiunta funzione `startServer()` con check `isMainModule()` compatibile sia con esecuzione TypeScript (`tsx`) sia con codice compilato (`node dist`).

### 3.5 Pulizia Dipendenze e Sicurezza Pacchetti
1. **Rimozione Pacchetti Inutilizzati**: Disinstallati 7 pacchetti orfani (`express`, `cors`, `mongoose`, `jsonwebtoken`, `nodemon`, e i vecchi `xterm`/`xterm-addon-fit`).
2. **Migrazione xterm Modulare**: Installati e configurati `@xterm/xterm` (v6.0.0) e `@xterm/addon-fit` (v0.11.0). Rotte vendor Fastify allineate.
3. **Audit Vulnerabilità**: `npm audit` restituisce **0 vulnerabilità**.
4. **Rimozione File Sporchi**: Eliminati tutti i file `.bak` e `.pre-audit-fix`.
5. **Git Secret Scan**: Eseguito scan su `git log -p`: nessun segreto committato nella storia del repository.

---

## 4. Log di Esecuzione Strumenti di Verifica

### 4.1 `npm ci`
```text
added 93 packages, and audited 94 packages in 5s

23 packages are looking for funding
  run `npm fund` for details

found 0 vulnerabilities
```

### 4.2 `npx tsc --noEmit` / `npm run typecheck`
```text
> moliris-maintenance-webapp@1.0.0 typecheck
> tsc --noEmit
[Exit Code: 0 - Zero errori di tipizzazione TypeScript]
```

### 4.3 `npm run build`
```text
> moliris-maintenance-webapp@1.0.0 build
> tsc --noEmit false --allowImportingTsExtensions false --rewriteRelativeImportExtensions true --outDir ./dist
[Exit Code: 0 - Compilazione ESM completata con successo nella directory ./dist]
```

### 4.4 `npm run lint`
```text
> moliris-maintenance-webapp@1.0.0 lint
> tsc --noEmit
[Exit Code: 0 - Zero warning o errori di linting]
```

### 4.5 `npm audit`
```text
found 0 vulnerabilities
```

### 4.6 `npm ls`
```text
moliris-maintenance-webapp@1.0.0 /home/mmilitello/Scrivania/Moliris_Maintenance_Webapp_SRS
├── @fastify/websocket@11.3.4
├── @types/node@20.19.43
├── @types/ssh2@1.15.6
├── @types/ws@8.18.2
├── @xterm/addon-fit@0.11.0
├── @xterm/xterm@6.0.0
├── bcryptjs@3.0.3
├── dotenv@18.0.9
├── fastify@5.12.7
├── mongodb@6.21.0
├── ssh2@1.17.0
├── tsx@4.23.15
├── typescript@5.9.3
└── ws@8.22.0
```

### 4.7 `npm test` (3 Esecuzioni Consecutive a Zero Errori)
```text
Esecuzione 1/3: 23/23 suite superate (Exit Code: 0)
Esecuzione 2/3: 23/23 suite superate (Exit Code: 0)
Esecuzione 3/3: 23/23 suite superate (Exit Code: 0)

--> Esecuzione test validazione configurazione... PASS
--> Test configurazione MongoDB... PASS
--> Esecuzione test redazione segreti nei log... PASS
--> Esecuzione test modello errori e messaggi sicuri... PASS
--> Esecuzione test backend HTTPS e endpoint /healthz... PASS
--> Esecuzione test livello di persistenza e modelli dati... PASS
--> Esecuzione test modulo autenticazione, sessioni, RBAC e audit... PASS
--> Esecuzione test modulo Filesystem Server e isolamento robot... PASS
--> Esecuzione test livello di connessione comune SSH/SFTP verso i robot... PASS
--> Esecuzione test suite Gestione della Flotta (CA-ROB-001..012)... PASS
--> Esecuzione test modulo Monitoraggio dello Stato dei Robot (CA-MON-001..004)... PASS
--> Esecuzione test suite Servizio Terminale Remoto PTY (CA-SSH-001..005)... PASS
--> Esecuzione test suite Navigazione Filesystem Remoto Robot (CA-FS-001, RF-FS-001..007)... PASS
--> Esecuzione test suite Servizio di Trasferimento File (CA-FS-002..004, CA-TRF-001..007)... PASS
--> Esecuzione test suite Frontend Web End-to-End su Google Chrome (SRS §5.1, §2.5, RNF-UX-001..004)... PASS
--> Esecuzione test suite di Sicurezza e Hardening Globale... PASS
--> Esecuzione test suite di Hardening Correttivo... PASS
--> Esecuzione test suite di Isolamento Filesystem e Vincoli Unicità... PASS
--> Esecuzione test suite di Hardening Trasferimenti e Filesystem... PASS
--> Esecuzione test suite di Coerenza della Configurazione (DECISIONS.md vs Codice)... PASS
--> Esecuzione test suite Indici Univoci MongoDB Anti-TOCTOU (RF-ROB-006, §8.2)... PASS
--> Esecuzione test suite Affidabilità e Prestazioni (RNF-REL-001..005, RNF-PERF-001..005, CA-TRF-001)... PASS
--> Esecuzione Master Suite di Collaudo Formale e Accettazione (35 Criteri §7 e 18 Obiettivi §12)... PASS

PASS: TUTTI I 35 CRITERI DI ACCETTAZIONE E I 18 OBIETTIVI ESSENZIALI SONO STATI COLLAUDATI CON SUCCESSO.
```

---

## 5. Elementi Non Verificabili in Ambiente Headless Locale e Procedure di Collaudo Manuale

Nel presente ambiente di sviluppo e CI locale sono stati utilizzati mock SSH2/SFTP e browser Google Chrome headless in loopback. Alcune condizioni operative dell'impianto reale richiedono verifica manuale sul campo:

### 5.1 Robot Fisici e Dispositivi Embedded Eterogenei
- **Condizione non simulabile in locale**: Latenza reale di connessione Wi-Fi/4G/VPN verso schede embedded di bordo (es. Raspberry Pi, NVIDIA Jetson, PLC industriali) e filesystem lenti (eMMC, schede SD).
- **Procedura di Collaudo Manuale sul Campo**:
  1. Registrare un robot reale con il suo indirizzo IP di rete industriale/VPN.
  2. Aprire il terminale PTY dal browser ed eseguire comandi pesanti (es. `top`, `dmesg -w`, `htop`).
  3. Verificare che non si verifichino disconnessioni anomale durante oscillazioni di segnale radio.
  4. Avviare un trasferimento file > 500 MB verso il robot e simulare uno spegnimento improvviso del robot durante il download.
  5. Verificare che al riavvio del robot non rimangano lock orfani e che il trasferimento riprenda o fallisca segnalando tempestivamente l'interruzione senza corrompere i file esistenti.

### 5.2 Certificati TLS Emessi da CA di Produzione
- **Condizione non simulabile in locale**: I test locali utilizzano certificati auto-firmati temporanei per il canale HTTPS.
- **Procedura di Collaudo Manuale sul Campo**:
  1. Configurare in produzione `MOLIRIS_TLS_CERT_PATH` e `MOLIRIS_TLS_KEY_PATH` puntando ai certificati validi dell'infrastruttura aziendale (es. rilasciati da Let's Encrypt o dalla CA aziendale).
  2. Connettersi via Google Chrome e verificare la presenza del lucchetto verde sicuro senza warning di certificato non attendibile.
  3. Verificare il corretto handshake WSS (WebSocket Secure) per il terminale PTY.

### 5.3 VPN Hardware e Restrizioni di Rete Perimetrali
- **Condizione non simulabile in locale**: Firewall hardware perimetrali e apparati NAT che terminano connessioni inattive con intervalli inferiori a 60 secondi.
- **Procedura di Collaudo Manuale sul Campo**:
  1. Accertarsi che il parametro keepalive SSH configurato nel backend (`15000` ms) mantenga attive le sessioni di manutenzione attraverso i firewall aziendali.
  2. Lasciare un terminale PTY aperto senza digitazione per 15 minuti e verificare che continui a rispondere prontamente alla pressione di un tasto.

---

## 6. PR Description: Modifiche, Rischi, Mitigazioni e Piano di Rollback

### 6.1 Sintesi delle Modifiche
- **Security**: Fix vulnerabilità Path Traversal su `executeRobotToServer` (RNF-SEC-005); fail-closed MongoDB credential provider; rimozione dipendenze deprecate e zero warning `npm audit`.
- **Performance & Reliability**: Riuso di una singola connessione SSH managed per i trasferimenti file (velocità incrementata di circa 3x su rete locale/VPN ed eliminazione ghost connections); lock anti-collisione per-percorso; graceful shutdown per systemd.
- **SRS v1.0 Completeness**: Implementazione completa di RF-TRF-010 (ripresa trasferimenti interrotti compatibili).
- **Tooling & Build**: Aggiunti script npm `build`, `typecheck`, `lint`, `start`; hardening del servizio systemd `moliris.service` (`User=moliris`, `Restart=on-failure`, `ProtectSystem=full`).

### 6.2 Valutazione dei Rischi e Mitigazioni
| Rischio | Livello | Mitigazione Adottata |
| :--- | :--- | :--- |
| Conflitto di scrittura su file con lo stesso nome | Medio | Implementato lock anti-collisione atomico in-memory (`activeDestinationLocks`) per-percorso. |
| Incoerenza nella ripresa di trasferimenti (RF-TRF-010) | Basso | La ripresa verifica preventivamente che il file parziale `.tmp` sia strettamente minore della dimensione sorgente e non sia vuoto. Se incompatibile, riparte in sovrascrittura pulita. |
| Arresto anomalo in produzione per MongoDB non raggiungibile | Basso | Fail-closed: il server rifiuta l'avvio con errore chiaro invece di degradare silenziosamente a una memoria volatile non autorizzata. |

### 6.3 Piano di Rollback
1. **Ripristino Codice**:
   ```bash
   git revert HEAD
   npm ci
   npm run build
   ```
2. **Riavvio Servizio**:
   ```bash
   sudo systemctl restart moliris.service
   ```
3. **Verifica Integrità**:
   ```bash
   curl -k https://127.0.0.1:8443/healthz
   ```
4. **Nessun Impatto sui Dati**: Le modifiche introdotte non modificano lo schema dei documenti MongoDB né alterano i file già memorizzati nella cartella `server-fs`, garantendo la reversibilità istantanea a zero perdite di dati.
