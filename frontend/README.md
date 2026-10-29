# Modulo Frontend Web (§5.1)

## Responsabilità (SRS §5.1)
- Login e gestione dell'interfaccia utente.
- Visualizzazione della flotta e dei dettagli dei robot (RF-ROB-001, RF-ROB-003).
- Form per la registrazione dei robot (RF-ROB-004, RF-ROB-005).
- Visualizzazione dello stato operativo interpretato (RF-MON-006).
- Terminale SSH interattivo nel browser tramite xterm.js (RF-SSH-001..003, RNF-UX-004).
- Navigazione dei filesystem (remoto robot e server) (RF-FS-001, RF-SRVFS-002).
- Interfaccia di upload e download (RF-FS-004/005, RF-SRVFS-003/004, RF-TRF-001..003).
- Visualizzazione dei progressi e degli errori (RF-TRF-006, RF-SSH-007, RF-FS-006).

## Confini di Chiamata (RNF-MNT-002)
- Può chiamare: solo il backend via HTTPS e WebSocket (WSS) (SRS §1.2, §2.4 vincolo 3).
- NON può chiamare: i robot direttamente via SSH/SFTP (SRS §1.2, §2.4 vincolo 2 e 4), né il filesystem locale del server o il database.
