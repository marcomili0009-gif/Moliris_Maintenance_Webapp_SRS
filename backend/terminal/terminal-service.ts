// Requisiti soddisfatti: RF-SSH-001..008, RNF-SEC-001, RNF-SEC-002, RNF-SEC-004, RNF-SEC-007,
// RNF-SEC-009, RNF-REL-001, RNF-REL-005, RNF-PERF-002, RNF-PERF-003, SRS §5.4, §6.4, §9, §10.4, §11.6, §11.7,
// CA-SSH-001, CA-SSH-002, CA-SSH-003, CA-SSH-004, CA-SSH-005

import crypto from "crypto";
import { type SystemConfiguration } from "../../config/configuration.ts";
import { type RobotRepository } from "../../storage/robot-repository.ts";
import { type AuditRepository } from "../../storage/audit-repository.ts";
import { AuditOperation } from "../../storage/audit-models.ts";
import { type RobotConnectionManager } from "../connection/robot-connection-manager.ts";
import { type SessionManager, type SessionData } from "../auth/session-manager.ts";
import { type UserEntity } from "../auth/user-models.ts";
import { AppPermission, hasPermission, type RolePermissionMapping } from "../auth/permissions.ts";
import { MolirisAppError, ErrorCode } from "../../errors/app-errors.ts";
import { MolirisLogger, redactSensitiveData } from "../../logging/logger.ts";
import {
  type TerminalSession,
  type TerminalCloseReason,
  type TerminalSessionSharingPolicy,
  DefaultDenyTerminalSessionSharingPolicy,
} from "./terminal-models.ts";
import { type TerminalConcurrencyLimits, DEFAULT_TERMINAL_LIMITS } from "./terminal-limits.ts";

export class TerminalService {
  private config: SystemConfiguration;
  private robotRepository: RobotRepository;
  private auditRepository: AuditRepository;
  private connectionManager: RobotConnectionManager;
  private sessionManager: SessionManager;
  private roleMapping: RolePermissionMapping;
  private logger: MolirisLogger;
  private sharingPolicy: TerminalSessionSharingPolicy;
  private limits: TerminalConcurrencyLimits;

  // Sessioni terminale attive tracciate in memoria (RF-SSH-004, §5.4)
  private activeSessions: Map<string, TerminalSession> = new Map();
  private userSessionCounts: Map<string, number> = new Map();
  private robotSessionCounts: Map<string, number> = new Map();
  private pendingOpens = new Map<string, {
    userId: string;
    userSessionId: string;
    robotId: string;
    robotGeneration: number;
    serverGeneration: number;
  }>();
  private robotGenerations = new Map<string, number>();
  private serverGeneration = 0;
  private idleCheckTimer: NodeJS.Timeout | null = null;

