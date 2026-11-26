# Moliris Maintenance WebApp — Audit tecnico e collaudo QA

**26 novembre 2026 · Europe/Rome · Esito NO-GO per la produzione**

L’istanza individuata sull’host accessibile è l’unità di sistema `moliris.service`, con applicazione installata in `/opt/moliris/Moliris_Maintenance_Webapp_SRS`. L’unità era `inactive/dead`, disabilitata all’avvio e senza processo principale. Le richieste HTTPS a `127.0.0.1:8443` sono state rifiutate. La build installata diverge da quella ricompilata dal commit auditato. Due VM candidate risultavano ferme, senza regole di inoltro NAT visibili. Le prove di login, terminale e trasferimento riuscite su fixture non certificano il servizio installato.

L’ispezione dell’host è avvenuta in sola lettura. Il collaudo ha utilizzato un archivio Git del commit `fc0518c5aa402fcda09aa6c7b37822c82dd77d7d`, dipendenze copiate, filesystem temporaneo e namespace di rete separati privi di accesso a reti esterne. MongoDB, certificati e robot SSH/SFTP delle prove erano fixture. Le prove browser hanno usato Chrome 156.0.8078.47 via CDP. Node era 22.22.1 e il MongoDB di prova era 9.0.4. Non sono stati effettuati riavvii, modifiche di configurazione, deploy o mutazioni dei dati del servizio installato. Nessun FQDN, endpoint VPN o secondo host aziendale è stato identificato nelle evidenze disponibili. Il NO-GO si applica all’installazione ispezionata e al rilascio del commit auditato verso quella destinazione.

## Riepilogo verifiche

**54 controlli censiti · 41 eseguiti · 33 PASS · 8 FAIL · 9 BLOCKED · 4 NOT TESTED.**

Le righe della matrice rappresentano controlli indipendenti. **PASS** indica un comportamento verificato nel contesto indicato, **FAIL** uno scostamento osservato, **BLOCKED** una verifica impedita da un prerequisito e **NOT TESTED** un controllo non eseguito. Il totale degli eseguiti è PASS + FAIL. Il ledger Gravitas contiene anche tentativi tecnici e ripetizioni diagnostiche, che non incrementano la matrice.

### Host, deployment e controlli reali

