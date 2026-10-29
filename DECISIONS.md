# Registro delle Decisioni Architetturali e Scelte Aperte (SRS v1.0)

Il presente registro traccia le decisioni progettuali aperte, delegate alla configurazione o in attesa di definizione conforme alle regole del progetto (§11, §§8.1, 8.2).

---

## 1. Stack Tecnologico di Progetto (Step 1)
- **Stato**: CONFERMATO
- **Decisione**:
  - Backend: Node.js (TypeScript) con Fastify, `ssh2`, WebSocket (`@fastify/websocket`) e stream nativi con backpressure.
  - Database: MongoDB (documentale, come indicato esemplificativamente in SRS §2.3, isolato dietro interfaccia repository).
  - Frontend: React con TypeScript, Vite e `@xterm/xterm` per emulazione terminale in Google Chrome (§2.5).
  - Canale di comunicazione: HTTPS e WSS verso il browser; SSH v2 e SFTP v3 verso i robot.
- **Requisiti correlati**: §2.3, §2.4 (vincoli 3-5), §2.5, RF-SSH-004, RF-TRF-004/005, RNF-PERF-001..003.

---

## 2. Modalità di Registrazione Predefinita (§8.1)
- **Stato**: CONFERMATO
- **Decisione**: Modalità Rigorosa (il robot deve essere raggiungibile e verificato via SSH prima di completare la registrazione). La modalità Differita rimane selezionabile da configurazione.
- **Requisiti correlati**: §8.1, RF-ROB-006, RF-ROB-007, RF-ROB-012, CA-ROB-003.

---

## 3. Gestione Stesso Username con Host Differenti (§8.2)
- **Stato**: APERTA
- **Decisione**: [Valore da definire: convenzione per evitare collisioni sul filesystem, es. `<username>` se univoco; `<username>_<host>` o `<username>_<robot_id>` in caso di duplicati].
- **Requisiti correlati**: §8.2, RF-ROB-006, RF-SRVFS-001, CA-ROB-006.

---

## 4. Sezione 11 – Requisiti da Definire in Fase di Progettazione

### 11.1 Organizzazione del Filesystem Server
- **Percorso assoluto della root**: APERTA. Requisiti: RF-SRVFS-001, RNF-MNT-001. Decisione: [Valore da definire].
- **Nomi e finalità delle sottodirectory standard**: APERTA. Requisiti: RF-ROB-009, RF-SRVFS-007. Decisione: [Valore da definire].
- **Permessi di accesso alle directory**: APERTA. Requisiti: RNF-FS-001, RNF-SEC-005. Decisione: [Valore da definire].
- **Politica di conservazione dei file**: APERTA. Requisiti: §10.3, RNF-MNT-001. Decisione: [Valore da definire].
- **Eventuali quote per robot o per utente**: APERTA. Requisiti: RF-TRF-014, RNF-MNT-001. Decisione: [Valore da definire].

### 11.2 Autenticazione SSH
- **Supporto esclusivo delle chiavi SSH o anche password**: APERTA. Requisiti: RF-ROB-005, RNF-SEC-002. Decisione: [Valore da definire].
- **Eventuale uso di un archivio sicuro di segreti (Vault/KMS)**: APERTA. Requisiti: RNF-SEC-002. Decisione: [Valore da definire].
- **Modalità di distribuzione e aggiornamento delle chiavi**: APERTA. Requisiti: RNF-SEC-002. Decisione: [Valore da definire].
- **Politica di verifica e aggiornamento chiavi host**: APERTA. Requisiti: RF-ROB-005, RNF-SEC-003. Decisione: [Valore da definire].
- **Eventuali restrizioni sugli account remoti**: APERTA. Requisiti: RF-SSH-008, RF-FS-007. Decisione: [Valore da definire].

