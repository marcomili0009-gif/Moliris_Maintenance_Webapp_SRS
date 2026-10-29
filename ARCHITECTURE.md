# Architettura di Sistema – Moliris Maintenance Webapp (SRS v1.0)

## 1. Principi Fondamentali (§1.2)
1. **Mediazione Totale del Backend**: Il browser dell'utente non si collega mai direttamente ai robot tramite SSH o SFTP.
2. **Applicazione della Sicurezza**: Ogni operazione (terminale, monitoraggio, navigazione file e trasferimenti) è mediata dal backend applicativo, che applica verifiche di autenticazione, autorizzazione, convalida degli host e audit.

---

## 2. I 7 Vincoli Architetturali (§2.4)
1. **Vincolo 1**: Le credenziali e le chiavi private utilizzate per accedere ai robot dovranno essere gestite esclusivamente lato server.
2. **Vincolo 2**: Il browser non dovrà ricevere chiavi private SSH o credenziali persistenti dei robot.
3. **Vincolo 3**: Il traffico tra browser e applicazione dovrà utilizzare HTTPS.
4. **Vincolo 4**: Le comunicazioni tra backend e robot dovranno utilizzare SSH e, per i trasferimenti di file, SFTP o un protocollo sicuro equivalente.
5. **Vincolo 5**: Il sistema dovrà consentire il trasferimento di file di dimensioni superiori a 1 GB.
6. **Vincolo 6**: La directory di ciascun robot sul server dovrà essere associata al relativo username del robot, secondo le regole di configurazione definite.
7. **Vincolo 7**: Il backend dovrà impedire l'accesso non autorizzato alle directory e alle sessioni di altri robot.

---

## 3. Schema dei Componenti Logici (§5)

```
+-------------------------------------------------------------------------------+
|                                GOOGLE CHROME                                  |
|                           (Client su VPN Moliris)                             |
|                                                                               |
|   [Interfaccia Utente React] <===============> [Terminale xterm.js]           |
+-------------------------------------------------------------------------------+
            |                                                   ^
      HTTPS | (REST API / Streams)                              | WSS (WebSocket)
            v                                                   v
+-------------------------------------------------------------------------------+
|                          MOLIRIS MAINTENANCE BACKEND                          |
|                             (Node.js su Ubuntu 26.04)                         |
|                                                                               |
|  +-------------------------------------------------------------------------+  |
|  | §5.2 Backend API (Auth, Anagrafica Robot, RBAC, Config, Coordinamento) |  |
|  +-------------------------------------------------------------------------+  |
|         |                           |                             |           |
|         v                           v                             v           |
|  +--------------------+   +-------------------+   +------------------------+  |
|  | §5.3 Servizio      |   | §5.4 Servizio     |   | §5.5 Servizio          |  |
|  | Monitoraggio SSH   |   | Terminale SSH     |   | Trasferimento File     |  |
|  | (Polling & Parsing)|   | (PTY / WebSocket) |   | (Streaming / Backpress)|  |
|  +--------------------+   +-------------------+   +------------------------+  |
|         |                           |                             |           |
|         +-------------+-------------+-----------------------------+           |
|                       |                                                       |
|                       v                                                       |
|  +-------------------------------------------------------------------------+  |
|  | §5.6 Data Access & Storage (Repository MongoDB / Filesystem Server)     |  |
|  +-------------------------------------------------------------------------+  |
+-------------------------------------------------------------------------------+
      |                        |                                     |
      | MongoDB Driver         | Server FS I/O                       | SSH2 / SFTP
      v                        v                                     v
+------------+   +---------------------------+   +------------------------------+
|  DATABASE  |   |     FILESYSTEM SERVER     |   |         FLOTTA ROBOT         |
|  MongoDB   |   |       /home/robots/       |   |    Dispositivi Linux su VPN  |
| (§2.3, §10)|   |        └── <username>/    |   |    - Servizio SSH (porta 22) |
|            |   |       (§5.6, §10.3)       |   |    - File di stato (§3.3)    |
+------------+   +---------------------------+   +------------------------------+
```

