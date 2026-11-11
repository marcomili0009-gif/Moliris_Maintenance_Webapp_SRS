# Matrice di Tracciabilità dei Requisiti (SRS v1.0)

La presente matrice collega ciascun requisito formale (funzionale, non funzionale e vincolo architetturale) di **Moliris Maintenance Webapp (SRS v1.0)** al relativo modulo sorgente di implementazione, alla suite di test automatizzati di verifica e allo stato di conformità.

---

## 1. Requisiti Funzionali (RF)

### 1.1 Autenticazione e Accesso (§3.1)
| ID Requisito | Descrizione Sintetica | Modulo Implementazione | Suite di Test Automatizzati | Stato |
| :--- | :--- | :--- | :--- | :--- |
| **RF-AUTH-001** | Login con username e password | `backend/auth/auth-routes.ts`<br>`backend/auth/user-repository.ts`<br>`scripts/seed-users.ts` | `backend/auth/auth.test.ts`<br>`tests/acceptance/acceptance.test.ts`<br>`tests/security/corrective-hardening.test.ts` | **Soddisfatto** |
| **RF-AUTH-002** | Verifica credenziali (hashing scrypt timing-safe) | `backend/auth/user-models.ts`<br>`backend/auth/auth-routes.ts` | `backend/auth/auth.test.ts`<br>`tests/acceptance/acceptance.test.ts` | **Soddisfatto** |
| **RF-AUTH-003** | Gestione della sessione e rifiuto anonimi | `backend/auth/session-manager.ts`<br>`backend/auth/auth-middleware.ts` | `backend/auth/auth.test.ts`<br>`tests/security/security-hardening.test.ts` | **Soddisfatto** |
| **RF-AUTH-004** | Logout e invalidazione immediata sessione | `backend/auth/auth-routes.ts`<br>`backend/auth/session-manager.ts` | `backend/auth/auth.test.ts`<br>`tests/acceptance/acceptance.test.ts` | **Soddisfatto** |
| **RF-AUTH-005** | Autorizzazioni RBAC per operazione e per robot | `backend/auth/permissions.ts`<br>`backend/auth/session-manager.ts` | `backend/auth/auth.test.ts`<br>`tests/security/security-hardening.test.ts` | **Soddisfatto** |
| **RF-AUTH-006** | Scadenza configurabile della sessione per inattività | `backend/auth/session-manager.ts`<br>`config/configuration.ts` | `backend/auth/auth.test.ts`<br>`tests/acceptance/acceptance.test.ts`<br>`tests/security/corrective-hardening.test.ts` | **Soddisfatto** |

