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
      const rawPath = typeof query.path === "string" ? query.path.trim() : "";
      const subPath = rawPath === "/" || rawPath === "\\" || rawPath === "." ? "" : rawPath.replace(/^[/\\]+/, "");

      let robot = await robotRepository.findById(robotId);
      if (!robot) {
        robot = await robotRepository.findByServerDirectory(robotId);
      }
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
        const mappedEntries = items.map((it: any) => ({
          name: it.name,
          type: it.type === "directory" ? "directory" : "file",
          size: typeof it.size === "number" ? it.size : 0,
          mtime: it.modifiedAt instanceof Date ? it.modifiedAt.toISOString() : (it.modifiedAt || new Date().toISOString()),
          modifiedAt: it.modifiedAt instanceof Date ? it.modifiedAt.toISOString() : (it.modifiedAt || new Date().toISOString()),
        }));

        return reply.status(200).send({
          robotId: robot.id,
          currentPath: rawPath || "/",
          path: rawPath || "/",
          items,
          entries: mappedEntries,
          totalCount: items.length,
          isTruncated: false,
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
   * Download file dal filesystem server del robot (RF-SRVFS-004, RF-TRF-001)
   */
  app.get(
    "/api/robots/:robotId/fs/server/download",
    {
      preHandler: [
        authMiddleware.requirePermission(
          AppPermission.FS_SERVER_DOWNLOAD,
          (req) => (req.params as any).robotId
        ),
      ],
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { robotId } = req.params as { robotId: string };
      const query = (req.query as any) || {};
      const rawPath = typeof query.path === "string" ? query.path.trim() : "";
      const filePath = rawPath.replace(/^[/\\]+/, "");

      if (!filePath) {
        return reply.status(400).send({
          code: ErrorCode.MISSING_ROBOT_PARAMS,
          message: "Parametro 'path' obbligatorio mancante.",
          classification: "richiede_intervento_amministrativo",
        });
      }

      let robot = await robotRepository.findById(robotId);
      if (!robot) {
        robot = await robotRepository.findByServerDirectory(robotId);
      }
      if (!robot) {
        return reply.status(404).send({
          code: ErrorCode.MISSING_ROBOT_PARAMS,
          message: `Robot '${robotId}' non trovato.`,
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
        const stream = await serverFsService.openFileReadStream(context, robot, filePath);
        const fileName = path.basename(filePath);
        reply.header("content-disposition", `attachment; filename="${fileName}"`);
        reply.header("content-type", "application/octet-stream");
        return reply.send(stream);
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

      let robot = await robotRepository.findById(robotId);
      if (!robot) {
        robot = await robotRepository.findByServerDirectory(robotId);
      }
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

  /**
   * Creazione nuova cartella nella directory server del robot (§2, §4)
   */
  app.post(
    "/api/robots/:robotId/fs/server/mkdir",
    {
      preHandler: [
        authMiddleware.requirePermission(
          AppPermission.FS_SERVER_UPLOAD,
          (req) => (req.params as any).robotId
        ),
      ],
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { robotId } = req.params as { robotId: string };
      const body = (req.body as any) || {};
      const folderName = typeof body.folderName === "string" ? body.folderName : body.name;
      const parentPath = typeof body.path === "string" ? body.path : (body.parentPath || "");

      if (!folderName || !folderName.trim()) {
        return reply.status(400).send({
          code: ErrorCode.MISSING_ROBOT_PARAMS,
          message: "Nome della cartella obbligatorio.",
          classification: "recuperabile",
        });
      }

      let robot = await robotRepository.findById(robotId);
      if (!robot) {
        robot = await robotRepository.findByServerDirectory(robotId);
      }
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
        const result = await serverFsService.createRobotFolder(context, robot, parentPath, folderName);
        return reply.status(201).send({
          success: true,
          message: `Cartella '${result.name}' creata con successo.`,
          path: result.path,
          name: result.name,
        });
      } catch (err: any) {
        if (err instanceof MolirisAppError || err?.name === "MolirisAppError") {
          const status = err.code === ErrorCode.INSUFFICIENT_PERMISSIONS ? 403 : err.userMessage?.toLowerCase().includes("esiste già") ? 409 : 400;
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
   * =========================================================================
   * ARCHIVIO GENERALE DEL SERVER (§1, §3, §4)
   * =========================================================================
   */

  /**
   * Elenco file e cartelle nell'Archivio Generale del server
   */
  app.get(
    "/api/fs/general/list",
    {
      preHandler: [
        authMiddleware.requirePermission(AppPermission.FS_SERVER_NAVIGATE),
      ],
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const query = (req.query as any) || {};
      const rawPath = typeof query.path === "string" ? query.path.trim() : "";
      const subPath = rawPath === "/" || rawPath === "\\" || rawPath === "." ? "" : rawPath.replace(/^[/\\]+/, "");

      const context = sessionManager.createAuthorizedContext(
        req.molirisSession!,
        req.molirisUser!,
        undefined,
        roleMapping
      );

      try {
        const items = await serverFsService.listGeneralDirectory(context, subPath);
        const mappedEntries = items.map((it: any) => ({
          name: it.name,
          type: it.type === "directory" ? "directory" : "file",
          size: typeof it.size === "number" ? it.size : 0,
          mtime: it.modifiedAt instanceof Date ? it.modifiedAt.toISOString() : (it.modifiedAt || new Date().toISOString()),
          modifiedAt: it.modifiedAt instanceof Date ? it.modifiedAt.toISOString() : (it.modifiedAt || new Date().toISOString()),
        }));

        return reply.status(200).send({
          scope: "general",
          currentPath: rawPath || "/",
          path: rawPath || "/",
          items,
          entries: mappedEntries,
          totalCount: items.length,
          isTruncated: false,
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
   * Creazione nuova cartella nell'Archivio Generale del server (§3, §4)
   */
  app.post(
    "/api/fs/general/mkdir",
    {
      preHandler: [
        authMiddleware.requirePermission(AppPermission.FS_SERVER_UPLOAD),
      ],
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const body = (req.body as any) || {};
      const folderName = typeof body.folderName === "string" ? body.folderName : body.name;
      const parentPath = typeof body.path === "string" ? body.path : (body.parentPath || "");

      if (!folderName || !folderName.trim()) {
        return reply.status(400).send({
          code: ErrorCode.MISSING_ROBOT_PARAMS,
          message: "Nome della cartella obbligatorio.",
          classification: "recuperabile",
        });
      }

      const context = sessionManager.createAuthorizedContext(
        req.molirisSession!,
        req.molirisUser!,
        undefined,
        roleMapping
      );

      try {
        const result = await serverFsService.createGeneralFolder(context, parentPath, folderName);
        return reply.status(201).send({
          success: true,
          message: `Cartella '${result.name}' creata con successo nell'archivio generale.`,
          path: result.path,
          name: result.name,
        });
      } catch (err: any) {
        if (err instanceof MolirisAppError || err?.name === "MolirisAppError") {
          const status = err.code === ErrorCode.INSUFFICIENT_PERMISSIONS ? 403 : err.userMessage?.toLowerCase().includes("esiste già") ? 409 : 400;
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
   * Download file dall'Archivio Generale del server (§3)
   */
  app.get(
    "/api/fs/general/download",
    {
      preHandler: [
        authMiddleware.requirePermission(AppPermission.FS_SERVER_DOWNLOAD),
      ],
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const query = (req.query as any) || {};
      const rawPath = typeof query.path === "string" ? query.path.trim() : "";
      const filePath = rawPath.replace(/^[/\\]+/, "");

      if (!filePath) {
        return reply.status(400).send({
          code: ErrorCode.MISSING_ROBOT_PARAMS,
          message: "Parametro 'path' obbligatorio mancante.",
          classification: "richiede_intervento_amministrativo",
        });
      }

      const context = sessionManager.createAuthorizedContext(
        req.molirisSession!,
        req.molirisUser!,
        undefined,
        roleMapping
      );

      try {
        const stream = await serverFsService.openGeneralFileReadStream(context, filePath);
        const fileName = path.basename(filePath);
        reply.header("content-disposition", `attachment; filename="${fileName}"`);
        reply.header("content-type", "application/octet-stream");
        return reply.send(stream);
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
   * Upload file verso l'Archivio Generale del server (§3)
   */
  app.post(
    "/api/fs/general/upload",
    {
      preHandler: [
        authMiddleware.requirePermission(AppPermission.FS_SERVER_UPLOAD),
      ],
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const query = (req.query as any) || {};
      const context = sessionManager.createAuthorizedContext(
        req.molirisSession!,
        req.molirisUser!,
        undefined,
        roleMapping
      );

      let filename = (req.headers["x-filename"] as string) || query.filename;
      let targetSubPath = (req.headers["x-subpath"] as string) || query.path || "";
      const overwrite = req.headers["x-overwrite"] === "true" || query.overwrite === "true";

      try {
        if (req.isMultipart()) {
          const data = await req.file();
          if (!data) {
            return reply.status(400).send({
              code: ErrorCode.MISSING_ROBOT_PARAMS,
              message: "Nessun file caricato.",
              classification: "recuperabile",
            });
          }
          if (!filename) {
            filename = data.filename;
          }
          const filePath = targetSubPath ? `${targetSubPath.replace(/^[/\\]+/, "")}/${filename}` : filename;
          const writeStream = await serverFsService.openGeneralFileWriteStream(context, filePath, { overwrite });
          await new Promise((resolve, reject) => {
            data.file.pipe(writeStream);
            writeStream.on("finish", resolve);
            writeStream.on("error", reject);
          });
          return reply.status(200).send({
            success: true,
            message: `File '${filename}' caricato con successo nell'archivio generale.`,
            filename,
            path: filePath,
          });
        } else {
          if (!filename) {
            return reply.status(400).send({
              code: ErrorCode.MISSING_ROBOT_PARAMS,
              message: "Nome file mancante.",
              classification: "recuperabile",
            });
          }
          const filePath = targetSubPath ? `${targetSubPath.replace(/^[/\\]+/, "")}/${filename}` : filename;
          const writeStream = await serverFsService.openGeneralFileWriteStream(context, filePath, { overwrite });
          const stream = req.raw;
          await new Promise((resolve, reject) => {
            stream.pipe(writeStream);
            writeStream.on("finish", resolve);
            writeStream.on("error", reject);
          });
          return reply.status(200).send({
            success: true,
            message: `File '${filename}' caricato con successo nell'archivio generale.`,
            filename,
            path: filePath,
          });
        }
      } catch (err: any) {
        if (err instanceof MolirisAppError || err?.name === "MolirisAppError") {
          const status = err.code === ErrorCode.INSUFFICIENT_PERMISSIONS ? 403 : err.userMessage?.toLowerCase().includes("esiste già") ? 409 : 400;
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
   * Eliminazione file o cartella nell'Archivio Generale del server (§3)
   */
  app.delete(
    "/api/fs/general/file",
    {
      preHandler: [
        authMiddleware.requirePermission(AppPermission.FS_SERVER_DELETE),
      ],
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const query = (req.query as any) || {};
      const rawPath = typeof query.path === "string" ? query.path.trim() : "";
      const filePath = rawPath.replace(/^[/\\]+/, "");

      if (!filePath) {
        return reply.status(400).send({
          code: ErrorCode.SERVER_DIR_INACCESSIBLE,
          message: "Percorso dell'elemento da eliminare mancante.",
          classification: "recuperabile",
        });
      }

      const context = sessionManager.createAuthorizedContext(
        req.molirisSession!,
        req.molirisUser!,
        undefined,
        roleMapping
      );

      try {
        await serverFsService.deleteGeneralFile(context, filePath);
        const filename = path.basename(filePath);
        return reply.status(200).send({
          success: true,
          message: `'${filename}' eliminato con successo dall'archivio generale.`,
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
