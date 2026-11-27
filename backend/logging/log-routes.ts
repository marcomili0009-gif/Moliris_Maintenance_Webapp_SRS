// Requisiti soddisfatti: Requisito #8, RF-AUTH-005, RNF-SEC-004, RNF-SEC-005

import fs from "fs";
import { type FastifyInstance, type FastifyRequest, type FastifyReply } from "fastify";
import { type PhysicalFileLogger } from "./physical-file-logger.ts";
import { type AuthMiddleware } from "../auth/auth-middleware.ts";
import { type TransferService } from "../transfer/transfer-service.ts";
import { MolirisAppError, ErrorCode, ERROR_CATALOG } from "../../errors/app-errors.ts";

export function registerLogRoutes(
  app: FastifyInstance,
  fileLogger: PhysicalFileLogger,
  authMiddleware: AuthMiddleware,
  transferService?: TransferService
): void {
  const requireAdmin = (req: FastifyRequest, reply: FastifyReply): boolean => {
    const user = req.molirisUser;
    if (!user) {
      reply.status(401).send({
        code: ErrorCode.INSUFFICIENT_PERMISSIONS,
        message: "Autenticazione richiesta.",
        classification: "richiede_intervento_amministrativo",
      });
      return false;
    }

    const roles = Array.isArray(user.roles) ? user.roles : [];
    const isAdmin = roles.some((r) => {
      const lower = (r || "").toLowerCase();
      return lower === "admin";
    });

    if (!isAdmin) {
      reply.status(403).send({
        code: ErrorCode.INSUFFICIENT_PERMISSIONS,
        message: "Accesso ai log di audit riservato esclusivamente agli amministratori.",
        classification: "richiede_intervento_amministrativo",
      });
      return false;
    }

    return true;
  };

  /**
   * GET /api/logs/access
   * Query filtri: limit, user, event
   */
  app.get(
    "/api/logs/access",
    { preHandler: [authMiddleware.authenticate.bind(authMiddleware)] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (!requireAdmin(req, reply)) return;

      const query = (req.query as any) || {};
      const limit = query.limit ? Number(query.limit) : 100;
      const user = typeof query.user === "string" ? query.user.trim() : undefined;
      const event = typeof query.event === "string" ? query.event.trim() : undefined;

      try {
        const logs = await fileLogger.getAccessLogs({ limit, user, event });
        return reply.status(200).send({
          success: true,
          type: "access",
          total: logs.length,
          logs,
        });
      } catch (err: any) {
        return reply.status(500).send({
          code: ErrorCode.SERVER_DIR_INACCESSIBLE,
          message: "Errore durante la lettura dei log di accesso.",
          classification: "richiede_intervento_amministrativo",
        });
      }
    }
  );

  /**
   * GET /api/logs/transfers
   * Query filtri: limit, offset, user, outcome, status, batchId, file
   * Restituisce sia le righe testuali di transfers.log (retrocompatibilità) sia
   * lo storico strutturato completo (records) inclusi TUTTI i trasferimenti falliti,
   * annullati, interrotti, in corso, in coda e completati.
   */
  app.get(
    "/api/logs/transfers",
    { preHandler: [authMiddleware.authenticate.bind(authMiddleware)] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (!requireAdmin(req, reply)) return;

      const query = (req.query as any) || {};
      const limit = query.limit ? Number(query.limit) : 200;
      const offset = query.offset ? Number(query.offset) : 0;
      const user = typeof query.user === "string" ? query.user.trim() : undefined;
      const outcome = typeof query.outcome === "string" ? query.outcome.trim() : undefined;
      const status = typeof query.status === "string" ? query.status.trim() : undefined;
      const batchId = typeof query.batchId === "string" ? query.batchId.trim() : undefined;
      const file = typeof query.file === "string" ? query.file.trim() : undefined;

      try {
        const [logs, records] = await Promise.all([
          fileLogger.getTransferLogs({ limit, user, outcome }),
          transferService
            ? transferService.listAllTransferHistory({
                limit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, 1000) : 200,
                offset: Number.isFinite(offset) && offset > 0 ? offset : 0,
                user: user || undefined,
                outcome: outcome || undefined,
                status: status || undefined,
                batchId: batchId || undefined,
                file: file || undefined,
              })
            : Promise.resolve([]),
        ]);
        return reply.status(200).send({
          success: true,
          type: "transfers",
          total: logs.length,
          logs,
          totalRecords: records.length,
          records,
        });
      } catch (err: any) {
        return reply.status(500).send({
          code: ErrorCode.SERVER_DIR_INACCESSIBLE,
          message: "Errore durante la lettura dei log dei trasferimenti.",
          classification: "richiede_intervento_amministrativo",
        });
      }
    }
  );

  /**
   * GET /api/logs/download/:type
   * type: "access" | "transfers"
   * Restituisce il file fisico come allegato da scaricare
   */
  app.get(
    "/api/logs/download/:type",
    { preHandler: [authMiddleware.authenticate.bind(authMiddleware)] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (!requireAdmin(req, reply)) return;

      const { type } = req.params as { type: string };
      if (type !== "access" && type !== "transfers") {
        return reply.status(400).send({
          code: ErrorCode.MISSING_ROBOT_PARAMS,
          message: "Tipo di log non valido. Valori ammessi: 'access', 'transfers'.",
          classification: "recuperabile",
        });
      }

      await fileLogger.ensureInitialized();
      const filePath =
        type === "access"
          ? fileLogger.getAccessLogFilePath()
          : fileLogger.getTransferLogFilePath();

      if (!fs.existsSync(filePath)) {
        return reply.status(404).send({
          code: ErrorCode.SERVER_DIR_INACCESSIBLE,
          message: `File di log '${type}.log' non presente.`,
          classification: "recuperabile",
        });
      }

      const stream = type === "transfers"
        ? await fileLogger.openTransferLogDownload()
        : fs.createReadStream(filePath);
      reply.header("Content-Disposition", `attachment; filename="${type}.log"`);
      reply.header("Content-Type", "text/plain; charset=utf-8");
      return reply.send(stream);
    }
  );

  /**
   * DELETE /api/logs/access
   * Svuota esclusivamente il registro dei log di accesso (riservato ad admin).
   */
  app.delete(
    "/api/logs/access",
    { preHandler: [authMiddleware.authenticate.bind(authMiddleware)] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (!requireAdmin(req, reply)) return;

      try {
        await fileLogger.clearAccessLogs();
        return reply.status(200).send({
          success: true,
          type: "access",
          message: "Log di accesso svuotato con successo.",
        });
      } catch {
        return reply.status(500).send({
          code: ErrorCode.SERVER_DIR_INACCESSIBLE,
          message: "Errore durante l'eliminazione dei log di accesso.",
          classification: "richiede_intervento_amministrativo",
        });
      }
    }
  );

  /**
   * DELETE /api/logs/transfers
   * Svuota esclusivamente il registro dei log dei trasferimenti (riservato ad admin).
   */
  app.delete(
    "/api/logs/transfers",
    { preHandler: [authMiddleware.authenticate.bind(authMiddleware)] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (!requireAdmin(req, reply)) return;

      try {
        await fileLogger.clearTransferLogs();
        return reply.status(200).send({
          success: true,
          type: "transfers",
          message: "Log dei trasferimenti svuotato con successo.",
        });
      } catch {
        return reply.status(500).send({
          code: ErrorCode.SERVER_DIR_INACCESSIBLE,
          message: "Errore durante l'eliminazione dei log dei trasferimenti.",
          classification: "richiede_intervento_amministrativo",
        });
      }
    }
  );
}
