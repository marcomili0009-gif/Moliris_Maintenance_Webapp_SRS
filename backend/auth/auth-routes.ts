// Requisiti soddisfatti: RF-AUTH-001..006, RNF-SEC-002, RNF-SEC-004, RNF-SEC-009, SRS §6.1 punti 1–5, §9

import { type FastifyInstance, type FastifyRequest, type FastifyReply } from "fastify";
import crypto from "crypto";
import { type SessionManager } from "./session-manager.ts";
import { type UserRepository } from "./user-repository.ts";
import { type AuditRepository } from "../../storage/audit-repository.ts";
import { AuditOperation } from "../../storage/audit-models.ts";
import { type AuthMiddleware } from "./auth-middleware.ts";
import { hashPassword, verifyPassword, toUserProfileDto } from "./user-models.ts";
import { AppPermission } from "./permissions.ts";
import { ErrorCode, ERROR_CATALOG } from "../../errors/app-errors.ts";
import { MolirisLogger } from "../../logging/logger.ts";

export function registerAuthRoutes(
  app: FastifyInstance,
  sessionManager: SessionManager,
  userRepository: UserRepository,
  auditRepository: AuditRepository,
  authMiddleware: AuthMiddleware,
  logger: MolirisLogger
): void {
  const loginAttempts = new Map<string, { count: number; windowStartedAt: number; blockedUntil: number }>();
  (app as any)._molirisLoginAttempts = loginAttempts;
  const loginWindowMs = 5 * 60 * 1000;
  const loginMaxAttempts = 10;
  const maxTrackedLoginIps = 10_000;
  const dummyPasswordHash = hashPassword(crypto.randomBytes(32).toString("hex"));

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
      logger.info(`Tentativo di login fallito per username '${username}'`);
      await auditRepository.record({
        userId: username,
        operation: AuditOperation.AUTH_LOGIN,
        outcome: "FAILURE",
        timestamp: new Date(),
        details: { reason: "USER_NOT_FOUND_OR_DISABLED" },
      });
      return reply.status(401).send({
        code: invalidCredsDef.code,
        message: invalidCredsDef.userMessage,
        classification: invalidCredsDef.classification,
      });
    }

    const passwordMatch = await verifyPassword(password, user.passwordHash);
    if (!passwordMatch) {
      recordFailure();
      logger.info(`Password non valida per username '${username}'`);
      await auditRepository.record({
        userId: username,
        operation: AuditOperation.AUTH_LOGIN,
        outcome: "FAILURE",
        timestamp: new Date(),
        details: { reason: "INVALID_PASSWORD" },
      });
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
    let session = sessionManager.createSession(user);
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

    await auditRepository.record({
      userId: user.username,
      operation: AuditOperation.AUTH_LOGIN,
      outcome: "SUCCESS",
      timestamp: new Date(),
      details: { roles: user.roles },
    });

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
   * Endpoint di Logout (RF-AUTH-004)
   * Invalida la sessione lato server e ripulisce il cookie.
   */
  app.post("/api/auth/logout", async (req: FastifyRequest, reply: FastifyReply) => {
    const sessionId = authMiddleware.extractSessionId(req);
    if (sessionId) {
      const session = sessionManager.getSession(sessionId);
      const username = session ? session.username : "unknown";
      sessionManager.destroySession(sessionId);

      await auditRepository.record({
        userId: username,
        operation: AuditOperation.AUTH_LOGOUT,
        outcome: "SUCCESS",
        timestamp: new Date(),
      });
    }

    reply.header(
      "Set-Cookie",
      "__Host-moliris_session=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT"
    );

    return reply.status(200).send({
      status: "LOGGED_OUT",
      message: "Sessione terminata con successo.",
    });
  });

  /**
   * Endpoint per ottenere il profilo dell'utente autenticato (RF-AUTH-003)
   */
  app.get("/api/auth/me", { preHandler: [authMiddleware.authenticate.bind(authMiddleware)] }, async (req: FastifyRequest, reply: FastifyReply) => {
    const user = req.molirisUser!;
    return reply.status(200).send({
      user: toUserProfileDto(user),
    });
  });

  /**
   * Endpoint protetto flotta (placeholder SRS §6.1 punto 5)
   * Richiede permesso AppPermission.FLEET_VIEW (RF-ROB-001, RF-AUTH-005, RNF-SEC-004)
   */
  app.get(
    "/api/fleet/summary",
    { preHandler: [authMiddleware.requirePermission(AppPermission.FLEET_VIEW)] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      return reply.status(200).send({
        status: "OK",
        description: "Placeholder schermata della flotta (SRS §6.1 punto 5)",
        robots: [],
      });
    }
  );
}
