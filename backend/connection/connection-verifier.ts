// Requisiti soddisfatti: RF-ROB-007, RF-ROB-005, RF-MON-001, SRS §6.2 passi 6-7, §8.1, §9, §10.1, RNF-SEC-003, RNF-SEC-006

import net from "net";
import { type RobotEntity } from "../../storage/robot-models.ts";
import { type CredentialProvider } from "./credential-provider.ts";
import { type HostKeyVerifier } from "./host-key-verifier.ts";
import { validateHostAndPort, type DestinationValidator } from "./connection-validator.ts";
import { MolirisAppError, ErrorCode, ERROR_CATALOG } from "../../errors/app-errors.ts";
import { MolirisLogger, redactSensitiveData } from "../../logging/logger.ts";
import ssh2 from "ssh2";

export type VerificationStepStatus = "SUCCESS" | "FAILED" | "SKIPPED";

export interface VerificationStepResult {
  step: "host_reachability" | "ssh_port_availability" | "host_key_verification" | "ssh_authentication" | "resources_accessibility";
  status: VerificationStepStatus;
  message?: string;
  errorCode?: string;
  diagnosticDetail?: string;
}

export interface ConnectionVerificationReport {
  overallSuccess: boolean;
  timestamp: Date;
  steps: VerificationStepResult[];
  lastConnectionVerificationInfo: {
    timestamp: Date;
    success: boolean;
    message?: string;
  };
}

/**
 * Esegue il controllo di connessione non distruttivo verso il robot (RF-ROB-007, §6.2 passi 6-7).
 * Esegue in ordine rigoroso i 5 controlli previsti dalla specifica, interrompendosi
 * al primo fallimento e marcando i passi successivi come SKIPPED.
 *
 * VINCOLO RIGOROSO RF-ROB-007:
 * Le operazioni eseguite sono ESCLUSIVAMENTE di consultazione e non distruttive:
 * 1. Reachability: connessione socket TCP read-only
 * 2. Port: lettura identificativo banner SSH
 * 3. Host Key: estrazione chiave pubblica in handshake e comparazione impronta
 * 4. Auth: autenticazione con credenziali fornite
 * 5. Risorse: lettura non invasiva file di stato o avvio sessione SFTP (read-only)
 * NESSUNA scrittura, modifica o creazione di file sul robot remoto.
 */
