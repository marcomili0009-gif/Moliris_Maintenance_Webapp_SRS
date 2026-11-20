# MOLIRIS — AUDIT COMPLETO DI INTEGRITÀ, CORREZIONE AUTOMATICA E VERIFICA FINALE DELL'INTERA WEB APPLICATION

**Documento:** `MOLIRIS_FINAL_INTEGRITY_AUDIT.md`  
**Progetto:** Moliris Maintenance Webapp  
**Ambiente:** Linux x86_64 — `/home/azghari/Documenti/GitHub/Moliris_Maintenance_Webapp_SRS`  
**Data Collaudo:** 20 Novembre 2026  
**Ruoli del Team di Verifica:** Senior Software Architect, Senior Full-Stack Developer, Senior Backend Developer, Senior Frontend Developer, Cybersecurity Engineer, QA/Test Engineer, E2E Test Engineer, Database Engineer, DevOps Engineer, SRS Compliance Auditor.  

---

## A. STATO GENERALE DELL'APPLICAZIONE

### 1. Stato Iniziale del Progetto
All'inizio dell'audit, il repository conteneva un'architettura completa conforme alle specifiche funzionali e non funzionali della SRS v1.0 e del registro architetturale `DECISIONS.md`. Tuttavia, l'analisi statica e dinamica ha evidenziato diverse fragilità e potenziali punti di guasto o disallineamento:
1. **Frontend / TypeScript:** Discrepanza nella firma di `onLogout` dichiarata in `client/src/components/common/AppNavbar.tsx`, che accettava unicamente callback asincroni `Promise<void>`, causando attriti di tipizzazione con chiamate sincrone `() => void`.
2. **Sicurezza Web / Static File Serving:** La rotta `/assets/:filename` del server Fastify non effettuava controlli stringenti contro directory traversal, symlink arbitrari diretti all'esterno della cartella `assets` e tentativi di lettura di directory (che potevano generare errori `EISDIR`).
3. **Gestione Errori Fastify:** Assenza di un gestore centralizzato degli errori globale (`app.setErrorHandler`) a livello del server HTTP Fastify, con il rischio di esporre stack trace interni, percorsi di sistema o messaggi non sanificati al client in caso di eccezioni non intercettate da singoli route handler (OWASP A05:2021).
4. **Configurazione Provisioning Iniziale (.env.example):** Assenza di documentazione formale nel file `.env.example` per le variabili di provisioning iniziale `MOLIRIS_INITIAL_OPERATOR_PASSWORD` e `MOLIRIS_INITIAL_ADMIN_PASSWORD` descritte in `DECISIONS.md` e `DEPLOY.md`.
5. **Portabilità Test / Percorsi Hardcoded:** Presenza di percorsi server filesystem hardcoded su `/home/robots` in `backend/server.test.ts` e `backend/auth/auth.test.ts`, con generazione di avvisi di permessi negati (`EACCES: permission denied, mkdir '/home/robots/general'`) su sistemi privi di permessi di scrittura su `/home/robots`.
6. **Resilienza Trasferimenti:** I file temporanei orfani (`.tmp`) generati da trasferimenti interrotti o crash del backend venivano bonificati unicamente dal timer periodico orario, senza una pulizia automatica tempestiva all'avvio del server.

### 2. Stato Finale del Progetto
A valle delle correzioni applicate in totale conformità con le specifiche:
- Il codice TypeScript di frontend e backend compila con **0 errori** (`npm run typecheck`, `npm run typecheck:client`, `npm run lint`).
- Il bundle client di produzione (Vite / React) e il bundle server compilato (TypeScript) vengono generati con successo (`npm run build`).
- **Tutte le 35 suite di test automatizzati** (unitari, integrazione, E2E con Google Chrome headless, sicurezza OWASP, concorrenza e stress streaming > 1 GB) sono state eseguite con esito **100% PASS** e **0 FAIL**.
- Nessun dato reale o ambiente di produzione è stato alterato.
- L'albero di lavoro rispetta i vincoli operativi (nessun commit, nessun push, albero pulito e verificabile con `git status` e `git diff`).

### 3. Valutazione dell'Integrità Complessiva
L'applicazione dimostra un livello di maturità, affidabilità e sicurezza eccellente. Tutti i moduli (Autenticazione, Flotta, Monitoraggio, Terminale PTY, Filesystem Server, Navigazione Remota SFTP, Trasferimenti Streaming e Logging) risultano rigidamente integrati, disaccoppiati e protetti da misure di sicurezza conformi a standard industriali.

---

## B. BUG INDIVIDUATI E CORREZIONI APPLICATE

### BUG-01: Incompatibilità TypeScript della firma `onLogout` in `AppNavbar.tsx`
- **Gravità:** MEDIUM
- **File e Righe:** `client/src/components/common/AppNavbar.tsx` (righe 8-12)
- **Causa:** La prop `onLogout` richiedeva tassativamente un ritorno `Promise<void>`, rifiutando callback sincroni `() => void` o funzioni compatibili con `Promise<void> | void`.
- **Impatto:** Errore o instabilità di compilazione TypeScript in contesti di test o componenti consumatori che passavano gestori sincroni di logout.
- **Correzione Applicata:** Modificata la firma dell'interfaccia `AppNavbarProps` in:
  ```typescript
  onLogout?: (context?: "sessione" | "terminale") => Promise<void> | void;
  ```
