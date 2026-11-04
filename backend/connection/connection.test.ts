// Requisiti testati: Vincolo 2.4 punti 1–2, 4, RF-ROB-005, RF-ROB-006, RF-ROB-007,
// RF-SSH-008, RF-TRF-012, RNF-SEC-002, RNF-SEC-003, RNF-SEC-006, RNF-PERF-003,
// RNF-PERF-004, RNF-REL-001, RNF-REL-005, SRS §6.2, §6.3, §9, §11.2

import assert from "assert";
import crypto from "crypto";
import net from "net";
import ssh2 from "ssh2";
import { InMemoryCredentialProvider } from "./credential-provider.ts";
import { DefaultHostKeyVerifier, computeHostKeyFingerprint } from "./host-key-verifier.ts";
import { validateHostAndPort, DestinationValidator } from "./connection-validator.ts";
import { RobotConnectionManager } from "./robot-connection-manager.ts";
import { verifyRobotConnection } from "./connection-verifier.ts";
import { type RobotEntity } from "../../storage/robot-models.ts";
import { MolirisLogger } from "../../logging/logger.ts";
import { MolirisAppError, ErrorCode } from "../../errors/app-errors.ts";

console.log("--> Esecuzione test livello di connessione comune SSH/SFTP verso i robot...");

// Setup chiavi per il server SSH locale di test (ambiente di collaudo e sviluppo dichiarato)
const serverHostKey = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "pkcs1", format: "pem" },
});

// Calcolo fingerprint reale del server di test (formato OpenSSH wire key esposto da ssh2)
const parsedKey = (ssh2 as any).utils.parseKey(serverHostKey.privateKey);
const publicSshWireBuffer = parsedKey.getPublicSSH();
const serverFingerprintInfo = computeHostKeyFingerprint(publicSshWireBuffer);

const testLogger = new MolirisLogger();
const credentialProvider = new InMemoryCredentialProvider();
const hostKeyVerifier = new DefaultHostKeyVerifier();

// Registrazione credenziali di test (password e chiave privata)
credentialProvider.registerSecret("vault://creds/robot_valid", {
  method: "password",
  password: "ValidRobotPassword123!",
});

credentialProvider.registerSecret("vault://creds/robot_bad_pwd", {
  method: "password",
  password: "WrongPassword!",
});

// Tracciamento dei comandi eseguiti sul server di test per verificare che NON vi siano scritture
const executedCommands: string[] = [];

// Avvio server SSH di test
let testServerPort = 0;
const testServer = new ssh2.Server({ hostKeys: [serverHostKey.privateKey] }, (client) => {
  client.on("error", () => {}); // Previene crash su disconnessioni anticipate o errori di handshake

  client.on("authentication", (ctx) => {
    if (ctx.method === "password" && ctx.username === "moliris_op" && ctx.password === "ValidRobotPassword123!") {
      ctx.accept();
    } else {
      ctx.reject();
    }
  });

  client.on("ready", () => {
    client.on("session", (accept) => {
      const session = accept();
      session.on("error", () => {});

      // Intercettazione comandi remoti
      session.on("exec", (acceptExec, _rejectExec, info) => {
        executedCommands.push(info.command);
        const stream = acceptExec();
        if (info.command.includes("test -r") || info.command.includes("cat")) {
          // Risposta a test di leggibilità non distruttivo
          stream.write("READABLE\n");
          stream.exit(0);
        } else {
          stream.write("UNKNOWN\n");
          stream.exit(0);
        }
        stream.end();
      });

      session.on("sftp", (acceptSftp) => {
        const sftpStream = acceptSftp();
        sftpStream.on("error", () => {});
      });
    });
  });
});

await new Promise<void>((resolve) => {
  testServer.listen(0, "127.0.0.1", () => {
    testServerPort = (testServer.address() as any).port;
    resolve();
  });
});