### 11.3 Registrazione dei Robot
- **Obbligatorietà della verifica SSH**: APERTA (Default: Rigorosa, configurabile). Requisiti: §8.1, RF-ROB-007. Decisione: [Valore da definire].
- **Regole definitive per l'unicità dei robot**: APERTA. Requisiti: RF-ROB-006, §8.2. Decisione: [Valore da definire].
- **Politica in caso di directory già esistente**: APERTA. Requisiti: RF-ROB-009, RF-SRVFS-006, RNF-FS-004. Decisione: [Valore da definire].
- **Gestione del cambio di username**: APERTA. Requisiti: §8.3. Decisione: [Valore da definire].
- **Politica di disabilitazione e rimozione**: APERTA. Requisiti: RF-ROB-013, §8.4. Decisione: [Valore da definire].

### 11.4 File di Stato
- **Percorsi dei file di testo**: APERTA. Requisiti: RF-MON-001, RNF-MNT-001. Decisione: [Valore da definire].
- **Formato e struttura dei contenuti**: APERTA. Requisiti: RF-MON-002. Decisione: [Valore da definire].
- **Frequenza di polling**: APERTA. Requisiti: RF-MON-003, RNF-PERF-004. Decisione: [Valore da definire].
- **Regole di interpretazione degli stati**: APERTA. Requisiti: RF-MON-002, RF-MON-006. Decisione: [Valore da definire].
- **Gestione dei dati non validi o obsoleti**: APERTA. Requisiti: RF-MON-005, RNF-REL-002. Decisione: [Valore da definire].

### 11.5 Trasferimenti
- **Dimensione massima dei file, se prevista**: APERTA. Requisiti: RF-TRF-004, RNF-MNT-001. Decisione: [Valore da definire].
- **Numero massimo di trasferimenti simultanei**: APERTA. Requisiti: RF-TRF-012, RNF-PERF-003. Decisione: [Valore da definire].
- **Politica di sovrascrittura**: APERTA. Requisiti: RF-TRF-011. Decisione: [Valore da definire].
- **Politica di ripresa dei trasferimenti**: APERTA. Requisiti: RF-TRF-010. Decisione: [Valore da definire].
- **Algoritmo di checksum (SHA256, MD5)**: APERTA. Requisiti: RF-TRF-008. Decisione: [Valore da definire].
- **Durata di conservazione dei file temporanei**: APERTA. Requisiti: RF-TRF-009, RNF-REL-005. Decisione: [Valore da definire].
- **Limiti di timeout e quote di spazio**: APERTA. Requisiti: RF-TRF-013, RF-TRF-014. Decisione: [Valore da definire].

### 11.6 Utenti e Autorizzazioni
- **Ruoli definitivi**: APERTA. Requisiti: §2.2, RF-AUTH-005. Decisione: [Valore da definire].
- **Permessi per terminale, monitoraggio e trasferimenti**: APERTA. Requisiti: RF-AUTH-005, RF-SSH-008. Decisione: [Valore da definire].
- **Permessi per registrazione, modifica e rimozione robot**: APERTA. Requisiti: §2.2, §8.4. Decisione: [Valore da definire].
- **Politica di timeout e scadenza delle sessioni**: APERTA. Requisiti: RF-AUTH-006. Decisione: [Valore da definire].
- **Eventuali requisiti di autenticazione aggiuntiva (MFA)**: APERTA. Requisiti: RNF-SEC-002. Decisione: [Valore da definire].

### 11.7 Prestazioni e Capacità
- **Numero iniziale e massimo previsto di robot**: APERTA. Requisiti: RNF-PERF-005. Decisione: [Valore da definire].
- **Numero massimo di utenti simultanei**: APERTA. Requisiti: RNF-PERF-003. Decisione: [Valore da definire].
- **Numero di sessioni terminale contemporanee**: APERTA. Requisiti: RNF-PERF-003. Decisione: [Valore da definire].
- **Volume e frequenza dei trasferimenti**: APERTA. Requisiti: RNF-PERF-001/002. Decisione: [Valore da definire].
- **Requisiti di disponibilità e ripristino**: APERTA. Requisiti: RNF-REL-001/003. Decisione: [Valore da definire].
