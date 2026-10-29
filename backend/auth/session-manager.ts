// Requisiti soddisfatti: RF-AUTH-003, RF-AUTH-004, RF-AUTH-006, RF-SSH-005, RF-SSH-006,
// RNF-SEC-007, RNF-SEC-009, RNF-REL-005, SRS §6.1 punto 4

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

export type SessionTerminationReason = "LOGOUT" | "EXPIRED";

export type SessionTerminationListener = (
  sessionId: string,
  userId: string,
  reason: SessionTerminationReason
) => void;

/**
 * Contesto autorizzato (RF-SSH-006, RNF-SEC-007).
 * Oggetto riusabile in seguito dai servizi (terminale, trasferimenti)
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

  constructor(inactiveSessionTimeoutMinutes: number) {
    if (!inactiveSessionTimeoutMinutes || inactiveSessionTimeoutMinutes <= 0) {
      throw new Error("Il parametro di timeout sessione deve essere un numero positivo maggiore di zero (RF-AUTH-006).");
    }
    this.timeoutMs = inactiveSessionTimeoutMinutes * 60 * 1000;
  }

  /**
   * Registra un listener per gli eventi di chiusura o scadenza sessione (RF-SSH-005, RNF-REL-005).
   * Permette ai moduli futuri (terminale, trasferimenti) di rilasciare le risorse correlate.
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
   * Recupera e convalida una sessione verificando l'inattività (RF-AUTH-006).
   * Se la sessione è inattiva da più del timeout configurato, viene invalidata e rimossa.
   */
  public getSession(sessionId: string): SessionData | null {
    if (!sessionId) return null;

    const session = this.sessions.get(sessionId);
    if (!session) return null;

    const now = Date.now();
    const elapsed = now - session.lastActivityAt.getTime();

    if (elapsed > this.timeoutMs) {
      // Sessione scaduta per inattività: rimozione e notifica
      this.sessions.delete(sessionId);
      this.notifyTermination(sessionId, session.userId, "EXPIRED");
      return null;
    }

    // Aggiornamento timestamp di ultima attività
    session.lastActivityAt = new Date(now);
    return structuredClone(session);
  }

  /**
   * Invalida esplicitamente la sessione lato server (RF-AUTH-004).
   */
  public destroySession(sessionId: string): boolean {
    if (!sessionId) return false;

    const session = this.sessions.get(sessionId);
    if (!session) return false;

    this.sessions.delete(sessionId);
    this.notifyTermination(sessionId, session.userId, "LOGOUT");
    return true;
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

  // Utilità di test per forzare una data di inattività
  public _simulateInactivity(sessionId: string, inactiveMinutes: number): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.lastActivityAt = new Date(Date.now() - (inactiveMinutes * 60 * 1000 + 1000));
    }
  }
}
