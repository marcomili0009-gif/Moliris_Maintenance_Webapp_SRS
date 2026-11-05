// Requisiti soddisfatti: RF-SSH-001, RF-SSH-004, RF-SSH-005, RF-SSH-006, RF-SSH-007,
// RNF-SEC-001, RNF-SEC-004, RNF-SEC-007, RNF-SEC-009, SRS §5.4, §6.4, §9, CA-SSH-001..005

import { type FastifyInstance, type FastifyRequest, type FastifyReply } from "fastify";
import { type TerminalService } from "./terminal-service.ts";
import { type SessionManager } from "../auth/session-manager.ts";
import { type UserRepository } from "../auth/user-repository.ts";
import { type AuditRepository } from "../../storage/audit-repository.ts";
import { AuditOperation } from "../../storage/audit-models.ts";
import { type AuthMiddleware } from "../auth/auth-middleware.ts";
import { AppPermission } from "../auth/permissions.ts";
import { MolirisAppError, ErrorCode, ERROR_CATALOG } from "../../errors/app-errors.ts";

export function registerTerminalRoutes(
  app: FastifyInstance,
  terminalService: TerminalService,
  sessionManager: SessionManager,
  userRepository: UserRepository,
  auditRepository: AuditRepository,
  authMiddleware: AuthMiddleware
): void {
  const extractRobotId = (req: FastifyRequest): string | undefined => {
    return (req.params as any)?.robotId;
  };

  const handleError = (err: any, reply: FastifyReply) => {
    if (err instanceof MolirisAppError) {
      const status =
        err.code === ErrorCode.INSUFFICIENT_PERMISSIONS
          ? 403
          : err.code === ErrorCode.MISSING_ROBOT_PARAMS
          ? 400
          : err.code === ErrorCode.HOST_UNREACHABLE || err.code === ErrorCode.SSH_PORT_UNAVAILABLE
          ? 502
          : err.code === ErrorCode.TIMEOUT_ERROR
          ? 504
          : err.code === ErrorCode.INSUFFICIENT_STORAGE
          ? 429
          : 500;

      return reply.status(status).send({
        code: err.code,
        message: err.userMessage,
        classification: err.classification,
      });
    }

    const defaultDef = ERROR_CATALOG[ErrorCode.TERMINAL_SESSION_ERROR];
    return reply.status(500).send({
      code: defaultDef.code,
      message: defaultDef.userMessage,
      classification: defaultDef.classification,
    });
  };

  // STEP 1 – Apertura sessione terminale e allocazione PTY (RF-SSH-001, RF-SSH-004, §6.4 passi 1-5)
  // Il browser indica SOLO robotId e dimensioni iniziali; nessun parametro di connessione o credenziale (CA-SSH-001)
  app.post(
    "/api/robots/:robotId/terminal/sessions",
    { preHandler: [authMiddleware.requirePermission(AppPermission.TERMINAL_OPEN, extractRobotId)] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        const user = req.molirisUser!;
        const robotId = extractRobotId(req)!;
        const userSessionId = req.molirisSession!.sessionId;

        const body = (req.body as any) || {};
        const cols = typeof body.cols === "number" ? body.cols : 80;
        const rows = typeof body.rows === "number" ? body.rows : 24;

        const session = await terminalService.openTerminalSession(
          user,
          robotId,
          { cols, rows },
          userSessionId
        );

        return reply.status(201).send({
          success: true,
          sessionId: session.sessionId,
          robotId: session.robotId,
          cols: session.cols,
          rows: session.rows,
        });
      } catch (err: any) {
        return handleError(err, reply);
      }
    }
  );

  // STEP 1 & 2 – Canale bidirezionale in tempo reale protetto su WebSocket / WSS (§5.4, §6.4 passi 4-5)
  // Autenticato e autorizzato lato server prima di connettere il flusso (RF-SSH-006, RNF-SEC-004)
  app.get(
    "/api/terminal/ws/:sessionId",
    {
      websocket: true,
      preValidation: async (req, reply) => {
        const origin = req.headers.origin;
        const host = req.headers.host;
        const isHttps = Boolean((req.raw.socket as any).encrypted);

        let validOrigin = false;

        if (typeof origin === "string" && typeof host === "string" && isHttps) {
          try {
            const parsedOrigin = new URL(origin);
            const expectedOrigin = new URL(`https://${host}`);

            validOrigin =
              parsedOrigin.protocol === "https:" &&
              parsedOrigin.origin === origin &&
              parsedOrigin.origin === expectedOrigin.origin;
          } catch {
            validOrigin = false;
          }
        }

        if (!validOrigin) {
          const reason =
            !origin ? "WS_ORIGIN_MISSING" : "WS_ORIGIN_INVALID_OR_MISMATCH";

          await auditRepository.record({
            userId: "anonymous",
            operation: AuditOperation.SECURITY_AUTHORIZATION_ERROR,
            outcome: "FAILURE",
            timestamp: new Date(),
            details: { reason, sessionId: (req.params as any)?.sessionId },
          });

          return reply.code(403).send({
            message: "Origine WebSocket non autorizzata.",
          });
        }
      },
    },
    async (socket: any, req: FastifyRequest) => {
      const sessionId = (req.params as any)?.sessionId;

      // 1. Estrazione esclusiva del cookie di sessione HttpOnly
      const cookieHeader = req.headers.cookie;
      let userSessionId: string | null = null;
      if (cookieHeader) {
        const match = cookieHeader.match(/moliris_session=([a-f0-9]+)/i);
        if (match) userSessionId = match[1];
      }

      if (!userSessionId) {
        await auditRepository.record({
          userId: "anonymous",
          operation: AuditOperation.SECURITY_AUTHORIZATION_ERROR,
          outcome: "FAILURE",
          timestamp: new Date(),
          details: { reason: "WS_SESSION_COOKIE_MISSING", sessionId },
        });

        socket.send(JSON.stringify({ type: "error", message: "Accesso non autorizzato: sessione mancante." }));
        socket.close(4401, "Unauthorized");
        return;
      }

      // 2. Convalida sessione utente
      const userSession = sessionManager.getSession(userSessionId);
      if (!userSession) {
        await auditRepository.record({
          userId: "anonymous",
          operation: AuditOperation.SECURITY_AUTHORIZATION_ERROR,
          outcome: "FAILURE",
          timestamp: new Date(),
          details: { reason: "WS_SESSION_EXPIRED_OR_INVALID", sessionId },
        });

        socket.send(JSON.stringify({ type: "error", message: "Sessione utente non valida o scaduta." }));
        socket.close(4401, "Session Expired");
        return;
      }

      const user = await userRepository.findById(userSession.userId);
      if (!user || !user.enabled) {
        socket.send(JSON.stringify({ type: "error", message: "Account utente disabilitato o non trovato." }));
        socket.close(4401, "User Disabled");
        return;
      }

      // 3. Convalida titolarità e aggancio del flusso (RF-SSH-006, CA-SSH-005)
      terminalService.attachWebSocket(sessionId, user, socket);
    }
  );

  // STEP 5 – Chiusura esplicita della sessione terminale via REST (RF-SSH-005, CA-SSH-004)
  app.delete(
    "/api/terminal/sessions/:sessionId",
    { preHandler: [authMiddleware.authenticate.bind(authMiddleware)] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        const user = req.molirisUser!;
        const sessionId = (req.params as any)?.sessionId;
        const session = terminalService.getSession(sessionId);

        if (!session) {
          return reply.status(404).send({
            code: ErrorCode.TERMINAL_SESSION_ERROR,
            message: "Sessione terminale non trovata.",
          });
        }

        if (session.userId !== user.id && !user.roles.includes("amministratore")) {
          await auditRepository.record({
            userId: user.username,
            operation: AuditOperation.SECURITY_AUTHORIZATION_ERROR,
            robotId: session.robotId,
            outcome: "FAILURE",
            timestamp: new Date(),
            details: { reason: "PERMISSION_DENIED_CLOSE_OTHER_SESSION", sessionId },
          });

          return reply.status(403).send({
            code: ErrorCode.INSUFFICIENT_PERMISSIONS,
            message: "Operazione non consentita: non puoi chiudere la sessione di un altro utente.",
          });
        }

        await terminalService.closeSession(sessionId, "USER_EXPLICIT");
        return reply.status(200).send({
          success: true,
          message: "Sessione terminale chiusa con successo.",
        });
      } catch (err: any) {
        return handleError(err, reply);
      }
    }
  );
}
