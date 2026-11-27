# Audit finale di consegna · Moliris Maintenance Web App

**27 novembre 2026 · Verdetto NO-GO**

**Candidato** · [GitHub `main`, commit `039940800c79ed2bba73af59a72074841c38b3a1`](https://github.com/marcomili0009-gif/Moliris_Maintenance_Webapp_SRS/commit/039940800c79ed2bba73af59a72074841c38b3a1)

Il candidato implementa i flussi principali dell’SRS con separazione fra browser, API, storage e connessioni ai robot. Il collaudo locale ha confermato diverse proprietà operative, compresi i trasferimenti, il controllo di integrità e la registrazione dei loro esiti. Il rilascio è bloccato dall’arresto fuori budget con uno stream SSE attivo, dal certificato dell’endpoint aziendale, dalla mancata attestazione del backend installato e dall’assenza di collaudo operativo su robot e ripristino di produzione.

## Perimetro e criteri di valutazione

- Baseline normativa · [PDF SRS](Moliris_Maintenance_Webapp_SRS.pdf) §§2–12 e [specifiche aggiuntive in coda al TXT, righe 1673–1737](Moliris_Maintenance_Webapp_SRS.txt#L1673). I criteri e gli obiettivi sono stati ricontrollati sulla baseline. La [checklist precedente](docs/04-CHECKLIST-VERIFICA.md) attribuisce, per esempio, numerazioni diverse a RF-ROB-009..013. La matrice qui segue la numerazione ufficiale.
- Inventario del commit · 836 file tracciati, di cui 569 sotto `.agent/`. La revisione ha seguito l’intero inventario e i percorsi di esecuzione del prodotto, inclusi backend, client, storage, configurazione, test, script operativi, unità systemd e documenti. Gli strumenti e gli asset di supporto all’agente non fanno parte del prodotto distribuito.
- Locali · Copie del commit da `git archive`, Node 22.22.1, npm 9.2.0, MongoDB 9.0.4 temporaneo, server HTTPS/Fastify, fixture ssh2/SFTP e Chrome 156.0.8078.47. Esecuzione dinamica in namespace di rete e mount con `/tmp` dedicato, senza route predefinita. Uso delle dipendenze già installate per la suite. Dati e chiavi delle fixture generati localmente.
- NEANTE · Letture pubbliche HTTPS all’indirizzo aziendale indicato nei report precedenti. DNS del nome corto senza risultato nell’ambiente di audit. Nessun accesso autenticato al sistema o al prodotto. Nessuna modifica al codice, commit, deploy, riavvio remoto o prova con scrittura su robot o dati aziendali.
- **P** · Prova locale pertinente passata entro il perimetro indicato. **△** · Evidenza parziale, dipendenza operativa o copertura incompleta. **F** · Esito contrario al requisito o al gate indicato. **NV** · Verifica non eseguita o non verificabile. Ogni esito della matrice è locale salvo indicazione esplicita. Per i requisiti autenticati o hardware, NEANTE resta **NV**.

## Esiti dei test ed evidenze ripetibili

| ID | Verifica | Esito ed evidenza |
|---|---|---|
| E1 | Type check e build | **P** · `npm run typecheck`, `npm run typecheck:client`, `npm run lint` e `npm run build` tutti exit 0. Il lint del progetto è un alias di `tsc --noEmit`. Vite 8.3.8 ha prodotto il bundle principale JS 462,25 kB, 131,20 kB gzip, il chunk xterm 330,92 kB, 83,01 kB gzip, e CSS principale 257,62 kB, 37,19 kB gzip. |
| E2 | Unitari, API, MongoDB, sicurezza e regressione | **F** · `npm test` exit 1 su Chrome, dopo 18 suite. Le 15 suite successive sono state lanciate singolarmente e sono uscite 0. Bilancio dei 34 file npm · 33 passati, 1 fallito. Due suite aggiuntive del prodotto sono passate. MongoDB era reale e isolato, compresi repository, indici, errori e credenziali. Nel totale sono conteggiati file, non singole asserzioni. |
| E3 | SSH, SFTP e terminali | **P** · `connection.test.ts`, `monitoring.test.ts`, `state-file-parser.test.ts`, `terminal.test.ts` e `remote-fs.test.ts` hanno superato i controlli. Verificati handshake, fingerprint valida/difforme, credenziali, host irraggiungibile, SSH PTY e WSS, sessioni concorrenti, disconnessione e cleanup del singolo terminale, listing, upload/download e dinieghi SFTP. Robot simulati su TCP locale. |
| E4 | File, checksum, batch e prestazioni | **P** nelle fixture · Suite transfer, bulk upload jail, hardening trasferimenti e affidabilità passate. Bulk con 100 file e quattro destinazioni, 400 invii con byte e SHA-256 verificati. Verificati checksum non coincidente, destinazione esistente preservata, timeout SFTP, annullamenti, path e .part. Righe esito, filtri, storico e download verificati dopo riapertura backend nella fixture bulk. Prove >1 GiB nelle sei direzioni con delta heap finale in MB, nell’ordine computer→server, server→computer, server→robot, robot→server, computer→robot, robot→computer · **+2, −11, 0, 0, +1, 0**. Il delta può essere negativo per garbage collection. Nessuna misura di picco RSS. |
| E5 | Chrome reale locale | **F** · Test integrale fallito due volte su `ALPHA_LINE` dopo riapertura e scroll del terminale server, [riga 1910](client/react-frontend.test.ts#L1910). Prima del blocco sono passati errori login, ruoli e navigazione Logs, archivio, selettore robot, resize/Ctrl+C e copia-incolla PTY. Le modalità predefinite `SESSION_CONFLICT_ONLY`, `LOGOUT_ONLY` e `LOGOUT_CYCLES_ONLY` hanno ciascuna exit 0. Verificati conflitto senza errore generico, 20 login/logout, risposta sospesa senza invalidare la nuova sessione, rete assente/riconnessione, Indietro e refresh. I controlli dopo riga 1910 restano NV in Chrome, inclusi disconnessione del job legato a questo scenario, due robot, vista Gestione File e controllo finale di log e navigazione. |
| E6 | Processo compilato con profilo produzione | **F** sul gate SIGTERM, **P** su avvio e riavvio a riposo. TLS verificato con certificato fixture e Mongo autenticato con ruolo limitato. Due osservazioni · SIGTERM a riposo exit 0 in 22 e 45 ms. Readiness al riavvio in 1.401 e 2.017 ms, vecchio cookie 401, nuovo login 200. Con SSE autenticato aperto il processo era ancora attivo a **16.500 ms** in entrambe le prove, uscita 0 a 16.526 e 16.530 ms dopo la chiusura dello stream da parte del client. Arresto con job reali, quota disco ed esiti non scaricati NV. |
| E7 | Dipendenze | **P** · `npm audit --omit=dev --json` e `npm audit --json` entrambi exit 0, 0 advisory in ogni fascia sul lockfile. Sono esclusi dal risultato il runtime Node e i pacchetti OS. |
| E8 | GitHub e NEANTE pubblico | **P** per identità GitHub e tre asset pubblici. **F** per trust TLS sul percorso esaminato. **NV** per binario backend, unità installata e verifica autenticata. Dettagli nella sezione NEANTE. |
| E9 | Backup e ripristino | **P** parziale in locale · `mongodump` e `mongorestore` hanno ripristinato un namespace Mongo separato. Verificati utente e decifratura della credenziale sintetica del vault con la chiave originale. **NV** su NEANTE per backup effettivo, filesystem/log, custodia della chiave, RPO/RTO, retention e ripristino coordinato. |
| E10 | Unità systemd | **P** · `systemd-analyze verify moliris.service` ha restituito 0 fuori sandbox. Analisi sintattica del modello. Esecuzione dell’unità, override e sandbox effettiva di NEANTE **NV**. |
| E11 | Accettazione SRS e suite fuori da npm test | **P** per exit 0 di `tests/acceptance/acceptance.test.ts`, `tests/portability/server-portability.test.ts` e `tests/security/input-validation-hardening.test.ts`. La stampa finale della prima suite dichiara 35 criteri e 18 obiettivi. Le asserzioni di CA-TRF-002 misurano metadati backend, quelle di CA-TRF-006 un diniego e quelle di CA-FS-002 il lato lettura. La matrice associa le prove complementari oppure lascia il criterio parziale. |

Le prime esecuzioni incomplete hanno isolato problemi dell’ambiente di prova. Il socket Unix predefinito di MongoDB interferiva con un socket del sistema e il namespace è stato configurato con MongoDB solo TCP. Un’esecuzione con capacità Linux attive ha falsato il controllo DAC della flotta. Il `/tmp` condiviso ha esaurito la quota e un percorso lungo del profilo Chrome ha impedito il collegamento CDP in un’altra esecuzione. Il collaudo conclusivo usa capacità rimosse, un mount privato su disco e un percorso temporaneo breve. Un’approvazione automatica ha respinto una variante diagnostica che avrebbe proseguito dopo l’asserzione scrollback, per il rischio di indebolire il segnale della regressione. La variante non è stata eseguita. Le prove Chrome integrali hanno mantenuto il test originale.

### Verifiche non eseguite

Chrome autenticato su NEANTE e su altre postazioni, Firefox e Safari, test contro robot o VM reali, carico prolungato su flotta aziendale con RSS e percentili, interruzione di rete reale fra NEANTE e robot, arresto o riavvio di NEANTE, lettura di unità e journal remoti, prove con fault hardware e disco di produzione pieno, ripristino di backup aziendale, scansione del sistema operativo installato e reinstallazione completa a freddo delle dipendenze. Le prove applicative di sicurezza hanno usato fixture isolate e i test difensivi del progetto.

## Stato NEANTE e corrispondenza con GitHub

| Controllo | Risultato |
|---|---|
| GitHub `main` | Connettore GitHub Compare · `identical`, 0 commit avanti o indietro. `HEAD` e `origin/main` locali hanno lo stesso SHA. |
| Certificato su `192.168.32.29:8443` | `curl` con verifica standard è uscito 60, HTTP 000. Certificato autofirmato, CN pari all’IP, nessuna estensione SAN, validità dal 26/11/2026 al 26/11/2027, fingerprint SHA-256 `98:A5:DD:31:57:C3:B5:68:11:24:16:71:BD:47:1B:70:54:A8:B0:4C:0C:88:D9:7F:8A:5C:BD:45:93:76:85:BE`. |
| Risorse pubbliche | Sonda diagnostica senza verifica di fiducia e senza credenziali. HTTP 200 su `/` e `/healthz` con `status=OK`. HTTP 404 su `/livez`, route presente in [backend/server.ts](backend/server.ts#L578). Il risultato può dipendere dal backend o dal percorso di pubblicazione. L’attestazione della versione o del controllo MongoDB richiede evidenza aggiuntiva rispetto al 200 di `/healthz`. |
| HTML | SHA-256 uguale in locale e remoto · `21c49f6182064858a7fdfff79518f3bd3640776398eec0605b01dccf7ef22a3c`. |
| Bundle JS `index-GSf30j10.js` | SHA-256 uguale · `8ec61c1a7ec9468ee4133a25ba279c4a74fb206c7ddea3f8e6040f797153e333`. |
| CSS `index-GAeHec2n.css` | SHA-256 uguale · `01e5536074c415721724f191342dc99a5c3bef856eb9be85cf94e29b44128ac1`. |
| Backend, unità, DB, account e rete robot | **NV** · Servono attestazione SHA dell’artefatto e informazioni in sola lettura su unità effettiva, runtime, readiness, vault, configurazione, permessi, canali e log. Il [report del 26 novembre](MOLIRIS_POST_AUDIT_FIX_REPORT.md) documenta un precedente rifiuto SSH. Quel tentativo è storico e non costituisce una verifica odierna. |

## Rilievi e rischi di consegna

| ID | Gravità e stato | Evidenza, conseguenza e intervento richiesto |
|---|---|---|
| A01 | **Alta · riprodotto localmente** | **SIGTERM supera il limite con SSE attivo.** `/api/transfers/stream` usa risposta hijacked e heartbeat. La chiusura è legata a disconnessione o revoca sessione. Il signal handler attende `server.close()` prima di completare la pulizia. Il processo era in attesa a 16,5 s e si è chiuso alla disconnessione del client. L’unità nel repository concede 15 s. Il test individua un percorso compatibile con un timeout systemd. L’origine dei precedenti 90 s rimane indeterminata senza journal e unità effettiva. Serve drenare SSE e gestire trasferimenti, PTY/WSS e audit entro un budget prima dell’uscita. [Route SSE](backend/transfer/transfer-routes.ts#L620) · [Shutdown](backend/server.ts#L825) · [Unità](moliris.service#L23) |
| A02 | **Alta · osservato su endpoint pubblico** | **TLS dell’endpoint aziendale privo di fiducia e SAN.** Il trust store standard rifiuta la connessione e l’IP manca da SAN. Prima della consegna usare nome/IP operativo con SAN e catena riconosciuta dalle postazioni, poi verificare HTTPS e WSS senza eccezioni. |
| A03 | **Alta · evidenza insufficiente su NEANTE** | **Backend runtime non attestato.** Gli asset osservati corrispondono alla build. `/livez` restituisce 404. Finché checksum del backend avviato, commit, PID, unità effettiva e percorso di pubblicazione restano privi di evidenze, flotta, ruoli, terminali e trasferimenti su NEANTE non sono approvati. |
| A04 | **Alta · requisito operativo aperto** | **Ripristino aziendale non dimostrato.** La guida copre provisioning, hardening e start/stop. Manca una procedura verificabile coordinata per database, filesystem/archivio, esiti, configurazione, chiavi e rollback, con RPO, RTO, retention e responsabilità. L’attestazione del backup di produzione richiede evidenze del job e una prova di ripristino dei dati previsti dal runbook. [Guida deploy](DEPLOY.md) |
| A05 | **Alta · analisi statica** | **Durabilità degli esiti degrada in caso di errore di scrittura.** Esiti finali presenti nel log fisico in condizioni normali. Una scrittura fallita viene catturata e segnalata nel logger diagnostico. Il ramo deduplica la promessa per il record e manca una ripetizione persistente, una coda durevole o una riconciliazione. Le evidenze si possono frammentare fra Mongo e log, soprattutto con disco non scrivibile o uscita forzata. Serve un esito recuperabile, monitoraggio della scrivibilità e verifica su guasto controllato. [Scrittura fisica e deduplicazione](backend/transfer/transfer-service.ts#L3150) · [Esito terminale](backend/transfer/transfer-service.ts#L3214) |
| A06 | **Media · analisi statica** | **Crescita indefinita di `transfers.log`.** Il file è append-only con esclusione esplicita dalla rotazione applicativa, mentre `access.log` ruota. Lo storico trasferimenti è esposto anche come download. Va definita una retention dimensionata con archiviazione verificabile, alert sul disco e comportamento concordato sui log precedenti. [Logger](backend/logging/physical-file-logger.ts#L218) |
| A07 | **Media · analisi statica** | **Due configurazioni possono assegnare la stessa directory log a identità diverse.** `moliris.service` usa `/var/log/moliris` con `User=moliris` e `LogsDirectoryMode=0700`. L’installer locale usa la stessa directory anche per il journal su file di MongoDB. Il conflitto dipende dalla coesistenza effettiva. Separare i percorsi e verificarne owner e modi nella configurazione di consegna. [Unità](moliris.service#L8) · [Installer](scripts/install-local-server.sh#L92) |
| A08 | **Media · verificato nello storico Git** | **Chiave privata TLS di sviluppo tracciata in uno storico raggiungibile.** `70c65f4` aggiunge `dev-certs/key.pem` e il certificato autofirmato con CN localhost, `8b35e73` rimuove i file dal tree successivo. La chiave storica è stata riconosciuta come PEM da OpenSSL, senza riportarne il contenuto. Riutilizzo fuori dallo sviluppo non verificato. Trattarla come pubblica, verificare dove sia stata usata e sostituire eventuali copie operative. |
| A09 | **Media · copertura di capacità incompleta** | **Carico alla taglia prevista senza misura rappresentativa.** Il polling carica gli elementi del repository e avvia un lavoro per ogni robot eleggibile con guardia per ID. Il profilo operativo propone 100 robot e intervallo 5 s. Misurare durata giro, errori, code, CPU, RSS, occupazione disco e p95/p99 sotto il profilo di consegna. [Polling](backend/monitoring/monitoring-service.ts#L63) · [Profilo](config/config.json) |
| A10 | **Media · runtime QA inferiore alla baseline di patch** | Node locale 22.22.1 precede la release di sicurezza 22.23.5. L’applicabilità dei singoli advisory al processo Moliris resta da verificare. Versione di NEANTE ignota. Includere nel manifest release le versioni patchate di Node, MongoDB, OpenSSL e OS e verificare il candidato con quelle versioni. [Bollettino Node.js](https://nodejs.org/en/blog/vulnerability/november-2026-security-releases/) |
| A11 | **Bassa · documentazione e qualità** | Il lint coincide con il type check, non risultano workflow versionati in `.github/` e due suite di prodotto sono fuori da `npm test`. README usa link `file://` legati a un’altra home. La tracciabilità cita prove fuori contesto e alcune coperture sono sovrastimate dai messaggi della suite. Collegare un gate ripetibile, correggere i link e riportare SHA, runtime, matrice e limiti di ogni collaudo. [Script npm](package.json#L7) · [README](README.md#L174) · [Suite accettazione](tests/acceptance/acceptance.test.ts#L769) |
| A12 | **Media · riprodotto in Chrome** | **Il test di storico del terminale server fallisce due volte.** La sessione, il socket e il comando lanciato a finestra nascosta sopravvivono, e alla riapertura è visibile `HIDDEN_COMPLETE`. Dopo lo scroll simulato la suite non vede `ALPHA_LINE` in xterm. Il DOM visibile non permette di stabilire se la riga sia persa nel buffer o se scorrimento e rendering la lascino fuori viewport. Il gate browser resta fallito. Verificare scrollback dopo ridimensionamento e riapertura con un’asserzione sul buffer o sull’effettiva posizione di scroll, oltre alla prova visiva. [Test](client/react-frontend.test.ts#L1888) |
| A13 | **Media · osservato in Chrome e correlato ai log backend** | **Errori lato server sulle route Logs durante il cambio di account.** Sono comparse quattro occorrenze `ERR_HTTP_HEADERS_SENT` per lettura e download dei log. Le asserzioni di visibilità e rifiuto per l’operatore sono passate. L’esatta origine della seconda operazione sugli header resta da localizzare. Verificare il completamento univoco della risposta nelle transizioni di sessione e l’audit del rifiuto. [Guardia richieste](backend/auth/auth-middleware.ts#L65) · [Route Logs](backend/logging/log-routes.ts#L44) |
| A14 | **Bassa · osservato al bootstrap locale** | **Zero sul polling con semantiche diverse tra schema e servizio.** Il processo compilato rifiuta `MOLIRIS_POLLING_INTERVAL_SEC=0` perché lo schema richiede almeno 1. Il servizio, se invocato direttamente, interpreta zero come polling disabilitato. Allineare documentazione, comportamento di bootstrap e test prima di documentare la possibilità di disattivarlo. [Schema](src/config/schema.ts#L178) · [Servizio](backend/monitoring/monitoring-service.ts#L63) |

**Critici** · Nessun difetto classificato critico è stato confermato nel perimetro esercitato. Le aree senza accesso operativo restano indeterminate.

### Architettura, sicurezza e operabilità

- Fastify compone autenticazione, autorizzazione, SSH/SFTP, filesystem, flotta, monitoraggio, terminali e trasferimenti. React usa API same-origin e il backend connette i robot. I repository Mongo e le implementazioni in memoria permettono prove ripetibili di route e servizi. [Composizione](backend/server.ts) · [API client](client/src/services/api-client.ts) · [Architettura](ARCHITECTURE.md)
- I punti con maggiore rischio di regressione sono la composizione nel server, gli stati del terminale, il cleanup e la durabilità dei trasferimenti. `transfer-service.ts` ha 4.818 righe, `terminal-service.ts` 1.225 e `DashboardView.tsx` 774. Per la consegna conta dimostrare le transizioni operative in pre-close, i fallimenti parziali e i confini fra pre-check, commit del file e audit. [Trasferimenti](backend/transfer/transfer-service.ts) · [Terminali](backend/terminal/terminal-service.ts) · [Dashboard](client/src/views/DashboardView.tsx)
- Controlli osservati nel codice e nelle suite · hash scrypt, cookie protetti, scadenza e revoca server-side, rate limit locale, controlli Origin/Referer, CSP/HSTS, pinning della chiave host, allowlist SSH, chiamate mediate dal backend, controllo del proprietario delle sessioni e jail dei path. Sessioni, limiti e rate limit in memoria definiscono un perimetro a singolo processo. Topologia a più istanze e persistenza distribuita restano fuori dalla verifica. [Auth](backend/auth/auth-routes.ts) · [Ruoli](backend/auth/permissions.ts) · [Path](backend/auth/path-authorization.ts) · [Chiave host](backend/connection/host-key-verifier.ts)
- Il terminale server è una shell amministrativa con i privilegi dell’account del servizio. Bash e `script` sono dipendenze operative della funzione. Verificare esistenza dei binari, identità e sandbox effettiva sulla macchina di consegna. La shell dei robot usa le credenziali SSH configurate. [Terminale](backend/terminal/terminal-service.ts#L704) · [Unità](moliris.service#L8)
- `409` per sessione già attiva, revoca al logout e pulizia per sessione sono parte del disegno. Audit accessi e trasferimenti su file, audit strutturato su Mongo e storico operativo recente hanno cicli di vita distinti. L’affidabilità della registrazione è un requisito separato dal successo del trasferimento. [Logout](backend/auth/auth-routes.ts) · [Audit](storage/audit-repository.ts) · [Storico recente](backend/transfer/transfer-routes.ts#L597)


## Matrice SRS §§2–11

Sono inclusi tutti i **62 RF** e **30 RNF**. Una riga con più ID condivide l’evidenza e l’esito riportati. Le prove E2–E5 sono da leggere insieme alla tabella di esecuzione e alle limitazioni di E11.

### Requisiti funzionali §3

| Requisito | Esito | Evidenza locale e limite |
|---|---|---|
| RF-AUTH-001, 002 | P | Login con credenziali valide e rigetto credenziali non valide su API e Chrome. Scrypt, salt e provisioning testati. E2, E5, E6. |
| RF-AUTH-003, 004, 006 | P | Sessione server-side, 409, logout, revoca, inattività, sospensione temporanea in trasferimento e scadenza assoluta verificate nelle suite Auth e Security. E2, E5, E6. |
| RF-AUTH-005 | P | Ruoli Admin/Operatore, rifiuto su risorse protette, path associati all’utente e proprietà della sessione. Le anomalie di risposta Logs sono in A13. E2, E5. |
| RF-ROB-001, 002, 003 | P | Lista, filtro, selezione e dettaglio; query paginata con repository Mongo testato e Dashboard Chrome. E2, E5. |
| RF-ROB-004, 005, 006 | P | Registrazione, parametri SSH e cliente, impianto facoltativo, validazione e duplicati. E2, E11. |
| RF-ROB-007 | P | Verifica in politica rigorosa e differita, fingerprint e connessione verificati con fixture. E3, E11. |
| RF-ROB-008, 009, 010 | P | Directory `<username>_<id>`, aggiornamento albero, preservazione, rollback e recupero DB/FS verificati in locale. E2, E11. |
| RF-ROB-011, 012 | P | Funzionalità inizializzate secondo configurazione e raggiungibilità, stati esito e segnali di errore distinti. E2, E3, E11. |
| RF-ROB-013, 014 | P | Disabilitazione e rimozione anagrafica con dati preservati; registro e connettività distinti. E2, E11. |
| RF-MON-001, 002 | △ | Lettura SSH e parser KV/JSON su fixture. Formato e path dei robot aziendali non convalidati. [Formato stato](STATUS_FILE_FORMAT.md) · E3, E11. |
| RF-MON-003, 004, 005, 006 | P | Polling, refresh, ultimo valido separato da ultimo tentativo, stato stale/mai letto e presentazione testati. E2, E3, E11. |
| RF-SSH-001, 002, 003 | P | PTY remoto, input/output bidirezionale e resize su fixture SSH e WSS; terminale server su Chrome reale. E3, E5, E11. |
| RF-SSH-004 | P | Backend PTY/WSS e comando mantenuto a terminale server nascosto su Chrome. La verifica browser dello scrollback è separatamente fallita, A12. E3, E5. |
| RF-SSH-005, 006, 007 | P | Chiusura esplicita, ownership, rifiuti, disconnessione, timeout, errori e cleanup verificati nelle suite terminale. Shutdown di processo con SSE in A01. E3, E11. |
| RF-SSH-008 | △ | La shell usa l’identità SSH configurata senza elevazione automatica nel percorso esaminato. Privilegi, sudoers e configurazione reale non verificati. E3. |
| RF-FS-001, 002, 003 | P | Listing SFTP, metadati, navigazione e limiti di visibilità. E3, E11. |
| RF-FS-004, 005, 006, 007 | P | Download/upload, errori e autorizzazioni per utente/robot/path su fixture. E2–E4. |
| RF-SRVFS-001, 002, 003, 004 | P | Directory dedicata e navigazione; upload e download API su server locale. E2, E4, E5. |
| RF-SRVFS-005, 006, 007 | P | Canonicalizzazione, separazione robot, preservazione directory e cartelle standard configurabili. E2, E4. |
| RF-TRF-001, 002, 003 | P | Direzioni computer↔server, server↔robot e computer↔robot. Browser e server SFTP della prova sono distinti. E3, E4, E11. |
| RF-TRF-004, 005 | P | Payload >1 GiB, streaming/multipart e controllo delta heap nel collaudo locale. E4, E11. |
| RF-TRF-006 | P | DTO progresso con byte, percentuale, velocità ed ETA; stream SSE con snapshot provato su HTTPS. E4, E6, E11. |
| RF-TRF-007, 008, 009 | P | Errori, mismatch checksum, readback, staging e cleanup nei percorsi della suite, con file valido preservato nei casi controllati. E4, E11. |
| RF-TRF-010, 011 | P | Resume e compatibilità del parziale nei casi coperti, gestione conflitto ed esplicita sovrascrittura. E4. |
| RF-TRF-012, 013 | P | Limiti, queue/rigetto, cancellazione singola e per batch, e percorsi di timeout nelle fixture. Arresto del processo separatamente fallito. E4, E6, E11. |
| RF-TRF-014 | △ | Spazio insufficiente e margine verificati con fixture `statvfs` e controlli applicativi. Esaurimento reale su filesystem e volume remoto e gestione su ogni tipo di destinazione da completare. E2, E4. |

### Requisiti non funzionali §4 e vincoli trasversali

| Requisito | Esito | Evidenza locale e limite |
|---|---|---|
| RNF-SEC-001 | △ / F su endpoint | HTTPS/WSS locale testati. Il client standard rifiuta il certificato aziendale esaminato, A02. E3, E6, E8. |
| RNF-SEC-002 | △ | Hash, AES-256-GCM del vault, permessi master key, redazione e assenza di chiavi nel tree corrente verificati. Chiave TLS storica A08 e topologia operativa NV. E2, E6. |
| RNF-SEC-003, 004, 005, 006, 007 | P | Fingerprint, RBAC, canonicalizzazione e symlink, allowlist e vincoli host, sessioni isolate e rifiuti testati su fixture. A13 riguarda la gestione della risposta, senza accesso indebito osservato. E2–E4. |
| RNF-SEC-008 | P | Staging e gestione dei temporanei, jail e pulizia con fixture server e SFTP. E4. |
| RNF-SEC-009 | △ | Login/logout, eventi flotta, terminali, trasferimenti, rifiuti e sanitizzazione testati per le casistiche previste. Durabilità con I/O guasto e retention da chiudere, A05–A07. E2, E4. |
| RNF-FS-001, 002, 003, 004 | P | Permessi effettivi nella fixture DAC, isolamento, preflight/doppia conferma nei flussi coperti, idempotenza e recupero. E2, E4. |
| RNF-PERF-001 | P | >1 GiB e delta heap sotto soglia delle fixture. E4, E11. |
| RNF-PERF-002 | △ | Streaming, chunking e backpressure nel codice e nei test. Mancano picchi RSS, profiling lungo e misure per più carichi reali concorrenti. E4. |
| RNF-PERF-003, 004 | P | Limiti utente/robot/server e intervallo configurabile; nessuna sovrapposizione di polling sul medesimo robot nei test. Capacità aziendale aperta, A09. E2–E4. |
| RNF-PERF-005 | P | Nuovi robot tramite anagrafica e configurazione, senza estensioni specifiche nel collaudo SSH/SFTP. La capacità a piena flotta resta aperta. E2–E3. |
| RNF-REL-001, 002, 003, 004 | P | Guasti isolati, stato stale, rollback e file valido preservato nei casi di prova. E2–E4. |
| RNF-REL-005 | F | Rilascio su chiusura e disconnessione nelle suite, ma il processo compilato resta in attesa oltre il budget con SSE aperto. A01, E6. |
| RNF-UX-001, 002 | △ | Chrome osserva navigazione, focus e feedback nei flussi coperti. Regressione integrale e gestione Logs aperte, A12–A13. E5. |
| RNF-UX-003 | △ | Chrome reale avviato e usato. Suite end-to-end completa fallita nello scrollback, A12. L’SRS designa Chrome come browser supportato. E5. |
| RNF-UX-004 | △ | Terminali PTY, resize, copia/incolla e controllo in locale. Scrollback a riapertura e flussi browser dopo l’asserzione fallita da completare. E3, E5. |
| RNF-MNT-001, 002 | P | Configurazione Zod/ambiente, precedenze, limiti e moduli separati. La configurazione effettiva NEANTE resta NV. E1, E2, E6. |
| RNF-MNT-003 | △ | Catalogo, classificazione, diagnostica e redazione testati su fixture. Difetti di registrazione/risposta e runbook da completare, A05, A11, A13. E2. |
| §§2.1–2.5, architettura e ambiente | △ | Separazione dei ruoli, accoppiamento browser/backend e assenza di SSH diretto per costruzione, HTTPS locale e modello Ubuntu/systemd. VPN, FQDN, runtime e policy firewall aziendali NV. E3, E6, E8, E10. |
| §§5–6, componenti e flussi | △ | Flussi app/API, storage, autenticazione, registrazione, monitoraggio, terminale e trasferimenti esercitati in locale. Flussi installati e browser completo restano aperti. E2–E6, E11. |
| §8, registrazione | P | Politiche rigorosa/differita, unicità ID e username per host o globale, cartella dedicata, modifica, disabilitazione e rimozione con preservazione. E2, E3, E11. |
| §9, errori | △ | Catalogo con classificazione, risposta pubblica e diagnostica separata. Verifica completa su dipendenze effettive e risposte terminali Logs ancora aperta. E2, E5. |
| §10, dati e persistenza | △ | Repository Mongo e indici testati, recupero utenti e vault su fixture, esiti file persistenti in condizioni ordinarie. Restano A05–A06 e backup coordinato. E2, E4, E9. |
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
| CA-TRF-002 | △ | DTO e snapshot SSE verificati e implementazione frontend presente. Il percorso finale browser di rappresentazione dei trasferimenti rimane aperto dopo A12. |
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
| 9 | Terminale Linux interattivo nel browser | △ · E3, E5, scrollback browser A12. |
| 10 | Navigazione filesystem remoto e server | P · E2–E5. |
| 11 | Upload/download tra computer, server e robot | P · E4, E11. |
| 12 | Backend intermediario | P · Architettura e prove locali E3–E4. |
| 13 | File >1 GB in streaming | P · E4, E11. |
| 14 | Avanzamento, errori, timeout, integrità e temporanei | △ · E4, E6, E11 e CA-TRF-002/006. |
| 15 | Protezione di credenziali, sessioni, directory e flotta | △ · E2–E4, requisiti operativi A02, A08. |
| 16 | Eventi e informazioni diagnostiche | △ · E2, E4, A05, A06, A13. |
| 17 | Separazione fra stato anagrafico, raggiungibilità e stato operativo | P · E2, E11. |
| 18 | Nuovi robot compatibili senza cambi codice | P · E2, E3. |

### Integrazioni normative in coda al TXT SRS

| Gruppo e punto | Esito ed evidenza |
|---|---|
| Estensione 1 · Sessioni, 15/30 min, avviso 5 min, username univoci, terminali Admin | △ · Config, unitari e API per limiti, inattività e nomi univoci. E5 per i percorsi browser eseguiti. Verifica con tempi effettivi e terminale nascosto sul deployment NV. |
| Estensione 2 · Config operativa, 10 utenti, limiti terminali, batch/3 GB, estendibilità | P · Configurazione e concorrenza, validazione e precedenze nei test. Il valore di 3 GB è stato verificato come configurazione. Il trasferimento end-to-end a quel limite resta NV. |
| Estensione 3 · Bulk multi-target, ruoli, conflitti e annullamento | P · Suite bulk, UI per selezione e destinazione e vincoli path. Prove sui terminali e sui permessi distinte. |
| Estensione 4 · Cliente e impianto | P · Campi anagrafici, cliente richiesto e impianto opzionale nel backend e nelle fixture. |
| Estensione 5 · Filtri, Bootstrap, logo Home, React | △ · React/Bootstrap verificabili nella build, filtri testati, route e navigazione parzialmente osservate. Il blocco E5 precede l’asserzione esplicita sul logo. |
| Specifiche 1 · Cliente obbligatorio e impianto facoltativo | P · API, schema e test flotta. |
| Specifiche 2 · Popup Gestione File e path a scelta o manuale | △ · Componenti e integrazione API presenti; scenario browser successivo all’asserzione fallita E5. |
| Specifiche 3 · Config e path per operatore | P · Test configurazione, RBAC e jail. |
| Specifiche 4 · Conferma, esci e sospensione inattività durante trasferimento | △ · Suite backend e logout. Il logout in Chrome è passato. La prova completa delle due finestre di avviso resta fuori dal percorso concluso. |
| Specifiche 5 · Conferma eliminazione e conteggio file | △ · Preflight e conteggio ricorsivo testati lato server, componenti di conferma presenti. Copertura interfaccia di tutti i percorsi e produzione aperta. |
| Specifiche 6 · Concorrenza della sessione | P · Gate 409, configurazione e test simultanei. |
| Specifiche 7 · Nessun pulsante terminale per Operatore | △ · Guardia API e rendering condizionale verificati, prova Chrome end-to-end conclusiva per server e per robot non raggiunta. |
| Specifiche 8 · Logs amministratore, campi, esiti e delimitatori | △ · Accesso amministrativo e rifiuto Operatore in Chrome, log fisici e righe batch da test backend. A05–A07, A13; righe e filtri della vista a fine suite Chrome non raggiunti. |
| Specifiche 9 · Annullamento dell’intero batch, parziali e completati | P · Suite bulk con annullamento in corso, protezione del completato, pulizia e ripresa applicate secondo il tipo di operazione testato. Traffico reale NV. |

## Preparazione alla produzione e condizioni per il GO

| Priorità | Evidenza richiesta per chiudere il gate |
|---:|---|
| 1 | Arresto sul binario candidato con SSE, terminali PTY/WSS, polling, trasferimenti in corso e audit da scrivere. Osservare marker di pulizia, esiti durevoli, porta liberata, uscita entro il budget con margine e assenza di SIGKILL. Confrontare unità, override e journal precedenti per spiegare i 90 s. |
| 2 | Catena TLS fidata e SAN per il punto di accesso effettivo. Confronto immutabile di commit, bundle, backend avviato e configurazioni dichiarate su NEANTE, incluso il comportamento di readiness e liveness. |
| 3 | Regressione `npm test` integralmente verde e prove E5 rimanenti, con verifica della cronologia terminale, disconnessione e cambio account Logs. Aggiungere al gate le due suite di prodotto oggi eseguite a parte. |
| 4 | Collaudo con account Admin/Operatore di prova e robot rappresentativi via rete aziendale. Esercitare percorsi autorizzati, fingerprint, stato, terminale, trasferimenti nelle direzioni richieste, SHA-256, annullamenti e persistenza in condizioni normali e di guasto. |
| 5 | Operabilità e recupero · ripristino isolato coerente di DB, filesystem, log e vault, runtime patchato, permessi di servizio, policy di retention e monitoraggio capacità con prestazioni a piena flotta misurate. |
| 6 | Aggiornare la documentazione per riproducibilità e passaggio di consegne con runbook, ambiente, baseline, criteri e artefatti firmati. |

**VERDICT: FAIL — rilascio NO-GO.** Il candidato locale supera compilazione e numerosi controlli funzionali. Il timeout con SSE e la regressione browser sono osservati sul candidato. Il percorso TLS, la versione backend di NEANTE e il ripristino operativo non offrono ancora le evidenze necessarie per autorizzare la consegna.

### Riferimenti delle evidenze locali

Output originali in ambiente di audit · [regressione npm](/home/azghari/.codex/visualizations/2026/11/27/01a21c54-d166-7000-8ae8-e9a320e8fa9a/.moliris-final-audit/evidence/short-tmp/npm-full.log), [secondo Chrome](/home/azghari/.codex/visualizations/2026/11/27/01a21c54-d166-7000-8ae8-e9a320e8fa9a/.moliris-final-audit/evidence/continuation/browser-repeat.log), [esiti delle suite rimanenti](/home/azghari/.codex/visualizations/2026/11/27/01a21c54-d166-7000-8ae8-e9a320e8fa9a/.moliris-final-audit/evidence/continuation/results.tsv), [SIGTERM e ripristino](/home/azghari/.codex/visualizations/2026/11/27/01a21c54-d166-7000-8ae8-e9a320e8fa9a/.moliris-final-audit/evidence/production.log), [modalità mirate Chrome](/home/azghari/.codex/visualizations/2026/11/27/01a21c54-d166-7000-8ae8-e9a320e8fa9a/.moliris-final-audit/evidence/chrome-modes/results.tsv).

| Validatore Gravitas | Exit | Identificativo evento |
|---|---:|---|
| `static` | 0 | `89acaa5ed5f00f14c9518fa63bd53db5e7384bc57a0e7e257d71e380ff87287c` |
| `full-short-tmp` | 1 | `aa9b74d4f756e048f38b1858e994419799ef14f5c0f8088c8b117301cd44bc8e` |
| `chrome-modes` | 0 | `07ecbad8b7d5d453d89164bd4bef5d9547e0ba770ce56f5f22e921c22aacfb25` |
| `production-fixture-v3` | 1 | `d8f6c6ab314cdc251f551e188431724200d2b5e51e0238b8e4380cff7d6658b7` |
