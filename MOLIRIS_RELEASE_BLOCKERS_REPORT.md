# Moliris · Rimozione dei blocchi di rilascio

**NO-GO** per il rilascio. Le correzioni applicative e il collaudo locale del candidato hanno superato le prove indicate sotto. La registrazione SSH rigorosa su un robot reale o sulla VM rappresentativa resta bloccata prima dell’handshake. La topologia di produzione resta da collaudare.

**Perimetro.** 25 novembre 2026. Candidato in working tree su `main`, base Git `0dfe13369981d4c7682c34d83d72b3d5c929d352`. Ho confrontato l’audit iniziale, il report delle correzioni e la validazione finale con il codice e con prove ripetute. Ho usato dati sintetici per tutte le scritture di collaudo. La patch collaudata ha SHA-256 `60bcdf18fa3a8084671710953a8106cc571ed8cb9f08495ab68bc3bf68175a07`. I report precedenti e le modifiche nell’altro checkout sono stati preservati. Nessun commit o push.

## 1. Sincronizzazione dell’ambiente

Il listener HTTPS su `127.0.0.1:8443` appartiene all’unità systemd utente `moliris-local-updated.service`. Il comando esegue il backend compilato nel checkout GitHub e la directory di lavoro è il secondo checkout locale, usato anche per caricare la configurazione. Quest’ultimo ha modifiche locali e un HEAD separato. Il frontend veniva letto dagli artefatti `dist/frontend` accanto al backend compilato. Gli hash serviti coincidevano con il vecchio `dist` anche via curl. L’HTML è servito con `Cache-Control: no-store`. La ricerca nel client non ha rilevato un service worker e non è stato rilevato un proxy sulle porte 80/443 né un runtime Docker/Podman. La causa verificata era la build obsoleta.

Prima delle modifiche ho compilato il commit base, conservato la build precedente e riavviato l’unità. Dopo il collaudo ho installato gli artefatti del candidato e riavviato di nuovo lo stesso servizio. Il nuovo processo ha restituito `OK` su `/healthz`. Il backend compilato sul posto ha superato il confronto col candidato. Anche l’HTML e i due asset sono identici byte per byte sul servizio locale e nello staging isolato.

| Asset | Prima | SHA-256 del candidato compilato e servito |
|---|---|---|
| JavaScript | `index-BI0Q_h2c.js` | `index-LqK7nwII.js` · `cf15c2afea5bc0681ad1d2e3041c820d20f742d634c3e695044af988733c8af5` |
| CSS | `index-DPiYVbyi.css` | `index-Dnp9Fmig.css` · `04f4da7b1975bb2a854a47ca00052d611b30dee1d2e213a9cb53d6e04184813c` |

## 2. Durata assoluta, stream e trasferimenti

Il gestore controllava l’attività dei trasferimenti prima del limite assoluto. A 121 secondi con un limite di 120 secondi, il caso riprodotto conservava una sessione attiva finché il trasferimento non terminava.

Il gestore ora verifica il limite assoluto prima dell’inattività e dispone di un timer autonomo per revocare sessioni prive di nuove richieste. L’attività ordinaria e i trasferimenti incidono sul timer di inattività. Il limite assoluto è ancorato alla creazione della sessione. La revoca attiva la chiusura degli stream, dei WebSocket e delle risorse PTY. I trasferimenti della sessione sono annullati prima della promozione dello staging. Se la sostituzione di un file già verificato è stata inoltrata, può concludersi per preservare la destinazione. Gli handle SFTP restituiti dopo la revoca vengono rilasciati.

La regressione HTTPS ha aperto insieme SSE, WSS con PTY e un upload in corso. La revoca ha chiuso i due stream, dato 401 su heartbeat e flotta, annullato l’upload, rimosso il file temporaneo e preservato la destinazione preesistente. Il vecchio contesto non ha potuto avviare un nuovo trasferimento e l’audit ha riportato `ABSOLUTE_TIMEOUT`. Le prove unitarie verificano il limite esatto e il timer senza nuove richieste. La suite trasferimenti ha verificato il rilascio dell’handle SFTP acquisito dopo la revoca.

