// Requisiti soddisfatti: RNF-SEC-001, SRS §2.4 vincolo 3, §5.1, §5.2, RF-AUTH-001..006

import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyReply } from "fastify";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { type SystemConfiguration, loadAndValidateConfig } from "../config/configuration.ts";
import { loadConfig, registerAppConfig, type AppConfig } from "../src/config/index.ts";
import { assertMongoCredentialsInProduction, resolveMongoConfig } from "../config/mongodb.ts";
import { MolirisLogger } from "../logging/logger.ts";
import { SessionManager } from "./auth/session-manager.ts";
import { type UserRepository, InMemoryUserRepository, MongoUserRepository } from "./auth/user-repository.ts";
import { type AuditRepository, InMemoryAuditRepository, MongoAuditRepository } from "../storage/audit-repository.ts";
import { AuditOperation } from "../storage/audit-models.ts";
import { type RobotRepository, InMemoryRobotRepository, MongoRobotRepository } from "../storage/robot-repository.ts";
import {
  type ClientRepository,
  type PlantRepository,
  InMemoryClientRepository,
  InMemoryPlantRepository,
  MongoClientRepository,
  MongoPlantRepository,
} from "../storage/client-plant-repository.ts";
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
import multipart from "@fastify/multipart";
import { TerminalService } from "./terminal/terminal-service.ts";
import { registerTerminalRoutes } from "./terminal/terminal-routes.ts";
import { RemoteFilesystemService } from "./remote-fs/remote-fs-service.ts";
import { registerRemoteFsRoutes } from "./remote-fs/remote-fs-routes.ts";
import { TransferService } from "./transfer/transfer-service.ts";
import { registerTransferRoutes } from "./transfer/transfer-routes.ts";
import { type TelemetryRepository, MongoTelemetryRepository, InMemoryTelemetryRepository } from "../storage/telemetry-repository.ts";
import { setPathAuthorizationAuditRepository } from "./auth/path-authorization.ts";
import { PhysicalFileLogger } from "./logging/physical-file-logger.ts";
import { registerLogRoutes } from "./logging/log-routes.ts";
import { BatchTransferManager } from "./transfer/batch-transfer-manager.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function resolveFrontendDistDir(serverDirectory = __dirname): string {
  const candidates = [
    path.resolve(serverDirectory, "../dist/frontend"),
    path.resolve(serverDirectory, "../frontend"),
  ];
  return candidates.find((candidate) => fs.existsSync(path.join(candidate, "index.html"))) ?? candidates[0];
}

export interface ServerDependencies {
  sessionManager?: SessionManager;
  userRepository?: UserRepository;
  auditRepository?: AuditRepository;
  robotRepository?: RobotRepository;
  clientRepository?: ClientRepository;
  plantRepository?: PlantRepository;
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
  telemetryRepository?: TelemetryRepository;
  physicalFileLogger?: PhysicalFileLogger;
  batchTransferManager?: BatchTransferManager;
  roleMapping?: RolePermissionMapping;
  db?: any;
  appConfig?: AppConfig;
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

  // Registrazione e validazione configurazione dell'applicazione conforme all'SRS §2
  const appConfig = deps.appConfig || loadConfig();
  registerAppConfig(app, appConfig);

