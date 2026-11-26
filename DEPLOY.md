# Guida di Installazione, Deploy e Migrazione in Produzione

Questa guida descrive la procedura operativa per installare, aggiornare e migrare **Moliris Maintenance Webapp** su server Linux (Ubuntu 24.04 / 26.04 LTS), sia in modalità **servizio di sistema (`sudo` + utente dedicato `moliris`)** sia in modalità **utente senza `sudo` (`systemd --user`)**.

---

## 1. Requisiti di Sistema e Rete

- **Sistema Operativo**: Ubuntu 24.04 / 26.04 LTS (x86_64).
- **Software**: Node.js ≥ 20 (consigliato v24 LTS), `npm`, MongoDB 6.0+ / 7.0+, `openssl`, `rsync`.
- **Porte in ingresso**: `8443/tcp` (HTTPS/WSS) accessibile solo agli operatori autorizzati.
- **Porte in uscita**: `22/tcp` (o porte SSH/SFTP configurate) verso gli IP dei robot autorizzati in `MOLIRIS_ALLOWED_DESTINATIONS`.

### Installazione prerequisiti (con `sudo`)
```bash
sudo apt-get update
sudo apt-get install -y curl gnupg openssl rsync

# Node.js 24.x LTS
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs

# MongoDB
sudo apt-get install -y mongodb-org || sudo apt-get install -y mongodb
sudo systemctl enable --now mongod
```

### Autenticazione MongoDB (consigliata in produzione)
Abilitare in `/etc/mongod.conf`:
```yaml
security:
  authorization: enabled
```
Riavviare con `sudo systemctl restart mongod`, poi creare l'amministratore e l'utente applicativo `moliris_app`:
```bash
mongosh
```
```javascript
use admin
db.createUser({
  user: "moliris_user_admin",
  pwd: passwordPrompt(),
  roles: [{ role: "userAdminAnyDatabase", db: "admin" }]
})
```
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

---

## 2. Deploy Standard di Produzione (con `sudo` e `systemd` di sistema)

### 2.1 Utente di servizio e directory dedicate
```bash
sudo useradd --system --shell /usr/sbin/nologin --comment "Moliris Service Account" moliris

sudo mkdir -p /opt/moliris/Moliris_V1.0
sudo mkdir -p /var/lib/moliris/server-fs
sudo mkdir -p /var/log/moliris
sudo mkdir -p /etc/moliris/certs
sudo install -d -o moliris -g moliris -m 700 /etc/moliris/keys

sudo chown -R moliris:moliris /var/lib/moliris /var/log/moliris
sudo chmod 750 /var/lib/moliris/server-fs
sudo chmod 700 /var/log/moliris
sudo chown -R root:moliris /etc/moliris
sudo chmod 750 /etc/moliris
sudo chmod 700 /etc/moliris/certs
```

### 2.2 Trasferimento codice e build
Dal PC locale:
```bash
rsync -avz --progress /home/mmilitello/Scrivania/Moliris_V1.0/ UTENTE@IP_SERVER:/tmp/Moliris_V1.0/
```
Sul server:
```bash
sudo rsync -av --delete /tmp/Moliris_V1.0/ /opt/moliris/Moliris_V1.0/
rm -rf /tmp/Moliris_V1.0
cd /opt/moliris/Moliris_V1.0
sudo npm ci && sudo npm run build && sudo npm prune --omit=dev
sudo chown -R root:root /opt/moliris/Moliris_V1.0
```

### 2.3 Certificati TLS e Master Key (32 byte raw)
```bash
# Certificato aziendale o autofirmato di collaudo
sudo openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
  -keyout /etc/moliris/certs/key.pem \
  -out /etc/moliris/certs/cert.pem \
  -subj "/CN=moliris.local/O=Moliris/OU=Maintenance"
sudo chown -R root:moliris /etc/moliris/certs
sudo chmod 640 /etc/moliris/certs/*

# Master key AES-256: ESATTAMENTE 32 byte raw (non base64), permessi 0600
sudo -u moliris openssl rand -out /etc/moliris/keys/master.key 32
sudo chmod 600 /etc/moliris/keys/master.key
```

### 2.4 File d'ambiente (`/etc/moliris/moliris.env`)
```bash
sudo cp /opt/moliris/Moliris_V1.0/.env.example /etc/moliris/moliris.env
sudo chown root:moliris /etc/moliris/moliris.env
sudo chmod 640 /etc/moliris/moliris.env
sudo nano /etc/moliris/moliris.env
```
Parametri essenziali da impostare:
```ini
NODE_ENV=production
MOLIRIS_FS_ROOT=/var/lib/moliris/server-fs
MOLIRIS_LOGS_DIR=/var/log/moliris
MOLIRIS_TLS_CERT_PATH=/etc/moliris/certs/cert.pem
MOLIRIS_TLS_KEY_PATH=/etc/moliris/certs/key.pem
MOLIRIS_CREDENTIAL_PROVIDER=mongo
MOLIRIS_MASTER_KEY_FILE=/etc/moliris/keys/master.key
MOLIRIS_MONGODB_URI=mongodb://moliris_app:<PASSWORD_URL_ENCODED>@127.0.0.1:27017/moliris_maintenance?authSource=moliris_maintenance
MOLIRIS_SERVER_PORT=8443
MOLIRIS_SERVER_HOST=0.0.0.0
# Inserire gli IP o hostname esatti dei robot separati da virgola (es. 192.168.32.50,192.168.32.51).
# Usare "none" solo se non ci sono ancora robot da contattare.
MOLIRIS_ALLOWED_DESTINATIONS=none
```

