# Moliris · Validazione finale e idoneità al rilascio

**NO-GO** per il rilascio del commit `0dfe13369981d4c7682c34d83d72b3d5c929d352`.

**Data e perimetro.** 25 novembre 2026, branch `main`, coincidente con il riferimento locale `origin/main`. Il codice di partenza incorpora `c8b4d3a` (correzioni dell’audit) e `d03fa98` (diagnostica SSH). Ho confrontato `MOLIRIS_FULL_AUDIT_REPORT.md` e `MOLIRIS_BUG_FIX_REPORT.md` con il diff da `8ef73ff` e ripetuto le prove su uno snapshot del commit. Le scritture di collaudo hanno usato database, certificati, filesystem e profili browser temporanei. Sul servizio locale ho interrogato il solo endpoint pubblico di salute e la homepage. Sul database operativo ho eseguito letture di metadati e conteggi. La validazione ha prodotto soltanto questo nuovo file nella working tree.

## 1. Decisione ed evidenze determinanti

1. **P1 · Durata assoluta della sessione oltre il limite configurato.** Con limite assoluto di 2 minuti e un’età simulata di 121 secondi, la sessione senza trasferimenti è scaduta. Quella con un trasferimento attivo risultava ancora valida. È scaduta alla successiva verifica dopo la fine del trasferimento. Il ramo corrispondente precede il controllo assoluto in `backend/auth/session-manager.ts:288–319` ed è presente anche in `8ef73ff`. Lo stream SSE usa quel validatore a ogni pubblicazione. La prova supplementare verifica il validatore in memoria. I test HTTPS verificano la chiusura SSE per logout e scadenza ordinaria. La chiusura SSE con un trasferimento ancora attivo non ha una prova positiva.
2. **P1 · Rimozione riuscita dopo retry senza evento di audit.** Una rimozione ordinaria su fixture con SSH ha registrato **1** evento `ROBOT_REMOVAL/SUCCESS`. Dopo un guasto forzato del purge del vault, l’anagrafica era già cancellata. Il retry ha eliminato la credenziale rimasta, preservando l’archivio, e ha registrato **0** eventi di successo. Il ramo di recupero termina prima della scrittura di audit in `backend/fleet/fleet-service.ts:1310–1336`. È un effetto del percorso aggiunto dalla correzione e lascia incompleto il requisito RNF-SEC-009 dell’SRS, che include la rimozione dei robot.
3. **Blocco operativo · SSH rigorosa sul robot reale.** Entrambe le porte locali `127.0.0.1:2223` e `127.0.0.1:2224` hanno risposto `Connection refused`. Nessuna VM era in esecuzione. Le due VM risultavano in stato `aborted` e VirtualBox riportava la virtualizzazione hardware come indisponibile. La prova reale si è fermata prima dell’handshake. La registrazione rigorosa via SSH/SFTP su fixture ha superato i test.
4. **Blocco di validazione · Il servizio locale espone un altro bundle.** `/healthz` su `127.0.0.1:8443` ha restituito `OK`. La homepage serviva `index-BI0Q_h2c.js` e `index-DPiYVbyi.css`. Lo snapshot appena compilato produceva `index-LqK7nwII.js` e `index-Dnp9Fmig.css`. Il commit Git locale include le correzioni. L’identità del backend in esecuzione e la configurazione di staging restano da verificare separatamente.

## 2. Riesame dei quattro bug confermati