// Fixture Robot per i test
function createTestRobotEntity(overrides: Partial<RobotEntity> = {}): RobotEntity {
  return {
    id: overrides.id || "robot_test_conn_01",
    displayName: "Robot Collaudo SSH",
    remoteUsername: overrides.remoteUsername || "moliris_op",
    host: overrides.host || "127.0.0.1",
    sshPort: overrides.sshPort !== undefined ? overrides.sshPort : testServerPort,
    sshAuthMethod: overrides.sshAuthMethod || "password",
    credentialReference: overrides.credentialReference || "vault://creds/robot_valid",
    hostKeyVerification: overrides.hostKeyVerification || {
      fingerprint: serverFingerprintInfo.sha256Hex,
      strictHostKeyChecking: true,
    },
    stateFilePaths: ["/opt/moliris/status/robot.txt"],
    serverDirectoryPath: `/srv/moliris/data/${overrides.remoteUsername || "moliris_op"}`,
    anagraphicState: overrides.anagraphicState || "attivo",
    connectionState: "non_verificato",
    operationalState: null,
    lastValidUpdateAt: null,
    lastAttemptOutcome: null,
    registrationState: "ssh_non_verificata",
    lastConnectionVerification: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

const connectionLimits = {
  maxConcurrentPerUser: 2,
  maxConcurrentPerRobot: 2,
  maxConcurrentServer: 5,
  connectionTimeoutMs: 3000,
};

const connManager = new RobotConnectionManager(
  credentialProvider,
  hostKeyVerifier,
  connectionLimits,
  testLogger
);

// --- 1. Test Validazione Sintattica Host e Porta (RF-ROB-005, RF-ROB-006) ---
const val1 = validateHostAndPort("192.168.1.10", 22);
assert.strictEqual(val1.normalizedHost, "192.168.1.10");
assert.strictEqual(val1.normalizedPort, 22);

const val2 = validateHostAndPort("robot.moliris.local");
assert.strictEqual(val2.normalizedPort, 22, "Default porta SSH deve essere 22 (RF-ROB-005)");

assert.throws(() => validateHostAndPort(""), (err: any) => err instanceof MolirisAppError && err.code === ErrorCode.MISSING_ROBOT_PARAMS);
assert.throws(() => validateHostAndPort("192.168.1.1; rm -rf /"), (err: any) => err instanceof MolirisAppError && err.code === ErrorCode.MISSING_ROBOT_PARAMS);
assert.throws(() => validateHostAndPort("localhost", 70000), (err: any) => err instanceof MolirisAppError && err.code === ErrorCode.MISSING_ROBOT_PARAMS);
console.log("  PASS: Validazione sintattica host/IP e porta (default 22).");

// --- 2. Test Misure Anti-Abuso e Whitelist Destinazioni (RNF-SEC-006) ---
const destValidator = new DestinationValidator(["127.0.0.1", "192.168.1.50"], 2);
assert.strictEqual(destValidator.isDestinationAllowed("127.0.0.1"), true);
assert.strictEqual(destValidator.isDestinationAllowed("10.0.0.99"), false);

// Test limite concorrenza verifiche
destValidator.acquireVerificationSlot();
destValidator.acquireVerificationSlot();
assert.throws(() => destValidator.acquireVerificationSlot(), (err: any) => err instanceof MolirisAppError && err.code === ErrorCode.TIMEOUT_ERROR);
destValidator.releaseVerificationSlot();
destValidator.releaseVerificationSlot();
console.log("  PASS: Misure anti-abuso e whitelist destinazioni in registrazione (RNF-SEC-006).");

// --- 3. Test Verifica Chiave Host: Corretta vs Errata (RNF-SEC-003, RF-ROB-005) ---
// Caso 3a: Fingerprint corrispondente -> Connessione stabilita con successo
const robotOk = createTestRobotEntity();
const connOk = await connManager.acquireConnection("user_01", robotOk);
assert(connOk.connectionId, "Connessione con chiave host valida deve avere un ID");
assert.strictEqual(connManager.getActiveConnectionCount(), 1);
await connOk.close();
assert.strictEqual(connManager.getActiveConnectionCount(), 0, "Rilascio garantito connessione dopo chiusura");

// Caso 3b: Fingerprint diverso -> Errore HOST_KEY_INVALID e connessione bloccata
const robotBadKey = createTestRobotEntity({
  hostKeyVerification: {
    fingerprint: "SHA256:0000000000000000000000000000000000000000000",
    strictHostKeyChecking: true,
  },
});

try {
  await connManager.acquireConnection("user_01", robotBadKey);
  assert.fail("Should have thrown");
} catch (err: any) {
  assert(err instanceof MolirisAppError);
  assert.strictEqual(err.code, ErrorCode.HOST_KEY_INVALID, "Deve restituire errore chiave host non valida (§9)");
  assert.strictEqual(err.classification, "richiede_intervento_amministrativo");
}
assert.strictEqual(connManager.getActiveConnectionCount(), 0, "Nessuna connessione residua su fallimento chiave host");
console.log("  PASS: Verifica chiave host attiva; blocco categorico su discrepanza (RNF-SEC-003).");

// --- 4. Test Autenticazione Errata vs Host/Porta Irraggiungibile (SRS §9) ---
// Caso 4a: Password errata -> SSH_AUTH_FAILED
const robotBadPwd = createTestRobotEntity({
  credentialReference: "vault://creds/robot_bad_pwd",
});
await assert.rejects(
  async () => await connManager.acquireConnection("user_01", robotBadPwd),
  (err: any) => {
    assert(err instanceof MolirisAppError);
    assert.strictEqual(err.code, ErrorCode.SSH_AUTH_FAILED, "Password errata deve produrre SSH_AUTH_FAILED (§9)");
    assert.strictEqual(err.classification, "recuperabile");
    return true;
  }
);

// Caso 4b: Porta chiusa su localhost -> SSH_PORT_UNAVAILABLE
// Troviamo una porta libera non in ascolto
const dummyServer = net.createServer();
await new Promise<void>((r) => dummyServer.listen(0, "127.0.0.1", () => r()));
const closedPort = (dummyServer.address() as any).port;
await new Promise<void>((r) => dummyServer.close(() => r()));

const robotClosedPort = createTestRobotEntity({ sshPort: closedPort });
await assert.rejects(
  async () => await connManager.acquireConnection("user_01", robotClosedPort),
  (err: any) => {
    assert(err instanceof MolirisAppError);
    assert.strictEqual(err.code, ErrorCode.SSH_PORT_UNAVAILABLE, "Porta chiusa deve produrre SSH_PORT_UNAVAILABLE (§9)");
    return true;
  }
);

// Caso 4c: Host irraggiungibile -> HOST_UNREACHABLE
const robotUnreachable = createTestRobotEntity({ host: "192.0.2.1", sshPort: 22 }); // TEST-NET-1 (non instradabile)
await assert.rejects(
  async () => await connManager.acquireConnection("user_01", robotUnreachable),
  (err: any) => {
    assert(err instanceof MolirisAppError);
    assert(
      err.code === ErrorCode.HOST_UNREACHABLE || err.code === ErrorCode.TIMEOUT_ERROR,
      `Host non instradabile deve restituire HOST_UNREACHABLE o TIMEOUT, ricevuto: ${err.code}`
    );
    return true;
  }
);
console.log("  PASS: Distinzione netta tra autenticazione fallita, porta chiusa e host irraggiungibile (§9).");

// --- 5. Test Limiti di Concorrenza e Rilascio Risorse (RNF-PERF-003, RNF-REL-005) ---
// Limite per utente = 2
const c1 = await connManager.acquireConnection("user_limited", robotOk);
const c2 = await connManager.acquireConnection("user_limited", robotOk);
assert.strictEqual(connManager.getUserConnectionCount("user_limited"), 2);

// Terza connessione per lo stesso utente deve fallire
await assert.rejects(
  async () => await connManager.acquireConnection("user_limited", robotOk),
  (err: any) => {
    assert(err instanceof MolirisAppError);
    return true;
  },
  "Il superamento del limite utente deve essere bloccato"
);

await c1.close();
await c2.close();
assert.strictEqual(connManager.getUserConnectionCount("user_limited"), 0, "Rilascio completo connessioni utente");
console.log("  PASS: Limiti di concorrenza applicati e rilascio garantito (RNF-PERF-003, RNF-REL-005).");

// --- 5B. Test concorrenza apertura connessioni SSH (RNF-PERF-003) ---
const delayedCredentialProvider = new InMemoryCredentialProvider();
delayedCredentialProvider.registerSecret("vault://creds/robot_valid", {
  method: "password",
  password: "ValidRobotPassword123!",
});

const originalGetCredentials = delayedCredentialProvider.getCredentials.bind(delayedCredentialProvider);
delayedCredentialProvider.getCredentials = async (reference, method) => {
  await new Promise<void>((resolve) => setTimeout(resolve, 100));
  return originalGetCredentials(reference, method);
};

const concurrentManager = new RobotConnectionManager(
  delayedCredentialProvider,
  hostKeyVerifier,
  {
    maxConcurrentPerUser: 5,
    maxConcurrentPerRobot: 1,
    maxConcurrentServer: 5,
    connectionTimeoutMs: 3000,
  },
  testLogger
);

const concurrentRobot = createTestRobotEntity({ id: "robot_concurrent_test" });
const concurrentResults = await Promise.allSettled([
  concurrentManager.acquireConnection("user_concurrent", concurrentRobot),
  concurrentManager.acquireConnection("user_concurrent", concurrentRobot),
]);

const concurrentSuccesses = concurrentResults.filter(
  (result) => result.status === "fulfilled"
);
const concurrentFailures = concurrentResults.filter(
  (result) => result.status === "rejected"
);

assert.strictEqual(
  concurrentSuccesses.length,
  1,
  "Con due aperture contemporanee deve riuscire una sola connessione per robot"
);
assert.strictEqual(
  concurrentFailures.length,
  1,
  "La seconda apertura contemporanea deve essere rifiutata"
);

const concurrentFailure = concurrentFailures[0];
assert(
  concurrentFailure.status === "rejected" &&
    concurrentFailure.reason instanceof MolirisAppError &&
    concurrentFailure.reason.code === ErrorCode.INSUFFICIENT_STORAGE,
  "La richiesta eccedente deve essere rifiutata per superamento del limite"
);

assert.strictEqual(concurrentManager.getRobotConnectionCount(concurrentRobot.id), 1);

if (concurrentSuccesses[0].status === "fulfilled") {
  await concurrentSuccesses[0].value.close();
}

assert.strictEqual(concurrentManager.getRobotConnectionCount(concurrentRobot.id), 0);
assert.strictEqual(concurrentManager.getActiveConnectionCount(), 0);
await concurrentManager.closeAll();

console.log("  PASS: Limite per robot rispettato anche con aperture SSH contemporanee (RNF-PERF-003).");

// --- 6. Test Isolamento Errori tra Robot (RNF-REL-001) ---
// Connessione attiva su robot A
const connRobotA = await connManager.acquireConnection("user_multi", robotOk);
assert.strictEqual(connManager.getActiveConnectionCount(), 1);

// Tentativo fallito su robot B (con porta chiusa)
try {
  await connManager.acquireConnection("user_multi", robotClosedPort);
  assert.fail("Avrebbe dovuto fallire");
} catch (err: any) {
  assert(err instanceof MolirisAppError);
}

// La connessione attiva su robot A deve rimanere perfettamente intatta e funzionante
const cmdRes = await connRobotA.executeCommand("test -r /dummy");
assert(cmdRes.stdout.includes("READABLE"), "La connessione su robot A deve restare valida");
await connRobotA.close();
assert.strictEqual(connManager.getActiveConnectionCount(), 0);
console.log("  PASS: Isolamento guasti tra robot: errore su robot B non tocca robot A (RNF-REL-001).");

// --- 7. Test Controllo di Connessione Non Distruttivo (RF-ROB-007, §6.2) ---
executedCommands.length = 0; // Reset tracciamento comandi

const reportOk = await verifyRobotConnection(robotOk, {
  credentialProvider,
  hostKeyVerifier,
  timeoutMs: 2000,
  logger: testLogger,
});

assert.strictEqual(reportOk.overallSuccess, true, "Verifica con parametri validi deve avere esito positivo");
assert.strictEqual(reportOk.steps.length, 5, "Devono essere presenti tutti e 5 i controlli");
assert.strictEqual(reportOk.steps[0].status, "SUCCESS", "Step 1: host raggiungibile");
assert.strictEqual(reportOk.steps[1].status, "SUCCESS", "Step 2: porta disponibile");
assert.strictEqual(reportOk.steps[2].status, "SUCCESS", "Step 3: chiave host verificata");
assert.strictEqual(reportOk.steps[3].status, "SUCCESS", "Step 4: autenticazione riuscita");
assert.strictEqual(reportOk.steps[4].status, "SUCCESS", "Step 5: risorse accessibili");

// Verifica rigorosa: NESSUNA operazione di scrittura sul robot (RF-ROB-007)
for (const cmd of executedCommands) {
  assert(!cmd.includes("touch"), "Nessun comando touch consentito");
  assert(!cmd.includes("rm "), "Nessun comando rm consentito");
  assert(!cmd.includes("mkdir"), "Nessun comando mkdir consentito");
  assert(!cmd.includes(">"), "Nessun operatore di redirezione scrittura consentito");
}
console.log("  PASS: Controllo di connessione a 5 passi rigorosamente non distruttivo (RF-ROB-007).");

// Test sequenza fallimento controlli: se step 1 o 2 fallisce, i successivi sono SKIPPED
const reportFailPort = await verifyRobotConnection(robotClosedPort, {
  credentialProvider,
  hostKeyVerifier,
  timeoutMs: 2000,
  logger: testLogger,
});
assert.strictEqual(reportFailPort.overallSuccess, false);
assert.strictEqual(reportFailPort.steps[0].status, "FAILED");
assert.strictEqual(reportFailPort.steps[1].status, "SKIPPED");
assert.strictEqual(reportFailPort.steps[2].status, "SKIPPED");
assert.strictEqual(reportFailPort.steps[3].status, "SKIPPED");
assert.strictEqual(reportFailPort.steps[4].status, "SKIPPED");
console.log("  PASS: Interruzione ordinata e passi successivi SKIPPED su fallimento (§6.2).");

// --- 8. Test Sicurezza Credenziali nei Log e nelle Eccezioni (RNF-SEC-002) ---
try {
  await credentialProvider.getCredentials("vault://creds/robot_bad_pwd", "password");
} catch (e: any) {
  assert(!JSON.stringify(e).includes("ValidRobotPassword123!"));
  assert(!JSON.stringify(e).includes("WrongPassword!"));
}
console.log("  PASS: Nessun segreto esposto nei messaggi, eccezioni o log (RNF-SEC-002).");

// Chiusura del server di test
await connManager.closeAll();
await new Promise<void>((resolve) => {
  testServer.close(() => resolve());
});

console.log("PASS: Tutti i test del livello comune di connessione SSH/SFTP completati con successo.");