| ID | Verifica | Stato | Evidenza |
|---|---|---|---|
| H01 | Identificazione installazione | PASS | `FragmentPath=/etc/systemd/system/moliris.service`; `WorkingDirectory=/opt/moliris/Moliris_Maintenance_Webapp_SRS`. Nessuna unità Moliris nel manager utente consultato. |
| H02 | Stato, processo e attivazione all’avvio | FAIL | `inactive/dead`, `MainPID=0`, `UnitFileState=disabled`. Nessun processo Node associabile. MA-01. |
| H03 | Accessibilità HTTPS e health HTTP | FAIL | `curl` a `/` e `/healthz` su `127.0.0.1:8443` ha restituito codice 7, HTTP 000. Nessun listener su 80, 443 o 8443 nella fotografia host. MA-01. |
| H04 | Accessibilità da rete operativa e VPN | BLOCKED | FQDN/URL e percorso operativo non identificati. L’endpoint documentato sul nodo era chiuso. |
| H05 | Validità statica unità systemd | PASS | `systemd-analyze verify` per unità installata e modello repository, codice 0. |
| H06 | Coerenza sorgente, build e unità | FAIL | Hash frontend e backend divergenti dalla build appena riprodotta, modulo log nuovo assente, unità installata diversa. MA-02. |
| H07 | Catena TLS, SAN, scadenza, protocolli, HSTS e WSS sul deployment | BLOCKED | Nessun handshake e materiale del servizio in area con accesso limitato. |
| H08 | Ambiente effettivo, vault, permessi di chiave e certificato | BLOCKED | `/etc/moliris` con modo 0750, `root:moliris`. Il file ambiente non era leggibile con l’identità di audit. |
| H09 | Permessi base della radice dati | PASS | `/var/lib/moliris/server-fs`, 0750 e `moliris:moliris`. Sottocartelle e ACL effettive non ispezionate. |
| H10 | Allocazione directory log nel modello candidato | FAIL | Il modello punta alla directory attualmente usata da MongoDB. MA-03. |
| H11 | Processi MongoDB e connettività di base | PASS | Entrambe le unità attive, listener loopback 27017/27018; `ping` ha restituito `ok:1` su entrambe. |
| H12 | Autenticazione configurata sulle due istanze MongoDB | FAIL | Configurazione dedicata 27018 con `authorization: enabled`. Configurazione dell’istanza 27017 senza direttiva attiva di autorizzazione. MA-05. |
| H13 | Identità applicativa MongoDB, ruolo e lettura DB reale | BLOCKED | Ambiente di servizio protetto e backend fermo. Nessun dato applicativo reale interrogato. |
| H14 | Journal e log operativi effettivi | BLOCKED | Nessuna entry Moliris visibile; journal avverte dei limiti di accesso. Contenuto dei log e rotazione sotto l’identità del servizio non verificati. |
| H15 | Risorse fisiche e processi database | PASS | Quattro CPU logiche; load average 3,39 / 2,32 / 2,02 in uno snapshot; RAM 14.893 MiB totali e 8.495 MiB disponibili in uno snapshot precedente; 819 GiB di disco disponibili su 915 GiB. RSS MongoDB circa 176/192 MiB, CPU media di processo 1,5% ciascuno allo snapshot. |
| H16 | VM registrate, NAT e porte guest previste | FAIL | Entrambe `aborted`; NIC 1 NAT, nessuna regola NAT visibile, nessun listener locale sulle porte candidate 2223/2224. MA-04. |
| H17 | Dal backend a ciascun robot reale, SSH e impronte | BLOCKED | Backend e VM indisponibili. Mappatura guest–robot, indirizzi, account e fonti fidate delle impronte da confermare. |
| H18 | Prestazioni reali, richieste duplicate, memoria e stabilità di produzione | BLOCKED | Nessun processo applicativo né sessione browser sul servizio installato. |
| H19 | Query MongoDB reali, `explain`, working set e latenza sotto carico | BLOCKED | Accesso applicativo in sola lettura e metriche/profili di produzione non disponibili. |
| H20 | Flusso end-to-end con operatori, robot e utenti reali | BLOCKED | Endpoint chiuso. Login, logout, ruoli, flotta, log, audit, PTY, WSS e trasferimenti reali restano da collaudare. |
| H21 | Ripristino da backup e continuità su host reale | NOT TESTED | Nessuna prova di ripristino eseguita nell’audit. |

### Collaudo del commit in ambiente isolato