### 1.2 Gestione della Flotta dei Robot (§3.2, §§8.1-8.4, §10.1-10.2)
| ID Requisito | Descrizione Sintetica | Modulo Implementazione | Suite di Test Automatizzati | Stato |
| :--- | :--- | :--- | :--- | :--- |
| **RF-ROB-001** | Elenco flotta con anagrafica e stati distinti | `backend/fleet/fleet-service.ts`<br>`backend/fleet/fleet-routes.ts` | `backend/fleet/fleet.test.ts`<br>`tests/acceptance/acceptance.test.ts` | **Soddisfatto** |
| **RF-ROB-002** | Dettaglio singolo robot con azioni permesse | `backend/fleet/fleet-service.ts`<br>`storage/dto/robot-dto.ts` | `backend/fleet/fleet.test.ts`<br>`tests/acceptance/acceptance.test.ts` | **Soddisfatto** |
| **RF-ROB-003** | Registrazione nuovo robot da utenti autorizzati | `backend/fleet/fleet-service.ts`<br>`backend/fleet/fleet-routes.ts` | `backend/fleet/fleet.test.ts`<br>`tests/acceptance/acceptance.test.ts` | **Soddisfatto** |
| **RF-ROB-004** | Parametri descrittivi obbligatori (ID, display name) | `backend/fleet/fleet-service.ts`<br>`storage/robot-models.ts` | `backend/fleet/fleet.test.ts`<br>`tests/acceptance/acceptance.test.ts` | **Soddisfatto** |
| **RF-ROB-005** | Parametri di connessione e verifica host key | `backend/fleet/fleet-service.ts`<br>`backend/connection/connection-validator.ts`<br>`backend/connection/mongo-credential-provider.ts` | `backend/connection/connection.test.ts`<br>`tests/security/security-hardening.test.ts`<br>`tests/security/corrective-hardening.test.ts` | **Soddisfatto** |
| **RF-ROB-006** | Validazione cumulativa dati e vincoli unicità | `backend/fleet/fleet-service.ts`<br>`storage/robot-repository.ts`<br>`storage/robot-models.ts` | `backend/fleet/fleet.test.ts`<br>`storage/storage.test.ts`<br>`tests/security/fleet-uniqueness-fs.test.ts`<br>`tests/acceptance/acceptance.test.ts` | **Soddisfatto** |
| **RF-ROB-007** | Verifica SSH durante la registrazione (5 passi) | `backend/fleet/fleet-service.ts`<br>`backend/connection/robot-connection-manager.ts` | `backend/connection/connection.test.ts`<br>`backend/fleet/fleet.test.ts` | **Soddisfatto** |
| **RF-ROB-008** | Creazione directory associata allo username (<username>_<id>) | `backend/fleet/fleet-service.ts`<br>`storage/server-fs.ts`<br>`storage/robot-models.ts` | `storage/server-fs.test.ts`<br>`tests/security/fleet-uniqueness-fs.test.ts`<br>`tests/acceptance/acceptance.test.ts` | **Soddisfatto** |
| **RF-ROB-009** | Sottodirectory standard configurabili e non cancellazione | `backend/fleet/fleet-service.ts`<br>`storage/server-fs.ts` | `storage/server-fs.test.ts`<br>`tests/security/fleet-uniqueness-fs.test.ts`<br>`tests/acceptance/acceptance.test.ts` | **Soddisfatto** |
| **RF-ROB-010** | Tracciamento atomico o recovery coerente (protocollo 2 fasi) | `backend/fleet/fleet-service.ts`<br>`storage/server-fs.ts`<br>`storage/robot-repository.ts` | `backend/fleet/fleet.test.ts`<br>`tests/security/fleet-uniqueness-fs.test.ts`<br>`tests/acceptance/acceptance.test.ts` | **Soddisfatto** |
| **RF-ROB-011** | Esito registrazione e disponibilità funzionalità | `backend/fleet/fleet-service.ts`<br>`storage/dto/robot-dto.ts` | `backend/fleet/fleet.test.ts`<br>`tests/security/fleet-uniqueness-fs.test.ts`<br>`tests/acceptance/acceptance.test.ts` | **Soddisfatto** |
| **RF-ROB-012** | Distinzione esiti registrazione (6 stati formali) | `backend/fleet/fleet-service.ts`<br>`storage/robot-models.ts` | `backend/fleet/fleet.test.ts`<br>`tests/security/fleet-uniqueness-fs.test.ts`<br>`tests/acceptance/acceptance.test.ts` | **Soddisfatto** |
| **RF-ROB-013** | Disabilitazione e rimozione con salvaguardia dati | `backend/fleet/fleet-service.ts`<br>`backend/fleet/fleet-routes.ts` | `backend/fleet/fleet.test.ts`<br>`tests/security/fleet-uniqueness-fs.test.ts`<br>`tests/acceptance/acceptance.test.ts` | **Soddisfatto** |
| **RF-ROB-014** | Tracciamento separato stato anagrafico e connessione | `storage/robot-models.ts`<br>`storage/dto/robot-dto.ts` | `storage/storage.test.ts`<br>`tests/acceptance/acceptance.test.ts` | **Soddisfatto** |

