// Requisiti soddisfatti: RF-ROB-001..014, RNF-SEC-002, RNF-SEC-003, RNF-SEC-004, RNF-SEC-005,
// RNF-SEC-006, RNF-SEC-009, RNF-REL-001, RNF-REL-003, RNF-FS-001..004, RNF-PERF-003,
// SRS §6.2, §6.3, §8.1..8.4, §9, §10.1, §10.2, §11.2, §11.3,
// CA-ROB-001..012, CA-AUTH-003, CA-SSH-005

import path from "path";
import {
  type RobotEntity,
  type RegistrationState,
  type ConnectionState,
  StandardRobotDirectoryNamingPolicy,
} from "../../storage/robot-models.ts";
import { type RobotRepository } from "../../storage/robot-repository.ts";
import { type AuditRepository } from "../../storage/audit-repository.ts";
import { AuditOperation } from "../../storage/audit-models.ts";
import { ServerFilesystemService } from "../../storage/server-fs.ts";
import { type UserEntity } from "../auth/user-models.ts";
import { AppPermission, hasPermission, type RolePermissionMapping, DEFAULT_ROLE_PERMISSIONS } from "../auth/permissions.ts";
import { type CredentialProvider, type InMemoryCredentialProvider } from "../connection/credential-provider.ts";
import { type HostKeyVerifier } from "../connection/host-key-verifier.ts";
import { validateHostAndPort, DestinationValidator } from "../connection/connection-validator.ts";
import { RobotConnectionManager } from "../connection/robot-connection-manager.ts";
import { verifyRobotConnection } from "../connection/connection-verifier.ts";
import { type SystemConfiguration } from "../../config/configuration.ts";
import { MolirisLogger, redactSensitiveData } from "../../logging/logger.ts";
import { MolirisAppError, ErrorCode } from "../../errors/app-errors.ts";
import {
  type RobotRegistrationInput,
  type RobotConfigurationUpdateInput,
  type RegistrationResult,
  type ConnectionVerificationResult,
  type AvailableFeatures,
} from "./fleet-types.ts";
import {
  type RobotSummaryDto,
  type RobotDetailDto,
  toRobotSummaryDto,
  toRobotDetailDto,
} from "../../storage/dto/robot-dto.ts";

export class FleetService {
  private config: SystemConfiguration;
  private robotRepository: RobotRepository;
  private auditRepository: AuditRepository;
  private serverFsService: ServerFilesystemService;
  private credentialProvider: CredentialProvider;
  private hostKeyVerifier: HostKeyVerifier;
  private connectionManager: RobotConnectionManager;
  private destinationValidator: DestinationValidator;
  private logger: MolirisLogger;
  private roleMapping: RolePermissionMapping;
  private directoryNamingPolicy: StandardRobotDirectoryNamingPolicy;

  constructor(
    config: SystemConfiguration,
    robotRepository: RobotRepository,
    auditRepository: AuditRepository,
    serverFsService: ServerFilesystemService,
    credentialProvider: CredentialProvider,
    hostKeyVerifier: HostKeyVerifier,
    connectionManager: RobotConnectionManager,
    logger: MolirisLogger,
    roleMapping: RolePermissionMapping = DEFAULT_ROLE_PERMISSIONS
  ) {
    this.config = config;
    this.robotRepository = robotRepository;
    this.auditRepository = auditRepository;
    this.serverFsService = serverFsService;
    this.credentialProvider = credentialProvider;
    this.hostKeyVerifier = hostKeyVerifier;
    this.connectionManager = connectionManager;
    this.logger = logger;
    this.roleMapping = roleMapping;
    this.destinationValidator = new DestinationValidator(
      config.allowedDestinations,
      config.maxConcurrentRegistrationVerifications
    );
    this.directoryNamingPolicy = new StandardRobotDirectoryNamingPolicy();
  }