| ID | Verifica | Stato | Evidenza |
|---|---|---|---|
| Q01 | Build frontend e backend | PASS | `npm run build`, exit 0, 19 s per il validatore. |
| Q02 | TypeScript backend e frontend | PASS | `npm run typecheck` e `npm run typecheck:client`, exit 0. |
| Q03 | Validazione configurazione, precedenze, errori e concorrenza | PASS | Suite configurazione di sistema/applicativa, Mongo e coerenza al caricamento, exit 0. |
| Q04 | Persistenza e indici MongoDB su database di prova | PASS | Suite storage, database improvements e unicità Mongo, exit 0; Mongo di fixture attivo. |
| Q05 | Login valido e credenziali errate | PASS | Suite auth e Chrome; dashboard visibile dopo login valido, messaggio esplicito dopo login errato. |
| Q06 | Cookie, sessione concorrente, scadenza e inattività | PASS | Suite auth, concurrent sessions e inactivity; Chrome ha verificato dialogo di conflitto e conto alla rovescia. |
| Q07 | Logout, revoca, persistenza e richieste duplicate | PASS | Suite logout e 20 cicli consecutivi in Chrome, un POST ciascuno, revoca verificata. |
| Q08 | Logout con API lenta e risposta sospesa | PASS | Latenza 1.200 ms simulata, feedback pubblico in 6,8 ms nel primo run; ripetizione dopo risposta sospesa e protezione della sessione successiva. |
| Q09 | Logout offline, riconnessione automatica e refresh | PASS | Suite Chrome originale superata con interfaccia virtuale interna e senza route predefinita; logout offline, riconnessione, risposta e refresh verificati. Il primo namespace con solo loopback non generava l’evento `online`. |
| Q10 | Ruoli, permessi e rifiuto delle richieste anonime | PASS | Controlli difensivi delle suite auth, terminale e trasferimenti; rifiuti previsti e audit su fixture. |
| Q11 | Gestione utenti e ruoli dal browser | NOT TESTED | Inventario sorgente: UI con visualizzazione dei ruoli e script di provisioning/reset. Le rotte auth consultate non contengono CRUD utenti e l’SRS §3.1 specifica login, sessioni e autorizzazioni. |
| Q12 | Dashboard, navigazione, menu, modali e focus | PASS | Chrome: flotta, trasferimenti, log, menu «Altre», tasto Escape, focus iniziale e ripristino, navigazione senza reload. |
| Q13 | Layout a più risoluzioni | PASS | Chrome: larghezze 320, 360, 390, 414, 768, 1.024 e 1.920 px; verifiche navbar, hit target e focus. Browser aggiuntivi da verificare. |
| Q14 | Stato frontend, console e HTTP durante il percorso misurato | PASS | Cinque cicli strumentati con zero eccezioni o errori console JS, 70 risposte 200, 5 risposte 204, 10 risposte 401 attese e 5 richieste cancellate durante il ciclo. |
| Q15 | Registrazione, modifica, cancellazione logica e unicità robot | PASS | Suite flotta superata con permessi DAC effettivi; prove su server SSH simulato. |
| Q16 | Input invalidi e rollback su errore di filesystem/DB | PASS | Suite flotta con accesso DAC effettivo e repository che simula un errore I/O; suite API su fixture. |
| Q17 | Destinazione irraggiungibile, handshake e verifica fingerprint SSH | PASS | Suite connessione con porta chiusa, firma host valida e difforme, autenticazione e prova a cinque passi del robot sintetico. |
| Q18 | Terminale server e terminale robot, PTY e WebSocket | PASS | Chrome su PTY locale e suite end-to-end WSS con robot simulato, prompt, resize e chiusura. |
| Q19 | Disconnessioni e timeout del terminale | PASS | Suite terminale, perdita WebSocket, timeout e rilascio risorse, chiusura in condizioni concorrenti. |
| Q20 | Trasferimenti file, progressi, integrità, annullamento e ripresa | PASS | Suite transfer su SSH/SFTP simulati, validazione checksum, interruzioni, ripresa e limiti concorrenti. |
| Q21 | Archivio generale, file locali, cartelle SFTP e navigazione | PASS | Chrome verifica archivio e modale file; suite transfer e new-features verificano flussi locali e cartelle SFTP nel perimetro riportato. |
| Q22 | Telemetria, aggiornamento manuale e ultima lettura valida | PASS | Suite monitoring e parser, fixture di stato e disconnessione. |
| Q23 | Consultazione log e audit, fusi orari, messaggi e notifiche | PASS | Chrome: log accessi/trasferimenti, UTC nel download e Europe/Rome nelle tabelle, test fixture estate/inverno; suite logger per redazione strutturata e formattazione. |
| Q24 | Screening dipendenze runtime | PASS | `npm audit --omit=dev` sul lockfile, totale 0 advisory riportati; hash del lockfile installato identico. |
| Q25 | Controlli difensivi CSP, CSRF, CORS e input | PASS | CSP e HSTS ricevuti via HTTPS; preflight fixture con origine esterna restituisce 404 senza `Access-Control-Allow-Origin`. Revisione regola CSRF, schemi input e flussi same-origin. |
| Q26 | Segreti tracciati, sicurezza chiavi e redazione | PASS | Screening limitato a 571 file testuali tracciati, quattro file con marcatori, ricondotti a fixture, controlli o placeholder; logger e restrizioni chiave verificati nel codice e su fixture. Storico Git e segreti effettivi esclusi. |
| Q27 | Trasferimento oltre 1 GiB, heap e concorrenza | PASS | Suite dedicata, sei direzioni, limite di concorrenza e rilascio degli slot. Misure riportate di seguito. |
| Q28 | Chiusura ordinata e riavvio della sola istanza isolata | PASS | Suite affidabilità, porta liberata e riutilizzata, stato della fixture preservato. |
| Q29 | Profilo produzione su binario compilato con Mongo autenticato e TLS verificato | PASS | Avvio via `dist/backend/server.js`, Mongo con autenticazione abilitata e ruolo applicativo limitato, TLS con CA fixture e controllo del nome. Login, sessione, flotta e API log restituiscono 200. |
| Q30 | Segnalazione del degrado in caso di Mongo indisponibile | FAIL | Dopo lo stop del solo Mongo temporaneo, `/healthz` restituisce 200 e l’API flotta autenticata 400 con `DB_PERSISTENCE_ERROR`. MA-06. |
| Q31 | Profilo memoria prolungato, picco RSS e p95/p99 ripetibili | NOT TESTED | Suite misura heap prima/dopo e non registra RSS, picchi continui o percentili di carico. |
| Q32 | Suite `npm test` integrale, scenari di sicurezza invasivi e browser aggiuntivi | NOT TESTED | Eseguite le suite mirate riportate. Nessun tentativo di sfruttamento o intrusion testing. |
| Q33 | Applicazione del limite di paginazione lato query MongoDB | FAIL | L’API con `limit=1` restituisce un risultato; la query del repository continua a esaminare 1.000 documenti nella fixture. MA-07. |

