// Requisiti soddisfatti: Vincolo 2.4 punto 4, RF-ROB-005, RF-SSH-008, RF-TRF-012,
// RNF-MNT-001, RNF-PERF-003, RNF-PERF-004, RNF-REL-001, RNF-REL-005, RNF-SEC-002, RNF-SEC-003, SRS §6.3, §9

import ssh2, { type Client, type ClientChannel, type SFTPWrapper } from "ssh2";
import crypto from "crypto";
import { type RobotEntity } from "../../storage/robot-models.ts";
import { type CredentialProvider, type AuthenticationMaterial } from "./credential-provider.ts";
import { type HostKeyVerifier, computeHostKeyFingerprint } from "./host-key-verifier.ts";
import { type AuditRepository } from "../../storage/audit-repository.ts";
import { AuditOperation } from "../../storage/audit-models.ts";
import { MolirisAppError, ErrorCode, ERROR_CATALOG } from "../../errors/app-errors.ts";
import { MolirisLogger, redactSensitiveData } from "../../logging/logger.ts";

export interface ManagedRobotConnection {
  connectionId: string;
  robotId: string;
  userId: string;
  createdAt: Date;
  executeCommand(command: string): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  getSftpClient(): Promise<SFTPWrapper>;
  openPtyStream(options: { rows?: number; cols?: number; term?: string }): Promise<ClientChannel>;
  close(): Promise<void>;
}

export interface ConnectionLimits {
  maxConcurrentPerUser: number;
  maxConcurrentPerRobot: number;
  maxConcurrentServer: number;
  connectionTimeoutMs: number;
}

export class RobotConnectionManager {
  private activeConnections: Map<string, { client: Client; robotId: string; userId: string }> = new Map();
  private userConnectionCounts: Map<string, number> = new Map();
  private robotConnectionCounts: Map<string, number> = new Map();

  private credentialProvider: CredentialProvider;
  private hostKeyVerifier: HostKeyVerifier;
  private limits: ConnectionLimits;
  private logger: MolirisLogger;
  private auditRepository?: AuditRepository;

  constructor(
    credentialProvider: CredentialProvider,
    hostKeyVerifier: HostKeyVerifier,
    limits: ConnectionLimits,
    logger: MolirisLogger,
    auditRepository?: AuditRepository
  ) {
    this.credentialProvider = credentialProvider;
    this.hostKeyVerifier = hostKeyVerifier;
    this.limits = limits;
    this.logger = logger;
    this.auditRepository = auditRepository;
  }

  public getActiveConnectionCount(): number {
    return this.activeConnections.size;
  }

  public getUserConnectionCount(userId: string): number {
    return this.userConnectionCounts.get(userId) || 0;
  }

  public getRobotConnectionCount(robotId: string): number {
    return this.robotConnectionCounts.get(robotId) || 0;
  }

