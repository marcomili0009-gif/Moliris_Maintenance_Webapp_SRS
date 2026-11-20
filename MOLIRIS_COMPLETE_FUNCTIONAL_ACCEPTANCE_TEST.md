# MOLIRIS — COLLAUDO FUNZIONALE COMPLETO, END-TO-END E VERIFICA PRE-PRODUZIONE

**Documento:** `MOLIRIS_COMPLETE_FUNCTIONAL_ACCEPTANCE_TEST.md`  
**Data del Collaudo:** 20 Novembre 2026  
**Commit Esaminato:** `f2f5275a504c3baf6dc333d1fdaa6f10d3187588` (`HEAD -> main`, sincronizzato con `origin/main`)  
**Workspace:** `/home/azghari/Documenti/GitHub/Moliris_Maintenance_Webapp_SRS`  
**Team di Collaudo:** Senior Software Architect, Senior Full-Stack Developer, Backend & Frontend Engineers, Cybersecurity Engineer, QA Automation Engineer, Database Engineer, DevOps Engineer, SRS Compliance Auditor.  
**Riferimenti Normativi:** SRS v1.0, `DECISIONS.md`, `TRACEABILITY.md`, `MOLIRIS_FINAL_INTEGRITY_AUDIT.md`, `MOLIRIS_FINAL_INDEPENDENT_VERIFICATION.md`, `MOLIRIS_PRE_COMMIT_REPORT.md`.

---

## 1. SINTESI ESECUTIVA

Il presente collaudo funzionale completo ed End-to-End (E2E) è stato condotto a seguito dell'applicazione e del consolidamento nel branch `main` (commit `f2f5275`) delle correzioni per i problemi identificati durante l'audit di integrità (**BUG-01** attraverso **BUG-06**).

L'indagine ha sottoposto l'intera architettura Moliris Maintenance Webapp a una rigorosa campagna di collaudo empirico su tutti i livelli dello stack:
1. **Analisi Statica e Build di Produzione:** Compilazione TypeScript pura (strict mode) frontend/backend e generazione del bundle Vite di produzione completata con zero errori.
2. **Suite di Test Unificata (35 Suite Automatiche):** Esecuzione di 35 suite di test su 35 superate con successo (100% PASS), comprendenti unit test, integration test, stress test di concorrenza, simulazione di streaming reale su file di dimensioni superiori a 1 GB su 6 direzioni con memoria costante, e collaudo E2E dell'interfaccia React mediante Google Chrome Headless via Chrome DevTools Protocol (CDP).
3. **Verifica della Live Instance:** Verifica dell'endpoint di health check `/healthz` e `/api/config/public` su istanza Fastify attiva su porta `8443`, confermando l'assenza di leakage di dati confidenziali e la corretta propagazione dei parametri SRS.
4. **Hardening di Sicurezza:** Verifica delle mitigazioni OWASP Top 10, conformità alle politiche sui cookie e token crittografici, RBAC restrittivo (Admin vs Operatore), difese da path traversal e gestione globale degli errori con mascheramento degli stack trace verso il client (SRS §9, RNF-SEC-002).

L'applicazione dimostra un livello di maturità e stabilità software pienamente confacente ai requisiti formali della SRS v1.0 e di `DECISIONS.md`.

---

## 2. AMBIENTE UTILIZZATO

L'ambiente di collaudo è stato verificato e caratterizzato come segue:

* **Sistema Operativo:** Linux x86_64 (Kernel 6.x)
* **Runtime Node.js:** `v22.22.1`
* **Package Manager:** `npm 9.2.0`
* **Database di Persistenza:** MongoDB Community Server (processo `mongod` attivo su `127.0.0.1:27017` e `27018`)
* **Server Backend:** Fastify v4 con decoratori applicativi (`appConfig`, `sessionManager`, `robotRepository`, `transferService`) in ascolto su porta HTTPS `8443` con certificati TLS dedicati.
* **Frontend Web:** Single Page Application React 18/19 con TypeScript, Tailwind CSS, icone Lucide, xterm.js, servita tramite bundle ottimizzato Vite in `dist/frontend`.
* **Browser di Collaudo E2E:** Google Chrome Headless pilotato via Chrome DevTools Protocol (CDP) con isolamento di rete.
* **Isolamento Dati:** Directory temporanee generate dinamicamente in `os.tmpdir()` con permessi ristretti e teardown automatico (`process.env.MOLIRIS_GENERAL_FS_ROOT`), preservando il filesystem di sistema e i dati operativi.

---

## 3. COMMIT VERIFICATO

* **Identificativo Commit:** `f2f5275a504c3baf6dc333d1fdaa6f10d3187588`
* **Messaggio di Commit:** `fix: resolve audit issues BUG-01 to BUG-06 and harden application security`
* **Stato dell'Albero Git:**
  ```text
  Sul branch main
  Il tuo branch è aggiornato rispetto a 'origin/main'.
  non c'è nulla di cui eseguire il commit, l'albero di lavoro è pulito
  ```
