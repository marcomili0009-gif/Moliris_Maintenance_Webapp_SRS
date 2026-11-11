// Requisiti soddisfatti: RF-FS-001, RF-FS-002, RF-FS-003, RF-FS-006, RF-FS-007,
// RF-AUTH-005, RNF-SEC-004, RNF-SEC-005, RNF-SEC-006, RNF-PERF-002, RNF-REL-005, SRS §1.2, §5.5, §9, CA-FS-001

import { type FastifyInstance, type FastifyRequest, type FastifyReply } from "fastify";
import { type RemoteFilesystemService } from "./remote-fs-service.ts";
import { type RobotRepository } from "../../storage/robot-repository.ts";
import { type SessionManager } from "../auth/session-manager.ts";
import { type AuthMiddleware } from "../auth/auth-middleware.ts";
import { AppPermission, type RolePermissionMapping, DEFAULT_ROLE_PERMISSIONS } from "../auth/permissions.ts";
import { MolirisAppError, ErrorCode, ERROR_CATALOG } from "../../errors/app-errors.ts";

export function registerRemoteFsRoutes(
  app: FastifyInstance,
  remoteFsService: RemoteFilesystemService,
  robotRepository: RobotRepository,
  sessionManager: SessionManager,
  authMiddleware: AuthMiddleware,
  roleMapping: RolePermissionMapping = DEFAULT_ROLE_PERMISSIONS
): void {
  /**
   * STEP 1 & 2 – Navigazione filesystem remoto del robot (RF-FS-001, RF-FS-002, RF-FS-003, CA-FS-001).
   * - Solo tramite backend via SFTP (RNF-SEC-006, vincolo 2.4).
   * - Verifica sessione e autorizzazione per robot (RF-AUTH-005, RNF-SEC-004).
   * - Il frontend invia solo robotId e percorso (nessun host o porta).
   */
  app.get(
    "/api/robots/:robotId/fs/remote/list",
    {
      preHandler: [
        authMiddleware.requirePermission(
          AppPermission.FS_REMOTE_NAVIGATE,
          (req) => (req.params as any).robotId
        ),
      ],
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { robotId } = req.params as { robotId: string };
      const query = (req.query as any) || {};
      const requestedPath = typeof query.path === "string" ? query.path : undefined;

      // 1. Caricamento robot da anagrafica
      const robot = await robotRepository.findById(robotId);
      if (!robot) {
        const errDef = ERROR_CATALOG[ErrorCode.MISSING_ROBOT_PARAMS];
        return reply.status(404).send({
          code: errDef.code,
          message: `Robot con identificativo '${robotId}' non trovato nell'anagrafica.`,
          classification: errDef.classification,
        });
      }

      // 2. Costruzione contesto autorizzato verificato (RF-SSH-006, RNF-SEC-007)
      const context = sessionManager.createAuthorizedContext(
        req.molirisSession!,
        req.molirisUser!,
        robot.id,
        roleMapping
      );

      // 3. Esecuzione elenco directory remota
      try {
        const listing = await remoteFsService.listDirectory(context, robot, requestedPath);
        return reply.status(200).send(listing);
      } catch (err: any) {
        if (err instanceof MolirisAppError) {
          let statusCode = 400;
          if (err.code === ErrorCode.INSUFFICIENT_PERMISSIONS) {
            statusCode = 403;
          } else if (err.code === ErrorCode.HOST_UNREACHABLE) {
            statusCode = 503;
          } else if (err.code === ErrorCode.TIMEOUT_ERROR) {
            statusCode = 504;
          } else if (err.userMessage.includes("non presente") || err.userMessage.includes("non trovato")) {
            statusCode = 404;
          }

          return reply.status(statusCode).send({
            code: err.code,
            message: err.userMessage,
            classification: err.classification,
          });
        }

        return reply.status(500).send({
          code: ErrorCode.REMOTE_FS_ERROR,
          message: ERROR_CATALOG[ErrorCode.REMOTE_FS_ERROR].userMessage,
          classification: "recuperabile",
        });
      }
    }
  );

  /**
   * Eliminazione controllata di un file sul filesystem remoto del robot (RF-FS-007, RNF-FS-003, RF-ROB-013)
   */
  app.delete(
    "/api/robots/:robotId/fs/remote/file",
    {
      preHandler: [
        authMiddleware.requirePermission(
          AppPermission.FS_REMOTE_DELETE,
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
          code: ErrorCode.REMOTE_FS_ERROR,
          message: "Percorso del file remoto da eliminare mancante o non specificato.",
          classification: "recuperabile",
        });
      }

      const robot = await robotRepository.findById(robotId);
      if (!robot) {
        return reply.status(404).send({
          code: ErrorCode.MISSING_ROBOT_PARAMS,
          message: `Robot con identificativo '${robotId}' non trovato nell'anagrafica.`,
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
        await remoteFsService.deleteRemoteFile(context, robot, filePath);
        const filename = filePath.split("/").filter(Boolean).pop() || filePath;
        return reply.status(200).send({
          success: true,
          message: `File '${filename}' eliminato con successo dal robot.`,
        });
      } catch (err: any) {
        if (err instanceof MolirisAppError) {
          let statusCode = 400;
          if (err.code === ErrorCode.INSUFFICIENT_PERMISSIONS) {
            statusCode = 403;
          } else if (err.code === ErrorCode.HOST_UNREACHABLE) {
            statusCode = 503;
          } else if (err.code === ErrorCode.TIMEOUT_ERROR) {
            statusCode = 504;
          } else if (err.userMessage.includes("non presente") || err.userMessage.includes("non trovato")) {
            statusCode = 404;
          }

          return reply.status(statusCode).send({
            code: err.code,
            message: err.userMessage,
            classification: err.classification,
          });
        }

        return reply.status(500).send({
          code: ErrorCode.REMOTE_FS_ERROR,
          message: "Errore durante l'eliminazione del file dal robot.",
          classification: "recuperabile",
        });
      }
    }
  );
}
