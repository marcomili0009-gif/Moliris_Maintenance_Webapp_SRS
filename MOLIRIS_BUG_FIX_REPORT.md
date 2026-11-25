# Moliris · Correzioni e test di regressione

**Riferimento** [Audit completo](MOLIRIS_FULL_AUDIT_REPORT.md) · **Data** 25 novembre 2026 · **Base Git** `8ef73ff` · **Ambiente** snapshot isolato, HTTPS con certificato di prova, MongoDB di test, Chrome e Firefox headless.

## 1. Correzioni

| ID | Stato | Causa confermata | Correzione |
|---|---|---|---|
| MOL-P1-001 · Sessione orfana dopo errore audit | FIXED | Il login allocava una sessione prima della scrittura di audit. Un errore impediva l’invio del cookie e lasciava occupato lo slot. | La risposta di successo rimane subordinata all’audit. Se la scrittura fallisce, viene revocata la nuova sessione e l’errore raggiunge il gestore HTTP. |
| MOL-P1-002 · Anagrafica attiva con credenziali perse | FIXED | L’eliminazione definitiva dal vault precedeva la conferma della cancellazione dell’anagrafica. | L’anagrafica passa a `rimosso`, impedendo la riattivazione. Il vault marca il segreto e conserva il materiale cifrato fino alla conferma della cancellazione dell’anagrafica. Solo dopo elimina la credenziale marcata. Il retry riprende la fase incompleta. |
| MOL-P2-001 · Logout fuori viewport | FIXED | Logo, azioni e logout erano forzati sulla stessa riga. | Su schermi stretti, logo e logout precedono un secondo rigo flessibile di navigazione. Misura dinamica dell’altezza della barra conservata. |
| MOL-P2-002 · Focus dietro la registrazione | FIXED | La modale gestiva Escape ma lasciava il focus al controllo chiamante. | Focus iniziale sul primo campo, Tab e Shift+Tab confinati ai controlli effettivamente raggiungibili, inclusa l’intestazione SFTP quando chiusa. Escape chiude fuori da una richiesta in corso e il focus torna al chiamante. [W3C, pattern per dialoghi modali](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/). |
| MOL-SEC-P1-001 · Vita dello stream SSE | FIXED | Lo stream manteneva il contesto ottenuto all’apertura e terminava solo quando si chiudeva la connessione. | La sottoscrizione termina alla revoca e alla scadenza. Ogni pubblicazione verifica la sessione, il listener viene rimosso insieme al timer e la risposta SSE usa `no-store`. |

### Recupero della rimozione

La soluzione usa due scritture persistenti e condizionali compatibili con MongoDB standalone. Il passaggio a `rimosso` riserva l’ID fino alla cancellazione dell’anagrafica. Il contrassegno del vault è opzionale per i documenti già esistenti. Una nuova registrazione che salva il proprio materiale rimuove il contrassegno, impedendo a un purge pendente di cancellare il nuovo segreto. Richieste concorrenti di rimozione dello stesso ID condividono l’operazione nel processo applicativo. Il normale endpoint amministrativo di rimozione con conferma può essere ripetuto anche dopo un riavvio. Un record già passato a `rimosso` non compare nella flotta attiva. La ripresa dopo un errore e un ricaricamento può quindi richiedere la richiesta amministrativa per lo stesso ID.

Il coordinamento delle mutazioni concorrenti è stato verificato per il deployment attuale con una singola istanza applicativa. Per repliche applicative concorrenti serve una verifica di coordinamento distribuito o un’operazione transazionale supportata dalla topologia. Le prove di scrittura sono state eseguite esclusivamente su fixture. I file di archivio sono rimasti intatti anche nei test di errore e retry.

## 2. File modificati

- Compensazione login e notifiche di fine sessione in `backend/auth/auth-routes.ts:250–263` e `backend/auth/session-manager.ts:17,74,214–217`.
- Rimozione recuperabile e coordinamento per ID in `backend/fleet/fleet-service.ts:64–67,510–522,1000–1036,1294–1339`, `storage/robot-repository.ts:241–258,575–589`, `backend/connection/credential-provider.ts:38–39,110–121` e `backend/connection/mongo-credential-provider.ts:18–20,67–86,100–106`.
- Vita dello stream SSE in `backend/transfer/transfer-routes.ts:584–649`.
- Layout e focus in `client/src/components/common/AppNavbar.tsx:52–80`, `client/src/styles.css:82–95` e `client/src/components/fleet/RobotRegisterModal.tsx:42–91,457–460`.
- Test in `backend/auth/auth.test.ts:285`, `backend/fleet/fleet.test.ts:631`, `tests/security/corrective-hardening.test.ts:73`, `tests/security/logout-persistence.test.ts:117,256` e `client/react-frontend.test.ts:610,724`.