### 1.3 Monitoraggio dello Stato dei Robot (§3.3, §10.2)
| ID Requisito | Descrizione Sintetica | Modulo Implementazione | Suite di Test Automatizzati | Stato |
| :--- | :--- | :--- | :--- | :--- |
| **RF-MON-001** | Lettura remota file di stato via SFTP/SSH | `backend/monitoring/robot-reader.ts`<br>`backend/monitoring/monitoring-service.ts` | `backend/monitoring/monitoring.test.ts`<br>`tests/acceptance/acceptance.test.ts` | **Soddisfatto** |
| **RF-MON-002** | Interpretazione formati (KV e JSON) isolata | `backend/monitoring/state-parser.ts`<br>`backend/monitoring/monitoring-service.ts` | `backend/monitoring/monitoring.test.ts`<br>`tests/acceptance/acceptance.test.ts` | **Soddisfatto** |
| **RF-MON-003** | Polling periodico a intervallo configurabile | `backend/monitoring/monitoring-service.ts`<br>`config/configuration.ts` | `backend/monitoring/monitoring.test.ts`<br>`tests/acceptance/acceptance.test.ts` | **Soddisfatto** |
| **RF-MON-004** | Aggiornamento manuale su richiesta dell'utente | `backend/monitoring/monitoring-service.ts`<br>`backend/monitoring/monitoring-routes.ts` | `backend/monitoring/monitoring.test.ts`<br>`tests/acceptance/acceptance.test.ts` | **Soddisfatto** |
| **RF-MON-005** | Preservazione ultimo stato valido (stale) su guasto | `backend/monitoring/monitoring-service.ts`<br>`storage/robot-repository.ts` | `backend/monitoring/monitoring.test.ts`<br>`tests/acceptance/acceptance.test.ts` | **Soddisfatto** |
| **RF-MON-006** | Visualizzazione distinta dei 3 stati (anagrafico, conn, oper) | `storage/dto/robot-dto.ts`<br>`frontend/state-formatter.js` | `backend/monitoring/monitoring.test.ts`<br>`frontend/frontend.test.ts` | **Soddisfatto** |

### 1.4 Terminale Remoto (§3.4, §5.4, §6.4)
| ID Requisito | Descrizione Sintetica | Modulo Implementazione | Suite di Test Automatizzati | Stato |
| :--- | :--- | :--- | :--- | :--- |
| **RF-SSH-001** | Apertura sessione terminale Linux interattivo | `backend/terminal/terminal-service.ts`<br>`backend/terminal/terminal-routes.ts` | `backend/terminal/terminal.test.ts`<br>`tests/acceptance/acceptance.test.ts` | **Soddisfatto** |
| **RF-SSH-002** | Esecuzione comandi interattivi remoti | `backend/terminal/terminal-service.ts` | `backend/terminal/terminal.test.ts`<br>`tests/acceptance/acceptance.test.ts` | **Soddisfatto** |
| **RF-SSH-003** | Streaming progressivo dell'output della shell | `backend/terminal/terminal-service.ts`<br>`frontend/app.js` | `backend/terminal/terminal.test.ts`<br>`frontend/frontend.test.ts` | **Soddisfatto** |
| **RF-SSH-004** | Emulazione terminale xterm nel browser e canale WSS | `frontend/app.js`<br>`backend/terminal/terminal-routes.ts` | `backend/terminal/terminal.test.ts`<br>`frontend/frontend.test.ts`<br>`tests/security/corrective-hardening.test.ts` | **Soddisfatto** |
| **RF-SSH-005** | Chiusura ordinata e rilascio a zero risorse (7 cause) | `backend/terminal/terminal-service.ts` | `backend/terminal/terminal.test.ts`<br>`tests/acceptance/acceptance.test.ts`<br>`tests/security/corrective-hardening.test.ts` | **Soddisfatto** |
| **RF-SSH-006** | Isolamento sessioni e divieto accessi non autorizzati | `backend/terminal/terminal-service.ts`<br>`backend/terminal/terminal-models.ts` | `backend/terminal/terminal.test.ts`<br>`tests/security/security-hardening.test.ts` | **Soddisfatto** |
| **RF-SSH-007** | Blocco apertura terminale su robot disabilitato/non verificato | `backend/terminal/terminal-service.ts` | `backend/terminal/terminal.test.ts`<br>`tests/acceptance/acceptance.test.ts` | **Soddisfatto** |
| **RF-SSH-008** | Privilegi dell'account SSH specificato (nessun sudo) | `backend/connection/robot-connection-manager.ts` | `backend/connection/connection.test.ts`<br>`tests/security/security-hardening.test.ts` | **Soddisfatto** |

