# Aggiornamento manuale di Moliris su NEANTE

Il pacchetto contiene i sorgenti e la build locale verificata. La procedura usa l’account `stage`, `/home/stage/moliris/app` e l’unità utente `moliris.service`. L’attivazione e il rollback vanno eseguiti dal referente IT in una finestra approvata, con i flussi operativi quiescenti.

## Preflight in sola lettura

1. Acquisire l’hash pubblicato del pacchetto attraverso il canale di consegna e verificare `sha256sum -c` prima di estrarlo. Verificare anche `SHA256SUMS` nella directory estratta. Tenere estrazione, app e directory di rollback in percorsi distinti sullo stesso filesystem.
2. Da `stage`, rilevare `systemctl --user show moliris.service -p ExecStart -p MainPID -p FragmentPath -p WorkingDirectory -p DropInPaths -p TimeoutStopUSec -p ActiveState`. Confermare la directory installata e che l’unità esegua `dist/backend/server.js`, confrontare il PID con `/proc/PID/exe` e rilevare versione e architettura Node. Conservare l’output in un’area privata. Parametri con segreti e contenuto dei file ambiente vanno conservati nel sistema IT previsto.
3. Confrontare i checksum di `package.json`, `package-lock.json`, `dist/backend/server.js`, frontend e sorgenti installati se presenti con l’inventario ricevuto e con la base GitHub dichiarata nel pacchetto. Se l’unità lancia sorgenti TypeScript, la struttura differisce, i checksum non sono riconducibili a una base nota o le configurazioni sono annidate in `dist` o `node_modules`, sospendere il cambio e riconciliare i percorsi. L’allineamento della macchina in uso richiede questo controllo.
4. Verificare spazio per pacchetto, copia di ritorno e build. Verificare in sola lettura salute, log, MongoDB, owner e modalità degli archivi, e le destinazioni e i percorsi configurati. Provare HTTPS e WSS con la catena riconosciuta dalle postazioni. Il certificato e il trust store rientrano nella gestione IT.
5. Predisporre il backup coordinato descritto nel [runbook](BACKUP-RESTORE.md), registrare i checksum di partenza e concordare il punto in cui eventuali nuovi dati richiederanno una riconciliazione.

## Preparazione separata e attivazione manuale

Estrarre il pacchetto in una directory privata separata. Dentro quella directory, eseguire `npm ci --ignore-scripts`, i type check e `npm run build` con la versione Node/npm di consegna. `npm ci` usa il lockfile e scarica anche gli strumenti di build, a prescindere dalle dipendenze presenti in `app`. Conservare gli SHA-256 della build risultante. Preparare i soli pacchetti runtime nella stessa directory con `npm ci --omit=dev --ignore-scripts` e verificare il caricamento di Fastify, MongoDB e ssh2. In assenza di accesso al registro, predisporre l’installazione in staging da una cache aziendale verificata o usare un runtime preparato per lo stesso sistema e ABI.

Prima del cambio, fermare manualmente l’unità `systemctl --user stop moliris.service`. Verificare `MainPID=0`, stato inattivo e journal senza uscita forzata. Registrare l’eventuale anomalia e sospendere l’attivazione fino alla decisione IT. Creare una directory di backup vuota protetta con modo 0700. Lo scambio conserva il resto di `app`, compresi file ambiente, config, certificati, chiavi, log e dati esterni al runtime.

Dalla directory estratta, con variabili impostate ai tre percorsi assoluti scelti:

```bash
bash scripts/moliris-runtime-swap.sh "$app" "$candidate" "$runtime_backup"
systemctl --user start moliris.service
systemctl --user show moliris.service -p MainPID -p ActiveState
```

Registrare gli SHA-256 attivi. Verificare `/livez`, `/healthz`, login e logout, separazione dei ruoli, una sonda SSH/SFTP autorizzata e i log. Valutare la vista Logs con un amministratore e una risposta 403 con un operatore. Conservare il backup finché il dirigente operativo accetta la versione. Il pacchetto non cambia i file di unità, le configurazioni di rete o il database esistente. Il journal dei trasferimenti introduce una raccolta Mongo aggiuntiva inizializzata dall’applicazione.

## Rollback manuale

Fermare l’unità e verificare l’assenza di PID. Usare come ingresso la directory di backup runtime dell’attivazione. Stoccare il runtime candidato in una nuova directory vuota, sullo stesso filesystem.

```bash
bash scripts/moliris-runtime-swap.sh "$app" "$runtime_backup" "$candidate_retained"
systemctl --user start moliris.service
```

Controllare i checksum registrati prima della modifica, poi PID, health, comportamento dei ruoli e accessibilità dell’archivio. Lo scambio non sovrascrive dati operativi. Se il candidato ha scritto nuovi documenti o file, preservare tali scritture per la riconciliazione. Per ripristinare anche dati e configurazione, usare una copia isolata e il [runbook di ripristino](BACKUP-RESTORE.md).
