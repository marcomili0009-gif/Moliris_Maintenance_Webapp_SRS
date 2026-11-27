# Moliris · Validazione infrastrutturale

**NO-GO al 25 novembre 2026.** Il collaudo SSH reale è bloccato prima dell’handshake. Il candidato funziona sull’istanza locale, mentre il profilo di produzione effettivo e il ripristino dei backup restano da validare. Questo report integra `MOLIRIS_RELEASE_BLOCKERS_REPORT.md` con verifiche mirate. Il codice applicativo, le unità installate, il firmware e le VM sono rimasti invariati.

## Virtualizzazione e VM

| Controllo | Esito ed evidenza |
|---|---|
| Supporto hardware | **Superato.** L’host è un HP ProBook 450 G2 con BIOS M73 01.15 e Intel Core i7-5500U. Intel dichiara il supporto VT-x per questa CPU. [Specifiche Intel](https://www.intel.com/content/www/us/en/products/sku/85214/intel-core-i75500u-processor-4m-cache-up-to-3-00-ghz/specifications.html) |
| Disponibilità a runtime | **Fallito.** CPUID non espone `vmx`. VirtualBox 7.2.22 riporta virtualizzazione hardware indisponibile. I log dell’ultimo avvio di entrambe le VM riportano `VERR_VMX_MSR_ALL_VMX_DISABLED`. `systemd-detect-virt` sul contesto host non rileva un hypervisor esterno. Le evidenze indicano il firmware come causa. |
| Conflitto con altri hypervisor | **Non rilevato nel controllo attuale.** Il driver `vboxdrv` è presente. Il modulo generico `kvm` è caricato senza utenti, il modulo `kvm_intel` e `/dev/kvm` sono assenti e non risultano processi QEMU o VMware. Verificare di nuovo dopo l’abilitazione di VT-x se VirtualBox segnala un conflitto. |
| Inventario | Le due VM candidate sono `robot ` con spazio finale (UUID `5f4eef50-de82-49bd-a3c5-36696e8b6dc6`) e `robot2` (UUID `f46d0f7d-de00-4694-91c0-084c8922ecfc`). Entrambe risultano `aborted`, scheda 1 NAT, scheda 2 assente, nessuna regola di forwarding visibile. L’istanza Moliris locale conta 0 robot registrati. L’associazione guest–robot–porta va verificata dalla console o dall’inventario del team. |
| Sistema operativo dei guest | VirtualBox le etichetta entrambe come Ubuntu 25.04 a 64 bit. La versione realmente installata è da verificare nella console. Se confermata, usare i guest per prove isolate. Ubuntu 25.04 è fuori supporto da gennaio 2026. [Note di rilascio Canonical](https://documentation.ubuntu.com/release-notes/25.04/) |

### Intervento manuale sul BIOS

1. Riavviare il ProBook. Al logo HP premere ripetutamente **Esc**, poi **F10** per entrare in **BIOS Setup**.
2. Cercare **Virtualization Technology (VTx)**. Sui BIOS HP con **System Configuration → Device Configurations** è in quel sottomenu. Sulle interfacce con **Advanced → System Options** cercarla lì. Impostarla su **Enabled**, salvare con **F10** e riavviare. La posizione esatta nel menu della revisione M73 01.15 resta da confermare a schermo. [Guida HP a VTx](https://support.hp.com/gb-en/document/ish_5637142-5637191-16) · [Procedura HP con menu System Configuration](https://support.hp.com/us-en/document/ish_9516425-9516742-16)
3. Dopo il riavvio, comunicare che VT-x è abilitato. Il primo controllo sarà `VBoxManage list hostinfo`, seguito dall’avvio delle VM di test. Il firmware è il prerequisito per proseguire con la configurazione dei guest.

## Esito del collaudo SSH reale

Il backend Moliris e il processo di diagnosi condividono lo stesso namespace di rete, `net:[4026531833]`. In quel namespace le sonde Node a **127.0.0.1:2223** e **127.0.0.1:2224** hanno entrambe restituito **ECONNREFUSED**. Le due VM sono ferme e le porte sono prive di listener. L’istanza Moliris locale è in modalità `rigorosa`.

| Passo | Esito |
|---|---|
| Connessione TCP dal contesto del backend | **Fallito** su entrambe le porte |
| Avvio guest, stato di `ssh.service` e forwarding | **Bloccato** finché VT-x resta indisponibile |
| Handshake, verifica dell’impronta, autenticazione | **Bloccato** prima dell’handshake |
| Registrazione rigorosa CA-ROB-003, terminale remoto, SFTP | **Non eseguito**, in attesa del guest reale |

Dopo il ripristino del firmware, identificare ciascun guest attraverso la console, controllare `systemctl status ssh` e il listener TCP 22. Configurare le regole NAT sull’adattatore 1 con bind **127.0.0.1**, porte host **2223** e **2224**, porta guest **22**, assegnando ciascuna regola al guest confermato. Per VirtualBox 7.2, il formato su VM spenta è `VBoxManage modifyvm "<UUID-confermato>" --nat-pf1 "moliris-ssh-2224,tcp,127.0.0.1,2224,,22"`. Ripetere la sonda dal namespace del backend, confrontare la chiave pubblica SSH presentata con l’impronta SHA-256 ottenuta dalla console fidata e usare un account di test autorizzato. Dopo la registrazione rigorosa, verificare PTY con un comando di sola lettura e SFTP scaricando un file di prova già esistente e confrontandone il checksum. [Guida Oracle alla rete NAT](https://docs.oracle.com/en/virtualization/virtualbox/7.2/user/networkingdetails.html)

## Topologia di produzione

| Area | Verificato localmente | Stato del profilo di produzione |
|---|---|---|
| Frontend e backend | **Superato.** L’unità utente `moliris-local-updated.service` su `127.0.0.1:8443` ha risposto HTTP 200 a `/healthz`. HTML, JS e CSS coincidono byte per byte con il build del workspace. | **Non validato.** L’unità di sistema `moliris.service` è inattiva. Il backend sotto `/opt/moliris` ha SHA-256 diverso dal candidato. L’host usa Ubuntu 26.04 e Node 22.22.1, mentre `DEPLOY.md` indica Node 24.x LTS. Avvio e smoke del candidato con la configurazione effettiva ancora da eseguire. |
| HTTPS, rete e reverse proxy | TLS locale risponde. Il certificato ha soggetto ed emittente `CN=localhost`, senza SAN. La prova con il trust store di sistema su `127.0.0.1` ha restituito codice curl **60**. Sulle porte 80/443 non ci sono listener. | **Non validato.** La guida prevede accesso HTTPS diretto via rete protetta o VPN. L’installer locale configura il bind a loopback. Occorre confermare l’accesso previsto nel deployment e verificare DNS, catena della CA e nome del certificato. Se il deployment include un proxy, verificare passaggio WSS, streaming SSE e policy di rete dal percorso reale. |
| MongoDB | Il backend utente usa Mongo su `127.0.0.1:27017`. Una lettura sul suo DB è riuscita senza identità autenticata. | **Parziale.** Il servizio dedicato su `127.0.0.1:27018` risponde a `ping`, imposta `authorization: enabled` e rifiuta una query anonima con errore MongoDB **13**. L’accesso con il ruolo applicativo reale resta da provare. |
| Vault e segreti | Il profilo locale usa il provider Mongo. La chiave master locale è leggibile dal processo di verifica e ha proprietario e permessi compatibili con il loader. | **Non validato.** La directory `/etc/moliris` è `0750 root:moliris`. L’utente di diagnosi non ha accesso ai file riservati. L’installer prevede credenziali protette, chiave master separata a `0600` e vault Mongo. Verificare lettura di una credenziale di prova sotto l’identità del servizio. La guida manuale e l’installer indicano permessi differenti per la directory dei certificati. Verificare la traversabilità per `moliris`. |
| Log e unità systemd | **Controllo statico superato.** `systemd-analyze verify` restituisce 0 per il modello e per le unità installate. | **Blocco di configurazione da risolvere.** Il modello candidato usa `LogsDirectory=moliris` con utente `moliris`. Sul sistema `/var/log/moliris` appartiene a `mongodb:mongodb` ed è la destinazione del log MongoDB. Installare e avviare quel modello può cambiare ricorsivamente la proprietà della directory, ostacolando l’accesso di MongoDB. Separare i log dei due servizi prima del deploy e verificare scrittura e riavvio di entrambi. [Semantica di LogsDirectory](https://freedesktop.org/software/systemd/man/latest/systemd.exec.html) |
| Destinazioni SSH | Il profilo utente è rigoroso, senza allowlist e senza limite assoluto configurato. | La produzione richiede allowlist esplicita, limite assoluto configurato e verifica della chiave host. L’installer parte da `MOLIRIS_ALLOWED_DESTINATIONS=none`, che nega tutte le destinazioni. Occorrono l’inventario autorizzato con impronte fidate e una prova di egress dal backend effettivo. |
| Backup e ripristino | Sono disponibili `mongodump` e `mongorestore`. Tra i timer visibili e nei file di deploy esaminati non è emersa una procedura di backup Moliris. | **Non verificato.** Serve evidenza di backup verificabile di database e filesystem applicativo, custodia separata della master key, retention, RPO/RTO e prova di ripristino isolata con lettura di una credenziale di prova. I contenuti dei backup di produzione non sono stati consultati. |

## Condizioni per rivalutare l’esito

Abilitare VT-x e completare il collaudo SSH rigoroso sul guest identificato o sul robot autorizzato. Sul deployment di rilascio, separare le directory log, installare il build verificato, collaudare HTTPS, configurazione effettiva di Mongo/vault, rete e ripristino. Le verifiche sono state eseguite in sola lettura con timeout. Non sono state utilizzate fixture per il collaudo reale. Nessun commit o push.