  constructor(
    config: SystemConfiguration,
    robotRepository: RobotRepository,
    auditRepository: AuditRepository,
    connectionManager: RobotConnectionManager,
    sessionManager: SessionManager,
    roleMapping: RolePermissionMapping,
    logger: MolirisLogger,
    sharingPolicy?: TerminalSessionSharingPolicy,
    customLimits?: Partial<TerminalConcurrencyLimits>
  ) {
    this.config = config;
    this.robotRepository = robotRepository;
    this.auditRepository = auditRepository;
    this.connectionManager = connectionManager;
    this.sessionManager = sessionManager;
    this.roleMapping = roleMapping;
    this.logger = logger;
    this.sharingPolicy = sharingPolicy || new DefaultDenyTerminalSessionSharingPolicy();

    this.limits = {
      maxConcurrentServer:
        customLimits?.maxConcurrentServer ?? config.maxConcurrentTerminalSessionsServer ?? DEFAULT_TERMINAL_LIMITS.maxConcurrentServer,
      maxConcurrentPerUser:
        customLimits?.maxConcurrentPerUser ?? config.maxConcurrentTerminalSessionsPerUser ?? DEFAULT_TERMINAL_LIMITS.maxConcurrentPerUser,
      maxConcurrentPerRobot:
        customLimits?.maxConcurrentPerRobot ?? config.maxConcurrentTerminalSessionsPerRobot ?? DEFAULT_TERMINAL_LIMITS.maxConcurrentPerRobot,
      sessionTimeoutMinutes:
        customLimits?.sessionTimeoutMinutes ?? config.terminalSessionTimeoutMinutes ?? DEFAULT_TERMINAL_LIMITS.sessionTimeoutMinutes,
      maxBufferedBytes: customLimits?.maxBufferedBytes ?? DEFAULT_TERMINAL_LIMITS.maxBufferedBytes,
    };

    // STEP 5 – Hook di notifica chiusura/scadenza sessione utente (RF-SSH-005, Prompt 3)
    // Il logout/scadenza chiude SOLO i terminali della specifica sessione terminata (non tutti i terminali dell'utente)
    this.sessionManager.onSessionTerminated((userSessionId, userId, reason) => {
      for (const [reservationId, reservation] of this.pendingOpens) {
        if (reservation.userSessionId === userSessionId && reservation.userId === userId) {
          this.releasePendingOpen(reservationId);
        }
      }

      const termReason: TerminalCloseReason = "USER_SESSION_TERMINATED";
      for (const session of Array.from(this.activeSessions.values())) {
        if (session.authorizedContext.sessionId === userSessionId) {
          this.closeSession(session.sessionId, termReason, `Sessione utente terminata (${reason})`);
        }
      }
    });

    // Controllo periodico del timeout di inattività (RF-SSH-005)
    this.startIdleChecker();
  }

  private startIdleChecker(): void {
    if (this.limits.sessionTimeoutMinutes <= 0) return;
    const intervalMs = Math.min(this.limits.sessionTimeoutMinutes * 60 * 1000, 30000);

    this.idleCheckTimer = setInterval(() => {
      const now = Date.now();
      const timeoutMs = this.limits.sessionTimeoutMinutes * 60 * 1000;

      for (const session of Array.from(this.activeSessions.values())) {
        if (now - session.lastActivityAt.getTime() > timeoutMs) {
          this.closeSession(session.sessionId, "IDLE_TIMEOUT", "Timeout inattività terminale superato.");
        }
      }
    }, intervalMs);

    if (this.idleCheckTimer && typeof (this.idleCheckTimer as any).unref === "function") {
      (this.idleCheckTimer as any).unref();
    }
  }

  public dispose(): void {
    if (this.idleCheckTimer) {
      clearInterval(this.idleCheckTimer);
      this.idleCheckTimer = null;
    }
  }

  public getActiveSessionCount(): number {
    return this.activeSessions.size;
  }

  public getSession(sessionId: string): TerminalSession | undefined {
    return this.activeSessions.get(sessionId);
  }

  private releasePendingOpen(reservationId: string): void {
    const reservation = this.pendingOpens.get(reservationId);
    if (!reservation) return;

    this.pendingOpens.delete(reservationId);

    const userCount = this.userSessionCounts.get(reservation.userId) || 0;
    if (userCount <= 1) this.userSessionCounts.delete(reservation.userId);
    else this.userSessionCounts.set(reservation.userId, userCount - 1);

    const robotCount = this.robotSessionCounts.get(reservation.robotId) || 0;
    if (robotCount <= 1) this.robotSessionCounts.delete(reservation.robotId);
    else this.robotSessionCounts.set(reservation.robotId, robotCount - 1);
  }

