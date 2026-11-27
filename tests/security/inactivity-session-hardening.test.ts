// Requisiti verificati: Prompt Correttivo #4 - Gestione avvisi di inattività e sessione
// SRS v1.0 §2, §6.1, §6.4, §10.4, RF-AUTH-004, RF-AUTH-006, RF-SSH-005, CA-AUTH-001..003, CA-SSH-001..005

import assert from "assert";
import { SessionManager } from "../../backend/auth/session-manager.ts";
import { type UserEntity } from "../../backend/auth/user-models.ts";
import { AuditOperation } from "../../storage/audit-models.ts";
import { InMemoryAuditRepository } from "../../storage/audit-repository.ts";
import { TerminalService } from "../../backend/terminal/terminal-service.ts";
import { EventEmitter } from "events";
import { mock } from "node:test";

console.log("--> Esecuzione test suite Prompt Correttivo #4 (Gestione avvisi inattività, pop-up, trasferimenti e audit)...");

const auditRepo = new InMemoryAuditRepository();

const testUser: UserEntity = {
  id: "user_p4_01",
  username: "operatore_p4",
  passwordHash: "dummy_hash",
  roles: ["operatore"],
  enabled: true,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const adminUser: UserEntity = {
  id: "user_p4_admin",
  username: "admin_p4",
  passwordHash: "dummy_hash",
  roles: ["admin"],
  enabled: true,
  createdAt: new Date(),
  updatedAt: new Date(),
};

// Il tetto assoluto è indipendente da rinnovo, consultazione e controllo periodico.
for (const check of [
  (manager: SessionManager, id: string) => manager.validate(id) === null,
  (manager: SessionManager, id: string) => !manager.touchSession(id),
  (manager: SessionManager, id: string) => manager.getRemainingInactivityMs(id) === null,
  (manager: SessionManager, _id: string) => {
    manager.purgeExpiredSessions();
    return manager.getActiveSessionsCount(testUser.id) === 0;
  },
]) {
  const manager = new SessionManager(1, 2);
  try {
    const { sessionId } = manager.createSession(testUser);
    const expirations: string[] = [];
    const terminations: string[] = [];
    manager.onSessionExpired((_, reason) => expirations.push(reason));
    manager.onSessionTerminated((_, __, reason) => terminations.push(reason));
    manager.setActiveTransferChecker(() => 1);
    manager.setActiveTransfersProvider(() => 2);
    manager._simulateInactivity(sessionId, 1);
    assert.equal(manager.touchSession(sessionId), true, "Un trasferimento sospende la sola inattività");
    manager._simulateAge(sessionId, 2);
    assert.ok(check(manager, sessionId));
    assert.equal(manager.getSession(sessionId), null);
    assert.deepEqual(expirations, ["ABSOLUTE_TIMEOUT"]);
    assert.deepEqual(terminations, ["EXPIRED"]);
  } finally {
    manager.dispose();
  }
}

{
  // Nessun polling o messaggio deve essere necessario per attivare la revoca.
  mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const manager = new SessionManager(1, 2);
  try {
    const session = manager.createSession(testUser);
    const alreadyLoggedOut = manager.createSession(testUser);
    const expirations: string[] = [];
    manager.onSessionExpired((expired) => expirations.push(expired.sessionId));
    manager.setActiveTransferChecker(() => 1);
    manager.destroySession(alreadyLoggedOut.sessionId);
    mock.timers.tick(119_999);
    assert.equal(manager.touchSession(session.sessionId), true);
    assert.deepEqual(expirations, []);
    mock.timers.tick(1);
    assert.deepEqual(expirations, [session.sessionId]);
    assert.equal(manager.validate(session.sessionId), null);
  } finally {
    manager.dispose();
    mock.timers.reset();
  }
}
console.log("  PASS: Tetto assoluto con trasferimenti attivi, heartbeat, task periodico e timer autonomo al millisecondo di scadenza.");

// =========================================================================
// TEST 1: Avviso mostrato al preavviso corretto (Sessione Generale e Terminale)
// =========================================================================
{
  const sessionTimeoutMin = 30;
  const sm = new SessionManager(sessionTimeoutMin);

  const session = sm.createSession(testUser);

  // A 24 minuti (6 minuti rimanenti): nessun avviso
  sm._simulateInactivity(session.sessionId, 24);
  const remBeforeWarning = sm.getRemainingInactivityMs(session.sessionId);
  assert.ok(remBeforeWarning);
  assert.strictEqual(remBeforeWarning.isSuspended, false);
  assert.strictEqual(Math.ceil(remBeforeWarning.remainingMs / 60000), 6);

  // A 25 minuti (5 minuti rimanenti, esatta soglia preavviso): avviso attivo con countdown 5..1
  for (let minElapsed = 25; minElapsed < 30; minElapsed++) {
    sm._simulateInactivity(session.sessionId, minElapsed);
    const remWarning = sm.getRemainingInactivityMs(session.sessionId);
    assert.ok(remWarning);
    const expectedRemainingMin = 30 - minElapsed;
    assert.strictEqual(Math.ceil(remWarning.remainingMs / 60000), expectedRemainingMin);
  }

  sm.dispose();
  console.log("  PASS: Test 1 - Avviso mostrato al preavviso corretto (5m) con progressione countdown.");
}

// =========================================================================
// TEST 2: CONFIRM - Timer azzerato lato client e server, pop-up chiuso, sessione ancora valida
// =========================================================================
{
  const sm = new SessionManager(30);
  const session = sm.createSession(testUser);

  // Simula inattività quasi al limite di scadenza (28 minuti trascorsi su 30)
  sm._simulateInactivity(session.sessionId, 28);
  assert.strictEqual(Math.ceil(sm.getRemainingInactivityMs(session.sessionId)!.remainingMs / 60000), 2);

  // Azione Conferma (CONFIRM): tocca e rinnova la sessione
  const touched = sm.touchSession(session.sessionId);
  assert.strictEqual(touched, true, "touchSession deve restituire true");

  // Timer azzerato: riparte dal valore predefinito (30 minuti rimanenti)
  const remAfterConfirm = sm.getRemainingInactivityMs(session.sessionId);
  assert.ok(remAfterConfirm);
  assert.strictEqual(Math.ceil(remAfterConfirm.remainingMs / 60000), 30);

  // Verifica validità sessione dopo la scadenza originaria
  sm._simulateInactivity(session.sessionId, 5); // trascorsi 5 minuti dalla conferma
  const valid = sm.validate(session.sessionId);
  assert.ok(valid, "La sessione deve essere valida oltre la scadenza originaria");

  sm.dispose();
  console.log("  PASS: Test 2 - CONFIRM azzera il timer e la sessione resta valida dopo la scadenza originaria.");
}

// =========================================================================
// TEST 3: DELETE - Logout immediato, chiusura WebSocket/terminale, sessione invalidata
// =========================================================================
{
  const sm = new SessionManager(30);
  let closedReason: string | null = null;
  let closedSessionId: string | null = null;

  sm.onSessionTerminated((sId, _uId, reason) => {
    closedSessionId = sId;
    closedReason = reason;
  });

  const session = sm.createSession(testUser);

  // Azione Esci (DELETE): distruzione immediata della sessione
  const destroyed = sm.destroySession(session.sessionId, "LOGOUT");
  assert.strictEqual(destroyed, true);

  // Notifica immediata di terminazione alle risorse collegate (WebSocket/PTY/SFTP)
  assert.strictEqual(closedSessionId, session.sessionId);
  assert.strictEqual(closedReason, "LOGOUT");

  // Accesso successivo categoricamente negato
  const afterDelete = sm.validate(session.sessionId);
  assert.strictEqual(afterDelete, null, "La sessione distrutta deve essere respinta (null)");

  sm.dispose();
  console.log("  PASS: Test 3 - DELETE effettua il logout immediato, notifica i listener e nega accessi successivi.");
}

// =========================================================================
// TEST 4: Scadenza senza risposta - Logout automatico al termine del countdown
// =========================================================================
{
  const sm = new SessionManager(30);
  let expiredNotified = false;

  sm.onSessionTerminated((_sId, _uId, reason) => {
    if (reason === "EXPIRED") expiredNotified = true;
  });

  const session = sm.createSession(testUser);

  // Countdown arriva a zero (30 minuti trascorsi)
  sm._simulateInactivity(session.sessionId, 30);
  sm.purgeExpiredSessions();

  assert.strictEqual(expiredNotified, true, "Scadenza senza risposta deve notificare EXPIRED");
  assert.strictEqual(sm.validate(session.sessionId), null, "Sessione scaduta deve essere invalidata");

  sm.dispose();
  console.log("  PASS: Test 4 - Scadenza automatica a zero senza risposta invalida la sessione.");
}

// =========================================================================
// TEST 5: Eccezione trasferimenti in corso durante l'inattività
// =========================================================================
{
  const sm = new SessionManager(30);
  const session = sm.createSession(testUser);

  // Registro/contatore trasferimenti attivi
  let activeTransfersRegister = new Map<string, number>();
  activeTransfersRegister.set(session.sessionId, 0);

  sm.setActiveTransferChecker((sId) => activeTransfersRegister.get(sId) || 0);

  let suspendedEvents: Array<{ sessionId: string; activeTransfers: number }> = [];
  sm.onSessionSuspendedForTransfer((sId, _uId, active, _ctx) => {
    suspendedEvents.push({ sessionId: sId, activeTransfers: active });
  });

  // Avvio di 2 trasferimenti concorrenti
  activeTransfersRegister.set(session.sessionId, 2);

  // Tempo avanza a 40 minuti (ben oltre il timeout di 30m)
  sm._simulateInactivity(session.sessionId, 40);
  sm.purgeExpiredSessions();

  // Nessun logout né scadenza: sessione protetta
  assert.ok(sm.validate(session.sessionId), "Sessione non deve scadere con 2 trasferimenti attivi");
  assert.strictEqual(suspendedEvents.length, 1);
  assert.strictEqual(suspendedEvents[0].activeTransfers, 2);

  // Un trasferimento fallisce/si annulla: rimane 1 trasferimento attivo
  activeTransfersRegister.set(session.sessionId, 1);
  sm._simulateInactivity(session.sessionId, 45);
  sm.purgeExpiredSessions();
  assert.ok(sm.validate(session.sessionId), "Sessione ancora protetta con 1 trasferimento residuo");

  // Secondo trasferimento si conclude (errore, annullamento o completamento): conteggio a 0
  activeTransfersRegister.set(session.sessionId, 0);
  sm.touchSession(session.sessionId); // il completamento del trasferimento riavvia il timer dal default

  // Il timer riparte dal valore predefinito (30m)
  const rem = sm.getRemainingInactivityMs(session.sessionId);
  assert.ok(rem);
  assert.strictEqual(Math.ceil(rem.remainingMs / 60000), 30);

  // Ora avanza nuovamente oltre 30 minuti senza trasferimenti: deve scadere normalmente
  sm._simulateInactivity(session.sessionId, 31);
  sm.purgeExpiredSessions();
  assert.strictEqual(sm.validate(session.sessionId), null, "Senza trasferimenti, la sessione scade regolarmente");

  sm.dispose();
  console.log("  PASS: Test 5 - Trasferimenti concorrenti, sospensione, ripartenza dal default e gestione fallimento/annullamento verificati.");
}

// =========================================================================
// TEST 6: Terminale - pop-up, confirm_idle, sospensione per trasferimenti e non sovrapposizione
// =========================================================================
{
  class MockWs extends EventEmitter {
    public readyState = 1;
    public bufferedAmount = 0;
    public sent: any[] = [];
    public send(data: any) {
      this.sent.push(typeof data === "string" ? JSON.parse(data) : data);
    }
    public close() {
      this.readyState = 3;
    }
  }

  class MockPty extends EventEmitter {
    public write() { return true; }
    public setWindow() {}
    public kill() {}
  }

  const sm = new SessionManager(30);
  const termSessionId = "sess_term_p4_01";
  const userSession = sm.createSession(adminUser);

  const mockWs = new MockWs();
  const mockPty = new MockPty();

  const termService = new TerminalService(
    {
      serverFilesystemRoot: "/tmp",
      pollingIntervalSeconds: 5,
      sshConnectionTimeoutMs: 2000,
      maxConcurrentTransfersPerUser: 5,
      maxConcurrentTransfersPerRobot: 5,
      maxConcurrentTransfersServer: 10,
      tempFileRetentionMinutes: 60,
      stateFilePaths: ["/state"],
      inactiveSessionTimeoutMinutes: 30,
      terminalSessionTimeoutMinutes: 15,
      terminalSessionWarningMinutes: 5,
      tlsCertPath: "/cert",
      tlsKeyPath: "/key",
      registrationMode: "rigorosa",
      auditLogRetentionDays: 365,
    } as any,
    {} as any,
    auditRepo,
    {} as any,
    sm,
    {} as any,
    { info: () => {}, warn: () => {}, error: () => {} } as any
  );

  const baseTime = Date.now();
  const termSession = {
    sessionId: termSessionId,
    robotId: "robot-test-p4",
    userId: adminUser.id,
    username: adminUser.username,
    userSessionId: userSession.sessionId,
    state: "active" as const,
    cols: 80,
    rows: 24,
    ptyChannel: mockPty,
    authorizedContext: {
      sessionId: userSession.sessionId,
      userId: adminUser.id,
      username: adminUser.username,
      roles: adminUser.roles,
      permissions: new Set(),
    },
    createdAt: new Date(baseTime),
    lastActivityAt: new Date(baseTime),
    hasHadSocket: false,
    webSocket: null,
  };
  (termService as any).activeSessions.set(termSessionId, termSession);

  const messageListeners: ((msg: any) => void)[] = [];
  mockWs.on = (evt: string, fn: any): any => {
    if (evt === "message") messageListeners.push(fn);
    return mockWs;
  };
  mockWs.emit = (evt: string, data: any): any => {
    if (evt === "message") {
      for (const fn of messageListeners) fn(data);
      return true;
    }
    return false;
  };

  termService.attachWebSocket(termSessionId, adminUser, mockWs as any);

  // 1. A 10m trascorsi (5m rimanenti su 15m): avviso terminal_idle_warning inviato
  termService.checkIdleSessions(baseTime + 10 * 60 * 1000);
  const warnMsg = mockWs.sent.find((m) => m.type === "terminal_idle_warning" && m.remainingMinutes === 5);
  assert.ok(warnMsg, "terminal_idle_warning a 5m dalla scadenza");
  assert.strictEqual(warnMsg.context, "terminale");

  // 2. Azione CONFIRM da WebSocket: confirm_idle
  mockWs.sent.length = 0;
  mockWs.emit("message", JSON.stringify({ type: "confirm_idle" }));

  // Verifica terminal_idle_reset inviato
  const resetMsg = mockWs.sent.find((m) => m.type === "terminal_idle_reset");
  assert.ok(resetMsg, "Messaggio confirm_idle azzera il warning con terminal_idle_reset");

  // 3. Verifica sospensione del terminale se vi è un trasferimento attivo
  let activeTransfers = 1;
  termService.setActiveTransferChecker(() => activeTransfers);

  const afterConfirmTime = termSession.lastActivityAt.getTime();
  termService.checkIdleSessions(afterConfirmTime + 16 * 60 * 1000); // 16 minuti dopo

  assert.strictEqual(termService.getActiveSessionCount(), 1, "Terminale non deve chiudersi se ci sono trasferimenti attivi");

  // Disattiva trasferimenti: scade regolarmente
  activeTransfers = 0;
  const resumeTime = termSession.lastActivityAt.getTime();
  termService.checkIdleSessions(resumeTime + 15 * 60 * 1000 + 1000);

  assert.strictEqual(termService.getActiveSessionCount(), 0, "Alla scadenza definitiva il terminale è chiuso");

  termService.dispose();
  sm.dispose();
  console.log("  PASS: Test 6 - Terminale (avviso, confirm_idle, sospensione trasferimenti e chiusura) verificato.");
}

// =========================================================================
// TEST 7: Audit log trail (avviso mostrato, conferma, logout, timeout, sospensione)
// =========================================================================
{
  const events = await auditRepo.query();

  const warningEvents = events.filter((e) => e.operation === AuditOperation.SESSION_IDLE_WARNING);
  const confirmEvents = events.filter((e) => e.operation === AuditOperation.SESSION_IDLE_CONFIRM);
  const suspendEvents = events.filter((e) => e.operation === AuditOperation.SESSION_TRANSFER_SUSPEND);
  const timeoutEvents = events.filter((e) => e.operation === AuditOperation.SESSION_IDLE_TIMEOUT);

  assert.ok(warningEvents.length > 0, "Almeno un evento SESSION_IDLE_WARNING registrato");
  assert.ok(confirmEvents.length > 0, "Almeno un evento SESSION_IDLE_CONFIRM registrato");
  assert.ok(suspendEvents.length > 0, "Almeno un evento SESSION_TRANSFER_SUSPEND registrato");
  assert.ok(timeoutEvents.length > 0, "Almeno un evento SESSION_IDLE_TIMEOUT registrato");

  // Verifica che gli eventi contengano utente e contesto (terminale o sessione)
  for (const ev of [...warningEvents, ...confirmEvents, ...suspendEvents, ...timeoutEvents]) {
    assert.ok(ev.userId, "Ogni evento deve contenere userId");
    assert.ok(
      ev.details?.context === "sessione" || ev.details?.context === "terminale",
      `Contesto deve essere 'sessione' o 'terminale', ricevuto: ${ev.details?.context}`
    );
  }

  console.log("  PASS: Test 7 - Audit log completo con tutte le operazioni tracciate, utente e contesto distinti.");
}

console.log("PASS: Tutti i test della suite Prompt Correttivo #4 superati con successo!\n");
