# Modulo Backend API / Logica Applicativa (§5.2)

## Responsabilità (SRS §5.2)
- Autenticazione e autorizzazione (RF-AUTH-001..006, RNF-SEC-004).
- Gestione dell'anagrafica dei robot (RF-ROB-001..006, RF-ROB-013).
- Validazione dei parametri (RF-ROB-006, RNF-SEC-006).
- Gestione delle configurazioni di sistema (RNF-MNT-001).
- Coordinamento delle operazioni (flussi 6.1–6.7).
- Accesso al database applicativo (MongoDB, §5.6).
- Controllo delle operazioni sul filesystem server (RF-SRVFS-001..007, RNF-SEC-005).
- Registrazione degli eventi di audit (RNF-SEC-009, §10.4).

## Confini di Chiamata (RNF-MNT-002)
- Può chiamare: `storage` (§5.6), `monitoring` (§5.3), `terminal` (§5.4), `transfer` (§5.5).
- NON può esporre credenziali o chiavi private verso il `frontend` (SRS §2.4 vincolo 2, RNF-SEC-002).
