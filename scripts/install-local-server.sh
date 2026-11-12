#!/usr/bin/env bash
set -Eeuo pipefail

# Installazione locale di collaudo: MongoDB isolato e autenticato, app su loopback.
# Avvio: pkexec bash /percorso/Moliris_Maintenance_Webapp_SRS/scripts/install-local-server.sh

PROJECT_DIR="$(cd -- "$(dirname -- "$0")/.." && pwd)"
APP_DIR=/opt/moliris/Moliris_Maintenance_Webapp_SRS
DATA_DIR=/var/lib/moliris
CONFIG_DIR=/etc/moliris
LOG_DIR=/var/log/moliris
STAGE_DIR=
die() { printf 'ERRORE: %s\n' "$*" >&2; exit 1; }
cleanup() { if [[ -n "$STAGE_DIR" && -d "$STAGE_DIR" ]]; then rm -rf -- "$STAGE_DIR"; fi; }
trap cleanup EXIT

CALLER_UID="$(printenv PKEXEC_UID || true)"
[[ "$EUID" -eq 0 && -n "$CALLER_UID" ]] || die "Avviare con pkexec dal terminale del server."
CALLER_NAME="$(getent passwd "$CALLER_UID" | cut -d: -f1)"
CALLER_HOME="$(getent passwd "$CALLER_UID" | cut -d: -f6)"
[[ -n "$CALLER_NAME" && "$CALLER_NAME" != root && -d "$CALLER_HOME" ]] || die "Account utente non identificato."
[[ -f "$PROJECT_DIR/.env" ]] || die "Manca .env locale."
[[ -f "$PROJECT_DIR/dist/backend/server.js" && -f "$PROJECT_DIR/dist/frontend/index.html" ]] || die "Build dist assente."
[[ -x /usr/bin/mongod && -x /usr/bin/node && -x /usr/bin/curl && -x /usr/bin/openssl ]] || die "Mancano mongod, node, curl o openssl."
[[ -d "$PROJECT_DIR/node_modules/dotenv" ]] || die "Dipendenza dotenv assente."
getent passwd mongodb >/dev/null || die "Utente mongodb non trovato."
for target in "$APP_DIR" "$CONFIG_DIR" "$DATA_DIR" "$LOG_DIR" /etc/mongod-moliris.conf \
  /etc/systemd/system/moliris-mongodb.service /etc/systemd/system/moliris.service.d \
  "$CALLER_HOME/.moliris-local-credentials.txt"; do
  [[ ! -e "$target" ]] || die "Percorso già esistente: $target. Non sovrascrivo."
done
getent passwd moliris >/dev/null && die "Utente moliris già esistente."
getent group moliris >/dev/null && die "Gruppo moliris già esistente."
python3 - <<'PY'
import socket
for port in (27018, 8443):
    sock = socket.socket()
    try: sock.bind(("127.0.0.1", port))
    except OSError: raise SystemExit("Porta 27018 o 8443 già occupata; nessuna modifica avviata.")
    finally: sock.close()
PY

