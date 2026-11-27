# Moliris Maintenance Webapp (SRS v1.0)

Web Application centralizzata per la gestione operativa, il monitoraggio dello stato e la manutenzione di una flotta di robot mobili (AMR/AGV), conforme alle specifiche **SRS v1.0**.

---

## 1. Funzionalità Principali

- **Autenticazione e Sicurezza (`RNF-SEC-001..009`)**:
  - Accesso esclusivamente cifrato via **HTTPS** e **WSS** (blocco categorico HTTP in chiaro).
  - RBAC centralizzato lato server (`admin` / `operatore`) con permessi per singolo robot e jail sui percorsi autorizzati.
  - Credenziali cifrate con AES-256 (`master.key` locale `0600`) e password hashate con `scrypt` timing-safe; nessuna credenziale o chiave privata esposta al browser o nei log.
  - Verifica obbligatoria delle chiavi host SSH (`StrictHostKeyChecking`) e whitelist destinazioni SSH (`MOLIRIS_ALLOWED_DESTINATIONS`, `RNF-SEC-006`).
- **Gestione Flotta e Registrazione Robot**:
  - Registrazione in modalità rigorosa o differita con verifica connessione SSH/SFTP, allocazione della cartella dedicata sotto `MOLIRIS_FS_ROOT` e rollback automatico in caso di errore parziale.
  - Ricerca e filtro flotta per Cliente, Impianto, Nome Robot e ID Robot.
- **Monitoraggio Telemetria e Stato**:
  - Polling periodico configurabile e refresh manuale via SFTP con parser modulare (`json` / `keyvalue` / `auto`).
  - Separazione tra stato anagrafico, stato di connessione e stato operativo, con preservazione dell'ultimo stato valido (`[Non Più Verificato]`).
- **Terminale Remoto Linux PTY**:
  - Shell interattiva nel browser tramite `@xterm/xterm` su WebSocket (`/ws/terminal`), mediata esclusivamente dal backend, con chiusura automatica per inattività, disconnessione o logout.
- **Gestione File e Trasferimenti (> 1 GB)**:
  - Navigazione Archivio Generale Server, area dedicata per robot e filesystem remoto SFTP in sola lettura.
  - Trasferimenti bidirezionali e caricamento massivo in streaming a memoria costante, verifica checksum (`sha256`/`md5`) e gestione file temporanei.

---

## 2. Struttura Completa del Progetto

