# Stabilizzazione finale · Moliris Maintenance Web App

**27 novembre 2026 · Candidato locale alla revisione · Verdetto operativo NO-GO**

Base revisionata `039940800c79ed2bba73af59a72074841c38b3a1` del [repository GitHub](https://github.com/marcomili0009-gif/Moliris_Maintenance_Webapp_SRS/commit/039940800c79ed2bba73af59a72074841c38b3a1), con modifiche locali. La baseline di confronto è il [report di audit](MOLIRIS_FINAL_AUDIT_REPORT.md) e la [SRS ufficiale](Moliris_Maintenance_Webapp_SRS.pdf), incluse le [integrazioni in coda al TXT](Moliris_Maintenance_Webapp_SRS.txt#L1673).

Durante il lavoro `main` è avanzato di quattro commit fino a [`dec0d082a164184bf8ebbdbfab0de0ceb4532460`](https://github.com/marcomili0009-gif/Moliris_Maintenance_Webapp_SRS/commit/dec0d082a164184bf8ebbdbfab0de0ceb4532460). Il workspace conserva le correzioni sulla base dell’audit. Il pacchetto cumulativo combina la nuova revisione GitHub e le correzioni in una copia separata, preservando le API Logs strutturate, le modifiche ai trasferimenti, lo storico e le suite di upstream. La copia cumulativa ordina le scritture dello storico per trasferimento e le attende prima di chiudere MongoDB. Nessun commit, push, deploy o riavvio su NEANTE.

**Valutazione applicativa locale.** Il candidato ha superato il collaudo delle 39 suite configurate, eseguite in più blocchi, e tre suite su Chrome reale. I quattro rilievi prioritari sono risolti nel perimetro locale. Sul binario consegnato, l’arresto con SSE, due terminali, un download SFTP in corso e due upload aperti ha impiegato 7,055 s, con tre annullamenti durevoli e rilascio dei socket del robot. I controlli di infrastruttura che determinano il GO restano aperti.

## Chiusura dei rilievi

| ID e stato | Causa, intervento, file ed evidenza |
|---|---|
| **A01 · RISOLTO** | Lo stream SSE rimaneva aperto prima di `server.close()`, rinviando la pulizia. Il collaudo dalla copia ripristinata ha anche riprodotto la chiusura anticipata del client Mongo durante l’audit di un download già consegnato. Il backend chiude gli stream in pre-close, ferma schedulazione e timer, annulla i lavori arrestabili, chiude terminali e connessioni SSH/SFTP, attende trasferimenti in background, finalizzazioni di download, storico e registrazioni accodate prima di chiudere MongoDB. Il watchdog chiude HTTP residuo dopo 7 s e segnala un arresto incompleto con codice 1 a 13 s. Il budget systemd resta 15 s. [Server](backend/server.ts) · [Route trasferimenti](backend/transfer/transfer-routes.ts) · [Servizio trasferimenti](backend/transfer/transfer-service.ts) · [Gestore batch](backend/transfer/batch-transfer-manager.ts) · E6 |
| **A02 · RESPONSABILITÀ INFRASTRUTTURA AZIENDALE** | Il certificato dell’endpoint pubblico è stato rifiutato dal client standard durante l’audit. Certificati, TLS aziendale e trust store sono rimasti invariati. IT deve validare il punto di accesso effettivo e la fiducia HTTPS/WSS delle postazioni. E8 |
| **A03 · NON VERIFICATO** | La sonda diagnostica pubblica senza credenziali ha letto 200 su `/healthz` e 404 su `/livez` per l’endpoint di NEANTE esaminato in audit. Accesso SSH come `stage`, con verifica rigorosa della chiave host, rifiutato. Dal percorso pubblico non è stato possibile leggere digest backend e sorgenti, PID, runtime effettivo, unità, override e journal. Il pacchetto prevede un preflight bloccante se layout o runtime divergono. [Procedura NEANTE](docs/NEANTE-MANUAL-UPDATE.md) · E8 |
| **A04 · PARZIALMENTE RISOLTO** | Mancava un runbook coordinato. Aggiunti inventario, finestra coerente, dump Mongo, archivio filesystem, log e configurazione, custodia separata delle chiavi, controlli di ripristino, retention e RPO/RTO. La fixture ha confrontato byte di archivio, configurazione e log, ritrovato un utente e decifrato una credenziale sintetica dopo il ripristino. Il binario ha servito login, flotta, download e Logs dalla copia restaurata. Restano da provare job, tempi e dati aziendali. [Runbook](docs/BACKUP-RESTORE.md) · E9 |
| **A05 · RISOLTO** | L’append fallito poteva lasciare l’esito fuori dallo storico fisico senza recupero. Ogni esito/marker riceve un identificativo stabile nel journal Mongo `transfer_log_outcomes` e resta recuperabile finché la proiezione fsync non è confermata. Se Mongo è indisponibile lo spool locale conserva il record fino alla riconciliazione. Il riavvio rilegge anche gli archivi per evitare la duplicazione tra append e conferma. I guasti sono segnalati e la perdita di entrambi i supporti degrada la readiness. Il journal conserva la riga canonica e il suo stato di proiezione. L’audit operativo Mongo `audit_events` mantiene il proprio ciclo di vita. [Logger](backend/logging/physical-file-logger.ts) · [Server](backend/server.ts) · [Test recupero](tests/database/transfer-log-recovery.test.ts) · E4 |
| **A06 · RISOLTO** | `transfers.log` cresceva senza rotazione; per gli accessi il vecchio limite poteva eliminare il file più antico. Accessi e trasferimenti ruotano su soglia, gli archivi vengono mantenuti, la lettura conserva anche i precedenti file numerati e il download integra i segmenti in ordine. La retention e gli alert disco restano una scelta operativa esplicita. [Logger](backend/logging/physical-file-logger.ts) · [Route](backend/logging/log-routes.ts) · [Decisioni](DECISIONS.md) · E4 |
| **A07 · PARZIALMENTE RISOLTO** | L’installer locale poteva destinare MongoDB alla stessa directory assegnata all’utente Moliris dall’unità applicativa. Il modello locale usa ora `/var/log/moliris-mongodb` per Mongo e mantiene `/var/log/moliris` per l’applicazione. Sintassi shell verificata. Applicabilità alla configurazione effettiva di NEANTE NV. [Installer](scripts/install-local-server.sh) |
| **A08 · PARZIALMENTE RISOLTO** | La chiave di sviluppo resta nello storico Git. Le chiavi pubbliche dei due certificati sono diverse. SHA-256 SPKI storico `eb23ef442c10cc3f0921c52cef38af4bb19451277cb383587a3345df3410a97d`, endpoint osservato `23cafeeb6e3bb3f346f3d92ec51b8cd2016bd6f0c8fe8ebcf5b3af5e86988ba9`. L’evidenza vale per questo endpoint. Altri endpoint e vecchie copie operative richiedono inventario IT. Storico e materiale TLS invariati. E8 |
| **A09 · RISOLTO** | Il polling avviava contemporaneamente l’intera flotta, contendendo tutti gli slot dello stesso utente. Il ciclo periodico ha una sola esecuzione attiva e usa lavoratori limitati dalla configurazione; il refresh massivo usa lo stesso limite. La prova riusa un endpoint SSH locale con 100 robot distinti e verifica lettura aggiornata e zero connessioni a fine ciclo. [Scheduler](backend/monitoring/monitoring-service.ts) · [Prova SSH a 100 robot](backend/monitoring/monitoring.test.ts) · E3 |
| **A10 · PARZIALMENTE RISOLTO** | Verificati Node 22.22.1, npm 9.2.0, MongoDB 9.0.4 e Chrome 156.0.8078.47 nella QA locale, installazione pulita e audit npm 0 advisory sia runtime sia completo. La versione Node locale è precedente alle patch del [bollettino Node.js](https://nodejs.org/en/blog/vulnerability/november-2026-security-releases/). Runtime e patch del sistema NEANTE NV. Nessun aggiornamento infrastrutturale eseguito. E1, E7, E8 |
| **A11 · RISOLTO** | Portabilità e hardening input erano fuori da `npm test`. Il gate include entrambe le suite e il nuovo test di ripristino del journal. I riferimenti README sono relativi al repository e i runbook sono collegati. L’alias lint continua a invocare TypeScript. [Script npm](package.json) · [README](README.md) · E1, E2, E11 |
| **A12 · RISOLTO** | Il buffer xterm dopo la riapertura conteneva `ALPHA_LINE` alla riga 3. Una singola rotella portava la viewport da 8 a 5. Il test ora centra il puntatore su xterm, invia più eventi di rotella reali separati da frame e conserva l’asserzione sul testo visibile. La sessione/applicazione terminale non richiedeva una modifica. [Test Chrome](client/react-frontend.test.ts) · E5 |
| **A13 · RISOLTO** | Nelle route Logs, il guard sincrono chiamava `reply.send()` e l’handler asincrono restituiva `undefined` mentre `onSend` era ancora attivo. Fastify tentava una nuova risposta. Autenticazione e guardie restituiscono ora esplicitamente il reply dei dinieghi e Logs applica il controllo ruolo in pre-handler. Il test esercita accesso anonimo 401, operatore 403, amministratore 200, cambio account, concorrenza, download e assenza di `ERR_HTTP_HEADERS_SENT`. [Guardie](backend/auth/auth-middleware.ts) · [Route](backend/logging/log-routes.ts) · [Test Chrome](client/react-frontend.test.ts) · E5 |
| **A14 · RISOLTO** | Lo schema rifiutava zero mentre il servizio lo interpretava come polling disabilitato. I due schemi accettano zero e il bootstrap applica il fallback dalla configurazione JSON quando la variabile è assente. Il valore negativo resta rifiutato; E6 avvia il binario con zero. [Schema](src/config/schema.ts) · [Config](config/configuration.ts) · [Esempio](.env.example) · E1, E2, E6 |

## Collaudo e tracciamento delle evidenze

I test sono stati eseguiti su copie del candidato separate dal repository, in un namespace locale con `/tmp` privato e rete senza route predefinita. MongoDB, HTTPS, WSS, PTY e SSH/SFTP di prova sono stati esercitati con dati sintetici. **P** indica una prova passata nel perimetro dichiarato. **△** indica copertura parziale o una dipendenza operativa. **F** indica prova fallita. **NV** indica prova non eseguita o evidenza non disponibile.

| ID | Esito e riscontro |
|---|---|
| E1 | **P** · Installazione pulita in ambiente separato, type check backend e frontend, alias lint TypeScript e build cumulativa completati. Installazione runtime pulita con `npm ci --omit=dev --ignore-scripts` e caricamento di Fastify, websocket, multipart, SSH2, MongoDB e dotenv passati. |
| E2 | **P distribuito** · 39/39 file di suite nel gate cumulativo. Il comando `npm test` ha completato 23 suite e si è fermato alla fixture SFTP; le 16 rimanenti sono state eseguite singolarmente. Due esiti iniziali rossi sono stati ripetuti con successo, dopo aver allineato la fixture SFTP alla home remota `/remote` e ripristinato la creazione del log vuoto all’inizializzazione, comportamento richiesto dalla suite backend fase 1. Non risulta un singolo processo `npm test` concluso con codice 0 sul cumulativo. |
| E3 | **P** nelle fixture SSH/PTY/SFTP e di monitoraggio. Due cicli da 100 robot in 6.280 e 6.542 ms, CPU processo 2.645 e 2.836 ms (42% e 43% di un core), RSS da 162,56 a 175,41 MB al picco e heap da 37,89 a 50,28 MB. Cinque connessioni simultanee al picco, zero errori e nessuna connessione attiva a fine ciclo. La prova include server SSH simulato e backend nello stesso processo. Con intervallo configurato a 5 s il ciclo successivo viene omesso finché l’attuale è in corso. |
| E4 | **P** in fixture · Batch 50 e 100 file, rispettivamente 200 e 400 invii misti con byte e SHA-256 verificati. File oltre 1 GiB in tutte le sei direzioni, variazioni heap nelle sei direzioni +2, −7, +2, +2, +1 e −1 MB. Verificati limiti e rilascio slot, mismatch e troncamento, sostituzione atomica, guasto della proiezione, replay e mancato riscontro dopo append, fallback spool con Mongo indisponibile, assenza di duplicati e rotazione conservativa. |
| E5 | **P** · Chrome 156 reale in headless, tre suite completate separatamente. La generale verifica storico e comandi nella finestra nascosta, due robot, clipboard, disconnessione selettiva, logout di tre sessioni terminale, navigazione, ruoli/401/403/200 senza risposte duplicate, modale inattività, 20 cicli logout e progressbar al 35%. La suite bulk verifica cinque scenari, la suite lifecycle tutti i 14 scenari con teardown reale del browser. |
| E6 | **P** · Sul binario consegnato con TLS verificato e MongoDB autenticato, SIGTERM con solo SSE 28 ms, a riposo 35–59 ms, carico misto 7.053 ms e carico misto con SSH/SFTP 7.055 ms. Quest’ultima prova mantiene aperti SSE, WSS con due PTY (server e robot), un download SFTP con richieste READ pendenti, un upload singolo e la ricezione di un batch. Verificati tre annullamenti durevoli e proiettati, chiusura di WebSocket e socket robot e rilascio della shell server. Riavvio sulla stessa porta, revoca del vecchio cookie e nuovo login verificati. Arresto con un comando di polling SSH pendente e SSE in 66 ms, con chiusura del trasporto e persistenza dell’esito del polling. Passato anche l’arresto subito dopo il download dalla copia restaurata. Tutti gli arresti validati sono terminati con codice 0. |
| E7 | **P** · installazione pulita e audit npm runtime/completo 0 advisory. Sono esclusi OS, runtime Node e binari MongoDB/SSH. Versioni effettive NEANTE NV. |
| E8 | **△** · identità dei tre asset pubblici contro il commit base verificata in audit. Confermati in questa fase healthz 200, livez 404, digest SPKI distinti e rifiuto SSH. Il candidato locale include nuovi cambiamenti e non è stato installato. |
| E9 | **P** in fixture · Dump/ripristino Mongo in namespace separato, verifica di utente e vault, confronto byte di archivio, configurazione e log, chiave separata, avvio dalla configurazione ripristinata e download dell’oggetto di prova. Verificati login, flotta, Logs e arresto. **NV** per job, backup, durata e dati aziendali. |
| E10 | **P** · `bash -n` sull’installer e verifica del modello systemd in audit. Il file unità del repository è invariato. Preflight e unità installata da provare con il referente IT. |
| E11 | **P in fixture** · Suite di accettazione del repository terminata con esito 0. Portabilità e hardening input terminano entrambe con esito 0. Le matrici distinguono ciò che le singole prove dimostrano, le evidenze combinate e i casi parziali o operativi. Il riepilogo del test di accettazione, da solo, non attesta una prova su NEANTE né ogni variante di produzione. |

Le esecuzioni intermedie hanno evidenziato l’aspettativa precedente del test di configurazione su polling zero, un tipo documentale Mongo della nuova fixture e il drift documentale della variabile di rotazione ritirata. Sono state corrette le aspettative e la documentazione. Il primo tentativo del controllo SSH/SFTP supplementare attendeva un blocco HTTPS prima di SIGTERM e scadeva durante lo stallo simulato. La ripetizione sincronizza il segnale sulle letture effettivamente pendenti e verifica la chiusura delle connessioni e i tre esiti. Il test di readiness con handshake Mongo sospeso ha inoltre individuato che il journal doveva essere iniettato dall’avvio di produzione, dove il client Mongo è già connesso. La prova Chrome conserva i controlli originali e ne aggiunge su autorizzazioni Logs e avanzamento SSE. La fixture ora attende lo stato ANNULLATO nel DOM prima dell’avviso inattività. La suite lifecycle attende l’uscita di Chrome prima della pulizia del profilo.

## Matrice SRS §§2–11

Sono inclusi tutti i **62 RF** e **30 RNF**. Una riga con più ID condivide l’evidenza e l’esito riportati. Le prove E2–E5 sono da leggere insieme alla tabella di esecuzione e alle limitazioni di E11.

### Requisiti funzionali §3

| Requisito | Esito | Evidenza locale e limite |
|---|---|---|
| RF-AUTH-001, 002 | P | Login con credenziali valide e rigetto credenziali non valide su API e Chrome. Scrypt, salt e provisioning testati. E2, E5, E6. |
| RF-AUTH-003, 004, 006 | P | Sessione server-side, 409, logout, revoca, inattività, sospensione temporanea in trasferimento e scadenza assoluta verificate nelle suite Auth e Security. E2, E5, E6. |
| RF-AUTH-005 | P | Ruoli Admin/Operatore, rifiuto su risorse protette, path per utente e proprietà della sessione. Chrome verifica tre profili HTTP sulle route Logs. E2, E5. |
| RF-ROB-001, 002, 003 | P | Lista, filtro, selezione e dettaglio; query paginata con repository Mongo testato e Dashboard Chrome. E2, E5. |
| RF-ROB-004, 005, 006 | P | Registrazione, parametri SSH e cliente, impianto facoltativo, validazione e duplicati. E2, E11. |
| RF-ROB-007 | P | Verifica in politica rigorosa e differita, fingerprint e connessione verificati con fixture. E3, E11. |
| RF-ROB-008, 009, 010 | P | Directory `<username>_<id>`, aggiornamento albero, preservazione, rollback e recupero DB/FS verificati in locale. E2, E11. |
| RF-ROB-011, 012 | P | Funzionalità inizializzate secondo configurazione e raggiungibilità, stati esito e segnali di errore distinti. E2, E3, E11. |
| RF-ROB-013, 014 | P | Disabilitazione e rimozione anagrafica con dati preservati; registro e connettività distinti. E2, E11. |
| RF-MON-001, 002 | △ | Lettura SSH e parser KV/JSON su fixture. Formato e path dei robot aziendali non convalidati. [Formato stato](STATUS_FILE_FORMAT.md) · E3, E11. |
| RF-MON-003, 004, 005, 006 | P | Polling, refresh, ultimo valido separato da ultimo tentativo, stato stale/mai letto e presentazione testati. E2, E3, E11. |
| RF-SSH-001, 002, 003 | P | PTY remoto, input/output bidirezionale e resize su fixture SSH e WSS; terminale server su Chrome reale. E3, E5, E11. |
| RF-SSH-004 | P | Backend PTY/WSS e comando mantenuto a terminale server e remoto nascosti. Buffer e viewport esercitati in Chrome. E3, E5. |
| RF-SSH-005, 006, 007 | P | Chiusura esplicita, ownership, rifiuti, disconnessione, timeout, errori e cleanup nelle suite terminale e nell’arresto di processo. E3, E5, E6. |
| RF-SSH-008 | △ | La shell usa l’identità SSH configurata senza elevazione automatica nel percorso esaminato. Privilegi, sudoers e configurazione reale non verificati. E3. |
| RF-FS-001, 002, 003 | P | Listing SFTP, metadati, navigazione e limiti di visibilità. E3, E11. |
| RF-FS-004, 005, 006, 007 | P | Download/upload, errori e autorizzazioni per utente/robot/path su fixture. E2–E4. |
| RF-SRVFS-001, 002, 003, 004 | P | Directory dedicata e navigazione; upload e download API su server locale. E2, E4, E5. |
| RF-SRVFS-005, 006, 007 | P | Canonicalizzazione, separazione robot, preservazione directory e cartelle standard configurabili. E2, E4. |
| RF-TRF-001, 002, 003 | P | Direzioni computer↔server, server↔robot e computer↔robot. Browser e server SFTP della prova sono distinti. E3, E4, E11. |
| RF-TRF-004, 005 | P | Payload >1 GiB, streaming/multipart e controllo delta heap nel collaudo locale. E4, E11. |
| RF-TRF-006 | P | DTO e snapshot SSE con byte, velocità ed ETA. Asserzione sul 35% mostrato nel DOM di Chrome. E4, E5, E6. |
| RF-TRF-007, 008, 009 | P | Errori, mismatch checksum, readback, staging e cleanup nei percorsi della suite, con file valido preservato nei casi controllati. E4, E11. |
| RF-TRF-010, 011 | P | Resume e compatibilità del parziale nei casi coperti, gestione conflitto ed esplicita sovrascrittura. E4. |
| RF-TRF-012, 013 | P | Limiti, queue/rigetto, timeout e annullamento singolo/per batch nelle fixture. E4, E6, E11. |
| RF-TRF-014 | △ | Spazio insufficiente e margine verificati con fixture `statvfs` e controlli applicativi. Esaurimento reale su filesystem e volume remoto e gestione su ogni tipo di destinazione da completare. E2, E4. |

### Requisiti non funzionali §4 e vincoli trasversali

| Requisito | Esito | Evidenza locale e limite |
|---|---|---|
| RNF-SEC-001 | △ / F su endpoint | HTTPS/WSS locale testati. Il client standard rifiuta il certificato aziendale esaminato, A02. E3, E6, E8. |
| RNF-SEC-002 | △ | Hash, AES-256-GCM del vault, permessi master key, redazione e assenza di chiavi nel tree corrente verificati. Chiave TLS storica A08 e topologia operativa NV. E2, E6. |
| RNF-SEC-003, 004, 005, 006, 007 | P | Fingerprint, RBAC, canonicalizzazione e symlink, allowlist e vincoli host, sessioni isolate e rifiuti. E2–E5. |
| RNF-SEC-008 | P | Staging e gestione dei temporanei, jail e pulizia con fixture server e SFTP. E4. |
| RNF-SEC-009 | △ | Audit fisico e Mongo provati, inclusi proiezione degli esiti, fallback e replay senza duplicati. Retention aziendale, correlazione delle evidenze e disponibilità dei supporti su NEANTE NV. A04–A06, E2, E4, E9. |
| RNF-FS-001, 002, 003, 004 | P | Permessi effettivi nella fixture DAC, isolamento, preflight/doppia conferma nei flussi coperti, idempotenza e recupero. E2, E4. |
| RNF-PERF-001 | P | >1 GiB e delta heap sotto soglia delle fixture. E4, E11. |
| RNF-PERF-002 | △ | Streaming, chunking, backpressure e delta heap. Campionamento RSS su 100 robot, senza profiling prolungato o picco del processo in produzione. E3–E4. |
| RNF-PERF-003, 004 | P | Limiti utente/robot/server e intervallo configurabile; nessuna sovrapposizione di polling sul medesimo robot nei test. Capacità aziendale aperta, A09. E2–E4. |
| RNF-PERF-005 | P | Nuovi robot tramite anagrafica e configurazione, senza estensioni specifiche nel collaudo SSH/SFTP. La capacità a piena flotta resta aperta. E2–E3. |
| RNF-REL-001, 002, 003, 004 | P | Guasti isolati, stato stale, rollback e file valido preservato nei casi di prova. E2–E4. |
| RNF-REL-005 | P | Disconnessione, annullamento e shutdown compilato con SSE, WSS/PTY e trasferimenti concorrenti. Budget e residui controllati in ambiente locale. E3, E5, E6. |
| RNF-UX-001, 002 | P | Navigazione, focus, feedback, filtri e gestione errori negli scenari browser esercitati. E5. |
| RNF-UX-003 | P | Chrome reale di fixture è il browser indicato dall’SRS. Browser e postazioni del deployment NV. E5. |
| RNF-UX-004 | P | PTY, resize, copia/incolla, scrollback a riapertura e disconnessione in Chrome. E3, E5. |
| RNF-MNT-001, 002 | P | Configurazione Zod/ambiente, precedenze, limiti e moduli separati. La configurazione effettiva NEANTE resta NV. E1, E2, E6. |
| RNF-MNT-003 | P | Catalogo, classificazione, diagnostica, redazione, segnalazione esplicita del guasto e runbook. Uso operativo NEANTE NV. E2, E4, E9. |
| §§2.1–2.5, architettura e ambiente | △ | Separazione dei ruoli, accoppiamento browser/backend e assenza di SSH diretto per costruzione, HTTPS locale e modello Ubuntu/systemd. VPN, FQDN, runtime e policy firewall aziendali NV. E3, E6, E8, E10. |
| §§5–6, componenti e flussi | △ | Flussi app/API, storage, autenticazione, registrazione, monitoraggio, terminale e trasferimenti esercitati in locale. Flussi installati su NEANTE NV. E2–E6, E11. |
| §8, registrazione | P | Politiche rigorosa/differita, unicità ID e username per host o globale, cartella dedicata, modifica, disabilitazione e rimozione con preservazione. E2, E3, E11. |
| §9, errori | △ | Catalogo con classificazione, risposte pubbliche e diagnostica separata. Chrome verifica i dinieghi Logs. Dipendenze e log operativi effettivi NV. E2, E5. |
| §10, dati e persistenza | △ | Repository Mongo e indici, recupero utenti e vault, journal trasferimenti e proiezione con riavvio nelle fixture. Backup coordinato aziendale NV. E2, E4, E9. |
| §11.1–11.3, filesystem, SSH e registrazione | △ | Scelte implementate e verificabili con fixture. Effective config, permessi, policy, DNS/whitelist, chiavi host e permessi degli account operativi NV. E2, E3, E8. |
| §11.4–11.7, monitoraggio, limiti e profili | △ | Parametri regolabili e validati, modalità di checksum e resume, ruoli e vincoli. Formato reale, profilo di flotta, dimensionamento e impostazioni firmate dal referente NV. E2–E4. |

### Criteri di accettazione §7

| Criterio | Esito | Osservazione o limite |
|---|---|---|
| CA-AUTH-001, 002 | P | Login valido e invalido, API e Chrome. |
| CA-AUTH-003 | P | Rifiuti per ruolo, proprietario e risorsa in test Auth, security e Chrome Logs. |
| CA-ROB-001, 002 | P | Dati validi e campi obbligatori invalidi sulle fixture. |
| CA-ROB-003 | P | Verifica SSH e politica rigorosa/differita, esiti distinti. |
| CA-ROB-004, 005, 006 | P | Directory dedicata, idempotenza, dati preesistenti e unicità. |
| CA-ROB-007, 008, 009 | P | Accesso directory negato con DAC, rollback e percorso non autorizzato riportati. |
| CA-ROB-010, 011, 012 | P | Robot presente, azioni secondo permessi, rimozione senza perdita di file e robot irraggiungibile ancora visibile. |
| CA-MON-001 | △ | Lettura e stato interpretato in fixture. Il contratto effettivo dei file dei robot deve essere confermato. |
| CA-MON-002, 003, 004 | P | Intervallo, refresh e conservazione dell’ultimo stato valido. |
| CA-SSH-001, 002, 003 | P | Apertura e interazione PTY/WSS, output progressivo e resize nei percorsi di prova. |
| CA-SSH-004, 005 | P | Chiusura sessione, rilascio risorse per il singolo terminale e isolamento testati sul backend. E3. |
| CA-FS-001, 002, 003, 004 | P | Listing SFTP, upload/download server, server↔robot e client↔robot. La prova CA-FS-002 nella suite di accettazione è integrata da `storage/server-fs.test.ts` e `backend/transfer/transfer.test.ts` per l’upload. |
| CA-TRF-001 | P | Streaming >1 GiB con delta heap misurato. |
| CA-TRF-002 | P | Barra e ARIA aggiornate al 35% in Chrome da stato streaming del backend. E5. |
| CA-TRF-003, 004, 005 | P | Interruzione distinta da completamento, mismatch checksum, destinazione esistente preservata nei casi coperti, con evidenze delle suite trasferimenti e affidabilità. |
| CA-TRF-006 | △ | La suite di accettazione verifica un diniego di permesso con questo ID. Hardening verifica margine con spazio simulato, e le altre suite coprono singole forme di errore/timeout. Esaurimento di disco e timeout end-to-end rappresentativo su tutte le destinazioni restano da provare. |
| CA-TRF-007 | P | Limiti simultanei e rilascio degli slot nelle fixture. |

### Obiettivi essenziali §12

| N. | Obiettivo | Esito ed evidenza |
|---:|---|---|
| 1 | Username e password | P · E2, E5, E6. |
| 2 | Visualizzazione e gestione flotta | P · E2, E5. |
| 3 | Registrazione autorizzata con parametri di connessione | P · E2, E3, E11. |
| 4 | Validazione e verifica secondo policy | P · E2, E3. |
| 5 | Directory robot creata o verificata | P · E2, E11. |
| 6 | Coerenza anagrafica/filesystem in errore | P · E2, E11. |
| 7 | Lettura e interpretazione stato via SSH | △ · E3, E11, formato reale NV. |
| 8 | Stato periodico e su richiesta | P · E2, E3. |
| 9 | Terminale Linux interattivo nel browser | P · E3, E5, terminale integrato con storico preservato. |
| 10 | Navigazione filesystem remoto e server | P · E2–E5. |
| 11 | Upload/download tra computer, server e robot | P · E4, E11. |
| 12 | Backend intermediario | P · Architettura e prove locali E3–E4. |
| 13 | File >1 GB in streaming | P · E4, E11. |
| 14 | Avanzamento, errori, timeout, integrità e temporanei | △ · E4–E6, E11. Rimane da chiudere CA-TRF-006 in condizioni rappresentative. |
| 15 | Protezione di credenziali, sessioni, directory e flotta | △ · E2–E4, requisiti operativi A02, A08. |
| 16 | Eventi e informazioni diagnostiche | P · E2, E4, E5. Retention e workflow operativi di NEANTE NV. |
| 17 | Separazione fra stato anagrafico, raggiungibilità e stato operativo | P · E2, E11. |
| 18 | Nuovi robot compatibili senza cambi codice | P · E2, E3. |

### Integrazioni normative in coda al TXT SRS

| Gruppo e punto | Esito ed evidenza |
|---|---|
| Estensione 1 · Sessioni, 15/30 min, avviso 5 min, username univoci, terminali Admin | △ · Config, unitari e API per limiti, inattività e nomi univoci. E5 per i percorsi browser eseguiti. Verifica con tempi effettivi e terminale nascosto sul deployment NV. |
| Estensione 2 · Config operativa, 10 utenti, limiti terminali, batch/3 GB, estendibilità | P · Configurazione e concorrenza, validazione e precedenze nei test. Il valore di 3 GB è stato verificato come configurazione. Il trasferimento end-to-end a quel limite resta NV. |
| Estensione 3 · Bulk multi-target, ruoli, conflitti e annullamento | P · Suite bulk, UI per selezione e destinazione e vincoli path. Prove sui terminali e sui permessi distinte. |
| Estensione 4 · Cliente e impianto | P · Campi anagrafici, cliente richiesto e impianto opzionale nel backend e nelle fixture. |
| Estensione 5 · Filtri, Bootstrap, logo Home, React | P · Build React/Bootstrap, filtri, logo Home e navigazione Chrome. |
| Specifiche 1 · Cliente obbligatorio e impianto facoltativo | P · API, schema e test flotta. |
| Specifiche 2 · Popup Gestione File e path a scelta o manuale | P · Chrome esercita apertura, metadati e validazione del percorso della modale Gestione File. E5. |
| Specifiche 3 · Config e path per operatore | P · Test configurazione, RBAC e jail. |
| Specifiche 4 · Conferma, esci e sospensione inattività durante trasferimento | P · Conferma, uscita e sospensione validate nelle suite backend. Modale della sessione e logout verificati anche in Chrome. E3, E5. |
| Specifiche 5 · Conferma eliminazione e conteggio file | △ · Preflight e conteggio ricorsivo testati lato server, componenti di conferma presenti. Copertura interfaccia di tutti i percorsi e produzione aperta. |
| Specifiche 6 · Concorrenza della sessione | P · Gate 409, configurazione e test simultanei. |
| Specifiche 7 · Nessun pulsante terminale per Operatore | P · Guardia API, rendering condizionale e regressione dei ruoli. E2, E3, E5. |
| Specifiche 8 · Logs amministratore, campi, esiti e delimitatori | P · Accesso per ruolo, righe esito, delimitatori, filtri e download in Chrome e nelle suite backend. E4, E5. |
| Specifiche 9 · Annullamento dell’intero batch, parziali e completati | P · Suite bulk con annullamento in corso, protezione del completato, pulizia e ripresa applicate secondo il tipo di operazione testato. Traffico reale NV. |


## Pacchetto cumulativo, rollback e gate aziendale

Il [pacchetto manuale cumulativo](/home/azghari/.codex/visualizations/2026/11/27/01a21c54-d166-7000-8ae8-e9a320e8fa9a/MOLIRIS_NEANTE_CUMULATIVE_UPDATE_2026-11-27.tar.gz) contiene sorgenti, build, manifest integrale e digest dei componenti runtime. Il [checksum esterno](/home/azghari/.codex/visualizations/2026/11/27/01a21c54-d166-7000-8ae8-e9a320e8fa9a/MOLIRIS_NEANTE_CUMULATIVE_UPDATE_2026-11-27.tar.gz.sha256) e i digest interni sono stati verificati. L’archivio esclude certificati, chiavi, file ambiente effettivi, metadati Git, dipendenze installate e dati operativi. Installazione dipendenze e compilazione hanno usato directory separate. Il [runbook manuale](docs/NEANTE-MANUAL-UPDATE.md) prevede account stage, unità utente, preflight, backup, attivazione e ritorno al runtime precedente.

Lo scambio e il rollback sono stati eseguiti in una fixture filesystem. I digest di ambiente, configurazione, archivio e log sono rimasti identici in entrambe le direzioni. La prova distingue il rollback del runtime dal ripristino coordinato dei dati. Il modello applicativo distribuito e i sorgenti installati su NEANTE richiedono verifica IT. La riconciliazione dei quattro commit GitHub è disponibile nel pacchetto come sorgenti completi e build.

### Condizioni rimanenti di consegna

1. IT deve attestare unità, PID, binario effettivo, runtime e sorgenti su NEANTE e verificare la pubblicazione di readiness e liveness.
2. IT deve convalidare il TLS delle postazioni e i percorsi SSH/SFTP verso robot autorizzati. Il collaudo locale ha usato esclusivamente hardware di prova o simulato.
3. IT deve attestare backup, retention, ripristino operativo e una finestra per il cambio manuale. Il rollback del runtime è stato provato in locale.
4. Verificare a piena flotta i tempi effettivi, inclusi congestione e scadenze, e completare il collaudo SRS su profili reali e nelle condizioni indicate come parziali.

**VERDICT: FAIL — NO-GO operativo su NEANTE.** Il candidato applicativo locale è pronto per la revisione IT. Il rilascio richiede ancora la riconciliazione dei sorgenti e del runtime installati, la convalida di TLS e liveness, la prova del backup aziendale e il collaudo operativo sui robot. Per la verifica diretta di NEANTE l’accesso SSH di `stage` è stato rifiutato. Nessuna installazione è stata eseguita.

### Tracce di collaudo

- [Chrome generale](/home/azghari/.codex/visualizations/2026/11/27/01a21c54-d166-7000-8ae8-e9a320e8fa9a/.moliris-stabilization/evidence/chrome-sync/chrome.log) · [Chrome bulk](/home/azghari/.codex/visualizations/2026/11/27/01a21c54-d166-7000-8ae8-e9a320e8fa9a/.moliris-stabilization/evidence/browser-final/bulk-chrome.log) · [Chrome lifecycle](/home/azghari/.codex/visualizations/2026/11/27/01a21c54-d166-7000-8ae8-e9a320e8fa9a/.moliris-stabilization/evidence/lifecycle-sync/lifecycle.log)
- [Regressione cumulativa](/home/azghari/.codex/visualizations/2026/11/27/01a21c54-d166-7000-8ae8-e9a320e8fa9a/.moliris-stabilization/evidence/regression-integrated-final/regression.log)
- [SIGTERM con SSE](/home/azghari/.codex/visualizations/2026/11/27/01a21c54-d166-7000-8ae8-e9a320e8fa9a/.moliris-stabilization/evidence/process-delivery/sse.log) · [carico misto, riavvio e restore](/home/azghari/.codex/visualizations/2026/11/27/01a21c54-d166-7000-8ae8-e9a320e8fa9a/.moliris-stabilization/evidence/process-delivery/restored.log)
- [Preflight pubblico NEANTE](/home/azghari/.codex/visualizations/2026/11/27/01a21c54-d166-7000-8ae8-e9a320e8fa9a/.moliris-stabilization/evidence/neante-readonly.log) · [swap e rollback](/home/azghari/.codex/visualizations/2026/11/27/01a21c54-d166-7000-8ae8-e9a320e8fa9a/.moliris-stabilization/evidence/package/swap-test.log) · [contratto Gravitas](/home/azghari/.codex/visualizations/2026/11/27/01a21c54-d166-7000-8ae8-e9a320e8fa9a/.moliris-stabilization/session/contract.json)

- [SIGTERM con SSH e SFTP attivi](/home/azghari/.codex/visualizations/2026/11/27/01a21c54-d166-7000-8ae8-e9a320e8fa9a/.moliris-stabilization/evidence/process-delivery/ssh-sftp-retest.log) · [SIGTERM durante polling periodico](/home/azghari/.codex/visualizations/2026/11/27/01a21c54-d166-7000-8ae8-e9a320e8fa9a/.moliris-stabilization/evidence/process-delivery/polling-transport.log) · [build del binario consegnato](/home/azghari/.codex/visualizations/2026/11/27/01a21c54-d166-7000-8ae8-e9a320e8fa9a/.moliris-stabilization/evidence/rebuild-delivery/build.log)
- [Esiti della seconda parte della regressione](/home/azghari/.codex/visualizations/2026/11/27/01a21c54-d166-7000-8ae8-e9a320e8fa9a/.moliris-stabilization/evidence/regression-tail/results.tsv) · [ripetizione fixture SFTP](/home/azghari/.codex/visualizations/2026/11/27/01a21c54-d166-7000-8ae8-e9a320e8fa9a/.moliris-stabilization/evidence/regression-sftp-fixture/results.tsv) · [ripetizione backend fase 1 e journal Mongo](/home/azghari/.codex/visualizations/2026/11/27/01a21c54-d166-7000-8ae8-e9a320e8fa9a/.moliris-stabilization/evidence/final-logger/results.tsv) · [suite accettazione](/home/azghari/.codex/visualizations/2026/11/27/01a21c54-d166-7000-8ae8-e9a320e8fa9a/.moliris-stabilization/evidence/regression-tail/tests_acceptance_acceptance.test.ts.log) · [sei direzioni oltre 1 GiB](/home/azghari/.codex/visualizations/2026/11/27/01a21c54-d166-7000-8ae8-e9a320e8fa9a/.moliris-stabilization/evidence/regression-tail/tests_reliability-performance_reliability-perf.test.ts.log)
- [Manifest pacchetto verificato](/home/azghari/.codex/visualizations/2026/11/27/01a21c54-d166-7000-8ae8-e9a320e8fa9a/.moliris-stabilization/evidence/package/cumulative-contents-check.log) · [digest runtime e archivio](/home/azghari/.codex/visualizations/2026/11/27/01a21c54-d166-7000-8ae8-e9a320e8fa9a/.moliris-stabilization/evidence/package/final-bundle.log)