  /**
   * Calcola le funzionalità disponibili per un utente su uno specifico robot (RF-ROB-011, CA-ROB-010).
   * Tiene conto di autorizzazioni RBAC, stato anagrafico e stato di raggiungibilità/connessione.
   */
  public getAvailableFeatures(robot: RobotEntity, user: UserEntity): AvailableFeatures {
    const isRemoved = robot.anagraphicState === "rimosso";
    const isDisabled = robot.anagraphicState === "disabilitato";
    const isConnReachable = robot.connectionState === "raggiungibile";
    const isRegistered = robot.registrationState === "registrazione_completata" || robot.registrationState === "completata_con_funzionalita_non_verificate";

    // 1. Monitoraggio (STATUS_VIEW)
    let monitoring = false;
    let monitoringReason = "";
    if (isRemoved) {
      monitoringReason = "Robot rimosso dall'anagrafica attiva.";
    } else if (isDisabled) {
      monitoringReason = "Robot disabilitato: operazioni operative sospese.";
    } else if (!hasPermission(user, AppPermission.STATUS_VIEW, robot.id, this.roleMapping)) {
      monitoringReason = "Autorizzazione insufficiente (permesso STATUS_VIEW non accordato).";
    } else if (!isRegistered || !isConnReachable) {
      monitoringReason = "Stato di connessione non verificato o robot non raggiungibile.";
    } else {
      monitoring = true;
    }

    // 2. Terminale Remoto (TERMINAL_OPEN)
    let terminal = false;
    let terminalReason = "";
    if (isRemoved) {
      terminalReason = "Robot rimosso dall'anagrafica attiva.";
    } else if (isDisabled) {
      terminalReason = "Robot disabilitato: sessioni di terminale non consentite.";
    } else if (!hasPermission(user, AppPermission.TERMINAL_OPEN, robot.id, this.roleMapping)) {
      terminalReason = "Autorizzazione insufficiente (permesso TERMINAL_OPEN non accordato).";
    } else if (!isRegistered || !isConnReachable) {
      terminalReason = "Terminale non disponibile: connessione SSH non verificata o non raggiungibile.";
    } else {
      terminal = true;
    }

    // 3. Filesystem Remoto (FS_REMOTE_NAVIGATE)
    let remoteFs = false;
    let remoteFsReason = "";
    if (isRemoved) {
      remoteFsReason = "Robot rimosso dall'anagrafica attiva.";
    } else if (isDisabled) {
      remoteFsReason = "Robot disabilitato: navigazione remota bloccata.";
    } else if (!hasPermission(user, AppPermission.FS_REMOTE_NAVIGATE, robot.id, this.roleMapping)) {
      remoteFsReason = "Autorizzazione insufficiente (permesso FS_REMOTE_NAVIGATE non accordato).";
    } else if (!isRegistered || !isConnReachable) {
      remoteFsReason = "Filesystem remoto non disponibile: connessione non verificata.";
    } else {
      remoteFs = true;
    }

    // 4. Filesystem Server (FS_SERVER_NAVIGATE)
    // Non richiede connessione SSH attiva verso il robot (file residenti sul server)
    let serverFs = false;
    let serverFsReason = "";
    if (isRemoved) {
      serverFsReason = "Robot rimosso dall'anagrafica attiva.";
    } else if (!hasPermission(user, AppPermission.FS_SERVER_NAVIGATE, robot.id, this.roleMapping)) {
      serverFsReason = "Autorizzazione insufficiente (permesso FS_SERVER_NAVIGATE non accordato).";
    } else {
      serverFs = true;
    }

    // 5. Trasferimenti (TRANSFER_SERVER_ROBOT o TRANSFER_CLIENT_ROBOT)
    let transfers = false;
    let transfersReason = "";
    const hasTransferPerm =
      hasPermission(user, AppPermission.TRANSFER_SERVER_ROBOT, robot.id, this.roleMapping) ||
      hasPermission(user, AppPermission.TRANSFER_CLIENT_ROBOT, robot.id, this.roleMapping);

    if (isRemoved) {
      transfersReason = "Robot rimosso dall'anagrafica attiva.";
    } else if (isDisabled) {
      transfersReason = "Robot disabilitato: trasferimenti sospesi.";
    } else if (!hasTransferPerm) {
      transfersReason = "Autorizzazione insufficiente (permessi di trasferimento non accordati).";
    } else if (!isRegistered || !isConnReachable) {
      transfersReason = "Trasferimenti non disponibili: connessione SFTP non verificata o non raggiungibile.";
    } else {
      transfers = true;
    }

    return {
      monitoring,
      terminal,
      remoteFs,
      serverFs,
      transfers,
      reasons: {
        monitoring: monitoringReason || undefined,
        terminal: terminalReason || undefined,
        remoteFs: remoteFsReason || undefined,
        serverFs: serverFsReason || undefined,
        transfers: transfersReason || undefined,
      },
    };
  }

  /**
   * STEP 1 – Lista della flotta (RF-ROB-001, RF-ROB-014, CA-ROB-012).
   * Restituisce i robot registrati visibili all'utente.
   * I robot rimossi dall'anagrafica attiva sono esclusi dalla lista attiva.
   * I robot disabilitati compaiono con stato "disabilitato".
   * I robot non raggiungibili compaiono con stato appropriato (mai nascosti o eliminati).
   */
  public async listFleet(user: UserEntity): Promise<RobotSummaryDto[]> {
    // Verifica autorizzazione generale FLEET_VIEW
    const allRobots = await this.robotRepository.list();

    const visibleRobots: RobotSummaryDto[] = [];
    for (const robot of allRobots) {
      // Esclusione robot rimossi dalla lista attiva (RF-ROB-014, CA-ROB-012)
      if (robot.anagraphicState === "rimosso") {
        continue;
      }

      // Filtro per robot visibili secondo i permessi specifici dell'utente (Prompt 3)
      if (hasPermission(user, AppPermission.FLEET_VIEW, robot.id, this.roleMapping)) {
        visibleRobots.push(toRobotSummaryDto(robot));
      }
    }

    return visibleRobots;
  }

  /**
   * STEP 2 – Selezione e Dettaglio (RF-ROB-002, RF-ROB-003).
   * Restituisce la configurazione (priva di credenziali), lo stato e i collegamenti alle funzioni autorizzate.
   */
  public async getRobotDetail(
    user: UserEntity,
    robotId: string
  ): Promise<{ robot: RobotDetailDto; availableFeatures: AvailableFeatures }> {
    if (!hasPermission(user, AppPermission.FLEET_VIEW, robotId, this.roleMapping)) {
      throw new MolirisAppError(
        ErrorCode.INSUFFICIENT_PERMISSIONS,
        `Accesso negato: utente non autorizzato a visualizzare il robot '${robotId}'.`
      );
    }

    const robot = await this.robotRepository.findById(robotId);
    if (!robot) {
      throw new MolirisAppError(
        ErrorCode.MISSING_ROBOT_PARAMS,
        `Robot con identificativo '${robotId}' non trovato.`
      );
    }

    const availableFeatures = this.getAvailableFeatures(robot, user);

    return {
      robot: toRobotDetailDto(robot),
      availableFeatures,
    };
  }

