// Requisiti soddisfatti: RF-TRF-001, RF-TRF-002, RF-TRF-003, RF-TRF-004, RF-TRF-005,
// RF-TRF-006, RF-TRF-007, RF-TRF-008, RF-TRF-009, RF-TRF-010, RF-TRF-011, RF-TRF-012,
// RF-TRF-013, RF-TRF-014, RNF-SEC-002, RNF-SEC-004, RNF-SEC-005, RNF-SEC-007, RNF-SEC-008,
// RNF-SEC-009, RNF-PERF-001, RNF-PERF-002, RNF-PERF-003, RNF-REL-004, RNF-REL-005,
// SRS §1.2, §2.4, §5.5, §6.5, §6.6, §6.7, §9, §10.3, CA-FS-002, CA-FS-003, CA-FS-004

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { type FastifyInstance, type FastifyRequest, type FastifyReply } from "fastify";
import { type Readable } from "stream";
import { type TransferService } from "./transfer-service.ts";
import { type RobotRepository } from "../../storage/robot-repository.ts";
import { type SessionManager } from "../auth/session-manager.ts";
import { type AuthMiddleware } from "../auth/auth-middleware.ts";
import { AppPermission, type RolePermissionMapping, DEFAULT_ROLE_PERMISSIONS } from "../auth/permissions.ts";
import { MolirisAppError, ErrorCode, ERROR_CATALOG } from "../../errors/app-errors.ts";
import { type StartServerRobotTransferRequest } from "./transfer-models.ts";
import { type BulkPreCheckRequest, type BulkTarget } from "./bulk-transfer-models.ts";

