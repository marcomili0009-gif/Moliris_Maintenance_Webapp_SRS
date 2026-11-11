# Modulo Frontend Web (SRS v1.0 §5.1, §2.5, RNF-UX-001..004)

## Responsabilità (§5.1)
Il frontend web della Moliris Maintenance Webapp realizza un'interfaccia utente coerente, reattiva e sicura con le seguenti responsabilità tassative:
1. **Login e gestione dell'interfaccia utente** (§6.1, RF-AUTH-001..006, CA-AUTH-001..003):
   - Accesso con username e password su canale HTTPS.
   - Tracciamento della sessione autenticata via cookie/token sicuro senza esposizione in storage persistente o URL.
   - Adattamento dei controlli visivi in base ai ruoli e permessi autorizzati (RNF-SEC-004).
   - Logout esplicito e gestione uniforme della scadenza sessione.
2. **Visualizzazione della flotta e dei dettagli dei robot** (RF-ROB-001..003, RF-ROB-014, CA-ROB-010..012):
   - Elenco della flotta con navigazione fluida e selezione rapida (RNF-UX-001).
   - Scheda dettaglio con anagrafica, parametri tecnici e collegamenti espliciti alle funzionalità autorizzate.
   - Funzionalità non disponibili mostrate con il MOTIVO comprensibile (RF-ROB-011).
3. **Form per la registrazione dei robot** (RF-ROB-004..006, RF-ROB-012, CA-ROB-001..003):
   - Indicazione chiara dei campi obbligatori contrassegnati con `*` (RF-ROB-005).
   - Metodo di autenticazione SSH dinamico (password o chiave privata PEM).
   - Configurazione crittografica di verifica chiave host (StrictHostKeyChecking e fingerprint SHA256 / known_hosts, RNF-SEC-003).
   - Evidenziazione puntuale degli errori di validazione associati ai campi del form (RF-ROB-006).
   - Riepilogo dettagliato dell'esito nei 6 casi formali di RF-ROB-012.
4. **Visualizzazione dello stato operativo interpretato** (RF-MON-001..006, CA-MON-003..004):
   - Rappresentazione rigorosamente distinta dei 3 stati (§10.2: anagrafico, connessione, operativo).
   - Data/ora dell'ultimo aggiornamento valido e dell'ultimo tentativo.
   - Nessuna assenza di dati confusa con uno stato operativo (`dato non disponibile`).
   - Evidenziazione visiva del dato non più verificato (`[Non più verificato]`).
5. **Terminale SSH interattivo nel browser** (RF-SSH-001..008, §5.4, §6.4, RNF-UX-004):
   - Emulazione VT100/Xterm tramite xterm.js e fit addon.
   - Streaming PTY bidirezionale via WebSocket WSS senza richiedere alcun client SSH locale sul computer dell'operatore.
   - Stato sessione trasparente e rilascio ordinato delle risorse.
6. **Navigazione dei filesystem (server e remoto)** (RF-SRVFS-002, RF-FS-001..003, CA-FS-001):
   - Tab separati per archivio server dedicato e filesystem remoto SFTP del robot.
   - Percorso corrente (breadcrumb), navigazione cartelle e indicazione troncamento limite elementi.
7. **Interfaccia di upload e download** (RF-TRF-001..003, CA-FS-002..004):
   - Azioni dirette per file: scaricamento su computer locale, invio al robot, copia su server.
   - Dialog di conferma sovrascrittura protetta (RF-TRF-011).
8. **Visualizzazione dei progressi, trasferimenti ed errori** (RF-TRF-006, §9, RNF-UX-002):
   - Pannello trasferimenti con byte trasferiti, percentuale, velocità stimata (EWMA), ETA e pulsante di annullamento.
   - Traduzione centralizzata di tutti gli errori del catalogo §9, con distinzione visiva tra errori recuperabili ed errori che richiedono intervento amministrativo.

---

## Architettura e Separazione dei Moduli (RNF-MNT-002)
Il codice del frontend è rigorosamente suddiviso in moduli specializzati senza duplicazioni:
- `api-client.js`: client HTTP/WebSocket sicuro con gestione token, interceptor 401, gestione caduta connessione/VPN e divieto categorico di connessioni dirette dal browser ai robot.
- `error-presenter.js`: componente centralizzato di presentazione degli errori (§9), traduzione codici, sanitizzazione per escludere qualsiasi segreto o stack trace, distinzione visiva recuperabile vs amministrativo, ed evidenziazione errori form.
- `state-formatter.js`: formattatore deterministico dei 3 stati distinti (§10.2, RF-ROB-014, RF-MON-005/006), gestione date e staleness.
- `double-submit.js`: guardia contro invii doppi accidentali su tutte le azioni asincrone.
- `app.js`: orchestrazione dell'interfaccia, routing tra viste, modali e binding degli eventi.
- `index.html`: template HTML semantico senza schermate o funzioni fittizie non previste dalla SRS.
- `styles.css`: foglio di stile reattivo conforme all'identità grafica Moliris.

---

## Compatibilità e Requisiti dell'Ambiente (§2.5, RNF-UX-003, RNF-UX-004)
- **Browser supportato**: Google Chrome è l'unico browser prescritto e supportato dal progetto (§2.5). Non sono stati estesi o testati altri browser senza formale decisione progettuale.
- **Nessun componente aggiuntivo**: l'applicazione funziona nativamente in Google Chrome senza estensioni, plugin o client SSH/SFTP locali sul computer dell'operatore (RNF-UX-004).
- **Assenza di notifiche o funzioni sonore**: benché il §2.5 citi altoparlanti come parte dell'ambiente utente, la specifica SRS v1.0 non descrive alcuna funzione audio, allarme acustico o segnale sonoro. Nessuna funzionalità audio è stata inventata o implementata.
- **Raggiungibilità applicazione e VPN**: in caso di assenza di connettività Internet o mancato accesso alla VPN Moliris, il frontend intercetta uniformemente l'errore di rete mostrando: *"Applicazione non raggiungibile. Verificare la connessione di rete e l'accesso alla VPN Moliris."*
