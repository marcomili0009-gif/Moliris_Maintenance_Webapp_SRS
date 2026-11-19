# 04 - CHECKLIST VERIFICA - Moliris Maintenance Webapp

Legenda: IMPLEMENTATO / PARZIALE / MANCANTE. Evidenze = file e route verificati nel codice. Audit UI-Guard, Sec-Auditor, Browser-QA in fondo, da compilare in ordine.

## A. Requisiti funzionali SRS §3

| ID | Stato | Evidenza nel codice |
|---|---|---|
| RF-AUTH-001 (login) | IMPLEMENTATO | `backend/auth/auth-routes.ts` POST `/api/auth/login` |
| RF-AUTH-002 (verifica credenziali) | IMPLEMENTATO | scrypt + salt in `backend/auth/user-models.ts` (RNF-SEC-002) |
| RF-AUTH-003 (sessione) | IMPLEMENTATO | sessione server-side; singola sessione per account con HTTP 409 (`auth-routes.ts:194-198`) |
| RF-AUTH-004 (logout) | IMPLEMENTATO | POST `/api/auth/logout` |
| RF-AUTH-005 (autorizzazioni) | IMPLEMENTATO | `backend/auth/permissions.ts`, `path-authorization.ts`; TERMINAL_OPEN riservato ad Admin |
| RF-AUTH-006 (scadenza configurabile) | IMPLEMENTATO | timeout sessione configurabile (default 30 min) in `config/configuration.ts` |
| RF-ROB-001..003 (lista/selezione/dettaglio) | IMPLEMENTATO | `backend/fleet/`, route `/api/robots/*`; UI `client/src/components/fleet/` |
| RF-ROB-004..008 (registrazione, validazione, verifica SSH, directory `<username>_<id>`, idempotenza) | IMPLEMENTATO | `backend/fleet/fleet-routes.ts`, rollback DB/FS; test `tests/security/fleet-uniqueness-fs.test.ts` |
| RF-ROB-009 (coerenza DB/FS) | IMPLEMENTATO | check coerenza + rollback in registrazione |
| RF-ROB-010..011 (esito a 6 stati, distinzione stato anagrafico) | IMPLEMENTATO | modello in `backend/fleet/`; stati distinti anagrafico/connessione/operativo |
| RF-ROB-012 (disabilita) | IMPLEMENTATO | route flotta + UI |
| RF-ROB-013 (rimozione senza cancellazione automatica) | PARZIALE | rimozione senza auto-cancellazione implementata per scelta; l'eventuale comando separato di eliminazione dati server NON è implementato (SRS §8.4 punto 2 "se implementata") -> domanda referente n.5 |
| RF-ROB-014 (distinzione stato vs connettività) | IMPLEMENTATO | campi separati nel modello robot |
| RF-MON-001 (lettura file di stato via SSH) | IMPLEMENTATO | `backend/monitoring/` + `backend/remote-fs/` |
| RF-MON-002 (parsing) | PARZIALE | parser dietro `StateFileParser` / `ProvisionalDevelopmentStateFileParser` (`STATUS_FILE_FORMAT.md` = "ESEMPIO ILLUSTRATIVO - DA CONFERMARE"); nessun enum hardcoded -> domanda referente n.1 |
| RF-MON-003 (polling configurabile) | IMPLEMENTATO | `MOLIRIS_POLLING_INTERVAL_SEC` (default 60, disabilitato se <= 0) |
| RF-MON-004 (refresh manuale) | IMPLEMENTATO | endpoint monitoring + pulsante UI |
| RF-MON-005 (assenza dato mai = stato specifico; ultimo dato valido separato) | IMPLEMENTATO | `lastValidData` separato da `lastAttemptOutcome` (per `STATUS_FILE_FORMAT.md`) |
| RF-MON-006 (visualizzazione distinta stati) | IMPLEMENTATO | UI monitoraggio con stati distinti |
| RF-SSH-001..008 (PTY WebSocket, shell completa, stream, chiusura, isolamento, errori, comandi limitati) | IMPLEMENTATO | `backend/terminal/` (ssh2 PTY + websocket in `server.ts`); TERMINAL_OPEN solo Admin; timeout `MOLIRIS_SSH_TIMEOUT_MS` |
| RF-FS-001..007 (FS remoto: navigazione, elenco metadati, down/up streaming, errori, permessi, sola lettura) | IMPLEMENTATO | `backend/remote-fs/`, route `/api/robots/:id/fs/remote/*` |
| RF-SRVFS-001..007 (FS server: root configurata, dir per robot, down/up, isolamento anti-traversal, preservazione, sottodirectory) | IMPLEMENTATO | `storage/server-fs.ts`; `MOLIRIS_FS_ROOT` (default `/var/lib/moliris/server-fs`, check permessi fail-closed in produzione), `MOLIRIS_GENERAL_FS_ROOT`; test jail `tests/bulk-transfer/bulk-upload-jail.test.ts` |
| RF-TRF-001..009 (trasferimenti computer-server, server-robot, computer-robot via backend, >1 GB streaming, avanzamento realtime, errori) | IMPLEMENTATO | `backend/transfer/transfer-routes.ts` (POST/GET Multiple), multipart streaming in `server.ts` |
| RF-TRF-010 (ripresa) | PARZIALE | ripresa implementata ma disattivata di default: `MOLIRIS_TRANSFER_RESUME_ENABLED=false` in `.env.example` -> domanda referente n.4 |
| RF-TRF-011 (sovrascrittura esplicita) | IMPLEMENTATO | pop-up conflitto + sovrascrittura su conferma (UI `BulkConflictsModal`) |
| RF-TRF-012 (limiti concorrenza) | IMPLEMENTATO | parametri config (max file simultanei per richiesta massiva) |
| RF-TRF-013 (timeout/annullamento) | IMPLEMENTATO | annullamento che preserva i completati e rimuove i parziali |
| RF-TRF-014 (controllo spazio disco) | IMPLEMENTATO | verifica spazio in `backend/transfer/` prima dell'upload |