  private assertPendingOpenValid(
    reservationId: string,
    user: UserEntity,
    userSessionId: string,
    robotId: string
  ): SessionData {
    const reservation = this.pendingOpens.get(reservationId);

    if (
      !reservation ||
      reservation.userId !== user.id ||
      reservation.userSessionId !== userSessionId ||
      reservation.robotId !== robotId ||
      reservation.serverGeneration !== this.serverGeneration ||
      reservation.robotGeneration !== (this.robotGenerations.get(robotId) || 0)
    ) {
      throw new MolirisAppError(
        ErrorCode.INSUFFICIENT_PERMISSIONS,
        "Apertura del terminale annullata perché la sessione utente, il robot o il servizio non sono più validi."
      );
    }

    const userSession = this.sessionManager.validate(userSessionId);

    // validate() può notificare la scadenza e rimuovere la prenotazione.
    if (
      !userSession ||
      userSession.userId !== user.id ||
      !this.pendingOpens.has(reservationId)
    ) {
      throw new MolirisAppError(
        ErrorCode.INSUFFICIENT_PERMISSIONS,
        "Apertura del terminale annullata: sessione utente non più valida."
      );
    }

    return userSession;
  }

  /**
   * STEP 1 – Apertura della sessione di terminale (RF-SSH-001, RF-SSH-004, §6.4 passi 1-5).
   * Verifica permessi, stato del robot, limiti di concorrenza e alloca il canale PTY.
   * Il browser non riceve mai credenziali né apre connessioni SSH dirette (CA-SSH-001).
   */
  public async openTerminalSession(
    user: UserEntity,
    robotId: string,
    initialDimensions: { cols?: number; rows?: number },
    userSessionId: string
  ): Promise<TerminalSession> {
    if (!hasPermission(user, AppPermission.TERMINAL_OPEN, robotId, this.roleMapping)) {
      await this.auditRepository.record({
        userId: user.username,
        operation: AuditOperation.SECURITY_AUTHORIZATION_ERROR,
        robotId,
        outcome: "FAILURE",
        timestamp: new Date(),
        details: { reason: "PERMISSION_DENIED_TERMINAL_OPEN" },
      });

      throw new MolirisAppError(
        ErrorCode.INSUFFICIENT_PERMISSIONS,
        "Operazione non consentita: autorizzazioni insufficienti per aprire il terminale sul robot."
      );
    }

    const initialSession = this.sessionManager.validate(userSessionId);
    if (!initialSession || initialSession.userId !== user.id) {
      throw new MolirisAppError(
        ErrorCode.INSUFFICIENT_PERMISSIONS,
        "Sessione utente non valida o scaduta."
      );
    }

    const robot = await this.robotRepository.findById(robotId);
    if (!robot) {
      throw new MolirisAppError(ErrorCode.MISSING_ROBOT_PARAMS, `Robot '${robotId}' non trovato.`);
    }

    if (robot.anagraphicState === "disabilitato" || robot.anagraphicState === "rimosso") {
      throw new MolirisAppError(
        ErrorCode.INSUFFICIENT_PERMISSIONS,
        `Impossibile aprire il terminale: il robot è ${robot.anagraphicState}.`
      );
    }

    if (robot.registrationState === "ssh_non_verificata") {
      throw new MolirisAppError(
        ErrorCode.HOST_UNREACHABLE,
        "Impossibile aprire il terminale: la connessione SSH del robot non è ancora stata verificata. Eseguire la verifica preliminare."
      );
    }

    if (robot.connectionState === "non_raggiungibile") {
      throw new MolirisAppError(
        ErrorCode.HOST_UNREACHABLE,
        "Impossibile aprire il terminale: il robot non è attualmente raggiungibile sulla rete."
      );
    }

    // Prenotazione sincrona: include anche le aperture SSH ancora in corso.
    if (this.activeSessions.size + this.pendingOpens.size >= this.limits.maxConcurrentServer) {
      throw new MolirisAppError(
        ErrorCode.INSUFFICIENT_STORAGE,
        "Numero massimo di sessioni terminale contemporanee sul server raggiunto. Riprovare a breve."
      );
    }

    const userCount = this.userSessionCounts.get(user.id) || 0;
    if (userCount >= this.limits.maxConcurrentPerUser) {
      throw new MolirisAppError(
        ErrorCode.INSUFFICIENT_STORAGE,
        "Numero massimo di sessioni terminale simultanee per utente raggiunto."
      );
    }

    const robotCount = this.robotSessionCounts.get(robot.id) || 0;
    if (robotCount >= this.limits.maxConcurrentPerRobot) {
      throw new MolirisAppError(
        ErrorCode.INSUFFICIENT_STORAGE,
        "Numero massimo di sessioni terminale simultanee per questo robot raggiunto."
      );
    }

    const reservationId = crypto.randomBytes(24).toString("hex");
    this.pendingOpens.set(reservationId, {
      userId: user.id,
      userSessionId,
      robotId: robot.id,
      robotGeneration: this.robotGenerations.get(robot.id) || 0,
      serverGeneration: this.serverGeneration,
    });
    this.userSessionCounts.set(user.id, userCount + 1);
    this.robotSessionCounts.set(robot.id, robotCount + 1);

    let managedConn: Awaited<ReturnType<RobotConnectionManager["acquireConnection"]>> | undefined;
    let ptyChannel: Awaited<ReturnType<NonNullable<typeof managedConn>["openPtyStream"]>> | undefined;
    let registeredSession: TerminalSession | undefined;

    try {
      const validSession = this.assertPendingOpenValid(reservationId, user, userSessionId, robot.id);

      managedConn = await this.connectionManager.acquireConnection(user.username, robot);
      this.assertPendingOpenValid(reservationId, user, userSessionId, robot.id);

      const cols = Math.max(10, Math.min(300, initialDimensions.cols || 80));
      const rows = Math.max(5, Math.min(100, initialDimensions.rows || 24));

      ptyChannel = await managedConn.openPtyStream({ cols, rows, term: "xterm-256color" });
      this.assertPendingOpenValid(reservationId, user, userSessionId, robot.id);

      const sessionId = `term_${crypto.randomBytes(24).toString("hex")}`;
      const authorizedContext = this.sessionManager.createAuthorizedContext(
        validSession,
        user,
        robot.id,
        this.roleMapping
      );

      const session: TerminalSession = {
        sessionId,
        userId: user.id,
        username: user.username,
        robotId: robot.id,
        authorizedContext,
        state: "active",
        cols,
        rows,
        createdAt: new Date(),
        lastActivityAt: new Date(),
        managedConnection: managedConn,
        ptyChannel,
      };

      // Nessun await tra l'ultima validazione e la conversione della prenotazione.
      this.assertPendingOpenValid(reservationId, user, userSessionId, robot.id);
      this.pendingOpens.delete(reservationId);
      this.activeSessions.set(sessionId, session);
      registeredSession = session;

      ptyChannel.on("exit", () => {
        this.closeSession(sessionId, "SHELL_EXIT", "Processo shell terminato dall'utente (exit).");
      });

      ptyChannel.on("close", () => {
        this.closeSession(sessionId, "SHELL_EXIT", "Canale PTY remoto chiuso.");
      });

      ptyChannel.on("end", () => {
        this.closeSession(sessionId, "SHELL_EXIT", "Stream PTY terminato.");
      });

      ptyChannel.on("error", (err: any) => {
        this.closeSession(sessionId, "ROBOT_DISCONNECT", `Errore PTY robot: ${err?.message}`);
      });

      await this.auditRepository.record({
        userId: user.username,
        operation: AuditOperation.TERMINAL_OPEN,
        robotId: robot.id,
        outcome: "SUCCESS",
        timestamp: new Date(),
        details: { sessionId, cols, rows },
      });

      return session;
    } catch (err) {
      if (registeredSession) {
        try {
          await this.closeSession(
            registeredSession.sessionId,
            "ROBOT_DISCONNECT",
            "Apertura terminale fallita durante la registrazione audit."
          );
        } catch (closeErr) {
          this.logger.warn("Errore durante la pulizia della sessione dopo apertura terminale fallita.", {
            error: redactSensitiveData(String(closeErr)),
          });
        }
      } else {
        this.releasePendingOpen(reservationId);

        if (ptyChannel) {
          try { ptyChannel.end(); } catch {}
          try { ptyChannel.destroy(); } catch {}
        }

        if (managedConn) {
          try { await managedConn.close(); } catch (closeErr) {
            this.logger.warn("Errore durante il rilascio della connessione SSH dopo apertura terminale fallita.", {
              error: redactSensitiveData(String(closeErr)),
            });
          }
        }
      }

      throw err;
    }
  }

