# Moliris · Audit tecnico, funzionale e di sicurezza

**Data** 25 novembre 2026 · **Revisione** `8ef73ff8642930558fba4ee35409978d0ac9c68e` · **Ambito** audit prima delle correzioni

## 1. Riepilogo esecutivo

La build locale è avviabile e il bundle servito corrisponde alla revisione esaminata. I **35 script applicativi** sono passati dopo un retest per correggere una precondizione Git del banco di prova. Tutti i **20 cicli consecutivi Chrome** di login e logout sono passati nella stessa pagina. Sono passati anche il logout tra due schede Firefox e i collaudi SSH rigorosi su fixture.

L’audit supplementare ha confermato **quattro bug applicativi**. Due sono **P1**. Un errore dell’audit può lasciare una sessione senza cookie e impedire il login successivo. Un errore nella rimozione del robot può lasciare la sua anagrafica attiva dopo averne eliminato le credenziali. Due bug **P2** interessano il logout sui viewport stretti e il focus nella finestra di registrazione. Il caricamento iniziale senza una scadenza applicativa è un’ulteriore criticità **P2** da verificare in condizioni di indisponibilità prolungata.

**Esito per il rilascio** · sospendere il rilascio in produzione fino alla correzione dei P1, alla verifica dei controlli di sicurezza indicati qui e al collaudo sulla topologia reale. Il robot reale è ancora irraggiungibile dall’host locale. Nessun incidente P0 è stato dimostrato nel perimetro verificato.

## 2. Architettura e ambiente

| Area | Rilevazione |
|---|---|
| Repository | `main`, HEAD `8ef73ff`, allineato a `origin/main` e al riferimento pubblicato su GitHub, verificato con `git ls-remote`. Sorgenti integri all’inizio. |
| Stack | Node 22.22.1, TypeScript, React 19, Vite 8, Bootstrap 5, Fastify 5 su HTTPS, MongoDB 9.0.4 locale, SSH2/SFTP e terminale WebSocket. I trasferimenti pubblicano snapshot SSE. |
| Browser | Chrome 156.0.8078.47 e Firefox 149.0.2 in headless, con profili e utenti di test. |
| Runtime locale | Node in ascolto su `127.0.0.1:8443` dalla build `dist/backend/server.js` di questo checkout. La directory di lavoro e la configurazione operativa provengono dal clone locale già in uso. Il bundle HTTPS è identico byte per byte al bundle ricostruito in isolamento. |
| Sessioni | Cookie `__Host-moliris_session` con `Secure`, `HttpOnly`, `SameSite=Strict`; sessioni server in memoria e token usato anche come credenziale delle API. Il flusso browser usa heartbeat e scadenza della sessione, senza refresh token. La creazione utenti avviene tramite provisioning, senza registrazione pubblica nel frontend. |
| Configurazione | Registrazione SSH rigorosa osservata nel file operativo; porta SSH di default 22. Il loopback del modulo usa la porta immessa dall’utente. Docker e Podman non disponibili sull’host; il processo web osservato è Node diretto. |
| Isolamento | Snapshot temporaneo del commit, certificato TLS di collaudo, istanza MongoDB separata su loopback, profili browser separati e timeout per comando. Gli accessi diretti al database operativo hanno usato solo letture. I 25 GET anonimi di misura a `/api/auth/me` hanno attivato la normale registrazione di eventi `SESSION_MISSING` del servizio. |

## 3. Copertura funzionale

