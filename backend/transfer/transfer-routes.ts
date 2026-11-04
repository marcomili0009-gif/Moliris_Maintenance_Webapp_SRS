// Requisiti soddisfatti: RF-TRF-001, RF-TRF-002, RF-TRF-003, RF-TRF-004, RF-TRF-005,
// RF-TRF-006, RF-TRF-007, RF-TRF-008, RF-TRF-009, RF-TRF-010, RF-TRF-011, RF-TRF-012,
// RF-TRF-013, RF-TRF-014, RNF-SEC-002, RNF-SEC-004, RNF-SEC-005, RNF-SEC-007, RNF-SEC-008,
// RNF-SEC-009, RNF-PERF-001, RNF-PERF-002, RNF-PERF-003, RNF-REL-004, RNF-REL-005,
// SRS §1.2, §2.4, §5.5, §6.5, §6.6, §6.7, §9, §10.3, CA-FS-002, CA-FS-003, CA-FS-004

import { type FastifyInstance, type FastifyRequest, type FastifyReply } from "fastify";
import { type Readable } from "stream";
import { type TransferService } from "./transfer-service.ts";
import { type RobotRepository } from "../../storage/robot-repository.ts";
import { type SessionManager } from "../auth/session-manager.ts";
import { type AuthMiddleware } from "../auth/auth-middleware.ts";
import { AppPermission, type RolePermissionMapping, DEFAULT_ROLE_PERMISSIONS } from "../auth/permissions.ts";
import { MolirisAppError, ErrorCode, ERROR_CATALOG } from "../../errors/app-errors.ts";
import { type StartServerRobotTransferRequest } from "./transfer-models.ts";

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
