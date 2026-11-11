// Requisiti soddisfatti: RF-AUTH-001..006, RNF-SEC-004, RNF-SEC-009, SRS §9, CA-AUTH-001..003

import { type FastifyRequest, type FastifyReply } from "fastify";
import { type SessionManager, type SessionData } from "./session-manager.ts";
import { type UserRepository } from "./user-repository.ts";
import { type UserEntity } from "./user-models.ts";
import { type AppPermission, type RolePermissionMapping, DEFAULT_ROLE_PERMISSIONS, hasPermission } from "./permissions.ts";
import { type AuditRepository } from "../../storage/audit-repository.ts";
import { AuditOperation } from "../../storage/audit-models.ts";
import { MolirisAppError, ErrorCode, ERROR_CATALOG } from "../../errors/app-errors.ts";
import { MolirisLogger } from "../../logging/logger.ts";

// Estensione dei tipi FastifyRequest per memorizzare utente e sessione autenticati
declare module "fastify" {
  interface FastifyRequest {
    molirisSession?: SessionData;
    molirisUser?: UserEntity;
  }
}

export class AuthMiddleware {
  private sessionManager: SessionManager;
  private userRepository: UserRepository;
  private auditRepository: AuditRepository;
  private logger: MolirisLogger;
  private roleMapping: RolePermissionMapping;

  constructor(
    sessionManager: SessionManager,
    userRepository: UserRepository,
    auditRepository: AuditRepository,
    logger: MolirisLogger,
    roleMapping: RolePermissionMapping = DEFAULT_ROLE_PERMISSIONS
  ) {
    this.sessionManager = sessionManager;
    this.userRepository = userRepository;
    this.auditRepository = auditRepository;
    this.logger = logger;
    this.roleMapping = roleMapping;
  }

  /**
   * Estrae il token di sessione dalla richiesta (header Authorization o cookie).
   */
  public extractSessionId(req: FastifyRequest): string | null {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith("Bearer ")) {
      return authHeader.substring(7).trim();
    }

    const cookies = req.headers.cookie;
    if (cookies) {
      const match = cookies.match(/(?:^|;\s*)moliris_session=([^;]+)/);
      if (match) {
        return match[1].trim();
      }
    }

    return null;
  }

  /**
   * Guardia di autenticazione: verifica sessione valida e non scaduta (RF-AUTH-003, RF-AUTH-006).
   */
  public async authenticate(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const sessionId = this.extractSessionId(req);

    if (!sessionId) {
      await this.recordSecurityError("anonymous", undefined, "SESSION_MISSING");
      const errDef = ERROR_CATALOG[ErrorCode.INVALID_CREDENTIALS];
      reply.status(401).send({
        code: errDef.code,
        message: "Sessione di accesso non presente o non valida.",
        classification: errDef.classification,
      });
      return;
    }

    const session = this.sessionManager.validate(sessionId);
    if (!session) {
      await this.recordSecurityError("anonymous", undefined, "SESSION_EXPIRED_OR_INVALID");
      const errDef = ERROR_CATALOG[ErrorCode.INVALID_CREDENTIALS];
      reply.status(401).send({
        code: errDef.code,
        message: "Sessione scaduta o non valida. Effettuare nuovamente il login.",
        classification: errDef.classification,
      });
      return;
    }

    const user = await this.userRepository.findById(session.userId);
    if (!user || !user.enabled) {
      await this.recordSecurityError(session.username, undefined, "USER_DISABLED_OR_NOT_FOUND");
      this.sessionManager.destroySession(sessionId);
      const errDef = ERROR_CATALOG[ErrorCode.INVALID_CREDENTIALS];
      reply.status(401).send({
        code: errDef.code,
        message: "Utente disabilitato o non trovato.",
        classification: errDef.classification,
      });
      return;
    }

    // Rinnovo attività qualificata: richieste API autenticate (escluso polling automatico di monitoraggio RF-MON-003)
    const isMonitoringPolling =
      req.method === "GET" &&
      /^\/api\/robots\/[^/]+\/status(?:\?.*)?$/.test(req.url);
    if (!isMonitoringPolling) {
      this.sessionManager.touchSession(sessionId);
    }

    req.molirisSession = session;
    req.molirisUser = user;
  }

  /**
   * Guardia centrale di autorizzazione RBAC (RF-AUTH-005, RNF-SEC-004, CA-AUTH-003).
   * Default fail-closed: nega l'accesso se il permesso (+ robot opzionale) non è esplicitamente accordato.
   */
  public requirePermission(
    permission: AppPermission,
    robotIdExtractor?: (req: FastifyRequest) => string | undefined
  ) {
    return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
      // 1. Verifica autenticazione
      if (!req.molirisUser || !req.molirisSession) {
        await this.authenticate(req, reply);
        if (reply.sent) return;
      }

      const user = req.molirisUser!;
      const targetRobotId = robotIdExtractor ? robotIdExtractor(req) : undefined;

      // 2. Valutazione RBAC con target robot (CA-SSH-005)
      const allowed = hasPermission(user, permission, targetRobotId, this.roleMapping);

      if (!allowed) {
        await this.recordSecurityError(user.username, targetRobotId, `PERMISSION_DENIED_${permission}`);
        const errDef = ERROR_CATALOG[ErrorCode.INSUFFICIENT_PERMISSIONS];
        reply.status(403).send({
          code: errDef.code,
          message: errDef.userMessage,
          classification: errDef.classification,
        });
        return;
      }
    };
  }

  private async recordSecurityError(
    userId: string,
    robotId: string | undefined,
    reason: string
  ): Promise<void> {
    this.logger.error("Errore di autorizzazione o accesso negato", reason, { userId, robotId });
    try {
      await this.auditRepository.record({
        userId,
        operation: AuditOperation.SECURITY_AUTHORIZATION_ERROR,
        robotId,
        outcome: "FAILURE",
        timestamp: new Date(),
        details: { reason },
      });
    } catch {
      // Evita che un fallimento dell'audit comprometta la sicurezza del blocco
    }
  }
}