## Rilievi ordinati per priorità

### MA-01 — HIGH — Servizio installato indisponibile

- **Componente** — systemd, ingresso HTTPS/WSS.
- **Descrizione** — Il servizio di manutenzione identificato sull’host non serve richieste. Sono bloccati tutti i flussi operativi collegati a questa istanza.
- **Evidenza** — `ActiveState=inactive`, `SubState=dead`, `MainPID=0`, `UnitFileState=disabled`. Nessun listener su 8443. Due richieste HTTPS mirate a pagina iniziale e health hanno restituito curl 7 e HTTP 000. Nessuna entry leggibile nel journal consultato.
- **Riproduzione non distruttiva** — Consultare `systemctl show moliris.service -p ActiveState -p SubState -p MainPID -p UnitFileState` e `ss -ltn`. Richiedere `https://127.0.0.1:8443/healthz` usando il trust store previsto.
- **Atteso** — Sull’host designato, processo attivo e risposta HTTPS autenticabile dal client operativo.
- **Effettivo** — Unità inattiva, connessione rifiutata prima di TLS.
- **Causa** — Assenza del processo e del listener confermata. Motivo amministrativo o tecnico della mancata attivazione indeterminato con il journal e la configurazione accessibili.
- **Risoluzione** — Identificare l’endpoint operativo con il referente, ottenere il journal con un’identità abilitata, preparare e validare la configurazione in staging e concordare una finestra per il ripristino.
- **File** — `/etc/systemd/system/moliris.service`, `/etc/moliris/moliris.env`, `DEPLOY.md`.

### MA-02 — HIGH — Artefatti e unità installati divergono dal commit auditato

