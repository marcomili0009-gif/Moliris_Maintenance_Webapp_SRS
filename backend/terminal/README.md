# Servizio Terminale SSH (§5.4)

## Responsabilità (SRS §5.4)
- Apertura delle connessioni SSH verso i robot selezionati (RF-SSH-001).
- Allocazione e gestione dei pseudoterminali (PTY) (RF-SSH-002, RF-SSH-004).
- Scambio bidirezionale di dati in tempo reale con il browser via WebSocket (RF-SSH-003, RF-SSH-004).
- Gestione del ciclo di vita delle sessioni, disconnessioni e timeout (RF-SSH-005, RF-SSH-006, RNF-REL-005).
- Applicazione dei controlli di autorizzazione e isolamento delle sessioni (RF-SSH-006, RF-SSH-008, RNF-SEC-007).

## Confini di Chiamata (RNF-MNT-002)
- Può chiamare: i robot via SSH/PTY; il frontend via WebSocket.
- Può essere chiamato da: `backend` per verifica credenziali e permessi di sessione.
- NON può eseguire comandi con privilegi elevati automatici (RF-SSH-008).
