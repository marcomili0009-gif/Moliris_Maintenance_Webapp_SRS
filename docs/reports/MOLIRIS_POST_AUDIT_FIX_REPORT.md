# Moliris Maintenance WebApp — Verifica post-audit e correzioni locali

**26 novembre 2026 · Europe/Rome · Base Git `fc0518c5aa402fcda09aa6c7b37822c82dd77d7d`**

## Identità dell’istanza e stato osservato

L’audit precedente ha ispezionato **l’installazione del computer locale**. Ha interrogato il systemd locale e `127.0.0.1:8443`, confrontato il suo albero `/opt/moliris` e consultato le VM VirtualBox di quell’host. I test applicativi usavano fixture isolate. Il precedente NO-GO non costituisce un esito sul server aziendale.

La nuova verifica è partita da `192.168.32.197` verso **`192.168.32.29`**, tramite `enp8s0`. Le osservazioni seguenti fotografano il percorso dal computer locale durante il controllo.

| Controllo | Esito | Evidenza |
|---|---|---|
| Porta HTTPS 8443 | Raggiungibile | TCP e handshake rispondono. Con il trust store corrente, curl restituisce 60 per certificato autofirmato. Certificato presentato con `CN=192.168.32.29` senza SAN. |
| HTTPS pubblico | Servizio applicativo in risposta | La lettura diagnostica delle sole risorse pubbliche, con verifica TLS disattivata per quella sonda, ha ottenuto HTTP 200 da `/`, `/healthz` e `/api/config/public`. `/healthz` ha restituito `status: OK`. Nessuna credenziale è stata inviata su HTTPS. |
| Porta 443 | Connessione rifiutata | Il tentativo TCP/HTTPS diretto è stato rifiutato. |
| Frontend distribuito | Tre artefatti identici alla build auditata | Corrispondenza SHA-256 byte per byte per HTML, JavaScript e CSS principali. Gli hash abbreviati sono HTML `0af7d028b20b`, `index-DMVefsQZ.js` `258d4a9dbb4b`, `index-4Nejhfm3.css` `7053bc9c0cfc`. |
| Stato systemd e revisione backend | BLOCKED | TCP 22 raggiungibile. Un tentativo SSH non interattivo con verifica rigorosa di una chiave host già nota ha ricevuto `Permission denied (publickey,password)`. Non sono stati letti unità, PID, journal, manifest o checksum backend remoto. |
| Percorso effettivo verso VM e robot | BLOCKED | Nessun accesso al contesto di rete del backend aziendale e nessuna associazione certa fra le VM locali e i robot di produzione. |

L’applicazione risponde su 8443 dal percorso osservato. Il confronto degli asset identifica il **frontend pubblico** rispetto alla build di riferimento. Il commit del backend remoto, il gestore del processo e la readiness effettiva di MongoDB restano indeterminati.

## Disposizione dei sette rilievi

| ID | Componente | Causa verificata e stato |
|---|---|---|
| MA-01 | Infrastruttura · disponibilità | L’unità inattiva e il listener mancante erano locali. Il server aziendale serve la WebApp su 8443. Stato effettivo di systemd remoto bloccato dall’accesso SSH. |
| MA-02 | Deployment · provenienza | La divergenza era tra l’installazione locale e il checkout. HTML e asset principali di produzione coincidono con la build auditata. Versione del backend remoto non verificata. |
| MA-03 | Infrastruttura · directory log | Il modello `moliris.service` e l’installer locale assegnano entrambi `/var/log/moliris` a servizi con identità diverse. Il conflitto è verificabile nei file del progetto e nel contesto locale precedente. Applicabilità al server aziendale bloccata dall’assenza di accesso alla configurazione effettiva. |
| MA-04 | Infrastruttura · VM e SSH | Lo stato VirtualBox, le regole NAT assenti e l’errore VT-x si riferivano alle VM locali. Stato e instradamento dei robot aziendali bloccati. |
| MA-05 | Infrastruttura · MongoDB | I due listener e le diverse impostazioni di autorizzazione appartenevano all’host locale. Endpoint, utente e policy effettivi dell’istanza aziendale non verificati. |
| MA-06 | Applicazione · health e risposta API | Difetto riprodotto sulla build originale e corretto nel repository locale. Health restituiva 200 senza consultare MongoDB. L’errore del repository utenti passava dal gestore globale, la cui mappa cadeva sul fallback HTTP 400. |
| MA-07 | Applicazione · paginazione MongoDB | Difetto riprodotto e corretto nel repository locale. Il percorso di lista caricava la collezione con `find({}).toArray()`; i filtri, la conversione DTO e la paginazione avvenivano dopo la lettura. |

## Correzioni e compatibilità

**MA-06.** `/livez` risponde finché il processo HTTP è operativo. `/healthz` controlla Mongo mediante `ping`, restituisce 503 durante l’indisponibilità e torna a 200 dopo il ripristino. Il segnale di abort a un secondo vale anche durante l’handshake iniziale. Le risposte delle sonde espongono stato e timestamp e impostano `Cache-Control: no-store`. Il codice applicativo `DB_PERSISTENCE_ERROR` propagato al gestore globale produce HTTP 500 con il messaggio già previsto dal catalogo. La politica di autenticazione rimane quella esistente.