```text
Moliris_V1.0/
├── backend/                               # Server HTTPS/WSS Fastify e logica di dominio
│   ├── auth/                              # Autenticazione, sessioni, RBAC e jail percorsi
│   │   ├── auth-middleware.ts             # Middleware verifica sessione e permessi
│   │   ├── auth-routes.ts                 # Endpoint login, logout, stato sessione
│   │   ├── path-authorization.ts          # Controllo percorsi consentiti per ruolo Operatore
│   │   ├── permissions.ts                 # Definizioni permessi applicativi
│   │   ├── roles.ts                       # Ruoli (admin / operatore) e mapping
│   │   ├── session-manager.ts             # Gestione sessioni attive e timeout inattività
│   │   ├── user-models.ts                 # Modelli entità utente
│   │   └── user-repository.ts             # Persistenza utenti (MongoDB)
│   ├── connection/                        # Livello SSH/SFTP, host key e cifratura credenziali
│   │   ├── connection-validator.ts        # Whitelist destinazioni (RNF-SEC-006) e rate-limit
│   │   ├── connection-verifier.ts         # Verifica connessione SSH pre-registrazione
│   │   ├── credential-provider.ts         # Interfaccia provider credenziali
│   │   ├── host-key-verifier.ts           # Verifica StrictHostKeyChecking (SHA-256 / known_hosts)
│   │   ├── master-key.ts                  # Caricamento e validazione master.key AES-256 (32 byte)
│   │   ├── mongo-credential-provider.ts   # Salvataggio/lettura credenziali cifrate in MongoDB
│   │   └── robot-connection-manager.ts    # Gestione connessioni SSH/SFTP verso i robot
│   ├── fleet/                             # Gestione anagrafica e registrazione robot
│   │   ├── fleet-routes.ts                # API REST flotta (CRUD, clienti/impianti, verifica)
│   │   ├── fleet-service.ts               # Logica registrazione, modifica, disabilitazione, rollback
│   │   └── fleet-types.ts                 # Tipi e DTO di dominio flotta
│   ├── logging/                           # Log fisici di accesso e trasferimenti
│   │   ├── log-routes.ts                  # API consultazione log di audit/accesso/trasferimenti
│   │   └── physical-file-logger.ts        # Scrittura file access.log e transfers.log con rotazione
│   ├── monitoring/                        # Telemetria periodica e parser file di stato
│   │   ├── monitoring-routes.ts           # API refresh stato manuale e storico telemetria
│   │   ├── monitoring-service.ts          # Polling periodico e marcatura [Non Più Verificato]
│   │   ├── robot-reader.ts                # Lettura file di stato remoto via SFTP
│   │   └── state-file-parser.ts           # Parser modulare (auto / json / keyvalue)
│   ├── remote-fs/                         # Navigazione filesystem remoto SFTP (sola lettura)
│   │   ├── remote-fs-models.ts            # Modelli voci filesystem remoto
│   │   ├── remote-fs-routes.ts            # API navigazione filesystem robot
│   │   └── remote-fs-service.ts           # Servizio listing SFTP sicuro
│   ├── terminal/                          # Terminale remoto Linux PTY su WebSocket
│   │   ├── terminal-limits.ts             # Limiti concorrenza sessioni PTY
│   │   ├── terminal-models.ts             # Modelli sessioni terminale
│   │   ├── terminal-routes.ts             # Endpoint WebSocket /ws/terminal
│   │   └── terminal-service.ts            # Gestione PTY, resize, watchdog e chiusura ordinata
│   ├── transfer/                          # Motore trasferimenti streaming (> 1 GB) e bulk upload
│   │   ├── batch-transfer-manager.ts      # Coordinamento lotti massivi multi-target
│   │   ├── bulk-transfer-models.ts        # Modelli e conflitti caricamento massivo
│   │   ├── checksum-service.ts            # Calcolo e verifica integrità SHA-256 / MD5
│   │   ├── transfer-models.ts             # Modelli trasferimenti (6 direzioni)
│   │   ├── transfer-progress.ts           # Tracking avanzamento in tempo reale
│   │   ├── transfer-routes.ts             # API upload/download/trasferimenti/preflight
│   │   └── transfer-service.ts            # Streaming a memoria costante e gestione file .tmp
│   ├── validation/                        # Validazione input HTTP con Zod
│   │   ├── request-schemas.ts             # Schemi Zod per body e query
│   │   └── request-validation.ts          # Helper validazione centralizzata
│   ├── server-fs-routes.ts                # API Archivio Generale Server e cartelle robot
│   ├── server.ts                          # Entry point server HTTPS Fastify + WebSocket
│   └── README.md                          # Note interne modulo backend
│
├── client/                                # Frontend SPA React 19 + Vite + Bootstrap 5
│   ├── index.html                         # Entry HTML applicazione
│   ├── tsconfig.json                      # Configurazione TypeScript client
│   ├── vite.config.ts                     # Configurazione Vite (build in dist/frontend)
│   └── src/
│       ├── main.tsx                       # Bootstrap React
│       ├── App.tsx                        # Router principale e stato globale sessione
│       ├── styles.css                     # Stili applicativi e temi Bootstrap 5
│       ├── vite-env.d.ts                  # Tipizzazioni ambiente Vite
│       ├── assets/
│       │   └── Moliris_white.png          # Logo Moliris navbar
│       ├── views/                         # Viste principali
│       │   ├── LoginView.tsx              # Schermata autenticazione
│       │   ├── DashboardView.tsx          # Dashboard flotta e gestione operativa
│       │   └── LogsView.tsx               # Consultazione log accessi e trasferimenti
│       ├── components/
│       │   ├── fleet/                     # Flotta: FleetTable, FleetFilterBar, RobotRegisterModal,
│       │   │                              # RobotEditModal, RobotDetailModal, RegistrationOutcomeModal
│       │   ├── filesystem/                # File & Trasferimenti: FileManagementModal, GeneralFsPanel,
│       │   │                              # ServerFsPanel, RemoteFsPanel, TransfersPanel, FsTable,
│       │   │                              # FsBrowserSection, FsBreadcrumb, FsTabBar
│       │   ├── bulk/                      # Caricamento massivo: BulkUploadModal, BulkConflictsModal
│       │   ├── terminal/                  # Terminale PTY: TerminalModal (@xterm/xterm)
│       │   └── common/                    # UI condivisa: AppNavbar, Modal, ConfirmDialog, ErrorModal,
│       │                                  # IdleWarningModal, FolderPickerModal, NewFolderModal,
│       │                                  # DeleteFolderModal, DoubleSubmitButton, RobotCombobox,
│       │                                  # StatusBadge, NotificationBanner, ToastHost
│       ├── hooks/                         # Custom React hooks (useAuth, useFleet, useFilesystem,
│       │                                  # useTerminal, useTransfers)
│       ├── services/                      # api-client.ts, error-presenter.ts, state-formatter.ts
│       ├── types/                         # Definizioni TypeScript (auth, error, filesystem, fleet,
│       │                                  # monitoring, transfer)
│       └── utils/                         # download.ts, filterRobots.ts, transfer-format.ts
│
├── config/                                # Configurazione operativa e connessione DB
│   ├── config.json                        # Parametri applicativi attivi (timeout, limiti, jail)
│   ├── configuration.ts                   # Validazione fail-closed variabili d'ambiente (.env)
│   └── mongodb.ts                         # Client MongoDB e controllo credenziali in produzione
│
├── src/                                   # Loader configurazione applicativa
│   └── config/
│       ├── index.ts                       # Caricamento e merge config.json / env
│       └── schema.ts                      # Schema validazione config.json
│
├── storage/                               # Layer persistenza MongoDB e filesystem server
│   ├── audit-models.ts                    # Modelli eventi di audit
│   ├── audit-repository.ts                # Repository audit_events e pending_robot_removals
│   ├── client-plant-models.ts             # Modelli clienti e impianti
│   ├── client-plant-repository.ts         # Repository clients / plants
│   ├── robot-models.ts                    # Modelli entità robot e stati
│   ├── robot-repository.ts                # Repository robots con indici univoci
│   ├── telemetry-repository.ts            # Storico telemetria robot_telemetry_history
│   ├── server-fs.ts                       # Gestione, isolamento e listing MOLIRIS_FS_ROOT
│   ├── dto/
│   │   └── robot-dto.ts                   # DTO robot privi di credenziali
│   └── README.md                          # Note interne modulo storage
│
├── errors/
│   └── app-errors.ts                      # Catalogo errori formale (§9) e codici HTTP
│
├── logging/
│   └── logger.ts                          # Logger JSON strutturato con redazione segreti
│
├── scripts/                               # Script operativi e migrazioni (vedi sezione 4)
│   ├── audit-robot-directories.ts
│   ├── cleanup-robot-orphans.ts
│   ├── migrate-database-improvements.ts
│   ├── migrate-operator-paths.ts
│   ├── migrate-robot-directories.ts
│   ├── purge-all-temp-files.sh
│   ├── purge-all-temp-files.ts
│   ├── reencrypt-credentials.ts
│   ├── reset-admin-password.ts
│   └── seed-users.ts
│
├── .env.example                           # Template completo variabili d'ambiente
├── config.example.json                    # Template di riferimento per config/config.json
├── moliris.service                        # Unit file systemd per produzione
├── DEPLOY.md                              # Guida installazione, deploy e migrazione server
├── README.md                              # Panoramica progetto e guida rapida
├── package.json                           # Dipendenze e script npm
├── package-lock.json                      # Lockfile deterministico dipendenze
├── tsconfig.json                          # Configurazione compilatore TypeScript backend
├── .gitignore                             # Regole esclusione Git
└── .gitattributes                         # Normalizzazione fine riga LF
```