## 3. Audit della rimozione dopo guasti e riavvio

Prima, dopo un guasto del purge, il retry trovava l’anagrafica già assente, ripuliva il vault e terminava prima di registrare l’evento. La prova precedente aveva osservato **0 eventi** invece dell’evento atteso.

La rimozione ora registra prima un intento persistente in `pending_robot_removals`, con un ID stabile per l’evento, l’autore e i riferimenti del robot. Il flusso marca il vault, cancella l’anagrafica, esegue il purge condizionale, registra l’evento con upsert idempotente e chiude l’intento solo dopo la conferma della scrittura. Le operazioni del journal e dell’evento MongoDB richiedono scrittura confermata e journaling. Il recupero rientra nel percorso del retry e parte all’avvio di Fastify. L’ID del robot resta riservato durante il recupero. I dati di archivio restano sul filesystem.

Le regressioni simulano errori del journal, cambio di stato, marcatura del vault, cancellazione anagrafica, purge, scrittura audit e risposta audit persa. In MongoDB standalone isolato, la prova con una connessione nuova e un nuovo avvio Fastify ha verificato **1 solo evento logico**, attribuito all’autore originale, e un evento distinto sul successivo riuso dell’ID. L’archivio è rimasto intatto. La prova riguarda una singola istanza applicativa. Le rimozioni storiche prive di intento possono ancora ripulire condizionalmente la credenziale marcata, ma il loro autore storico non è ricostruibile.

## 4. SSH del robot e ripristino dell’ambiente

Il commit del collega `d03fa98` è presente come antenato. Il backend gira come processo locale, con configurazione `MOLIRIS_REGISTRATION_MODE=rigorosa`. Sulle porte host **2223 e 2224** la sonda TCP ha restituito `Connection refused`. VirtualBox 7.2.22 mostra entrambe le VM in stato `aborted`, con la prima scheda in modalità NAT e nessuna regola di inoltro per le porte. I log di entrambe riportano `VERR_VMX_MSR_ALL_VMX_DISABLED`. Sul sistema host il dispositivo `/dev/vboxdrv` è presente. Il servizio SSH interno al guest e la sua identità non sono verificabili a VM spenta. Il test applicativo CA-ROB-003 con una fixture SSH è passato con verifica della host key. Il collaudo reale resta bloccato.