**MA-07.** Il servizio calcola l’accesso globale o l’insieme degli ID autorizzati usando `hasPermission`. Il repository Mongo applica prima l’esclusione dei robot rimossi e, dove necessario, il filtro per ID. Applica poi ordinamento stabile per `_id`, `skip` e `limit` nel database. L’ordine esplicita il normale ordine di inserimento dei record con ObjectId generati dal driver. In precedenza Mongo non aveva un ordinamento dichiarato. Il percorso mantiene la visibilità dei robot disabilitati e dei record legacy senza stato, la guardia globale HTTP e il comportamento completo delle richieste senza limite. Il repository in memoria applica la stessa semantica usando il proprio ordine d’inserimento. Nessun nuovo indice o migrazione.

La correzione conserva la visibilità e le informazioni flotta previste da RF-AUTH-005, RF-ROB-001 e RF-ROB-014, oltre alla distinzione dei robot disabilitati formalizzata in DECISIONS.md, decisione 20 relativa a SRS §8.4. Le query senza limite continuano a restituire l’intero insieme autorizzato; offset profondi possono ancora comportare lavoro proporzionale all’offset.

| File | Modifica |
|---|---|
| `backend/server.ts` | Liveness, readiness Mongo con timeout, mappatura errore persistenza e dipendenza `Db` tipizzata. |
| `backend/fleet/fleet-service.ts` | Riutilizzo della policy RBAC e applicazione della finestra al repository, prima dei DTO. |
| `storage/robot-repository.ts` | Operazione dedicata alla pagina nel repository Mongo e nel repository in memoria. |
| `tests/database/database-improvements.test.ts` | Regressioni Mongo reali su query, RBAC, dati legacy, degrado, timeout e risposta API. |
| `MOLIRIS_POST_AUDIT_FIX_REPORT.md` | Verifica separata del server, disposizione dei rilievi ed evidenze post-correzione. |

## Evidenze di collaudo

Le prove hanno usato una copia temporanea, Node 22.22.1, MongoDB 9.0.4, certificati e utenti generati per le fixture. Per il browser è stata predisposta una scheda solo interna al namespace, priva di route verso la rete aziendale. Le prove di errore hanno interrotto esclusivamente il database temporaneo.

| Verifica | Risultato |
|---|---|
| Riproduzione baseline | A Mongo fermo, `/healthz` 200 e API flotta 400 con `DB_PERSISTENCE_ERROR`. Su 1.000 robot, la query completa esaminava e restituiva 1.000 documenti anche a fronte di una risposta HTTP con un solo robot. |
| Typecheck backend e client | PASS. `npm run typecheck` e `npm run typecheck:client`, exit 0. |
| Build Vite e TypeScript | PASS. `npm run build`, exit 0. |
| Regressione Mongo e Fastify | PASS. Sulla query effettivamente inviata per `limit=1&offset=1`, Mongo ha esaminato **3 documenti su 1.000**. Verificati ordine, robot rimossi/disabilitati, dati legacy, scope per ID, richieste offset-only e senza pagina, utenti senza accesso e risposta 403 della guardia HTTP. Un handshake Mongo bloccato ha prodotto readiness 503 in **1.072 ms**. |
| Smoke test HTTPS reale su binario compilato | PASS. Con TLS verificato dalla CA fixture, Mongo autenticato e binario compilato, validati login, sessione, flotta, log e logout. Dopo lo stop del database temporaneo, `/healthz` ha risposto 503 in **812 ms**, `/livez` 200, flotta 500. Al ripristino, readiness e flotta sono tornate 200 senza riavviare l’applicazione. Logout 200 e sessione revocata 401. |
| Suite `npm test` | PASS, exit 0 per tutti i 34 file di test configurati. Chrome reale, SSH/PTY e WSS, SFTP e trasferimenti oltre 1 GiB nelle sei direzioni hanno superato il collaudo isolato. La suite di accettazione ha dichiarato superati 35 criteri e 18 obiettivi. |
| Coerenza diff | PASS. `git diff --check` senza rilievi. |

Le due esecuzioni incomplete di `npm test` hanno evidenziato requisiti della fixture: il test di hardening usa `git ls-files` e una prova filesystem richiede cartelle inizialmente vuote. L’esecuzione finale ha usato un indice Git separato e nuove radici di prova.

Il primo tentativo con il solo timeout dell’operazione Mongo ha atteso 30,063 s su un client mai connesso. La regressione ha fatto emergere che il timeout scattava dopo il collegamento iniziale. Il segnale di abort ha portato la stessa prova entro il limite previsto.

I dati del collaudo non attestano la latenza del sistema aziendale. La revisione dell’artefatto remoto, la configurazione effettiva dei servizi e il collaudo integrato con robot restano aperti. Anche la fiducia del client nel certificato di produzione richiede verifica con endpoint e CA aziendali. Codebase e report sono stati modificati solo nel workspace locale. Nessun intervento su produzione, riavvio remoto, deploy, commit o push.

Il report d’audit originale è conservato come evidenza della verifica locale.
