# Moliris Maintenance Webapp (SRS v1.0)

Web Application centralizzata per la gestione operativa, il monitoraggio dello stato e la manutenzione di una flotta di robot mobili (AMR/AGV), conforme alle specifiche dei requisiti software **SRS v1.0**.

---

## 1. Caratteristiche Principali

- **Autenticazione e Sicurezza Rigorosa (§2.4, §3.1, RNF-SEC-001..009)**:
  - Accesso esclusivamente cifrato tramite **HTTPS** e **WSS** (rifiuto categorico HTTP in chiaro).
  - RBAC centralizzato lato server con permessi valutabili globalmente e per singolo robot.
  - Hashing credenziali `scrypt` con confronto timing-safe anti-timing attack.
  - **Zero credenziali o chiavi private esposte al browser**: gestione confinata al backend e redazione totale nei log.
  - Verifica obbligatoria delle chiavi host SSH (`StrictHostKeyChecking`) e blocco attacchi man-in-the-middle.
  - Protezione totale contro Path Traversal su tutti i percorsi server e remoti.

- **Gestione della Flotta e Registrazione Idempotente (§3.2, §8.1..8.4)**:
  - Registrazione con verifica di connessione SSH a 5 passi (modalità rigorosa e differita).
  - Creazione automatica o riutilizzo idempotente della cartella dedicata `/var/lib/moliris/server-fs/<username>`.
  - Rollback automatico a zero perdite dati in caso di guasto parziale durante la registrazione.
  - Supporto per dispositivi eterogenei senza modifiche al codice sorgente.

- **Monitoraggio dello Stato della Flotta (§3.3, §10.2, §11.4)**:
  - Acquisizione periodica (polling configurabile) o manuale on-demand dei file di stato via SFTP/SSH.
  - Parser polimorfico sostituibile (Key-Value e JSON) isolato dietro interfaccia `StateFileParser`.
  - **Separazione categorica dei 3 stati**: stato anagrafico, stato di connessione e stato operativo interpretato.
  - Preservazione assoluta dell'ultimo stato valido acquisito in caso di offline e marcatura `[Non più verificato]`.

- **Terminale Remoto Linux PTY (§3.4, §5.4, §6.4)**:
  - Shell Linux interattiva completa nel browser tramite `@xterm/xterm` su WebSocket (`/ws/terminal`).
  - Il browser non apre alcuna connessione SSH diretta verso i dispositivi della flotta.
  - Chiusura ordinata e rilascio a zero risorse residue per tutte le cause (inattività, disconnessione, logout, stop servizio).

- **Navigazione Filesystem e Trasferimento File > 1 GB (§3.5..3.7, §5.5..5.7, §§6.5..6.7)**:
  - Navigazione filesystem remoto via SFTP in rigorosa sola lettura.
  - Trasferimenti bidirezionali a 6 direzioni (Computer ↔ Server, Server ↔ Robot, Computer ↔ Robot).
  - **Streaming a memoria RAM costante (Heap delta < 3 MB) su file superiori a 1 GB** con contropressione nativa dei flussi Node.js.
  - Avanzamento in tempo reale, verifica integrità opzionale (SHA-256/MD5) e file temporanei protetti.

---

## 2. Architettura e Struttura della Codebase

```
Moliris_Maintenance_Webapp_SRS/
├── backend/
│   ├── auth/              # Autenticazione, sessioni utente, RBAC e utenti iniziali
│   ├── connection/        # Livello comune SSH/SFTP, credenziali e verifica chiavi host
│   ├── fleet/             # Gestione flotta, registrazione, anagrafica e controlli
│   ├── monitoring/        # Monitoraggio telemetria, reader SFTP e parser di stato
│   ├── terminal/          # Terminale remoto interattivo PTY e gestione canali WebSocket
│   ├── remote-fs/         # Navigazione filesystem remoto SFTP in sola lettura
│   ├── transfer/          # Motore di trasferimento file in streaming (6 direzioni, >1 GB)
│   ├── server-fs-routes.ts# Endpoint navigazione e download filesystem server
│   └── server.ts          # Server HTTPS Fastify centrale e configurazione WebSocket
├── storage/
│   ├── robot-models.ts    # Modelli entità robot e definizioni stati distinti
│   ├── robot-repository.ts# Repository robot (in-memory e MongoDB) con indici unicità
│   ├── audit-repository.ts# Registro immutabile di audit con politica di conservazione
│   ├── server-fs.ts       # Servizio di allocazione, isolamento e navigazione server-fs
│   └── dto/robot-dto.ts   # Data Transfer Object rigorosamente privi di credenziali
├── frontend/
│   ├── index.html         # Interfaccia grafica HTML5 conforme a Google Chrome (§2.5)
│   ├── styles.css         # Stile visuale accessibile con distinzione semantica degli stati
│   ├── api-client.js      # Client API REST e WSS con gestione credenziali di sessione
│   ├── error-presenter.js # Traduzione centralizzata errori sicuri conformi a SRS §9
│   ├── state-formatter.js # Formattazione e separazione rigorosa dei 3 stati
│   ├── double-submit.js   # Protezione da doppi click concorrenti
│   └── app.js             # Controller applicativo e integrazione terminale xterm.js
├── config/                # Validazione configurazione fail-closed e variabili d'ambiente
├── errors/                # Modello formale errori §9 e classificazione severità
├── logging/               # Logger strutturato JSON con redazione automatica segreti
├── scripts/               # Script di provisioning utenti iniziali (seed-users.ts)
└── tests/
    ├── security/          # Suite di verifica hardening di sicurezza (RNF-SEC-001..009)
    ├── reliability-performance/ # Suite affidabilità, riavvio e heap >1 GB su tutte le 6 direzioni
    └── acceptance/        # Master suite di collaudo dei 35 Criteri §7 e 18 Obiettivi §12
```

