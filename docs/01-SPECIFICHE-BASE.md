# 01 - SPECIFICHE BASE - Moliris Maintenance Webapp (SRS v1.0)

Fonte: `Moliris_Maintenance_Webapp_SRS.txt` (SRS v1.0, testo integrale) + requisiti specifici aggiuntivi in coda al documento. Stato codebase: esistente, quasi completa (verificata requisito per requisito in `04-CHECKLIST-VERIFICA.md`).

## 1. Scopo e ambito

Web app centralizzata per gestire, monitorare e interagire da remoto con una flotta di robot mobili Linux. L'utente autorizzato accede via browser (Google Chrome, HTTPS, VPN Moliris) a: login, elenco flotta, stato operativo, terminale SSH nel browser, filesystem remoto del robot, filesystem server, trasferimenti file tra computer/server/robot, registrazione nuovi robot con creazione automatica della directory server. Il browser non si collega mai direttamente ai robot: tutto passa dal backend (SSH/SFTP lato server).

Ambiente: server Ubuntu 26.04, database MongoDB, HTTPS obbligatorio, file > 1 GB in streaming.

## 2. Utenti e ruoli

- Utente autorizzato (operatore): funzioni consentite dal profilo, navigazione limitée alle cartelle autorizzate.
- Amministratore/gestore flotta: registra/modifica/disabilita/rimuove robot; terminale SSH réservé solo agli Admin.
- Sessione singola per account: un solo utente attivo per sessione (HTTP 409 su accesso simultaneo).

## 3. Vincoli architetturali (SRS §2.4)

1. Credenziali e chiavi private gestite solo lato server.
2. Il browser non riceve mai chiavi private SSH o credenziali persistenti dei robot.
3. Traffico browser-app in HTTPS.
4. Backend-robot via SSH e SFTP (o equivalente sicuro).
5. Supporto file > 1 GB.
6. Directory server per robot = username remoto del robot dentro la root configurata.
7. Blocco accessi non autorizzati a directory e sessioni di altri robot.

## 4. Requisiti funzionali (SRS §3)