| Riferimento | Riscontro sul codice e prova eseguita | Esito |
|---|---|---|
| MOL-P1-001 · Sessione orfana dopo errore audit del login | `backend/auth/auth-routes.ts:250–263` revoca la nuova sessione se la scrittura fallisce. In `backend/auth/auth.test.ts` il guasto controllato ha prodotto HTTP 500 senza cookie né slot occupato. Il login successivo ha funzionato e registrato l’evento di successo. | **Superato per il difetto originale.** |
| MOL-P1-002 · Robot attivo con credenziali perse | `backend/fleet/fleet-service.ts:1294–1336`, repository e provider separano stato `rimosso`, cancellazione anagrafica e purge. In `backend/fleet/fleet.test.ts` sono passati i guasti su stato, vault e anagrafica, i retry concorrenti e la conservazione dell’archivio. `corrective-hardening.test.ts` ha verificato in Mongo la marcatura, il purge idempotente e la protezione di una nuova credenziale. | **Superato per l’incoerenza originale.** La verifica supplementare ha confermato il problema di audit della sezione 1. |
| MOL-P2-001 · Disconnetti fuori dal viewport | `AppNavbar.tsx` e `client/src/styles.css:82–95` distribuiscono la barra su due righe a schermo stretto. Chrome ha verificato 320, 360, 390, 414, 768, 1024 e 1920 px senza overflow dell’intera pagina e con pulsante raggiungibile. Un tocco emulato a 390 px ha concluso il logout. Firefox ha verificato un viewport effettivo di 500 px. | **Superato alle larghezze e con gli input provati.** |
| MOL-P2-002 · Focus fuori dalla modale di registrazione | `RobotRegisterModal.tsx:42–91` sposta e confina il focus, includendo il controllo SFTP quando chiuso. Chrome e Firefox hanno verificato campo iniziale, Tab, Shift+Tab, Escape e ritorno al pulsante chiamante. | **Superato nei due browser.** |
| MOL-SEC-P1-001 · SSE dopo revoca | `backend/transfer/transfer-routes.ts:598–648` usa `Cache-Control: no-store`, controlla la sessione a ogni invio, chiude sul segnale di revoca e rimuove listener e timer alla chiusura. Il test HTTPS ha osservato la fine del flusso al logout e alla scadenza ordinaria. | **Superato per questi due scenari.** Resta il caso di durata assoluta della sezione 1. |

## 3. Test e copertura

| Area | Risultato rilevato |
|---|---|
| Suite applicative | **35/35** script passati. Tutti i 34 script elencati in `npm test` sono stati eseguiti singolarmente per registrare l’esito di ciascuno, più `tests/security/input-validation-hardening.test.ts`. Nessun timeout. |
| Build e controlli statici | **3/3**. Build frontend e backend, lint e typecheck frontend. |
| Accettazione e integrazione | Passati i percorsi di autenticazione, protezione API, flotta e modifica configurazione, registrazione rigorosa e differita, rimozione e conservazione dati, monitoraggio, SSH/SFTP e host key, terminale PTY/WebSocket, filesystem e trasferimenti. Verificati sulle fixture anche permessi, integrità e checksum, upload >1 GB, concorrenza e riavvio. La suite di accettazione ha riportato 35 criteri e 18 obiettivi essenziali collaudati. |
| Chrome 156.0.8078.47 | E2E React passato. Percorsi coperti su login, flotta, filtri, portali/menu, Logs, filesystem server e remoto, trasferimenti, modale inattività, terminale locale, logout con clic ripetuti, navigazione Indietro, ricarica, rete assente e riconnessione. Misurati 20 cicli consecutivi nello stesso documento con revoca lato server, cookie assente e API protetta a 401 dopo ogni logout. |
| Firefox 149.0.2 | **7/8** scenari di compatibilità passati e **1 osservazione** sulla verifica iniziale della sessione. Schema di prova indipendente via WebDriver. Passati login, focus modale, navigazione Flotta/Logs, logout, ricarica e propagazione a una seconda scheda. **20/20** cicli misurati nello stesso documento, con cookie assente a ciascun logout. La copertura Firefox non include la matrice completa PTY e trasferimenti complessi. |
| Desktop, mobile e interazioni | Oltre alle asserzioni DOM, ho ispezionato le schermate della flotta vuota a 1440×900 e 390×844. I controlli principali sono leggibili e il logout è raggiungibile con un tocco. Sul mobile la tabella scorre orizzontalmente e il messaggio di flotta vuota, centrato nella tabella, rimane fuori dalla porzione inizialmente visibile. Osservazione grafica minore, senza confronto con il commit precedente. Prove su browser desktop con viewport e touch emulati. |
| Console e log | Nessun errore JavaScript catturato durante i 20 cicli Chrome. Firefox non ha rilevato eccezioni JavaScript non gestite nei 20 cicli. I log di suite contengono i rifiuti e i guasti intenzionali dei test, inclusi 401 dopo revoca. WebDriver ha emesso messaggi interni del browser. Il runner di carico ha registrato i rifiuti imprevisti descritti sotto. I log di produzione e la console di ogni combinazione di browser e funzionalità restano fuori dalla copertura. |
| Dipendenze | `npm audit --json` sul lockfile ha restituito **0 avvisi** al momento del controllo. |

