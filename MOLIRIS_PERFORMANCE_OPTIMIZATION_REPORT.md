# Moliris · Ottimizzazione delle prestazioni

**Riepilogo.** Il candidato riduce del **42,8%** il JavaScript iniziale e dell’**88,9%** il traffico SSE mediano con storico invariato. Le regressioni applicative sono passate. Il terminale mostra subito la finestra e carica il motore al primo utilizzo, con un costo misurato sulla prima connessione. L’LCP mobile simulato resta sopra l’obiettivo nei campioni Lighthouse, che hanno restituito un avviso di misura incompleta.

## Modifiche

- `client/src/components/terminal/TerminalModal.tsx` prima importava xterm, FitAddon e il CSS nell’entry point. Ora il terminale mantiene la finestra e il feedback esistenti e carica questi moduli quando apre la sessione. La chiusura invalida l’inizializzazione pendente, libera le risorse e annulla il frame di ridimensionamento. Più richieste di ridimensionamento nello stesso frame vengono accorpate. Un errore del caricamento viene mostrato nella finestra.
- `backend/transfer/transfer-routes.ts` confronta lo storico serializzato per sottoscrittore. Invia lo snapshot iniziale e i cambiamenti, usa un commento SSE periodico per mantenere aperta la connessione e salta la scrittura quando la socket segnala backpressure. La validazione della sessione precede ogni controllo e restano attivi la revoca, la chiusura e il fallback di polling client.
- `backend/transfer/transfer-service.ts` ordina i record con i timestamp già disponibili e converte in DTO dopo l’ordinamento, evitando copia preliminare dell’iteratore e parsing ripetuto delle date.
- `tests/security/logout-persistence.test.ts` verifica che uno storico invariato non venga trasmesso due volte. Una prova HTTPS supplementare con 200 trasferimenti ha osservato uno snapshot iniziale, un solo aggiornamento dopo la rimozione di una voce di prova, il commento di keepalive e la risposta singola per `once=1`.

## Bundle e browser

Cinque navigazioni Chrome desktop per versione con cache disattivata, stessa fixture HTTPS e viewport 1366×900. Mediane locali in ms salvo dove indicato. Le azioni misurano tempo dal comando CDP alla prima osservazione dello stato DOM atteso, incluso il polling dello strumento. La prima connessione terminale include caricamento e apertura PTY. L’Event Timing è un proxy di laboratorio dell’INP su pochi percorsi.

| Misura | Prima | Dopo | Variazione |
|---|---:|---:|---:|
| JS iniziale | 772143 B | 441533 B | -42,82% |
| JS iniziale gzip di riferimento | 205993 B | 123769 B | -39,92% |
| CSS iniziale | 260639 B | 256701 B | -1,51% |
| JS totale di tutti i chunk | 772143 B | 773667 B | +0,2% |
| LCP desktop | 136 ms | 148 ms | +8,82% |
| Primo form di login utilizzabile | 150,4 ms | 152,7 ms | +1,53% |
| CLS desktop | 0 | 0 | — |
| Risorse iniziali osservate | 5 | 5 | 0% |
| Event Timing, massimo osservato | 80 ms | 104 ms | +30% |
| Login fino a Flotta | 165,8 ms | 144,1 ms | -13,09% |
| Navigazione a Gestione file | 57,6 ms | 53,3 ms | -7,47% |
| Navigazione a Logs | 34,3 ms | 31,8 ms | -7,29% |
| Modale di registrazione | 57,3 ms | 53,3 ms | -6,98% |
| Finestra del terminale visibile | 27,2 ms | 29,8 ms | +9,56% |
| Prima connessione terminale pronta | 93,4 ms | 154,2 ms | +65,1% |
| Archivio generale | 45,1 ms | 36,9 ms | -18,18% |
| File server | 17,9 ms | 10,3 ms | -42,46% |
| File robot | 21,9 ms | 17,8 ms | -18,72% |
| Vista trasferimenti | 17,1 ms | 21,9 ms | +28,07% |

**Mobile simulato.** Lighthouse 13.6 ha prodotto due campioni per versione. La mediana LCP è passata da **6,92 s** a **5,3 s** (-23,42%), con CLS 0. Tutti e quattro i run segnalano che il caricamento non si è concluso entro il limite di acquisizione. Il target **2,5 s** rimane aperto su mobile. Il desktop è rientrato nelle soglie locali per LCP, CLS e proxy INP. Resta da verificare l’INP sul traffico reale. I valori gzip indicano la dimensione compressa di riferimento, mentre i byte JS iniziali sono quelli osservati dal browser dopo decodifica.

### Logout

| Browser e versione del codice | Feedback mediana / p95 / max | Completamento mediana / p95 / max |
|---|---:|---:|
| Chrome prima | 5,85 / 12,3 / 15,7 ms | 23,8 / 44,2 / 52,3 ms |
| Chrome dopo | 7,85 / 12,1 / 15 ms | 28,5 / 40,6 / 44 ms |
| Firefox dopo | 3 / 5 / 6 ms | 12 / 19 / 27 ms |

Ogni riga riporta 20 cicli consecutivi. Il p95 e il massimo di completamento Chrome sono migliorati, mentre la mediana è salita di 4,7 ms. Con 1.200 ms di latenza simulata il test applicativo ha confermato il feedback prima della risposta server. Sono passate le prove di clic ripetuti, Indietro, risposta sospesa, riconnessione e revoca. Chrome ha verificato 7 viewport da 320 a 1920 px, focus iniziale, Tab, Shift+Tab, Escape e ritorno del focus. Firefox ha verificato anche la sincronizzazione del logout tra due schede.

