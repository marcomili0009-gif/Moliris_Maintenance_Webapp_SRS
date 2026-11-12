# Guida di Installazione e Avvio in Produzione (Deploy)

La presente guida descrive i requisiti e la procedura standard per l'installazione, la configurazione e la gestione del servizio **Moliris Maintenance Webapp** su server **Ubuntu 26.04 LTS**, in conformità ai requisiti normativi della SRS v1.0 (§2.3, §2.4, §2.5, §11, RNF-SEC-001..009).

---

## 1. Requisiti di Sistema e Prerequisiti

### Ambiente di Rete e Sicurezza (§2.4, §2.5)
- **Sistema Operativo**: Ubuntu 26.04 LTS (x86_64).
- **Rete**: Server connesso alla rete locale protetta / VPN Moliris.
- **Porte in ingresso**: Porta 8443 (HTTPS/WSS) aperta unicamente verso gli operatori di rete autorizzati.
- **Porte in uscita**: Porta 22 (o porte SSH/SFTP configurate per i robot) verso i dispositivi della flotta.

### Dipendenze Software di Sistema
- **Node.js**: v24.x LTS (o versione con supporto nativo a `--experimental-strip-types`).
- **MongoDB**: v6.0+ / v7.0+ (servizio `mongod.service`).
- **OpenSSL**: per la gestione dei certificati TLS.

Installazione prerequisiti su Ubuntu 26.04:
```bash
sudo apt-get update
sudo apt-get install -y curl gnupg openssl

# Installazione Node.js 24.x
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs

# Installazione MongoDB
sudo apt-get install -y mongodb-org || sudo apt-get install -y mongodb
sudo systemctl enable --now mongod
```

### Abilitare l'autenticazione MongoDB

Abilitare l'autenticazione in `/etc/mongod.conf`:
```yaml
security:
  authorization: enabled
```
Riavviare MongoDB con `sudo systemctl restart mongod`. Al primo accesso, la localhost exception consente di creare un solo utente iniziale nel database `admin`, che deve poter gestire gli utenti. Crearlo con una password robusta richiesta interattivamente:
```bash
mongosh
```
Nel prompt MongoDB:
```javascript
use admin
db.createUser({
  user: "moliris_user_admin",
  pwd: passwordPrompt(),
  roles: [{ role: "userAdminAnyDatabase", db: "admin" }]
})
```
Riconnettersi autenticandosi con questo account e creare l'utente applicativo con permessi limitati:
```bash
mongosh -u moliris_user_admin --authenticationDatabase admin
```
```javascript
use moliris_maintenance
db.createUser({
  user: "moliris_app",
  pwd: passwordPrompt(),
  roles: [{ role: "readWrite", db: "moliris_maintenance" }]
})
```
Configurare l'URI applicativa con le credenziali di `moliris_app`; codificare i caratteri speciali della password secondo la codifica URL e conservarla solo nel file ambiente protetto. La documentazione MongoDB spiega che il primo utente va creato in `admin` e deve avere privilegi di gestione utenti ([localhost exception](https://www.mongodb.com/docs/manual/core/localhost-exception/)).

---

## 2. Creazione Utente di Servizio e Cartelle Dedicate

In conformità al principio del privilegio minimo (RNF-SEC-004, RNF-FS-001):
```bash
# Creazione utente e gruppo di sistema non privilegiato
sudo useradd --system --shell /usr/sbin/nologin --comment "Moliris Service Account" moliris

# Creazione alberatura di runtime
sudo mkdir -p /var/lib/moliris/server-fs
sudo mkdir -p /etc/moliris/certs
sudo mkdir -p /opt/moliris/Moliris_Maintenance_Webapp_SRS

# Assegnazione permessi rigorosi
sudo chown -R moliris:moliris /var/lib/moliris
sudo chmod 750 /var/lib/moliris/server-fs
sudo chown -R root:moliris /etc/moliris
sudo chmod 750 /etc/moliris
sudo chmod 700 /etc/moliris/certs
sudo install -d -o moliris -g moliris -m 700 /etc/moliris/keys
```

---

## 3. Installazione e Compilazione dell'Applicazione

Clonazione o copia del codice sorgente in `/opt/moliris/Moliris_Maintenance_Webapp_SRS`:
```bash
cd /opt/moliris/Moliris_Maintenance_Webapp_SRS
sudo npm ci
sudo npm run build
sudo chown -R root:root /opt/moliris/Moliris_Maintenance_Webapp_SRS
```

---

## 4. Generazione o Installazione Certificati TLS (§2.4 punto 3, RNF-SEC-001)

