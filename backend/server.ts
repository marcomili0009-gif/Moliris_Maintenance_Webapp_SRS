// Requisiti soddisfatti: RNF-SEC-001, SRS §2.4 vincolo 3, §5.1, §5.2, RF-AUTH-001..006

import Fastify, { type FastifyInstance } from "fastify";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { type SystemConfiguration, loadAndValidateConfig } from "../config/configuration.ts";
import { MolirisLogger } from "../logging/logger.ts";
import { SessionManager } from "./auth/session-manager.ts";
import { type UserRepository, InMemoryUserRepository } from "./auth/user-repository.ts";
import { type AuditRepository, InMemoryAuditRepository } from "../storage/audit-repository.ts";
import { type RobotRepository, InMemoryRobotRepository } from "../storage/robot-repository.ts";
import { ServerFilesystemService } from "../storage/server-fs.ts";
import { AuthMiddleware } from "./auth/auth-middleware.ts";
import { registerAuthRoutes } from "./auth/auth-routes.ts";
import { registerServerFsRoutes } from "./server-fs-routes.ts";
import { type RolePermissionMapping, DEFAULT_ROLE_PERMISSIONS } from "./auth/permissions.ts";
import { type CredentialProvider, InMemoryCredentialProvider } from "./connection/credential-provider.ts";
import { type HostKeyVerifier, DefaultHostKeyVerifier } from "./connection/host-key-verifier.ts";
import { RobotConnectionManager } from "./connection/robot-connection-manager.ts";
import { FleetService } from "./fleet/fleet-service.ts";
import { registerFleetRoutes } from "./fleet/fleet-routes.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface ServerDependencies {
  sessionManager?: SessionManager;
  userRepository?: UserRepository;
  auditRepository?: AuditRepository;
  robotRepository?: RobotRepository;
  serverFsService?: ServerFilesystemService;
  credentialProvider?: CredentialProvider;
  hostKeyVerifier?: HostKeyVerifier;
  connectionManager?: RobotConnectionManager;
  fleetService?: FleetService;
  roleMapping?: RolePermissionMapping;
}

export function createServer(
  config: SystemConfiguration,
  logger: MolirisLogger,
  deps: ServerDependencies = {}
): FastifyInstance {
  // Verifica esistenza certificati TLS obbligatori per HTTPS esclusivo (RNF-SEC-001)
  if (!fs.existsSync(config.tlsCertPath) || !fs.existsSync(config.tlsKeyPath)) {
    throw new Error(`File certificato o chiave TLS mancante: ${config.tlsCertPath}, ${config.tlsKeyPath}`);
  }

  const httpsOptions = {
    key: fs.readFileSync(config.tlsKeyPath),
    cert: fs.readFileSync(config.tlsCertPath),
  };

  const app = Fastify({
    https: httpsOptions,
    logger: false, // Disabilitato il logger standard in favore del logger applicativo con redazione attiva
  });

  // Dipendenze di autenticazione e sicurezza
  const sessionManager = deps.sessionManager || new SessionManager(config.inactiveSessionTimeoutMinutes);
  const userRepository = deps.userRepository || new InMemoryUserRepository();
  const auditRepository = deps.auditRepository || new InMemoryAuditRepository();
  const roleMapping = deps.roleMapping || DEFAULT_ROLE_PERMISSIONS;

  const authMiddleware = new AuthMiddleware(
    sessionManager,
    userRepository,
    auditRepository,
    logger,
    roleMapping
  );

  // Dipendenze di persistenza e filesystem
  const robotRepository = deps.robotRepository || new InMemoryRobotRepository();
  const serverFsService = deps.serverFsService || new ServerFilesystemService(config.serverFilesystemRoot, auditRepository, logger);

  // Dipendenze di connessione comune verso i robot (Prompt 5, vincolo 2.4 punto 4)
  const credentialProvider = deps.credentialProvider || new InMemoryCredentialProvider(config.allowedSshAuthMethods);
  const hostKeyVerifier = deps.hostKeyVerifier || new DefaultHostKeyVerifier();
  const connectionLimits = {
    maxConcurrentPerUser: config.maxConcurrentTransfersPerUser,
    maxConcurrentPerRobot: config.maxConcurrentTransfersPerRobot,
    maxConcurrentServer: config.maxConcurrentTransfersServer,
    connectionTimeoutMs: config.sshConnectionTimeoutMs,
  };
  const connectionManager = deps.connectionManager || new RobotConnectionManager(
    credentialProvider,
    hostKeyVerifier,
    connectionLimits,
    logger
  );

  // Servizio di gestione flotta (Prompt 6, RF-ROB-001..014)
  const fleetService = deps.fleetService || new FleetService(
    config,
    robotRepository,
    auditRepository,
    serverFsService,
    credentialProvider,
    hostKeyVerifier,
    connectionManager,
    logger,
    roleMapping
  );

  // Registrazione endpoint di autenticazione e autorizzazione (RF-AUTH-001..006)
  registerAuthRoutes(
    app,
    sessionManager,
    userRepository,
    auditRepository,
    authMiddleware,
    logger
  );

  // Registrazione endpoint filesystem server (RF-SRVFS-002, RF-SRVFS-005)
  registerServerFsRoutes(
    app,
    serverFsService,
    robotRepository,
    sessionManager,
    authMiddleware,
    roleMapping
  );

  // Registrazione endpoint gestione flotta (RF-ROB-001..014)
  registerFleetRoutes(
    app,
    fleetService,
    authMiddleware
  );

  // Singolo endpoint tecnico di verifica dello stato del servizio (senza dati sensibili)
  app.get("/healthz", async (_request, reply) => {
    return reply.status(200).send({
      status: "OK",
      timestamp: new Date().toISOString(),
    });
  });

  // Servizio statico del frontend client compatibile Google Chrome (§2.5, §5.1, RNF-UX-002/003)
  const frontendDir = path.resolve(__dirname, "../frontend");

  app.get("/", async (_request, reply) => {
    const indexPath = path.join(frontendDir, "index.html");
    if (fs.existsSync(indexPath)) {
      reply.type("text/html").send(fs.readFileSync(indexPath));
    } else {
      reply.status(404).send("Frontend non trovato");
    }
  });

  app.get("/styles.css", async (_request, reply) => {
    const cssPath = path.join(frontendDir, "styles.css");
    if (fs.existsSync(cssPath)) {
      reply.type("text/css").send(fs.readFileSync(cssPath));
    } else {
      reply.status(404).send("File styles.css non trovato");
    }
  });

  app.get("/app.js", async (_request, reply) => {
    const jsPath = path.join(frontendDir, "app.js");
    if (fs.existsSync(jsPath)) {
      reply.type("application/javascript").send(fs.readFileSync(jsPath));
    } else {
      reply.status(404).send("File app.js non trovato");
    }
  });

  return app;
}

// Avvio del server se eseguito direttamente
if (process.argv[1] && process.argv[1].endsWith("server.ts")) {
  const logger = new MolirisLogger();
  try {
    const config = loadAndValidateConfig(process.env);
    const server = createServer(config, logger);
    const port = Number(process.env["MOLIRIS_SERVER_PORT"]) || 8443;
    const host = process.env["MOLIRIS_SERVER_HOST"] || "0.0.0.0";

    server.listen({ port, host }, (err, address) => {
      if (err) {
        logger.error("Errore fatale avvio server HTTPS", err.message);
        process.exit(1);
      }
      logger.info(`Backend HTTPS avviato con successo su ${address}`);
    });
  } catch (error: any) {
    logger.error("Errore inizializzazione backend", error.message);
    process.exit(1);
  }
}