  /**
   * STEP 2 & 4 – Aggancio del canale WebSocket alla sessione PTY (RF-SSH-004, RF-SSH-006, CA-SSH-005).
   * Verifica rigorosa dell'identità dell'utente (nessun accesso a sessioni altrui).
   * Flusso trasparente bidirezionale senza interpretazione o filtraggio comandi (RF-SSH-002, RF-SSH-008).
   */
  public attachWebSocket(sessionId: string, requestingUser: UserEntity, socket: any): void {
    const session = this.activeSessions.get(sessionId);

    // 1. Verifica esistenza e stato sessione
    if (!session || session.state === "closed" || session.state === "closing") {
      try {
        socket.send(JSON.stringify({ type: "error", message: "Sessione terminale non trovata o già chiusa." }));
        socket.close(4404, "Session Not Found");
      } catch {}
      return;
    }

    // 2. Verifica di isolamento: divieto di accesso a sessioni altrui
    if (!this.sharingPolicy.canAccessSession(requestingUser, session)) {
      this.auditRepository.record({
        userId: requestingUser.username,
        operation: AuditOperation.SECURITY_AUTHORIZATION_ERROR,
        robotId: session.robotId,
        outcome: "FAILURE",
        timestamp: new Date(),
        details: {
          reason: "UNAUTHORIZED_SESSION_ACCESS_ATTEMPT",
          sessionId,
          sessionOwnerUserId: session.userId,
          requestingUserId: requestingUser.id,
        },
      }).catch(() => {});

      try {
        socket.send(JSON.stringify({ type: "error", message: "Accesso negato: non sei il titolare di questa sessione terminale." }));
        socket.close(4403, "Forbidden");
      } catch {}
      return;
    }

    // 3. Rifiuto di un secondo aggancio (RF-SSH-006)
    if (session.hasHadSocket) {
      try {
        socket.send(JSON.stringify({ type: "error", message: "Riconnessione non consentita: la sessione terminale ha già avuto un collegamento WebSocket." }));
        socket.close(4409, "Second Attach Forbidden");
      } catch {}
      return;
    }

    session.hasHadSocket = true;
    session.webSocket = socket;

    // STEP 2 – Streaming PROGRESSIVO dell'output dal PTY verso il WebSocket (CA-SSH-003, RNF-PERF-002)
    const onPtyData = (chunk: Buffer | string) => {
      session.lastActivityAt = new Date();
      if (socket.readyState === 1 /* OPEN */) {
        // Controllo del traffico e buffer limitato (RNF-PERF-002)
        if (socket.bufferedAmount > this.limits.maxBufferedBytes) {
          try {
            session.ptyChannel.pause();
          } catch {}

          const drainInterval = setInterval(() => {
            if (socket.bufferedAmount === 0 || socket.readyState !== 1) {
              clearInterval(drainInterval);
              try {
                session.ptyChannel.resume();
              } catch {}
            }
          }, 30);
        }

        socket.send(chunk);
      }
    };

    session.ptyChannel.on("data", onPtyData);

    // STEP 2 – Input dal WebSocket verso il PTY (comandi, caratteri di controllo, resize)
    socket.on("message", (rawMsg: any) => {
      session.lastActivityAt = new Date();
      // Attività qualificata: input utente o resize dal WebSocket rinnova la sessione applicativa
      if (session.authorizedContext?.sessionId) {
        this.sessionManager.touchSession(session.authorizedContext.sessionId);
      }
      const text = typeof rawMsg === "string" ? rawMsg : rawMsg.toString("utf-8");

      // Riconoscimento messaggi di controllo formattati JSON
      if (text.startsWith("{") && text.endsWith("}")) {
        try {
          const parsed = JSON.parse(text);
          if (parsed.type === "resize" && typeof parsed.cols === "number" && typeof parsed.rows === "number") {
            session.cols = parsed.cols;
            session.rows = parsed.rows;
            try {
              session.ptyChannel.setWindow(parsed.rows, parsed.cols, 0, 0);
            } catch {}
            return;
          }
          if (parsed.type === "close") {
            this.closeSession(sessionId, "USER_EXPLICIT");
            return;
          }
          if (parsed.type === "input" && typeof parsed.data === "string") {
            try {
              session.ptyChannel.write(parsed.data);
            } catch {}
            return;
          }
        } catch {
          // Se non è un comando JSON valido, trasmetti come raw input alla shell
        }
      }

      // Flusso trasparente (RF-SSH-002): nessun filtraggio comandi o blacklist
      try {
        session.ptyChannel.write(text);
      } catch {}
    });

    // Gestione Heartbeat WebSocket opzionale (RNF-REL-005, CA-SSH-004)
    if (this.config.wsPingIntervalMs && this.config.wsPingIntervalMs > 0) {
      const pingIntervalMs = this.config.wsPingIntervalMs;
      let isAlive = true;
      socket.on("pong", () => {
        isAlive = true;
      });

      const pingTimer = setInterval(() => {
        if (session.state !== "active") {
          clearInterval(pingTimer);
          return;
        }

        if (!isAlive) {
          clearInterval(pingTimer);
          session.pingTimer = undefined;
          this.logger.error(`Heartbeat WebSocket non ricevuto per sessione terminale '${sessionId}'`);
          try {
            socket.terminate();
          } catch {}
          this.closeSession(sessionId, "CLIENT_DISCONNECT", "Perdita heartbeat WebSocket");
          return;
        }

        isAlive = false;
        try {
          if (socket.readyState === 1 /* OPEN */) {
            socket.ping();
          }
        } catch {
          clearInterval(pingTimer);
          session.pingTimer = undefined;
          this.closeSession(sessionId, "CLIENT_DISCONNECT", "Errore invio ping heartbeat");
        }
      }, pingIntervalMs);

      if (typeof (pingTimer as any).unref === "function") {
        (pingTimer as any).unref();
      }
      session.pingTimer = pingTimer;
    }

    // STEP 5 – Gestione interruzione browser o canale (RF-SSH-005, CA-SSH-004)
    // Alla disconnessione il PTY viene terminato (la sessione non sopravvive)
    socket.on("close", () => {
      if (session.pingTimer) {
        clearInterval(session.pingTimer);
        session.pingTimer = undefined;
      }
      session.ptyChannel.removeListener("data", onPtyData);
      this.closeSession(sessionId, "CLIENT_DISCONNECT");
    });

    socket.on("error", (err: any) => {
      if (session.pingTimer) {
        clearInterval(session.pingTimer);
        session.pingTimer = undefined;
      }
      session.ptyChannel.removeListener("data", onPtyData);
      this.closeSession(sessionId, "CLIENT_DISCONNECT", err?.message);
    });
  }