## B. Requisiti non funzionali SRS §4

| ID | Stato | Evidenza |
|---|---|---|
| RNF-SEC-001 HTTPS | IMPLEMENTATO | infrastructuur HTTPS (DEPLOY.md); verifica runtime in Sec-Auditor |
| RNF-SEC-002 protezione credenziali | IMPLEMENTATO | scrypt password; AES-256-GCM (IV 96 bit, AAD `robotId\|keyVersion`) in `backend/connection/mongo-credential-provider.ts` |
| RNF-SEC-003 verifica host key | IMPLEMENTATO | `MOLIRIS_SSH_*` + verifica host key in connessione (`backend/connection/`) |
| RNF-SEC-004 auth lato server | IMPLEMENTATO | tutte le route dietro middleware auth |
| RNF-SEC-005 anti path-traversal | IMPLEMENTATO | `path-authorization.ts` (limite 4096, jail FS); test `operator-path-authorization.test.ts`, `bulk-upload-jail.test.ts` |
| RNF-SEC-006 validazione host | IMPLEMENTATO | validazione input robot in registrazione |
| RNF-SEC-007 isolamento sessioni | IMPLEMENTATO | sessione singola (409) + isolamento terminale |
| RNF-SEC-008 protezione temporanei | IMPLEMENTATO | area temp separata + `scripts/purge-all-temp-files.ts` |
| RNF-SEC-009 audit senza segreti | IMPLEMENTATO | log strutturato senza password/chiavi |
| RNF-FS-001..004 | IMPLEMENTATO | permessi directory root, separazione per robot, conferma operazioni distruttive (pop-up con conteggio file), idempotenza registrazione |
| RNF-PERF-001..005 | IMPLEMENTATO | streaming a memoria costante (multipart), risorse controllate, concorrenza e polling configurabili |
| RNF-REL-001..005 | IMPLEMENTATO | gestione disconnessioni SSH, distinzione dato corrente/storico, rollback, preservazione file esistenti, cleanup risorse |
| RNF-UX-001..004 | IMPLEMENTATO | React + Bootstrap 5.3.8, feedback operazioni, Chrome target, xterm.js senza plugin |
| RNF-MNT-001..003 | IMPLEMENTATO | config via env (`config/configuration.ts`, `.env.example`), componenti separati, TRACEABILITY.md |

