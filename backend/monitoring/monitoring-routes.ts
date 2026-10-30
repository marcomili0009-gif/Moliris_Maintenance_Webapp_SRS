// Requisiti soddisfatti: RF-MON-001, RF-MON-002, RF-MON-004, RF-MON-006,
// RNF-SEC-002, RNF-SEC-004, RNF-SEC-009, SRS §5.3, §9, CA-AUTH-003, CA-MON-003

import { type FastifyInstance, type FastifyRequest, type FastifyReply } from "fastify";
import { type MonitoringService } from "./monitoring-service.ts";
import { type AuthMiddleware } from "../auth/auth-middleware.ts";
import { AppPermission } from "../auth/permissions.ts";
import { MolirisAppError, ErrorCode, ERROR_CATALOG } from "../../errors/app-errors.ts";

export function registerMonitoringRoutes(
  app: FastifyInstance,
  monitoringService: MonitoringService,
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
          : 500;

      return reply.status(status).send({
        code: err.code,
        message: err.userMessage,
        classification: err.classification,
      });
    }

    const defaultDef = ERROR_CATALOG[ErrorCode.STATE_FILE_UNREADABLE];
    return reply.status(500).send({
      code: defaultDef.code,
      message: defaultDef.userMessage,
      classification: defaultDef.classification,
    });
  };

  // Lettura stato di dettaglio e monitoraggio del robot (RF-MON-001, RF-MON-006, RF-ROB-002)
  app.get(
    "/api/robots/:robotId/status",
    { preHandler: [authMiddleware.requirePermission(AppPermission.STATUS_VIEW, extractRobotId)] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        const user = req.molirisUser!;
        const robotId = extractRobotId(req)!;
        const robot = await monitoringService.getRobotStatus(user, robotId);
        return reply.status(200).send({ robot });
      } catch (err: any) {
        return handleError(err, reply);
      }
    }
  );

  // Richiesta di aggiornamento manuale dello stato (RF-MON-004, CA-MON-003)
  app.post(
    "/api/robots/:robotId/status/refresh",
    { preHandler: [authMiddleware.requirePermission(AppPermission.STATUS_REFRESH_MANUAL, extractRobotId)] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        const user = req.molirisUser!;
        const robotId = extractRobotId(req)!;
        const result = await monitoringService.refreshRobotStatus(user, robotId);
        return reply.status(200).send(result);
      } catch (err: any) {
        return handleError(err, reply);
      }
    }
  );
}