### 1.5 Navigazione Filesystem Remoto del Robot (§3.5, §5.5)
| ID Requisito | Descrizione Sintetica | Modulo Implementazione | Suite di Test Automatizzati | Stato |
| :--- | :--- | :--- | :--- | :--- |
| **RF-FS-001** | Visualizzazione e navigazione directory remote SFTP | `backend/remote-fs/remote-fs-service.ts`<br>`backend/remote-fs/remote-fs-routes.ts` | `backend/remote-fs/remote-fs.test.ts`<br>`tests/acceptance/acceptance.test.ts` | **Soddisfatto** |
| **RF-FS-002** | Metadati file restituiti dal protocollo (nome, tipo, dim, data) | `backend/remote-fs/remote-fs-service.ts`<br>`backend/remote-fs/remote-fs-models.ts` | `backend/remote-fs/remote-fs.test.ts`<br>`tests/acceptance/acceptance.test.ts` | **Soddisfatto** |
| **RF-FS-003** | Riconoscimento directory, file e permessi | `backend/remote-fs/remote-fs-service.ts` | `backend/remote-fs/remote-fs.test.ts`<br>`tests/acceptance/acceptance.test.ts` | **Soddisfatto** |
| **RF-FS-004** | Streaming download da filesystem remoto | `backend/remote-fs/remote-fs-service.ts` | `backend/remote-fs/remote-fs.test.ts`<br>`tests/acceptance/acceptance.test.ts` | **Soddisfatto** |
| **RF-FS-005** | Streaming upload verso filesystem remoto | `backend/remote-fs/remote-fs-service.ts` | `backend/remote-fs/remote-fs.test.ts`<br>`tests/acceptance/acceptance.test.ts` | **Soddisfatto** |
| **RF-FS-006** | Gestione errori e percorsi non accessibili | `backend/remote-fs/remote-fs-service.ts`<br>`errors/app-errors.ts` | `backend/remote-fs/remote-fs.test.ts`<br>`tests/acceptance/acceptance.test.ts` | **Soddisfatto** |
| **RF-FS-007** | Livello navigazione rigorosamente di sola lettura | `backend/remote-fs/remote-fs-service.ts` | `backend/remote-fs/remote-fs.test.ts`<br>`tests/security/security-hardening.test.ts` | **Soddisfatto** |

### 1.6 Gestione Filesystem Server (§3.6, §5.6, §11.1)
| ID Requisito | Descrizione Sintetica | Modulo Implementazione | Suite di Test Automatizzati | Stato |
| :--- | :--- | :--- | :--- | :--- |
| **RF-SRVFS-001** | Root dedicata del server per l'archiviazione della flotta | `storage/server-fs.ts`<br>`config/configuration.ts` | `storage/server-fs.test.ts`<br>`tests/acceptance/acceptance.test.ts` | **Soddisfatto** |
| **RF-SRVFS-002** | Navigazione directory server del robot | `storage/server-fs.ts`<br>`backend/server-fs-routes.ts` | `storage/server-fs.test.ts`<br>`tests/acceptance/acceptance.test.ts` | **Soddisfatto** |
| **RF-SRVFS-003** | Caricamento file dal client del manutentore al server | `storage/server-fs.ts`<br>`backend/transfer/transfer-service.ts` | `storage/server-fs.test.ts`<br>`backend/transfer/transfer.test.ts` | **Soddisfatto** |
| **RF-SRVFS-004** | Download file dal server al client del manutentore | `storage/server-fs.ts`<br>`backend/transfer/transfer-service.ts` | `storage/server-fs.test.ts`<br>`backend/transfer/transfer.test.ts` | **Soddisfatto** |
| **RF-SRVFS-005** | Isolamento directory server per robot e blocco traversal | `storage/server-fs.ts` | `storage/server-fs.test.ts`<br>`tests/security/security-hardening.test.ts`<br>`tests/security/fleet-uniqueness-fs.test.ts` | **Soddisfatto** |
| **RF-SRVFS-006** | Preservazione dei file su directory già esistente | `storage/server-fs.ts` | `storage/server-fs.test.ts`<br>`tests/acceptance/acceptance.test.ts` | **Soddisfatto** |

