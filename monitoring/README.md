# Servizio di Monitoraggio SSH (§5.3)

## Responsabilità (SRS §5.3)
- Connessione ai robot via SSH (RF-MON-001, RF-MON-003).
- Lettura dei file di stato configurati sui dispositivi remoti (RF-MON-001).
- Parsing dei contenuti testuali in strutture dati (RF-MON-002).
- Aggiornamento periodico (polling) e manuale su richiesta (RF-MON-003, RF-MON-004).
- Gestione dei timeout e degli errori di connessione senza degradare lo stato storico valido (RF-MON-005, RNF-REL-002).

## Confini di Chiamata (RNF-MNT-002)
- Può chiamare: robot remoti via protocollo SSH v2 (§2.4 vincolo 4).
- Può essere chiamato da: `backend` (§5.2).
- NON può chiamare: direttamente il database o il frontend.
