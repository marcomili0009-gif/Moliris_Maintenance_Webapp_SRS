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

## 3. Gestione Stesso Username con Host Differenti (§8.2, §11.3)
- **Stato**: APERTA
- **Decisione**: [Valore da definire: convenzione definitiva per evitare collisioni sul filesystem quando due robot hanno lo stesso username remoto su host diversi. Implementata nel codice l'interfaccia `RobotDirectoryNamingPolicy` e l'implementazione predefinita `StandardRobotDirectoryNamingPolicy` che usa lo username con validazione di unicità sul DB per bloccare assegnazioni duplicate della stessa directory].
- **Requisiti correlati**: §8.2, §11.3, RF-ROB-006, RF-ROB-008, RF-SRVFS-001, CA-ROB-006.

---

## 4. Valori Ammessi per lo Stato di Connessione (§10.2, RF-ROB-014)
- **Stato**: APERTA (in attesa di conferma dall'utente)
- **Decisione**: [Valori modellati secondo i requisiti SRS: `non_verificato` (CA-ROB-003), `raggiungibile` (RF-ROB-001), `non_raggiungibile` (RF-ROB-001), `errore` (CA-ROB-012, RF-ROB-014), `avviso` (RF-ROB-014). Da confermare se la lista deve includere ulteriori sotto-stati].
- **Requisiti correlati**: §10.2, RF-ROB-001, RF-ROB-014, CA-ROB-003, CA-ROB-012.

---

## 5. Politica di Conservazione dei Log di Audit (§10.4, §11.1)
- **Stato**: APERTA (in attesa di conferma dall'utente)
- **Decisione**: [Valore da definire: parametro reso configurabile all'avvio fail-closed tramite `MOLIRIS_AUDIT_RETENTION_DAYS` (in giorni) senza valore predefinito inventato].
- **Requisiti correlati**: §10.4, RNF-SEC-009, RNF-MNT-001, §11.1.

---

## 6. Sezione 11 – Requisiti da Definire in Fase di Progettazione

### 11.1 Organizzazione del Filesystem Server
- **Percorso assoluto della root**: APERTA. Requisiti: RF-SRVFS-001, RNF-MNT-001. Decisione: [Valore da definire: caricato obbligatoriamente all'avvio fail-closed tramite la variabile di configurazione `MOLIRIS_FS_ROOT` senza alcun default inventato].
- **Nomi e finalità delle sottodirectory standard**: APERTA. Requisiti: RF-ROB-009, RF-SRVFS-007. Decisione: [Valore da definire: rese configurabili tramite `MOLIRIS_STANDARD_SUBDIRS` con default vuoto per non creare sottodirectory non volute].
- **Permessi di accesso alle directory**: APERTA. Requisiti: RNF-FS-001, RNF-SEC-005. Decisione: [Valore da definire: parametro reso configurabile tramite `MOLIRIS_DIR_PERMISSIONS` (es. `0750` o `0700`); in assenza si applicano i permessi predefiniti del sistema operativo Ubuntu senza forzature arbitrarie].
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
- **Politica in caso di directory già esistente**: APERTA. Requisiti: RF-ROB-009, RF-SRVFS-006, RNF-FS-004. Decisione: [Valore da definire: `ServerFilesystemService` rileva e restituisce l'esito distinto `created: false, alreadyExisted: true` senza toccare o svuotare i file preesistenti; la decisione di ammettere o rifiutare la registrazione sarà configurabile nel Prompt 6].
- **Caratteri ammessi per lo username**: APERTA. Requisiti: RF-ROB-005, RNF-SEC-005. Decisione: [Valore da definire: la SRS non prescrive un set di caratteri ristretto per lo username; la protezione del filesystem contro path traversal e injection è garantita dal validatore canonical `resolveRobotPath`].
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
- **Politica di sovrascrittura**: APERTA. Requisiti: RF-TRF-011, RNF-FS-003. Decisione: [Valore da definire: il livello filesystem server blocca di default qualsiasi sovrascrittura accidentale se non specificato `overwrite: true`].
- **Politica di ripresa dei trasferimenti**: APERTA. Requisiti: RF-TRF-010. Decisione: [Valore da definire].
- **Algoritmo di checksum (SHA256, MD5)**: APERTA. Requisiti: RF-TRF-008. Decisione: [Valore da definire].
- **Durata di conservazione dei file temporanei**: APERTA. Requisiti: RF-TRF-009, RNF-REL-005. Decisione: [Valore da definire].
- **Limiti di timeout e quote di spazio**: APERTA. Requisiti: RF-TRF-013, RF-TRF-014. Decisione: [Valore da definire].

### 11.6 Utenti e Autorizzazioni
- **Ruoli definitivi**: APERTA. Requisiti: §2.2, RF-AUTH-005. Decisione: [Valore da definire: implementate le 2 categorie logiche di §2.2 ("operatore" / Utente autorizzato e "amministratore" / Gestore flotta) con mapping configurabile `RolePermissionMapping` senza ruoli cablati rigidamente nel codice].
- **Permessi per terminale, monitoraggio e trasferimenti**: APERTA. Requisiti: RF-AUTH-005, RF-SSH-008. Decisione: [Valore da definire: modellato il catalogo tassativo dei permessi operativi previsti dalla SRS, con supporto sia a permessi globali sia a permessi associati a singoli robot (CA-SSH-005)].
- **Permessi per registrazione, modifica e rimozione robot**: APERTA. Requisiti: §2.2, §8.4. Decisione: [Valore da definire: assegnazione configurabile tramite `RolePermissionMapping` a runtime, con default assegnato al profilo amministratore].
- **Politica di timeout e scadenza delle sessioni**: APERTA. Requisiti: RF-AUTH-006. Decisione: [Valore da definire: parametro reso configurabile all'avvio fail-closed tramite `MOLIRIS_SESSION_TIMEOUT_MIN` (in minuti) senza alcun default inventato].
- **Eventuali requisiti di autenticazione aggiuntiva (MFA)**: APERTA. Requisiti: RNF-SEC-002. Decisione: [Valore da definire: MFA non implementata in quanto scelta aperta; architettura pronta ad accogliere fattori aggiuntivi].
- **Meccanismo di provisioning e gestione del ciclo di vita utenti**: APERTA. Requisiti: RF-AUTH-001, RNF-SEC-002. Decisione: [Valore da definire: la SRS non descrive interfacce né API di creazione/modifica utenti; predisposto esclusivamente lo script CLI di provisioning iniziale per sviluppo e collaudo `scripts/seed-users.ts`].

### 11.7 Prestazioni e Capacità
- **Numero iniziale e massimo previsto di robot**: APERTA. Requisiti: RNF-PERF-005. Decisione: [Valore da definire].
- **Numero massimo di utenti simultanei**: APERTA. Requisiti: RNF-PERF-003. Decisione: [Valore da definire].
- **Numero di sessioni terminale contemporanee**: APERTA. Requisiti: RNF-PERF-003. Decisione: [Valore da definire].
- **Volume e frequenza dei trasferimenti**: APERTA. Requisiti: RNF-PERF-001/002. Decisione: [Valore da definire].
- **Requisiti di disponibilità e ripristino**: APERTA. Requisiti: RNF-REL-001/003. Decisione: [Valore da definire].