  /**
   * STEP 5 – Chiusura e pulizia completa a zero risorse residue (RF-SSH-005, RNF-REL-005, CA-SSH-004).
   * Rilascia PTY, connessione SSH, socket e decrementa tutti i contatori.
   */
  public async closeSession(
    sessionId: string,
    reason: TerminalCloseReason,
    diagnosticMessage?: string
  ): Promise<void> {
    const session = this.activeSessions.get(sessionId);
    if (!session || session.state === "closed") {
      return;
    }

    if (session.pingTimer) {
      clearInterval(session.pingTimer);
      session.pingTimer = undefined;
    }

    session.state = "closing";
    session.closeReason = reason;
    session.diagnosticError = diagnosticMessage;

    // Rimozione immediata dalla mappa delle sessioni attive
    this.activeSessions.delete(sessionId);

    // Aggiornamento contatori di concorrenza
    const uCount = this.userSessionCounts.get(session.userId) || 0;
    if (uCount <= 1) this.userSessionCounts.delete(session.userId);
    else this.userSessionCounts.set(session.userId, uCount - 1);

    const rCount = this.robotSessionCounts.get(session.robotId) || 0;
    if (rCount <= 1) this.robotSessionCounts.delete(session.robotId);
    else this.robotSessionCounts.set(session.robotId, rCount - 1);

    // 1. Chiusura del canale PTY
    try {
      session.ptyChannel.end();
      session.ptyChannel.destroy();
    } catch {}

    // 2. Rilascio garantito della connessione gestita SSH (RNF-REL-005)
    try {
      await session.managedConnection.close();
    } catch {}

    // 3. Notifica e chiusura del socket client se ancora aperto
    if (session.webSocket && session.webSocket.readyState === 1 /* OPEN */) {
      try {
        session.webSocket.send(
          JSON.stringify({
            type: "session_closed",
            reason,
            message: "Connessione terminale chiusa.",
          })
        );
        session.webSocket.close(1000, reason);
      } catch {}
    }

    session.state = "closed";

    // STEP 8 – Registrazione Audit di chiusura con causa (RNF-SEC-009, §10.4)
    // Nessun contenuto digitato né output del terminale viene mai salvato nei log o audit (RNF-SEC-002)
    await this.auditRepository.record({
      userId: session.username,
      operation: AuditOperation.TERMINAL_CLOSE,
      robotId: session.robotId,
      outcome: "SUCCESS",
      timestamp: new Date(),
      details: {
        sessionId,
        reason,
        diagnosticMessage: diagnosticMessage ? redactSensitiveData(diagnosticMessage) : undefined,
      },
    });
  }