---

## 3. Prerequisiti, Build e Avvio

### Prerequisiti
- **Linux x86_64** (es. Ubuntu 24.04 / 26.04 LTS)
- **Node.js** ≥ 20 (consigliato v24 LTS) e `npm`
- **MongoDB** v6.0+ / v7.0+ raggiungibile tramite `MOLIRIS_MONGODB_URI`
- **Certificati TLS** (`MOLIRIS_TLS_CERT_PATH`, `MOLIRIS_TLS_KEY_PATH`) e **master key AES-256** da 32 byte raw (`MOLIRIS_MASTER_KEY_FILE`, permessi `0600`)

### Compilazione e avvio in produzione
```bash
# 1. Prepara .env (o /etc/moliris/moliris.env in produzione con systemd)
cp .env.example .env
chmod 600 .env

# 2. Installazione pulita, build frontend + backend e rimozione devDependencies
npm ci && npm run build && npm prune --omit=dev

# 3. Avvio del server compilato
npm start
```

> Per l'installazione completa su server di produzione (utente dedicato `moliris`, autenticazione MongoDB, certificati TLS, `master.key`, `systemd` con `moliris.service` e verifica `/healthz`), segui **[DEPLOY.md](./DEPLOY.md)**.

### Avvio in sviluppo locale
```bash
npm ci
npm run dev
```