| Area | Verifiche effettivamente eseguite |
|---|---|
| Frontend | Login valido e non valido, conflitto sessione, flotta, filtri, menu e ritorno alla home, navigazione Logs, filesystem generale/server/remoto, gestione trasferimenti, terminale locale e layout espanso, modale inattività. Misure del logout, clic rapidi, modali e verifica console negli scenari Chrome coperti. Smoke Firefox con login, navigazione, logout, refresh e sincronizzazione tra due schede. |
| Sessioni e API | Login/logout concorrenti nel runner del progetto, cookie, invalidazione e risposta `401`, scadenza, isolamento ruoli, avvisi inattività, limite accessi, comportamento dopo ricarica e Indietro. Risposta logout sospesa e modalità offline con ripresa. Iniezione di guasto dell’archivio audit su fixture separata. |
| Robot e SSH | Registrazione e modifica, validazione parametri, host key SHA‑256, credenziali e autenticazione, modalità rigorosa e differita, timeout e limiti di connessione, gestione stato e monitoraggio. SSH/SFTP di prova con host key nota e connessione verso porte effimere. Misura TCP reale su `127.0.0.1:2223` e `:2224`. |
| Storage e terminale | Upload/download, annullamento, conflitti bulk, isolamento directory, checksum, isolamento PTY, rilascio WebSocket e riavvio del server verificati dai test. Iniezione di guasto sulla rimozione dell’anagrafica in memoria. |
| Database e sicurezza | Indici e vincoli ripetuti su MongoDB isolato, rotazione e cifratura credenziali su fixture, controlli esistenti di TLS, RBAC e validazione, analisi statica dei confini di sicurezza, audit npm e consultazione di conteggi/indici del database operativo senza leggere i valori sensibili. |

## 4. Conteggi e risultati

I conteggi usano come unità uno script, un controllo statico o uno scenario supplementare. Le asserzioni interne, i 20 cicli e i campioni prestazionali sono riportati separatamente.

| Gruppo | Controlli distinti | Passati | Falliti | Osservazioni |
|---|---:|---:|---:|---:|
| Script applicativi del progetto | 35 | 35 | 0 | 0 |
| Build, lint e TypeScript frontend | 3 | 3 | 0 | 0 |
| Firefox WebDriver | 8 | 6 | 1 | 1 |
| Chrome supplementare · autenticazione, larghezze e tastiera | 5 | 1 | 4 | 0 |
| Guasti controllati · audit del login e rimozione robot | 2 | 0 | 2 | 0 |
| **Totale** | **53** | **45** | **7** | **1** |

**54 esecuzioni** per i 53 controlli distinti. La prima esecuzione di `security-hardening.test.ts` è uscita perché lo snapshot creato con `git archive` era privo dell’indice Git. Il retest con l’indice in sola lettura ha completato la suite con esito positivo. Il runner ha proseguito dopo il primo errore. Nessun controllo eseguito è scaduto per timeout. Il controllo separato `npm audit` ha restituito 0 avvisi per il lockfile alla data della prova.

### Funzionalità bloccate o con copertura parziale

- **Robot reale e VM** · collegamento, fingerprint, credenziali, registrazione completa e trasferimenti su robot reale bloccati prima dell’handshake TCP. Le prove su fixture coprono il flusso applicativo.
- **Firefox** · smoke e prova a due schede eseguiti. La suite E2E completa, il terminale e i trasferimenti complessi sono stati collaudati in Chrome o nei runner di integrazione. Firefox non è stato verificato su tutta la matrice.
- **Produzione** · proxy effettivo, trust della CA, autenticazione MongoDB di produzione, rete robot e policy di contenimento non verificabili dall’istanza locale. Non è stato svolto un collaudo prolungato di più ore né un test di carico con una flotta rappresentativa. I dati correnti non dimostrano l’assenza di perdite di memoria o di race sporadiche.

## 5. Bug confermati

### MOL-P1-001 · Login bloccato dopo errore dell’archivio audit

