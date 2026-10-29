# Modulo di Accesso ai Dati e Filesystem Server (§5.6)

## Responsabilità (SRS §5.6)
- Conservazione e persistenza dei dati anagrafici e configurazioni robot su MongoDB (§10.1).
- Gestione della root del filesystem server per l'archiviazione dei file della flotta (RF-SRVFS-001, §10.3).
- Creazione e mantenimento idempotente delle directory dedicate per robot denominate in base allo username (RF-ROB-008, RF-ROB-009, RNF-FS-004).
- Prevenzione da accessi non autorizzati e controlli rigorosi anti path-traversal (RNF-SEC-005, RNF-FS-001/002).
- Gestione della coerenza e compensazione da errori parziali tra database e filesystem (RF-ROB-010).

## Confini di Chiamata (RNF-MNT-002)
- Può chiamare: demone MongoDB e API filesystem del server host Ubuntu.
- Può essere chiamato da: `backend` (§5.2) e `transfer` (§5.5).