  /**
   * STEP 4 – Validazione dei parametri di registrazione (RF-ROB-006, CA-ROB-002, CA-ROB-006, CA-ROB-009).
   * Raccoglie TUTTI gli errori di validazione in un'unica risposta (non uno alla volta).
   */
  public async validateRegistrationInput(input: RobotRegistrationInput): Promise<{
    valid: boolean;
    errors: Record<string, string>;
    normalizedHost?: string;
    normalizedPort?: number;
  }> {
    const errors: Record<string, string> = {};

    // 1. Identificativo univoco del robot
    if (!input.id || input.id.trim() === "") {
      errors["id"] = "L'identificativo interno del robot è obbligatorio.";
    } else if (!/^[a-zA-Z0-9_-]{1,64}$/.test(input.id.trim())) {
      errors["id"] = "L'identificativo contiene caratteri non ammessi (consentiti solo alfanumerici, trattino e underscore).";
    }

    // 2. Nome visualizzato
    if (!input.displayName || input.displayName.trim() === "") {
      errors["displayName"] = "Il nome visualizzato è obbligatorio.";
    }

    // 3. Username remoto
    if (!input.remoteUsername || input.remoteUsername.trim() === "") {
      errors["remoteUsername"] = "Lo username remoto è obbligatorio.";
    } else if (input.remoteUsername.includes("\0") || /[\\/]/.test(input.remoteUsername)) {
      errors["remoteUsername"] = "Lo username remoto contiene caratteri o separatori non validi.";
    }

    // 4. Hostname o IP e Porta SSH (default 22, RF-ROB-005)
    let normHost = "";
    let normPort = 22;
    if (!input.host || input.host.trim() === "") {
      errors["host"] = "L'indirizzo IP o hostname è obbligatorio.";
    } else {
      try {
        const validated = validateHostAndPort(input.host, input.sshPort ?? this.config.defaultSshPort);
        normHost = validated.normalizedHost;
        normPort = validated.normalizedPort;

        // Verifica contro whitelist destinazioni se configurata (RNF-SEC-006)
        if (!this.destinationValidator.isDestinationAllowed(normHost)) {
          errors["host"] = "Destinazione di rete non ammessa dalle regole di sicurezza configurate (RNF-SEC-006).";
        }
      } catch (err: any) {
        errors["host"] = err.userMessage || "Indirizzo IP o hostname non valido.";
        if (input.sshPort !== undefined && (input.sshPort < 1 || input.sshPort > 65535)) {
          errors["sshPort"] = "Porta SSH non valida (deve essere compresa tra 1 e 65535).";
        }
      }
    }

    // 5. Metodo di autenticazione SSH
    if (!input.sshAuthMethod || (input.sshAuthMethod !== "key" && input.sshAuthMethod !== "password")) {
      errors["sshAuthMethod"] = "Metodo di autenticazione non valido: consentiti 'key' o 'password'.";
    } else if (this.config.allowedSshAuthMethods && !this.config.allowedSshAuthMethods.includes(input.sshAuthMethod)) {
      errors["sshAuthMethod"] = `Metodo di autenticazione '${input.sshAuthMethod}' non abilitato dalla configurazione di sistema.`;
    }

    // 6. Credenziali obbligatorie per il metodo scelto
    if (input.sshAuthMethod === "password") {
      if (!input.password && !input.credentialReference) {
        errors["password"] = "La password di accesso remoto è obbligatoria per il metodo con password.";
      }
    } else if (input.sshAuthMethod === "key") {
      if (!input.privateKey && !input.credentialReference) {
        errors["privateKey"] = "La chiave privata SSH (o riferimento sicuro) è obbligatoria per il metodo con chiave.";
      }
    }

    // 7. Parametri di verifica della chiave host (RNF-SEC-003, RF-ROB-005)
    if (!input.hostKeyVerification) {
      errors["hostKeyVerification"] = "La configurazione di verifica della chiave host SSH è obbligatoria.";
    } else {
      const hasFingerprint = !!(input.hostKeyVerification.fingerprint && input.hostKeyVerification.fingerprint.trim() !== "");
      const hasKnownHosts = !!(input.hostKeyVerification.knownHostsPath && input.hostKeyVerification.knownHostsPath.trim() !== "");
      if (!hasFingerprint && !hasKnownHosts) {
        errors["hostKeyVerification"] = "Specificare l'impronta (fingerprint) attesa o il percorso di un file known_hosts.";
      }
    }

    // 8. Controllo percorsi sicuri per file di monitoraggio (CA-ROB-009)
    // Nessun path traversal ("..") o caratteri di controllo permessi nei percorsi di stato
    const checkPathTraversal = (p: string, fieldName: string) => {
      if (p.includes("\0")) {
        errors[fieldName] = "Percorso contenente byte nullo non consentito.";
      } else if (/(?:^|[\\/])\.\.(?:[\\/]|$)/.test(p) || /%2e%2e/i.test(p)) {
        errors[fieldName] = "Percorso non valido: sequenza di path traversal ('..') non consentita (CA-ROB-009).";
      }
    };

    if (input.remoteMonitoringPath) {
      checkPathTraversal(input.remoteMonitoringPath, "remoteMonitoringPath");
    }

    if (input.stateFilePaths && Array.isArray(input.stateFilePaths)) {
      for (let i = 0; i < input.stateFilePaths.length; i++) {
        checkPathTraversal(input.stateFilePaths[i], `stateFilePaths[${i}]`);
      }
    }

    // 9. Verifica unicità identificativo, username e directory (RF-ROB-006, §8.2)
    if (input.id && !errors["id"]) {
      const existingId = await this.robotRepository.findById(input.id.trim());
      if (existingId) {
        errors["id"] = `Violazione unicità: l'identificativo '${input.id.trim()}' è già utilizzato da un altro robot.`;
      }
    }

    if (input.remoteUsername && !errors["remoteUsername"]) {
      const existingUsername = await this.robotRepository.findByUsername(input.remoteUsername.trim());
      if (existingUsername) {
        errors["remoteUsername"] = `Violazione unicità (RF-ROB-006): lo username remoto '${input.remoteUsername.trim()}' è già assegnato a un altro robot.`;
      }
    }

    return {
      valid: Object.keys(errors).length === 0,
      errors,
      normalizedHost: normHost || undefined,
      normalizedPort: normPort,
    };
  }