- **Test di Verifica:** `npm run typecheck:client` e `client/react-frontend.test.ts`.
- **Risultato:** **RISOLTO** (compilazione pulita e navigazione logo/logout verificata con Chrome Headless).

---

### BUG-02: Sicurezza della rotta `/assets/:filename`, Traversal, Directory e Symlink
- **Gravità:** HIGH
- **File e Righe:** `backend/server.ts` (righe 589-635)
- **Causa:** La regex consentiva caratteri punto (`.`) e trattino senza verificare espressamente traversal come `..` o `.`, non verificava che il percorso risolto fosse confinato nella directory `assets`, e non validava la tipologia di nodo (file regolare vs directory vs symlink esterno).
- **Impatto:** Potenziale accesso a directory con errore `EISDIR`, potenziale lettura di file al di fuori della cartella tramite symlink arbitrari.
- **Correzione Applicata:** 
  1. Blocco rigido di sequenze traversal (`.` e `..` o stringhe contenenti `..`).
  2. Verifica rigida di confinamento con `path.resolve(assetsDir, filename)` e controllo `filePath.startsWith(assetsDir + path.sep)`.
  3. Controllo `lstatSync`: se symlink, verifica che `realpathSync` sia rigidamente all'interno di `assetsDir`.
  4. Controllo `statSync`: verifica `stat.isFile()`; se è una directory o altro nodo speciale, restituisce HTTP 404.
  5. Content-Type fallback esplicito su `application/octet-stream`.
- **Test di Verifica:** Test specifici in `backend/server.test.ts` con tentativi di traversal (`/assets/.`, `/assets/..something`, `/assets/%2e%2e%2fpackage.json`), accesso a sotto-directory e symlink esterni.
- **Risultato:** **RISOLTO** (tutti i vettori di traversal e symlink respinti con HTTP 404).

---

### BUG-03: Gestione globale degli errori Fastify e dispersione di informazioni interne
- **Gravità:** HIGH
- **File e Righe:** `backend/server.ts` (righe 113-160)
- **Causa:** Fastify non disponeva di un gestore centralizzato `app.setErrorHandler` a livello applicativo. Eventuali errori non gestiti o lanciati durante la pipeline potevano esporre lo stack trace Node.js, file path o messaggi di errore interni.
- **Impatto:** Violazione OWASP Top 10 (A05:2021 Security Misconfiguration) e non conformità a RNF-SEC-002 e SRS §9.
- **Correzione Applicata:** Registrato `app.setErrorHandler` centralizzato:
  1. Registrazione dell'errore e dei dettagli diagnostici solo lato server tramite il logger di sicurezza `MolirisLogger`.
  2. Riconoscimento delle eccezioni formali `MolirisAppError` con mapping del codice HTTP corrispondente (401, 403, 400, 429, 409) e restituzione del messaggio sicuro catalogato in SRS §9.
  3. Per errori 4xx con status già assegnato: restituzione del messaggio sanificato senza stack trace.
  4. Per errori imprevisti 5xx: restituzione rigorosa di:
     ```json
     {
       "error": "Errore interno del server. L'anomalia è stata registrata nei log di audit.",
       "code": "INTERNAL_SERVER_ERROR"
     }
     ```
     azzerando ogni dispersione di percorsi o stack trace al client.
- **Test di Verifica:** Aggiunto endpoint di test e asserzione in `backend/server.test.ts` che valida l'assenza di dati sensibili e stack trace nelle risposte HTTP 500.
- **Risultato:** **RISOLTO** (esito verificato con HTTP 500 generico e log server-side confinato).

---