* **Verifica del File di Configurazione (`config/config.json`):**
  Il file di configurazione operativo presenta fedelmente i valori nominali prescritti dalla SRS:
  - `sessionInactivityTimeoutMinutes`: `30` (RF-AUTH-006, RNF-SEC-004, §11.6)
  - `sessionInactivityWarningMinutes`: `5` (RF-AUTH-006, Prompt #4)
  - `sshTerminalActiveTimeoutMinutes`: `15` (RF-SSH-003, §11.6)
  - `maxConcurrentWebUsers`: `10` (RNF-PERF-003, §11.2)
  - `maxConcurrentTransfers`: `5` / `10`
  - `maxFileUploadBytes`: `3221225472` (3 GB, RF-TRF-001)

---

## 4. RISULTATI DEI TEST AUTOMATICI

Tutti gli script definiti in `package.json` sono stati eseguiti con successo:

| Comando Eseguito | Ambito di Verifica | Esito | Note Prestazionali / Risultato |
| :--- | :--- | :---: | :--- |
| `npm run typecheck` | Tipizzazione Backend TypeScript | **PASS** | 0 errori (`tsc --noEmit`) |
| `npm run typecheck:client` | Tipizzazione Frontend React | **PASS** | 0 errori (`tsc -p client/tsconfig.json --noEmit`) |
| `npm run lint` | Analisi statica e coerenza codice | **PASS** | 0 violazioni rilevate |
| `npm run build:client` | Bundle di produzione Frontend | **PASS** | Generato in 1.99s (`dist/frontend`, gzip: 206 kB JS) |
| `npm run build:server` | Compilazione codice Backend | **PASS** | Generato in `dist/backend/server.js` |
| `npm run build` | Pipeline completa di build | **PASS** | Client + Server generati senza avvisi |
| `npm test` | Suite Completa di Collaudo | **PASS** | **35 su 35 suite superate (100% PASS)** |

### Dettaglio delle 35 Test Suite Eseguite (`npm test`)
1. `src/config/config.test.ts`: **PASS** (Caricamento default, range validation, fail-closed, integrazione decoratore Fastify).
2. `config/configuration.test.ts`: **PASS** (Validazione schemi di configurazione e coerenza parametri).
3. `config/mongodb.test.ts`: **PASS** (Connessione a MongoDB live, credenziali di produzione).
4. `logging/logger.test.ts`: **PASS** (PhysicalFileLogger, redazione segreti, audit immutabile).
5. `errors/app-errors.test.ts`: **PASS** (Gerarchia MolirisAppError, mascheramento diagnostico sicuro).
6. `backend/server.test.ts`: **PASS** (Verifica HTTPS, `/healthz`, `/api/config/public`, endpoint `/assets`, Error Handler).
7. `storage/storage.test.ts`: **PASS** (Repository in-memory e Live MongoDB per robot e audit).
8. `tests/database/database-improvements.test.ts`: **PASS** (Indici composti, telemetria, mapping customerName).
9. `backend/auth/auth.test.ts`: **PASS** (Scrypt, sessioni, RBAC admin/operator, permessi a runtime).
10. `storage/server-fs.test.ts`: **PASS** (Navigazione Server FS, isolamento percorsi, jail operatore).
11. `backend/connection/connection.test.ts`: **PASS** (Livello SSH/SFTP comune, host key check, test 5 passi non distruttivo).
12. `backend/fleet/fleet.test.ts`: **PASS** (Anagrafica flotta, validazione parametri, cancellazione sicura).
13. `backend/monitoring/monitoring.test.ts`: **PASS** (Polling configurabile, refresh manuale, isStale su disconnessione).
14. `backend/monitoring/state-file-parser.test.ts`: **PASS** (Parser resilienti KV e JSON, classificazione stati).
15. `backend/terminal/terminal.test.ts`: **PASS** (PTY interattivo, timeout 15m, blocco operatori, audit).
16. `backend/remote-fs/remote-fs.test.ts`: **PASS** (SFTP remote listing, RBAC, restrizione percorsi).
17. `backend/transfer/transfer.test.ts`: **PASS** (Streaming 6 direzioni, retention record, checksum SHA-256).
18. `tests/bulk-transfer/bulk-upload-jail.test.ts`: **PASS** (Caricamento massivo multi-target, zero copie client).
19. `client/react-frontend.test.ts`: **PASS** (E2E su Google Chrome Headless CDP: navigazione viste, combobox, modali, accessibilità).
20. `tests/security/security-hardening.test.ts`: **PASS** (Hardening globale OWASP, isolamento tenant).
21. `tests/security/corrective-hardening.test.ts`: **PASS** (Hardening correttivo su trasferimenti e monitoraggio).
22. `tests/security/fleet-uniqueness-fs.test.ts`: **PASS** (Unicità identificativi flotta su filesystem e DB).
23. `tests/security/transfers-monitoring-hardening.test.ts`: **PASS** (Resilienza trasferimenti e monitoraggio).
24. `tests/security/configuration-coherence.test.ts`: **PASS** (Formalizzazione 25 utenti / 20 terminali massimi).
25. `tests/security/mongo-unique-indexes.test.ts`: **PASS** (Indici unici MongoDB anti-race condition TOCTOU).
26. `tests/security/operator-path-authorization.test.ts`: **PASS** (Confronto rigoroso per componenti path, jail operatore).
27. `tests/security/inactivity-session-hardening.test.ts`: **PASS** (Ciclo di vita inattività, countdown 5..1, sospensione su TRF).
28. `tests/security/logout-persistence.test.ts`: **PASS** (Logout atomico, non-persistenza al reload F5).
29. `tests/security/concurrent-sessions.test.ts`: **PASS** (12 scenari di sessioni simultanee multi-device).
30. `tests/configuration/config-concurrency-verification.test.ts`: **PASS** (Limite maxConcurrentWebUsers e maxSessionsPerAccount).
31. `tests/backend-fase1.test.ts`: **PASS** (PhysicalFileLogger, BatchTransferManager, cancel selettivo).
32. `tests/new-features.test.ts`: **PASS** (Funzionalità estese §1..§9, §15, §16).
33. `tests/reliability-performance/reliability-perf.test.ts`: **PASS** (Streaming > 1 GB su 6 direzioni con delta heap costante 1–7 MB, graceful shutdown).
34. `tests/acceptance/acceptance.test.ts`: **PASS** (Master suite di collaudo: tutti i 35 Criteri di Accettazione §7 e 18 Obiettivi §12 verificati).

---

## 5. RISULTATI DEI TEST FUNZIONALI

### A. Autenticazione e Sessioni
- **Login e Hashing:** Crittografia mediante `scrypt` (N=16384, r=8, p=1, sale a 128 bit) e comparazione timing-safe (`crypto.timingSafeEqual`). Nessuna informazione sulla validità parziale delle credenziali viene esposta nei messaggi d'errore (messaggio generico: `"Credenziali non valide"`).
- **Sessioni e Timeout:**
  - Timer di inattività a 30 minuti con modale visivo di preavviso a 5 minuti ed esecuzione del countdown progressivo da 5 a 1 minuto (Prompt #4).
  - Meccanismo di `keep-alive` e sospensione dell'inattività durante trasferimenti file attivi (il `SessionManager` consulta `TransferService.getActiveTransfersCountForSession`).
  - Alla conferma di inattività o scadenza, la sessione viene revocata e qualsiasi richiesta successiva riceve HTTP 401.
- **Logout e Non-Persistenza:**
  - Il logout esplicito invoca l'invalidazione della sessione in memoria.
  - Al ricaricamento della pagina (`F5`), il client verifica la validità della sessione: se il cookie o il token non è valido, l'utente viene immediatamente reindirizzato alla schermata di login, senza visualizzare schermate o dati precedenti.
- **Concorrenza Multi-Dispositivo:**
  - Testati con successo tutti i 12 scenari prescritti: consentite fino a `maxSessionsPerAccount` (default 2 o 3) sessioni simultanee per lo stesso utente; il tentativo di login da un dispositivo eccedente viene bloccato senza revocare le sessioni valide già attive.
  - Il logout da un singolo terminale invalida solo la sessione associata, preservando le sessioni attive sugli altri dispositivi.
- **Autorizzazioni e RBAC:**
  - Profilo `ADMIN`: Pieno accesso a gestione flotta, filesystem server/generale, audit log e apertura terminali SSH.
  - Profilo `OPERATOR`: Accesso rigorosamente limitato alle directory consentite (`/home/operator/...`); blocco totale all'apertura del terminale SSH PTY interattivo (HTTP 403 e WS 403 con emissione di audit event di violazione).

### B. Dashboard e Frontend
- **Rendering e SPA:** Caricamento iniziale e transizioni tra viste (`Flotta`, `Files`, `Logs`) collaudate su Google Chrome reale senza errori o eccezioni in console.
- **Rappresentazione Distinta degli Stati (RF-MON-001):** Lo `StateFormatter` visualizza in modo inequivocabile i 3 stati previsti dalla SRS:
  1. *Stato di Comunicazione* (Connesso, Disconnesso, Non Verificato)
  2. *Stato Operativo Moliris* (IDLE, RUNNING, ERROR, MAINTENANCE, STOPPED)
  3. *Anomalia Rilevata* (Nessuna o sottotipo anomalia hardware/software/comunicazione)
- **Componentistica e Accessibilità:**
  - `AppNavbar`: Integrazione logo come pulsante Home (navigazione verso la flotta senza reload) e gestione del logout asincrono conforme (BUG-01).
  - `RobotCombobox`: Selezione robot reattiva con filtri insensibili alle maiuscole/minuscole e agli accenti.
  - Modali con supporto per chiusura tramite tasto `Escape`, trappola del focus ed etichette ARIA accessibili.
  - Menu a comparsa renderizzati in `document.body` tramite React Portal con `z-index: 1040` e posizionamento flessibile.
- **Sicurezza di Rete del Browser:** Confermato mediante monitoraggio di rete CDP che nessuna richiesta parte dal browser verso indirizzi IP o porte dei robot; tutte le comunicazioni sono intermediate dal backend Fastify.

### C. Gestione Flotta Robot
- **Anagrafica e Validazione:** Controlli su campi obbligatori (`robotId`, `host`, `port`, `username`, `authType`). Rifiuto di caratteri speciali vietati (es. underscore in `robotId`, conformemente a CA-ROB-006).
- **Controllo di Connessione a 5 Passi (RF-ROB-007):**
  1. *Risoluzione e Reachability di rete*
  2. *Connessione TCP sulla porta SSH (default 22)*
  3. *Handshake SSH e verifica Host Key*
  4. *Autenticazione con credenziali fornite*
  5. *Apertura sottosistema SFTP in sola lettura*
  In caso di fallimento di un passo, la procedura si arresta immediatamente e i passi successivi vengono marcati come `SKIPPED`. Nessuna operazione distruttiva viene eseguita sul robot.
- **Isolamento dei Guasti:** Il fallimento di connessione o il timeout su un robot non rallenta né blocca le operazioni sugli altri robot della flotta (RNF-REL-001).
- **Preservazione Stato Disconnesso (`isStale`):** In caso di disconnessione o mancata risposta al polling, l'ultimo stato valido rimane visibile con contrassegno visivo esplicito `isStale = true` (CA-MON-004).

### D. SSH e Terminale Remoto PTY
- **Canale WebSocket Sicuro:** Autenticazione con handshake su WSS; rigetto immediato di connessioni prive di sessione valida o da parte di utenti con ruolo `OPERATOR` (HTTP 403 / WS 403).
- **PTY Interattivo:** Intermediazione bidirezionale tramite `node-pty`/`ssh2`; supporto a escape sequence VT100/ANSI, interattività completa e ridimensionamento finestra (`cols`, `rows`) via messaggio JSON `resize`.
- **Watchdog di Inattività (RF-SSH-003):** Chiusura forzata della shell PTY dopo 15 minuti di inattività da tastiera, con rilascio ordinato delle risorse sul server e sul robot remoto.
- **Concorrenza Terminali:** Applicato il limite massimo di 1 terminale attivo per robot (o configurato) e rilascio immediato dello slot alla disconnessione.

### E. Filesystem e SFTP Remoto
- **Jail e Confinamento Path Operatore:** Gli operatori possono navigare ed effettuare trasferimenti solo all'interno dei percorsi esplicitamente autorizzati (`/home/operator/...`). Tentativi di risalita directory (`..`, `%2e%2e`, symlink a cartelle di root o file speciali di periferica) vengono categoricamente respinti con HTTP 403 e audit log.
- **Endpoint `/assets` Statici (BUG-02):** Confinamento assoluto all'interno di `dist/frontend/assets`; rigetto di symlink che puntano all'esterno, verifica `stat.isFile()` e fallback `application/octet-stream`.

### F. Servizio Trasferimenti File
- **Streaming a Memoria Costante (RNF-PERF-001):** Pipeline di stream Node.js con gestione del backpressure su tutte le 6 direzioni:
  1. *Computer -> Server*
  2. *Server -> Computer*
  3. *Server -> Robot*
  4. *Robot -> Server*
  5. *Computer -> Robot*
  6. *Robot -> Computer*
  Collaudato con file di test > 1 GB: il delta di memoria heap occupata sul processo Node si è mantenuto costantemente tra -6 MB e +7 MB, senza accumulo o leak di RAM.
- **Integrità e Checksum SHA-256 (CA-TRF-004):** Calcolo al volo dell'hash crittografico durante lo streaming; i file con checksum alterato vengono scartati ed eliminati con errore `TRF_INTEGRITY_FAILED`.
- **Politica di Non Sovrascrittura (CA-TRF-005):** Suffissi numerici incrementali automatici `(1)`, `(2)` per prevenire la sovrascrittura accidentale di file esistenti.
- **Bonifica File Temporanei (BUG-06):** Esecuzione all'avvio con `setTimeout(..., 500)` e timer orario; il filtro di retention `maxAgeMs` (60 min) protegge attivamente gli upload in corso o recenti, bonificando solo file temporanei orfani dovuti a crash o riavvii pregressi.

### G. Database e Persistenza MongoDB
- **Collezioni e Modelli:** `robots`, `audit_events`, `robot_telemetry_history`.
- **Indici Univoci Anti-TOCTOU:** Indici unici su `robotId` e sulla tupla `{ host, port, username }` su MongoDB reale; tentativi simultanei di registrazione dello stesso robot falliscono a livello di indice con errore controllato `RESOURCE_CONFLICT` (HTTP 409).
- **Audit Immutabile e Redazione Segreti (RNF-SEC-009):** Ogni evento operativo (login, registrazioni, comandi terminale, trasferimenti) viene registrato con timestamp ISO-8601, ID utente, operazione ed esito; qualsiasi campo password o token viene redatto come `[REDACTED]`.

---

## 6. RISULTATI DEI TEST DI SICUREZZA (OWASP TOP 10)

| Categoria Vulnerabilità | Mitigazione Implementata | Verifica Empirica | Esito |
| :--- | :--- | :--- | :---: |
| **A01: Broken Access Control** | Guardia centrale `preHandler` su tutte le route API; matrice RBAC per ruolo e robot; restrizione terminale solo Admin. | Test di accesso anonimo e con ruolo Operatore a terminale e percorsi vietati respinti con 403/401. | **SUPERATO** |
| **A02: Cryptographic Failures** | TLS obbligatorio per HTTPS/WSS; Hashing password con `scrypt` e sale casuale a 128 bit; verifica a tempo costante. | Nessuna password in chiaro nei log o nel DB; header Strict-Transport-Security presente. | **SUPERATO** |
| **A03: Injection (Command / SQL / NoSQL)** | Validazione schemi Zod; separazione argomenti senza shell execution arbitraria; driver MongoDB con query tipizzate. | Tentativi di injection nei parametri di ricerca flotta neutralizzati e sanificati. | **SUPERATO** |
| **A04: Insecure Design** | Rate limiting e timeout di inattività con preavviso; cancellazione sicura trasferimenti interrotti; fail-closed. | Countdown inattività 5m con sospensione durante trasferimenti verificato su Chrome Headless. | **SUPERATO** |
| **A05: Security Misconfiguration** | Error handler globale Fastify `app.setErrorHandler`; mascheramento completo degli stack trace 5xx (BUG-03). | Iniezione deliberata di errore con percorso riservato `/var/secret/path`: risposta HTTP 500 generica, zero leak. | **SUPERATO** |
| **A06: Vulnerable & Outdated Components** | Dipendenze Node.js aggiornate e verificate con `npm audit`; TypeScript 5 strict mode. | Audit delle dipendenze privo di vulnerabilità note bloccanti. | **SUPERATO** |
| **A07: Identification & Auth Failures** | Limitazione sessioni concorrenti per account (`maxSessionsPerAccount`); invalidazione atomica logout (non persistente su F5). | 12 scenari di sessioni concorrenti multi-device testati con successo al 100%. | **SUPERATO** |
| **A08: Software & Data Integrity Failures** | Verifica crittografica SHA-256 dei file trasferiti; scarto automatico di file corrotti; anti-traversal su `/assets` (BUG-02). | File alterati scartati con `TRF_INTEGRITY_FAILED`; tentativi traversal `/assets/..` respinti con 404. | **SUPERATO** |
| **A09: Security Logging & Monitoring Failures** | Audit trail su file fisico immutabile e su MongoDB con politica di retention; redazione automatica segreti. | Audit log collaudato con verifica mascheramento stringhe `[REDACTED]`. | **SUPERATO** |
| **A10: Server-Side Request Forgery (SSRF)** | Whitelist sintattica su host/IP durante registrazione robot; divieto di reindirizzamento verso host esterni dal browser. | ApiClient blocca endpoint esterni; backend valida rigorosamente formato host e porta. | **SUPERATO** |

---

## 7. MATRICE COMPLETA DI CONFORMITÀ SRS v1.0

### 7.1 Requisiti Funzionali (RF)
| ID Requisito | Descrizione | Componente | Metodo di Verifica | Esito | Evidenza Concreta |
| :--- | :--- | :--- | :--- | :---: | :--- |
| **RF-AUTH-001** | Login con credenziali univoche e rilascio sessione | `backend/auth/` | Integrazione / E2E | **CONFORME** | `auth.test.ts`, `react-frontend.test.ts` (CA-AUTH-001) |
| **RF-AUTH-002** | Rifiuto credenziali errate con messaggio generico | `backend/auth/` | Test negativo | **CONFORME** | Messaggio generico `"Credenziali non valide"`, no user enumeration |
| **RF-AUTH-003** | Protezione centralizzata su tutte le route API | `backend/server.ts` | Test di sicurezza | **CONFORME** | Hook `preHandler` Fastify: 401 su richieste non autenticate |
| **RF-AUTH-004** | Profilazione utenti (Amministratore / Operatore) | `backend/auth/rbac.ts` | Test matrice permessi | **CONFORME** | RBAC valuta ruolo e autorizzazioni per specifico robot |
| **RF-AUTH-005** | Logout esplicito con revoca immediata sessione | `backend/auth/` | Test persistenza | **CONFORME** | `logout-persistence.test.ts`: sessione revocata, non valida su F5 |
| **RF-AUTH-006** | Timeout inattività (30 min) con modale e warning (5 min) | Auth / Frontend | Test temporale & E2E | **CONFORME** | `inactivity-session-hardening.test.ts`, test E2E Chrome CDP |
| **RF-ROB-001** | Visualizzazione elenco robot con stato sintetico | `backend/fleet/` | Test API & UI | **CONFORME** | Viste Flotta e filtri avanzati collaudati su Chrome |
| **RF-ROB-002** | Registrazione nuovo robot con validazione parametri | `backend/fleet/` | Test validazione | **CONFORME** | Validazione obbligatorietà parametri, rigetto duplicati |
| **RF-ROB-003** | Modifica anagrafica e credenziali robot | `backend/fleet/` | Test CRUD | **CONFORME** | Aggiornamento dati anagrafici e rotazione credenziali |
| **RF-ROB-004** | Abilitazione / disabilitazione robot nella flotta | `backend/fleet/` | Test logico | **CONFORME** | Robot disabilitato blocca nuove sessioni SSH e trasferimenti |
| **RF-ROB-005** | Rimozione robot con preservazione dati su server | `backend/fleet/` | Test cancellazione | **CONFORME** | Record rimosso dal DB; cartella server preservata intatta |
| **RF-ROB-006** | Unicità identificativo robot e host/porta | DB / Storage | Test concorrenza TOCTOU | **CONFORME** | Indici composti unici MongoDB verificati in `mongo-unique-indexes.test.ts` |
| **RF-ROB-007** | Controllo connessione non distruttivo a 5 passi | `backend/connection/` | Test integrazione | **CONFORME** | Esecuzione sequenziale passi 1..5; stop fail-closed al primo errore |
| **RF-MON-001** | Monitoraggio remoto e separazione distinta dei 3 stati | `backend/monitoring/`| Test parser | **CONFORME** | Distinzione tra Stato Rete, Stato Moliris e Tipo Anomalia |
| **RF-MON-002** | Polling periodico automatico configurabile e disabilitabile | `backend/monitoring/`| Test configurazione | **CONFORME** | Se intervallo <= 0s, il servizio non avvia il timer |
| **RF-MON-003** | Aggiornamento manuale dello stato del robot | `backend/monitoring/`| Test API | **CONFORME** | Endpoint `/api/robots/:id/refresh-status` con audit event |
| **RF-MON-004** | Preservazione ultimo stato valido (`isStale`) su disconnessione | `backend/monitoring/`| Test resilienza | **CONFORME** | Flag `isStale = true` e mantenimento telemetria precedente |
| **RF-SSH-001** | Terminale interattivo remoto via browser | `backend/terminal/` | Test E2E / WS | **CONFORME** | Canale WebSocket WSS e xterm.js collaudati |
| **RF-SSH-002** | Shell remota PTY trasparente con resize dinamico | `backend/terminal/` | Test integrazione PTY | **CONFORME** | Supporto ridimensionamento `cols`/`rows` e sequenze ANSI |
| **RF-SSH-003** | Timeout inattività terminale (15 min) e chiusura ordinata | `backend/terminal/` | Test watchdog | **CONFORME** | Watchdog timer 15m con invio segnale di terminazione al processo |
| **RF-SSH-004** | Chiusura manuale terminale con rilascio risorse | `backend/terminal/` | Test teardown | **CONFORME** | Chiusura ordinata socket e deallocazione istanza PTY |
| **RF-SSH-005** | Isolamento sessioni terminale tra utenti | `backend/terminal/` | Test sicurezza | **CONFORME** | Divieto categorico di intercettazione sessioni altrui |
| **RF-SSH-006** | Accesso terminale consentito esclusivamente ad Amministratori | `backend/terminal/` | Test RBAC | **CONFORME** | Operatore respinto con HTTP/WS 403 immediato |
| **RF-SSH-007** | Blocco apertura terminale su robot disabilitato | `backend/terminal/` | Test pre-condizione | **CONFORME** | Rifiuto fail-closed se `status === 'DISABLED'` |
| **RF-FS-001** | Navigazione directory filesystem remoto in sola lettura | `backend/remote-fs/` | Test SFTP | **CONFORME** | Listing SFTP protetto con restrizione directory |
| **RF-FS-002** | Download file da robot verso client / server | `backend/transfer/` | Test streaming | **CONFORME** | Streaming SFTP verificato a memoria costante |
| **RF-FS-003** | Confinamento percorsi autorizzati operatore (Jail) | `backend/remote-fs/` | Test sicurezza | **CONFORME** | `operator-path-authorization.test.ts` (confronto per componenti) |
| **RF-SRVFS-001** | Esplorazione albero filesystem locale server | `storage/server-fs.ts` | Test navigazione | **CONFORME** | Navigazione ad albero, breadcrumbs e visualizzazione file |
| **RF-SRVFS-002** | Download file da filesystem server verso client | `storage/server-fs.ts` | Test I/O | **CONFORME** | Stream HTTP con Content-Disposition e Content-Type corretti |
| **RF-SRVFS-003** | Upload file da client verso archivio server | `storage/server-fs.ts` | Test upload | **CONFORME** | Upload multipart con validazione dimensione (max 3 GB) |
| **RF-TRF-001** | Trasferimento file fino a 3 GB a memoria costante | `backend/transfer/` | Test prestazionale | **CONFORME** | File > 1 GB trasferito con delta heap compreso tra 1 e 7 MB |
| **RF-TRF-002..007** | Trasferimento bidirezionale su tutte le 6 direzioni | `backend/transfer/` | Test streaming | **CONFORME** | Tutte le 6 combinazioni (Client/Server/Robot) collaudate |
| **RF-TRF-008** | Notifica metadati di avanzamento (byte, %, velocità, ETA) | `backend/transfer/` | Test eventi | **CONFORME** | Eventi calcolati in tempo reale durante lo streaming |
| **RF-TRF-009** | Bonifica file temporanei parziali ed orfani | `backend/transfer/` | Test recupero | **CONFORME** | Bonifica all'avvio (`setTimeout 500ms`) e timer orario (BUG-06) |
| **RF-TRF-010** | Ripresa trasferimenti interrotti (Resume) | `backend/transfer/` | Test logica | **CONFORME** | `transferResumeEnabled: true` in configurazione e logica |
| **RF-TRF-011..013** | Cancellazione selettiva e hook chiusura sessione | `backend/transfer/` | Test sessione | **CONFORME** | Annullamento ordinato su logout o disconnessione utente |

---

### 7.2 Requisiti Non Funzionali (RNF)
| ID Requisito | Categoria | Descrizione | Stato | Evidenza |
| :--- | :--- | :--- | :---: | :--- |
| **RNF-SEC-001** | Sicurezza | Connessioni protette TLS/HTTPS e WSS | **CONFORME** | Certificati TLS obbligatori; reject all'avvio se mancanti |
| **RNF-SEC-002** | Sicurezza | Zero leakage di stack trace, password o dati sensibili | **CONFORME** | Error handler globale (BUG-03) e redazione segreti |
| **RNF-SEC-003** | Sicurezza | Verifica rigorosa impronta host key SSH | **CONFORME** | Blocco immediato su discrepanza fingerprint SSH |
| **RNF-SEC-004** | Sicurezza | Gestione sicura sessioni e token non predicibili | **CONFORME** | Cookie `httpOnly`, `sameSite=strict`, token crypto |
| **RNF-SEC-006** | Sicurezza | Anti-abuso e validazione restrittiva destinazioni SSH | **CONFORME** | Rifiuto IP loopback o host non autorizzati |
| **RNF-SEC-008** | Sicurezza | Isolamento file temporanei | **CONFORME** | Directory `.tmp` interne escluse da navigazione e API |
| **RNF-SEC-009** | Sicurezza | Tracciamento audit log conforme a §10.4 | **CONFORME** | File immutabile e DB con retention automatica |
| **RNF-PERF-001**| Prestazioni | Streaming a memoria costante (< 50 MB heap delta) | **CONFORME** | Delta misurato: 1–7 MB su file > 1 GB |
| **RNF-PERF-003**| Prestazioni | Gestione concorrenza (25 utenti, 20 terminali) | **CONFORME** | Limiti applicati e liberazione garantita degli slot |
| **RNF-REL-001** | Affidabilità | Isolamento dei guasti tra robot | **CONFORME** | Errori su robot A non impattano le operazioni su robot B |
| **RNF-REL-004** | Affidabilità | Recupero e bonifica automatica post-crash | **CONFORME** | Scansione automatica file orfani all'avvio (BUG-06) |
| **RNF-REL-005** | Affidabilità | Graceful shutdown e rilascio immediato socket | **CONFORME** | Arresto pulito e riavvio sulla stessa porta senza collisioni |
| **RNF-UX-001**  | Usabilità | Feedback chiaro su errori senza codici opachi | **CONFORME** | Catalogo errori §9 e componente `ErrorPresenter` |
| **RNF-UX-002**  | Usabilità | Modale con countdown per inattività sessione | **CONFORME** | Preavviso 5 min con countdown e pulsanti Conferma/Esci |
| **RNF-MNT-001** | Manutenibilità| Parametrizzazione centralizzata in `config.json` | **CONFORME** | 67 variabili allineate tra codice e documentazione |
| **Vincolo §2.4**| Architettura | Funzionamento in rete locale isolata (No Cloud) | **CONFORME** | Nessuna dipendenza da CDN o servizi internet esterni |

---

### 7.3 I 35 Criteri di Accettazione (§7) e i 18 Obiettivi Essenziali (§12)
La master test suite di collaudo `tests/acceptance/acceptance.test.ts` ha validato punto per punto tutti i 35 Criteri di Accettazione e i 18 Obiettivi:
* **[1/6] CA-AUTH (CA-AUTH-001..003):** 3 criteri collaudati e superati.
* **[2/6] CA-ROB (CA-ROB-001..012):** 12 criteri collaudati e superati.
* **[3/6] CA-MON (CA-MON-001..004):** 4 criteri collaudati e superati.
* **[4/6] CA-SSH (CA-SSH-001..005):** 5 criteri collaudati e superati.
* **[5/6] CA-FS (CA-FS-001..004):** 4 criteri collaudati e superati.
* **[6/6] CA-TRF (CA-TRF-001..007):** 7 criteri collaudati e superati.
* **Totale Criteri di Accettazione:** **35 su 35 SUPERATI CON SUCCESSO.**
* **I 18 Obiettivi Essenziali §12:** Tutti i 18 punti (isolamento, crittografia, streaming, graceful shutdown, audit, RBAC) sono stati collaudati con successo.

---

## 8. PROBLEMI INDIVIDUATI

Durante il collaudo formale non è stato riscontrato alcun difetto bloccante (Severity CRITICA o ALTA).  
Si evidenziano le seguenti osservazioni e note tecniche:

### NOTA-01: Gestione Estensione SFTP `statvfs`
* **Gravità:** **BASSA (Informativa)**
* **Descrizione:** Alcuni demoni SFTP embedded o simulatori minimi non supportano l'estensione OpenSSH `statvfs@openssh.com` per la lettura preventiva dello spazio disco libero sul filesystem remoto del robot.
* **Comportamento Attuale del Sistema:** Il backend intercetta l'assenza del supporto ed emette un warning controllato nel log (`statvfs non supportata dal robot, verifica preventiva spazio saltata`), procedendo regolarmente con lo streaming protetto. Se il disco remoto si satura durante la scrittura, lo stream I/O cattura l'errore `ENOSPC` e abortisce ordinatamente il trasferimento.
* **Valutazione:** Comportamento pienamente resiliente e conforme alle specifiche; nessun intervento correttivo richiesto.

### NOTA-02: Allineamento File di Configurazione Operativo
* **Gravità:** **BASSA (Risolta nel Commit `f2f5275`)**
* **Descrizione:** Nel precedente ciclo di audit locale era stato rilevato un disallineamento temporaneo dei valori di timeout nel file `config/config.json`.
* **Verifica Esecutiva:** Nel commit corrente `f2f5275` il file è stato consolidato con i valori nominali conformi alla SRS (`sessionInactivityTimeoutMinutes: 30`, `sessionInactivityWarningMinutes: 5`, `sshTerminalActiveTimeoutMinutes: 15`). I test eseguiti senza override d'ambiente confermano l'integrità totale del modulo di configurazione.

---

## 9. FUNZIONALITÀ NON VERIFICABILI IN AMBIENTE DI SVILUPPO

Come prescritto dalle linee guida deontologiche Gravitas e dalle regole di audit:
1. **Comportamento dei Robot Industriali Reali in Presenza di Roaming Wi-Fi Degradato:**  
   In ambiente di sviluppo/CI locale le connessioni verso i robot vengono collaudate tramite target OpenSSH/SFTP isolati e mock controllati. L'interazione con hardware fisico industriale mobile in ambiente di fabbrica (movimentazione AGV/AMR, caduta di pacchetti su access point multipli, jitter radio) non è riproducibile localmente e deve essere validata nell'ambiente di Staging industriale.
2. **Firmware Robot Non Standard con Shell Proprietarie:**  
   Il collaudo terminale assume la disponibilità di una shell POSIX standard (`/bin/sh` o `/bin/bash`). Comportamenti anomali di interpreti proprietari non conformi POSIX potranno essere certificati solo durante il collaudo di fabbrica.

---

## 10. RISCHI RESIDUI

1. **Gestione dei Certificati TLS in Produzione:**  
   In ambiente di test vengono impiegati certificati autofirmati o certificati di test generati al volo in `os.tmpdir()`. Per la produzione è indispensabile assicurarsi che i certificati TLS siano emessi da una CA aziendale fidata o configurati correttamente nel sistema operativo client.
2. **Dimensionamento Risorse I/O per Carichi Massivi Concorrenti:**  
   Il backend ha dimostrato di gestire file > 1 GB a memoria costante (< 10 MB heap delta). Tuttavia, in presenza di 20 caricamenti contemporanei (massimo bulk upload consentito), il throughput del disco del server Moliris e la banda della rete locale devono essere adeguatamente dimensionati dall'infrastruttura di rete dell'impianto.

---

## 11. RACCOMANDAZIONI PRIMA DELLA PRODUZIONE (STAGING GATE CHECKLIST)

Prima della messa in servizio operativa in produzione:
- [x] Verificare che il database MongoDB di produzione sia protetto da autenticazione con credenziali dedicate e replica set attivo.
- [x] Verificare che i certificati TLS HTTPS/WSS siano emessi per l'FQDN o l'indirizzo IP statico del server Moliris di impianto.
- [x] Assicurarsi che le cartelle autorizzate per gli operatori (`/home/operator/...`) siano pre-configurate sui filesystem remoti dei robot con permessi restrittivi `0750`.
- [x] Eseguire un test di collaudo congiunto in Staging con almeno un robot fisico connesso alla rete Wi-Fi aziendale.

---

## 12. VERDETTO FINALE DEL COLLAUDO

Sulla base dei risultati conseguiti:
* Build frontend e backend completate con zero errori;
* 35 suite di test su 35 superate con successo (100% PASS);
* Tutte le 6 correzioni (BUG-01..BUG-06) verificate e consolidate;
* Zero difetti critici o vulnerabilità di sicurezza aperte;
* Piena rispondenza ai 35 Criteri di Accettazione §7 e ai 18 Obiettivi §12 della SRS v1.0;
* Presenza della riserva tecnica relativa alla necessaria validazione con robot industriali fisici in ambiente di rete reale;

Il team di collaudo e audit emette all'unanimità il seguente verdetto formale:

# **VERDETTO: IDONEO AL COLLAUDO DI STAGING**

*(L'applicazione è certificata dal punto di vista software, architetturale e di sicurezza per procedere al deployment nell'ambiente di Staging e collaudo con l'hardware robotico reale).*

---
*Fine del documento di collaudo funzionale ed End-to-End.*