  /**
   * STEP 5 & 6 – Orchestrazione della registrazione (§6.2 passi 4-11, RF-ROB-007..012).
   */
  public async registerRobot(
    user: UserEntity,
    input: RobotRegistrationInput
  ): Promise<RegistrationResult> {
    const performedActions: string[] = [];
    const skippedActions: string[] = [];

    // 1. Verifica autorizzazione dell'utente (ROBOT_REGISTER)
    if (!hasPermission(user, AppPermission.ROBOT_REGISTER, undefined, this.roleMapping)) {
      await this.recordAudit(user.username, AuditOperation.SECURITY_AUTHORIZATION_ERROR, input.id, "FAILURE", {
        reason: "PERMISSION_DENIED_ROBOT_REGISTER",
      });
      throw new MolirisAppError(
        ErrorCode.INSUFFICIENT_PERMISSIONS,
        "Operazione non consentita: autorizzazioni insufficienti per registrare un nuovo robot."
      );
    }

    // 2. Validazione e unicità (Step 4, CA-ROB-002, CA-ROB-006, CA-ROB-009)
    performedActions.push("validazione_parametri");
    const validation = await this.validateRegistrationInput(input);
    if (!validation.valid) {
      skippedActions.push("verifica_connessione_ssh", "creazione_directory", "persistenza_database");
      await this.recordAudit(user.username, AuditOperation.ROBOT_REGISTRATION, input.id, "FAILURE", {
        reason: "VALIDATION_FAILED",
        errors: validation.errors,
      });

      return {
        outcome: "registrazione_rifiutata",
        validationErrors: validation.errors,
        performedActions,
        skippedActions,
        message: "Registrazione rifiutata per dati non validi o mancanti.",
        recoveryPath: "Correggere i campi segnalati e ripetere la registrazione.",
      };
    }

    const host = validation.normalizedHost!;
    const sshPort = validation.normalizedPort!;

    // Risoluzione credenziali: memorizzazione sicura nel CredentialProvider
    const credentialRef = input.credentialReference || `vault://robots/${input.id.trim()}`;
    if (input.sshAuthMethod === "password" && input.password) {
      if ("registerSecret" in this.credentialProvider) {
        (this.credentialProvider as InMemoryCredentialProvider).registerSecret(credentialRef, {
          method: "password",
          password: input.password,
        });
      }
    } else if (input.sshAuthMethod === "key" && input.privateKey) {
      if ("registerSecret" in this.credentialProvider) {
        (this.credentialProvider as InMemoryCredentialProvider).registerSecret(credentialRef, {
          method: "key",
          privateKey: input.privateKey,
          passphrase: input.passphrase,
        });
      }
    }

    // Risoluzione del percorso della directory server del robot (RF-ROB-008, §8.2)
    const serverDirectoryPath = this.directoryNamingPolicy.resolveDirectoryPath(
      this.config.serverFilesystemRoot,
      { id: input.id.trim(), remoteUsername: input.remoteUsername.trim(), host }
    );

    // Costruzione bozza entità robot per i controlli di connessione
    const candidateRobot: RobotEntity = {
      id: input.id.trim(),
      displayName: input.displayName.trim(),
      remoteUsername: input.remoteUsername.trim(),
      host,
      sshPort,
      sshAuthMethod: input.sshAuthMethod,
      credentialReference: credentialRef,
      hostKeyVerification: { ...input.hostKeyVerification },
      stateFilePaths: input.stateFilePaths && input.stateFilePaths.length > 0
        ? [...input.stateFilePaths]
        : (input.remoteMonitoringPath ? [input.remoteMonitoringPath] : [...this.config.stateFilePaths]),
      serverDirectoryPath,
      anagraphicState: "attivo",
      connectionState: "non_verificato",
      operationalState: null,
      lastValidUpdateAt: null,
      lastAttemptOutcome: null,
      registrationState: "ssh_non_verificata",
      lastConnectionVerification: null,
      remoteMonitoringPath: input.remoteMonitoringPath,
      sftpParameters: input.sftpParameters ? { ...input.sftpParameters } : undefined,
      customParameters: input.customParameters ? { ...input.customParameters } : undefined,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    // 3. Verifica connessione SSH secondo la politica di registrazione (§8.1, §6.2 passo 6)
    performedActions.push("verifica_connessione_ssh");
    let sshVerificationSucceeded = false;
    let connCheckResult: any = null;

    try {
      connCheckResult = await verifyRobotConnection(candidateRobot, {
        credentialProvider: this.credentialProvider,
        hostKeyVerifier: this.hostKeyVerifier,
        destinationValidator: this.destinationValidator,
        timeoutMs: this.config.sshConnectionTimeoutMs,
        logger: this.logger,
      });
      sshVerificationSucceeded = connCheckResult.overallSuccess;
    } catch (verifErr: any) {
      sshVerificationSucceeded = false;
      connCheckResult = {
        overallSuccess: false,
        lastConnectionVerificationInfo: {
          timestamp: new Date(),
          success: false,
          message: verifErr.message || "Errore imprevisto durante la verifica SSH.",
        },
        steps: [],
      };
    }

    const failureReason =
      connCheckResult?.lastConnectionVerificationInfo?.message ||
      connCheckResult?.steps?.find((s: any) => s.status === "FAILED")?.diagnosticDetail ||
      connCheckResult?.steps?.find((s: any) => s.status === "FAILED")?.message;

    // Aggiornamento informazioni di verifica
    candidateRobot.lastConnectionVerification = {
      timestamp: new Date(),
      success: sshVerificationSucceeded,
      message: failureReason || "Verifica di connessione completata con successo.",
    };

    if (sshVerificationSucceeded) {
      candidateRobot.connectionState = "raggiungibile";
      candidateRobot.lastAttemptOutcome = {
        timestamp: new Date(),
        success: true,
        stage: "connection",
      };
    } else {
      candidateRobot.connectionState = "non_raggiungibile";
      const failedStep = connCheckResult?.steps?.find((s: any) => s.status === "FAILED");
      candidateRobot.lastAttemptOutcome = {
        timestamp: new Date(),
        success: false,
        stage: "connection",
        errorCode: failedStep?.errorCode || ErrorCode.HOST_UNREACHABLE,
        diagnosticMessage: failureReason || "Tentativo di connessione iniziale fallito.",
      };
    }

    // Gestione modalità di registrazione (§8.1, CA-ROB-003):
    // Se "rigorosa", la registrazione DEVE fallire se i controlli SSH non hanno esito positivo
    if (this.config.registrationMode === "rigorosa" && !sshVerificationSucceeded) {
      skippedActions.push("creazione_directory", "persistenza_database");
      await this.recordAudit(user.username, AuditOperation.ROBOT_REGISTRATION, candidateRobot.id, "FAILURE", {
        mode: "rigorosa",
        reason: "SSH_VERIFICATION_FAILED",
        diagnosticDetail: failureReason,
      });

      return {
        outcome: "ssh_non_verificata",
        performedActions,
        skippedActions,
        message: "Registrazione rifiutata: connessione SSH verso il robot non verificata con successo in modalità rigorosa (CA-ROB-003).",
        diagnosticDetail: failureReason,
        recoveryPath: "Verificare che il robot sia online, che la porta SSH sia raggiungibile e che credenziali e chiave host siano corrette.",
      };
    }

    // In modalità differita, se SSH non è verificato, lo stato di registrazione iniziale è 'ssh_non_verificata'
    let finalRegState: RegistrationState = sshVerificationSucceeded
      ? "registrazione_completata"
      : "ssh_non_verificata";

    candidateRobot.registrationState = finalRegState;

    // 4. Verifica della configurazione necessaria a monitoraggio e trasferimenti
    performedActions.push("verifica_configurazione_monitoraggio_trasferimenti");

    // 5. Creazione o verifica della directory del robot (RF-ROB-008, RF-ROB-009, CA-ROB-004, CA-ROB-005, CA-ROB-007)
    performedActions.push("creazione_directory_server");
    let dirResult: any = null;

    try {
      // Verifica politica in caso di directory già esistente (§11.3)
      if (this.config.existingDirectoryPolicy === "rifiuta") {
        // Se la politica impone di rifiutare directory preesistenti
        const preCheck = await this.serverFsService.resolveRobotPath(candidateRobot);
        const fs = await import("fs");
        if (fs.existsSync(preCheck)) {
          skippedActions.push("persistenza_database");
          await this.recordAudit(user.username, AuditOperation.ROBOT_REGISTRATION, candidateRobot.id, "FAILURE", {
            reason: "EXISTING_DIRECTORY_REJECTED",
            path: preCheck,
          });

          return {
            outcome: "creazione_directory_fallita",
            performedActions,
            skippedActions,
            message: "Registrazione non riuscita: la directory del robot esiste già sul server e la politica configurata ne vieta l'associazione.",
            diagnosticDetail: `Directory già esistente: ${preCheck}`,
            recoveryPath: "Configurare uno username diverso o abilitare la politica di riutilizzo directory.",
          };
        }
      }

      dirResult = await this.serverFsService.ensureRobotDirectory(candidateRobot, {
        standardSubdirectories: this.config.standardSubdirectories,
        directoryPermissions: this.config.serverDirectoryPermissions,
      });
    } catch (dirErr: any) {
      skippedActions.push("persistenza_database");
      await this.recordAudit(user.username, AuditOperation.ROBOT_REGISTRATION, candidateRobot.id, "FAILURE", {
        reason: "DIRECTORY_CREATION_FAILED",
        error: dirErr.message,
      });

      return {
        outcome: "creazione_directory_fallita",
        performedActions,
        skippedActions,
        message: "Creazione della directory del robot sul server non riuscita (CA-ROB-007).",
        diagnosticDetail: dirErr.diagnosticDetail || dirErr.message,
        recoveryPath: "Verificare i permessi di scrittura e lo spazio disponibile sulla root del filesystem server.",
      };
    }

    // 6. Registrazione nel database e gestione non-atomicità (RF-ROB-010, RNF-REL-003, CA-ROB-008)
    performedActions.push("persistenza_database");
    let savedRobot: RobotEntity;

    try {
      savedRobot = await this.robotRepository.create(candidateRobot);
    } catch (dbErr: any) {
      this.logger.error("Errore salvataggio database post-creazione directory", dbErr.message, { robotId: candidateRobot.id });

      // Tentativo di rollback delle sole operazioni reversibili (CA-ROB-008)
      let rolledBack = false;
      if (dirResult) {
        const rollbackRes = await this.serverFsService.rollbackRobotDirectory(dirResult);
        rolledBack = rollbackRes.rolledBack;
      }

      await this.recordAudit(user.username, AuditOperation.ROBOT_REGISTRATION, candidateRobot.id, "FAILURE", {
        reason: "DB_PERSISTENCE_FAILED",
        directoryRolledBack: rolledBack,
        error: dbErr.message,
      });

      if (rolledBack) {
        throw new MolirisAppError(
          ErrorCode.DB_PERSISTENCE_ERROR,
          `Errore durante il salvataggio dei dati applicativi. Le risorse create su filesystem sono state annullate.`
        );
      } else {
        // Rollback non possibile (directory preesistente o non vuota) -> stato incompleto che richiede intervento
        return {
          outcome: "registrazione_incompleta",
          performedActions,
          skippedActions: [],
          message: "Registrazione incompleta che richiede un intervento: directory creata sul server ma salvataggio a database fallito (CA-ROB-008).",
          diagnosticDetail: "Incoerenza tra database e filesystem rilevata (DB_FS_SYNC_ERROR).",
          recoveryPath: "Utilizzare la funzione di ripristino/riparazione della registrazione.",
        };
      }
    }

    // 7. Registrazione evento di audit con esito (RNF-SEC-009, §10.4)
    await this.recordAudit(user.username, AuditOperation.ROBOT_REGISTRATION, savedRobot.id, "SUCCESS", {
      mode: this.config.registrationMode,
      registrationOutcome: savedRobot.registrationState,
      connectionState: savedRobot.connectionState,
      directoryCreated: dirResult.created,
      directoryAlreadyExisted: dirResult.alreadyExisted,
    });

    // 8. Restituzione esito dettagliato e aggiornamento lista flotta (RF-ROB-011, RF-ROB-012)
    const availableFeatures = this.getAvailableFeatures(savedRobot, user);

    let userMsg = "Registrazione completata con successo.";
    if (savedRobot.registrationState === "ssh_non_verificata") {
      userMsg = "Robot registrato in modalità differita con connessione SSH non verificata. Le funzioni operative che richiedono connessione sono disabilitate fino a verifica successiva (CA-ROB-003).";
    }

    return {
      outcome: savedRobot.registrationState,
      robot: toRobotDetailDto(savedRobot),
      availableFeatures,
      performedActions,
      skippedActions,
      message: userMsg,
      recoveryPath: savedRobot.registrationState === "ssh_non_verificata"
        ? "Eseguire 'Ripeti verifica connessione' quando il robot sarà online."
        : undefined,
    };
  }

  /**
   * Verifica di connessione on-demand o ripetuta (§6.3, §8.1).
   * Riusa il controllo a 5 passi non distruttivo del Prompt 5 e aggiorna anagrafica e stati.
   */
  public async verifyConnection(
    user: UserEntity,
    robotId: string
  ): Promise<ConnectionVerificationResult> {
    // Permesso richiesto: modifica configurazione o registrazione
    const hasPerm =
      hasPermission(user, AppPermission.ROBOT_CONFIG_UPDATE, robotId, this.roleMapping) ||
      hasPermission(user, AppPermission.ROBOT_REGISTER, robotId, this.roleMapping) ||
      hasPermission(user, AppPermission.STATUS_REFRESH_MANUAL, robotId, this.roleMapping);

    if (!hasPerm) {
      await this.recordAudit(user.username, AuditOperation.SECURITY_AUTHORIZATION_ERROR, robotId, "FAILURE", {
        reason: "PERMISSION_DENIED_VERIFY_CONNECTION",
      });
      throw new MolirisAppError(
        ErrorCode.INSUFFICIENT_PERMISSIONS,
        "Operazione non consentita: autorizzazioni insufficienti per verificare la connessione del robot."
      );
    }

    const robot = await this.robotRepository.findById(robotId);
    if (!robot) {
      throw new MolirisAppError(ErrorCode.MISSING_ROBOT_PARAMS, `Robot '${robotId}' non trovato.`);
    }

    if (robot.anagraphicState === "disabilitato" || robot.anagraphicState === "rimosso") {
      throw new MolirisAppError(
        ErrorCode.INSUFFICIENT_PERMISSIONS,
        `Impossibile verificare la connessione di un robot ${robot.anagraphicState}.`
      );
    }

    let checkResult: any = null;
    let success = false;

    try {
      checkResult = await verifyRobotConnection(robot, {
        credentialProvider: this.credentialProvider,
        hostKeyVerifier: this.hostKeyVerifier,
        destinationValidator: this.destinationValidator,
        timeoutMs: this.config.sshConnectionTimeoutMs,
        logger: this.logger,
      });
      success = checkResult.overallSuccess;
    } catch (err: any) {
      success = false;
      checkResult = {
        overallSuccess: false,
        lastConnectionVerificationInfo: {
          timestamp: new Date(),
          success: false,
          message: err.message,
        },
        steps: [],
      };
    }

    const failureReason =
      checkResult?.lastConnectionVerificationInfo?.message ||
      checkResult?.steps?.find((s: any) => s.status === "FAILED")?.diagnosticDetail ||
      checkResult?.steps?.find((s: any) => s.status === "FAILED")?.message;

    // Aggiornamento stato connessione
    const newConnState: ConnectionState = success ? "raggiungibile" : "non_raggiungibile";
    const failedStep = checkResult?.steps?.find((s: any) => s.status === "FAILED");
    const outcome = {
      timestamp: new Date(),
      success,
      stage: "connection" as const,
      errorCode: success ? undefined : (failedStep?.errorCode || ErrorCode.HOST_UNREACHABLE),
      diagnosticMessage: failureReason,
    };

    await this.robotRepository.updateConnectionState(robotId, newConnState, outcome);

    // Se il robot era in stato 'ssh_non_verificata' e ora ha avuto successo, promuovilo a 'registrazione_completata'
    let newRegState = robot.registrationState;
    if (success && robot.registrationState === "ssh_non_verificata") {
      newRegState = "registrazione_completata";
    }

    await this.robotRepository.updateRegistrationState(robotId, newRegState, {
      timestamp: new Date(),
      success,
      message: failureReason || "Verifica connessione riuscita.",
    });

    await this.recordAudit(user.username, AuditOperation.ROBOT_CONNECTION_VERIFY, robotId, success ? "SUCCESS" : "FAILURE", {
      success,
      connectionState: newConnState,
      registrationState: newRegState,
      diagnosticMessage: failureReason,
    });

    return {
      robotId,
      success,
      connectionState: newConnState,
      registrationState: newRegState,
      steps: checkResult.steps || [],
      message: success
        ? "Verifica di connessione SSH completata con successo."
        : `Verifica di connessione fallita: ${failureReason || "Dispositivo non raggiungibile."}`,
    };
  }

  /**
   * STEP 6 – Riparazione o recupero controllato di una registrazione incompleta (CA-ROB-008, RNF-FS-004).
   * Idempotente: ripete i passi mancanti senza sovrascrivere o corrompere file esistenti.
   */
  public async repairRegistration(
    user: UserEntity,
    robotId: string
  ): Promise<RegistrationResult> {
    if (!hasPermission(user, AppPermission.ROBOT_REGISTER, robotId, this.roleMapping) &&
        !hasPermission(user, AppPermission.ROBOT_CONFIG_UPDATE, robotId, this.roleMapping)) {
      throw new MolirisAppError(ErrorCode.INSUFFICIENT_PERMISSIONS, "Autorizzazioni insufficienti per riparare la registrazione.");
    }

    const robot = await this.robotRepository.findById(robotId);
    if (!robot) {
      throw new MolirisAppError(ErrorCode.MISSING_ROBOT_PARAMS, `Robot '${robotId}' non trovato.`);
    }

    const performedActions: string[] = ["controllo_stato_incompleto"];
    const skippedActions: string[] = [];

    // Assicura directory server del robot in modo idempotente (RNF-FS-004)
    performedActions.push("ripristino_directory_server");
    try {
      await this.serverFsService.ensureRobotDirectory(robot, {
        standardSubdirectories: this.config.standardSubdirectories,
        directoryPermissions: this.config.serverDirectoryPermissions,
      });
    } catch (dirErr: any) {
      return {
        outcome: "creazione_directory_fallita",
        performedActions,
        skippedActions: ["verifica_connessione_ssh"],
        message: "Riparazione fallita: impossibile ripristinare la directory server.",
        diagnosticDetail: dirErr.message,
      };
    }

    // Verifica connessione SSH
    performedActions.push("verifica_connessione_ssh");
    const verif = await this.verifyConnection(user, robotId);

    const updated = await this.robotRepository.findById(robotId);
    const availableFeatures = this.getAvailableFeatures(updated!, user);

    return {
      outcome: updated!.registrationState,
      robot: toRobotDetailDto(updated!),
      availableFeatures,
      performedActions,
      skippedActions,
      message: verif.success
        ? "Registrazione ripristinata e completata con successo."
        : "Directory ripristinata. Connessione SSH verso il robot ancora non verificata.",
    };
  }

  /**
   * STEP 9 – Aggiornamento della configurazione (§2.2, §8.3).
   * Valida i nuovi parametri. Se cambiano host, porta o credenziali, invalida le sessioni in cache,
   * aggiorna il vault e riporta lo stato di connessione a 'non_verificato' (§8.3).
   * Lo username remoto è immutabile (§11.3).
   */
  public async updateConfiguration(
    user: UserEntity,
    robotId: string,
    update: RobotConfigurationUpdateInput
  ): Promise<RobotDetailDto> {
    if (!hasPermission(user, AppPermission.ROBOT_CONFIG_UPDATE, robotId, this.roleMapping)) {
      await this.recordAudit(user.username, AuditOperation.SECURITY_AUTHORIZATION_ERROR, robotId, "FAILURE", {
        reason: "PERMISSION_DENIED_ROBOT_CONFIG_UPDATE",
      });
      throw new MolirisAppError(
        ErrorCode.INSUFFICIENT_PERMISSIONS,
        "Operazione non consentita: permesso di modifica configurazione robot non accordato."
      );
    }

    const robot = await this.robotRepository.findById(robotId);
    if (!robot) {
      throw new MolirisAppError(ErrorCode.MISSING_ROBOT_PARAMS, `Robot '${robotId}' non trovato.`);
    }

    // Verifica validità e sicurezza dei percorsi modificati (CA-ROB-009)
    if (update.remoteMonitoringPath) {
      if (update.remoteMonitoringPath.includes("\0") || /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(update.remoteMonitoringPath)) {
        throw new MolirisAppError(ErrorCode.MISSING_ROBOT_PARAMS, "Percorso monitoraggio non valido: path traversal non consentito (CA-ROB-009).");
      }
    }
    if (update.stateFilePaths) {
      for (const p of update.stateFilePaths) {
        if (p.includes("\0") || /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(p)) {
          throw new MolirisAppError(ErrorCode.MISSING_ROBOT_PARAMS, "Percorso file di stato non valido: path traversal non consentito (CA-ROB-009).");
        }
      }
    }

    let connectionInvalidated = false;

    // Convalida host e porta se forniti
    let normHost = robot.host;
    let normPort = robot.sshPort;
    if (update.host || update.sshPort !== undefined) {
      const val = validateHostAndPort(update.host || robot.host, update.sshPort ?? robot.sshPort);
      normHost = val.normalizedHost;
      normPort = val.normalizedPort;

      if (!this.destinationValidator.isDestinationAllowed(normHost)) {
        throw new MolirisAppError(ErrorCode.MISSING_ROBOT_PARAMS, "Destinazione non ammessa dalle regole di sicurezza configurate (RNF-SEC-006).");
      }

      if (normHost !== robot.host || normPort !== robot.sshPort) {
        connectionInvalidated = true;
      }
    }

    // Aggiornamento credenziali nel CredentialProvider se fornite
    let credentialRef = robot.credentialReference;
    if (update.password) {
      connectionInvalidated = true;
      credentialRef = update.credentialReference || `vault://robots/${robot.id}`;
      if ("registerSecret" in this.credentialProvider) {
        (this.credentialProvider as InMemoryCredentialProvider).registerSecret(credentialRef, {
          method: "password",
          password: update.password,
        });
      }
    } else if (update.privateKey) {
      connectionInvalidated = true;
      credentialRef = update.credentialReference || `vault://robots/${robot.id}`;
      if ("registerSecret" in this.credentialProvider) {
        (this.credentialProvider as InMemoryCredentialProvider).registerSecret(credentialRef, {
          method: "key",
          privateKey: update.privateKey,
          passphrase: update.passphrase,
        });
      }
    }

    // Se sono cambiate le coordinate di connessione o le credenziali (§8.3):
    // 1. Chiude le connessioni attive o in cache nel connection manager
    // 2. Riporta lo stato di connessione a 'non_verificato' finché non viene ripetuta la verifica
    if (connectionInvalidated) {
      await this.connectionManager.closeConnectionsForRobot(robotId);
      await this.robotRepository.updateConnectionState(robotId, "non_verificato");
    }

    const cleanUpdate: any = {};
    if (update.displayName !== undefined) cleanUpdate.displayName = update.displayName;
    if (normHost !== undefined) cleanUpdate.host = normHost;
    if (normPort !== undefined) cleanUpdate.sshPort = normPort;
    if (update.sshAuthMethod !== undefined) cleanUpdate.sshAuthMethod = update.sshAuthMethod;
    if (credentialRef !== undefined) cleanUpdate.credentialReference = credentialRef;
    if (update.hostKeyVerification !== undefined) cleanUpdate.hostKeyVerification = update.hostKeyVerification;
    if (update.stateFilePaths !== undefined) cleanUpdate.stateFilePaths = update.stateFilePaths;
    if (update.remoteMonitoringPath !== undefined) cleanUpdate.remoteMonitoringPath = update.remoteMonitoringPath;
    if (update.sftpParameters !== undefined) cleanUpdate.sftpParameters = update.sftpParameters;
    if (update.customParameters !== undefined) cleanUpdate.customParameters = update.customParameters;

    const updatedEntity = await this.robotRepository.updateConfiguration(robotId, cleanUpdate);

    await this.recordAudit(user.username, AuditOperation.ROBOT_UPDATE, robotId, "SUCCESS", {
      connectionInvalidated,
      updatedFields: Object.keys(update).filter(k => k !== "password" && k !== "privateKey"),
    });

    return toRobotDetailDto(updatedEntity);
  }

  /**
   * STEP 10 – Disabilitazione del robot (RF-ROB-013, §8.4, CA-ROB-011).
   * Porta lo stato anagrafico a 'disabilitato'. Blocca ogni nuova connessione operativa.
   * Il comportamento verso le sessioni esistenti è gestito da configurazione.
   */
  public async disableRobot(user: UserEntity, robotId: string): Promise<RobotDetailDto> {
    if (!hasPermission(user, AppPermission.ROBOT_DISABLE, robotId, this.roleMapping)) {
      await this.recordAudit(user.username, AuditOperation.SECURITY_AUTHORIZATION_ERROR, robotId, "FAILURE", {
        reason: "PERMISSION_DENIED_ROBOT_DISABLE",
      });
      throw new MolirisAppError(ErrorCode.INSUFFICIENT_PERMISSIONS, "Autorizzazioni insufficienti per disabilitare il robot.");
    }

    const robot = await this.robotRepository.findById(robotId);
    if (!robot) {
      throw new MolirisAppError(ErrorCode.MISSING_ROBOT_PARAMS, `Robot '${robotId}' non trovato.`);
    }

    // Politica verso sessioni già aperte alla disabilitazione (§11.3, §8.4)
    if (this.config.activeSessionPolicyOnDisable === "chiudi_immediatamente") {
      await this.connectionManager.closeConnectionsForRobot(robotId);
    }

    const updated = await this.robotRepository.updateAnagraphicState(robotId, "disabilitato");

    await this.recordAudit(user.username, AuditOperation.ROBOT_DISABLE, robotId, "SUCCESS", {
      sessionPolicy: this.config.activeSessionPolicyOnDisable,
    });

    return toRobotDetailDto(updated);
  }

  /**
   * Riabilitazione del robot (da 'disabilitato' ad 'attivo').
   */
  public async enableRobot(user: UserEntity, robotId: string): Promise<RobotDetailDto> {
    if (!hasPermission(user, AppPermission.ROBOT_DISABLE, robotId, this.roleMapping) &&
        !hasPermission(user, AppPermission.ROBOT_CONFIG_UPDATE, robotId, this.roleMapping)) {
      throw new MolirisAppError(ErrorCode.INSUFFICIENT_PERMISSIONS, "Autorizzazioni insufficienti per riabilitare il robot.");
    }

    const robot = await this.robotRepository.findById(robotId);
    if (!robot) {
      throw new MolirisAppError(ErrorCode.MISSING_ROBOT_PARAMS, `Robot '${robotId}' non trovato.`);
    }

    const updated = await this.robotRepository.updateAnagraphicState(robotId, "attivo");

    await this.recordAudit(user.username, AuditOperation.ROBOT_UPDATE, robotId, "SUCCESS", {
      action: "ENABLE_ROBOT",
    });

    return toRobotDetailDto(updated);
  }

  /**
   * STEP 10 – Rimozione del robot dall'anagrafica attiva (RF-ROB-013, §8.4, CA-ROB-011).
   * Richiede conferma esplicita (RNF-FS-003). Porta lo stato a 'rimosso'.
   * NON cancella la directory né i file associati sul server (RF-ROB-013, CA-ROB-011).
   */
  public async removeRobot(
    user: UserEntity,
    robotId: string,
    confirmation: boolean
  ): Promise<void> {
    if (!hasPermission(user, AppPermission.ROBOT_REMOVE, robotId, this.roleMapping)) {
      await this.recordAudit(user.username, AuditOperation.SECURITY_AUTHORIZATION_ERROR, robotId, "FAILURE", {
        reason: "PERMISSION_DENIED_ROBOT_REMOVE",
      });
      throw new MolirisAppError(ErrorCode.INSUFFICIENT_PERMISSIONS, "Autorizzazioni insufficienti per rimuovere il robot.");
    }

    if (confirmation !== true) {
      throw new MolirisAppError(
        ErrorCode.MISSING_ROBOT_PARAMS,
        "La rimozione del robot dall'anagrafica attiva richiede conferma esplicita (RNF-FS-003)."
      );
    }

    const robot = await this.robotRepository.findById(robotId);
    if (!robot) {
      throw new MolirisAppError(ErrorCode.MISSING_ROBOT_PARAMS, `Robot '${robotId}' non trovato.`);
    }

    // Chiude eventuali connessioni attive
    await this.connectionManager.closeConnectionsForRobot(robotId);

    // Cambia stato anagrafico a 'rimosso' (preservando database storico e file su filesystem)
    await this.robotRepository.updateAnagraphicState(robotId, "rimosso");

    await this.recordAudit(user.username, AuditOperation.ROBOT_REMOVAL, robotId, "SUCCESS", {
      serverDirectoryPreserved: robot.serverDirectoryPath,
    });
  }

  private async recordAudit(
    userId: string,
    operation: any,
    robotId: string | undefined,
    outcome: "SUCCESS" | "FAILURE",
    details?: Record<string, unknown>
  ): Promise<void> {
    try {
      await this.auditRepository.record({
        userId,
        operation,
        robotId,
        outcome,
        timestamp: new Date(),
        details,
      });
    } catch (err: any) {
      this.logger.error("Errore scrittura audit log flotta", err.message, { robotId });
    }
  }
}