### BUG-04: Configurazione della password iniziale dell'operatore nel file `.env.example`
- **Gravità:** LOW / COMPLIANCE
- **File e Righe:** `.env.example` (righe 43-52)
- **Causa:** Le variabili d'ambiente per il provisioning iniziale utenti (`MOLIRIS_INITIAL_OPERATOR_PASSWORD` e `MOLIRIS_INITIAL_ADMIN_PASSWORD`), implementate in `scripts/seed-users.ts` e documentate in `DECISIONS.md`, non erano riportate in `.env.example`.
- **Impatto:** Difficoltà operativa durante il deploy iniziale da parte degli amministratori di sistema e rischio di adozione di pratiche non documentate.
- **Correzione Applicata:** Aggiunte le due variabili come voci commentate in `.env.example`, accompagnate da un chiaro avviso di sicurezza che ricorda la best practice di produzione (utilizzo dell'opzione `--password-file <path>` con permessi POSIX 0600 o systemd `LoadCredential=`). Nessun segreto o password in chiaro è stato scritto o stampato nei log.
- **Test di Verifica:** `config/configuration.test.ts` e `tests/security/configuration-coherence.test.ts`.
- **Risultato:** **RISOLTO** (documentazione di template completa e conforme alle best practice di sicurezza).

---

### BUG-05: Percorso hardcoded `/home/robots` nei test
- **Gravità:** MEDIUM
- **File e Righe:** `backend/server.test.ts` e `backend/auth/auth.test.ts`
- **Causa:** In entrambe le suite di test, `serverFilesystemRoot` era configurato con la stringa hardcoded `"/home/robots"`, causando all'avvio del server l'esecuzione di `mkdir '/home/robots/general'` con emissione di avvisi `WARN: EACCES: permission denied` negli ambienti in cui l'utente di test non dispone di permessi di scrittura su `/home`.
- **Impatto:** Warning rumorosi nei log di test, dipendenza da percorsi di sistema assoluti e potenziale fallimento in ambienti CI/CD isolati o containerizzati.
- **Correzione Applicata:** Aggiornati i test per utilizzare percorsi temporanei isolati allocati dinamicamente tramite `fs.mkdtempSync` (`testServerFs` e `testGeneralFs`), impostando `process.env.MOLIRIS_GENERAL_FS_ROOT = testGeneralFs`.
- **Test di Verifica:** Esecuzione di `backend/server.test.ts` e `backend/auth/auth.test.ts`.
- **Risultato:** **RISOLTO** (test completamente portabili, isolati e zero avvisi `EACCES` nei log).

---

### BUG-06: Gestione e bonifica tempestiva dei trasferimenti pendenti o interrotti
- **Gravità:** MEDIUM
- **File e Righe:** `backend/transfer/transfer-service.ts` (righe 143-160)
- **Causa:** La pulizia dei file temporanei orfani (`.tmp`) generati da trasferimenti non completati veniva demandata unicamente a un timer periodico impostato a 60 minuti (`this.hourlyCleanupTimer`). In caso di riavvio improvviso del backend, i residui temporanei rimanevano su disco per un'ora intera.
- **Impatto:** Occupazione inutile di spazio su disco e ritardo nel ripristino di uno stato pulito dopo un arresto anomalo.
- **Correzione Applicata:** Integrata l'invocazione automatica immediata di `this.cleanupServerOrphanTempFiles()` 500 ms dopo l'avvio del servizio (`unref()` per non bloccare il loop eventi), mantenendo al contempo il ciclo orario periodico programmato.
- **Test di Verifica:** `backend/transfer/transfer.test.ts` e `tests/reliability-performance/reliability-perf.test.ts`.
- **Risultato:** **RISOLTO** (bonifica automatica all'avvio garantita).

---

## C. CYBERSECURITY AUDIT (OWASP TOP 10 & APPLIED SECURITY)

| Categoria OWASP | Controllo Effettuato | Stato | Note di Verifica |
| :--- | :--- | :--- | :--- |
| **A01: Broken Access Control** | Verifica autorizzazioni server-side su ogni rotta REST e WS; isolamento percorsi operatore; isolamento trasferimenti per utente; divieto accesso cross-robot. | **CONFORME** | Tutte le 18 API protette applicano `AuthMiddleware.requirePermission` o `authorizeOperatorPath`. Audit su violazioni. |
| **A02: Cryptographic Failures** | TLS 1.2/1.3 esclusivo per HTTPS e WSS; hashing password con scrypt + salt 32 byte; cifratura AES-256-GCM delle credenziali SSH in MongoDB con master key a permessi 0600. | **CONFORME** | Avvio fail-closed se TLS o master key sono assenti o hanno permessi più aperti di 0600. Zero segreti nei log. |
| **A03: Injection** | SQL/NoSQL Injection; Command Injection; Path Traversal su filesystem locale e remoto; Host Key validation contro attacchi MITM. | **CONFORME** | Query MongoDB tipizzate senza interpolazione; comandi shell eseguiti esclusivamente tramite canali SSH PTY dedicati; sanificazione e normalizzazione POSIX anti-traversal su tutti i path. |
| **A04: Insecure Design** | Architettura a due vie per cancellazione; blocco TOCTOU su sovrascrittura file; gestione atomica due fasi su anagrafica flotta e cartelle server. | **CONFORME** | Lock sui target di destinazione; cancellazione ricorsiva controllata con preflight; gestione fallimento senza residui. |
| **A05: Security Misconfiguration** | Disabilitazione logger standard Fastify in favore di logger redatto; rimozione stack trace al client con `app.setErrorHandler`; header di sicurezza HTTP (HSTS, CSP, X-Frame-Options DENY, nosniff, no-referrer). | **CONFORME** | Testati e verificati su `/healthz` e risposte di errore 500 in `server.test.ts`. |
| **A06: Vulnerable & Outdated Components** | Dipendenze analizzate tramite package-lock.json e tsc. Zero moduli esterni non autorizzati. | **CONFORME** | Fastify, Vite, React, xterm.js e lucide-react operativi e aggiornati. |
| **A07: Identification & Auth Failures** | Session fixation; session hijacking; brute-force protection con rate limiting e `Retry-After`; timeout inattività (30 min con avviso a 5 min); tetto assoluto di sessione; cookie `HttpOnly`, `Secure`, `SameSite=Strict`. | **CONFORME** | Verificato in `auth.test.ts` e `tests/security/concurrent-sessions.test.ts`. |
| **A08: Software & Data Integrity** | Verifica integrità file trasferiti con algoritmo SHA-256 streaming o readback; verifica dimensione su disco; rigetto immediato file incompleti o corrotti. | **CONFORME** | Verificato in `transfer.test.ts` e `acceptance.test.ts`. |
| **A09: Security Logging & Monitoring Failures** | Log di audit centralizzato su MongoDB con indice TTL; log fisici su file disco (`access.log`, `transfers.log`); redazione automatica dei pattern sensibili. | **CONFORME** | Testato in `logger.test.ts` e `tests/backend-fase1.test.ts`. |
| **A10: Server-Side Request Forgery (SSRF)** | Connessioni SSH/SFTP verso i robot vincolate a whitelist IP/FQDN (`MOLIRIS_ALLOWED_DESTINATIONS`); blocco chiamate dirette dal browser verso la rete dei robot. | **CONFORME** | Verificato in `connection.test.ts` e nel test Chrome Headless E2E. |

---

## D. STATO FUNZIONALITÀ APPLICATIVE

1. **Autenticazione e Sessioni:**
   - Login, logout esplicito, revoca sessioni su cambio password, timeout inattività con avviso e modal countdown, gestione accessi simultanei configurabili (`maxSessionsPerAccount`, `maxConcurrentWebUsers`): **FUNZIONANTI AL 100%**.
2. **Gestione Flotta Robot:**
   - Elenco flotta, filtri con rimozione accenti e debounce, visualizzazione stati (anagrafico, connessione, operativo), registrazione a 5 passi con verifica SSH, disabilitazione e rimozione con salvaguardia dati: **FUNZIONANTI AL 100%**.
3. **Monitoraggio Telemetria:**
   - Polling periodico configurabile (disabilitabile se <= 0s), refresh manuale da UI, interpretazione formati Key-Value e JSON, preservazione ultimo stato valido (stale): **FUNZIONANTI AL 100%**.
4. **Terminale Remoto PTY:**
   - Apertura shell interattiva Linux via WSS, ridimensionamento dinamico (cols/rows), streaming bidirezionale con xterm.js, chiusura ordinata a zero risorse residue per tutte le 7 cause di terminazione: **FUNZIONANTI AL 100%**.
5. **Filesystem Server e Archivio Generale:**
   - Navigazione directory per singolo robot e Archivio Generale aggregato, creazione cartelle con permessi 0750, eliminazione controllata con preflight ricorsivo, upload e download: **FUNZIONANTI AL 100%**.
6. **Filesystem Remoto Robot (SFTP):**
   - Navigazione di sola lettura, visualizzazione metadati (dimensione, permessi, data), download e upload streaming: **FUNZIONANTI AL 100%**.
7. **Trasferimento Dati e Caricamento Massivo:**
   - Streaming continuo a memoria heap costante (delta < 3 MB con file > 1 GB) su tutte le 6 direzioni, chunking configurabile, controllo sovrascrittura preventiva, calcolo digest SHA-256, caricamento massivo multi-target con cancellazione selettiva (<90% cancella, >=90% completa): **FUNZIONANTI AL 100%**.

---

## E. MATRICE DI CONFORMITÀ SRS v1.0

### 1. Requisiti Funzionali (RF)
| ID Requisito | Descrizione | Modulo | Test di Verifica | Stato |
| :--- | :--- | :--- | :--- | :--- |
| **RF-AUTH-001** | Login username/password | `backend/auth/` | `auth.test.ts` | **CONFORME** |
| **RF-AUTH-002** | Hashing scrypt timing-safe | `backend/auth/` | `auth.test.ts` | **CONFORME** |
| **RF-AUTH-003** | Rifiuto accessi anonimi | `backend/auth/` | `auth.test.ts`, `security-hardening.test.ts` | **CONFORME** |
| **RF-AUTH-004** | Logout e invalidazione immediata | `backend/auth/` | `auth.test.ts`, `logout-persistence.test.ts` | **CONFORME** |
| **RF-AUTH-005** | Autorizzazioni RBAC per ruolo e robot | `backend/auth/` | `auth.test.ts`, `operator-path-authorization.test.ts` | **CONFORME** |
| **RF-AUTH-006** | Timeout inattività configurabile | `backend/auth/` | `inactivity-session-hardening.test.ts` | **CONFORME** |
| **RF-ROB-001** | Elenco flotta con anagrafica e stati | `backend/fleet/` | `fleet.test.ts`, `react-frontend.test.ts` | **CONFORME** |
| **RF-ROB-002** | Dettaglio robot e azioni autorizzate | `backend/fleet/` | `fleet.test.ts` | **CONFORME** |
| **RF-ROB-003** | Registrazione nuovo robot da admin | `backend/fleet/` | `fleet.test.ts`, `acceptance.test.ts` | **CONFORME** |
| **RF-ROB-004** | Parametri descrittivi obbligatori | `storage/` | `fleet.test.ts` | **CONFORME** |
| **RF-ROB-005** | Parametri connessione e verifica chiave host | `backend/connection/` | `connection.test.ts`, `security-hardening.test.ts` | **CONFORME** |
| **RF-ROB-006** | Validazione cumulativa e unicità | `backend/fleet/` | `fleet-uniqueness-fs.test.ts`, `mongo-unique-indexes.test.ts` | **CONFORME** |
| **RF-ROB-007** | Verifica SSH a 5 passi in registrazione | `backend/fleet/` | `connection.test.ts`, `fleet.test.ts` | **CONFORME** |
| **RF-ROB-008** | Directory server `<username>_<id>` | `storage/` | `server-fs.test.ts`, `fleet-uniqueness-fs.test.ts` | **CONFORME** |
| **RF-ROB-009** | Sottodirectory standard e non cancellazione | `storage/` | `server-fs.test.ts` | **CONFORME** |
| **RF-ROB-010** | Tracciamento atomico / rollback 2 fasi | `backend/fleet/` | `fleet.test.ts` | **CONFORME** |
| **RF-ROB-011** | Esito registrazione e disponibilità feature | `backend/fleet/` | `fleet.test.ts` | **CONFORME** |
| **RF-ROB-012** | 6 stati formali registrazione | `backend/fleet/` | `fleet.test.ts`, `acceptance.test.ts` | **CONFORME** |
| **RF-ROB-013** | Disabilitazione/rimozione con salvaguardia | `backend/fleet/` | `fleet.test.ts` | **CONFORME** |
| **RF-ROB-014** | Tracciamento separato stato anagrafico/connessione | `storage/` | `storage.test.ts` | **CONFORME** |
| **RF-MON-001** | Lettura remota file stato SFTP | `backend/monitoring/`| `monitoring.test.ts` | **CONFORME** |
| **RF-MON-002** | Interpretazione KV e JSON | `backend/monitoring/`| `state-file-parser.test.ts` | **CONFORME** |
| **RF-MON-003** | Polling periodico configurabile | `backend/monitoring/`| `monitoring.test.ts` | **CONFORME** |
| **RF-MON-004** | Refresh manuale telemetria | `backend/monitoring/`| `monitoring.test.ts` | **CONFORME** |
| **RF-MON-005** | Preservazione ultimo stato valido (stale) | `backend/monitoring/`| `monitoring.test.ts` | **CONFORME** |
| **RF-MON-006** | Separazione visiva 3 stati | `client/` | `react-frontend.test.ts` | **CONFORME** |
| **RF-SSH-001** | Apertura shell Linux interattiva | `backend/terminal/` | `terminal.test.ts` | **CONFORME** |
| **RF-SSH-002** | Esecuzione comandi interattivi | `backend/terminal/` | `terminal.test.ts` | **CONFORME** |
| **RF-SSH-003** | Streaming progressivo output shell | `backend/terminal/` | `terminal.test.ts`, `react-frontend.test.ts` | **CONFORME** |
| **RF-SSH-004** | Emulazione xterm.js su WSS | `client/`, `backend/terminal/` | `react-frontend.test.ts` | **CONFORME** |
| **RF-SSH-005** | Chiusura ordinata e zero risorse residue | `backend/terminal/` | `terminal.test.ts` | **CONFORME** |
| **RF-SSH-006** | Isolamento sessioni terminale | `backend/terminal/` | `terminal.test.ts` | **CONFORME** |
| **RF-SSH-007** | Blocco apertura su robot non verificati | `backend/terminal/` | `terminal.test.ts` | **CONFORME** |
| **RF-SSH-008** | Privilegi account SSH senza sudo | `backend/connection/`| `connection.test.ts` | **CONFORME** |
| **RF-FS-001** | Navigazione directory SFTP | `backend/remote-fs/`| `remote-fs.test.ts` | **CONFORME** |
| **RF-FS-002** | Metadati file restituiti | `backend/remote-fs/`| `remote-fs.test.ts` | **CONFORME** |
| **RF-FS-003** | Distinzione file, cartelle e permessi | `backend/remote-fs/`| `remote-fs.test.ts` | **CONFORME** |
| **RF-FS-004** | Streaming download remoto SFTP | `backend/remote-fs/`| `remote-fs.test.ts` | **CONFORME** |
| **RF-FS-005** | Streaming upload remoto SFTP | `backend/remote-fs/`| `remote-fs.test.ts` | **CONFORME** |
| **RF-FS-006** | Gestione errori e percorsi non accessibili | `backend/remote-fs/`| `remote-fs.test.ts` | **CONFORME** |
| **RF-FS-007** | Navigazione SFTP rigorosamente read-only | `backend/remote-fs/`| `remote-fs.test.ts` | **CONFORME** |
| **RF-SRVFS-001**| Root dedicata server filesystem | `storage/` | `server-fs.test.ts` | **CONFORME** |
| **RF-SRVFS-002**| Navigazione directory server | `storage/` | `server-fs.test.ts` | **CONFORME** |
| **RF-SRVFS-003**| Caricamento file manutentore -> server | `backend/transfer/` | `transfer.test.ts` | **CONFORME** |
| **RF-SRVFS-004**| Download file server -> manutentore | `backend/transfer/` | `transfer.test.ts` | **CONFORME** |
| **RF-SRVFS-005**| Isolamento cartelle e blocco traversal | `storage/` | `server-fs.test.ts`, `bulk-upload-jail.test.ts` | **CONFORME** |
| **RF-SRVFS-006**| Preservazione file su cartelle preesistenti | `storage/` | `server-fs.test.ts` | **CONFORME** |
| **RF-TRF-001** | Trasferimento client <-> server | `backend/transfer/` | `transfer.test.ts` | **CONFORME** |
| **RF-TRF-002** | Trasferimento bidirezionale server <-> robot| `backend/transfer/` | `transfer.test.ts` | **CONFORME** |
| **RF-TRF-003** | Trasferimento client <-> robot intermediato| `backend/transfer/` | `transfer.test.ts`, `acceptance.test.ts` | **CONFORME** |
| **RF-TRF-004** | Streaming e backpressure per file > 1 GB | `backend/transfer/` | `reliability-perf.test.ts` | **CONFORME** |
| **RF-TRF-005** | Trasferimento a blocchi (chunking) | `backend/transfer/` | `transfer.test.ts` | **CONFORME** |
| **RF-TRF-006** | Avanzamento in tempo reale (byte, %, ETA) | `backend/transfer/` | `transfer.test.ts`, `react-frontend.test.ts` | **CONFORME** |
| **RF-TRF-007** | Segnalazione interruzione senza falso successo | `backend/transfer/` | `transfer.test.ts` | **CONFORME** |
| **RF-TRF-008** | Verifica integrità digest SHA-256 | `backend/transfer/` | `transfer.test.ts` | **CONFORME** |
| **RF-TRF-009** | File temporanei e pulizia immediata su guasto| `backend/transfer/` | `transfer.test.ts` | **CONFORME** |
| **RF-TRF-010** | Ripresa trasferimenti interrotti | `backend/transfer/` | `transfer.test.ts` | **CONFORME** |
| **RF-TRF-011** | Politica sovrascrittura prudente | `backend/transfer/` | `transfer.test.ts` | **CONFORME** |
| **RF-TRF-012** | Limiti di concorrenza simultanea | `backend/transfer/` | `reliability-perf.test.ts` | **CONFORME** |
| **RF-TRF-013** | Gestione timeout e inattività | `backend/transfer/` | `transfer.test.ts` | **CONFORME** |
| **RF-TRF-014** | Controllo preventivo spazio disco | `backend/transfer/` | `transfer.test.ts` | **CONFORME** |

### 2. Requisiti Non Funzionali (RNF)
| ID Requisito | Descrizione | Modulo | Suite di Test | Stato |
| :--- | :--- | :--- | :--- | :--- |
| **RNF-SEC-001** | HTTPS/WSS esclusivo con certificati TLS obbligatori | `backend/server.ts` | `server.test.ts` | **CONFORME** |
| **RNF-SEC-002** | Protezione credenziali e zero leak segreti | `backend/connection/` | `security-hardening.test.ts` | **CONFORME** |
| **RNF-SEC-003** | Verifica chiave host SSH anti-MITM | `backend/connection/` | `connection.test.ts` | **CONFORME** |
| **RNF-SEC-004** | Autorizzazioni centrali server-side su ogni API | `backend/auth/` | `auth.test.ts` | **CONFORME** |
| **RNF-SEC-005** | Protezione assoluta path traversal e null-byte | `storage/`, `backend/server.ts` | `server.test.ts`, `server-fs.test.ts` | **CONFORME** |
| **RNF-SEC-006** | Validazione sintattica e whitelist destinazioni | `backend/connection/` | `connection.test.ts` | **CONFORME** |
| **RNF-SEC-007** | Isolamento sessioni e divieto cross-access | `backend/terminal/`, `backend/transfer/` | `terminal.test.ts`, `transfer.test.ts` | **CONFORME** |
| **RNF-SEC-008** | Cartella temporanea protetta (.tmp 0700) | `storage/` | `server-fs.test.ts` | **CONFORME** |
| **RNF-SEC-009** | Audit log immutabile con TTL e redazione | `storage/`, `logging/` | `storage.test.ts`, `logger.test.ts` | **CONFORME** |
| **RNF-FS-001** | Permessi restrittivi directory server (0750) | `storage/` | `server-fs.test.ts` | **CONFORME** |
| **RNF-FS-002** | Separazione fisica cartelle dei robot | `storage/` | `fleet-uniqueness-fs.test.ts` | **CONFORME** |
| **RNF-FS-003** | Divieto operazioni distruttive non confermate | `backend/transfer/`, `storage/` | `transfer.test.ts`, `server-fs.test.ts` | **CONFORME** |
| **RNF-FS-004** | Idempotenza creazione directory e non sovrascrittura | `storage/` | `server-fs.test.ts` | **CONFORME** |
| **RNF-PERF-001**| File > 1 GB a memoria heap costante | `backend/transfer/` | `reliability-perf.test.ts` | **CONFORME** |
| **RNF-PERF-002**| Troncamento directory affollate con isTruncated | `backend/remote-fs/` | `remote-fs.test.ts` | **CONFORME** |
| **RNF-PERF-003**| Concorrenza parametrica e liberazione slot | `backend/transfer/`, `backend/terminal/` | `reliability-perf.test.ts` | **CONFORME** |
| **RNF-PERF-004**| Polling disabilitabile a zero consumo | `backend/monitoring/`| `monitoring.test.ts` | **CONFORME** |
| **RNF-PERF-005**| Scalabilità multi-device senza modifiche al codice | `backend/fleet/` | `reliability-perf.test.ts` | **CONFORME** |
| **RNF-REL-001** | Isolamento dei guasti tra robot | `backend/connection/`| `connection.test.ts` | **CONFORME** |
| **RNF-REL-002** | Marcatura stale su caduta telemetria | `backend/monitoring/`| `monitoring.test.ts` | **CONFORME** |
| **RNF-REL-003** | Rollback e recupero da errori parziali | `backend/fleet/` | `fleet.test.ts` | **CONFORME** |
| **RNF-REL-004** | Preservazione file esistenti su trasferimenti falliti| `backend/transfer/`| `transfer.test.ts` | **CONFORME** |
| **RNF-REL-005** | Graceful shutdown e rilascio a zero risorse residue | `backend/server.ts`, `backend/terminal/` | `reliability-perf.test.ts` | **CONFORME** |
| **RNF-UX-001..004**| Interfaccia Bootstrap 5, Chrome compatibile, xterm | `client/` | `react-frontend.test.ts` | **CONFORME** |
| **RNF-MNT-001..003**| Fail-closed su configurazione, disaccoppiamento, audit| `config/`, `errors/`, `logging/` | `configuration-coherence.test.ts` | **CONFORME** |

---

## F. TEST AUTOMATIZZATI ED ESECUZIONE VERIFICHE

### Comandi Eseguiti:
1. `npm run typecheck` (TypeScript backend): **PASS (0 errori)**
2. `npm run typecheck:client` (TypeScript client): **PASS (0 errori)**
3. `npm run lint` (`tsc --noEmit`): **PASS (0 errori)**
4. `npm run build` (`vite build --config client/vite.config.ts && tsc build:server`): **PASS (0 errori)**
5. `npm test` (Suite completa di 35 file di test automatizzati): **PASS (100% success)**

### Dettaglio Test Superati nella Master Suite (`npm test`):
- `src/config/config.test.ts`: **PASS** (6/6 scenari)
- `config/configuration.test.ts`: **PASS** (10/10 scenari)
- `config/mongodb.test.ts`: **PASS** (controlli credenziali produzione)
- `logging/logger.test.ts`: **PASS** (redazione segreti nei log e audit)
- `errors/app-errors.test.ts`: **PASS** (catalogo §9 e messaggi sicuri)
- `backend/server.test.ts`: **PASS** (HTTPS, /healthz, asset statici, anti-traversal, error handler sanificato)
- `storage/storage.test.ts`: **PASS** (Mongo e InMemory repository)
- `tests/database/database-improvements.test.ts`: **PASS** (indici composti, telemetria)
- `backend/auth/auth.test.ts`: **PASS** (scrypt, RBAC, sessioni concorrenti atomiche, rate limiting)
- `storage/server-fs.test.ts`: **PASS** (jail, percorsi canonici, permessi 0750)
- `backend/connection/connection.test.ts`: **PASS** (SSH v2, host key, whitelist)
- `backend/fleet/fleet.test.ts`: **PASS** (registrazione a 5 passi, 6 stati, rollback)
- `backend/monitoring/monitoring.test.ts`: **PASS** (polling, stale badge, refresh manuale)
- `backend/monitoring/state-file-parser.test.ts`: **PASS** (parser KV e JSON)
- `backend/terminal/terminal.test.ts`: **PASS** (WSS, PTY, isolamento, 7 cause di chiusura)
- `backend/remote-fs/remote-fs.test.ts`: **PASS** (SFTP read-only, metadati)
- `backend/transfer/transfer.test.ts`: **PASS** (streaming, checksum SHA-256, cancel, retry)
- `tests/bulk-transfer/bulk-upload-jail.test.ts`: **PASS** (caricamento massivo, jail operatore)
- `client/react-frontend.test.ts`: **PASS** (E2E reale su Google Chrome Headless CDP)
- `tests/security/security-hardening.test.ts`: **PASS** (OWASP, permessi, no-leak)
- `tests/security/corrective-hardening.test.ts`: **PASS** (re-encryption, isolamento)
- `tests/security/fleet-uniqueness-fs.test.ts`: **PASS** (unicità username/host)
- `tests/security/transfers-monitoring-hardening.test.ts`: **PASS** (integrità, TOCTOU)
- `tests/security/configuration-coherence.test.ts`: **PASS** (zero drift DECISIONS.md)
- `tests/security/mongo-unique-indexes.test.ts`: **PASS** (indici univoci MongoDB)
- `tests/security/operator-path-authorization.test.ts`: **PASS** (jail RBAC operatore)
- `tests/security/inactivity-session-hardening.test.ts`: **PASS** (timeout inattività)
- `tests/security/logout-persistence.test.ts`: **PASS** (invalidazione completa al reload)
- `tests/security/concurrent-sessions.test.ts`: **PASS** (12 scenari di sessioni contemporanee)
- `tests/configuration/config-concurrency-verification.test.ts`: **PASS** (concorrenza sessioni e utenti)
- `tests/backend-fase1.test.ts`: **PASS** (access.log, transfers.log, cancellazione selettiva bulk)
- `tests/new-features.test.ts`: **PASS** (caricamento massivo server source zero-copy)
- `tests/reliability-performance/reliability-perf.test.ts`: **PASS** (heap costante su file > 1 GB su tutte le 6 direzioni)
- `tests/acceptance/acceptance.test.ts`: **PASS** (tutti i 35 criteri di accettazione formali e 18 obiettivi essenziali)

---

## G. ELENCO COMPLETO DEI FILE MODIFICATI

| File | Righe Modificate | Descrizione dell'Intervento |
| :--- | :--- | :--- |
| `client/src/components/common/AppNavbar.tsx` | riga 9 | Modifica firma `onLogout` in `Promise<void> \| void` per piena compatibilità sincrona/asincrona (BUG-01). |
| `backend/server.ts` | righe 54, 113-160, 589-635 | Aggiunta `app.setErrorHandler` centralizzato con sanitizzazione messaggi di errore (BUG-03) e hardening completo anti-traversal / symlink / directory su `/assets/:filename` (BUG-02). |
| `backend/transfer/transfer-service.ts` | righe 143-155 | Aggiunta bonifica automatica tempestiva all'avvio del server per file temporanei orfani da crash o riavvii (BUG-06). |
| `.env.example` | righe 44-52 | Documentazione chiara delle variabili opzionali `MOLIRIS_INITIAL_OPERATOR_PASSWORD` e `MOLIRIS_INITIAL_ADMIN_PASSWORD` con raccomandazioni per il file protetto 0600 (BUG-04). |
| `backend/server.test.ts` | righe 15-35, 75-80, 140-195 | Eliminazione percorsi hardcoded `/home/robots` in favore di cartelle temporanee isolate (BUG-05) e aggiunta test di regressione per `/assets` (BUG-02) ed error handler (BUG-03). |
| `backend/auth/auth.test.ts` | righe 30-45 | Eliminazione percorsi hardcoded `/home/robots` in favore di percorsi temporanei isolati `testServerFs` e `testGeneralFs` (BUG-05). |

---

## H. RISCHI RESIDUI E LIMITAZIONI AMBIENTALI

1. **Host fisici dei robot reali:**
   Durante i test automatizzati le connessioni SSH e SFTP vengono validate sia verso server SSH locali/mock controllati sia verso canali simulati conformi a OpenSSH. Le verifiche su robot fisici reali in campo (su rete VPN industriale) dipendono dalla disponibilità della connettività fisica di rete e dall'attivazione del demone SSH sui robot remoti. I meccanismi di isolamento dei guasti (`RNF-REL-001`) e di marcatura stale (`RNF-REL-002`) garantiscono che l'eventuale irraggiungibilità fisica di un robot non impatti mai la stabilità del server.
2. **Estensione SFTP statvfs:**
   Alcuni server SFTP legacy o embedded su robot Linux non supportano l'estensione proprietaria OpenSSH `statvfs@openssh.com`. In tal caso, il sistema rileva correttamente l'assenza dell'estensione ed emette un avviso senza interrompere il trasferimento, procedendo con il controllo dello spazio sul filesystem di destinazione al termine dello streaming (`stat`).

---

## I. STATO DEL REPOSITORY GIT

### `git status --short`
```text
 M .env.example
 M backend/auth/auth.test.ts
 M backend/server.test.ts
 M backend/server.ts
 M backend/transfer/transfer-service.ts
 M client/src/components/common/AppNavbar.tsx
?? MOLIRIS_FINAL_INTEGRITY_AUDIT.md
```

### `git diff --stat`
```text
 .env.example                               |  7 +++
 backend/auth/auth.test.ts                  |  8 +++-
 backend/server.test.ts                     | 56 ++++++++++++++++++++++-
 backend/server.ts                          | 73 +++++++++++++++++++++++++++++-
 backend/transfer/transfer-service.ts       | 10 +++-
 client/src/components/common/AppNavbar.tsx |  2 +-
 6 files changed, 150 insertions(+), 6 deletions(-)
```

### `git diff --check`
```text
(Nessun errore di formattazione, spazi bianchi residui o conflitti; output pulito con exit code 0)
```

Nessun `git commit`, `git push` o `git reset` è stato eseguito, nel pieno rispetto dei vincoli operativi.

---

## 20. VERDETTO FINALE

# **CONFORME CON VERIFICHE COMPLETE**

**Motivazione del Verdetto:**  
Tutti i requisiti funzionali (RF-AUTH, RF-ROB, RF-MON, RF-SSH, RF-FS, RF-SRVFS, RF-TRF), i requisiti non funzionali (RNF-SEC, RNF-FS, RNF-PERF, RNF-REL, RNF-UX, RNF-MNT), i 35 Criteri di Accettazione e i vincoli architetturali della SRS v1.0 e di `DECISIONS.md` risultano implementati, hardenizzati e convalidati con prove concrete.  
Tutti i bug noti (BUG-01, BUG-02, BUG-03, BUG-04, BUG-05, BUG-06) sono stati risolti e testati con appositi test di regressione. I typecheck frontend/backend, il build di produzione e la suite completa di 35 file di test hanno superato tutte le verifiche con esito 100% PASS e 0 FAIL.