- **Componente** — Build, tracciabilità del deploy e copertura funzionale.
- **Descrizione** — Gli esiti sul checkout corrente non sono trasferibili alla build installata. Più moduli sorgente installati divergono e manca il modulo compilato delle rotte log presente nella build del commit auditato.
- **Evidenza** — SHA-256 abbreviati, installato → ricompilato. `dist/frontend/index.html` `bdac23b651bc → 0af7d028b20b`, `dist/backend/server.js` `630af0cad9df → c416fc53bb72`, `dist/backend/terminal/terminal-routes.js` `1a3bd92d1dfa → 6fd360f73db1`. `dist/backend/logging/log-routes.js` assente nella directory installata e presente nella build fresca. `package-lock.json` coincide. Il bundle index installato carica `index-D2QQisZH.js`; la build fresca carica `index-DMVefsQZ.js`.
- **Riproduzione** — Compilare il commit dichiarato in una directory temporanea e confrontare checksum, inventario dei moduli e `diff -u` delle unità. Il percorso installato non deve essere usato come destinazione della build.
- **Atteso** — Un commit/versione identificabile con manifest e corrispondenza verificabile tra unità, frontend e backend.
- **Effettivo** — Build e unità divergenti. Revisione Git esatta dell’artefatto installato non attribuibile.
- **Causa** — Set di artefatti diversi confermato. La procedura ha uno staging che esclude `.git`; l’audit non attribuisce i file installati a uno specifico deploy precedente.
- **Risoluzione** — Distribuire da un artefatto immutabile con commit e manifest, quindi collaudare sullo stesso artefatto approvato.
- **File** — `scripts/install-local-server.sh`, `moliris.service`, `dist/frontend/index.html`, `dist/backend/server.js`, `dist/backend/terminal/terminal-routes.js`, `dist/backend/logging/log-routes.js` sotto le due radici.

### MA-03 — HIGH — Conflitto tra directory log candidata e MongoDB

- **Componente** — Modello systemd di rilascio, audit fisico e database dedicato.
- **Descrizione** — Il modello candidato chiede a systemd di allocare `/var/log/moliris` al servizio che gira come `moliris`. La directory è già di MongoDB e contiene il percorso di log del processo dedicato. Il rischio si manifesta applicando il modello.
- **Evidenza** — `moliris.service` candidato contiene `LogsDirectory=moliris`, modo 0700 e `MOLIRIS_LOGS_DIR=/var/log/moliris`. Sul nodo la directory è `0750 mongodb:mongodb` e `/etc/mongod-moliris.conf` definisce `/var/log/moliris/mongod.log`. Il logger applicativo prova inoltre ad applicare 0700 alla propria directory.
- **Riproduzione non distruttiva** — Confrontare i due file di configurazione e i metadati con `stat`. Per verificare l’effetto di un avvio usare esclusivamente copie e directory in staging.
- **Atteso** — Ogni servizio dispone di una directory log distinta con proprietario e modalità coerenti con journaling e rotazione.
- **Effettivo** — Il modello candidato condivide la directory; l’unità installata non contiene la direttiva candidata né un percorso log scrivibile dichiarato esplicitamente nell’unità. Il valore effettivo del file ambiente resta ignoto.
- **Causa** — Collisione del percorso confermata. Mancata scrittura dei log sul nodo e danni da avvio/rotazione non osservati.
- **Risoluzione** — Assegnare alla WebApp una directory dedicata, poi verificare scrittura, rotazione, accesso alle tabelle e permanenza dei permessi MongoDB con le due identità di servizio.
- **File** — `moliris.service`, `/etc/systemd/system/moliris.service`, `/etc/mongod-moliris.conf`, `backend/server.ts:314`, `backend/logging/physical-file-logger.ts:122`.

### MA-04 — HIGH — Nessun percorso operativo verificabile verso le due VM candidate

- **Componente** — VirtualBox, rete host/guest, accesso a robot e terminale remoto.
- **Descrizione** — Entrambe le VM registrate sono ferme. L’adattatore 1 è in NAT e non sono state rilevate regole di inoltro né listener alle porte candidate.
- **Evidenza** — `VBoxManage list runningvms` vuoto; `showvminfo` restituisce `VMState="aborted"` e `nic1="nat"` per entrambe; `ss` non mostra 2223/2224. Nei log degli ultimi avvii di entrambe compare `VERR_VMX_MSR_ALL_VMX_DISABLED`. Nel contesto host ispezionato il flag VMX non era visibile.
- **Riproduzione non distruttiva** — Leggere stato VM, configurazione NAT e stato listener. Consultare i messaggi di avvio esistenti. Non occorre avviare i guest per verificare questi elementi.
- **Atteso** — Guest autorizzato attivo, endpoint SSH identificato e raggiungibile dal backend, chiave host corrispondente all’impronta ottenuta da fonte fidata.
- **Effettivo** — VM ferme e percorso NAT non configurato per le porte candidate. Nessun handshake, fingerprint o accesso guest reale verificabile.
- **Causa** — Ultimi avvii interrotti con errore relativo a VT-x; lo stato del firmware e la relazione tra ciascuna VM e un robot sono da confermare. Anche con guest attivi, l’inoltro NAT rimane da predisporre e collaudare.
- **Risoluzione** — Verificare VT-x nel firmware su finestra concordata, confermare inventario e schema di rete, poi validare raggiungibilità, autenticazione e impronta dal namespace del backend mantenendo la verifica rigorosa.
- **File/configurazioni** — Inventario VirtualBox e log `VBox.log` delle due VM, regole NAT e allowlist di `/etc/moliris/moliris.env`.