  // Sincronizza i parametri vincolanti di config.json su SystemConfiguration se non già valorizzati esplicitamente (SRS §2)
  if (config.pollingIntervalSeconds === undefined && appConfig.fleetPollingIntervalSeconds !== undefined) {
    config.pollingIntervalSeconds = appConfig.fleetPollingIntervalSeconds;
  }
  if (config.maxConcurrentTransfersServer === undefined && appConfig.maxConcurrentTransfers !== undefined) {
    config.maxConcurrentTransfersServer = appConfig.maxConcurrentTransfers;
  }
  if (config.sshConnectionTimeoutMs === undefined && appConfig.sshConnectTimeoutSeconds !== undefined) {
    config.sshConnectionTimeoutMs = appConfig.sshConnectTimeoutSeconds * 1000;
  }
  if (config.transferIdleTimeoutMs === undefined && appConfig.transferTimeoutMinutes !== undefined) {
    config.transferIdleTimeoutMs = appConfig.transferTimeoutMinutes * 60 * 1000;
  }
  if (config.inactiveSessionTimeoutMinutes === undefined && appConfig.sessionInactivityTimeoutMinutes !== undefined) {
    config.inactiveSessionTimeoutMinutes = appConfig.sessionInactivityTimeoutMinutes;
  }
  if (config.sessionInactivityWarningMinutes === undefined && appConfig.sessionInactivityWarningMinutes !== undefined) {
    config.sessionInactivityWarningMinutes = appConfig.sessionInactivityWarningMinutes;
  }
  if (config.terminalSessionTimeoutMinutes === undefined && appConfig.sshTerminalActiveTimeoutMinutes !== undefined) {
    config.terminalSessionTimeoutMinutes = appConfig.sshTerminalActiveTimeoutMinutes;
  }
  if (config.maxBulkUploadFiles === undefined && appConfig.bulkUploadConfig?.maxConcurrentFiles !== undefined) {
    config.maxBulkUploadFiles = appConfig.bulkUploadConfig.maxConcurrentFiles;
  }
  if (config.defaultOperatorAllowedPaths === undefined && appConfig.bulkUploadConfig?.allowedSubPaths !== undefined) {
    config.defaultOperatorAllowedPaths = appConfig.bulkUploadConfig.allowedSubPaths;
  }
  if (config.transferChunkSizeBytes === undefined && appConfig.bulkUploadConfig?.chunkSizeBytes !== undefined) {
    config.transferChunkSizeBytes = appConfig.bulkUploadConfig.chunkSizeBytes;
  }
  if (config.maxFileSizeBytes === undefined && appConfig.maxFileUploadBytes !== undefined) {
    config.maxFileSizeBytes = appConfig.maxFileUploadBytes;
  }

  app.get("/api/config/public", async (_request, reply) => {
    const allowedSubPaths = (appConfig as any).bulkUploadConfig?.allowedSubPaths ?? ["/"];
    return reply.status(200).send({
      sessionInactivityTimeoutMinutes:
        (config as any)?.inactiveSessionTimeoutMinutes ??
        (appConfig as any)?.sessionInactivityTimeoutMinutes ??
        (appConfig as any)?.inactiveSessionTimeoutMinutes ??
        30,
      sessionInactivityWarningMinutes:
        (config as any)?.sessionInactivityWarningMinutes ??
        (appConfig as any)?.sessionInactivityWarningMinutes ??
        5,
      sshTerminalActiveTimeoutMinutes:
        (appConfig as any)?.sshTerminalActiveTimeoutMinutes ?? 15,
      terminalSessionWarningMinutes:
        (config as any)?.sshTerminalWarningMinutes ??
        (appConfig as any)?.sshTerminalWarningMinutes ??
        (appConfig as any)?.terminalSessionWarningMinutes ??
        5,
      maxConcurrentWebUsers: (appConfig as any).maxConcurrentWebUsers ?? 10,
      maxConcurrentTerminalsPerRobot: (appConfig as any).maxConcurrentTerminalsPerRobot ?? 1,
      maxSessionsPerAccount: (appConfig as any).maxSessionsPerAccount ?? (appConfig as any).futureExtensions?.maxSessionsPerAccount ?? 1,
      fleetPollingIntervalSeconds: appConfig.fleetPollingIntervalSeconds ?? 5,
      maxConcurrentTransfers: appConfig.maxConcurrentTransfers ?? 5,
      sshConnectTimeoutSeconds: appConfig.sshConnectTimeoutSeconds ?? 15,
      transferTimeoutMinutes: appConfig.transferTimeoutMinutes ?? 30,
      maxFileUploadBytes: appConfig.maxFileUploadBytes,
      futureExtensions: appConfig.futureExtensions,
      activeConfigFile: (appConfig as any).loadedConfigPath ? path.basename((appConfig as any).loadedConfigPath) : "defaults",
      activeConfigPath: (appConfig as any).loadedConfigPath ?? null,
      allowedPaths: allowedSubPaths,
      bulkUploadConfig: {
        maxConcurrentFiles: (appConfig as any).bulkUploadConfig?.maxConcurrentFiles ?? 5,
        chunkSizeBytes: (appConfig as any).bulkUploadConfig?.chunkSizeBytes ?? 1024 * 1024,
        allowedSubPaths: allowedSubPaths,
      },
    });
  });