---

## 4. Flussi Operativi Principali (§6)

### Flusso 6.1 – Accesso all'applicazione
1. L'utente apre l'applicazione tramite HTTPS.
2. Inserisce username e password.
3. Il backend verifica le credenziali.
4. In caso di esito positivo, viene creata o attivata la sessione.
5. L'utente accede alla schermata della flotta secondo le proprie autorizzazioni.

### Flusso 6.2 – Registrazione di un nuovo robot
1. L'utente autorizzato apre la funzione di aggiunta robot.
2. Inserisce nome, username remoto, host, metodo di autenticazione e gli altri parametri richiesti.
3. Il frontend invia i dati al backend tramite un canale protetto.
4. Il backend verifica l'autorizzazione dell'utente.
5. Il backend valida i campi e controlla l'unicità dei dati.
6. Il backend verifica la connessione SSH, se richiesta dalla politica di registrazione (modalità rigorosa).
7. Il backend verifica la configurazione necessaria per monitoraggio e trasferimenti.
8. Il backend crea o verifica la directory del robot nella root configurata, senza alterare file preesistenti.
9. Il backend registra il robot nel database e aggiorna il relativo stato di configurazione.
10. Il backend registra l'evento di audit.
11. Il frontend mostra l'esito della registrazione e aggiorna la lista della flotta.

### Flusso 6.3 – Monitoraggio di un robot
1. Il servizio di monitoraggio seleziona il robot da interrogare.
2. Il backend verifica che il robot sia registrato e abilitato.
3. Il servizio apre una connessione SSH usando la configurazione associata.
4. Legge i file di stato configurati.
5. Il backend interpreta il contenuto e aggiorna le informazioni disponibili.
6. Il frontend visualizza lo stato e la data dell'ultimo aggiornamento valido.
7. In caso di errore, il sistema conserva l'ultima informazione valida e mostra l'esito dell'ultimo tentativo.

### Flusso 6.4 – Apertura del terminale
1. L'utente seleziona un robot.
2. Richiede l'apertura del terminale.
3. Il backend verifica la sessione e le autorizzazioni.
4. Il servizio terminale apre la connessione SSH e alloca un PTY.
5. Il frontend stabilisce il canale di comunicazione in tempo reale.
6. L'utente interagisce con la shell Linux.
7. Alla chiusura o alla disconnessione, il backend termina o libera le risorse della sessione secondo la politica configurata.

### Flusso 6.5 – Trasferimento computer-server
1. L'utente seleziona la directory di destinazione.
2. Seleziona il file da caricare oppure il file da scaricare.
3. Il backend verifica i permessi e la destinazione.
4. Il trasferimento avviene tramite streaming o blocchi.
5. Il sistema mostra l'avanzamento.
6. Al termine, viene eseguita la verifica di integrità prevista.
7. Il sistema comunica il risultato e gestisce gli eventuali file temporanei.

### Flusso 6.6 – Trasferimento server-robot
1. L'utente seleziona il robot e il file.
2. Il backend verifica le autorizzazioni.
3. Il servizio di trasferimento apre una connessione SFTP o equivalente.
4. Il file viene trasferito in streaming o a blocchi.
5. Il sistema gestisce l'avanzamento e gli errori.
6. Al termine, viene eseguita la verifica di integrità prevista.
7. Il frontend mostra l'esito dell'operazione.

### Flusso 6.7 – Trasferimento computer-robot
1. L'utente seleziona il robot e il file sul proprio computer.
2. Il backend riceve il contenuto tramite un flusso di upload.
3. Il sistema trasferisce il contenuto verso il robot tramite SSH/SFTP o protocollo sicuro equivalente.
4. Il backend gestisce i dati in streaming o a blocchi, evitando di caricare l'intero file in RAM.
5. Il sistema mostra il progresso e gestisce eventuali errori.
6. Il trasferimento viene dichiarato completato solo dopo i controlli previsti.
*(Il trasferimento inverso segue lo stesso principio: il backend legge dal robot via SFTP e invia progressivamente il contenuto al browser).*