### 1.7 Trasferimento File (§3.7, §5.5, §§6.5-6.7)
| ID Requisito | Descrizione Sintetica | Modulo Implementazione | Suite di Test Automatizzati | Stato |
| :--- | :--- | :--- | :--- | :--- |
| **RF-TRF-001** | Trasferimento tra client e server locale in entrambe le direzioni | `backend/transfer/transfer-service.ts` | `backend/transfer/transfer.test.ts`<br>`tests/acceptance/acceptance.test.ts` | **Soddisfatto** |
| **RF-TRF-002** | Trasferimento bidirezionale tra server e robot | `backend/transfer/transfer-service.ts` | `backend/transfer/transfer.test.ts`<br>`tests/acceptance/acceptance.test.ts` | **Soddisfatto** |
| **RF-TRF-003** | Trasferimento intermediato client ↔ robot (no SSH diretto) | `backend/transfer/transfer-service.ts` | `backend/transfer/transfer.test.ts`<br>`tests/acceptance/acceptance.test.ts` | **Soddisfatto** |
| **RF-TRF-004** | Streaming e backpressure per file > 1 GB a memoria costante | `backend/transfer/transfer-service.ts` | `backend/transfer/transfer.test.ts`<br>`tests/reliability-performance/reliability-perf.test.ts` | **Soddisfatto** |
| **RF-TRF-005** | Trasferimento a blocchi (chunk size configurabile) | `backend/transfer/transfer-service.ts` | `backend/transfer/transfer.test.ts`<br>`tests/acceptance/acceptance.test.ts` | **Soddisfatto** |
| **RF-TRF-006** | Avanzamento in tempo reale (byte, %, velocità, ETA) | `backend/transfer/transfer-service.ts`<br>`frontend/app.js` | `backend/transfer/transfer.test.ts`<br>`frontend/frontend.test.ts` | **Soddisfatto** |
| **RF-TRF-007** | Segnalazione interruzione e non falso completamento | `backend/transfer/transfer-service.ts` | `backend/transfer/transfer.test.ts`<br>`tests/acceptance/acceptance.test.ts` | **Soddisfatto** |
| **RF-TRF-008** | Verifica integrità opzionale tramite checksum | `backend/transfer/transfer-service.ts`<br>`backend/transfer/transfer-models.ts` | `backend/transfer/transfer.test.ts`<br>`tests/security/transfers-monitoring-hardening.test.ts`<br>`tests/acceptance/acceptance.test.ts` | **Soddisfatto** |
| **RF-TRF-009** | Utilizzo file temporanei e pulizia immediata su guasto | `backend/transfer/transfer-service.ts` | `backend/transfer/transfer.test.ts`<br>`tests/security/security-hardening.test.ts`<br>`tests/security/transfers-monitoring-hardening.test.ts` | **Soddisfatto** |
| **RF-TRF-010** | Ripresa dei trasferimenti (opzionale configurabile) | `backend/transfer/transfer-service.ts` | `backend/transfer/transfer.test.ts`<br>`DECISIONS.md` | **Soddisfatto** |
| **RF-TRF-011** | Politica di sovrascrittura prudente configurabile | `backend/transfer/transfer-service.ts` | `backend/transfer/transfer.test.ts`<br>`tests/security/transfers-monitoring-hardening.test.ts`<br>`tests/acceptance/acceptance.test.ts` | **Soddisfatto** |
| **RF-TRF-012** | Limiti di concorrenza simultanea per utente/robot/server | `backend/transfer/transfer-service.ts` | `backend/transfer/transfer.test.ts`<br>`tests/reliability-performance/reliability-perf.test.ts` | **Soddisfatto** |
| **RF-TRF-013** | Gestione timeout di trasferimento e inattività | `backend/transfer/transfer-service.ts` | `backend/transfer/transfer.test.ts`<br>`tests/acceptance/acceptance.test.ts` | **Soddisfatto** |
| **RF-TRF-014** | Controllo preventivo spazio su disco | `backend/transfer/transfer-service.ts` | `backend/transfer/transfer.test.ts`<br>`tests/security/transfers-monitoring-hardening.test.ts`<br>`tests/acceptance/acceptance.test.ts` | **Soddisfatto** |

---

## 2. Requisiti Non Funzionali (RNF)