- **Modulo e riferimento** · autenticazione. `backend/auth/auth-routes.ts:178,251–272`.
- **Prerequisito** · account di prova valido con limite di una sessione. Repository audit isolato configurato per fallire una sola scrittura di successo.
- **Procedura** · inviare un login valido, lasciare fallire la scrittura audit e ripetere il login dopo il ripristino della scrittura.
- **Atteso ed effettivo** · il primo tentativo fallito dovrebbe liberare la sessione; il successivo dovrebbe poter accedere. La prova ha restituito **500**, senza cookie, con **1 sessione attiva** in memoria. Il tentativo successivo ha restituito **409 `SESSION_ALREADY_ACTIVE`**. Frequenza **1/1** nell’iniezione di guasto.
- **Causa** · la sessione viene inserita prima della scrittura audit attesa. Se quella Promise si rigetta, Fastify restituisce un errore prima di inviare il cookie e il ramo lascia la sessione allocata.
- **Correzione proposta e rischio** · annullare l’allocazione se il login fallisce prima dell’emissione del cookie, preservando il requisito di audit. Rischio di regressione alto su concorrenza, limiti account e reset password. Aggiungere un test con guasto audit e nuovo tentativo.

### MOL-P1-002 · Rimozione robot parziale lascia un’anagrafica attiva senza credenziali

- **Modulo e riferimento** · flotta, persistenza e vault. `backend/fleet/fleet-service.ts:1274–1285`.
- **Prerequisito** · robot e credenziali sintetiche in repository in memoria; errore controllato nella cancellazione dell’anagrafica.
- **Procedura** · avviare la rimozione amministrativa confermata e far fallire la scrittura del repository dopo la rimozione dal vault.
- **Atteso ed effettivo** · la rimozione dovrebbe completarsi in modo coerente o mantenere il robot recuperabile. L’operazione è fallita lasciando **`robotStillExists=true` e `credentialStillExists=false`**. Frequenza **1/1** nel guasto simulato. Nessun dato operativo è stato coinvolto nella prova.
- **Causa** · eliminazione delle credenziali e dell’anagrafica seriali, senza transazione o compensazione.
- **Correzione proposta e rischio** · usare una transazione se entrambi i repository e la topologia MongoDB la supportano. In alternativa, introdurre uno stato di rimozione idempotente con recupero esplicito. Rischio alto su integrità delle credenziali, riuso identificativi e conservazione archivio filesystem.

### MOL-P2-001 · Disconnetti esce dal viewport su schermi stretti

- **Modulo e riferimento** · barra di navigazione, `client/src/components/common/AppNavbar.tsx:52–64,145–156`.
- **Prerequisito** · sessione amministrativa, Chrome con viewport emulato di 390, 360 o 320 px e pagina in posizione iniziale.
- **Procedura** · accedere, impostare la larghezza e confrontare il bordo destro del pulsante col viewport.
- **Atteso ed effettivo** · il pulsante dovrebbe essere interamente raggiungibile senza scorrimento orizzontale. Il bordo destro è a **424 px** in tutti e tre i casi. Il pulsante è parziale a 390 e 360 px e interamente fuori viewport a 320 px. Frequenza **3/3** sulle larghezze campionate. Firefox a 500 px ha mostrato il pulsante per intero.
- **Causa** · navbar sempre espansa con gruppi flex orizzontali e azioni/etichette che eccedono la larghezza disponibile.
- **Correzione proposta e rischio** · introdurre un breakpoint con disposizione flessibile e uscita sempre visibile. Rischio medio su logo, menu, sovrapposizione modali e terminale. Verificare 320–500 px oltre alla vista desktop.

### MOL-P2-002 · Il focus resta dietro la modale di registrazione robot

- **Modulo e riferimento** · accessibilità, `client/src/components/fleet/RobotRegisterModal.tsx:43–50,129–155`.
- **Prerequisito** · sessione amministrativa e apertura del modulo.
- **Procedura** · attivare **Registra Nuovo Robot** e osservare il focus; in Chrome premere Tab.
- **Atteso ed effettivo** · il focus dovrebbe entrare nella modale e la tabulazione restare tra i suoi controlli. Firefox ha lasciato il focus su `btn-register-robot`. In Chrome il tasto Tab è passato a `btn-server-terminal` dietro la modale. Frequenza **2/2 browser** nella prova mirata.
- **Causa** · la modale propria imposta `aria-modal` e gestisce Escape, ma non trasferisce o circoscrive il focus.
- **Correzione proposta e rischio** · focus iniziale esplicito, confinamento di Tab/Shift+Tab e ripristino sul pulsante chiamante. Rischio medio su Escape, errori di validazione e logout durante la modale.