---

## 3. Prerequisiti e Avvio Rapido

### Prerequisiti di Sistema
- **Sistema Operativo**: Ubuntu 26.04 LTS (o compatibile Linux x86_64).
- **Node.js**: v24.x LTS (eseguibile con `node --experimental-strip-types`).
- **MongoDB**: v6.0+ o v7.0+ attivo sulla porta 27017.
- **Browser**: Google Chrome (ultima versione stabile, §2.5).

### Installazione Dipendenze
```bash
npm install
```

### Configurazione d'Ambiente
Copiare il file di template `.env.example` in `.env` e impostare i percorsi:
```bash
cp .env.example .env
```

### Provisioning Utenti di Test
```bash
node --experimental-strip-types scripts/seed-users.ts
```

### Avvio in Sviluppo
```bash
npm run dev
```
L'applicazione è raggiungibile su `https://127.0.0.1:8443`.

---

## 4. Esecuzione dei Test Automatizzati

Il sistema include test completi end-to-end con esecuzione a zero configurazione:
```bash
npm test
```

La suite esegue sequenzialmente:
1. `config/configuration.test.ts`: validazione fail-closed configurazione.
2. `logging/logger.test.ts`: redazione automatica password e chiavi private.
3. `errors/app-errors.test.ts`: conformità catalogo errori §9 e messaggi opachi.
4. `backend/server.test.ts`: server HTTPS e blocco certificati mancanti.
5. `storage/storage.test.ts`: persistenza InMemory e Live MongoDB, sicurezza DTO.
6. `backend/auth/auth.test.ts`: login, logout, RBAC per robot e scadenza sessione.
7. `storage/server-fs.test.ts`: isolamento cartelle, idempotenza e rollback selettivo.
8. `backend/connection/connection.test.ts`: connessione SSH/SFTP, host key e whitelist.
9. `backend/fleet/fleet.test.ts`: anagrafica flotta, 6 esiti registrazione e disabilitazione.
10. `backend/monitoring/monitoring.test.ts`: polling periodico, refresh manuale e stale data.
11. `backend/terminal/terminal.test.ts`: shell PTY, WebSocket, resize e 7 cause chiusura.
12. `backend/remote-fs/remote-fs.test.ts`: navigazione remota SFTP e sola lettura.
13. `backend/transfer/transfer.test.ts`: trasferimenti 6 direzioni, integrità e timeout.
14. `frontend/frontend.test.ts`: test E2E su Google Chrome Headless via CDP.
15. `tests/security/security-hardening.test.ts`: verifica hardening (RNF-SEC-001..009).
16. `tests/reliability-performance/reliability-perf.test.ts`: misurazione reale heap > 1 GB su 6 direzioni, riavvio a zero perdite e multi-device.
17. `tests/acceptance/acceptance.test.ts`: collaudo formale dei 35 Criteri §7 e 18 Obiettivi §12.

---

## 5. Indice della Documentazione di Progetto

- **[TRACEABILITY.md](file:///home/mmilitello/Scrivania/Moliris_Maintenance_Webapp_SRS/TRACEABILITY.md)**: Matrice completa di tracciabilità Requisito → Modulo → Test per tutti i requisiti RF, RNF e vincoli §2.4.
- **[COLLAUDO.md](file:///home/mmilitello/Scrivania/Moliris_Maintenance_Webapp_SRS/COLLAUDO.md)**: Verbale ufficiale di collaudo con esito dei 35 criteri §7, 18 obiettivi §12 e misurazioni di memoria heap reale.
- **[DEPLOY.md](file:///home/mmilitello/Scrivania/Moliris_Maintenance_Webapp_SRS/DEPLOY.md)**: Guida operativa di installazione in produzione su Ubuntu 26.04 con servizio systemd (`moliris.service`).
- **[DECISIONS.md](file:///home/mmilitello/Scrivania/Moliris_Maintenance_Webapp_SRS/DECISIONS.md)**: Registro delle decisioni architetturali e dei punti aperti della Sezione 11 (isolati e configurabili).
- **[DIAGNOSTICS.md](file:///home/mmilitello/Scrivania/Moliris_Maintenance_Webapp_SRS/DIAGNOSTICS.md)**: Manuale di diagnostica, logging, audit trail e catalogo errori §9 (recuperabili vs intervento amministrativo).
- **[STATUS_FILE_FORMAT.md](file:///home/mmilitello/Scrivania/Moliris_Maintenance_Webapp_SRS/STATUS_FILE_FORMAT.md)**: Specifiche del formato dei file di stato (Key-Value e JSON) e regole di interpretazione.
- **[ARCHITECTURE.md](file:///home/mmilitello/Scrivania/Moliris_Maintenance_Webapp_SRS/ARCHITECTURE.md)**: Dettaglio dell'architettura a moduli disaccoppiati e flussi di comunicazione.