### 2.1 Sicurezza (RNF-SEC-001..009)
| ID Requisito | Descrizione Sintetica | Modulo Implementazione | Suite di Test Automatizzati | Stato |
| :--- | :--- | :--- | :--- | :--- |
| **RNF-SEC-001** | Comunicazioni protette: HTTPS/TLS obbligatorio, blocco HTTP | `backend/server.ts`<br>`config/configuration.ts` | `backend/server.test.ts`<br>`tests/security/security-hardening.test.ts` | **Soddisfatto** |
| **RNF-SEC-002** | Protezione credenziali e zero chiavi/segreti esposti | `backend/connection/credential-provider.ts`<br>`backend/connection/mongo-credential-provider.ts`<br>`backend/connection/master-key.ts`<br>`scripts/reencrypt-credentials.ts`<br>`scripts/seed-users.ts`<br>`logging/logger.ts`<br>`storage/dto/robot-dto.ts` | `backend/connection/connection.test.ts`<br>`tests/security/security-hardening.test.ts`<br>`tests/security/corrective-hardening.test.ts`<br>`tests/security/fleet-uniqueness-fs.test.ts` | **Soddisfatto** |
| **RNF-SEC-003** | Verifica chiavi host SSH e blocco man-in-the-middle | `backend/connection/host-key-verifier.ts` | `backend/connection/connection.test.ts`<br>`tests/security/security-hardening.test.ts`<br>`tests/security/corrective-hardening.test.ts` | **Soddisfatto** |
| **RNF-SEC-004** | Autorizzazione centrale lato server (guardia su 18 endpoint) | `backend/auth/auth-middleware.ts`<br>`backend/auth/permissions.ts`<br>`backend/auth/session-manager.ts` | `backend/auth/auth.test.ts`<br>`tests/security/security-hardening.test.ts`<br>`tests/security/corrective-hardening.test.ts` | **Soddisfatto** |
| **RNF-SEC-005** | Protezione categorica da Path Traversal e null-byte | `storage/server-fs.ts`<br>`backend/monitoring/robot-reader.ts` | `storage/server-fs.test.ts`<br>`tests/security/security-hardening.test.ts` | **Soddisfatto** |
| **RNF-SEC-006** | Validazione sintattica host/porte e whitelist anti-abuso | `backend/connection/connection-validator.ts` | `backend/connection/connection.test.ts`<br>`tests/security/security-hardening.test.ts` | **Soddisfatto** |
| **RNF-SEC-007** | Isolamento sessioni e divieto accessi cross-robot | `backend/terminal/terminal-service.ts`<br>`backend/auth/permissions.ts` | `backend/terminal/terminal.test.ts`<br>`tests/security/security-hardening.test.ts` | **Soddisfatto** |
| **RNF-SEC-008** | Protezione e isolamento directory/file temporanei (.tmp 0700) | `storage/server-fs.ts`<br>`backend/transfer/transfer-service.ts` | `backend/transfer/transfer.test.ts`<br>`tests/security/security-hardening.test.ts`<br>`tests/security/fleet-uniqueness-fs.test.ts` | **Soddisfatto** |
| **RNF-SEC-009** | Audit log immutabile con redazione e conservazione | `storage/audit-repository.ts`<br>`logging/logger.ts` | `storage/storage.test.ts`<br>`tests/security/security-hardening.test.ts` | **Soddisfatto** |

### 2.2 Filesystem e Persistenza (RNF-FS-001..004)
| ID Requisito | Descrizione Sintetica | Modulo Implementazione | Suite di Test Automatizzati | Stato |
| :--- | :--- | :--- | :--- | :--- |
| **RNF-FS-001** | Permessi restrittivi directory server (0750) | `storage/server-fs.ts`<br>`config/configuration.ts` | `storage/server-fs.test.ts`<br>`tests/security/security-hardening.test.ts`<br>`tests/security/fleet-uniqueness-fs.test.ts` | **Soddisfatto** |
| **RNF-FS-002** | Separazione fisica dei dati per ciascun robot | `storage/server-fs.ts` | `storage/server-fs.test.ts`<br>`tests/security/security-hardening.test.ts`<br>`tests/security/fleet-uniqueness-fs.test.ts` | **Soddisfatto** |
| **RNF-FS-003** | Divieto operazioni distruttive non confermate | `backend/fleet/fleet-service.ts`<br>`backend/transfer/transfer-service.ts` | `backend/transfer/transfer.test.ts`<br>`tests/security/transfers-monitoring-hardening.test.ts`<br>`tests/security/fleet-uniqueness-fs.test.ts`<br>`tests/acceptance/acceptance.test.ts` | **Soddisfatto** |
| **RNF-FS-004** | Idempotenza creazione directory e non sovrascrittura | `storage/server-fs.ts`<br>`backend/fleet/fleet-service.ts` | `storage/server-fs.test.ts`<br>`tests/security/fleet-uniqueness-fs.test.ts`<br>`tests/acceptance/acceptance.test.ts` | **Soddisfatto** |