## 6. Criticità da approfondire

| ID e priorità preliminare | Evidenza disponibile | Verifica e intervento proposti |
|---|---|---|
| MOL-R-P2-001 · Attesa riconoscimento sessione | In Firefox con risposta di `/api/auth/me` ritardata artificialmente di 4 s, a 236 ms era visibile la schermata di verifica e il form era assente. Il form è apparso dopo la risposta. In `client/src/hooks/useAuth.ts:107–127,266–285` il fetch usa un segnale di ciclo vita senza scadenza autonoma. Il POST login ha a sua volta un’attesa non limitata dal client in `132–141`. | Collaudare una mancata risposta prolungata e introdurre un limite con recupero esplicito. Verificare ripristino da Indietro e corse fra login e logout prima di modificare il flusso. |
| MOL-R-P2-002 · Logging fisico nel profilo systemd | Il logger usa per default `cwd/logs`. L’unità modello ha `ProtectSystem=strict` e concede scrittura solo alla directory dati. Senza override la destinazione dei log dell’unità può essere in sola lettura. `backend/logging/physical-file-logger.ts:129–176`, `moliris.service:11,29–33`. | Verificare l’unità in staging con la configurazione operativa e un percorso esplicitamente scrivibile per i log, mantenendo i privilegi minimi. |
| MOL-R-P2-003 · Doppio polling dei trasferimenti | Il client mantiene sia EventSource sia polling periodico. Il server ricrea snapshot ogni secondo anche quando i dati sono stabili. `client/src/hooks/useTransfers.ts:260–300`, `backend/transfer/transfer-routes.ts:607–625`. | Misurare a più utenti con trasferimenti attivi e proxy reali. Valutare polling solo quando SSE è indisponibile o una frequenza adattiva. |
| MOL-R-P2-004 · Diagnostica SSH per TCP rifiutato | Al passo `host_reachability` il verificatore può restituire un esito generico di host irraggiungibile dopo una prima sonda TCP. `backend/connection/connection-verifier.ts:82–105`. Sul computer entrambe le porte sono state rifiutate. | Distinguere host irraggiungibile, timeout e porta rifiutata nei messaggi senza esporre informazioni sensibili. Verificare con una fixture che chiude la porta. |

## 7. Sicurezza e database

### Controlli di sicurezza e rischi residui

- I test esistenti hanno verificato accessi per ruolo, invalidazione di cookie, chiavi host attese, rifiuto HTTP in chiaro e validazione applicativa. Il lockfile ha dato **0 avvisi** al controllo npm. Questo esito riguarda gli avvisi restituiti dal registro alla data della misura.
- **MOL-SEC-P1-001 · Sottoscrizione SSE e revoca, riscontro statico.** `backend/transfer/transfer-routes.ts:584–633` autentica all’apertura, poi conserva il contesto autorizzato durante la vita dello stream. Il suo timer viene eliminato alla chiusura della socket. Nel gestore non risulta una rivalutazione della sessione né un aggancio alla revoca. Priorità P1 per il confine di accesso ai dati. Valutare chiusura per revoca/scadenza e test difensivi con sottoscrittori legittimi su fixture.
- **MOL-SEC-P2-002 · Confronto Origin, riscontro statico.** In `backend/server.ts:249–276` il confronto esatto ha un ramo alternativo basato sull’host e su entrambi gli schemi HTTP/HTTPS. Riesaminare la relazione tra host, schema e fiducia nel reverse proxy. Il flusso di accesso non autorizzato conseguente non è stato riprodotto.
- **MOL-SEC-P2-003 · Autenticazione Mongo locale, osservato.** Connessione a MongoDB con zero identità autenticate e lettura riuscita dei conteggi. I listener risultano loopback. È una caratteristica dell’installazione locale; prima del rilascio confermare autenticazione, ruoli e protezione della rete nel deployment effettivo.
- **MOL-SEC-P2-004 · Controllo destinazioni, riscontro statico.** Se l’allowlist manca, il validatore ammette tutti gli host sintatticamente validi. La modalità production richiede una configurazione più restrittiva. Verificare restrizioni di egress e confini amministrativi nella topologia finale. `backend/connection/connection-validator.ts:65–72`, `config/configuration.ts:323–330`.