L'applicazione rifiuta categoricamente connessioni HTTP in chiaro e non si avvia se i certificati non sono presenti.

Per generare un certificato conforme o installare il certificato di produzione aziendale:
```bash
# Esempio certificato emesso dalla CA interna aziendale (o autofirmato per collaudo)
sudo openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
  -keyout /etc/moliris/certs/key.pem \
  -out /etc/moliris/certs/cert.pem \
  -subj "/CN=moliris.local/O=Moliris/OU=Maintenance"

sudo chown -R root:moliris /etc/moliris/certs
sudo chmod 640 /etc/moliris/certs/*
```

Generare la master key AES-256 nel percorso configurato. Il file deve appartenere all'utente del servizio e avere permessi `0600`:
```bash
sudo -u moliris openssl rand -out /etc/moliris/keys/master.key 32
sudo chmod 600 /etc/moliris/keys/master.key
```

---

## 5. Configurazione d'Ambiente (`/etc/moliris/moliris.env`)

Copiare il template `.env.example` nella configurazione di produzione:
```bash
sudo cp /opt/moliris/Moliris_Maintenance_Webapp_SRS/.env.example /etc/moliris/moliris.env
sudo chown root:moliris /etc/moliris/moliris.env
sudo chmod 640 /etc/moliris/moliris.env
```

Verificare i parametri obbligatori in `/etc/moliris/moliris.env`:
```ini
NODE_ENV=production
MOLIRIS_FS_ROOT=/var/lib/moliris/server-fs
MOLIRIS_TLS_CERT_PATH=/etc/moliris/certs/cert.pem
MOLIRIS_TLS_KEY_PATH=/etc/moliris/certs/key.pem
MOLIRIS_REGISTRATION_MODE=rigorosa
MOLIRIS_SESSION_TIMEOUT_MIN=30
MOLIRIS_AUDIT_RETENTION_DAYS=90
MOLIRIS_MONGODB_URI=mongodb://moliris_app:<PASSWORD_URL_ENCODED>@127.0.0.1:27017/moliris_maintenance?authSource=moliris_maintenance
MOLIRIS_SERVER_PORT=8443
MOLIRIS_SERVER_HOST=0.0.0.0
```

---

## 6. Provisioning Utenti Iniziali (`seed-users.ts`)

Per creare gli account amministrativi e operatori iniziali nel database MongoDB:
```bash
cd /opt/moliris/Moliris_Maintenance_Webapp_SRS

# Creare un file leggibile solo dall'utente di servizio e inserire password uniche
sudo install -o moliris -g moliris -m 600 /dev/null /var/lib/moliris/seed_passwords.env
sudo -u moliris nano /var/lib/moliris/seed_passwords.env
# Formato del file:
# MOLIRIS_INITIAL_ADMIN_PASSWORD=<password unica>
# MOLIRIS_INITIAL_OPERATOR_PASSWORD=<password unica>

sudo -u moliris bash -c 'set -a; source /etc/moliris/moliris.env; set +a; NODE_ENV=production node --experimental-strip-types scripts/seed-users.ts --password-file /var/lib/moliris/seed_passwords.env'
sudo rm -f /var/lib/moliris/seed_passwords.env
```

Output atteso:
```
Provisioning completato con successo.
- admin (amministratore)
- operatore (operatore)
```

---

## 7. Installazione e Gestione del Servizio systemd (`moliris.service`)

Installare il file di unità systemd:
```bash
sudo cp /opt/moliris/Moliris_Maintenance_Webapp_SRS/moliris.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable moliris.service
sudo systemctl start moliris.service
```

### Comandi Operativi
- **Stato del servizio**: `sudo systemctl status moliris`
- **Riavvio del servizio**: `sudo systemctl restart moliris`
- **Arresto del servizio**: `sudo systemctl stop moliris`
- **Consultazione log in tempo reale**: `sudo journalctl -u moliris -f`

---

## 8. Procedura di Collaudo e Verifica Post-Deploy

1. **Verifica Endpoint Salute (Healthz)**:
   ```bash
   curl -k https://127.0.0.1:8443/healthz
   # Risposta: {"status":"ok","timestamp":"...","uptime":...}
   ```

2. **Accesso da Browser Google Chrome (§2.5)**:
   - Aprire Google Chrome e navigare su `https://<ip-server>:8443`.
   - Autenticarsi con l'utente `admin` o `operatore`.
   - Verificare la corretta apertura della dashboard flotta e dei relativi moduli (Terminale PTY, Navigazione Filesystem, Trasferimenti File).