export function registerTransferRoutes(
  app: FastifyInstance,
  transferService: TransferService,
  robotRepository: RobotRepository,
  sessionManager: SessionManager,
  authMiddleware: AuthMiddleware,
  roleMapping: RolePermissionMapping = DEFAULT_ROLE_PERMISSIONS
): void {
  // Supporto content-type per streaming binario raw senza buffering in memoria (RF-TRF-004, CA-TRF-001)
  try {
    app.addContentTypeParser(
      ["application/octet-stream", "application/x-binary"],
      (req, payload, done) => {
        done(null, payload);
      }
    );
  } catch {}

  // =========================================================================
  // 1. TRASFERIMENTO SERVER ↔ ROBOT (RF-TRF-002, §6.6, CA-FS-003)
  // =========================================================================
  app.post(
    "/api/robots/:robotId/transfers/server-robot",
    {
      preHandler: [
        authMiddleware.requirePermission(
          AppPermission.TRANSFER_SERVER_ROBOT,
          (req) => (req.params as any).robotId
        ),
      ],
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { robotId } = req.params as { robotId: string };
      const body = req.body as StartServerRobotTransferRequest;

      const robot = await robotRepository.findById(robotId);
      if (!robot) {
        return sendErrorReply(reply, 404, ErrorCode.MISSING_ROBOT_PARAMS, `Robot '${robotId}' non trovato.`);
      }

      const context = sessionManager.createAuthorizedContext(
        req.molirisSession!,
        req.molirisUser!,
        robot.id,
        roleMapping
      );

      try {
        const transferDto = await transferService.executeServerRobotTransfer(context, robot, body);
        return reply.status(200).send(transferDto);
      } catch (err: any) {
        return handleRouteError(reply, err);
      }
    }
  );

  // Alias per trasferimento Robot → Server (RF-TRF-002, §6.6)
  app.post(
    "/api/robots/:robotId/transfers/robot-server",
    {
      preHandler: [
        authMiddleware.requirePermission(
          AppPermission.TRANSFER_SERVER_ROBOT,
          (req) => (req.params as any).robotId
        ),
      ],
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { robotId } = req.params as { robotId: string };
      const body = (req.body as any) || {};

      const robot = await robotRepository.findById(robotId);
      if (!robot) {
        return sendErrorReply(reply, 404, ErrorCode.MISSING_ROBOT_PARAMS, `Robot '${robotId}' non trovato.`);
      }

      const context = sessionManager.createAuthorizedContext(
        req.molirisSession!,
        req.molirisUser!,
        robot.id,
        roleMapping
      );

      const reqBody: StartServerRobotTransferRequest = {
        direction: "ROBOT_TO_SERVER",
        serverRelativePath: body.serverRelativePath || body.targetPath || "",
        remotePath: body.remotePath || body.sourcePath || "",
        overwrite: body.overwrite,
        confirmed: body.confirmed,
        expectedChecksum: body.expectedChecksum,
      };

      try {
        const transferDto = await transferService.executeServerRobotTransfer(context, robot, reqBody);
        return reply.status(200).send(transferDto);
      } catch (err: any) {
        return handleRouteError(reply, err);
      }
    }
  );

  // Alias retrocompatibili per chiamate dirette dal pannello filesystem (RF-TRF-002)
  app.post(
    "/api/robots/:robotId/fs/transfer-to-remote",
    {
      preHandler: [
        authMiddleware.requirePermission(
          AppPermission.TRANSFER_SERVER_ROBOT,
          (req) => (req.params as any).robotId
        ),
      ],
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { robotId } = req.params as { robotId: string };
      const body = (req.body as any) || {};

      const robot = await robotRepository.findById(robotId);
      if (!robot) {
        return sendErrorReply(reply, 404, ErrorCode.MISSING_ROBOT_PARAMS, `Robot '${robotId}' non trovato.`);
      }

      const context = sessionManager.createAuthorizedContext(
        req.molirisSession!,
        req.molirisUser!,
        robot.id,
        roleMapping
      );

      const reqBody: StartServerRobotTransferRequest = {
        direction: "SERVER_TO_ROBOT",
        serverRelativePath: body.serverRelativePath || body.sourcePath || "",
        remotePath: body.remotePath || body.targetPath || "",
        overwrite: body.overwrite,
        confirmed: body.confirmed,
        expectedChecksum: body.expectedChecksum,
      };

      try {
        const transferDto = await transferService.executeServerRobotTransfer(context, robot, reqBody);
        return reply.status(200).send(transferDto);
      } catch (err: any) {
        return handleRouteError(reply, err);
      }
    }
  );

  app.post(
    "/api/robots/:robotId/fs/transfer-to-server",
    {
      preHandler: [
        authMiddleware.requirePermission(
          AppPermission.TRANSFER_SERVER_ROBOT,
          (req) => (req.params as any).robotId
        ),
      ],
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { robotId } = req.params as { robotId: string };
      const body = (req.body as any) || {};

      const robot = await robotRepository.findById(robotId);
      if (!robot) {
        return sendErrorReply(reply, 404, ErrorCode.MISSING_ROBOT_PARAMS, `Robot '${robotId}' non trovato.`);
      }

      const context = sessionManager.createAuthorizedContext(
        req.molirisSession!,
        req.molirisUser!,
        robot.id,
        roleMapping
      );

      const reqBody: StartServerRobotTransferRequest = {
        direction: "ROBOT_TO_SERVER",
        serverRelativePath: body.serverRelativePath || body.targetPath || "",
        remotePath: body.remotePath || body.sourcePath || "",
        overwrite: body.overwrite,
        confirmed: body.confirmed,
        expectedChecksum: body.expectedChecksum,
      };

      try {
        const transferDto = await transferService.executeServerRobotTransfer(context, robot, reqBody);
        return reply.status(200).send(transferDto);
      } catch (err: any) {
        return handleRouteError(reply, err);
      }
    }
  );

  // =========================================================================
  // 2. UPLOAD CLIENT → SERVER (RF-TRF-001, §6.5, CA-FS-002)
  // =========================================================================
  app.post(
    "/api/robots/:robotId/transfers/client-server/upload",
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
      const query = (req.query as any) || {};

      const robot = await robotRepository.findById(robotId);
      if (!robot) {
        return sendErrorReply(reply, 404, ErrorCode.MISSING_ROBOT_PARAMS, `Robot '${robotId}' non trovato.`);
      }

      const context = sessionManager.createAuthorizedContext(
        req.molirisSession!,
        req.molirisUser!,
        robot.id,
        roleMapping
      );

      const filename = (req.headers["x-filename"] as string) || query.filename || "uploaded_file";
      const subPath = (req.headers["x-subpath"] as string) || query.subPath;
      const overwrite = req.headers["x-overwrite"] === "true" || query.overwrite === "true";
      const expectedChecksum = (req.headers["x-expected-checksum"] as string) || query.expectedChecksum;

      const contentLengthStr = req.headers["content-length"];
      const totalBytes = contentLengthStr ? parseInt(contentLengthStr, 10) : null;

      const incomingStream: Readable =
        req.body && typeof (req.body as any).pipe === "function"
          ? (req.body as Readable)
          : req.raw;

      try {
        const transferDto = await transferService.uploadClientToServer(
          context,
          robot,
          subPath,
          filename,
          incomingStream,
          { overwrite, expectedChecksum },
          totalBytes
        );
        return reply.status(200).send(transferDto);
      } catch (err: any) {
        return handleRouteError(reply, err);
      }
    }
  );

  // =========================================================================
  // 3. DOWNLOAD SERVER → CLIENT (RF-TRF-001, §6.5, CA-FS-002)
  // =========================================================================
  app.get(
    "/api/robots/:robotId/transfers/client-server/download",
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
      const relativePath = query.path;

      if (!relativePath || typeof relativePath !== "string") {
        return sendErrorReply(reply, 400, ErrorCode.MISSING_ROBOT_PARAMS, "Parametro 'path' obbligatorio mancante.");
      }

      const robot = await robotRepository.findById(robotId);
      if (!robot) {
        return sendErrorReply(reply, 404, ErrorCode.MISSING_ROBOT_PARAMS, `Robot '${robotId}' non trovato.`);
      }

      const context = sessionManager.createAuthorizedContext(
        req.molirisSession!,
        req.molirisUser!,
        robot.id,
        roleMapping
      );

      try {
        const { stream, filename, totalBytes, transferDto } =
          await transferService.openDownloadServerToClient(context, robot, relativePath);

        reply.header("Content-Type", "application/octet-stream");
        reply.header("Content-Disposition", `attachment; filename="${encodeURIComponent(filename)}"`);
        reply.header("Content-Length", totalBytes);
        reply.header("X-Transfer-Id", transferDto.transferId);

        return reply.send(stream);
      } catch (err: any) {
        return handleRouteError(reply, err);
      }
    }
  );

  // =========================================================================
  // 4. UPLOAD CLIENT → ROBOT (RF-TRF-003, §6.7, CA-FS-004)
  // =========================================================================
  app.post(
    "/api/robots/:robotId/transfers/client-robot/upload",
    {
      preHandler: [
        authMiddleware.requirePermission(
          AppPermission.TRANSFER_CLIENT_ROBOT,
          (req) => (req.params as any).robotId
        ),
      ],
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { robotId } = req.params as { robotId: string };
      const query = (req.query as any) || {};

      const robot = await robotRepository.findById(robotId);
      if (!robot) {
        return sendErrorReply(reply, 404, ErrorCode.MISSING_ROBOT_PARAMS, `Robot '${robotId}' non trovato.`);
      }

      const context = sessionManager.createAuthorizedContext(
        req.molirisSession!,
        req.molirisUser!,
        robot.id,
        roleMapping
      );

      const filename = (req.headers["x-filename"] as string) || query.filename || "remote_file";
      const remoteDirectory = (req.headers["x-remote-dir"] as string) || query.remoteDirectory || "";
      const overwrite = req.headers["x-overwrite"] === "true" || query.overwrite === "true";
      const expectedChecksum = (req.headers["x-expected-checksum"] as string) || query.expectedChecksum;

      const contentLengthStr = req.headers["content-length"];
      const totalBytes = contentLengthStr ? parseInt(contentLengthStr, 10) : null;

      const incomingStream: Readable =
        req.body && typeof (req.body as any).pipe === "function"
          ? (req.body as Readable)
          : req.raw;

      try {
        const transferDto = await transferService.uploadClientToRobot(
          context,
          robot,
          remoteDirectory,
          filename,
          incomingStream,
          { overwrite, expectedChecksum },
          totalBytes
        );
        return reply.status(200).send(transferDto);
      } catch (err: any) {
        return handleRouteError(reply, err);
      }
    }
  );

  // =========================================================================
  // 5. DOWNLOAD ROBOT → CLIENT (RF-TRF-003, §6.7, CA-FS-004)
  // =========================================================================
  app.get(
    "/api/robots/:robotId/transfers/client-robot/download",
    {
      preHandler: [
        authMiddleware.requirePermission(
          AppPermission.TRANSFER_CLIENT_ROBOT,
          (req) => (req.params as any).robotId
        ),
      ],
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { robotId } = req.params as { robotId: string };
      const query = (req.query as any) || {};
      const remoteFilePath = query.path;

      if (!remoteFilePath || typeof remoteFilePath !== "string") {
        return sendErrorReply(reply, 400, ErrorCode.MISSING_ROBOT_PARAMS, "Parametro 'path' obbligatorio mancante.");
      }

      const robot = await robotRepository.findById(robotId);
      if (!robot) {
        return sendErrorReply(reply, 404, ErrorCode.MISSING_ROBOT_PARAMS, `Robot '${robotId}' non trovato.`);
      }

      const context = sessionManager.createAuthorizedContext(
        req.molirisSession!,
        req.molirisUser!,
        robot.id,
        roleMapping
      );

      try {
        const { stream, filename, totalBytes, transferDto } =
          await transferService.openDownloadRobotToClient(context, robot, remoteFilePath);

        reply.header("Content-Type", "application/octet-stream");
        reply.header("Content-Disposition", `attachment; filename="${encodeURIComponent(filename)}"`);
        if (totalBytes !== null) {
          reply.header("Content-Length", totalBytes);
        }
        reply.header("X-Transfer-Id", transferDto.transferId);

        return reply.send(stream);
      } catch (err: any) {
        return handleRouteError(reply, err);
      }
    }
  );

  // =========================================================================
  // 6. ELENCO E STATO TRASFERIMENTI (RF-TRF-006, CA-TRF-002, RNF-SEC-007)
  // =========================================================================
  app.get(
    "/api/robots/:robotId/transfers",
    {
      preHandler: [
  authMiddleware.requirePermission(
    AppPermission.FLEET_VIEW,
    (req) => (req.params as any).robotId
  ),
],
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { robotId } = req.params as { robotId: string };
      const context = sessionManager.createAuthorizedContext(
        req.molirisSession!,
        req.molirisUser!,
        robotId,
        roleMapping
      );

      const list = transferService.listTransfers(context, robotId);
      return reply.status(200).send(list);
    }
  );

  app.get(
    "/api/transfers/:transferId",
    {
      preHandler: [(req, reply) => authMiddleware.authenticate(req, reply)],
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { transferId } = req.params as { transferId: string };
      const context = sessionManager.createAuthorizedContext(
        req.molirisSession!,
        req.molirisUser!,
        undefined,
        roleMapping
      );

      try {
        const dto = transferService.getTransfer(transferId, context);
        return reply.status(200).send(dto);
      } catch (err: any) {
        return handleRouteError(reply, err);
      }
    }
  );

  // =========================================================================
  // 7. ANNULLAMENTO TRASFERIMENTO (RF-TRF-013)
  // =========================================================================
  app.post(
    "/api/transfers/:transferId/cancel",
    {
      preHandler: [(req, reply) => authMiddleware.authenticate(req, reply)],
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { transferId } = req.params as { transferId: string };
      try {
        const dto = await transferService.cancelTransfer(transferId, req.molirisUser!.id);
        return reply.status(200).send(dto);
      } catch (err: any) {
        return handleRouteError(reply, err);
      }
    }
  );

  // =========================================================================
  // 8. BONIFICA FILE TEMPORANEI SUL ROBOT E SERVER (CA-TRF-005, RF-TRF-009)
  // =========================================================================
  app.post(
    "/api/robots/:robotId/fs/cleanup-temp",
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
      const robot = await robotRepository.findById(robotId);
      if (!robot) {
        return sendErrorReply(reply, 404, ErrorCode.MISSING_ROBOT_PARAMS, `Robot '${robotId}' non trovato.`);
      }

      try {
        const result = await transferService.purgeTempFilesForRobot(robot);
        return reply.status(200).send({
          success: true,
          robotId: robot.id,
          purgedCount: result.purgedCount,
          freedBytes: result.freedBytes,
          purgedFiles: result.purgedFiles,
          message: `Bonifica completata: eliminati ${result.purgedCount} file temporanei orfani.`,
        });
      } catch (err: any) {
        return handleRouteError(reply, err);
      }
    }
  );

  // =========================================================================
  // 9. BONIFICA GLOBALE FILE TEMPORANEI DAPPERTUTTO (AMMINISTRATORE)
  // =========================================================================
  app.post(
    "/api/fs/cleanup-temp-all",
    {
      preHandler: [
        authMiddleware.requirePermission(AppPermission.FLEET_VIEW),
      ],
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (!req.molirisUser?.roles.includes("amministratore")) {
        return sendErrorReply(
          reply,
          403,
          ErrorCode.INSUFFICIENT_PERMISSIONS,
          "Operazione consentita solo agli utenti con ruolo 'amministratore'."
        );
      }
      try {
        const result = await transferService.purgeAllTempFiles();
        return reply.status(200).send({
          success: true,
          serverPurged: result.serverPurged,
          serverFreedBytes: result.serverFreedBytes,
          robotsPurged: result.robotsPurged,
          robotsFreedBytes: result.robotsFreedBytes,
          totalPurged: result.serverPurged + result.robotsPurged,
          totalFreedBytes: result.serverFreedBytes + result.robotsFreedBytes,
          details: result.details,
          message: `Bonifica globale completata: eliminati ${result.serverPurged + result.robotsPurged} file temporanei.`,
        });
      } catch (err: any) {
        return handleRouteError(reply, err);
      }
    }
  );

  // =========================================================================
  // 6. CARICAMENTO MASSIVO MULTI-TARGET: PRE-CHECK CONFLITTI (RF-TRF-009, RF-TRF-011)
  // =========================================================================
  app.post(
    "/api/transfers/bulk/pre-check",
    {
      preHandler: [authMiddleware.requirePermission(AppPermission.FLEET_VIEW)],
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const body = req.body as BulkPreCheckRequest;
      if (!body || !Array.isArray(body.filenames) || !Array.isArray(body.targets)) {
        return reply.status(400).send({
          code: "INVALID_REQUEST_BODY",
          message: "Richiesta non valida: 'filenames' e 'targets' devono essere array.",
        });
      }

      const context = sessionManager.createAuthorizedContext(
        req.molirisSession!,
        req.molirisUser!,
        undefined,
        roleMapping
      );

      try {
        const response = await transferService.checkBulkConflicts(context, body);
        return reply.status(200).send(response);
      } catch (err: any) {
        return handleRouteError(reply, err);
      }
    }
  );

  // =========================================================================
  // 7. CARICAMENTO MASSIVO MULTI-TARGET: UPLOAD STREAMING (RF-TRF-001..005, RF-TRF-009)
  // =========================================================================
  app.post(
    "/api/transfers/bulk/upload",
    {
      preHandler: [authMiddleware.requirePermission(AppPermission.FLEET_VIEW)],
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (!req.isMultipart()) {
        return reply.status(400).send({
          code: "INVALID_MULTIPART_REQUEST",
          message: "Richiesta non valida: atteso payload multipart/form-data.",
        });
      }

      const context = sessionManager.createAuthorizedContext(
        req.molirisSession!,
        req.molirisUser!,
        undefined,
        roleMapping
      );

      let targets: BulkTarget[] = [];
      let overwrite = false;
      const stagedFiles: Array<{
        filename: string;
        stagingPath: string;
        sizeBytes: number;
        sha256: string;
      }> = [];
      const stagingPaths: string[] = [];
      let totalStagedBytes = 0;

      const stagingDir = path.join(
        transferService.getConfig().serverFilesystemRoot,
        ".tmp_bulk"
      );
      if (!fs.existsSync(stagingDir)) {
        await fs.promises.mkdir(stagingDir, { recursive: true, mode: 0o700 });
      }

      const uploadSessionId = crypto.randomUUID();
      let fileIndex = 0;

      try {
        const parts = req.parts();
        for await (const part of parts) {
          if (part.type === "file") {
            fileIndex++;
            const safeFilename = path.basename(part.filename);
            const stagingPath = path.join(stagingDir, `staging_${uploadSessionId}_${fileIndex}.part`);
            stagingPaths.push(stagingPath);

            const hash = crypto.createHash("sha256");
            let totalBytes = 0;
            const writeStream = fs.createWriteStream(stagingPath, { mode: 0o600 });

            await new Promise<void>((resolve, reject) => {
              part.file.on("data", (chunk: Buffer | string) => {
                const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                hash.update(buf);
                totalBytes += buf.length;
              });
              part.file.on("error", reject);
              writeStream.on("error", reject);
              writeStream.on("finish", () => resolve());
              part.file.pipe(writeStream);
            });

            if (part.file.truncated) {
              throw new MolirisAppError(ErrorCode.TRANSFER_INTERRUPTED, "Un file supera la dimensione massima consentita.");
            }
            totalStagedBytes += totalBytes;
            const maxUploadBytes = (req.server as any).appConfig.maxFileUploadBytes as number;
            if (totalStagedBytes > maxUploadBytes) {
              throw new MolirisAppError(ErrorCode.TRANSFER_INTERRUPTED, "La dimensione totale dei file supera il limite consentito.");
            }

            stagedFiles.push({
              filename: safeFilename,
              stagingPath,
              sizeBytes: totalBytes,
              sha256: hash.digest("hex"),
            });
          } else if (part.type === "field") {
            if (part.fieldname === "targets") {
              try {
                targets = typeof part.value === "string" ? JSON.parse(part.value) : (part.value as any);
              } catch {
                throw new MolirisAppError(ErrorCode.MISSING_ROBOT_PARAMS, "Campo 'targets' non valido o JSON malformato.");
              }
            } else if (part.fieldname === "overwrite") {
              overwrite = part.value === "true" || part.value === true;
            }
          }
        }

        if (stagedFiles.length === 0) {
          throw new MolirisAppError(ErrorCode.TRANSFER_INTERRUPTED, "Nessun file presente nel payload di caricamento.");
        }

        if (!targets || targets.length === 0) {
          throw new MolirisAppError(ErrorCode.MISSING_ROBOT_PARAMS, "Nessuna destinazione (server/robot) selezionata.");
        }

        // Se overwrite non è confermata, esegui pre-check dei conflitti
        if (!overwrite) {
          const preCheck = await transferService.checkBulkConflicts(context, {
            filenames: stagedFiles.map((f) => f.filename),
            targets,
          });

          if (preCheck.hasConflicts) {
            // Pulizia immediata dei file di staging per evitare spreco spazio o residui
            for (const s of stagedFiles) {
              try { if (fs.existsSync(s.stagingPath)) await fs.promises.unlink(s.stagingPath); } catch {}
            }
            return reply.status(409).send({
              code: "CONFLICTS_DETECTED",
              message: "Rilevati conflitti di sovrascrittura. Richiesta conferma esplicita.",
              conflicts: preCheck.conflicts,
            });
          }
        }

        // Esecuzione atomica del caricamento massivo
        const bulkResponse = await transferService.executeBulkUpload(context, {
          targets,
          overwrite,
          stagedFiles,
        });

        return reply.status(200).send(bulkResponse);
      } catch (err: any) {
        return handleRouteError(reply, err);
      } finally {
        for (const s of stagingPaths) {
          try {
            if (fs.existsSync(s)) {
              await fs.promises.unlink(s);
            }
          } catch {}
        }
      }
    }
  );

  // =========================================================================
  // 8. CARICAMENTO MASSIVO DA FILE SUL SERVER (§5, §7)
  // =========================================================================
  app.post(
    "/api/transfers/bulk/server-source",
    {
      preHandler: [authMiddleware.requirePermission(AppPermission.FLEET_VIEW)],
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const body = req.body as any;
      if (!body || !Array.isArray(body.sourcePaths) || !Array.isArray(body.targets)) {
        return reply.status(400).send({
          code: "INVALID_REQUEST_BODY",
          message: "Richiesta non valida: 'sourcePaths' e 'targets' devono essere array.",
        });
      }

      const context = sessionManager.createAuthorizedContext(
        req.molirisSession!,
        req.molirisUser!,
        undefined,
        roleMapping
      );

      try {
        const response = await transferService.executeBulkServerSource(context, {
          sourceScope: body.sourceScope || "general",
          sourceRobotId: body.sourceRobotId,
          sourcePaths: body.sourcePaths,
          targets: body.targets,
          overwrite: Boolean(body.overwrite),
        });
        return reply.status(200).send(response);
      } catch (err: any) {
        return handleRouteError(reply, err);
      }
    }
  );

  // =========================================================================
  // 9. TRASFERIMENTO ROBOT -> ROBOT (COPIA O SPOSTAMENTO) (§6)
  // =========================================================================
  app.post(
    "/api/transfers/robot-robot",
    {
      preHandler: [authMiddleware.requirePermission(AppPermission.FLEET_VIEW)],
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const body = req.body as any;
      if (!body || !body.sourceRobotId || !body.sourceRemotePath || !Array.isArray(body.targetRobotIds)) {
        return reply.status(400).send({
          code: "INVALID_REQUEST_BODY",
          message: "Richiesta non valida: 'sourceRobotId', 'sourceRemotePath' e 'targetRobotIds' sono obbligatori.",
        });
      }

      const context = sessionManager.createAuthorizedContext(
        req.molirisSession!,
        req.molirisUser!,
        undefined,
        roleMapping
      );

      try {
        const response = await transferService.executeRobotToRobotTransfer(context, {
          sourceRobotId: body.sourceRobotId,
          sourceRemotePath: body.sourceRemotePath,
          targetRobotIds: body.targetRobotIds,
          targetRemotePaths: body.targetRemotePaths,
          commonTargetDirectory: body.commonTargetDirectory,
          isMove: Boolean(body.isMove),
          confirmation: Boolean(body.confirmation),
          overwrite: Boolean(body.overwrite),
        });
        return reply.status(200).send(response);
      } catch (err: any) {
        return handleRouteError(reply, err);
      }
    }
  );
}