## API, connessioni e risorse

Tre esecuzioni per versione, 120 richieste per endpoint in ciascuna, concorrenza 5 e connessioni HTTPS riusate. La tabella mostra le mediane dei percentili fra le tre esecuzioni, in ms. La fixture usa persistenza in memoria e 200 trasferimenti sintetici. L’effetto diretto atteso riguarda la lista trasferimenti. Gli altri endpoint aiutano a leggere la variabilità dell’host.

| Endpoint | Prima p50 / p95 / p99 | Dopo p50 / p95 / p99 |
|---|---:|---:|
| `/healthz` | 3,53 / 10,87 / 23,96 | 2,97 / 7,27 / 21,7 |
| `/api/auth/me` | 4,3 / 8,03 / 10,85 | 3,77 / 6,94 / 8,65 |
| `/api/robots` | 4,83 / 10,9 / 14,36 | 4,22 / 7,89 / 9,25 |
| `/api/transfers/recent` | 12,66 / 24,19 / 33,97 | 8,3 / 15,69 / 18,91 |

Il p95 di `/api/transfers/recent` è sceso del **35,1%** nella mediana delle tre esecuzioni. I singoli run mostrano variabilità e un p99 più alto in uno dei campioni del candidato.

- **SSE.** Con 12 sottoscrittori per 8,2 s, il traffico mediano scende da **12,4 MB** a **1,38 MB** (-88,89%). Gli snapshot ricevuti passano da 61–108 a 12. CPU mediana del backend 32 → 34 tick nella finestra. La variazione RSS del candidato va da -5,32 a 1,82 MiB. La misura dimostra il risparmio di rete, mentre CPU e memoria richiedono un profilo più lungo per attribuire un effetto stabile. Ogni stream conserva l’ultimo storico serializzato.
- **MongoDB.** In un database isolato il lookup utente usa `id_1` con una chiave e un documento esaminati. L’audit recente per utente usa `userId_1_timestamp_-1` con 100 chiavi e 100 documenti per 100 risultati. Ho mantenuto gli indici esistenti. La lista completa della flotta legge l’inventario intero per definizione. Serve un campione rappresentativo prima di intervenire sulla paginazione.
- **Carico.** Sia prima sia dopo, su 25 account si sono aperti 20 PTY e sono stati verificati 10 upload, con i rifiuti di saturazione previsti e zero errori inattesi o connessioni residue. Sul candidato, p95 di apertura PTY **117,9 ms**, p95 upload **205,3 ms**, CPU **56,1%** di un core e RSS di picco **144,4 MiB**. Il profilo esteso da 50 account ha verificato 35 PTY, 20 upload e cleanup completo. Il carico usa SSH di prova su loopback e filesystem isolato.

## Navigazione prolungata

- **Prima.** Playwright ha completato 62 giri di navigazione in 60,63 s senza eccezioni JavaScript. Heap dopo garbage collection da 3,92 a 6,08 MB. Totale richieste API 380, inclusi login e logout.
- **Dopo.** Playwright ha completato 66 giri di navigazione in 61 s senza eccezioni JavaScript. Heap dopo garbage collection da 3,93 a 5,54 MB. Totale richieste API 404, inclusi login e logout.

La sessione alternava Flotta, Gestione file, Trasferimenti, Logs e la modale di registrazione. L’heap è cresciuto in entrambe le finestre. I giri e la durata breve danno un segnale da approfondire con heap snapshot e una sessione più lunga. Le richieste per ritorno da Logs sono rimaste sostanzialmente una per endpoint, coerenti con il rimontaggio della dashboard.

## Validazione e prossimi interventi

- **35/35 script applicativi e 3/3 controlli** di build, lint e TypeScript frontend passati. Passate le regressioni di login, rimozione con audit, responsive, focus modale, scadenza assoluta, chiusura SSE/WSS, terminale e streaming oltre 1 GB. La suite finale ha registrato **zero fallimenti e zero timeout**.
- Primo avvio del benchmark CDP corretto attivando la raccolta prima della navigazione. Primo avvio Lighthouse da CLI scaduto. La prova successiva con collegamento diretto a Chrome ha prodotto i campioni con avviso documentati sopra.
- Istanza utente locale riavviata dopo il superamento delle suite. `/healthz` risponde OK, il documento HTML e i sei asset del build coincidono byte per byte con il servizio su `127.0.0.1:8443`, compresi JS e CSS differiti del terminale.
- Priorità successive. Verificare compressione e budget LCP sulla topologia finale, misurare il costo del primo terminale sotto rete lenta, valutare il polling di fallback con un proxy reale e profilare l’heap su una sessione più lunga. Il collaudo SSH con robot o VM reali resta fuori dal perimetro di questa fase. Nessun commit o push.

Evidenze in `/tmp/moliris-perf-next/logs/`, inclusi `summary.json`, `suite/tests.tsv`, `browser-*.jsonl`, `api-*.jsonl`, `sse-regression.jsonl`, `soak-*.jsonl`, `lh-*.jsonl`, `mongo-plan.jsonl` e `runtime.log`.