---

## 4. Script Operativi (`scripts/`)

> Nota: gli script TypeScript in `scripts/` possono essere eseguiti con `npx tsx scripts/<nome>.ts` (prima di `npm prune --omit=dev`) oppure nella versione compilata con `node --import dotenv/config dist/scripts/<nome>.js`.

| Script | Scopo |
|---|---|
| `scripts/seed-users.ts` | Provisioning sicuro degli account iniziali (`admin`, `operatore`, consigliato `--password-file`). |
| `scripts/reset-admin-password.ts` | Reimpostazione della password dell'account amministratore. |
| `scripts/reencrypt-credentials.ts` | Ricifratura delle credenziali robot in MongoDB in caso di rotazione/cambio `master.key`. |
| `scripts/migrate-robot-directories.ts` | Riallineamento di `serverDirectoryPath` e creazione cartelle robot su un nuovo `MOLIRIS_FS_ROOT` (`--dry-run` / `--apply`). |
| `scripts/audit-robot-directories.ts` | Verifica coerenza tra anagrafica robot in MongoDB e directory su disco. |
| `scripts/cleanup-robot-orphans.ts` | Pulizia controllata di eventuali record/cartelle orfane. |
| `scripts/purge-all-temp-files.ts` / `.sh` | Rimozione file temporanei residui di trasferimento. |
| `scripts/migrate-database-improvements.ts` | Migrazione indici e miglioramenti schema MongoDB. |
| `scripts/migrate-operator-paths.ts` | Migrazione dei percorsi consentiti per gli account operatore. |

---

## 5. Checklist Post-Migrazione su Nuovo Server