### Persistenza osservata

| Area | Lettura effettiva |
|---|---|
| Utenti | 2 record. Indici univoci su ID e username. |
| Robot e credenziali | 0 record in ciascuna collezione. Presenti vincoli univoci di repository, inclusa la tripletta host/porta/utente per robot. Zero gruppi di ID duplicati nel campione vuoto. |
| Audit | 616 record al momento della lettura, TTL di 30 giorni e indici singoli/composti. Il piano per l’ordinamento recente con limite 100 ha esaminato 100 documenti e 100 chiavi, in 1 ms sul campione corrente. Il repository ammette anche query senza limite; l’impatto su dati grandi resta da misurare. |
| Telemetria | `robot_telemetry_history` vuota, indice composto robot/timestamp e TTL di 90 giorni. |
| Clienti e impianti | 2 record ciascuno. Vincoli univoci sul nome cliente e sul nome impianto nel cliente. |

## 8. Misure prestazionali

### Chrome · 20 cicli consecutivi

Tempi dal clic, in millisecondi. Il feedback è la comparsa del login nel DOM. La conferma è la riabilitazione del form dopo la risposta del server. Il p95 usa il rango più vicino verso l’alto.

| Misura | Min | Mediana | P95 | Max |
|---|---:|---:|---:|---:|
| Feedback | 2,9 | 3,35 | 6,3 | 7,3 |
| Conferma | 10,6 | 14,8 | 22,0 | 22,0 |

Cicli in ordine, come coppie feedback/conferma in ms

`6,3/21,8 · 6,1/16,6 · 4,4/15,5 · 7,3/22,0 · 5,2/14,2 · 3,9/22,0 · 3,1/15,3 · 3,1/12,8 · 3,0/13,9 · 3,4/14,1 · 4,3/13,5 · 3,2/17,8 · 2,9/13,8 · 3,0/15,5 · 3,3/14,2 · 3,2/20,8 · 3,5/13,0 · 3,9/14,3 · 3,3/10,6 · 3,2/17,5`

Con 1.200 ms di latenza artificiale, feedback in **6,2 ms**. Con risposta sospesa, il pulsante Riprova è apparso dopo **5.007,1 ms**. In Chrome supplementare, navigazione iniziale **223,6 ms** e login **107 ms**. In Firefox, evento di caricamento **441 ms**, schermata di login raggiunta tramite WebDriver in **597 ms**, login **150 ms**, feedback logout **6 ms**. I tempi WebDriver includono il costo di comando e polling e vanno letti separatamente dalle misure interne alla pagina.

### HTTPS locale · 25 richieste per endpoint

| Endpoint | Stato | P50 | P95 |
|---|---:|---:|---:|
| `/` | 200 | 2,05 ms | 4,07 ms |
| `/healthz` | 200 | 1,13 ms | 1,73 ms |
| `/api/config/public` | 200 | 1,23 ms | 1,71 ms |
| `/api/auth/me` anonimo | 401 | 2,64 ms | 3,60 ms |