## C. Vincoli §2.4 e requisiti aggiuntivi (sezione finale SRS)

| Voce | Stato | Evidenza |
|---|---|---|
| Credenziali solo lato server | IMPLEMENTATO | mai inviate al client |
| Browser mai con chiavi private | IMPLEMENTATO | AES-256-GCM a riposo server-side |
| HTTPS | IMPLEMENTATO | vedi RNF-SEC-001 |
| SSH/SFTP backend-robot | IMPLEMENTATO | ssh2 in `backend/connection/` |
| File > 1 GB | IMPLEMENTATO | streaming multipart |
| Directory robot = username remoto | IMPLEMENTATO | `MOLIRIS_FS_ROOT` + `<username>_<id>` |
| Isolamento accessi altri robot | IMPLEMENTATO | `path-authorization.ts` + jail |
| Sessione 30 min + avviso 5 min (4-3-2-1) | IMPLEMENTATO (valore "da verificare" nelle specifiche -> domanda n.3) | `IdleWarningModal.tsx` / `InactivityWarningModal.tsx`, default in config |
| Terminale 15 min + avviso 5 min | IMPLEMENTATO | config terminale + modale |
| Parametri config all'avvio (timeout, max utenti base 10, max terminali per robot base 1, caricamento massivo) | IMPLEMENTATO | `config/configuration.ts`, `.env.example` |
| Limite 3 GB preimpostato | PARZIALE | `MOLIRIS_MAX_FILE_SIZE_BYTES` supportato ma commentato; `.env.example` mostra 2 GB commentato -> domanda n.2 |
| Caricamento massivo senza limite prefissato + pop-up conflitto | IMPLEMENTATO | `BulkUploadModal.tsx`, `BulkConflictsModal.tsx` |
| Cliente (obbligatorio) / Impianto (opzionale) sul robot, mostrati a schermo | IMPLEMENTATO | modello robot + UI flotta |
| Barra filtri Cliente/Impianto/Robot/ID | IMPLEMENTATO | `FleetFiltersBar.tsx` |
| Palette Bootstrap, logo = Home, frontend React | IMPLEMENTATO | Bootstrap 5.3.8 in `client/package.json`; logo Home in DashboardView |
| Pop-up "Gestione File" con path selezionabile/digitabile + limitazione path operatore | IMPLEMENTATO | `FilePickerModal.tsx` + `path-authorization.ts` |
| Pop-up inattività: Conferma azzera timer / Esci = logout; sessione non termina durante trasferimento attivo | IMPLEMENTATO | `DashboardView.tsx:199` preserva trasferimenti attivi; modali inattività |
| Conferma eliminazione; per cartelle messaggio con numero file | IMPLEMENTATO | modale conferma con conteggio |
| Max 1 utente per account (HTTP 409 "sessione già avviata") | IMPLEMENTATO | `auth-routes.ts:194-198` |
| Pulsante terminale rimosso per Operatore | IMPLEMENTATO | `permissions.ts` (TERMINAL_OPEN solo Admin) + condizionale UI in `FleetTable.tsx` |
| Sezione Logs Admin: access.log (utente, livello, data/ora) + transfers.log con INIZIO/FINE CARICAMENTO MASSIVO | IMPLEMENTATO | `backend/logging/physical-file-logger.ts` (`access.log`, `transfers.log`, tag batch), `log-routes.ts`, `LogsView.tsx` |
| Annullamento massivo: completati restano, parziali rimossi, azione su blocco intero | IMPLEMENTATO | logica in `backend/transfer/` |
| MFA / auth aggiuntiva (§11.6 "eventuali") | MANCANTE | nessuna MFA nel codice -> domanda n.8 |

## D. Auth extra / sicurezza da verificare in audit

- Zero emoji nel codice: scansione regex su `client/src` trova solo simboli testuali di tipo freccia e una "x" di chiusura nel ToastHost; nessun emoji Unicode reale. UI-Guard valuta se sostituirli con testo/icone standard.
- Config: `MOLIRIS_GENERAL_FS_ROOT` default `/home/robots/general`.