## 3. Regressioni aggiunte

- **Login** · errore dell’archivio audit, risposta 500 senza cookie, assenza della sessione orfana, nuovo login con cookie sicuro e un evento audit di successo. `backend/auth/auth.test.ts`.
- **Rimozione** · fallimenti nella marcatura dell’anagrafica e del vault, cancellazione anagrafica con esito negativo o eccezione, errore del purge, retry simultaneo e a operazione completata, riuso ID e archivio preservato. Il test MongoDB verifica il materiale ancora decifrabile durante l’attesa e il purge condizionale dopo la sostituzione. `backend/fleet/fleet.test.ts` e `tests/security/corrective-hardening.test.ts`.
- **Chrome** · sette viewport con hit test del logout e assenza di overflow, focus iniziale, Tab, Shift+Tab, Escape e focus restituito. I 20 cicli esistenti misurano anche la richiesta HTTP con Resource Timing. `client/react-frontend.test.ts`.
- **SSE** · sottoscrizioni HTTPS di prova chiuse dopo logout e scadenza, con verifica di regressione su cookie, richieste concorrenti e audit. `tests/security/logout-persistence.test.ts`.
- **Firefox** · scenario WebDriver isolato con tastiera, sessioni fra schede e 20 cicli senza riavviare il browser o ricaricare il documento fra i cicli.

## 4. Rischi residui e collocazione

| ID | Stato | Valutazione |
|---|---|---|
| MOL-R-P2-001 · Attesa di verifica sessione | OPEN | Ritardo di 4 s riprodotto in Firefox su fixture; il form torna disponibile alla risposta. Il client non impone una scadenza autonoma al controllo iniziale o al login. Serve definire recupero da risposta assente e comportamento con cookie potenzialmente già emesso. |
| MOL-R-P2-002 · Log fisici con unità systemd | OPEN | Compatibilità tra percorso predefinito e direttive di scrittura ancora da verificare con l’unità di produzione e il suo ambiente. Non è stata modificata la configurazione operativa. |
| MOL-R-P2-003 · Polling e SSE insieme | OPEN | SSE e polling conservano il comportamento di fallback. L’impatto con elevato numero di utenti, robot e proxy richiede misure di carico specifiche. |
| MOL-R-P2-004 · Dettaglio della sonda TCP SSH | OPEN | Il primo errore può restare classificato come `host_reachability`. Il commit `d03fa98` aggiunge il motivo disponibile. La riuscita su un robot reale resta bloccata prima dell’handshake. |
| MOL-SEC-P2-002 · Confronto Origin | OPEN | Rimane il fallback basato sull’host. Serve definire lo schema canonico del deployment e verificare reverse proxy, TLS e richieste provenienti dai client consentiti prima di cambiare il contratto. |
| MOL-SEC-P2-003 · MongoDB locale | OPEN | L’audit ha osservato accesso locale senza autenticazione. Le regressioni usano un database dedicato. Autenticazione e ruoli di produzione devono essere verificati in staging. |
| MOL-SEC-P2-004 · Destinazioni SSH | OPEN | L’allowlist è obbligatoria nel profilo production. Restano da provare egress, elenco robot autorizzati e policy reali in staging. |
| Tecnologie assistive | OPEN | La prova riguarda tastiera e focus della registrazione in Chrome e Firefox. Una verifica completa con tecnologie assistive e l’intera famiglia di modali richiede un collaudo dedicato. |
| SSH reale sulle porte 2223 e 2224 | BLOCKED | Entrambe le porte rifiutano il TCP. Nessuna VM è attiva, VirtualBox non espone virtualizzazione hardware e le VM NAT non mostrano forwarding per queste porte. |

La tabulazione nel pannello SFTP chiuso è emersa come problema durante lo sviluppo in Firefox. La finestra ora considera il controllo `summary` e scarta eventuali campi non raggiungibili sotto `details` chiuso. La conferma è inclusa nel retest Firefox e Chrome.

## 5. Diagnostica ambiente SSH

Il commit `d03fa98` è antenato di HEAD. Il backend locale su `8443` esegue la build del checkout che contiene il dettaglio diagnostico aggiunto dal commit. Docker e Podman non sono presenti nei runtime osservabili. Il collaudo di regressione usa il frontend ricostruito in un ambiente separato. Il servizio operativo non è stato riavviato. Le prove di registrazione e rifiuto delle chiavi SSH usano server di prova con verifica rigorosa, mentre la registrazione del robot reale è **BLOCKED**. Il rifiuto TCP precede la verifica della chiave o delle credenziali.

## 6. Risultati e misure

### Prima e dopo

