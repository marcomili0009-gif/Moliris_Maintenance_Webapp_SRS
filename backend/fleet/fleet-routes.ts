// Requisiti soddisfatti: RF-ROB-001..014, RNF-SEC-002, RNF-SEC-004, RNF-SEC-009, SRS §9, CA-AUTH-003, CA-ROB-001..012

import { type FastifyInstance, type FastifyRequest, type FastifyReply } from "fastify";
import { type FleetService } from "./fleet-service.ts";
import { type AuthMiddleware } from "../auth/auth-middleware.ts";
import { AppPermission } from "../auth/permissions.ts";
import { MolirisAppError, ErrorCode, ERROR_CATALOG } from "../../errors/app-errors.ts";
import {
  type RobotRegistrationInput,
  type RobotConfigurationUpdateInput,
} from "./fleet-types.ts";

export function registerFleetRoutes(
  app: FastifyInstance,
  fleetService: FleetService,
  authMiddleware: AuthMiddleware
): void {
  // Helper per estrarre robotId dai parametri di rotta
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
          : 500;

      return reply.status(status).send({
        code: err.code,
        message: err.userMessage,
        classification: err.classification,
      });
    }

    const defaultDef = ERROR_CATALOG[ErrorCode.DB_PERSISTENCE_ERROR];
    return reply.status(500).send({
      code: defaultDef.code,
      message: defaultDef.userMessage,
      classification: defaultDef.classification,
    });
  };

  // STEP 1 – Lista della flotta (RF-ROB-001, RF-ROB-014, CA-ROB-012)
  app.get(
    "/api/robots",
    { preHandler: [authMiddleware.requirePermission(AppPermission.FLEET_VIEW)] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        const user = req.molirisUser!;
        const query = (req.query || {}) as { limit?: string; offset?: string };
        const rawLimit = query.limit !== undefined ? parseInt(query.limit, 10) : undefined;
        const rawOffset = query.offset !== undefined ? parseInt(query.offset, 10) : undefined;
        const list = await fleetService.listFleet(user, {
          limit: rawLimit !== undefined && Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : undefined,
          offset: rawOffset !== undefined && Number.isFinite(rawOffset) && rawOffset >= 0 ? rawOffset : undefined,
        });
        return reply.status(200).send({ robots: list });
      } catch (err: any) {
        return handleError(err, reply);
      }
    }
  );

  // STEP 2 – Dettaglio del robot e funzionalità autorizzate (RF-ROB-002, RF-ROB-003, RF-ROB-011)
  app.get(
    "/api/robots/:robotId",
    { preHandler: [authMiddleware.requirePermission(AppPermission.FLEET_VIEW, extractRobotId)] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        const user = req.molirisUser!;
        const { robotId } = req.params as { robotId: string };
        const result = await fleetService.getRobotDetail(user, robotId);
        return reply.status(200).send(result);
      } catch (err: any) {
        return handleError(err, reply);
      }
    }
  );

  // STEP 3, 4, 5, 6, 7 – Registrazione di un nuovo robot (RF-ROB-004..012, CA-ROB-001..009)
  app.post(
    "/api/robots",
    { preHandler: [authMiddleware.requirePermission(AppPermission.ROBOT_REGISTER)] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        const user = req.molirisUser!;
        const body = (req.body || {}) as RobotRegistrationInput;
        const result = await fleetService.registerRobot(user, body);

        // Se la registrazione è stata rifiutata per validazione fallita
        if (result.outcome === "registrazione_rifiutata") {
          return reply.status(400).send(result);
        }
        // Se la creazione della directory è fallita
        if (result.outcome === "creazione_directory_fallita") {
          return reply.status(502).send(result);
        }
        // Se la connessione SSH non è stata verificata in modalità rigorosa
        if (result.outcome === "ssh_non_verificata" && !result.robot) {
          return reply.status(422).send(result);
        }
        // Se incompleta
        if (result.outcome === "registrazione_incompleta") {
          return reply.status(500).send(result);
        }

        // Esito positivo o differito
        return reply.status(201).send(result);
      } catch (err: any) {
        return handleError(err, reply);
      }
    }
  );

  // STEP 5 – Ripeti verifica connessione SSH (RF-ROB-007, §6.3, §8.1)
  app.post(
    "/api/robots/:robotId/verify-connection",
    {
      preHandler: [
        authMiddleware.requirePermission(AppPermission.FLEET_VIEW, extractRobotId),
      ],
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        const user = req.molirisUser!;
        const { robotId } = req.params as { robotId: string };
        const result = await fleetService.verifyConnection(user, robotId);
        return reply.status(200).send(result);
      } catch (err: any) {
        return handleError(err, reply);
      }
    }
  );

  // STEP 6 – Riparazione o recupero controllato di registrazione incompleta (CA-ROB-008)
  app.post(
    "/api/robots/:robotId/repair",
    {
      preHandler: [
        authMiddleware.requirePermission(AppPermission.ROBOT_REGISTER, extractRobotId),
      ],
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        const user = req.molirisUser!;
        const { robotId } = req.params as { robotId: string };
        const result = await fleetService.repairRegistration(user, robotId);
        return reply.status(200).send(result);
      } catch (err: any) {
        return handleError(err, reply);
      }
    }
  );

  // STEP 9 – Modifica configurazione robot (§2.2, §8.3)
  app.put(
    "/api/robots/:robotId/configuration",
    {
      preHandler: [
        authMiddleware.requirePermission(AppPermission.ROBOT_CONFIG_UPDATE, extractRobotId),
      ],
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        const user = req.molirisUser!;
        const { robotId } = req.params as { robotId: string };
        const body = (req.body || {}) as RobotConfigurationUpdateInput;
        const result = await fleetService.updateConfiguration(user, robotId, body);
        return reply.status(200).send({ robot: result });
      } catch (err: any) {
        return handleError(err, reply);
      }
    }
  );

  // STEP 10 – Disabilitazione robot (RF-ROB-013, §8.4, CA-ROB-011)
  app.post(
    "/api/robots/:robotId/disable",
    {
      preHandler: [
        authMiddleware.requirePermission(AppPermission.ROBOT_DISABLE, extractRobotId),
      ],
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        const user = req.molirisUser!;
        const { robotId } = req.params as { robotId: string };
        const result = await fleetService.disableRobot(user, robotId);
        return reply.status(200).send({ robot: result, message: "Robot disabilitato con successo." });
      } catch (err: any) {
        return handleError(err, reply);
      }
    }
  );

  // STEP 10 – Riabilitazione robot
  app.post(
    "/api/robots/:robotId/enable",
    {
      preHandler: [
        authMiddleware.requirePermission(AppPermission.ROBOT_DISABLE, extractRobotId),
      ],
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        const user = req.molirisUser!;
        const { robotId } = req.params as { robotId: string };
        const result = await fleetService.enableRobot(user, robotId);
        return reply.status(200).send({ robot: result, message: "Robot riabilitato con successo." });
      } catch (err: any) {
        return handleError(err, reply);
      }
    }
  );

  // STEP 10 – Rimozione dall'anagrafica attiva (RF-ROB-013, §8.4, CA-ROB-011)
  app.post(
    "/api/robots/:robotId/remove",
    {
      preHandler: [
        authMiddleware.requirePermission(AppPermission.ROBOT_REMOVE, extractRobotId),
      ],
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        const user = req.molirisUser!;
        const { robotId } = req.params as { robotId: string };
        const body = (req.body || {}) as { confirmation?: boolean };
        await fleetService.removeRobot(user, robotId, body.confirmation === true);
        return reply.status(200).send({ message: "Robot rimosso dall'anagrafica attiva con successo." });
      } catch (err: any) {
        return handleError(err, reply);
      }
    }
  );
}