## E. Audit - da compilare in ordine (risultato PASS/FAIL + note)

### E.1 UI-Guard (da eseguire per primo)
- Stato: COMPLETATO (audit ripetuto dopo correzioni D1-D3 di Dev)
- Risultato complessivo: PASS
- Note: 14 controlli rieseguiti su `client/src/` contro SRS §5 (UI) e requisiti aggiuntivi §7, dopo le correzioni D1-D3.

| # | Controllo | Risultato | Note (file:riga) |
|---|-----------|-----------|------------------|
| 1 | Barra filtri Cliente / Impianto / Robot / ID | PASS | `client/src/components/fleet/FleetFilterBar.tsx` (tutto il file): campo ricerca + select campo (tutti/cliente/impianto/nome_robot/id_robot), debounce ~250ms, reset filtri, contatore. |
| 2 | Palette Bootstrap 5.3.8 | PASS | `client/src/styles.css` variabili `--bs-*`, `client/package.json` Bootstrap 5.3.8. |
| 3 | Logo = pulsante Home (ritorno Flotta) | PASS | `client/src/components/common/AppNavbar.tsx:31-60`: `navbar-brand` con `id="app-logo-link"`, `onClick` chiama `handleGoHome` → vista "fleet". |
| 4 | Pop-up "Gestione File" path selezionabile o digitabile | PASS | `client/src/components/filesystem/FileManagementModal.tsx` (tutto il file): input percorso + bottone "Vai / Esplora", breadcrumb, verifica permessi via API. |
| 5 | Limitazione path per Operatore | PASS | `FileManagementModal.tsx` `validateSyntax` e `isPathAllowedForUser` con `allowedPaths` da `useAuth`; gate operatore in `DashboardView.tsx` (`isOperator`). |
| 6 | Pop-up conflitto sovrascrittura + annullamento senza modifiche | PASS | `client/src/components/bulk/BulkConflictsModal.tsx` (tutto il file): elenco conflitti, pulsanti "Annulla Operazione" / "Sovrascrivi Confermati"; `BulkUploadModal.tsx` pre-check conflitti. |
| 7 | Modale inattività: Conferma (azzeramento timer) / Esci (logout) | PASS | `client/src/App.tsx:60-100`: singola `<IdleWarningModal context="sessione" isOpen={isSessionWarningOpen} ... />`; `client/src/views/DashboardView.tsx:~348`: `<IdleWarningModal context="terminale" isOpen={!isSessionWarningOpen && ...} />` (priorità anti-sovrapposizione); `client/src/components/common/InactivityWarningModal.tsx` eliminato (duplicato). |
| 8 | Conferma eliminazione; cartelle → numero file | PASS | `client/src/components/common/DeleteFolderModal.tsx:60-108`: ispezione cartella, `fileCount`/`directoryCount`, messaggio con conteggio file. |
| 9 | Pulsante terminale assente per Operatore (robot + server) | PASS | `client/src/components/fleet/FleetTable.tsx:~150-170` (gate `isAdmin`); `DashboardView.tsx` `btn-server-terminal` (gate `isAdmin`). Backend `permissions.ts` TERMINAL_OPEN solo Admin. |
| 10 | Sezione Logs Admin: access.log + transfers.log con tag INIZIO/FINE CARICAMENTO MASSIVO | PASS | `client/src/views/LogsView.tsx` regex `BULK_HEADER_REGEX`/`BULK_FOOTER_REGEX` (righe ~20-70); nav Logs gated solo Admin in `AppNavbar.tsx`; backend `backend/logging/physical-file-logger.ts`. |
| 11 | Feedback operazioni (toast, banner, stati vuoto/caricamento/errore) | PASS | `DashboardView.tsx` `ToastHost` + `pushToast`; `NotificationBanner.tsx`; `FleetTable.tsx` celle vuoto/caricamento; `TransfersPanel.tsx` stato vuoto. |
| 12 | Zero AI slop (nessun testo segnaposto/lorem/funzioni inventate/componenti morti/duplicati) | PASS | `client/src/styles.css`: rimossi gradienti `linear-gradient`, animazioni `moliris-spin`/`fs-spin`/`fs-shimmer`, box-shadow pesanti hardcoded; box-shadow ora via variabili Bootstrap (`var(--bs-box-shadow)`). Nessun lorem ipsum/placeholder di testo. Nessun componente morto o duplicato. |
| 13 | Zero emoji nel codice e nelle stringhe UI | PASS | Scan regex `grep -P` su `client/src` e `docs/`: nessun emoji Unicode. `✕` (U+2715) in `ToastHost.tsx:21` e frecce `→` in `TransfersPanel.tsx`/`transfer-format.ts`/`DashboardView.tsx`: testo standard, non emoji. |
| 14 | Coerenza layout, gerarchia visiva, stati (loading/errore/vuoto) desktop e piccoli schermi | PASS | Colori hardcoded rimossi da `BulkConflictsModal.tsx` e `ConfirmDialog.tsx` (nessun colore `#` residuo). Reattività `col-*/col-md-*/col-lg-*` presente. Stati vuoto/caricamento/errore coerenti. |