export async function verifyRobotConnection(
  robotParams: Pick<
    RobotEntity,
    | "id"
    | "host"
    | "sshPort"
    | "remoteUsername"
    | "sshAuthMethod"
    | "credentialReference"
    | "hostKeyVerification"
    | "stateFilePaths"
  >,
  deps: {
    credentialProvider: CredentialProvider;
    hostKeyVerifier: HostKeyVerifier;
    destinationValidator?: DestinationValidator;
    timeoutMs: number;
    logger: MolirisLogger;
  }
): Promise<ConnectionVerificationReport> {
  const timestamp = new Date();
  const steps: VerificationStepResult[] = [];

  // Validazione sintattica preventiva (RF-ROB-005, RF-ROB-006)
  const validated = validateHostAndPort(robotParams.host, robotParams.sshPort);
  const host = validated.normalizedHost;
  const port = validated.normalizedPort;

  // Misura anti-abuso su destinazioni consentite (RNF-SEC-006)
  if (deps.destinationValidator && !deps.destinationValidator.isDestinationAllowed(host)) {
    throw new MolirisAppError(
      ErrorCode.HOST_UNREACHABLE,
      "Connessione verso l'host specificato non consentita dalla politica di sicurezza (destinazione non in whitelist)."
    );
  }

  // Acquisizione slot anti-abuso (RNF-SEC-006)
  if (deps.destinationValidator) {
    deps.destinationValidator.acquireVerificationSlot();
  }

  try {
    // --- 1. Raggiungibilità dell'host (TCP Socket Connect) ---
    // Operazione: Socket TCP verso host:port per verificare se la rete risponde
    const reachability = await checkTcpReachability(host, port, deps.timeoutMs);
    if (!reachability.success) {
      steps.push({
        step: "host_reachability",
        status: "FAILED",
        errorCode: ErrorCode.HOST_UNREACHABLE,
        message: ERROR_CATALOG[ErrorCode.HOST_UNREACHABLE].userMessage,
        diagnosticDetail: reachability.error,
      });
      skipRemainingSteps(steps, ["ssh_port_availability", "host_key_verification", "ssh_authentication", "resources_accessibility"]);
      return buildReport(false, timestamp, steps);
    }
    steps.push({ step: "host_reachability", status: "SUCCESS" });

    // --- 2. Disponibilità del servizio SSH sulla porta ---
    // Operazione: Lettura del banner SSH (es. "SSH-2.0-OpenSSH...") per verificare che il servizio sia effettivamente SSH
    const sshBanner = await checkSshBanner(host, port, deps.timeoutMs);
    if (!sshBanner.success) {
      steps.push({
        step: "ssh_port_availability",
        status: "FAILED",
        errorCode: ErrorCode.SSH_PORT_UNAVAILABLE,
        message: ERROR_CATALOG[ErrorCode.SSH_PORT_UNAVAILABLE].userMessage,
        diagnosticDetail: sshBanner.error,
      });
      skipRemainingSteps(steps, ["host_key_verification", "ssh_authentication", "resources_accessibility"]);
      return buildReport(false, timestamp, steps);
    }
    steps.push({ step: "ssh_port_availability", status: "SUCCESS" });

    // Recupero credenziali per i passi successivi (Vincoli 2.4 punti 1-2, RNF-SEC-002)
    const credentials = await deps.credentialProvider.getCredentials(
      robotParams.credentialReference,
      robotParams.sshAuthMethod
    );

    // --- 3 & 4. Verifica della chiave host e autenticazione ---
    const sshVerification = await executeSshHandshakeAndAuth(
      host,
      port,
      robotParams.remoteUsername,
      credentials,
      robotParams.hostKeyVerification,
      deps.hostKeyVerifier,
      deps.timeoutMs
    );

    if (!sshVerification.hostKeyVerified) {
      steps.push({
        step: "host_key_verification",
        status: "FAILED",
        errorCode: ErrorCode.HOST_KEY_INVALID,
        message: ERROR_CATALOG[ErrorCode.HOST_KEY_INVALID].userMessage,
        diagnosticDetail: sshVerification.hostKeyError || "Impronta digitale chiave host non riconosciuta",
      });
      skipRemainingSteps(steps, ["ssh_authentication", "resources_accessibility"]);
      return buildReport(false, timestamp, steps);
    }
    steps.push({ step: "host_key_verification", status: "SUCCESS" });

    if (!sshVerification.authSuccess) {
      steps.push({
        step: "ssh_authentication",
        status: "FAILED",
        errorCode: ErrorCode.SSH_AUTH_FAILED,
        message: ERROR_CATALOG[ErrorCode.SSH_AUTH_FAILED].userMessage,
        diagnosticDetail: sshVerification.authError || "Autenticazione SSH fallita",
      });
      skipRemainingSteps(steps, ["resources_accessibility"]);
      return buildReport(false, timestamp, steps);
    }
    steps.push({ step: "ssh_authentication", status: "SUCCESS" });

    // --- 5. Possibilità di accedere alle risorse necessarie ---
    // Operazione NON DISTRUTTIVA: lettura non modificativa dello stato o verifica SFTP
    // Nessun comando di scrittura (touch, echo, rm, mkdir) viene mai eseguito (RF-ROB-007).
    const resources = await checkResourceAccessibility(sshVerification.client!, robotParams.stateFilePaths);
    if (!resources.success) {
      steps.push({
        step: "resources_accessibility",
        status: "FAILED",
        errorCode: ErrorCode.STATE_FILE_UNREADABLE,
        message: ERROR_CATALOG[ErrorCode.STATE_FILE_UNREADABLE].userMessage,
        diagnosticDetail: resources.error,
      });
      return buildReport(false, timestamp, steps);
    }
    steps.push({ step: "resources_accessibility", status: "SUCCESS" });

    return buildReport(true, timestamp, steps);
  } finally {
    if (deps.destinationValidator) {
      deps.destinationValidator.releaseVerificationSlot();
    }
  }
}

function skipRemainingSteps(
  steps: VerificationStepResult[],
  toSkip: Array<"host_reachability" | "ssh_port_availability" | "host_key_verification" | "ssh_authentication" | "resources_accessibility">
) {
  for (const step of toSkip) {
    steps.push({
      step,
      status: "SKIPPED",
    });
  }
}

function buildReport(
  overallSuccess: boolean,
  timestamp: Date,
  steps: VerificationStepResult[]
): ConnectionVerificationReport {
  const failedStep = steps.find(s => s.status === "FAILED");
  const message = overallSuccess
    ? "Verifica di connessione completata con successo."
    : failedStep?.message || "Verifica di connessione non riuscita.";

  return {
    overallSuccess,
    timestamp,
    steps,
    lastConnectionVerificationInfo: {
      timestamp,
      success: overallSuccess,
      message,
    },
  };
}

// Controllo non distruttivo TCP
async function checkTcpReachability(host: string, port: number, timeoutMs: number): Promise<{ success: boolean; error?: string }> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let resolved = false;

    socket.setTimeout(timeoutMs);

    socket.once("connect", () => {
      if (resolved) return;
      resolved = true;
      socket.destroy();
      resolve({ success: true });
    });

    socket.once("timeout", () => {
      if (resolved) return;
      resolved = true;
      socket.destroy();
      resolve({ success: false, error: "Timeout di connessione di rete superato" });
    });

    socket.once("error", (err) => {
      if (resolved) return;
      resolved = true;
      socket.destroy();
      resolve({ success: false, error: err.message });
    });

    socket.connect(port, host);
  });
}