function sendErrorReply(reply: FastifyReply, status: number, code: ErrorCode, message: string): FastifyReply {
  const errDef = ERROR_CATALOG[code];
  return reply.status(status).send({
    code: errDef.code,
    message,
    classification: errDef.classification,
  });
}

function handleRouteError(reply: FastifyReply, err: any): FastifyReply {
  if (err instanceof MolirisAppError) {
    let statusCode = 400;
    if (err.code === ErrorCode.INSUFFICIENT_PERMISSIONS) {
      statusCode = 403;
    } else if (err.code === ErrorCode.SERVER_DIR_INACCESSIBLE || err.code === ErrorCode.REMOTE_FS_ERROR) {
      statusCode = err.diagnosticDetail.includes("non trovato") ? 404 : 400;
    } else if (err.code === ErrorCode.HOST_UNREACHABLE || err.code === ErrorCode.SSH_PORT_UNAVAILABLE) {
      statusCode = 503;
    } else if (err.code === ErrorCode.TIMEOUT_ERROR) {
      statusCode = 504;
    } else if (err.code === ErrorCode.INSUFFICIENT_STORAGE) {
      statusCode = 507; // Insufficient Storage
    }

    return reply.status(statusCode).send({
      code: err.code,
      message: err.userMessage,
      classification: err.classification,
    });
  }

  return reply.status(500).send({
    code: "INTERNAL_ERROR",
    message: "Si è verificato un errore imprevisto durante l'elaborazione.",
    classification: "recuperabile",
  });
}