### 2.5 Provisioning utenti iniziali (solo al primo deploy su DB vuoto)
```bash
cd /opt/moliris/Moliris_V1.0
sudo install -o moliris -g moliris -m 600 /dev/null /var/lib/moliris/seed_passwords.env
sudo -u moliris nano /var/lib/moliris/seed_passwords.env
# Inserire:
# MOLIRIS_INITIAL_ADMIN_PASSWORD=<password_complessa_admin>
# MOLIRIS_INITIAL_OPERATOR_PASSWORD=<password_complessa_operatore>

sudo -u moliris bash -c 'set -a; source /etc/moliris/moliris.env; set +a; node dist/scripts/seed-users.js --password-file /var/lib/moliris/seed_passwords.env'
sudo rm -f /var/lib/moliris/seed_passwords.env
```

### 2.6 Servizio `systemd` (`moliris.service`)
Verificare che `WorkingDirectory` e `ReadOnlyPaths` in `moliris.service` puntino al percorso reale (es. `/opt/moliris/Moliris_V1.0`), quindi installare e avviare:
```bash
sudo cp /opt/moliris/Moliris_V1.0/moliris.service /etc/systemd/system/moliris.service
sudo systemctl daemon-reload
sudo systemctl enable --now moliris.service
sudo systemctl status moliris.service --no-pager
```

---

## 3. Deploy Alternativo in Home Utente senza `sudo` (`systemd --user`)

Utile su server di staging/collaudo dove l'utente (es. `stage`) non dispone di `sudo` ma ha `Linger=yes` attivo (`loginctl show-user "$USER" | grep Linger`).

```bash
# 1. Directory di runtime nella home
mkdir -p "$HOME/moliris/app" "$HOME/moliris/server-fs" "$HOME/moliris/logs" "$HOME/moliris/keys" "$HOME/moliris/certs"
chmod 700 "$HOME/moliris/keys" "$HOME/moliris/logs"

# 2. Master key (32 byte raw) e certificato TLS
openssl rand 32 > "$HOME/moliris/keys/master.key"
chmod 600 "$HOME/moliris/keys/master.key"
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout "$HOME/moliris/certs/key.pem" \
  -out "$HOME/moliris/certs/cert.pem" \
  -days 365 -subj "/CN=<IP_SERVER>"
chmod 600 "$HOME/moliris/certs/key.pem"

# 3. Configura "$HOME/moliris/app/.env" (chmod 600) e compila
cd "$HOME/moliris/app"
npm ci && npm run build && npm prune --omit=dev

# 4. Servizio systemd utente permanente (sopravvive alla chiusura SSH e al reboot)
mkdir -p "$HOME/.config/systemd/user"
NODE_BIN="$(command -v node)"
cat << EOF > "$HOME/.config/systemd/user/moliris.service"
[Unit]
Description=Moliris Maintenance Webapp
After=network.target

[Service]
Type=simple
WorkingDirectory=$HOME/moliris/app
ExecStart=${NODE_BIN} --import dotenv/config dist/backend/server.js
Restart=on-failure
RestartSec=5
StandardOutput=append:$HOME/moliris/logs/server.out
StandardError=append:$HOME/moliris/logs/server.out

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now moliris.service
systemctl --user status moliris.service --no-pager
```

---

## 4. Migrazione / Ripristino Database da un Altro Server

1. **Export sul server di origine**:
   ```bash
   mongodump --uri="$MOLIRIS_MONGODB_URI" --archive="$HOME/moliris_db.archive.gz" --gzip
   ```
2. **Import sul server di destinazione**:
   ```bash
   mongorestore --archive="$HOME/moliris_db.archive.gz" --gzip --drop
   ```
3. **Master key e credenziali robot**:
   - Copiare in modo sicuro la stessa `master.key` (`0600`) sul nuovo server **oppure** ricifrare le credenziali con `node --import dotenv/config dist/scripts/reencrypt-credentials.js` (o reinserirle dall'interfaccia web).
4. **Allineamento percorsi su nuovo `MOLIRIS_FS_ROOT`**:
   ```bash
   cd <CARTELLA_APP>
   node --import dotenv/config dist/scripts/migrate-robot-directories.js --dry-run
   node --import dotenv/config dist/scripts/migrate-robot-directories.js --apply
   ```
5. **Verifica `.env`**: aggiornare `MOLIRIS_ALLOWED_DESTINATIONS` con gli IP/hostname reali dei robot raggiungibili dal nuovo server e `MOLIRIS_MONGODB_URI` con le credenziali del nuovo DB, quindi riavviare il servizio.

---

## 5. Aggiornamento di un'Installazione Esistente

Dal PC locale (proteggendo `.env`, `node_modules` e `dist`):
```bash
rsync -avz --progress --delete \
  --exclude='.env' \
  --exclude='node_modules' \
  --exclude='dist' \
  /home/mmilitello/Scrivania/Moliris_V1.0/ \
  UTENTE@IP_SERVER:<CARTELLA_APP>/
```

Sul server:
```bash
cd <CARTELLA_APP>
# Fermare il servizio (systemd di sistema o --user)
npm ci && npm run build && npm prune --omit=dev
# Riavviare il servizio
```

---

## 6. Verifica Post-Deploy

1. **Controllo endpoint HTTPS**:
   ```bash
   curl -sk https://127.0.0.1:8443/healthz
   ```
2. **Controllo stato servizio e log**:
   - Sistema: `sudo systemctl status moliris.service` e `sudo journalctl -u moliris.service -n 50`
   - Utente: `systemctl --user status moliris.service` e `tail -n 30 "$HOME/moliris/logs/server.out"`
3. **Accesso browser**: aprire `https://<IP_SERVER>:8443` da Google Chrome, accedere con `admin` o `operatore` e verificare Flotta, Gestione File/Trasferimenti e Terminale PTY.