### MA-05 — MEDIUM — Baseline di autenticazione incoerente tra i due MongoDB locali

- **Componente** — MongoDB di sistema e MongoDB dedicato.
- **Descrizione** — L’istanza generica 27017 è attiva con configurazione priva di autorizzazione esplicita. L’altra istanza, sulla 27018, ha l’autorizzazione abilitata. Entrambe sono vincolate al loopback.
- **Evidenza** — `mongod.service` usa `/etc/mongod.conf` con `#security:` commentato; `moliris-mongodb.service` usa `/etc/mongod-moliris.conf` con `security.authorization: enabled`. La guida di deploy esemplifica 27017, mentre l’installer locale imposta 27018. `ping` riuscito su entrambe prova solo la connettività.
- **Riproduzione non distruttiva** — Identificare i file di configurazione associati ai processi attraverso systemd e confrontare le righe `net.bindIp`, `net.port` e `security.authorization`.
- **Atteso** — Sorgente dati di produzione identificata, autenticata e associata a un ruolo applicativo minimo, con runbook coerente con quanto installato.
- **Effettivo** — Baseline diversa sui due listener; endpoint e identità usati dal servizio reale indeterminati. Non sono state tentate letture anonime di dati.
- **Causa** — Presenza parallela dell’istanza generica e dell’istanza dedicata, con configurazioni diverse. Dipendenze dell’istanza generica non accertate.
- **Risoluzione** — Ricondurre guida e provisioning all’endpoint approvato e verificare l’accesso con ruolo applicativo. Allineare anche la dipendenza systemd all’istanza approvata. Inventariare i servizi che usano 27017 prima di modificare la sua configurazione.
- **File** — `/etc/mongod.conf`, `/etc/mongod-moliris.conf`, `/etc/systemd/system/moliris-mongodb.service`, `DEPLOY.md:148`, `scripts/install-local-server.sh:148`.

### MA-06 — MEDIUM — Degrado MongoDB nascosto dalla sonda e classificato come errore client

- **Componente** — Health, autenticazione e gestione errori API.
- **Descrizione** — A database indisponibile, il processo HTTPS resta attivo e la sonda restituisce 200. L’API protetta della flotta restituisce 400 nonostante la richiesta e la sessione di prova fossero valide prima dell’interruzione.
- **Evidenza** — Stesso binario compilato, stessa sessione. Prima dello stop del solo Mongo di fixture, `/healthz` e `/api/robots` erano 200. Dopo lo stop, health 200 in 6,1 ms, flotta 400 in 812,4 ms con `DB_PERSISTENCE_ERROR`. Ripetuto su due istanze temporanee.
- **Riproduzione** — In staging isolato, autenticarsi, verificare la lettura flotta, fermare il database di fixture e ripetere le due richieste con la stessa sessione.
- **Atteso** — La liveness può restare positiva. Una sonda di readiness deve segnalare la dipendenza indisponibile. L’API deve restituire un 5xx coerente per il guasto del servizio dati.
- **Effettivo** — La sonda esposta resta verde e l’API classifica il guasto come 400.
- **Causa** — `/healthz` risponde senza interrogare dipendenze. La ricerca utente nel pre-handler solleva `DB_PERSISTENCE_ERROR`. La mappa globale non lo prevede e applica il fallback 400.
- **Risoluzione** — Separare liveness e readiness con timeout breve e mappare esplicitamente l’indisponibilità temporanea della persistenza; testare gli errori provenienti anche dai pre-handler e collegare il monitoraggio alla readiness.
- **File** — `backend/server.ts:115`, `backend/server.ts:571`, `backend/auth/auth-middleware.ts:87`, `backend/auth/user-repository.ts:122`.