### 2.3 Prestazioni e Scalabilità (RNF-PERF-001..005)
| ID Requisito | Descrizione Sintetica | Modulo Implementazione | Suite di Test Automatizzati | Stato |
| :--- | :--- | :--- | :--- | :--- |
| **RNF-PERF-001** | File > 1 GB a memoria costante su tutte le 6 direzioni | `backend/transfer/transfer-service.ts` | `backend/transfer/transfer.test.ts`<br>`tests/reliability-performance/reliability-perf.test.ts` | **Soddisfatto** |
| **RNF-PERF-002** | Uso efficiente risorse e troncamento directory affollate | `backend/remote-fs/remote-fs-service.ts` | `backend/remote-fs/remote-fs.test.ts`<br>`tests/reliability-performance/reliability-perf.test.ts` | **Soddisfatto** |
| **RNF-PERF-003** | Concorrenza parametrica e liberazione immediata risorse | `backend/connection/robot-connection-manager.ts`<br>`backend/transfer/transfer-service.ts` | `backend/connection/connection.test.ts`<br>`tests/reliability-performance/reliability-perf.test.ts` | **Soddisfatto** |
| **RNF-PERF-004** | Polling configurabile a zero impatto (disabilitabile se <=0) | `backend/monitoring/monitoring-service.ts` | `backend/monitoring/monitoring.test.ts`<br>`tests/acceptance/acceptance.test.ts` | **Soddisfatto** |
| **RNF-PERF-005** | Scalabilità della flotta senza modifiche al codice | `backend/fleet/fleet-service.ts` | `tests/reliability-performance/reliability-perf.test.ts` | **Soddisfatto** |

### 2.4 Affidabilità e Resilienza (RNF-REL-001..005)
| ID Requisito | Descrizione Sintetica | Modulo Implementazione | Suite di Test Automatizzati | Stato |
| :--- | :--- | :--- | :--- | :--- |
| **RNF-REL-001** | Gestione disconnessioni e isolamento guasti tra robot | `backend/connection/robot-connection-manager.ts`<br>`backend/monitoring/monitoring-service.ts` | `backend/connection/connection.test.ts`<br>`backend/monitoring/monitoring.test.ts` | **Soddisfatto** |
| **RNF-REL-002** | Stato aggiornato e marcatura stale (badge [Non più verificato]) | `backend/monitoring/monitoring-service.ts`<br>`storage/dto/robot-dto.ts` | `backend/monitoring/monitoring.test.ts`<br>`tests/acceptance/acceptance.test.ts` | **Soddisfatto** |
| **RNF-REL-003** | Recupero da errori parziali e rollback sicuro | `backend/fleet/fleet-service.ts`<br>`storage/server-fs.ts` | `backend/fleet/fleet.test.ts`<br>`tests/acceptance/acceptance.test.ts` | **Soddisfatto** |
| **RNF-REL-004** | Integrità dei file esistenti su trasferimenti falliti | `backend/transfer/transfer-service.ts` | `backend/transfer/transfer.test.ts`<br>`tests/security/transfers-monitoring-hardening.test.ts`<br>`tests/acceptance/acceptance.test.ts` | **Soddisfatto** |
| **RNF-REL-005** | Pulizia delle risorse e riavvio pulito senza lock | `backend/server.ts`<br>`backend/terminal/terminal-service.ts` | `backend/terminal/terminal.test.ts`<br>`tests/reliability-performance/reliability-perf.test.ts`<br>`tests/security/corrective-hardening.test.ts` | **Soddisfatto** |