## E.1 - Sintesi difetti UI (stato dopo ripetizione audit)
- **D1 (bloccante)**: risolto — unica modale `IdleWarningModal` condivisa (`App.tsx:60-100` context sessione, `DashboardView.tsx:~348` context terminale con priorità `!isSessionWarningOpen`); `InactivityWarningModal.tsx` eliminato. → **PASS**
- **D2 (AI slop)**: risolto — rimossi gradienti, ombre pesanti e animazioni custom da `client/src/styles.css`; box-shadow ora via variabili Bootstrap. → **PASS**
- **D3 (AI slop minore)**: risolto — colori hardcoded (`#b91c1c`, `#fef2f2`, `#f87171`) rimossi da `BulkConflictsModal.tsx` e `ConfirmDialog.tsx` (nessun colore `#` residuo). → **PASS**
- **D4 (annotazione, non bloccante)**: simboli testuali `✕` e `→` accettabili come testo standard, non emoji. → **PASS**
- **D5 (marginale, preesistente)**: disallineamento ruolo admin "amministratore" vs "admin" tra `DashboardView.tsx` e `AppNavbar.tsx` (non rientra nelle correzioni D1-D3, segnalato come nota). → **nota**

**Verdetto complessivo UI-Guard: PASS** (14 controlli PASS, 0 controlli FAIL). Nessun codice sorgente modificato da UI-Guard; le correzioni D1-D3 sono state applicate da @Dev e verificate staticamente. Il verdetto di PASS si riferisce alla verifica UI/UX; il typecheck client presenta un errore preesistente su `AppNavbar.tsx:132` (`onLogout("sessione")` con zero argomenti dichiarati) dovuto a lavoro concorrente fuori scope, non riguardante i controlli UI-Guard.

### E.2 Sec-Auditor (dopo UI-Guard)
- Stato: COMPLETATO
- Risultato complessivo: **FAIL**
- Perimetro: audit statico di `backend/`, `storage/`, `config/`, `src/config/`, test di sicurezza e confronto con SRS §3, §4, §5, §6, §9, §10, §11 e `docs/01-SPECIFICHE-BASE.md`.