### MA-07 — MEDIUM — La paginazione flotta non limita il lavoro MongoDB

- **Componente** — API flotta e repository MongoDB.
- **Descrizione** — Il limite riduce la risposta HTTP, mentre il backend carica tutta la collezione e costruisce i DTO visibili prima di applicare la finestra richiesta.
- **Evidenza** — Su 1.000 robot sintetici, `GET /api/robots?limit=1` restituisce 200 con un robot. `explain("executionStats")` sulla query equivalente del repository rileva `COLLSCAN`, 1.000 documenti esaminati, 1.000 restituiti, 0 chiavi esaminate. La richiesta con limite è stata misurata a 98,4 ms in un singolo campione.
- **Riproduzione** — In un Mongo di prova, popolare la collezione con una flotta sintetica e invocare l’API con un account fixture; confrontare il numero di risultati con le statistiche del piano per la query di `MongoRobotRepository.list()`.
- **Atteso** — Il filtro pubblico e le autorizzazioni si applicano prima della paginazione, con un ordinamento stabile e una quantità di dati letti coerente con la pagina richiesta.
- **Effettivo** — La paginazione avviene in Node dopo la lettura e il filtro completi. L’incidenza sul deployment reale non è misurata.
- **Causa** — Il repository esegue `find({}).toArray()`; il servizio filtra per visibilità, converte in DTO e usa `slice`.
- **Risoluzione** — Portare nel repository filtro e paginazione preservando la visibilità per ruolo e per robot. Validare ordinamento, indici, istanze senza paginazione e regressioni con dataset rappresentativi.
- **File** — `backend/fleet/fleet-routes.ts:55`, `backend/fleet/fleet-service.ts:221`, `storage/robot-repository.ts:450`.

## Prestazioni e limiti di interpretazione

Cinque campioni Chrome su loopback, cache disattivata, un solo utente e piccola flotta in memoria. Il campione iniziale include la prima navigazione. Le durate HTTP applicative comprendono la lettura della risposta.

| Operazione | Mediana | Min–max |
|---|---:|---:|
| TTFB HTML | 7,6 ms | 3,8–76,9 ms |
| DOMContentLoaded | 96,5 ms | 67,1–405,1 ms |
| Richiesta `/healthz` | 5,4 ms | 3,7–17,8 ms |
| Login fino alla dashboard visibile | 107,5 ms | 96,0–154,5 ms |
| Richiesta autenticata `/api/robots` | 24,1 ms | 6,9–62,2 ms |
| Logout fino al form pubblico visibile | 12,4 ms | 7,9–18,7 ms |

In 20 cicli Chrome sullo stesso documento, il logout ha mostrato feedback in mediana **4,2 ms** (2,9–11,9), conferma in **19,7 ms** (10,3–32,3) e durata API in **3,6 ms** (2,8–9,6). Con 1.200 ms di latenza emulata il primo feedback è apparso in **6,8 ms**. Questi tempi non rappresentano la latenza VPN o Mongo di produzione.

Su un robot SSH simulato, un singolo controllo di connessione applicativo a cinque passi ha richiesto **102,6 ms**. Su una seconda prova, allocare il PTY ha richiesto **160,9 ms** e ricevere il primo prompt via WSS **194,0 ms** dall’inizio dell’allocazione. Il test WSS usa un certificato di fixture; lo smoke test HTTPS separato ha verificato certificato e nome mediante la CA di prova.