- §3.1 Auth: RF-AUTH-001..006 (login, verifica credenziali, sessione, logout, autorizzazioni, scadenza configurabile).
- §3.2 Flotta: RF-ROB-001..014 (lista, selezione, dettaglio, registrazione con parametri di connessione, validazione, verifica SSH, creazione directory `<username>_<id>`, idempotenza, coerenza DB/FS con rollback, esito a 6 stati, disabilita/rimozione senza cancellazione automatica, distinzione stato anagrafico vs connettività).
- §3.3 Monitoraggio: RF-MON-001..006 (lettura file di stato via SSH, parsing, polling configurabile, refresh manuale, preservazione ultimo dato valido, visualizzazione distinta stati).
- §3.4 Terminale: RF-SSH-001..008 (PTY + WebSocket, shell interattiva completa, stream bidirezionale, chiusura con rilascio risorse, isolamento sessioni, errori chiari, comandi limitati ai permessi dell'account SSH).
- §3.5 FS remoto robot: RF-FS-001..007 (navigazione, elenco con metadati, download/upload streaming via backend, errori, operazioni limitate ai permessi; navigazione in sola lettura).
- §3.6 FS server: RF-SRVFS-001..007 (root configurata, directory per robot, upload/download, isolamento e anti path-traversal, preservazione file esistenti, sottodirectory standard configurabili).
- §3.7 Trasferimenti: RF-TRF-001..014 (computer-server, server-robot, computer-robot via backend, >1 GB streaming, avanzamento in tempo reale, errori, checksum, file temporanei, ripresa, sovrascrittura esplicita, limiti concorrenza, timeout/annullamento, controllo spazio disco).

## 5. Requisiti non funzionali (SRS §4)

- Sicurezza RNF-SEC-001..009 (HTTPS, protezione credenziali, verifica chiavi host, autorizzazione lato server, anti path-traversal, validazione host, isolamento sessioni, protezione temporanei, audit senza segreti).
- Filesystem RNF-FS-001..004 (permessi directory, separazione dati, operazioni distruttive con conferma, idempotenza).
- Prestazioni RNF-PERF-001..005 (file grandi a memoria costante, risorse controllate, concorrenza configurabile, polling configurabile, scalabilità flotta).
- Affidabilità RNF-REL-001..005 (disconnessioni, distinzione dato corrente/storico, recupero errori parziali, integrità file esistenti, pulizia risorse).
- Usabilità RNF-UX-001..004 (UI intuitiva, feedback operazioni, compatibilità browser, terminale interattivo senza plugin).
- Manutenibilità RNF-MNT-001..003 (parametri configurabili, separazione componenti, tracciabilità errori senza dati sensibili).

## 6. Dati e persistenza (SRS §10)

Per robot: id univoco, nome, username remoto, host, porta SSH, metodo auth, riferimento sicuro credenziali, parametri verifica host key, percorsi file di stato, percorso directory server, stato anagrafico, date, info ultima verifica. Stati distinti: anagrafico / connessione / operativo / ultimo aggiornamento valido / esito ultimo tentativo. Audit con utente, operazione, robot, esito, timestamp, senza segreti, retention configurabile.

## 7. Requisiti specifici aggiuntivi (sezione in coda all'SRS)

1. Sessione: inattività 30 min con pop-up di avviso 5 min prima, conteggio 4-3-2-1; terminale: inattività 15 min con pop-up 5 min prima. Username univoco. Terminale SSH solo Admin.
2. File di config all'avvio: tempo inattività web app, tempo attività terminale, max utenti contemporanei (base 10), max terminali contemporanei per robot (base 1), impostazioni caricamento massivo, limite file server/robot preimpostato 3 GB, parametri futuri (max robot, max accessi stesso account - da confermare).
3. Caricamento massivo su server e robot senza limite prefissato (parametro in config); pop-up conflitto sovrascrittura, annullamento interrompe senza modifiche.
4. Associazione Nome Cliente e Nome Impianto al robot (cliente obbligatorio, impianto opzionale), mostrati a schermo.
5. UI: barra filtri per Cliente/Impianto/Robot/ID, palette Bootstrap, logo = pulsante Home, frontend React.
6. Pop-up "Gestione File" con path selezionabile o digitabile su "Invia al robot"/"Invia al server"; verifica funzionamento config e limitazione path per operatore.
7. Pop-up inattività con due opzioni: Conferma (azzeramento timer) / Esci (logout immediato); se un trasferimento è in corso la sessione non termina.
8. Conferma pop-up su eliminazione; per cartelle il messaggio indica il numero di file eliminati.
9. Max 1 utente attivo per account (notifica "sessione già avviata"); pulsante terminale rimosso completamente per Operatore.
10. Sezione Logs per Admin: access.log (utente, livello, data/ora) e transfers.log (file, utente, data, ora, esito) con tag INIZIO/FINE CARICAMENTO MASSIVO per i caricamenti massivi.
11. Annullamento trasferimento massivo: file completati restano, file parziali interrotti ed eliminati (salvo quando il completamento è ormai prossimo), azione sull'intero blocco.

## 8. Punti aperti da confermare (SRS §11)

§11.1 organizzazione FS server (root, sottodirectory, permessi, conservazione, quote); §11.2 auth SSH (chiavi/password, vault, distribuzione chiavi, politica host key, restrizioni account); §11.3 registrazione (obbligatorietà verifica SSH, unicità, directory esistente, cambio username, disabilita/rimozione); §11.4 file di stato (percorsi, formato, polling, regole interpretazione, dati non validi); §11.5 trasferimenti (dimensione max, max simultanei, sovrascrittura, ripresa, checksum, retention temporanei, timeout/quote); §11.6 utenti e autorizzazioni (ruoli, permessi per funzione, timeout sessioni, éventuelle auth aggiuntiva come MFA); §11.7 prestazioni e capacità (numero robot/utenti/sessioni, volumi).

Vedi `02-DOMANDE-REFERENTE.md` per le domande aperte ancora da girare.
