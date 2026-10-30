// Requisiti soddisfatti: RNF-SEC-001, SRS §2.4 vincolo 3, §5.1, §5.2, RF-AUTH-001..006

import Fastify, { type FastifyInstance } from "fastify";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { type SystemConfiguration, loadAndValidateConfig } from "../config/configuration.ts";
import { MolirisLogger } from "../logging/logger.ts";
import { SessionManager } from "./auth/session-manager.ts";
import { type UserRepository, InMemoryUserRepository, MongoUserRepository } from "./auth/user-repository.ts";
import { type AuditRepository, InMemoryAuditRepository, MongoAuditRepository } from "../storage/audit-repository.ts";
import { type RobotRepository, InMemoryRobotRepository, MongoRobotRepository } from "../storage/robot-repository.ts";
import { MongoClient } from "mongodb";
import { ServerFilesystemService } from "../storage/server-fs.ts";
import { AuthMiddleware } from "./auth/auth-middleware.ts";
import { registerAuthRoutes } from "./auth/auth-routes.ts";
import { registerServerFsRoutes } from "./server-fs-routes.ts";
import { type RolePermissionMapping, DEFAULT_ROLE_PERMISSIONS } from "./auth/permissions.ts";
import { type CredentialProvider, InMemoryCredentialProvider } from "./connection/credential-provider.ts";
import { MongoCredentialProvider } from "./connection/mongo-credential-provider.ts";
import { loadMasterKeyFromFile } from "./connection/master-key.ts";
import { type HostKeyVerifier, DefaultHostKeyVerifier } from "./connection/host-key-verifier.ts";
import { RobotConnectionManager } from "./connection/robot-connection-manager.ts";
import { FleetService } from "./fleet/fleet-service.ts";
import { registerFleetRoutes } from "./fleet/fleet-routes.ts";
import { type StateFileParser, ProvisionalDevelopmentStateFileParser } from "./monitoring/state-file-parser.ts";
import { RemoteRobotReader } from "./monitoring/robot-reader.ts";
import { MonitoringService } from "./monitoring/monitoring-service.ts";
import { registerMonitoringRoutes } from "./monitoring/monitoring-routes.ts";
import websocket from "@fastify/websocket";
import { TerminalService } from "./terminal/terminal-service.ts";
import { registerTerminalRoutes } from "./terminal/terminal-routes.ts";
import { RemoteFilesystemService } from "./remote-fs/remote-fs-service.ts";
import { registerRemoteFsRoutes } from "./remote-fs/remote-fs-routes.ts";
import { TransferService } from "./transfer/transfer-service.ts";
import { registerTransferRoutes } from "./transfer/transfer-routes.ts";

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
  stateFileParser?: StateFileParser;
  remoteRobotReader?: RemoteRobotReader;
  monitoringService?: MonitoringService;
  terminalService?: TerminalService;
  remoteFsService?: RemoteFilesystemService;
  transferService?: TransferService;
  roleMapping?: RolePermissionMapping;
  db?: any;
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

  // Registrazione supporto WebSocket per canale terminale interattivo (RF-SSH-004, §5.4)
  app.register(websocket);

  // Dipendenze di autenticazione e sicurezza
  const sessionManager = deps.sessionManager || new SessionManager(config.inactiveSessionTimeoutMinutes, config.sessionAbsoluteMaxMinutes);
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
  let credentialProvider = deps.credentialProvider;
  if (!credentialProvider) {
    if (config.credentialProviderType === "mongo") {
      if (deps.db) {
        const masterKey = loadMasterKeyFromFile(config.masterKeyFilePath!);
        credentialProvider = new MongoCredentialProvider(deps.db, masterKey, config.allowedSshAuthMethods);
      } else {
        credentialProvider = new InMemoryCredentialProvider(config.allowedSshAuthMethods);
      }
    } else {
      if (process.env.NODE_ENV === "production") {
        throw new Error("Configurazione non sicura: il provider 'in-memory' non è consentito in ambiente di produzione (NODE_ENV=production).");
      }
      credentialProvider = new InMemoryCredentialProvider(config.allowedSshAuthMethods);
    }
  }
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
    logger,
    auditRepository
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

  // Servizio di monitoraggio remoto (Prompt 7, RF-MON-001..006, §5.3, §11.4)
  const stateFileParser = deps.stateFileParser || new ProvisionalDevelopmentStateFileParser(config.stateFileFormat, config.stateFileSchemaPath);
  const remoteRobotReader = deps.remoteRobotReader || new RemoteRobotReader(
    connectionManager,
    config.sshConnectionTimeoutMs,
    logger
  );
  const monitoringService = deps.monitoringService || new MonitoringService(
    config,
    robotRepository,
    auditRepository,
    remoteRobotReader,
    stateFileParser,
    roleMapping,
    logger
  );

  // Servizio di terminale remoto interattivo PTY (Prompt 8, RF-SSH-001..008, §5.4, §6.4)
  const terminalService = deps.terminalService || new TerminalService(
    config,
    robotRepository,
    auditRepository,
    connectionManager,
    sessionManager,
    roleMapping,
    logger
  );
  (fleetService as any).terminalService = terminalService;

  // Servizio di navigazione filesystem remoto del robot (Prompt 9, RF-FS-001..007, §5.5)
  const remoteFsService = deps.remoteFsService || new RemoteFilesystemService(
    config,
    connectionManager,
    auditRepository,
    logger,
    roleMapping
  );

  // Servizio di trasferimento file (Prompt 10, RF-TRF-001..014, §5.5, §6.5..6.7)
  const transferService = deps.transferService || new TransferService(
    config,
    robotRepository,
    serverFsService,
    remoteFsService,
    sessionManager,
    auditRepository,
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

  // Registrazione endpoint monitoraggio stato robot (RF-MON-001..006, §5.3)
  registerMonitoringRoutes(
    app,
    monitoringService,
    authMiddleware
  );

  // Registrazione endpoint filesystem remoto del robot (RF-FS-001..007, §5.5)
  registerRemoteFsRoutes(
    app,
    remoteFsService,
    robotRepository,
    sessionManager,
    authMiddleware,
    roleMapping
  );

  // Registrazione endpoint terminale remoto interattivo PTY (RF-SSH-001..008, §5.4, §6.4)
  app.register(async (terminalScope) => {
    registerTerminalRoutes(
      terminalScope,
      terminalService,
      sessionManager,
      userRepository,
      auditRepository,
      authMiddleware
    );
  });

  // Registrazione endpoint servizio di trasferimento file (RF-TRF-001..014, §5.5, §6.5..6.7)
  registerTransferRoutes(
    app,
    transferService,
    robotRepository,
    sessionManager,
    authMiddleware,
    roleMapping
  );

  // Rilascio risorse, arresto polling periodico e chiusura sessioni alla chiusura del server (RNF-REL-005)
  app.decorate("monitoringService", monitoringService);
  app.decorate("terminalService", terminalService);
  app.decorate("remoteFsService", remoteFsService);
  app.decorate("transferService", transferService);
  app.addHook("onClose", async () => {
    monitoringService.stopPolling();
    transferService.stopCleanupTask();
    await terminalService.closeAll("SERVICE_SHUTDOWN");
    await connectionManager.closeAll();
  });

  // Singolo endpoint tecnico di verifica dello stato del servizio (senza dati sensibili)
  app.get("/healthz", async (_request, reply) => {
    return reply.status(200).send({
      status: "OK",
      timestamp: new Date().toISOString(),
    });
  });

  app.get("/favicon.ico", async (_request, reply) => {
    return reply.status(204).send();
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

  // Servizio moduli frontend modulari ES6 (§5.1, RNF-MNT-002)
  app.get("/:filename.js", async (request, reply) => {
    const { filename } = request.params as { filename: string };
    if (!/^[a-zA-Z0-9_-]+$/.test(filename)) {
      return reply.status(404).send("File non trovato");
    }
    const jsPath = path.join(frontendDir, `${filename}.js`);
    if (fs.existsSync(jsPath)) {
      reply.type("application/javascript").send(fs.readFileSync(jsPath));
    } else {
      reply.status(404).send("File non trovato");
    }
  });

  // Risorse statiche per emulatore terminale xterm.js (§5.1, RNF-UX-004)
  const nodeModulesDir = path.resolve(__dirname, "../node_modules");

  app.get("/vendor/xterm.js", async (_request, reply) => {
    const xtermPath = path.join(nodeModulesDir, "xterm/lib/xterm.js");
    if (fs.existsSync(xtermPath)) {
      reply.type("application/javascript").send(fs.readFileSync(xtermPath));
    } else {
      reply.status(404).send("File xterm.js non trovato");
    }
  });

  app.get("/vendor/xterm.css", async (_request, reply) => {
    const cssPath = path.join(nodeModulesDir, "xterm/css/xterm.css");
    if (fs.existsSync(cssPath)) {
      reply.type("text/css").send(fs.readFileSync(cssPath));
    } else {
      reply.status(404).send("File xterm.css non trovato");
    }
  });

  app.get("/vendor/xterm-addon-fit.js", async (_request, reply) => {
    const fitPath = path.join(nodeModulesDir, "xterm-addon-fit/lib/xterm-addon-fit.js");
    if (fs.existsSync(fitPath)) {
      reply.type("application/javascript").send(fs.readFileSync(fitPath));
    } else {
      reply.status(404).send("File xterm-addon-fit.js non trovato");
    }
  });

  return app;
}

// Avvio del server se eseguito direttamente
if (process.argv[1] && process.argv[1].endsWith("server.ts")) {
  const logger = new MolirisLogger();
  let mongoClient: MongoClient | undefined;

  try {
    const config = loadAndValidateConfig(process.env);
    const mongoUri = process.env["MOLIRIS_MONGODB_URI"];

    if (!mongoUri) {
      throw new Error("Variabile MOLIRIS_MONGODB_URI non configurata");
    }

    mongoClient = new MongoClient(mongoUri);
    await mongoClient.connect();

    const db = mongoClient.db();
    const robotRepository = new MongoRobotRepository(db);
    await robotRepository.initIndexes();

    const auditRepository = new MongoAuditRepository(db);
    await auditRepository.initIndexes(config.auditLogRetentionDays);

    const userRepository = new MongoUserRepository(db);
    await userRepository.initIndexes();

    let credentialProvider: CredentialProvider;
    if (config.credentialProviderType === "mongo") {
      const masterKey = loadMasterKeyFromFile(config.masterKeyFilePath!);
      const mongoCreds = new MongoCredentialProvider(db, masterKey, config.allowedSshAuthMethods);
      await mongoCreds.initIndexes();
      credentialProvider = mongoCreds;
    } else {
      if (process.env.NODE_ENV === "production") {
        throw new Error("Configurazione non sicura: il provider in-memory non è consentito in ambiente di produzione (NODE_ENV=production).");
      }
      credentialProvider = new InMemoryCredentialProvider(config.allowedSshAuthMethods);
    }

<<<<<<< Updated upstream
    const userRepository = new MongoUserRepository(db);
    await userRepository.initIndexes();

    const server = createServer(config, logger, {
      robotRepository,
      auditRepository,
      credentialProvider,
      userRepository,
      db,
    });
=======
    const server = createServer(config, logger, { robotRepository, auditRepository, userRepository, credentialProvider, db });
>>>>>>> Stashed changes

    server.addHook("onClose", async () => {
      await mongoClient?.close();
    });

    const port = Number(process.env["MOLIRIS_SERVER_PORT"]) || 8443;
    const host = process.env["MOLIRIS_SERVER_HOST"] || "0.0.0.0";

    await server.listen({ port, host });

    logger.info(`Backend HTTPS avviato con successo su ${host}:${port}`);
    (server as any).monitoringService?.startPolling();
  } catch (error: any) {
    logger.error("Errore inizializzazione backend", error.message);

    if (mongoClient) {
      await mongoClient.close().catch(() => {});
    }

    process.exit(1);
  }
}