### 2.5 Usabilità e Frontend (RNF-UX-001..004)
| ID Requisito | Descrizione Sintetica | Modulo Implementazione | Suite di Test Automatizzati | Stato |
| :--- | :--- | :--- | :--- | :--- |
| **RNF-UX-001** | Interfaccia intuitiva per manutentore | `frontend/index.html`<br>`frontend/styles.css` | `frontend/frontend.test.ts` | **Soddisfatto** |
| **RNF-UX-002** | Feedback visivo conforme al catalogo §9 | `frontend/error-presenter.js`<br>`frontend/app.js` | `frontend/frontend.test.ts` | **Soddisfatto** |
| **RNF-UX-003** | Compatibilità Google Chrome senza plugin aggiuntivi | `frontend/index.html`<br>`frontend/app.js` | `frontend/frontend.test.ts` | **Soddisfatto** |
| **RNF-UX-004** | Terminale Linux interattivo nel browser (xterm.js su WSS) | `frontend/app.js`<br>`backend/terminal/terminal-service.ts` | `frontend/frontend.test.ts`<br>`backend/terminal/terminal.test.ts` | **Soddisfatto** |

### 2.6 Manutenibilità e Tracciabilità (RNF-MNT-001..003)
| ID Requisito | Descrizione Sintetica | Modulo Implementazione | Suite di Test Automatizzati | Stato |
| :--- | :--- | :--- | :--- | :--- |
| **RNF-MNT-001** | Parametri di configurazione all'avvio fail-closed | `config/configuration.ts` | `config/configuration.test.ts`<br>`tests/security/configuration-coherence.test.ts` | **Soddisfatto** |
| **RNF-MNT-002** | Disaccoppiamento e separazione dei componenti | `backend/server.ts`<br>`frontend/app.js` | `backend/server.test.ts`<br>`frontend/frontend.test.ts` | **Soddisfatto** |
| **RNF-MNT-003** | Tracciabilità completa errori secondo catalogo §9 | `errors/app-errors.ts`<br>`logging/logger.ts` | `errors/app-errors.test.ts`<br>`tests/security/security-hardening.test.ts` | **Soddisfatto** |

---

## 3. Vincoli Architetturali e di Sicurezza (§2.4)

| Vincolo §2.4 | Descrizione del Vincolo | Modulo Implementazione | Suite di Test Automatizzati | Stato |
| :--- | :--- | :--- | :--- | :--- |
| **§2.4 punto 1** | Credenziali e chiavi private gestite esclusivamente lato server | `backend/connection/credential-provider.ts`<br>`backend/connection/mongo-credential-provider.ts` | `tests/security/security-hardening.test.ts`<br>`tests/security/corrective-hardening.test.ts` | **Soddisfatto** |
| **§2.4 punto 2** | Il browser non riceve chiavi private SSH o credenziali persistenti | `storage/dto/robot-dto.ts` | `tests/security/security-hardening.test.ts`<br>`tests/security/corrective-hardening.test.ts` | **Soddisfatto** |
| **§2.4 punto 3** | Traffico tra browser e applicazione utilizza HTTPS (e WSS) | `backend/server.ts` | `tests/security/security-hardening.test.ts` | **Soddisfatto** |
| **§2.4 punto 4** | Comunicazioni backend-robot utilizzano SSH v2 e SFTP v3 | `backend/connection/robot-connection-manager.ts` | `backend/connection/connection.test.ts` | **Soddisfatto** |
| **§2.4 punto 5** | Trasferimento file > 1 GB senza caricamento simultaneo in RAM | `backend/transfer/transfer-service.ts` | `tests/reliability-performance/reliability-perf.test.ts` | **Soddisfatto** |
| **§2.4 punto 6** | Directory del robot sul server associata al relativo username | `storage/server-fs.ts` | `storage/server-fs.test.ts`<br>`tests/acceptance/acceptance.test.ts` | **Soddisfatto** |
| **§2.4 punto 7** | Impedire accesso non autorizzato alle directory e sessioni di altri robot | `backend/auth/permissions.ts`<br>`storage/server-fs.ts` | `tests/security/security-hardening.test.ts` | **Soddisfatto** |