  /**
   * Chiude tutte le sessioni terminale aperte per un robot (es. disabilitazione con chiusura immediata).
   */
  public async closeSessionsForRobot(robotId: string, reason: TerminalCloseReason = "ADMIN_DISABLED"): Promise<void> {
    this.robotGenerations.set(robotId, (this.robotGenerations.get(robotId) || 0) + 1);

    for (const [reservationId, reservation] of Array.from(this.pendingOpens)) {
      if (reservation.robotId === robotId) {
        this.releasePendingOpen(reservationId);
      }
    }

    const message = this.closeMessageForRobot(robotId, reason);
    const toClose = Array.from(this.activeSessions.values()).filter((s) => s.robotId === robotId);

    for (const session of toClose) {
      try {
        await this.closeSession(session.sessionId, reason, message);
      } catch (err) {
        // Un errore su una sessione non deve lasciare aperte le altre (nessun dato sensibile nei log, RNF-SEC-002)
        console.error("closeSession fallita", { sessionId: session.sessionId, robotId, error: (err as Error).name });
      }
    }
  }

  private closeMessageForRobot(robotId: string, reason: TerminalCloseReason): string {
    const messages: Partial<Record<TerminalCloseReason, string>> = {
      ADMIN_DISABLED: `Robot '${robotId}' disabilitato o rimosso.`,
    };
    return messages[reason] ?? `Sessioni del robot '${robotId}' chiuse (motivo: ${reason}).`;
  }

  /**
   * Rilascio globale delle risorse all'arresto del servizio backend (RNF-REL-005).
   */
  public async closeAll(reason: TerminalCloseReason = "SERVICE_SHUTDOWN"): Promise<void> {
    this.serverGeneration++;

    try {
      if (this.idleCheckTimer) {
        clearInterval(this.idleCheckTimer);
        this.idleCheckTimer = null;
      }

      for (const reservationId of Array.from(this.pendingOpens.keys())) {
        this.releasePendingOpen(reservationId);
      }

      const sessions = Array.from(this.activeSessions.values());
      for (const session of sessions) {
        try {
          await this.closeSession(session.sessionId, reason, "Arresto ordinato del servizio.");
        } catch (err) {
          console.error("closeSession fallita in closeAll", { sessionId: session.sessionId, error: (err as Error).name });
        }
      }
    } finally {
      this.activeSessions.clear();
      this.userSessionCounts.clear();
      this.robotSessionCounts.clear();
    }
  }
}