**Test di carico separato, non superato come prova di capacità.** Ho eseguito `scripts/load-test.ts` con 25 utenti, 10 robot e i limiti predefiniti. Il processo ha restituito 0, ma tutti i 25 tentativi PTY sono stati respinti per autorizzazioni insufficienti, con **0 terminali aperti**. Le promesse di upload vengono avviate senza attenderne l’esito nel conteggio e gli stream vengono chiusi dal runner. Il risultato non dimostra il limite di 20 terminali né il comportamento dei trasferimenti sotto un carico rappresentativo. I controlli di concorrenza delle suite PTY e di affidabilità sono passati sulle loro fixture.

## 4. Logout e rete simulata

Tempi in millisecondi. Il feedback va dal clic alla comparsa del login. Il tempo completo termina quando il form torna utilizzabile dopo la conferma server. La durata HTTP del POST deriva da Performance Resource Timing. Il p95 è il 19º campione ordinato su 20.

| Browser | Misura | Min | Mediana | p95 | Max |
|---|---|---:|---:|---:|---:|
| Chrome | Feedback | 3,2 | 6,05 | 13,6 | 17,6 |
| Chrome | Completo | 15,2 | 24,7 | 37,9 | 47,0 |
| Chrome | API | 2,9 | 6,1 | 12,0 | 15,9 |
| Firefox | Feedback | 2 | 4 | 10 | 16 |
| Firefox | Completo | 10 | 23,5 | 38 | 79 |
| Firefox | API | 3 | 7 | 17 | 21 |

Tutti i 40 cicli ordinari hanno dato feedback entro 100 ms e completato il logout in meno di un secondo. Con **1.200 ms** di latenza simulata, Chrome ha mostrato il feedback in **5,2 ms**. Con la risposta del logout sospesa ha mostrato il retry dopo **5.038,5 ms** a sessione già revocata. Il test verifica la protezione del cookie della sessione successiva e l’annullamento del polling precedente.

In Firefox, ritardando artificialmente `/api/auth/me` di **4 s**, a **375 ms** era ancora visibile la schermata di verifica e il form era assente. Il form è apparso dopo la risposta. Il codice non impone una propria scadenza a quel controllo né alla richiesta di login. La limitazione MOL-R-P2-001 resta aperta e riguarda l’ingresso, mentre il feedback del logout ha rispettato la soglia nei cicli misurati.

| Ciclo | Chrome · feedback | Chrome · completo | Chrome · API | Firefox · feedback | Firefox · completo | Firefox · API |
|---:|---:|---:|---:|---:|---:|---:|
| 1 | 10,9 | 37,9 | 12,0 | 16 | 79 | 21 |
| 2 | 4,9 | 21,9 | 6,5 | 8 | 38 | 17 |
| 3 | 3,2 | 19,9 | 4,3 | 5 | 34 | 14 |
| 4 | 5,4 | 25,1 | 6,3 | 3 | 35 | 13 |
| 5 | 6,4 | 25,4 | 5,2 | 10 | 34 | 7 |
| 6 | 4,6 | 35,7 | 15,9 | 5 | 25 | 9 |
| 7 | 6,3 | 26,1 | 7,9 | 3 | 24 | 13 |
| 8 | 6,8 | 24,3 | 7,4 | 4 | 28 | 10 |
| 9 | 5,3 | 26,4 | 5,9 | 4 | 25 | 12 |
| 10 | 5,2 | 15,2 | 3,1 | 7 | 23 | 5 |
| 11 | 8,9 | 18,1 | 3,0 | 3 | 10 | 3 |
| 12 | 5,4 | 18,7 | 4,0 | 5 | 28 | 7 |
| 13 | 8,2 | 32,7 | 7,2 | 3 | 17 | 6 |
| 14 | 9,3 | 29,1 | 6,8 | 4 | 20 | 7 |
| 15 | 5,8 | 22,3 | 5,6 | 4 | 15 | 6 |
| 16 | 17,6 | 47,0 | 9,6 | 2 | 20 | 4 |
| 17 | 13,6 | 37,9 | 7,7 | 3 | 16 | 6 |
| 18 | 7,9 | 19,3 | 3,5 | 4 | 17 | 6 |
| 19 | 3,7 | 16,4 | 2,9 | 5 | 14 | 5 |
| 20 | 3,4 | 18,8 | 3,1 | 5 | 18 | 6 |

## 5. Database, sessioni e configurazione operativa