1. Accendere l’HP ProBook 450 G2, premere **F10** per entrare nel BIOS e abilitare **Virtualization Technology (VTx)**. La posizione della voce dipende dalla revisione del BIOS. Salvare, riavviare e verificare che `VBoxManage list hostinfo` riporti la virtualizzazione hardware disponibile. [Guida HP alla virtualizzazione nel BIOS](https://support.hp.com/gb-en/document/ish_5637142-5637191-16)
2. Identificare in console il guest predisposto per il robot verificando hostname, utente e configurazione concordati. Per assegnare la porta 2224 al guest `robot2`, dopo averne confermato l’identità e con VM spenta, usare `VBoxManage modifyvm "robot2" --nat-pf1 "moliris-ssh-2224,tcp,127.0.0.1,2224,,22"`. La stessa regola si applica a 2223 solo se serve effettivamente un secondo endpoint. Avviare il guest con `VBoxManage startvm "robot2"`. [Guida Oracle al port forwarding NAT](https://docs.oracle.com/en/virtualization/virtualbox/7.2/user/networkingdetails.html)
3. Nella console del guest, controllare che `ssh.service` sia attivo con `systemctl status ssh` e che `ss -ltn '( sport = :22 )'` mostri il listener. Su Ubuntu, se OpenSSH Server è installato ma inattivo, avviarlo con `sudo systemctl enable --now ssh`. Dal sistema host verificare il listener `127.0.0.1:2224` e provare `ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=yes -p 2224 UTENTE@127.0.0.1` dopo avere registrato in `known_hosts` la chiave confrontata con quella del guest attraverso la console fidata. Usare quella stessa impronta verificata in Moliris e ripetere CA-ROB-003. [Guida Ubuntu a OpenSSH Server](https://ubuntu.com/server/docs/how-to/security/openssh-server/)

L’intervento nel firmware richiede accesso alla macchina. Dopo il ripristino della VM occorre provare registrazione e rimozione complete con le credenziali autorizzate, i percorsi attesi e la verifica rigorosa mantenuta.

## 5. Test di carico eseguibile

Il runner precedente usava account `operatore`, mentre il servizio PTY richiede un amministratore. Ignorava inoltre il limite PTY indicato e contava upload avviati senza attenderne l’esito. La baseline ha restituito 0 con 25 rifiuti RBAC e zero terminali aperti.

Il nuovo runner aumenta il carico per stadi con account amministrativi di prova e connessioni SSH effettive su loopback. Verifica anche il rifiuto RBAC di un operatore, i limiti attesi, l’echo PTY, i risultati degli upload, i byte e il SHA-256 in rilettura. Distingue il rifiuto atteso per saturazione da errori inattesi e controlla che slot e connessioni tornino a zero. Una mutazione di prova che usa il ruolo `operatore` per le aperture previste ha restituito codice **1**.

| Utenti | PTY aperti / rifiutati per limite | Upload verificati / rifiutati per limite | P95 apertura PTY / echo / upload | CPU su un core | RSS picco | Durata |
|---:|---:|---:|---:|---:|---:|---:|
| 8 | 5 / 3 | 3 / 5 | 138,7 / 12,8 / 400,3 ms | 23% | 132,6 MiB | 1,78 s |
| 25 | 20 / 5 | 10 / 15 | 343,6 / 63,8 / 923,2 ms | 28,8% | 141,4 MiB | 3,22 s |
| 50 | 35 / 15 | 20 / 30 | 298,5 / 17,8 / 512,6 ms | 52,8% | 159,6 MiB | 2,48 s |

Tutti e tre i profili hanno registrato zero errori inattesi e zero PTY o connessioni SSH residue. Il tempo upload include la pausa dello staging prevista dal ramp-up. Le misure riguardano una fixture breve con terminale SSH e upload su filesystem locale. Il carico HTTP, il proxy, i robot reali e la stabilità su più ore restano fuori perimetro.

## 6. Regressioni, browser e staging

| Controllo | Risultato |
|---|---|
| Suite applicative | **35/35**. Include integrazione, accettazione, SSH/SFTP, streaming oltre 1 GB, integrità, RBAC e i quattro casi originali di audit login, rimozione, logout su schermi stretti e focus della modale. |
| Build e controlli statici | **3/3**. Build frontend e backend, lint e TypeScript frontend. |
| Login e logout | **40 cicli** completi. 20 sullo stesso documento Chrome e 20 sullo stesso documento Firefox. Verificati cookie rimosso, focus, sincronizzazione Firefox tra schede, console e regressioni Chrome con clic ripetuti e rete lenta. |
| Estensione Firefox 149.0.2 | Passati terminale locale con output, terminale SSH remoto con echo e ridimensionamento, navigazione file, invio dalla modale, trasferimento SFTP bidirezionale, download con confronto del contenuto e verifica dello storico. Nessuna eccezione JavaScript non gestita nello scenario. |
| Sessioni e audit | Passate le nuove regressioni con timer, WebSocket, SSE, trasferimento interrotto, SFTP in ritardo e recupero di rimozione su MongoDB isolato. |
| Staging locale con profilo production | Passati TLS con verifica del certificato di fixture, MongoDB con autenticazione e rifiuto della lettura anonima, ruolo applicativo limitato al database di collaudo, vault Mongo, allowlist SSH `none`, controllo Origin, login, cookie, revoca e scrittura del log accessi. |
| Modello systemd | `systemd-analyze verify` ha restituito 0. Il modello aggiunge `LogsDirectory=moliris` e `MOLIRIS_LOGS_DIR=/var/log/moliris` con permessi 0750. La direttiva mantiene la directory dedicata scrivibile con `ProtectSystem=strict`. L’unità di sistema installata e il proxy di produzione restano da collaudare. [Documentazione systemd sui percorsi scrivibili](https://freedesktop.org/software/systemd/man/latest/systemd.exec.html) |

Il primo tentativo della suite streaming ha restituito `EDQUOT` durante due scritture concorrenti oltre 1 GB in `/tmp`. Il giro finale è stato ripetuto da uno snapshot aggiornato con scratch separato su ext4. Lo scratch di test è stato rimosso al termine. Un avvio Chrome senza CDP raggiungibile è stato ripetuto isolatamente con profilo standard. Anche il bootstrap WebDriver e la scelta della directory nella prova Firefox sono stati ripetuti con attese esplicite per i rispettivi stati. Le evidenze dei tentativi sono conservate separatamente.

Tempi di logout in millisecondi. Il feedback termina quando appare il login e il tempo completo quando il form torna utilizzabile dopo la conferma del server. Le misure sono di laboratorio. La validazione precedente aveva mediane complete di 24,7 ms in Chrome e 23,5 ms in Firefox. I profili di carico del computer sono diversi tra le due misure.

| Browser | Feedback mediana / p95 / max | Completo mediana / p95 / max | API mediana / p95 / max |
|---|---:|---:|---:|
| Chrome | 5,6 / 13,3 / 15,3 | 21,2 / 39,1 / 44 | 4,6 / 12,9 / 18,8 |
| Firefox | 6,5 / 13 / 14 | 34,5 / 59 / 67 | 10 / 23 / 27 |

Tutti i feedback sono arrivati entro 100 ms e tutti i logout ordinari entro un secondo. Con 1.200 ms di latenza simulata, Chrome ha mostrato il feedback in 14 ms. Con risposta del logout sospesa, il retry è apparso dopo 5035,3 ms a sessione già revocata.

Resta aperta l’attesa iniziale di riconoscimento della sessione. In Firefox, con risposta di `/api/auth/me` ritardata di 4 s, a 473 ms il form era ancora assente. È comparso alla risposta.

## 7. File modificati ed evidenze

- Durata e revoca in `backend/auth/session-manager.ts`, `backend/auth/auth-middleware.ts`, `backend/auth/auth-routes.ts`, `backend/terminal/terminal-routes.ts`, `backend/terminal/terminal-service.ts`, `backend/transfer/transfer-routes.ts` e `backend/transfer/transfer-service.ts`.
- Rimozione, audit e recupero in `backend/fleet/fleet-service.ts`, `storage/audit-repository.ts` e `backend/server.ts`.
- Regressioni aggiunte nei runner esistenti `backend/fleet/fleet.test.ts`, `backend/transfer/transfer.test.ts`, `tests/database/database-improvements.test.ts`, `tests/security/inactivity-session-hardening.test.ts` e `tests/security/logout-persistence.test.ts`.
- Runner di carico in `scripts/load-test.ts`, configurazione log in `moliris.service` e questo report.
- Evidenze temporanee in `/tmp/moliris-release-blockers/logs/`. In particolare `final-suite/tests.tsv`, `final-suite/results.tsv`, `chrome-final-retest.log`, `final-suite/runs/`, `environment-sync.log`, `environment-candidate.log`, `ssh-and-unit.log`, `staging-candidate.log`, `firefox.jsonl`, `firefox-integration-candidate.jsonl`, `browser-metrics.json` e `load-metrics.json`.

Il criterio essenziale ancora aperto è CA-ROB-003 sul robot reale o sulla VM rappresentativa. Restano da validare anche il proxy e l’egress nella topologia finale, il carico rappresentativo e l’eventuale esecuzione con più istanze applicative. Nel codice resta il fallback Origin sullo stesso host per entrambi gli schemi, e il client trasferimenti mantiene polling e SSE. Lo staging locale ha verificato controlli specifici, mentre il deployment di produzione richiede la propria verifica.
