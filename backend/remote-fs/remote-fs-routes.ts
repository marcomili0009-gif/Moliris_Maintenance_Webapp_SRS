// Requisiti soddisfatti: RF-FS-001, RF-FS-002, RF-FS-003, RF-FS-006, RF-FS-007,
// RF-AUTH-005, RNF-SEC-004, RNF-SEC-005, RNF-SEC-006, RNF-PERF-002, RNF-REL-005, SRS §1.2, §5.5, §9, CA-FS-001

import { type FastifyInstance, type FastifyRequest, type FastifyReply } from "fastify";
import { type RemoteFilesystemService } from "./remote-fs-service.ts";
import { type RobotRepository } from "../../storage/robot-repository.ts";
import { type SessionManager } from "../auth/session-manager.ts";
import { type AuthMiddleware } from "../auth/auth-middleware.ts";
import { AppPermission, type RolePermissionMapping, DEFAULT_ROLE_PERMISSIONS } from "../auth/permissions.ts";
import { MolirisAppError, ErrorCode, ERROR_CATALOG } from "../../errors/app-errors.ts";
import { authorizeOperatorPath } from "../auth/path-authorization.ts";

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
        await authorizeOperatorPath(context, "remote", robot.id, requestedPath || "/", undefined, { isListingRootAllowed: true });
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
   * Navigazione delle sole directory remote per modale «Gestione File» (Prompt Correttivo #2)
   */
  app.get(
    "/api/robots/:robotId/fs/remote/directories",
    {
      schema: {
        querystring: {
          type: "object",
          properties: {
            path: { type: "string" },
          },
        },
      },
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

      const robot = await robotRepository.findById(robotId);
      if (!robot) {
        const errDef = ERROR_CATALOG[ErrorCode.MISSING_ROBOT_PARAMS];
        return reply.status(404).send({
          code: errDef.code,
          message: `Robot con identificativo '${robotId}' non trovato nell'anagrafica.`,
          classification: errDef.classification,
        });
      }

      const context = sessionManager.createAuthorizedContext(
        req.molirisSession!,
        req.molirisUser!,
        robot.id,
        roleMapping
      );

      try {
        await authorizeOperatorPath(context, "remote", robot.id, requestedPath || "/", undefined, { isListingRootAllowed: true });
        const listing = await remoteFsService.listDirectories(context, robot, requestedPath);
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
   * Verifica di un percorso remoto per modale «Gestione File» (Prompt Correttivo #2)
   */
  // Validazione reale di esistenza, tipo directory e scrittura via SFTP; il percorso storico
  // (/fs/remote/verify-path) e l'alias /sftp/validate-path condividono lo stesso handler.
  for (const url of [
    "/api/robots/:robotId/fs/remote/verify-path",
    "/api/robots/:robotId/sftp/validate-path",
  ]) {
    app.post(
      url,
      {
        schema: {
          body: {
            type: "object",
            required: ["path"],
            properties: {
              path: { type: "string" },
            },
          },
        },
        preHandler: [
          authMiddleware.requirePermission(
            AppPermission.FS_REMOTE_NAVIGATE,
            (req) => (req.params as any).robotId
          ),
        ],
      },
      async (req: FastifyRequest, reply: FastifyReply) => {
        const { robotId } = req.params as { robotId: string };
        const body = (req.body as any) || {};
        const candidatePath = typeof body.path === "string" ? body.path : "";

        const robot = await robotRepository.findById(robotId);
        if (!robot) {
          const errDef = ERROR_CATALOG[ErrorCode.MISSING_ROBOT_PARAMS];
          return reply.status(404).send({
            code: errDef.code,
            message: `Robot con identificativo '${robotId}' non trovato nell'anagrafica.`,
            classification: errDef.classification,
          });
        }

        const context = sessionManager.createAuthorizedContext(
          req.molirisSession!,
          req.molirisUser!,
          robot.id,
          roleMapping
        );

        try {
          const result = await remoteFsService.verifyPath(context, robot, candidatePath);
          return reply.status(200).send(result);
        } catch (err: any) {
          if (err instanceof MolirisAppError) {
            const statusCode = err.code === ErrorCode.INSUFFICIENT_PERMISSIONS ? 403 : 400;
            return reply.status(statusCode).send({
              valid: false,
              exists: false,
              isDirectory: false,
              isWritable: false,
              resolvedPath: candidatePath,
              error: err.userMessage,
            });
          }
          return reply.status(500).send({
            valid: false,
            exists: false,
            isDirectory: false,
            isWritable: false,
            resolvedPath: candidatePath,
            error: "Errore interno durante la verifica del percorso remoto.",
          });
        }
      }
    );
  }

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
        await authorizeOperatorPath(context, "remote", robot.id, filePath);
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

  const handleRemoteFolderInspection = async (
    req: FastifyRequest,
    reply: FastifyReply
  ): Promise<FastifyReply> => {
    const { robotId } = req.params as { robotId: string };
    const query = (req.query as any) || {};
    const folderPath = typeof query.path === "string" ? query.path.trim() : "";
    if (!folderPath) {
      return reply.status(400).send({
        code: ErrorCode.REMOTE_FS_ERROR,
        message: "Percorso della cartella remota da ispezionare mancante.",
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
      await authorizeOperatorPath(context, "remote", robot.id, folderPath);
      const inspection = await remoteFsService.getRemoteFolderDeletionInfo(context, robot, folderPath);
      return reply.status(200).send(inspection);
    } catch (err: any) {
      if (err instanceof MolirisAppError) {
        const statusCode =
          err.code === ErrorCode.INSUFFICIENT_PERMISSIONS
            ? 403
            : err.userMessage.includes("non trovato") || err.userMessage.includes("non presente")
              ? 404
              : err.code === ErrorCode.HOST_UNREACHABLE
                ? 503
                : 400;
        return reply.status(statusCode).send({
          code: err.code,
          message: err.userMessage,
          classification: err.classification,
        });
      }
      return reply.status(500).send({
        code: ErrorCode.REMOTE_FS_ERROR,
        message: "Errore durante l'ispezione della cartella remota.",
        classification: "recuperabile",
      });
    }
  };

  app.get(
    "/api/robots/:robotId/fs/remote/folder",
    {
      preHandler: [
        authMiddleware.requirePermission(
          AppPermission.FS_REMOTE_DELETE,
          (req) => (req.params as any).robotId
        ),
      ],
    },
    handleRemoteFolderInspection
  );

  app.get(
    "/api/robots/:robotId/fs/remote/folder/inspect",
    {
      preHandler: [
        authMiddleware.requirePermission(
          AppPermission.FS_REMOTE_DELETE,
          (req) => (req.params as any).robotId
        ),
      ],
    },
    handleRemoteFolderInspection
  );

  app.delete(
    "/api/robots/:robotId/fs/remote/folder",
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
      const folderPath = typeof query.path === "string" ? query.path.trim() : "";
      const recursive = query.recursive === true || query.recursive === "true";
      const hasPreflightCounts =
        query.expectedFileCount !== undefined &&
        query.expectedFileCount !== "" &&
        query.expectedDirectoryCount !== undefined &&
        query.expectedDirectoryCount !== "";
      const expectedFileCount = hasPreflightCounts ? Number(query.expectedFileCount) : NaN;
      const expectedDirectoryCount = hasPreflightCounts ? Number(query.expectedDirectoryCount) : NaN;

      if (!folderPath) {
        return reply.status(400).send({
          code: ErrorCode.REMOTE_FS_ERROR,
          message: "Percorso della cartella remota da eliminare mancante.",
          classification: "recuperabile",
        });
      }
      if (
        !Number.isInteger(expectedFileCount) ||
        !Number.isInteger(expectedDirectoryCount) ||
        expectedFileCount < 0 ||
        expectedDirectoryCount < 0
      ) {
        return reply.status(400).send({
          code: ErrorCode.REMOTE_FS_ERROR,
          message: "Eliminazione non confermata: recapito del preflight mancante.",
          classification: "recuperabile",
        });
      }
      const requiresRecursive = expectedFileCount > 0 || expectedDirectoryCount > 0;
      if (requiresRecursive && !recursive) {
        return reply.status(400).send({
          code: ErrorCode.REMOTE_FS_ERROR,
          message: "Eliminazione ricorsiva non confermata: la cartella non è vuota.",
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
        await authorizeOperatorPath(context, "remote", robot.id, folderPath);
        await remoteFsService.deleteRemoteFolder(context, robot, folderPath, {
          recursive,
          expectedFileCount,
          expectedDirectoryCount,
        });
        return reply.status(200).send({
          success: true,
          message: `Cartella '${folderPath.split("/").filter(Boolean).pop() || folderPath}' eliminata con successo dal robot.`,
        });
      } catch (err: any) {
        if (err instanceof MolirisAppError) {
          let statusCode = 400;
          if (err.code === ErrorCode.INSUFFICIENT_PERMISSIONS) statusCode = 403;
          else if (err.userMessage.includes("cambiato") || err.userMessage.includes("PREFLIGHT_STALE")) statusCode = 409;
          else if (err.userMessage.includes("non trovato") || err.userMessage.includes("non presente")) statusCode = 404;
          else if (err.code === ErrorCode.HOST_UNREACHABLE) statusCode = 503;
          else if (err.code === ErrorCode.TIMEOUT_ERROR) statusCode = 504;
          return reply.status(statusCode).send({
            code: err.code,
            message: err.userMessage,
            classification: err.classification,
          });
        }
        return reply.status(500).send({
          code: ErrorCode.REMOTE_FS_ERROR,
          message: "Errore durante l'eliminazione della cartella remota.",
          classification: "recuperabile",
        });
      }
    }
  );

  /**
   * Creazione controllata di una nuova directory sul filesystem remoto SFTP del robot (ISS-023)
   */
  app.post(
    "/api/robots/:robotId/fs/remote/mkdir",
    {
      preHandler: [
        authMiddleware.requirePermission(
          AppPermission.FS_REMOTE_UPLOAD,
          (req) => (req.params as any).robotId
        ),
      ],
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { robotId } = req.params as { robotId: string };
      const body = (req.body as any) || {};
      const folderName = typeof body.folderName === "string" ? body.folderName : body.name;
      const parentPath = typeof body.path === "string" ? body.path : (body.parentPath || "");

      if (!folderName || !String(folderName).trim()) {
        return reply.status(400).send({
          code: ErrorCode.MISSING_ROBOT_PARAMS,
          message: "Nome della cartella obbligatorio.",
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
        const candidatePath = parentPath
          ? `${parentPath.replace(/\/+$/, "")}/${String(folderName).trim()}`
          : String(folderName).trim();
        await authorizeOperatorPath(context, "remote", robot.id, candidatePath);
        const result = await remoteFsService.createRemoteDirectory(context, robot, parentPath, String(folderName));
        return reply.status(201).send({
          success: true,
          message: `Cartella '${result.name}' creata con successo sul robot.`,
          path: result.path,
          name: result.name,
        });
      } catch (err: any) {
        if (err instanceof MolirisAppError) {
          let statusCode = 400;
          if (err.code === ErrorCode.INSUFFICIENT_PERMISSIONS) statusCode = 403;
          else if (err.userMessage.toLowerCase().includes("esiste già")) statusCode = 409;
          else if (err.code === ErrorCode.HOST_UNREACHABLE) statusCode = 503;
          else if (err.code === ErrorCode.TIMEOUT_ERROR) statusCode = 504;
          return reply.status(statusCode).send({
            code: err.code,
            message: err.userMessage,
            classification: err.classification,
          });
        }
        return reply.status(500).send({
          code: ErrorCode.REMOTE_FS_ERROR,
          message: "Errore durante la creazione della cartella remota.",
          classification: "recuperabile",
        });
      }
    }
  );
}