Processo Node osservato durante i 100 GET in serie con keep-alive. RSS da **113.528 a 113.776 KiB**; **14 tick CPU** in **246,22 ms**, con clock di 100 tick/s. È un campione breve su loopback. Il test streaming ha trasferito file **oltre 1 GB**, in sei direzioni, con differenze heap misurate tra **−6 e +7 MB**. Nessuno di questi campioni equivale a una prova di durata o a un profilo sotto carico di produzione.

## 9. Configurazione del robot locale

- Le due VM VirtualBox sono in stato `aborted`, usano NAT e non mostrano forwarding per le porte in oggetto. VirtualBox riporta virtualizzazione hardware non disponibile. Le sonde TCP hanno restituito `ECONNREFUSED` su **2223 e 2224**. Il dettaglio `host_reachability` si presenta prima di autenticazione e controllo impronta.
- Il codice della revisione contiene il dettaglio di errore aggiunto da `d03fa98`. La registrazione SSH rigorosa con server di prova è passata. Per confermare il flusso reale occorre un endpoint SSH effettivamente attivo e una chiave host attesa verificata da fonte fidata.

## 10. Evidenze ripetibili

- **Revisione e suite** · test elencati dallo script `test` in `package.json`, più `tests/security/input-validation-hardening.test.ts`. Comandi applicativi `node --import tsx <file.test.ts>`, build `npm run build`, `npm run lint`, `npm run typecheck:client`. I runner di database usano esclusivamente l’istanza di test separata.
- **Login in guasto** · `{"firstStatus":500,"firstCookieIssued":false,"sessionsAfterFirst":1,"retryStatus":409,"retryCode":"SESSION_ALREADY_ACTIVE"}`.
- **Rimozione in guasto** · `{"robotStillExists":true,"credentialStillExists":false}`.
- **Responsive e focus** · a 390 px il bordo destro di Disconnetti è 424 px; su Firefox focus `btn-register-robot` a modale aperta; su Chrome il primo Tab porta a `btn-server-terminal`.
- **Runtime** · SHA‑256 identico del bundle live e isolato `126146121bd3df4227ce501f38f73f12ef951d0d9b338c71ac609ff195cd375d`.
- **Registri locali dell’audit** · `/tmp/moliris-full-audit/logs/tests.tsv`, `logs/runs/`, `logs/security-rerun.log`, `logs/firefox.jsonl`, `logs/chrome-extra.jsonl`, `logs/auth-failure.log`, `logs/robot-removal.log`, `logs/environment.log`, `logs/mongo-corrected.jsonl`, `logs/npm-audit.json` e `evidence.jsonl` nella stessa directory temporanea. Il report conserva i dati essenziali nel caso in cui il sistema elimini i file temporanei.

## 11. Piano di correzione ordinato

1. **P1 · Autenticazione.** Correggere l’allocazione lasciata da un fallimento audit e aggiungere regressioni di errore, ripristino e login concorrente.
2. **P1 · Integrità robot.** Rendere atomica o recuperabile la rimozione di anagrafica e credenziali, compresi guasti parziali e retry.
3. **P1 · Confine SSE.** Aggiungere una verifica mirata della revoca e riallineare il ciclo di vita dello stream. Controllare scadenza, logout e rotazione delle sessioni.
4. **P2 · Interfaccia.** Correggere navbar responsive e focus delle modali. Controllare tastiera, viewport stretti, overlay e terminale.
5. **P2 · Affidabilità e deployment.** Limitare le attese di apertura sessione con recupero testato. Verificare unità systemd, logging, MongoDB autenticato, Origin e allowlist nel profilo di staging.
6. **Validazione finale.** Ripetere suite, browser e guasti controllati. Completare il collaudo sulla rete robot e una prova di carico con traffico, flotta e durata rappresentativi prima della decisione di rilascio.

Questo documento conclude la fase di diagnosi. Le correzioni applicative restano separate dal presente audit.