  /**
   * Apre una connessione SSH verso un robot registrato e abilitato (§6.3 punto 2).
   * Applica limiti di concorrenza, credenziali server-side, verifica della chiave host e timeout.
   */
  public async acquireConnection(
    userId: string,
    robot: RobotEntity
  ): Promise<ManagedRobotConnection> {
    // 1. Verifica stato anagrafico del robot (§6.3 punto 2, §8.4)
    if (robot.anagraphicState === "disabilitato" || robot.anagraphicState === "rimosso") {
      throw new MolirisAppError(
        ErrorCode.INSUFFICIENT_PERMISSIONS,
        `Impossibile aprire connessioni verso un robot ${robot.anagraphicState}.`
      );
    }

    // 2. Controllo e applicazione limiti di concorrenza (RNF-PERF-003, RF-TRF-012)
    if (this.activeConnections.size >= this.limits.maxConcurrentServer) {
      throw new MolirisAppError(
        ErrorCode.INSUFFICIENT_STORAGE,
        "Limite massimo di connessioni contemporanee sul server raggiunto. Riprovare a breve."
      );
    }

    const currentForUser = this.getUserConnectionCount(userId);
    if (currentForUser >= this.limits.maxConcurrentPerUser) {
      throw new MolirisAppError(
        ErrorCode.INSUFFICIENT_STORAGE,
        "Limite massimo di connessioni simultanee per utente raggiunto."
      );
    }

    const currentForRobot = this.getRobotConnectionCount(robot.id);
    if (currentForRobot >= this.limits.maxConcurrentPerRobot) {
      throw new MolirisAppError(
        ErrorCode.INSUFFICIENT_STORAGE,
        "Limite massimo di connessioni simultanee per questo robot raggiunto."
      );
    }

    // 3. Recupero materiale di autenticazione protetto (Vincoli 2.4 punti 1-2, RNF-SEC-002)
    const authMaterial = await this.credentialProvider.getCredentials(
      robot.credentialReference,
      robot.sshAuthMethod
    );

    const connectionId = `conn_${Date.now()}_${crypto.randomBytes(8).toString("hex")}`;
    const client = new ssh2.Client();

    let hostKeyVerified = false;
    let hostKeyError: Error | null = null;

    // Configurazione di connessione SSH2
    const sshConfig: ssh2.ConnectConfig = {
      host: robot.host,
      port: robot.sshPort,
      username: robot.remoteUsername,
      readyTimeout: this.limits.connectionTimeoutMs,
      // Verifica della chiave host rigorosa (RNF-SEC-003): MAI disabilitata o bypassata
      hostVerifier: (serverHostKey: Buffer) => {
        try {
          const res = this.hostKeyVerifier.verify(
            robot.host,
            robot.sshPort,
            serverHostKey,
            robot.hostKeyVerification
          );
          const matched = typeof res === "boolean" ? res : res.matched;
          hostKeyVerified = matched;
          if (!matched) {
            const exp = typeof res === "object" ? res.expectedFingerprint : (robot.hostKeyVerification?.fingerprint || "");
            const rec = typeof res === "object" ? res.receivedFingerprint : computeHostKeyFingerprint(serverHostKey).openSshFormat;

            if (this.auditRepository) {
              this.auditRepository.record({
                userId,
                operation: AuditOperation.SECURITY_AUTHORIZATION_ERROR,
                robotId: robot.id,
                outcome: "FAILURE",
                timestamp: new Date(),
                details: {
                  reason: "SSH_HOST_KEY_MISMATCH",
                  expectedFingerprint: exp,
                  receivedFingerprint: rec,
                },
              }).catch(() => {});
            }

            hostKeyError = new MolirisAppError(
              ErrorCode.SSH_HOST_KEY_INVALID,
              `Discrepanza host key per robot '${robot.id}': attesa '${exp}', ricevuta '${rec}'. Richiede intervento amministrativo.`,
              "Verifica chiave host fallita: impronta digitale o chiave host non riconosciuta."
            );
          }
          return matched;
        } catch (err: any) {
          hostKeyError = err;
          return false;
        }
      },
    };

    if (authMaterial.method === "key") {
      sshConfig.privateKey = authMaterial.privateKey;
      if (authMaterial.passphrase) {
        sshConfig.passphrase = authMaterial.passphrase;
      }
    } else {
      sshConfig.password = authMaterial.password;
    }

    // 4. Apertura connessione con gestione garantita delle risorse (RNF-REL-005)
    try {
      await new Promise<void>((resolve, reject) => {
        let finished = false;

        const cleanupListeners = () => {
          client.removeListener("ready", onReady);
          client.removeListener("error", onError);
          client.removeListener("timeout", onTimeout);
          client.removeListener("close", onCloseBeforeReady);
          client.on("error", () => {}); // Previene crash da eventi error emessi successivamente dal socket
        };

        const onReady = () => {
          if (finished) return;
          finished = true;
          cleanupListeners();
          resolve();
        };

        const onError = (err: any) => {
          if (finished) return;
          finished = true;
          cleanupListeners();

          if (hostKeyError) {
            return reject(hostKeyError);
          }

          // Mappatura errori delle librerie sul modello SRS §9
          const errMsg = err.message || "";
          if (errMsg.includes("All configured authentication methods failed")) {
            return reject(new MolirisAppError(ErrorCode.SSH_AUTH_FAILED, "Autenticazione remota verso il robot fallita."));
          }
          if (err.code === "ECONNREFUSED") {
            return reject(new MolirisAppError(ErrorCode.SSH_PORT_UNAVAILABLE, "Porta SSH non raggiungibile o rifiutata dal robot."));
          }
          if (err.code === "ETIMEDOUT" || err.code === "ENOTFOUND" || err.code === "EHOSTUNREACH") {
            return reject(new MolirisAppError(ErrorCode.HOST_UNREACHABLE, "Robot remoto non raggiungibile sulla rete."));
          }
          if (err.level === "client-timeout" || errMsg.includes("Timed out")) {
            return reject(new MolirisAppError(ErrorCode.TIMEOUT_ERROR, "Timeout durante la connessione SSH verso il robot."));
          }

          return reject(new MolirisAppError(ErrorCode.HOST_UNREACHABLE, `Errore durante la connessione SSH: ${redactSensitiveData(errMsg)}`));
        };

        const onTimeout = () => {
          if (finished) return;
          finished = true;
          cleanupListeners();
          client.end();
          reject(new MolirisAppError(ErrorCode.TIMEOUT_ERROR, "Timeout connessione SSH superato."));
        };

        const onCloseBeforeReady = () => {
          if (finished) return;
          finished = true;
          cleanupListeners();
          if (hostKeyError) {
            return reject(hostKeyError);
          }
          reject(new MolirisAppError(ErrorCode.HOST_UNREACHABLE, "Connessione chiusa dal server remoto prima del completamento dell'handshake."));
        };

        client.once("ready", onReady);
        client.once("error", onError);
        client.once("timeout", onTimeout);
        client.once("close", onCloseBeforeReady);

        client.connect(sshConfig);
      });
    } catch (connErr: any) {
      client.destroy();
      throw connErr;
    }

    // Registrazione della connessione attiva
    this.activeConnections.set(connectionId, { client, robotId: robot.id, userId });
    this.userConnectionCounts.set(userId, currentForUser + 1);
    this.robotConnectionCounts.set(robot.id, currentForRobot + 1);

    const releaseConnection = async () => {
      const active = this.activeConnections.get(connectionId);
      if (active) {
        this.activeConnections.delete(connectionId);
        const uCount = this.getUserConnectionCount(userId);
        if (uCount <= 1) this.userConnectionCounts.delete(userId);
        else this.userConnectionCounts.set(userId, uCount - 1);

        const rCount = this.getRobotConnectionCount(robot.id);
        if (rCount <= 1) this.robotConnectionCounts.delete(robot.id);
        else this.robotConnectionCounts.set(robot.id, rCount - 1);

        try {
          active.client.end();
          active.client.destroy();
        } catch {}
      }
    };

    client.on("close", () => {
      releaseConnection();
    });

    const managed: ManagedRobotConnection = {
      connectionId,
      robotId: robot.id,
      userId,
      createdAt: new Date(),

      executeCommand: async (command: string) => {
        // RF-SSH-008: Nessuna elevazione automatica di privilegi (mai sudo automatico)
        return new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve, reject) => {
          client.exec(command, (err, stream) => {
            if (err) {
              return reject(new MolirisAppError(ErrorCode.REMOTE_FS_ERROR, `Errore esecuzione comando: ${redactSensitiveData(err.message)}`));
            }
            let stdout = "";
            let stderr = "";
            stream.on("data", (chunk: Buffer) => {
              stdout += chunk.toString();
            });
            stream.stderr.on("data", (chunk: Buffer) => {
              stderr += chunk.toString();
            });
            stream.on("close", (code: number) => {
              resolve({ stdout, stderr, exitCode: code });
            });
          });
        });
      },

