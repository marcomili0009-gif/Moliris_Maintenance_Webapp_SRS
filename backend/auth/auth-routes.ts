// Requisiti soddisfatti: RF-AUTH-001..006, RNF-SEC-002, RNF-SEC-004, RNF-SEC-009, SRS §6.1 punti 1–5, §9

import { type FastifyInstance, type FastifyRequest, type FastifyReply } from "fastify";
import crypto from "crypto";
import {
  SessionLimitReachedError,
  GlobalSessionLimitReachedError,
  type SessionData,
  type SessionManager,
} from "./session-manager.ts";
import { type UserRepository } from "./user-repository.ts";
import { type AuditRepository } from "../../storage/audit-repository.ts";
import { AuditOperation } from "../../storage/audit-models.ts";
import { type AuthMiddleware } from "./auth-middleware.ts";
import { hashPassword, verifyPassword, toUserProfileDto } from "./user-models.ts";
import { AppPermission } from "./permissions.ts";
import { ErrorCode, ERROR_CATALOG } from "../../errors/app-errors.ts";
import { MolirisLogger } from "../../logging/logger.ts";
import { type PhysicalFileLogger, normalizeRoleForLog, sanitizeLogText } from "../logging/physical-file-logger.ts";

export function registerAuthRoutes(
  app: FastifyInstance,
  sessionManager: SessionManager,
  userRepository: UserRepository,
  auditRepository: AuditRepository,
  authMiddleware: AuthMiddleware,
  logger: MolirisLogger,
  fileLogger?: PhysicalFileLogger
): void {
  if (fileLogger) {
    sessionManager.onSessionExpired((session, reason) => {
      fileLogger.logAccess({
        event: "INACTIVITY_LOGOUT",
        username: session.username,
        role: normalizeRoleForLog(session.roles),
        outcome: "SUCCESSO",
        details: `Sessione scaduta per inattività: ${reason}`,
      }).catch(() => {});
    });
  }
  const loginAttempts = new Map<string, { count: number; windowStartedAt: number; blockedUntil: number }>();
  (app as any)._molirisLoginAttempts = loginAttempts;
  const loginWindowMs = 5 * 60 * 1000;
  const loginMaxAttempts = 10;
  const maxTrackedLoginIps = 10_000;
  const dummyPasswordHash = hashPassword(crypto.randomBytes(32).toString("hex"));
  const pendingLogoutAudits = new Set<Promise<unknown>>();
  app.addHook("preClose", async () => {
    await Promise.allSettled(pendingLogoutAudits);
  });

  /**
   * Endpoint di Login (RF-AUTH-001, RF-AUTH-002, §6.1, CA-AUTH-001, CA-AUTH-002)
   */
  app.post("/api/auth/login", async (req: FastifyRequest, reply: FastifyReply) => {
    const ip = req.ip || "unknown";
    const now = Date.now();
    let attempt = loginAttempts.get(ip);
    if (!attempt || now - attempt.windowStartedAt >= loginWindowMs) {
      if (!attempt && loginAttempts.size >= maxTrackedLoginIps) {
        const oldestIp = loginAttempts.keys().next().value;
        if (oldestIp !== undefined) loginAttempts.delete(oldestIp);
      }
      attempt = { count: 0, windowStartedAt: now, blockedUntil: 0 };
      loginAttempts.set(ip, attempt);
    }
    const recordFailure = () => {
      attempt!.count++;
      if (attempt!.count >= loginMaxAttempts) attempt!.blockedUntil = now + loginWindowMs;
    };
    if (attempt.blockedUntil > now) {
      reply.header("Retry-After", String(Math.ceil((attempt.blockedUntil - now) / 1000)));
      return reply.status(429).send({
        code: "AUTH_RATE_LIMITED",
        message: "Troppi tentativi di accesso. Riprova più tardi.",
      });
    }

    const body = (req.body as any) || {};
    const username = typeof body.username === "string" ? body.username.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";
    // Il valore originale serve all'autenticazione; solo la copia escaped finisce nei log.
    const usernameForLog = sanitizeLogText(username);

    const invalidCredsDef = ERROR_CATALOG[ErrorCode.INVALID_CREDENTIALS];

    // Verifica credenziali con messaggio opaco e uniforme (nessun leak su esistenza utente o password)
    if (!username || !password || username.length > 128 || Buffer.byteLength(password, "utf8") > 1024) {
      recordFailure();
      await auditRepository.record({
        userId: username || "anonymous",
        operation: AuditOperation.AUTH_LOGIN,
        outcome: "FAILURE",
        timestamp: new Date(),
        details: { reason: "INVALID_CREDENTIALS_PAYLOAD" },
      });
      if (fileLogger) {
        fileLogger.logAccess({
          event: "LOGIN",
          username: username || "anonymous",
          role: "Operatore",
          outcome: "FALLIMENTO",
          details: "Payload credenziali non valido",
        }).catch(() => {});
      }
      return reply.status(401).send({
        code: invalidCredsDef.code,
        message: invalidCredsDef.userMessage,
        classification: invalidCredsDef.classification,
      });
    }

    const user = await userRepository.findByUsername(username);
    if (!user || !user.enabled) {
      // Stesso costo di derivazione della password errata per account esistenti:
      // evita che il tempo di risposta riveli l'esistenza o lo stato dell'account.
      await verifyPassword(password, await dummyPasswordHash);
      recordFailure();
      logger.info(`Tentativo di login fallito per username '${usernameForLog}'`);
      await auditRepository.record({
        userId: username,
        operation: AuditOperation.AUTH_LOGIN,
        outcome: "FAILURE",
        timestamp: new Date(),
        details: { reason: "USER_NOT_FOUND_OR_DISABLED" },
      });
      if (fileLogger) {
        fileLogger.logAccess({
          event: "LOGIN",
          username,
          role: "Operatore",
          outcome: "FALLIMENTO",
          details: "Utente non trovato o disabilitato",
        }).catch(() => {});
      }
      return reply.status(401).send({
        code: invalidCredsDef.code,
        message: invalidCredsDef.userMessage,
        classification: invalidCredsDef.classification,
      });
    }

    const passwordMatch = await verifyPassword(password, user.passwordHash);
    if (!passwordMatch) {
      recordFailure();
      logger.info(`Password non valida per username '${usernameForLog}'`);
      await auditRepository.record({
        userId: username,
        operation: AuditOperation.AUTH_LOGIN,
        outcome: "FAILURE",
        timestamp: new Date(),
        details: { reason: "INVALID_PASSWORD" },
      });
      if (fileLogger) {
        fileLogger.logAccess({
          event: "LOGIN",
          username,
          role: "Operatore",
          outcome: "FALLIMENTO",
          details: "Password errata",
        }).catch(() => {});
      }
      return reply.status(401).send({
        code: invalidCredsDef.code,
        message: invalidCredsDef.userMessage,
        classification: invalidCredsDef.classification,
      });
    }

    loginAttempts.delete(ip);

    // Creazione della sessione autenticata (§6.1 punto 4)
    // Se l'utente ha subito un reset password, assicuriamo che la nuova sessione sia temporalmente
    // strettamente successiva al reset (createdAt > passwordChangedAt), garantendo l'autenticazione valida
    // anche nell'eventualità remota di login nello stesso millisecondo.
    let session: SessionData;
    try {
      session = sessionManager.createSession(
        user,
        app.appConfig.maxSessionsPerAccount ?? app.appConfig.futureExtensions?.maxSessionsPerAccount ?? 1,
        app.appConfig.maxConcurrentWebUsers
      );
    } catch (error) {
      if (error instanceof GlobalSessionLimitReachedError) {
        await auditRepository.record({
          userId: user.username,
          operation: AuditOperation.AUTH_LOGIN,
          outcome: "FAILURE",
          timestamp: new Date(),
          details: { reason: "MAX_CONCURRENT_WEB_USERS_REACHED" },
        });

        if (fileLogger) {
          fileLogger.logAccess({
            event: "LOGIN",
            username: user.username,
            role: normalizeRoleForLog(user.roles),
            outcome: "FALLIMENTO",
            details: `Limite utenti contemporanei raggiunto (${app.appConfig.maxConcurrentWebUsers})`,
          }).catch(() => {});
        }

        return reply.status(503).send({
          success: false,
          code: "MAX_CONCURRENT_WEB_USERS_REACHED",
          message: `Raggiunto il limite massimo di utenti contemporanei alla web app (${app.appConfig.maxConcurrentWebUsers}). Riprova più tardi.`,
        });
      }

      if (!(error instanceof SessionLimitReachedError)) {
        throw error;
      }

      await auditRepository.record({
        userId: user.username,
        operation: AuditOperation.AUTH_LOGIN,
        outcome: "FAILURE",
        timestamp: new Date(),
        details: { reason: ErrorCode.SESSION_ALREADY_ACTIVE },
      });

      if (fileLogger) {
        fileLogger.logAccess({
          event: "LOGIN",
          username: user.username,
          role: normalizeRoleForLog(user.roles),
          outcome: "FALLIMENTO",
          details: "Sessione già attiva per questo account (HTTP 409)",
        }).catch(() => {});
      }

      return reply.status(409).send({
        success: false,
        code: ErrorCode.SESSION_ALREADY_ACTIVE,
        message: "Sessione già aperta da questo utente su un altro dispositivo o browser.",
      });
    }
    if (user.passwordChangedAt) {
      const resetMs = new Date(user.passwordChangedAt).getTime();
      const sessionMs = new Date(session.createdAt).getTime();
      if (sessionMs <= resetMs) {
        // Garantisce che session.createdAt sia posteriore al resetTime
        const sessionRecord = (sessionManager as any).sessions.get(session.sessionId);
        if (sessionRecord) {
          sessionRecord.createdAt = new Date(resetMs + 1);
          session = structuredClone(sessionRecord);
        }
      }
    }

    try {
      await auditRepository.record({
        userId: user.username,
        operation: AuditOperation.AUTH_LOGIN,
        outcome: "SUCCESS",
        timestamp: new Date(),
        details: { roles: user.roles },
      });
    } catch (error) {
      sessionManager.destroySession(session.sessionId, "LOGIN_FAILED");
      throw error;
    }

    if (fileLogger) {
      fileLogger.logAccess({
        event: "LOGIN",
        username: user.username,
        role: normalizeRoleForLog(user.roles),
        outcome: "SUCCESSO",
        details: "Autenticazione riuscita",
      }).catch(() => {});
    }

    // Imposta cookie di sessione sicuro (HttpOnly, Secure, SameSite=Strict)
    reply.header(
      "Set-Cookie",
      `__Host-moliris_session=${session.sessionId}; Path=/; Secure; HttpOnly; SameSite=Strict`
    );

    // Il token resta esclusivamente nel cookie HttpOnly: non esporlo al JavaScript
    // del browser riduce l'impatto di eventuali vulnerabilità XSS.
    return reply.status(200).send({
      user: toUserProfileDto(user),
    });
  });

  /**
   * Endpoint di Logout (RF-AUTH-004, Prompt #4)
   * Invalida la sessione lato server, registra l'audit con eventuale contesto e ripulisce il cookie.
   */
  app.post("/api/auth/logout", (req: FastifyRequest, reply: FastifyReply) => {
    const sessionId = authMiddleware.extractSessionId(req);
    const body = (req.body as any) || {};
    const context = body.context === "terminale" ? "terminale" : "sessione";
    const reason = typeof body.reason === "string" ? body.reason : "MANUAL_LOGOUT";

    const session = sessionId ? sessionManager.getSession(sessionId) : null;
    if (session && sessionManager.destroySession(session.sessionId)) {
      const audit = auditRepository.record({
        userId: session.username,
        operation: AuditOperation.AUTH_LOGOUT,
        outcome: "SUCCESS",
        timestamp: new Date(),
        details: { context, reason },
      }).catch((err: unknown) => {
        logger.error("Errore di registrazione audit logout", err instanceof Error ? err.message : undefined, {
          userId: session.username,
        });
      }).finally(() => { pendingLogoutAudits.delete(audit); });
      pendingLogoutAudits.add(audit);

      if (fileLogger) {
        fileLogger.logAccess({
          event: "LOGOUT",
          username: session.username,
          role: normalizeRoleForLog(session.roles),
          outcome: "SUCCESSO",
          details: reason,
        }).catch(() => {});
      }
    }

    reply.header(
      "Set-Cookie",
      "__Host-moliris_session=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT"
    );
    reply.header("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    reply.header("Pragma", "no-cache");
    reply.header("Expires", "0");

    return reply.status(200).send({
      status: "LOGGED_OUT",
      message: "Sessione terminata con successo.",
    });
  });

  /**
   * Endpoint di Conferma Inattività (Prompt #4 - Azione CONFIRM)
   * Rinnova la sessione lato server azzerando il timer di inattività e traccia l'audit.
   */
  app.post(
    "/api/auth/session/confirm",
    { preHandler: [authMiddleware.authenticate.bind(authMiddleware)] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const session = req.molirisSession!;
      const user = req.molirisUser!;
      const body = (req.body as any) || {};
      const context = body.context === "terminale" ? "terminale" : "sessione";

      sessionManager.touchSession(session.sessionId);

      await auditRepository.record({
        userId: user.username,
        operation: AuditOperation.SESSION_IDLE_CONFIRM,
        outcome: "SUCCESS",
        timestamp: new Date(),
        details: { context, action: "CONFIRM" },
      });

      return reply.status(200).send({
        success: true,
        message: "Sessione rinnovata con successo.",
      });
    }
  );

  /**
   * Endpoint di notifica avviso inattività (Prompt #4 - Avviso mostrato)
   * Traccia nell'audit log che l'utente ha visualizzato il pop-up di avviso prima della scadenza.
   */
  app.post(
    "/api/auth/session/warning",
    { preHandler: [authMiddleware.authenticate.bind(authMiddleware)] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const user = req.molirisUser!;
      const body = (req.body as any) || {};
      const context = body.context === "terminale" ? "terminale" : "sessione";
      const remainingSeconds = typeof body.remainingSeconds === "number" ? body.remainingSeconds : undefined;

      await auditRepository.record({
        userId: user.username,
        operation: AuditOperation.SESSION_IDLE_WARNING,
        outcome: "SUCCESS",
        timestamp: new Date(),
        details: { context, action: "WARNING_SHOWN", remainingSeconds },
      });

      return reply.status(200).send({
        success: true,
      });
    }
  );

  /**
   * Endpoint esplicito di heartbeat per rinnovo attività (Requisito #4)
   */
  app.post(
    "/api/auth/heartbeat",
    { preHandler: [authMiddleware.authenticate.bind(authMiddleware)] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const session = req.molirisSession!;
      sessionManager.touchSession(session.sessionId);
      return reply.status(200).send({
        success: true,
        lastActivityAt: session.lastActivityAt,
      });
    }
  );

  /**
   * Endpoint per ottenere il profilo dell'utente autenticato (RF-AUTH-003, Requisito #3)
   */
  app.get("/api/auth/me", { preHandler: [authMiddleware.authenticate.bind(authMiddleware)] }, async (req: FastifyRequest, reply: FastifyReply) => {
    const user = req.molirisUser!;
    const profile = toUserProfileDto(user);
    reply.header("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    reply.header("Pragma", "no-cache");
    reply.header("Expires", "0");
    return reply.status(200).send({
      user: profile,
      allowedPaths: profile.allowedPaths || [],
    });
  });

}
