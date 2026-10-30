// Requisiti soddisfatti: RF-SRVFS-002, RF-SRVFS-005, RF-AUTH-005, RNF-SEC-004, RNF-SEC-005, RNF-FS-003, RF-ROB-013, SRS §5.2, §5.6

import path from "path";
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
        if (err instanceof MolirisAppError || err?.name === "MolirisAppError") {
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

  /**
   * Eliminazione controllata di un file sul filesystem server del robot (RNF-FS-003, RF-ROB-013)
   */
  app.delete(
    "/api/robots/:robotId/fs/server/file",
    {
      preHandler: [
        authMiddleware.requirePermission(
          AppPermission.FS_SERVER_DELETE,
          (req) => (req.params as any).robotId
        ),
      ],
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { robotId } = req.params as { robotId: string };
      const query = (req.query as any) || {};
      const filePath = typeof query.path === "string" ? query.path : "";

      if (!filePath || filePath.trim() === "") {
        return reply.status(400).send({
          code: ErrorCode.SERVER_DIR_INACCESSIBLE,
          message: "Percorso del file da eliminare mancante o non specificato.",
          classification: "recuperabile",
        });
      }

      const robot = await robotRepository.findById(robotId);
      if (!robot) {
        return reply.status(404).send({
          code: ErrorCode.SERVER_DIR_INACCESSIBLE,
          message: "Robot specificato non trovato nell'anagrafica.",
          classification: "richiede_intervento_amministrativo",
        });
      }

      const context = sessionManager.createAuthorizedContext(
        req.molirisSession!,
        req.molirisUser!,
        robot.id,
        roleMapping
      );

      try {
        await serverFsService.deleteFile(context, robot, filePath);
        const filename = path.basename(filePath);
        return reply.status(200).send({
          success: true,
          message: `File '${filename}' eliminato con successo dal server.`,
        });
      } catch (err: any) {
        if (err instanceof MolirisAppError || err?.name === "MolirisAppError") {
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
