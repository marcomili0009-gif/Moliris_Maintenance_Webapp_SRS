// Requisiti soddisfatti: RF-AUTH-003, RF-AUTH-004, RF-AUTH-006, RF-SSH-005, RF-SSH-006,
// RNF-SEC-007, RNF-SEC-009, RNF-REL-005, SRS §6.1 punto 4, §10.1, §11.6

import crypto from "crypto";
import { type UserEntity } from "./user-models.ts";
import { AppPermission, type RolePermissionMapping, DEFAULT_ROLE_PERMISSIONS, hasPermission } from "./permissions.ts";

export interface SessionData {
  sessionId: string;
  userId: string;
  username: string;
  roles: string[];
  createdAt: Date;
  lastActivityAt: Date;
}

export type SessionTerminationReason = "LOGOUT" | "EXPIRED" | "PASSWORD_RESET";

export type SessionTerminationListener = (
  sessionId: string,
  userId: string,
  reason: SessionTerminationReason
) => void;

/**
 * Contesto autorizzato (RF-SSH-006, RNF-SEC-007).
 * Oggetto riusabile dai servizi (terminale, trasferimenti)
 * per associare sessioni remote e stream all'identità verificata dell'utente.
 */
export interface AuthorizedContext {
  sessionId: string;
  userId: string;
  username: string;
  roles: string[];
  targetRobotId?: string;
  permissions: Set<AppPermission>;
}

export class SessionManager {
  private sessions: Map<string, SessionData> = new Map();
  private terminationListeners: SessionTerminationListener[] = [];
  private readonly timeoutMs: number;
  private readonly absoluteTimeoutMs?: number;
  private expiryTimer: NodeJS.Timeout | null = null;

  constructor(inactiveMinutes?: number, absoluteMinutes?: number);
  constructor(userRepo: unknown, auditRepo: unknown, inactiveMinutes: number, logger?: unknown);
  constructor(
    arg1?: number | unknown,
    arg2?: number | unknown,
    arg3?: number,
    arg4?: unknown
  ) {
    let inactiveMinutes = 30;
    let absoluteMinutes: number | undefined = undefined;

    if (typeof arg1 === "number") {
      inactiveMinutes = arg1;
      if (typeof arg2 === "number") {
        absoluteMinutes = arg2;
      }
    } else if (typeof arg3 === "number") {
      // Supporto per test con firma estesa (userRepo, auditRepo, inactiveMinutes, logger)
      inactiveMinutes = arg3;
      if (typeof arg4 === "number") {
        absoluteMinutes = arg4;
      }
    }

    if (!inactiveMinutes || inactiveMinutes <= 0) {
      throw new Error("Il parametro di timeout sessione deve essere un numero positivo maggiore di zero (RF-AUTH-006).");
    }
    this.timeoutMs = inactiveMinutes * 60 * 1000;

    if (absoluteMinutes !== undefined) {
      if (!Number.isInteger(absoluteMinutes) || absoluteMinutes <= 0) {
        throw new Error("Il parametro di timeout assoluto sessione deve essere un numero intero positivo maggiore di zero.");
      }
      this.absoluteTimeoutMs = absoluteMinutes * 60 * 1000;
    }

    this.startExpiryTimer();
  }

  private startExpiryTimer(): void {
    // Controllo periodico attivo delle scadenze (evita dipendenza esclusiva da chiamate lazy)
    const intervalMs = Math.min(this.timeoutMs, 5000);
    this.expiryTimer = setInterval(() => {
      this.purgeExpiredSessions();
    }, intervalMs);

    if (this.expiryTimer && typeof (this.expiryTimer as any).unref === "function") {
      (this.expiryTimer as any).unref();
    }
  }

  /**
   * Scorre ed elimina tutte le sessioni scadute per inattività o per tetto assoluto.
   */
  public purgeExpiredSessions(): void {
    const now = Date.now();
    for (const [sessionId, session] of Array.from(this.sessions.entries())) {
      const inactiveElapsed = now - session.lastActivityAt.getTime();
      const absoluteElapsed = now - session.createdAt.getTime();

      const isInactiveExpired = inactiveElapsed > this.timeoutMs;
      const isAbsoluteExpired = this.absoluteTimeoutMs ? absoluteElapsed > this.absoluteTimeoutMs : false;

      if (isInactiveExpired || isAbsoluteExpired) {
        this.sessions.delete(sessionId);
        this.notifyTermination(sessionId, session.userId, "EXPIRED");
      }
    }
  }

  /**
   * Registra un listener per gli eventi di chiusura o scadenza sessione (RF-SSH-005, RNF-REL-005).
   * Notifica i servizi di terminale e trasferimento per la deallocazione tempestiva delle risorse.
   */
  public onSessionTerminated(listener: SessionTerminationListener): void {
    this.terminationListeners.push(listener);
  }

  /**
   * Crea una nuova sessione autenticata con token crittografico casuale a 256 bit (RF-AUTH-003).
   */
  public createSession(user: UserEntity): SessionData {
    const sessionId = crypto.randomBytes(32).toString("hex");
    const now = new Date();
    const session: SessionData = {
      sessionId,
      userId: user.id,
      username: user.username,
      roles: [...user.roles],
      createdAt: now,
      lastActivityAt: now,
    };
    this.sessions.set(sessionId, session);
    return structuredClone(session);
  }

