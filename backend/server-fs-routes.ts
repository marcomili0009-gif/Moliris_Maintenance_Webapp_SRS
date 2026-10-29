// Requisiti soddisfatti: RF-SRVFS-002, RF-SRVFS-005, RF-AUTH-005, RNF-SEC-004, RNF-SEC-005, SRS §5.2, §5.6

import { type FastifyInstance, type FastifyRequest, type FastifyReply } from "fastify";
import { type ServerFilesystemService } from "../storage/server-fs.ts";
import { type RobotRepository } from "../storage/robot-repository.ts";
import { type AuthMiddleware } from "./auth/auth-middleware.ts";
import { type SessionManager } from "./auth/session-manager.ts";
import { AppPermission, type RolePermissionMapping, DEFAULT_ROLE_PERMISSIONS } from "./auth/permissions.ts";
import { MolirisAppError, ErrorCode, ERROR_CATALOG } from "../errors/app-errors.ts";

export function registerServerFsRoutes(
  app: FastifyInstance,
  serverFsService: ServerFilesystemService,
  robotRepository: RobotRepository,
  sessionManager: SessionManager,
  authMiddleware: AuthMiddleware,
  roleMapping: RolePermissionMapping = DEFAULT_ROLE_PERMISSIONS
): void {
  /**
   * Navigazione file sul filesystem server del robot (RF-SRVFS-002, RF-SRVFS-005)
   */
  app.get(
    "/api/robots/:robotId/fs/server/list",
    {
      preHandler: [
        authMiddleware.requirePermission(
          AppPermission.FS_SERVER_NAVIGATE,
          (req) => (req.params as any).robotId
        ),
      ],
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { robotId } = req.params as { robotId: string };
      const query = (req.query as any) || {};
      const subPath = typeof query.path === "string" ? query.path : "";

      const robot = await robotRepository.findById(robotId);
      if (!robot) {
        const notFoundDef = ERROR_CATALOG[ErrorCode.SERVER_DIR_INACCESSIBLE];
        return reply.status(404).send({
          code: notFoundDef.code,
          message: "Robot specificato non trovato nell'anagrafica.",
          classification: notFoundDef.classification,
        });
      }

      // Costruzione del contesto autorizzato verificato (RF-SSH-006, RNF-SEC-007)
      const context = sessionManager.createAuthorizedContext(
        req.molirisSession!,
        req.molirisUser!,
        robot.id,
        roleMapping
      );

      try {
        const items = await serverFsService.listDirectory(context, robot, subPath);
        return reply.status(200).send({
          robotId: robot.id,
          currentPath: subPath,
          items,
        });
      } catch (err: any) {
        if (err instanceof MolirisAppError) {
          const status = err.code === ErrorCode.INSUFFICIENT_PERMISSIONS ? 403 : 400;
          return reply.status(status).send({
            code: err.code,
            message: err.userMessage,
            classification: err.classification,
          });
        }
        return reply.status(500).send({
          code: ErrorCode.SERVER_DIR_INACCESSIBLE,
          message: ERROR_CATALOG[ErrorCode.SERVER_DIR_INACCESSIBLE].userMessage,
          classification: "richiede_intervento_amministrativo",
        });
      }
    }
  );
}