  // Intestazioni difensive globali per il frontend.
  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    reply.header(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' wss:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'"
    );
    if (process.env.NODE_ENV === "production") {
      reply.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
    return payload;
  });

  // SameSite=Strict limita le richieste cross-site, ma non i sottodomini dello
  // stesso site. Per richieste mutative autenticate via cookie imponiamo anche
  // un controllo Origin esatto, mantenendo bearer token e client non-browser.
  app.addHook("onRequest", async (request, reply) => {
    const isMutation = !["GET", "HEAD", "OPTIONS"].includes(request.method);
    const hasSessionCookie = /(?:^|;\s*)__Host-moliris_session=[^;]+/.test(request.headers.cookie || "");
    if (!isMutation || !hasSessionCookie || !request.url.startsWith("/api/")) return;

    const origin = request.headers.origin;
    let originMatches = false;
    if (origin && request.headers.host) {
      try {
        const socketEncrypted = Boolean((request.raw?.socket as any)?.encrypted);
        const protoHeader = request.headers["x-forwarded-proto"];
        const isHttps = socketEncrypted || protoHeader === "https" || (request as any).protocol === "https";
        const expectedOrigin = new URL(`${isHttps ? "https" : "http"}://${request.headers.host}`).origin;
        const parsedOrigin = new URL(origin);
        originMatches =
          parsedOrigin.origin === expectedOrigin ||
          (parsedOrigin.host === request.headers.host && (parsedOrigin.protocol === "https:" || parsedOrigin.protocol === "http:"));
      } catch {
        originMatches = false;
      }
    }
    if (!originMatches) {
      return reply.status(403).send({
        code: "CSRF_ORIGIN_REJECTED",
        message: "Origine della richiesta non consentita.",
      });
    }
  });

  // Registrazione supporto WebSocket per canale terminale interattivo (RF-SSH-004, §5.4)
  app.register(websocket);

  // Supporto upload multipart in streaming per caricamento massivo (RF-TRF-001, RNF-PERF-001, SRS §2)
  app.register(multipart, {
    limits: {
      fileSize: appConfig.maxFileUploadBytes,
      files: appConfig.bulkUploadConfig.maxConcurrentFiles || config.maxBulkUploadFiles || 20,
      fields: 10,
      fieldSize: 64 * 1024,
    },
  });

  // Dipendenze di autenticazione e sicurezza
  const sessionManager = deps.sessionManager || new SessionManager(
    appConfig.sessionInactivityTimeoutMinutes,
    config.sessionAbsoluteMaxMinutes
  );
  const userRepository = deps.userRepository || new InMemoryUserRepository();
  const auditRepository = deps.auditRepository || new InMemoryAuditRepository();
  const roleMapping = deps.roleMapping || DEFAULT_ROLE_PERMISSIONS;

  // Inizializzazione guardia percorsi operatore con repository di audit (Requisito #3)
  setPathAuthorizationAuditRepository(auditRepository);

  // Servizio di logging su file fisico (Requisito #8) e gestore batch trasferimenti (Requisito #9)
  const physicalFileLogger = deps.physicalFileLogger || new PhysicalFileLogger(process.env.MOLIRIS_LOGS_DIR);
  const batchTransferManager = deps.batchTransferManager || new BatchTransferManager(physicalFileLogger);

  const authMiddleware = new AuthMiddleware(
    sessionManager,
    userRepository,
    auditRepository,
    logger,
    roleMapping
  );

  // Dipendenze di persistenza e filesystem
  const robotRepository = deps.robotRepository || new InMemoryRobotRepository();
  const serverFsService = deps.serverFsService || new ServerFilesystemService(
    config.serverFilesystemRoot,
    auditRepository,
    logger,
    config.defaultOperatorAllowedPaths
  );

  // Dipendenze di connessione comune verso i robot (Prompt 5, vincolo 2.4 punto 4)
  let credentialProvider = deps.credentialProvider;
  if (!credentialProvider) {
    if (config.credentialProviderType === "mongo") {
      if (deps.db) {
        const masterKey = loadMasterKeyFromFile(config.masterKeyFilePath!);
        credentialProvider = new MongoCredentialProvider(deps.db, masterKey, config.allowedSshAuthMethods);
      } else {
        throw new Error("Configurazione non valida: credentialProviderType='mongo' richiede un'istanza di database MongoDB attiva (deps.db). Fallback in memoria vietato da vincolo di sicurezza.");
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

  // Servizio di gestione flotta (Prompt 6, RF-ROB-001..014, RF-05)
  const clientRepository =
    deps.clientRepository || (deps.db ? new MongoClientRepository(deps.db) : new InMemoryClientRepository());
  const plantRepository =
    deps.plantRepository || (deps.db ? new MongoPlantRepository(deps.db) : new InMemoryPlantRepository());

  // Servizio di terminale remoto interattivo PTY (Prompt 8, RF-SSH-001..008, §5.4, §6.4)
  const terminalService = deps.terminalService || new TerminalService(
    config,
    robotRepository,
    auditRepository,
    connectionManager,
    sessionManager,
    roleMapping,
    logger,
    undefined,
    {
      maxConcurrentPerRobot: appConfig.maxConcurrentTerminalsPerRobot,
      sessionTimeoutMinutes: appConfig.sshTerminalActiveTimeoutMinutes,
    }
  );

  const fleetService = deps.fleetService || new FleetService(
    config,
    robotRepository,
    auditRepository,
    serverFsService,
    credentialProvider,
    hostKeyVerifier,
    connectionManager,
    logger,
    roleMapping,
    terminalService,
    clientRepository,
    plantRepository
  );

  // Servizio di monitoraggio remoto (Prompt 7, RF-MON-001..006, §5.3, §11.4)
  const telemetryRepository =
    deps.telemetryRepository || (deps.db ? new MongoTelemetryRepository(deps.db) : new InMemoryTelemetryRepository());
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
    logger,
    telemetryRepository
  );

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
    roleMapping,
    undefined,
    connectionManager
  );

  // Collegamento verificatore trasferimenti attivi per terminalService e sessionManager (Prompt #4, Requisito #4)
  transferService.setPhysicalFileLogger(physicalFileLogger);
  sessionManager.setActiveTransfersProvider((userId) => transferService.countActiveTransfersForUser(userId));

  terminalService.setActiveTransferChecker((sessionId, userId) => {
    const bySession = sessionId ? transferService.getActiveTransfersCountForSession(sessionId) : 0;
    if (bySession > 0) return bySession;
    return userId ? transferService.getActiveTransfersCountForUser(userId) : 0;
  });

  // Tracciamento audit per scadenza automatica sessione e sospensione per trasferimenti (Prompt #4)
  sessionManager.onSessionExpired((session, reason) => {
    auditRepository.record({
      userId: session.username,
      operation: AuditOperation.SESSION_IDLE_TIMEOUT,
      outcome: "SUCCESS",
      timestamp: new Date(),
      details: { context: "sessione", reason },
    }).catch(() => {});
  });

  sessionManager.onSessionSuspendedForTransfer((sessionId, userId, activeTransfers, context) => {
    const session = sessionManager.getSession(sessionId);
    auditRepository.record({
      userId: session?.username || userId,
      operation: AuditOperation.SESSION_TRANSFER_SUSPEND,
      outcome: "SUCCESS",
      timestamp: new Date(),
      details: { context, activeTransfers, reason: "Inactivity timeout suspended due to active file transfers" },
    }).catch(() => {});
  });

  // Registrazione endpoint di autenticazione e autorizzazione (RF-AUTH-001..006, Requisito #4, Requisito #8)
  registerAuthRoutes(
    app,
    sessionManager,
    userRepository,
    auditRepository,
    authMiddleware,
    logger,
    physicalFileLogger
  );

  // Registrazione endpoint di consultazione e download log su file fisico (Requisito #8)
  registerLogRoutes(app, physicalFileLogger, authMiddleware);

  // Registrazione endpoint filesystem server (RF-SRVFS-002, RF-SRVFS-005)
  registerServerFsRoutes(
    app,
    serverFsService,
    robotRepository,
    sessionManager,
    authMiddleware,
    roleMapping,
    transferService
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

  // Registrazione endpoint servizio di trasferimento file (RF-TRF-001..014, §5.5, §6.5..6.7, Requisito #9)
  registerTransferRoutes(
    app,
    transferService,
    robotRepository,
    sessionManager,
    authMiddleware,
    roleMapping,
    batchTransferManager
  );

  // Rilascio risorse, arresto polling periodico e chiusura sessioni alla chiusura del server (RNF-REL-005)
  app.decorate("monitoringService", monitoringService);
  app.decorate("terminalService", terminalService);
  app.decorate("remoteFsService", remoteFsService);
  app.decorate("transferService", transferService);
  app.decorate("physicalFileLogger", physicalFileLogger);
  app.decorate("batchTransferManager", batchTransferManager);
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

  // Servizio statico del frontend client React compatibile Google Chrome (§2.5, §5.1, RNF-UX-002/003)
  const distFrontendDir = resolveFrontendDistDir();

  const serveIndex = async (_request: FastifyRequest, reply: FastifyReply) => {
    const indexPath = path.join(distFrontendDir, "index.html");
    if (fs.existsSync(indexPath)) {
      reply
        .header("Cache-Control", "no-cache, no-store, must-revalidate")
        .header("Pragma", "no-cache")
        .header("Expires", "0")
        .type("text/html")
        .send(fs.readFileSync(indexPath));
    } else {
      reply.status(404).send("Frontend React non trovato. Eseguire 'npm run build:client'.");
    }
  };

  app.get("/", serveIndex);
  app.get("/index.html", serveIndex);

  app.get("/react", async (_request, reply) => {
    return reply.redirect("/");
  });

  app.get("/assets/:filename", async (request, reply) => {
    const { filename } = request.params as { filename: string };
    if (!/^[a-zA-Z0-9_.-]+$/.test(filename)) {
      return reply.status(404).send("Asset non valido");
    }
    const filePath = path.join(distFrontendDir, "assets", filename);
    if (fs.existsSync(filePath)) {
      reply.header("Cache-Control", "public, max-age=31536000, immutable");
      if (filename.endsWith(".js")) reply.type("application/javascript");
      else if (filename.endsWith(".css")) reply.type("text/css");
      else if (filename.endsWith(".svg")) reply.type("image/svg+xml");
      else if (filename.endsWith(".png")) reply.type("image/png");
      else if (filename.endsWith(".webp")) reply.type("image/webp");
      else if (filename.endsWith(".ico")) reply.type("image/x-icon");
      return reply.send(fs.readFileSync(filePath));
    }
    return reply.status(404).send("Asset non trovato");
  });

  return app;
}

export function isMainModule(): boolean {
  if (!process.argv[1]) return false;
  const script = process.argv[1].replace(/\\/g, "/");
  return script.endsWith("server.ts") || script.endsWith("server.js");
}

export async function startServer(): Promise<void> {
  const logger = new MolirisLogger();
  let mongoClient: MongoClient | undefined;

  try {
    // Caricamento e validazione rigida della configurazione conforme all'SRS §2
    const appConfig = loadConfig();
    logger.info(`[CONFIG] File di configurazione applicativo caricato: ${appConfig.loadedConfigPath || "valori predefiniti"}`);
    logger.info(`[CONFIG] Parametri attivi: maxConcurrentWebUsers=${appConfig.maxConcurrentWebUsers}, maxSessionsPerAccount=${appConfig.maxSessionsPerAccount ?? appConfig.futureExtensions?.maxSessionsPerAccount ?? 1}, maxConcurrentTerminalsPerRobot=${appConfig.maxConcurrentTerminalsPerRobot}, sessionTimeout=${appConfig.sessionInactivityTimeoutMinutes}m, sessionWarning=${appConfig.sessionInactivityWarningMinutes}m`);
    const config = loadAndValidateConfig(process.env);

    // Sincronizza i parametri vincolanti di config.json su SystemConfiguration
    if (appConfig.fleetPollingIntervalSeconds !== undefined && (!process.env["MOLIRIS_POLLING_INTERVAL_SEC"])) {
      config.pollingIntervalSeconds = appConfig.fleetPollingIntervalSeconds;
    }
    if (appConfig.maxConcurrentTransfers !== undefined && (!process.env["MOLIRIS_MAX_TRF_SERVER"])) {
      config.maxConcurrentTransfersServer = appConfig.maxConcurrentTransfers;
    }
    if (appConfig.sshConnectTimeoutSeconds !== undefined && (!process.env["MOLIRIS_SSH_CONNECTION_TIMEOUT_MS"] && !process.env["MOLIRIS_SSH_TIMEOUT_MS"])) {
      config.sshConnectionTimeoutMs = appConfig.sshConnectTimeoutSeconds * 1000;
    }
    if (appConfig.transferTimeoutMinutes !== undefined && (!process.env["MOLIRIS_TRANSFER_IDLE_TIMEOUT_MS"])) {
      config.transferIdleTimeoutMs = appConfig.transferTimeoutMinutes * 60 * 1000;
    }
    if (appConfig.sessionInactivityTimeoutMinutes !== undefined && (!process.env["MOLIRIS_SESSION_TIMEOUT_MIN"])) {
      config.inactiveSessionTimeoutMinutes = appConfig.sessionInactivityTimeoutMinutes;
    }
    if (appConfig.sessionInactivityWarningMinutes !== undefined && (!process.env["MOLIRIS_SESSION_WARNING_MIN"])) {
      config.sessionInactivityWarningMinutes = appConfig.sessionInactivityWarningMinutes;
    }
    if (appConfig.sshTerminalActiveTimeoutMinutes !== undefined && (!process.env["MOLIRIS_TERMINAL_SESSION_TIMEOUT_MIN"])) {
      config.terminalSessionTimeoutMinutes = appConfig.sshTerminalActiveTimeoutMinutes;
    }
    if (appConfig.bulkUploadConfig?.maxConcurrentFiles !== undefined) {
      config.maxBulkUploadFiles = appConfig.bulkUploadConfig.maxConcurrentFiles;
    }
    if (appConfig.bulkUploadConfig?.allowedSubPaths !== undefined) {
      config.defaultOperatorAllowedPaths = appConfig.bulkUploadConfig.allowedSubPaths;
    }
    if (appConfig.bulkUploadConfig?.chunkSizeBytes !== undefined) {
      config.transferChunkSizeBytes = appConfig.bulkUploadConfig.chunkSizeBytes;
    }
    if (appConfig.maxFileUploadBytes !== undefined) {
      config.maxFileSizeBytes = appConfig.maxFileUploadBytes;
    }
    const mongoConfig = resolveMongoConfig();
    assertMongoCredentialsInProduction(mongoConfig.uri);
    mongoClient = new MongoClient(mongoConfig.uri);
    await mongoClient.connect();

    const db = mongoClient.db(mongoConfig.dbName);
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

    const hostKeyVerifier = new DefaultHostKeyVerifier();
    const connectionLimits = {
      maxConcurrentPerUser: config.maxConcurrentTransfersPerUser,
      maxConcurrentPerRobot: config.maxConcurrentTransfersPerRobot,
      maxConcurrentServer: config.maxConcurrentTransfersServer,
      connectionTimeoutMs: config.sshConnectionTimeoutMs,
    };
    const connectionManager = new RobotConnectionManager(
      credentialProvider,
      hostKeyVerifier,
      connectionLimits,
      logger,
      auditRepository
    );

    const clientRepository = new MongoClientRepository(db);
    await clientRepository.initIndexes();

    const plantRepository = new MongoPlantRepository(db);
    await plantRepository.initIndexes();

    const server = createServer(config, logger, {
      robotRepository,
      clientRepository,
      plantRepository,
      auditRepository,
      credentialProvider,
      userRepository,
      connectionManager,
      db,
      appConfig,
    });

    server.addHook("onClose", async () => {
      await mongoClient?.close();
    });

    const port = Number(process.env["MOLIRIS_SERVER_PORT"]) || 8443;
    const host = process.env["MOLIRIS_SERVER_HOST"] || "0.0.0.0";

    await server.listen({ port, host });

    logger.info(`Backend HTTPS avviato con successo su ${host}:${port}`);
    (server as any).monitoringService?.startPolling();

    // RNF-REL-005: Chiusura ordinata su ricezione segnali SIGTERM e SIGINT
    let shuttingDown = false;
    const shutdown = async (signal: string) => {
      if (shuttingDown) return;
      shuttingDown = true;
      logger.info(`Ricevuto segnale ${signal}: avvio chiusura ordinata (RNF-REL-005)...`);
      try {
        await server.close();
        (server as any).terminalService?.closeAll("SERVICE_SHUTDOWN");
        connectionManager.closeAll();
        if (mongoClient) {
          await mongoClient.close();
        }
        logger.info("Chiusura ordinata delle risorse completata con successo.");
        process.exit(0);
      } catch (err: any) {
        logger.error("Errore durante la chiusura ordinata", err?.message);
        process.exit(1);
      }
    };

    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));
  } catch (error: any) {
    logger.error("Errore inizializzazione backend", error.message);

    if (mongoClient) {
      await mongoClient.close().catch(() => {});
    }

    process.exit(1);
  }
}

// Avvio del server se eseguito come modulo principale
if (isMainModule()) {
  startServer();
}