| # | Controllo | Risultato | Evidenza e riferimenti |
|---|---|---|---|
| 1 | Autenticazione, sessioni e cookie | PASS | Sessione server-side, revoca, timeout/heartbeat, limite sessione per account, cookie `Secure; HttpOnly; SameSite=Strict` e logout in `backend/auth/auth-middleware.ts`, `backend/auth/session-manager.ts`, `backend/auth/auth-routes.ts`; test `tests/security/inactivity-session-hardening.test.ts`. |
| 2 | Autorizzazione server-side e ruoli | PASS | `requirePermission()` e controllo robot in `backend/auth/auth-middleware.ts`/`permissions.ts`; terminale Admin-only e isolamento titolarità WebSocket in `backend/terminal/terminal-routes.ts:236-255` e `terminal-service.ts:728-749`; log Admin-only in `backend/logging/log-routes.ts:47-49`. |
| 3 | Validazione input a confine frontend/backend | **FAIL** | Diverse route usano cast TypeScript senza schema runtime (`backend/fleet/fleet-routes.ts:85-92`, `backend/transfer/transfer-routes.ts:55-72,785-812`). `FleetService.validateRegistrationInput()` controlla molti valori ma non verifica in modo completo il tipo del payload né la lunghezza di `displayName` (`backend/fleet/fleet-service.ts:281-298`); un campo numerico può arrivare a `.trim()` e produrre errore 500 invece di 400. |
| 4 | Filesystem, path traversal, symlink e permessi | PASS | Normalizzazione/fail-closed ACL operatore in `backend/auth/path-authorization.ts:182-240`; jail, realpath e controlli symlink/tipi speciali in `storage/server-fs.ts`; test `security-hardening`, `operator-path-authorization`, `transfers-monitoring-hardening` e `bulk-upload-jail` superati. |
| 5 | SSH, credenziali, terminali e host key | PASS | Whitelist destinazioni obbligatoria in production (`config/configuration.ts:319-331`), host-key verification senza bypass, master key e credenziali cifrate lato server; test `security-hardening.test.ts` e `corrective-hardening.test.ts` superati. |
| 6 | Trasferimenti e accesso a log | PASS per autorizzazione/FS; FAIL per integrità audit | Permessi per target e rollback/cleanup verificati in `backend/transfer/transfer-service.ts` e nelle suite di hardening. Tuttavia i campi testuali dell’audit non sono neutralizzati: username accettato nel login (`backend/auth/auth-routes.ts:75-98`) viene interpolato direttamente nei log (`backend/logging/physical-file-logger.ts:155-172`), consentendo log injection con CR/LF. |
| 7 | Errori e informazioni esposte | **FAIL** | `/api/config/public` è anonimo (`backend/server.ts:151`) e restituisce `activeConfigPath` assoluto (`backend/server.ts:179-181`), oltre alle policy dei path: viola il principio SRS RNF-MNT-003 di non esporre dettagli tecnici non necessari. Rimuovere il path assoluto o limitarlo a un metadato non sensibile. |
| 8 | Copertura requisiti SRS | PARZIALE / non completamente verificabile | Implementazioni e test coprono auth, RBAC, terminale, filesystem e trasferimenti; restano aperti i punti già registrati in `docs/02-DOMANDE-REFERENTE.md`/SRS §11 (formato file stato, limite 3 GB, ripresa, conservazione, policy aggiuntive). La suite `npm test` si è interrotta con exit 139 durante la fase auth dopo i test di persistenza; le suite security mirate e `npm run typecheck`/`npm run build:server` sono invece PASS. |

**Difetti da inoltrare a Dev:**

- **SEC-01:** rimuovere `activeConfigPath` assoluto da `/api/config/public` e non pubblicare policy filesystem non necessarie.
- **SEC-02:** sanificare CR/LF e delimitatori nei campi audit (`username`, `filename`, `batchId`) prima della scrittura su `access.log`/`transfers.log`.
- **SEC-03:** introdurre validazione runtime condivisa (schema JSON/Zod) su tutti i body API, con rifiuto 400 per tipo/formato/lunghezza/valori non ammessi; i cast TypeScript non sono validazione backend.

**Verifiche eseguite:** `tests/security/security-hardening.test.ts`, `corrective-hardening.test.ts`, `operator-path-authorization.test.ts`, `transfers-monitoring-hardening.test.ts`, `configuration-coherence.test.ts`, `inactivity-session-hardening.test.ts` PASS; `npm run typecheck` PASS; `npm run build:server` PASS; `git diff --check` PASS. Nessun codice sorgente modificato; E.1, E.3 e le tabelle requisito sono rimaste invariate.

### E.3 Browser-QA (dopo Sec-Auditor)
- Stato: IN ATTESA
- Risultato: -
- Note: -

Obiettivo finale: 100% PASS su tutte e tre le sezioni prima del rilascio.
