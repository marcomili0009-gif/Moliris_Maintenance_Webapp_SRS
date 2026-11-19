# 02 - DOMANDE AL REFERENTE - Moliris Maintenance Webapp

Regole: max 4-5 domande per blocco, linguaggio semplice, 2 opzioni concrete quando possibile. Non ripetere domande già risposte nei documenti esistenti (DECISIONS.md, STATUS_FILE_FORMAT.md, TRACEABILITY.md). Ogni risposta ricevuta va salvata qui come regola vincolante.

## Blocco 1 - da girare subito (5 domande)

1. File di stato dei robot: quali sono il percorso reale e il formato reale dei file di stato letti dai robot (oggi il parser supporta JSON e chiave-valore ma il formato è "esempio illustrativo da confermare")?
   - A) Ci forniamo il file di esempio reale del firmware (percorso + contenuto).
   - B) Va definido insieme: JSON, chiave-valore o rilevamento automatico (auto).

2. Limite dimensione file: le specifiche aggiuntive indicano un limite preimpostato di 3 GB per file su server e robot, ma nel codice la variabile è commentata (e in `.env.example` compare un 2 GB commentato). Confermate 3 GB come limite da preimpostare?
   - A) Sì, 3 GB preimpostato (`MOLIRIS_MAX_FILE_SIZE_BYTES` attivo di default).
   - B) No, nessun limite fisso (comportamento attuale, file > 1 GB sempre supportati).

3. Tempi di inattività: confermate 30 minuti di inattività per la sessione web (con avviso 5 minuti prima) e 15 minuti per il terminale SSH (con avviso 5 minuti prima)? Le specifiche aggiuntive dicono che i 30 minuti della sessione sono "da verificare".
   - A) Sì, 30 min sessione / 15 min terminale.
   - B) Altri valori (indicare quali).

4. Ripresa dei trasferimenti interrotti: oggi la ripresa è implementata ma disattivata di default (`MOLIRIS_TRANSFER_RESUME_ENABLED=false`). La attiviamo?
   - A) Sì, attiva di default.
   - B) No, resta disattivata (ripresa solo su richiesta esplicita).
   - Sotto-domanda: la verifica di integrità basta in modalità "stream" (digest in transito) o volete anche la rilettura completa del file ("readback")?

5. Rimozione robot: quando un robot viene rimosso dalla flotta, i file nella sua cartella sul server vanno eliminati con un comando separato e autorizzato (da implementare), oppure restano sempre intatti (comportamento attuale)?
   - A) Implementare l'eliminazione separata e protetta dei dati server.
   - B) I dati restano sempre sul server (comportamento attuale).

## Blocco 2 - in coda, da girare dopo le risposte del Blocco 1 (5 domande)

6. Le sottodirectory standard create in ogni cartella robot (`logs`, `configs`, `backups`): a cosa servono esattamente?
   - A) logs = log del robot, configs = configurazioni, backups = backup (conferma dei nomi).
   - B) Altra finalità (descrivere).

7. Conservazione file e quote: esiste una politica di conservazione dei file (cancellazione automatica dopo X giorni) o una quota disco per robot/utente?
   - A) Nessuna cancellazione automatica, nessuna quota.
   - B) Sì, indicare giorni e/o GB.

8. Autenticazione aggiuntiva: oltre a username e password è richiesta una seconda verifica (es. codice MFA) per qualche profilo?
   - A) No, username e password bastano.
   - B) Sì, MFA per gli Admin (indicare il metodo: app autenticatore, SMS, altro).

9. Utenti iniziali: come vengono creati il primo Admin e il primo Operatore in modo sicuro (file password protetto, credenziali systemd, altro)? E quanti robot sono previsti initially e al massimo, quanti accessi contemporanei con lo stesso account sono ammessi (da confermare con Daniele)?
   - A) Script seed con file password 0600 (già predisposto).
   - B) Altro meccanismo (descrivere).

10. Sessioni terminale condivise: confermate che un utente non possa mai collegarsi alla sessione terminale di un altro utente (politica attuale di negazione totale)?
    - A) Sì, negazione totale (comportamento attuale).
    - B) No, serve la condivisione con autorizzazione esplicita.

## Risposte ricevute

(Nessuna risposta ricevuta finora.)