Quando sposti l'applicazione e ripristini il database su un nuovo server:
1. **Master key**: copia la `master.key` in `/etc/moliris/keys/master.key` (o percorso in `MOLIRIS_MASTER_KEY_FILE`, permessi `0600`), oppure rigenerala (`openssl rand 32 > master.key && chmod 600 master.key`) e aggiorna le credenziali robot (`reencrypt-credentials.ts` o dall'interfaccia).
2. **Allineamento directory robot (dopo `mongorestore`)**:
   ```bash
   npx tsx scripts/migrate-robot-directories.ts --dry-run
   npx tsx scripts/migrate-robot-directories.ts --apply
   ```
3. **Whitelist destinazioni SSH (`.env`)**: imposta `MOLIRIS_ALLOWED_DESTINATIONS` con gli IP/hostname reali dei robot separati da virgola (es. `192.168.32.50,192.168.32.51`).
4. **MongoDB (`.env`)**: aggiorna `MOLIRIS_MONGODB_URI` con le credenziali e il database del nuovo server.

---

## 6. Funzionalità Intenzionalmente Escluse per Conformità SRS

In stretta aderenza alla regola cardine di non inventare funzionalità o comportamenti non previsti dalla specifica **SRS v1.0**, i seguenti punti sono stati intenzionalmente esclusi o isolati:

1. **Eliminazione fisica dei dati sul server alla rimozione del robot (`FS_SERVER_DELETE`)**:
   - *Motivazione*: L'SRS §8.4 punto 2 recita testualmente *"se implementata"*. L'eliminazione automatica dei dati sul server è lasciata non implementata per prevenire cancellazioni irreversibili di cartelle storiche di log e configurazioni della flotta. La preservazione assoluta dei dati preesistenti è garantita da RNF-FS-003 e verificata dal criterio CA-ROB-011.
2. **Modifica o cancellazione di file sul filesystem remoto del robot**:
   - *Motivazione*: La specifica SRS §5.5 e RF-FS-007 prescrivono un livello di navigazione remota SFTP rigorosamente in **sola lettura**. Non sono previste nella SRS v1.0 API o funzionalità di scrittura, modifica o cancellazione di file sul robot.
3. **Macchina a stati o enum rigidi per lo stato operativo del robot**:
   - *Motivazione*: La SRS non definisce un insieme chiuso di stati operativi o transizioni di stato del firmware robot. I contenuti estratti dal file di stato vengono trattati come record opaco (`Record<string, unknown>`) dal parser isolato `StateFileParser`, evitando deduzioni arbitrarie (RF-MON-002, RF-MON-005).
4. **Allarmi sonori o feedback acustici**:
   - *Motivazione*: Il §2.5 cita l'altoparlante nella configurazione minima del client utente, ma la specifica SRS v1.0 non richiede alcuna emissione acustica né feedback sonoro. Nessun audio è stato inserito.
5. **Autenticazione a più fattori (MFA)**:
   - *Motivazione*: Lasciata come scelta aperta in §11.6, non descritta nei requisiti funzionali della SRS v1.0. L'architettura modulare di autenticazione è predisposta per accogliere provider MFA futuri.
6. **Condivisione e supervisione delle sessioni terminale (RF-SSH-006)**:
   - *Motivazione*: La SRS prescrive il divieto di accedere alla sessione di un altro utente senza esplicita autorizzazione, senza però definire le modalità di delega o supervisione. È adottata la politica prudente fail-closed `DefaultDenyTerminalSessionSharingPolicy` che nega categoricamente ogni accesso cross-sessione.

---

## 7. Indice della Documentazione di Progetto

- **[TRACEABILITY.md](TRACEABILITY.md)**: Matrice completa di tracciabilità Requisito → Modulo → Test per tutti i requisiti RF, RNF e vincoli §2.4.
- **[COLLAUDO.md](COLLAUDO.md)**: Verbale ufficiale di collaudo con esito dei 35 criteri §7, 18 obiettivi §12 e misurazioni di memoria heap reale.
- **[DEPLOY.md](DEPLOY.md)**: Guida operativa di installazione in produzione su Ubuntu 26.04 con servizio systemd (`moliris.service`).
- **[DECISIONS.md](DECISIONS.md)**: Registro delle decisioni architetturali e dei punti aperti della Sezione 11 (isolati e configurabili).
- **[DIAGNOSTICS.md](DIAGNOSTICS.md)**: Manuale di diagnostica, logging, audit trail e catalogo errori §9 (recuperabili vs intervento amministrativo).
- **[Aggiornamento manuale NEANTE](docs/NEANTE-MANUAL-UPDATE.md)**: verifica del runtime, attivazione manuale e rollback.
- **[Backup e ripristino](docs/BACKUP-RESTORE.md)**: acquisizione coordinata e verifica isolata dei dati.
- **[STATUS_FILE_FORMAT.md](STATUS_FILE_FORMAT.md)**: Specifiche del formato dei file di stato (Key-Value e JSON) e regole di interpretazione.
- **[ARCHITECTURE.md](ARCHITECTURE.md)**: Dettaglio dell'architettura a moduli disaccoppiati e flussi di comunicazione.