      getSftpClient: async () => {
        return new Promise<SFTPWrapper>((resolve, reject) => {
          client.sftp((err, sftp) => {
            if (err) {
              return reject(new MolirisAppError(ErrorCode.REMOTE_FS_ERROR, `Errore avvio sessione SFTP: ${redactSensitiveData(err.message)}`));
            }
            resolve(sftp);
          });
        });
      },

      openPtyStream: async (options) => {
        return new Promise<ClientChannel>((resolve, reject) => {
          client.shell(
            {
              term: options.term || "xterm-256color",
              rows: options.rows || 24,
              cols: options.cols || 80,
            },
            (err, channel) => {
              if (err) {
                return reject(new MolirisAppError(ErrorCode.TERMINAL_SESSION_ERROR, `Errore apertura shell PTY: ${redactSensitiveData(err.message)}`));
              }
              resolve(channel);
            }
          );
        });
      },

      close: async () => {
        await releaseConnection();
      },
    };

    return managed;
  }

  public async closeConnectionsForRobot(robotId: string): Promise<void> {
    for (const [connId, entry] of this.activeConnections.entries()) {
      if (entry.robotId === robotId) {
        try {
          entry.client.end();
          entry.client.destroy();
        } catch {}
        this.activeConnections.delete(connId);
      }
    }
    this.robotConnectionCounts.delete(robotId);
    this.userConnectionCounts.clear();
    for (const entry of this.activeConnections.values()) {
      const current = this.userConnectionCounts.get(entry.userId) || 0;
      this.userConnectionCounts.set(entry.userId, current + 1);
    }
  }

  public async closeAll(): Promise<void> {
    for (const [connId, entry] of this.activeConnections.entries()) {
      try {
        entry.client.end();
        entry.client.destroy();
      } catch {}
    }
    this.activeConnections.clear();
    this.userConnectionCounts.clear();
    this.robotConnectionCounts.clear();
  }
}
