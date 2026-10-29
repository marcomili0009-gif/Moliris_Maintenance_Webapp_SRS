# Servizio di Trasferimento File (§5.5)

## Responsabilità (SRS §5.5)
- Trasferimenti bidirezionali tra computer utente e filesystem server (RF-TRF-001).
- Trasferimenti bidirezionali tra filesystem server e filesystem remoto robot (RF-TRF-002).
- Coordinamento dei trasferimenti computer-robot tramite il server come intermediario (RF-TRF-003).
- Streaming o trasferimento a blocchi per file >1 GB senza carico integrale in RAM (RF-TRF-004/005, RNF-PERF-001/002).
- Gestione di avanzamento, timeout, verifica integrità (checksum) e file temporanei (RF-TRF-006..010, RF-TRF-013).
- Gestione degli errori, conservazione file validi esistenti e ripresa (RF-TRF-007, RF-TRF-010, RNF-REL-004).

## Confini di Chiamata (RNF-MNT-002)
- Può chiamare: `storage` (filesystem server §5.6), robot via SFTP (§2.4 vincolo 4).
- Può essere chiamato da: `backend` (§5.2).
- NON instaura connessioni dirette browser <-> robot (RF-TRF-003).