- **Persistenza di collaudo.** Le suite Mongo isolate hanno verificato gli indici univoci, gli indici audit composti, la cifratura e la rotazione delle credenziali, la marcatura e la rimozione condizionale. I test di guasto con `FleetService` hanno verificato la coerenza dell’anagrafica e dell’archivio su repository in memoria. Il recupero end-to-end dopo un riavvio con un guasto reale di Mongo e del vault resta da collaudare. Il coordinamento delle mutazioni documentato dal report delle correzioni opera per singola istanza applicativa.
- **Persistenza operativa locale.** Mongo ha risposto su loopback e la connessione in sola lettura non aveva un’identità autenticata. Ho contato 2 utenti, 2 clienti, 2 impianti, 616 eventi di audit, 0 robot, 0 credenziali robot e 0 record di telemetria. Presenti indici univoci per utenti, robot, credenziali, clienti e impianti e TTL di 30 giorni per audit e 90 giorni per telemetria. La query recente con limite 100 ha esaminato 100 chiavi e 100 documenti. Zero gruppi di ID robot duplicati sulla collezione vuota. Il campione operativo è insufficiente per valutare relazioni tra anagrafiche e credenziali con una flotta popolata, backup o ripristino.
- **Sicurezza delle sessioni e dei flussi.** Le suite hanno verificato attributi `Secure`, `HttpOnly` e `SameSite=Strict`, revoca, cookie rimosso, protezione delle API, sessioni concorrenti, scadenza ordinaria, isolamento dei ruoli e chiusura SSE. Il risultato sul limite assoluto con trasferimento attivo è riportato nella sezione 1.
- **SSH.** L’integrazione su loopback ha usato un server SSH/SFTP di prova, verifica della chiave host e modalità rigorosa. La sonda TCP sulla VM ha confermato il blocco già indicato nei due report. Host key e credenziali del robot reale, rimozione end-to-end su quell’ambiente e raggiungibilità con l’allowlist di produzione restano senza prova.
- **Punti di staging dai report precedenti.** È ancora presente il fallback Origin per host con entrambi gli schemi HTTP/HTTPS. L’unità modello systemd imposta `ProtectSystem=strict` e dichiara scrivibile la directory dati, mentre il logger usa per default `cwd/logs`. Il client dei trasferimenti mantiene SSE e polling. Sono riscontri di codice. Proxy, TLS e schema canonico, percorso log effettivo, autenticazione e ruoli Mongo, egress SSH e carico con una flotta rappresentativa non sono stati collaudati sul deployment di rilascio.

## 6. Git, riproducibilità e limiti

- `git status` iniziale pulito. `git diff --check` sullo storico da `8ef73ff`, sulla working tree e sull’indice senza segnalazioni. Il delta storico comprende 17 file tra correzioni, test e i due report. Nessun `debugger` o nuova stampa di debug nel codice applicativo di quel delta. Le nuove stampe rilevate appartengono ai test. Nessun file temporaneo o chiave privata tra i file aggiunti dal delta.
- Scansione per pattern di **817 file UTF-8 tracciati**. I nove riscontri riguardavano fixture di test, un marcatore di chiave fittizia usato per verificare la redazione e un URI generato da variabili nello script d’installazione. Nessuna credenziale reale identificata nella scansione. `.env`, certificati, chiave master, build e log locali risultano ignorati. La scansione riguarda il commit e i pattern controllati. Non copre l’intera cronologia o copie fuori da Git.
- I test applicativi hanno usato timeout da 115 a 155 s per script, con limite complessivo di 550 s. Le prove browser supplementari e le verifiche dell’ambiente hanno usato limiti separati. Gli ambienti di test sono stati arrestati. Nessun servizio operativo è stato riavviato durante la validazione.
- Evidenze locali in `/tmp/moliris-final-validation/logs/`. `tests.tsv` e `runs/` per esiti e console, `firefox.jsonl` e `metrics.json` per i cicli, `chrome-extra.jsonl`, `chrome-touch.jsonl` e le due immagini per layout e interazioni. `absolute-session-confirmed.json`, `removal-audit-retest.log`, `load-test.log`, `environment.log` e `mongo-readonly.jsonl` per le conclusioni di rilascio. Le evidenze sono temporanee e i risultati determinanti sono riportati sopra.

Il rilascio resta **NO-GO**. Per riesaminare il verdetto servono una prova positiva del limite assoluto con trasferimenti attivi, l’audit della rimozione anche in caso di recupero e una prova SSH rigorosa su un robot reale o su una VM rappresentativa usando il build candidato in staging. Il carico operativo e i controlli di sicurezza del deployment restano da validare.
