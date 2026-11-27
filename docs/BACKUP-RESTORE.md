# Backup e ripristino coordinato Moliris

## Inventario e punto di consistenza

Raccogliere dall’unità effettiva e dalle variabili di configurazione i percorsi di database, root server, archivio generale, log, configurazione e chiavi. Includere manifest del runtime, checksum, configurazioni applicative JSON, file di ambiente e metadati dell’unità e dei suoi drop-in. Per MongoDB includere anagrafica, utenti applicativi, audit, telemetria, credenziali cifrate e la raccolta `transfer_log_outcomes`. Conservare nella copia del filesystem anche archivi storici e `.transfer-log-pending`. Per utenti e ruoli MongoDB che il dump applicativo non include, documentare il provisioning approvato e la relativa custodia.

Per ottenere un punto coerente tra MongoDB e filesystem, concordare una finestra e sospendere nuovi accessi e trasferimenti. Attendere il completamento oppure l’annullamento registrato. Con l’applicazione ferma e MongoDB disponibile per il dump, bloccare anche eventuali altri scrittori autorizzati per l’intera acquisizione, o usare un meccanismo di snapshot concordato dal responsabile del database. Registrare ora UTC, esiti e servizio effettivo. La semplice acquisizione di due copie a istanti diversi lascia aperta la coerenza.

## Acquisizione

1. Con un’identità di backup autorizzata, usare `mongodump --archive` per il namespace applicativo. Conservare il riferimento all’origine tramite un file di configurazione privato per gli strumenti MongoDB. Evitare credenziali nei comandi, nei log e nell’archivio consegnato.
2. Archiviare root server, archivio generale, log e configurazione in un contenitore che preservi modi e proprietari. Registrare il mapping dei percorsi e verificare inclusione di symlink autorizzati, residui pending e archivi numerati. Raccogliere i checksum SHA-256 di dump e archivi, controllare che siano leggibili e cifrare i backup prima del trasferimento.
3. Affidare le copie della master key del vault, delle credenziali di ripristino, delle chiavi e dei file ambiente a un archivio segreti separato con controllo accessi e processo di recupero verificato. Registrare riferimenti, mapping versione della chiave e consensi. La perdita della master key rende inutilizzabili le credenziali SSH cifrate ripristinate.
4. Definire con IT frequenza, retention, destinazione fuori host, copie immutabili, allarmi per spazio ed errori, RPO/RTO e responsabile del collaudo. Annotare il tempo reale per ogni prova. Le rotazioni applicative di `access.log` e `transfers.log` conservano gli archivi; un’eventuale eliminazione è affidata a una policy aziendale esplicita.

## Prova di ripristino isolata

Usare directory nuove e un’istanza MongoDB di prova separata. Vietare route verso i robot operativi e configurare `MOLIRIS_ALLOWED_DESTINATIONS=none`. Verificare checksum prima di aprire gli archivi.

1. Ripristinare il database in un nuovo namespace usando `mongorestore --archive` e un mapping esplicito `--nsFrom` / `--nsTo`. Verificare conteggi attesi, indici, un account di prova e una credenziale sintetica decifrata con la chiave corrispondente custodita separatamente.
2. Estrarre l’archivio in una nuova root, controllare permessi, hash di campioni, configurazione e log, poi indicare queste directory in una copia di configurazione di collaudo. Se gli ID robot contengono riferimenti assoluti alla root originale, validarli o riallinearli nella sola istanza di prova. Documentare checksum e tempo di ogni passaggio.
3. Avviare il binario candidato con un certificato di fixture e trust limitato all’ambiente di test. Verificare liveness/readiness, login, flotta e consultazione log. Distinguere il ripristino del runtime dal ripristino dei dati e provare entrambi. Registrare RPO/RTO misurati e qualsiasi evento rimasto in sospeso.