read_env_value() {
  (cd "$PROJECT_DIR" && node -e '
    const fs=require("node:fs"), dotenv=require("dotenv");
    const env=dotenv.parse(fs.readFileSync(process.argv[1],"utf8"));
    if(!env[process.argv[2]]) process.exit(2);
    process.stdout.write(env[process.argv[2]]);
  ' "$PROJECT_DIR/.env" "$1")
}
TLS_CERT_SOURCE="$(read_env_value MOLIRIS_TLS_CERT_PATH)" || die "Certificato TLS assente."
TLS_KEY_SOURCE="$(read_env_value MOLIRIS_TLS_KEY_PATH)" || die "Chiave TLS assente."
MASTER_KEY_SOURCE="$(read_env_value MOLIRIS_MASTER_KEY_FILE)" || die "Master key assente."
node - "$TLS_CERT_SOURCE" "$TLS_KEY_SOURCE" "$MASTER_KEY_SOURCE" <<'NODE'
const fs=require("node:fs");
const {X509Certificate,createPrivateKey}=require("node:crypto");
const [certPath,keyPath,masterPath]=process.argv.slice(2);
const cert=new X509Certificate(fs.readFileSync(certPath));
if(!cert.checkPrivateKey(createPrivateKey(fs.readFileSync(keyPath)))) throw Error("Certificato e chiave TLS non corrispondono.");
if(Date.parse(cert.validTo)-Date.now()<30*86400000) throw Error("Certificato TLS in scadenza entro 30 giorni.");
const stat=fs.statSync(masterPath), raw=fs.readFileSync(masterPath), hex=raw.toString("utf8").trim();
if(!stat.isFile()||(stat.mode&0o177)!==0) throw Error("Master key deve essere file regolare con permessi 0600.");
if(raw.length!==32&&!(hex.length===64&&/^[0-9a-fA-F]{64}$/.test(hex))) throw Error("Dimensione master key non valida.");
NODE

STAGE_DIR="$(mktemp -d /tmp/moliris-install.XXXXXX)"
chown "$CALLER_NAME" "$STAGE_DIR"
tar -C "$PROJECT_DIR" --exclude=.git --exclude=.env --exclude=node_modules -cf - . | tar -C "$STAGE_DIR" -xf -
chown -R "$CALLER_NAME" "$STAGE_DIR"
runuser -u "$CALLER_NAME" -- bash -c 'cd "$1" && npm ci --omit=dev' _ "$STAGE_DIR"

DB_ADMIN_PASSWORD="$(openssl rand -hex 32)"
DB_APP_PASSWORD="$(openssl rand -hex 32)"
ADMIN_PASSWORD="$(openssl rand -hex 24)"
OPERATOR_PASSWORD="$(openssl rand -hex 24)"
useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin moliris
install -d -o root -g root -m 0755 /opt/moliris "$DATA_DIR"
mv -- "$STAGE_DIR" "$APP_DIR"
STAGE_DIR=
chown -R root:root "$APP_DIR"
install -d -o moliris -g moliris -m 0750 "$DATA_DIR/server-fs"
install -d -o mongodb -g mongodb -m 0750 "$DATA_DIR/mongodb" "$LOG_DIR"
install -d -o root -g moliris -m 0750 "$CONFIG_DIR" "$CONFIG_DIR/certs" "$CONFIG_DIR/keys"
install -o root -g moliris -m 0644 "$TLS_CERT_SOURCE" "$CONFIG_DIR/certs/cert.pem"
install -o root -g moliris -m 0640 "$TLS_KEY_SOURCE" "$CONFIG_DIR/certs/key.pem"
install -o moliris -g moliris -m 0600 "$MASTER_KEY_SOURCE" "$CONFIG_DIR/keys/master.key"

cat > /etc/mongod-moliris.conf <<'YAML'
systemLog:
  destination: file
  logAppend: true
  path: /var/log/moliris/mongod.log
storage:
  dbPath: /var/lib/moliris/mongodb
net:
  port: 27018
  bindIp: 127.0.0.1
security:
  authorization: enabled
YAML
chown root:root /etc/mongod-moliris.conf
chmod 0644 /etc/mongod-moliris.conf
cat > /etc/systemd/system/moliris-mongodb.service <<'UNIT'
[Unit]
Description=Moliris isolated MongoDB (loopback, authenticated)
After=network.target
[Service]
Type=simple
User=mongodb
Group=mongodb
ExecStart=/usr/bin/mongod --config /etc/mongod-moliris.conf
Restart=on-failure
RestartSec=5
LimitNOFILE=65536
NoNewPrivileges=true
UMask=0077
CapabilityBoundingSet=
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
ReadWritePaths=/var/lib/moliris/mongodb /var/log/moliris
RestrictAddressFamilies=AF_INET AF_UNIX AF_NETLINK
SystemCallArchitectures=native
StandardOutput=journal
StandardError=journal
SyslogIdentifier=moliris-mongodb
[Install]
WantedBy=multi-user.target
UNIT
chown root:root /etc/systemd/system/moliris-mongodb.service
chmod 0644 /etc/systemd/system/moliris-mongodb.service
umask 077
printf 'MONGO_ADMIN_USER=moliris_db_admin\nMONGO_ADMIN_PASSWORD=%s\n' "$DB_ADMIN_PASSWORD" > "$CONFIG_DIR/mongodb-admin.env"
chown root:root "$CONFIG_DIR/mongodb-admin.env"
chmod 0600 "$CONFIG_DIR/mongodb-admin.env"

cat > "$CONFIG_DIR/moliris.env" <<ENV
NODE_ENV=production
MOLIRIS_FS_ROOT=$DATA_DIR/server-fs
MOLIRIS_TLS_CERT_PATH=$CONFIG_DIR/certs/cert.pem
MOLIRIS_TLS_KEY_PATH=$CONFIG_DIR/certs/key.pem
MOLIRIS_MASTER_KEY_FILE=$CONFIG_DIR/keys/master.key
MOLIRIS_CREDENTIAL_PROVIDER=mongo
MOLIRIS_MONGODB_URI="mongodb://moliris_app:$DB_APP_PASSWORD@127.0.0.1:27018/moliris_maintenance?authSource=moliris_maintenance"
MOLIRIS_ALLOWED_DESTINATIONS=none
MOLIRIS_SERVER_HOST=127.0.0.1
MOLIRIS_SERVER_PORT=8443
MOLIRIS_REGISTRATION_MODE=rigorosa
MOLIRIS_SESSION_TIMEOUT_MIN=30
MOLIRIS_SESSION_ABSOLUTE_MAX_MIN=480
MOLIRIS_AUDIT_RETENTION_DAYS=90
MOLIRIS_POLLING_INTERVAL_SEC=60
MOLIRIS_SSH_TIMEOUT_MS=5000
MOLIRIS_MAX_TRF_PER_USER=3
MOLIRIS_MAX_TRF_PER_ROBOT=2
MOLIRIS_MAX_TRF_SERVER=10
MOLIRIS_TEMP_RETENTION_MIN=60
MOLIRIS_STATE_FILE_PATHS=$DATA_DIR/server-fs/status.txt
MOLIRIS_DEFAULT_OPERATOR_ALLOWED_PATHS=/upload,/shared,/logs,/backups
MOLIRIS_DIR_PERMISSIONS=0750
MOLIRIS_ALLOWED_SSH_AUTH_METHODS=key,password
ENV
chown root:moliris "$CONFIG_DIR/moliris.env"
chmod 0640 "$CONFIG_DIR/moliris.env"

cat > "$APP_DIR/.bootstrap-mongodb.cjs" <<'NODE'
const path=require("node:path");
const {MongoClient}=require(path.join(process.argv[2],"node_modules/mongodb"));
(async()=>{
 const p=process.env.MOLIRIS_DB_ADMIN_PASSWORD, a=process.env.MOLIRIS_DB_APP_PASSWORD;
 const boot=new MongoClient("mongodb://127.0.0.1:27018/admin",{serverSelectionTimeoutMS:10000});
 await boot.connect();
 await boot.db("admin").command({createUser:"moliris_db_admin",pwd:p,roles:[{role:"userAdminAnyDatabase",db:"admin"}]});
 await boot.close();
 const uri="mongodb://moliris_db_admin:"+encodeURIComponent(p)+"@127.0.0.1:27018/admin?authSource=admin";
 const admin=new MongoClient(uri,{serverSelectionTimeoutMS:10000});
 await admin.connect();
 await admin.db("moliris_maintenance").command({createUser:"moliris_app",pwd:a,roles:[{role:"readWrite",db:"moliris_maintenance"}]});
 await admin.close();
})().catch(e=>{console.error("Bootstrap MongoDB fallito: "+(e?.name||"errore"));process.exitCode=1;});
NODE
chown root:root "$APP_DIR/.bootstrap-mongodb.cjs"
chmod 0600 "$APP_DIR/.bootstrap-mongodb.cjs"
install -d -o root -g root -m 0755 /etc/systemd/system/moliris.service.d
cat > /etc/systemd/system/moliris.service.d/mongodb.conf <<'DROPIN'
[Unit]
Wants=
After=
After=network.target moliris-mongodb.service
Requires=moliris-mongodb.service
DROPIN
chown root:root /etc/systemd/system/moliris.service.d/mongodb.conf
chmod 0644 /etc/systemd/system/moliris.service.d/mongodb.conf
install -o root -g root -m 0644 "$PROJECT_DIR/moliris.service" /etc/systemd/system/moliris.service
systemctl daemon-reload
systemd-analyze verify /etc/systemd/system/moliris-mongodb.service /etc/systemd/system/moliris.service
systemctl enable --now moliris-mongodb.service
MOLIRIS_DB_ADMIN_PASSWORD="$DB_ADMIN_PASSWORD" MOLIRIS_DB_APP_PASSWORD="$DB_APP_PASSWORD" node "$APP_DIR/.bootstrap-mongodb.cjs" "$APP_DIR"
rm -f "$APP_DIR/.bootstrap-mongodb.cjs"

SEED_FILE="$DATA_DIR/seed_passwords.json"
MOLIRIS_SEED_ADMIN="$ADMIN_PASSWORD" MOLIRIS_SEED_OPERATOR="$OPERATOR_PASSWORD" \
node - "$SEED_FILE" "$(id -u moliris)" "$(id -g moliris)" <<'NODE'
const fs=require("node:fs"), file=process.argv[2];
fs.writeFileSync(file,JSON.stringify({adminPassword:process.env.MOLIRIS_SEED_ADMIN,operatorPassword:process.env.MOLIRIS_SEED_OPERATOR}),{mode:0o600,flag:"wx"});
fs.chownSync(file,Number(process.argv[3]),Number(process.argv[4]));
NODE
cat > "$APP_DIR/.seed-local-users.mjs" <<'NODE'
import {MongoClient} from "mongodb";
import {MongoUserRepository} from "./dist/backend/auth/user-repository.js";
import {loadSeedPasswords,seedInitialUsers} from "./dist/scripts/seed-users.js";
import {resolveMongoConfig} from "./dist/config/mongodb.js";
const pw=loadSeedPasswords({passwordFile:process.argv[2]}), cfg=resolveMongoConfig(), c=new MongoClient(cfg.uri);
try{await c.connect();const repo=new MongoUserRepository(c.db(cfg.dbName));await repo.initIndexes();await seedInitialUsers(repo,pw.operatorPassword,pw.adminPassword);}
finally{await c.close();}
NODE
chown root:root "$APP_DIR/.seed-local-users.mjs"
chmod 0644 "$APP_DIR/.seed-local-users.mjs"
runuser -u moliris -- env -i HOME=/nonexistent PATH=/usr/bin:/bin \
  bash -c 'set -a; . /etc/moliris/moliris.env; set +a; exec /usr/bin/node "$1" "$2"' \
  _ "$APP_DIR/.seed-local-users.mjs" "$SEED_FILE"
rm -f "$SEED_FILE" "$APP_DIR/.seed-local-users.mjs"
install -o "$CALLER_NAME" -g "$(id -gn "$CALLER_NAME")" -m 0600 /dev/null "$CALLER_HOME/.moliris-local-credentials.txt"
printf 'URL: https://127.0.0.1:8443\nUsername admin: admin\nPassword admin: %s\nUsername operatore: operatore\nPassword operatore: %s\n' "$ADMIN_PASSWORD" "$OPERATOR_PASSWORD" > "$CALLER_HOME/.moliris-local-credentials.txt"
chown "$CALLER_NAME":"$(id -gn "$CALLER_NAME")" "$CALLER_HOME/.moliris-local-credentials.txt"
chmod 0600 "$CALLER_HOME/.moliris-local-credentials.txt"
unset ADMIN_PASSWORD OPERATOR_PASSWORD DB_ADMIN_PASSWORD DB_APP_PASSWORD

systemctl daemon-reload
systemctl enable --now moliris.service
systemctl is-active --quiet moliris-mongodb.service || die "MongoDB Moliris non attivo; controllare journalctl."
systemctl is-active --quiet moliris.service || die "Moliris non attivo; controllare journalctl."
ready=0
for attempt in $(seq 1 30); do
  if curl --fail --silent --insecure https://127.0.0.1:8443/healthz -o /dev/null; then ready=1; break; fi
  sleep 1
done
[[ "$ready" -eq 1 ]] || die "Health check HTTPS non riuscito; controllare journalctl."
curl --fail --silent --show-error --insecure https://127.0.0.1:8443/healthz
printf '\nInstallazione completata. Credenziali app in %s/.moliris-local-credentials.txt (permessi 0600).\n' "$CALLER_HOME"
printf 'MongoDB esistente invariato; porte bindate solo su loopback.\n'