| Prova | Audit iniziale | Regressione attuale |
|---|---|---|
| Login con errore di audit | 500, nessun cookie, 1 sessione residua, retry 409 | 500 senza cookie, 0 sessioni residue, retry 200 e una registrazione di successo |
| Errore nella cancellazione del robot | Record attivo senza credenziali | Stato `rimosso`, segreto conservato finché il database non conferma; dopo il completamento, nessun record e nessuna credenziale marcata |
| Layout a 320, 360 e 390 px | Il pulsante finiva a 424 px | Interamente raggiungibile. Nessun overflow a 320, 360, 390, 414, 768, 1024 e 1920 px |
| Focus registrazione | Fuori dalla modale in entrambi i browser | Primo campo attivo, ciclo Tab/Shift+Tab, chiusura con Escape e ritorno al chiamante in Chrome e Firefox |
| Stream SSE | Revoca assente nel ciclo di vita da riscontro statico | Chiusura HTTPS verificata al logout e alla scadenza |

### Esito della matrice di audit

| Gruppo | Controlli dell’audit ripetuti | Passati | Osservazioni |
|---|---:|---:|---:|
| Suite applicative del progetto | 35 | 35 | 0 |
| Build, lint, TypeScript frontend | 3 | 3 | 0 |
| Firefox WebDriver | 8 | 7 | 1 |
| Chrome supplementare · login, tre larghezze originali e focus | 5 | 5 | 0 |
| Iniezioni di guasto · audit del login e rimozione robot | 2 | 2 | 0 |
| **Totale** | **53** | **52** | **1** |

La sola osservazione riguarda l’attesa di sessione nella fixture Firefox con ritardo di 4 s. Le quattro larghezze aggiuntive e le 20 ripetizioni Firefox sono supplementari alla matrice precedente. I 20 cicli Chrome fanno parte della suite E2E. I 35 script sono completati con successo, inclusi i test di streaming oltre 1 GB, l’accettazione e la validazione input. Il limite totale del primo runner ha interrotto la registrazione degli ultimi tre script, poi rieseguiti fino all’uscita 0 in isolamento. Il lint ha superato il retest con un limite più ampio. Il build frontend e quello backend finali sono passati.

### Misure del logout nei due browser

20 cicli consecutivi per browser. Ogni riga indica min, mediana, p95 e max in millisecondi. Il feedback va dal clic alla comparsa del login nel DOM. L’API è la durata della risorsa `POST /api/auth/logout` da PerformanceResourceTiming. Il tempo completo va dal clic al login riabilitato dopo la conferma server. Moliris cambia schermata nella SPA, conservando lo stesso documento.

| Browser | Misura | Min | Mediana | P95 | Max |
|---|---|---:|---:|---:|---:|
| Chrome | Feedback | 5,5 | 16,55 | 27,5 | 41,4 |
| Chrome | API | 5,0 | 13,75 | 33,8 | 34,3 |
| Chrome | Completo | 39,1 | 57,95 | 98,1 | 123,2 |
| Firefox | Feedback | 4 | 8 | 24 | 43 |
| Firefox | API | 7 | 14,5 | 27 | 52 |
| Firefox | Completo | 27 | 45,5 | 115 | 124 |

Chrome ha verificato anche un solo POST per clic doppi, 401 dopo la revoca, assenza del cookie, percorso Indietro, ricarica, riconnessione e risposta sospesa. Il feedback Chrome con 1.200 ms di ritardo simulato è stato 15,5 ms. Il retry dopo la risposta sospesa era disponibile dopo 5.025,2 ms. Firefox ha verificato la sincronizzazione tra schede, l’assenza del cookie nei 20 cicli e zero errori JavaScript non gestiti. I log Chrome non hanno segnalato errori JavaScript negli scenari logout. I valori dell’audit precedente e quelli di oggi sono stati acquisiti con carico concorrente differente. Le misure osservate sono inferiori a un secondo per i 40 cicli ordinari; la differenza delle mediane Chrome non stabilisce da sola una regressione causale.

Evidenze nell’area temporanea `/tmp/moliris-remediation-final/logs/`. In particolare `tests.tsv`, `runs/client_react-frontend.test.ts.log`, `firefox.jsonl`, `chrome-extra.jsonl`, `target-backend_auth_auth.test.ts.log`, `target-backend_fleet_fleet.test.ts.log` e `target-tests_security_logout-persistence.test.ts.log`.

## 7. Decisione di rilascio

I difetti confermati dell’audit sono stati corretti nel perimetro verificato. La decisione per la produzione resta sospesa fino alla prova con il robot reale, alla verifica della topologia e dei controlli di sicurezza di staging e alla gestione dei rischi residui. Le misure browser sono di laboratorio e riflettono il carico della macchina durante il collaudo. Il report di audit originale è preservato. Le correzioni e i test restano nella working tree.