Lo smoke test sul binario compilato con Mongo autenticato ha misurato un login HTTP di **82,6 ms**, una lettura flotta iniziale di **14,6 ms** e **98,4 ms** con `limit=1` dopo l’inserimento di 1.000 robot sintetici, una richiesta per punto. Il piano della query equivalente del repository ha riportato **1.000 documenti esaminati**, **0 chiavi esaminate**, `COLLSCAN` e un tempo interno arrotondato di **3 ms**. Nessuna di queste misure è un percentile di produzione.

Il primo run Chrome ha fallito la riconnessione perché il browser rimaneva offline nel namespace con solo loopback. Il run mirato ha confermato `navigator.onLine=false`, nessun evento di riconnessione e ripristino al clic su «Riprova» quando il trasporto tornava disponibile. Lo stesso test originale, senza modifiche, ha superato riconnessione e refresh in un namespace con una scheda virtuale interna priva di route predefinita. Il primo esito è attribuito alla fixture. Anche la prima suite flotta aveva un errore di fixture: il namespace mappava l’utente a UID 0 e aggirava il modo 0555 del test. Con le capacità DAC rimosse, il rollback e l’intera suite flotta sono passati. I controlli sono rimasti confinati alla rete di test. [Chrome DevTools Protocol, emulazione di rete](https://chromedevtools.github.io/devtools-protocol/tot/Network/#method-emulateNetworkConditions)

La suite streaming ha richiesto 72 s nel complesso. Delta heap misurato prima/dopo, per direzione nell’ordine Computer→Server, Server→Computer, Server→Robot, Robot→Server, Computer→Robot, Robot→Computer: **+1, −6, −1, −1, +1, 0 MiB**. I delta negativi sono compatibili con la garbage collection. La metrica non misura picco RSS, memoria del processo SSH o crescita su sessioni lunghe. Il test programmato verifica un delta sotto 45 MiB per direzione; il README presenta una soglia più stretta, che richiede una metodologia esplicita prima di usarla come SLA.

Il lockfile auditato ha SHA-256 `e06d548737f997e7a4245f4fdb191dbd49c7fa01daaff9cd876485b8c1bcc801`. Il registro pubblico npm ha riportato zero advisory dirette o transitive nella scansione runtime. Il risultato riguarda il lockfile al momento del controllo. Il censimento testuale ha cercato marcatori di chiavi private nei file tracciati: i quattro riscontri erano in `RobotRegisterModal.tsx` e fixture/test di redazione, senza esporre il contenuto nel report.

## Piano di risoluzione e criteri GO

1. Confermare l’host di produzione, l’URL interno e gli accessi di audit. Determinare la causa della mancata attivazione dell’unità. Verificare configurazione effettiva, processo, journal e percorso dalla VPN.
2. Preparare l’artefatto di rilascio con commit e manifest. Separare i log WebApp e MongoDB. Verificare due servizi su staging, ciascuno con il proprio account, e allineare l’endpoint Mongo autenticato nella guida.
3. Ripristinare il percorso verso le VM o i robot autorizzati. Verificare identità, reachability, handshake, WSS, PTY, SFTP e integrità di un file di collaudo.
4. Completare il collaudo sul deployment effettivo con account amministratore e operatore. Validare TLS con la CA aziendale, sessioni, ruoli, log e audit; completare le prove invasive su staging, misurando latenza, risorse, query e trasferimenti sull’ambiente rappresentativo.
5. Correggere la gestione del degrado MongoDB e misurare la paginazione dopo aver introdotto filtri lato query.
6. Verificare il ripristino da backup in ambiente isolato e approvare il rilascio solo dopo aver chiuso i blocchi HIGH o documentato un’accettazione esplicita del rischio con criteri di collaudo equivalenti.

**Decisione finale: NO-GO.** Disponibilità dell’istanza, provenienza della build, compatibilità delle directory log e raggiungibilità dei robot sono condizioni di rilascio ancora aperte. Il collaudo isolato supporta lo sviluppo e delimita le verifiche sul prossimo artefatto, mentre autorizzazione, sicurezza e prestazioni della produzione restano da attestare sul percorso effettivo.