  /**
   * Valida l'esistenza e la validità temporale della sessione SENZA aggiornare lastActivityAt.
   * Se la sessione è scaduta per inattività o per timeout assoluto, viene invalidata e rimossa.
   */
  public validate(sessionId: string): SessionData | null {
    if (!sessionId) return null;

    const session = this.sessions.get(sessionId);
    if (!session) return null;

    const now = Date.now();
    const inactiveElapsed = now - session.lastActivityAt.getTime();
    const absoluteElapsed = now - session.createdAt.getTime();

    if (inactiveElapsed > this.timeoutMs || (this.absoluteTimeoutMs && absoluteElapsed > this.absoluteTimeoutMs)) {
      this.sessions.delete(sessionId);
      this.notifyTermination(sessionId, session.userId, "EXPIRED");
      return null;
    }

    return structuredClone(session);
  }

  /**
   * Rinnova il timestamp di ultima attività (lastActivityAt) per la sessione specificata.
   * Da invocare ESCLUSIVAMENTE a fronte di attività qualificate:
   * - Richieste API HTTP autenticate
   * - Input dell'utente sul WebSocket del terminale (tasti o resize)
   * - Avanzamento di un trasferimento file avviato dalla stessa sessione
   * NON contano: output del robot, polling di monitoraggio, heartbeat tecnici.
   */
  public touchSession(sessionId: string): boolean {
    if (!sessionId) return false;

    const session = this.sessions.get(sessionId);
    if (!session) return false;

    const now = Date.now();
    const inactiveElapsed = now - session.lastActivityAt.getTime();
    const absoluteElapsed = now - session.createdAt.getTime();

    if (inactiveElapsed > this.timeoutMs || (this.absoluteTimeoutMs && absoluteElapsed > this.absoluteTimeoutMs)) {
      this.sessions.delete(sessionId);
      this.notifyTermination(sessionId, session.userId, "EXPIRED");
      return false;
    }

    session.lastActivityAt = new Date(now);
    return true;
  }

  /**
   * Metodo di compatibilità: valida e restituisce la sessione senza rinnovarla.
   */
  public getSession(sessionId: string): SessionData | null {
    return this.validate(sessionId);
  }

  /**
   * Invalida esplicitamente la sessione lato server (RF-AUTH-004).
   */
  public destroySession(sessionId: string, reason: SessionTerminationReason = "LOGOUT"): boolean {
    if (!sessionId) return false;

    const session = this.sessions.get(sessionId);
    if (!session) return false;

    this.sessions.delete(sessionId);
    this.notifyTermination(sessionId, session.userId, reason);
    return true;
  }

  /**
   * Distrugge e revoca immediatamente tutte le sessioni attive in RAM per un determinato utente.
   * Rilascia tutte le risorse associate (terminali WebSocket/PTY e trasferimenti SFTP)
   * tramite i listener onSessionTerminated registrati.
   */
  public destroySessionsForUser(userId: string, reason: SessionTerminationReason = "PASSWORD_RESET"): number {
    if (!userId) return 0;
    let count = 0;
    for (const [sessionId, session] of Array.from(this.sessions.entries())) {
      if (session.userId === userId) {
        this.sessions.delete(sessionId);
        this.notifyTermination(sessionId, session.userId, reason);
        count++;
      }
    }
    return count;
  }

  /**
   * Crea il Contesto Autorizzato per un utente e un robot target opzionale (RF-SSH-006, RNF-SEC-007).
   */
  public createAuthorizedContext(
    session: SessionData,
    user: UserEntity,
    targetRobotId?: string,
    roleMapping: RolePermissionMapping = DEFAULT_ROLE_PERMISSIONS
  ): AuthorizedContext {
    const permissions = new Set<AppPermission>();
    for (const perm of Object.values(AppPermission)) {
      if (hasPermission(user, perm, targetRobotId, roleMapping)) {
        permissions.add(perm);
      }
    }

    return {
      sessionId: session.sessionId,
      userId: session.userId,
      username: session.username,
      roles: [...session.roles],
      targetRobotId,
      permissions,
    };
  }

  private notifyTermination(sessionId: string, userId: string, reason: SessionTerminationReason): void {
    for (const listener of this.terminationListeners) {
      try {
        listener(sessionId, userId, reason);
      } catch {
        // Nessun fallimento del listener deve interrompere la revoca della sessione
      }
    }
  }

  public _simulateInactivity(sessionId: string, inactiveMinutes: number): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.lastActivityAt = new Date(Date.now() - (inactiveMinutes * 60 * 1000 + 1000));
    }
  }

  public _simulateAge(sessionId: string, ageMinutes: number): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.createdAt = new Date(Date.now() - (ageMinutes * 60 * 1000 + 1000));
    }
  }

  public dispose(): void {
    if (this.expiryTimer) {
      clearInterval(this.expiryTimer);
      this.expiryTimer = null;
    }
  }
}