// Controllo non distruttivo banner SSH
async function checkSshBanner(host: string, port: number, timeoutMs: number): Promise<{ success: boolean; error?: string }> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let resolved = false;
    let banner = "";

    socket.setTimeout(timeoutMs);

    socket.on("data", (chunk) => {
      banner += chunk.toString();
      if (banner.includes("SSH-")) {
        if (resolved) return;
        resolved = true;
        socket.destroy();
        resolve({ success: true });
      }
    });

    socket.once("timeout", () => {
      if (resolved) return;
      resolved = true;
      socket.destroy();
      resolve({ success: false, error: "Nessun banner SSH ricevuto entro il timeout" });
    });

    socket.once("error", (err) => {
      if (resolved) return;
      resolved = true;
      socket.destroy();
      resolve({ success: false, error: err.message });
    });

    socket.connect(port, host);
  });
}

// Handshake e verifica crittografica
async function executeSshHandshakeAndAuth(
  host: string,
  port: number,
  username: string,
  credentials: any,
  hostKeyParams: any,
  hostKeyVerifier: HostKeyVerifier,
  timeoutMs: number
): Promise<{ hostKeyVerified: boolean; authSuccess: boolean; client?: ssh2.Client; hostKeyError?: string; authError?: string }> {
  return new Promise((resolve) => {
    const client = new ssh2.Client();
    let finished = false;
    let hostKeyVerified = false;
    let hostKeyError: string | undefined = undefined;

    const cleanup = () => {
      client.removeAllListeners();
      client.on("error", () => {});
    };

    const sshConfig: ssh2.ConnectConfig = {
      host,
      port,
      username,
      readyTimeout: timeoutMs,
      hostVerifier: (serverHostKey: Buffer) => {
        try {
          const verified = hostKeyVerifier.verify(host, port, serverHostKey, hostKeyParams);
          hostKeyVerified = verified;
          if (!verified) {
            hostKeyError = "Chiave host non corrispondente ai parametri attesi";
          }
          return verified;
        } catch (err: any) {
          hostKeyError = err.message;
          return false;
        }
      },
    };

    if (credentials.method === "key") {
      sshConfig.privateKey = credentials.privateKey;
      if (credentials.passphrase) sshConfig.passphrase = credentials.passphrase;
    } else {
      sshConfig.password = credentials.password;
    }

    client.once("ready", () => {
      if (finished) return;
      finished = true;
      resolve({ hostKeyVerified: true, authSuccess: true, client });
    });

    client.once("error", (err: any) => {
      if (finished) return;
      finished = true;
      cleanup();
      client.destroy();

      if (!hostKeyVerified) {
        return resolve({ hostKeyVerified: false, authSuccess: false, hostKeyError });
      }

      resolve({
        hostKeyVerified: true,
        authSuccess: false,
        authError: redactSensitiveData(err.message),
      });
    });

    client.once("close", () => {
      if (finished) return;
      finished = true;
      cleanup();
      client.destroy();
      resolve({
        hostKeyVerified,
        authSuccess: false,
        authError: hostKeyError || "Connessione chiusa durante handshake o autenticazione",
      });
    });

    try {
      client.connect(sshConfig);
    } catch (e: any) {
      resolve({ hostKeyVerified: false, authSuccess: false, authError: e.message });
    }
  });
}

// Controllo non distruttivo risorse (lettura file di stato o avvio SFTP)
async function checkResourceAccessibility(
  client: ssh2.Client,
  stateFilePaths?: string[]
): Promise<{ success: boolean; error?: string }> {
  try {
    // Se sono configurati file di stato, verifichiamo la leggibilità in sola lettura con comando safe
    if (stateFilePaths && stateFilePaths.length > 0) {
      const targetPath = stateFilePaths[0];
      // Comando strettamente NON DISTRUTTIVO: test -r legge solo i permessi senza modificare nulla (RF-ROB-007)
      const testCmd = `test -r "${targetPath.replace(/"/g, '\\"')}" && echo READABLE || echo UNREADABLE`;

      const result = await new Promise<string>((resolve, reject) => {
        client.exec(testCmd, (err, stream) => {
          if (err) return reject(err);
          let out = "";
          stream.on("data", (d: Buffer) => (out += d.toString()));
          stream.on("close", () => resolve(out.trim()));
        });
      });

      if (result.includes("READABLE")) {
        client.end();
        client.destroy();
        return { success: true };
      } else {
        client.end();
        client.destroy();
        return { success: false, error: `File di stato non accessibile in lettura: ${targetPath}` };
      }
    }

    // Se non ci sono file di stato, testiamo la disponibilità del sottosistema SFTP in sola lettura
    const sftpOk = await new Promise<boolean>((resolve) => {
      client.sftp((err, sftp) => {
        if (err) return resolve(false);
        sftp.end();
        resolve(true);
      });
    });

    client.end();
    client.destroy();
    return sftpOk ? { success: true } : { success: false, error: "Sottosistema SFTP non disponibile" };
  } catch (err: any) {
    client.end();
    client.destroy();
    return { success: false, error: redactSensitiveData(err.message) };
  }
}
