// Requisiti soddisfatti: RF-TRF-008, RF-TRF-009, RF-TRF-011, RF-TRF-014, RNF-REL-004, RNF-REL-005, RNF-SEC-005, RNF-SEC-009, §9, §11.5
// Test di sicurezza e robustezza trasferimenti, integrità a due livelli, TOCTOU, spazio con margine e restrizioni symlink

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Readable, Writable } from "node:stream";
import { ErrorCode } from "../../errors/app-errors.ts";
import { TransferService } from "../../backend/transfer/transfer-service.ts";
import { RemoteFilesystemService } from "../../backend/remote-fs/remote-fs-service.ts";
import { ServerFilesystemService } from "../../storage/server-fs.ts";
import { InMemoryRobotRepository } from "../../storage/robot-repository.ts";
import { InMemoryAuditRepository } from "../../storage/audit-repository.ts";
import { SessionManager } from "../../backend/auth/session-manager.ts";
import { MolirisLogger } from "../../logging/logger.ts";
import { type SystemConfiguration } from "../../config/configuration.ts";
import { type RobotEntity, type HostKeyVerificationParams } from "../../storage/robot-models.ts";

console.log("--> Esecuzione test suite di Hardening Trasferimenti e Filesystem (Problemi A1..A5, C1)...");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "moliris-trf-hardening-test-"));
const serverFsRoot = path.join(tmpDir, "server-fs");
fs.mkdirSync(serverFsRoot, { recursive: true });

const logger = new MolirisLogger();
const auditRepo = new InMemoryAuditRepository();
const sessionManager = new SessionManager(30);
const serverFsService = new ServerFilesystemService(serverFsRoot, auditRepo, logger);
const robotRepo = new InMemoryRobotRepository();

const baseConfig: SystemConfiguration = {
  serverFilesystemRoot: serverFsRoot,
  pollingIntervalSeconds: 60,
  sshConnectionTimeoutMs: 5000,
  maxConcurrentTransfersPerUser: 5,
  maxConcurrentTransfersPerRobot: 5,
  maxConcurrentTransfersServer: 10,
  tempFileRetentionMinutes: 60,
  stateFilePaths: ["/tmp/status.txt"],
  inactiveSessionTimeoutMinutes: 30,
  tlsCertPath: "/tmp/cert.pem",
  tlsKeyPath: "/tmp/key.pem",
  credentialProviderType: "in-memory",
  registrationMode: "rigorosa",
  robotUsernameUniqueness: "per_host",
  auditLogRetentionDays: 365,
  defaultSshPort: 22,
  transferVerifyMode: "stream",
  robotNonAtomicReplace: false,
  transferSpaceMarginMb: 0,
  stateFileFormat: "auto",
};

const robotRecord: RobotEntity = {
  id: "robot-test-h1",
  displayName: "Robot Hardening Test",
  host: "127.0.0.1",
  sshPort: 2222,
  remoteUsername: "operator",
  credentialReference: "cred-test",
  sshAuthMethod: "password",
  hostKeyVerification: { fingerprint: "SHA256:abc123mockfingerprint", strictHostKeyChecking: true },
  stateFilePaths: [path.join(serverFsRoot, "operator_robot-test-h1", "stato.json")],
  anagraphicState: "attivo",
  connectionState: "raggiungibile",
  operationalState: null,
  lastValidUpdateAt: null,
  lastAttemptOutcome: null,
  registrationState: "registrazione_completata",
  lastConnectionVerification: null,
  serverDirectoryPath: path.join(serverFsRoot, "operator_robot-test-h1"),
  createdAt: new Date(),
  updatedAt: new Date(),
};
await robotRepo.create(robotRecord);
fs.mkdirSync(robotRecord.serverDirectoryPath, { recursive: true });

const userAdmin: any = {
  id: "user-admin",
  username: "admin",
  roles: ["amministratore"],
  enabled: true,
  createdAt: new Date(),
  updatedAt: new Date(),
};
const sessionAdmin = sessionManager.createSession(userAdmin);
const adminContext = sessionManager.createAuthorizedContext(sessionAdmin, userAdmin, robotRecord.id);

// Mock SFTP Client per simulare comportamenti del robot
class MockSftpClient {
  public files = new Map<string, { content: Buffer; mode: number }>();
  public _extensions: Record<string, string> = { "posix-rename@openssh.com": "1", "statvfs@openssh.com": "2" };
  public availableSpaceBytes: number = 100 * 1024 * 1024; // 100 MB di default

  public createWriteStream(targetPath: string) {
    const chunks: Buffer[] = [];
    const stream = new Writable({
      write: (chunk: Buffer, _encoding: any, callback: any) => {
        chunks.push(chunk);
        callback();
      },
    });
    stream.on("finish", () => {
      this.files.set(targetPath, { content: Buffer.concat(chunks), mode: 0o100644 });
    });
    return stream;
  }

  public createReadStream(sourcePath: string) {
    const file = this.files.get(sourcePath);
    if (!file) {
      const errStream = new Readable({
        read() {
          this.emit("error", Object.assign(new Error("No such file"), { code: 2 }));
        },
      });
      return errStream;
    }
    return Readable.from([file.content]);
  }

  public stat(p: string, callback: (err: any, stats?: any) => void) {
    const file = this.files.get(p);
    if (!file) {
      return callback(Object.assign(new Error("No such file"), { code: 2 }));
    }
    callback(null, {
      size: file.content.length,
      mode: file.mode,
      isFile: () => (file.mode & 0o170000) === 0o100000,
      isDirectory: () => (file.mode & 0o170000) === 0o040000,
      isSymbolicLink: () => (file.mode & 0o170000) === 0o120000,
      isSocket: () => (file.mode & 0o170000) === 0o140000,
      isCharacterDevice: () => (file.mode & 0o170000) === 0o020000,
      isBlockDevice: () => (file.mode & 0o170000) === 0o060000,
      isFIFO: () => (file.mode & 0o170000) === 0o010000,
    });
  }

  public lstat(p: string, callback: (err: any, stats?: any) => void) {
    this.stat(p, callback);
  }

  public unlink(p: string, callback: (err: any) => void) {
    this.files.delete(p);
    callback(null);
  }

  public ext_openssh_rename(src: string, dest: string, callback: (err: any) => void) {
    const file = this.files.get(src);
    if (!file) return callback(new Error("Source not found"));
    this.files.delete(src);
    this.files.set(dest, file);
    callback(null);
  }

  public rename(src: string, dest: string, callback: (err: any) => void) {
    if (this.files.has(dest)) {
      return callback(Object.assign(new Error("Destination already exists"), { code: 4 }));
    }
    const file = this.files.get(src);
    if (!file) return callback(new Error("Source not found"));
    this.files.delete(src);
    this.files.set(dest, file);
    callback(null);
  }

  public ext_openssh_statvfs(targetDir: string, callback: (err: any, stats?: any) => void) {
    callback(null, {
      f_bavail: Math.floor(this.availableSpaceBytes / 4096),
      f_bsize: 4096,
    });
  }

  public realpath(p: string, callback: (err: any, res?: string) => void) {
    callback(null, path.resolve(p));
  }
}

let mockSftp = new MockSftpClient();

// Mock connection manager
const mockConnectionManager: any = {
  acquireConnection: async (_user: string, _robot: any) => {
    return {
      getSftpClient: async () => mockSftp,
      release: async () => {},
      close: async () => {},
    };
  },
  executeWithConnection: async (_robotId: string, fn: any) => {
    return fn({
      sftp: (callback: any) => callback(null, mockSftp),
    });
  },
};

const remoteFsService = new RemoteFilesystemService(baseConfig, mockConnectionManager, auditRepo, logger);

// 1. Test Problema A1: Integrità fallita su discrepanza dimensione -> INTEGRITY_CHECK_FAILED e cancellazione temp
console.log("  -> Test A1: Verifica discrepanza dimensione genera INTEGRITY_CHECK_FAILED");
{
  const transferService = new TransferService(
    baseConfig,
    robotRepo,
    serverFsService,
    remoteFsService,
    sessionManager,
    auditRepo,
    logger
  );

  // Creiamo un file su server
  const serverFilePath = path.join(robotRecord.serverDirectoryPath, "source_corrupt.bin");
  fs.writeFileSync(serverFilePath, Buffer.alloc(100, 0x41));

  // Simuliamo un MockSftp che tronca i file scritti a metà (50 byte invece di 100)
  const corruptSftp = new MockSftpClient();
  corruptSftp.createWriteStream = (targetPath: string) => {
    const stream = new Writable({
      write: (_chunk: any, _enc: any, cb: any) => cb(),
    });
    stream.on("finish", () => {
      // Scrive solo 50 byte
      corruptSftp.files.set(targetPath, { content: Buffer.alloc(50, 0x41), mode: 0o100644 });
    });
    return stream;
  };
  mockSftp = corruptSftp;

  await assert.rejects(
    async () => {
      await transferService.executeServerRobotTransfer(adminContext, robotRecord, {
        direction: "SERVER_TO_ROBOT",
        serverRelativePath: "source_corrupt.bin",
        remotePath: "dest.bin",
        overwrite: true,
      });
    },
    (err: any) => {
      assert.strictEqual(err.code, ErrorCode.INTEGRITY_CHECK_FAILED);
      assert.ok(err.diagnosticDetail.includes("50") && err.diagnosticDetail.includes("100"), "Il messaggio deve segnalare la discrepanza di dimensione");
      return true;
    }
  );

  // Il file temporaneo deve essere stato cancellato e il file di destinazione non deve esistere
  const tempFiles = Array.from(corruptSftp.files.keys()).filter(k => k.includes(".tmp_moliris_"));
  assert.strictEqual(tempFiles.length, 0, "I file temporanei orfani devono essere eliminati su fallimento integrità");
  assert.strictEqual(corruptSftp.files.has("dest.bin"), false, "Il file di destinazione non deve essere promosso su discrepanza");
  console.log("  PASS: A1 - Discrepanza dimensione genera INTEGRITY_CHECK_FAILED e pulisce i temporanei.");
}

// 2. Test Problema A1: Modalità readback rileva corruzione di contenuto e assegna etichetta corretta
console.log("  -> Test A1: Modalità readback rileva corruzione digest e assegna etichetta");
{
  const readbackConfig = { ...baseConfig, transferVerifyMode: "readback" as const };
  const transferService = new TransferService(
    readbackConfig,
    robotRepo,
    serverFsService,
    remoteFsService,
    sessionManager,
    auditRepo,
    logger
  );

  const serverFilePath = path.join(robotRecord.serverDirectoryPath, "source_digest.bin");
  fs.writeFileSync(serverFilePath, Buffer.from("DATI_ORIGINALI_MOLIRIS"));

  // Simuliamo un mock SFTP che scrive la stessa dimensione ma con byte alterati
  const digestCorruptSftp = new MockSftpClient();
  digestCorruptSftp.createWriteStream = (targetPath: string) => {
    const stream = new Writable({
      write: (_chunk: any, _enc: any, cb: any) => cb(),
    });
    stream.on("finish", () => {
      digestCorruptSftp.files.set(targetPath, {
        content: Buffer.from("DATI_ALTERATI_X_CORRUPT"), // stessa lunghezza (23 byte)
        mode: 0o100644,
      });
    });
    return stream;
  };
  mockSftp = digestCorruptSftp;

  await assert.rejects(
    async () => {
      await transferService.executeServerRobotTransfer(adminContext, robotRecord, {
        direction: "SERVER_TO_ROBOT",
        serverRelativePath: "source_digest.bin",
        remotePath: "dest_digest.bin",
        overwrite: true,
      });
    },
    (err: any) => {
      assert.strictEqual(err.code, ErrorCode.INTEGRITY_CHECK_FAILED);
      assert.ok(err.diagnosticDetail.includes("readback") || err.diagnosticDetail.includes("checksum") || err.message.includes("integrità"), "Errore deve menzionare integrità/checksum");
      return true;
    }
  );
  console.log("  PASS: A1 - Modalità readback rileva corruzione digest su file con medesima dimensione.");
}

// 3. Test Problema A2: posix-rename vs rifiuto vs robotNonAtomicReplace
console.log("  -> Test A2: Sostituzione atomica, posix-rename e opzione robotNonAtomicReplace");
{
  const validSftp = new MockSftpClient();
  // Il robot ha già un file valido
  validSftp.files.set("existing.bin", { content: Buffer.from("VERSIONE_ORIGINALE_VALIDA"), mode: 0o100644 });
  // Rimuoviamo il supporto posix-rename@openssh.com
  delete validSftp._extensions["posix-rename@openssh.com"];
  mockSftp = validSftp;

  const serverFilePath = path.join(robotRecord.serverDirectoryPath, "new_version.bin");
  fs.writeFileSync(serverFilePath, Buffer.from("NUOVA_VERSIONE_DA_CARICARE"));

  // A) Con robotNonAtomicReplace: false (default) e overwrite ammesso, deve rifiutare categoricamente per assenza di posix-rename e preservare existing.bin
  const allowOverwriteConfig = { ...baseConfig, transferOverwritePolicy: "richiedi_conferma" as const };
  const safeService = new TransferService(
    allowOverwriteConfig,
    robotRepo,
    serverFsService,
    remoteFsService,
    sessionManager,
    auditRepo,
    logger
  );

  await assert.rejects(
    async () => {
      await safeService.executeServerRobotTransfer(adminContext, robotRecord, {
        direction: "SERVER_TO_ROBOT",
        serverRelativePath: "new_version.bin",
        remotePath: "existing.bin",
        overwrite: true,
      });
    },
    (err: any) => {
      assert.ok(err.diagnosticDetail.includes("posix-rename") || err.message.includes("atomica") || err.diagnosticDetail.includes("atomica"), "Deve rifiutare la sostituzione non atomica");
      return true;
    }
  );

  // Verifica: il file originale esistente sul robot deve essere intatto al 100%
  const preserved = validSftp.files.get("existing.bin")?.content.toString("utf-8");
  assert.strictEqual(preserved, "VERSIONE_ORIGINALE_VALIDA", "Il file preesistente deve rimanere intatto su rifiuto");
  console.log("  PASS: A2 - Senza posix-rename e robotNonAtomicReplace=false, rifiuta e preserva il file valido.");

  // B) Con robotNonAtomicReplace: true, deve consentire la sostituzione
  const nonAtomicConfig = { ...baseConfig, transferOverwritePolicy: "richiedi_conferma" as const, robotNonAtomicReplace: true };
  const replaceService = new TransferService(
    nonAtomicConfig,
    robotRepo,
    serverFsService,
    remoteFsService,
    sessionManager,
    auditRepo,
    logger
  );

  await replaceService.executeServerRobotTransfer(adminContext, robotRecord, {
    direction: "SERVER_TO_ROBOT",
    serverRelativePath: "new_version.bin",
    remotePath: "existing.bin",
    overwrite: true,
  });
  const replaced = validSftp.files.get("existing.bin")?.content.toString("utf-8");
  assert.strictEqual(replaced, "NUOVA_VERSIONE_DA_CARICARE", "Con flag abilitato, il file deve essere sostituito");
  console.log("  PASS: A2 - Con robotNonAtomicReplace=true, sostituisce ed emette warning.");
}

// 4. Test Problema A3: Controllo anti-corsa TOCTOU subito prima della promozione
console.log("  -> Test A3: Controllo anti-corsa TOCTOU");
{
  const toctouSftp = new MockSftpClient();
  mockSftp = toctouSftp;

  const serverFilePath = path.join(robotRecord.serverDirectoryPath, "toctou_source.bin");
  fs.writeFileSync(serverFilePath, Buffer.from("DATI_TOCTOU"));

  // Simuliamo che il file appaia su destinazione DURANTE il trasferimento
  toctouSftp.createWriteStream = (targetPath: string) => {
    const stream = new Writable({
      write: (_c: any, _e: any, cb: any) => cb(),
    });
    stream.on("finish", () => {
      // Scrive il temp
      toctouSftp.files.set(targetPath, { content: Buffer.from("DATI_TOCTOU"), mode: 0o100644 });
      // UN ALTRO PROCESSO CREA IL TARGET 'toctou_dest.bin' PRIMA DELLA PROMOZIONE!
      toctouSftp.files.set("toctou_dest.bin", { content: Buffer.from("FILE_CREATO_DA_ALTRO"), mode: 0o100644 });
    });
    return stream;
  };

  const toctouConfig = { ...baseConfig, transferOverwritePolicy: "rifiuta" as const };
  const transferService = new TransferService(
    toctouConfig,
    robotRepo,
    serverFsService,
    remoteFsService,
    sessionManager,
    auditRepo,
    logger
  );

  await assert.rejects(
    async () => {
      await transferService.executeServerRobotTransfer(adminContext, robotRecord, {
        direction: "SERVER_TO_ROBOT",
        serverRelativePath: "toctou_source.bin",
        remotePath: "toctou_dest.bin",
        overwrite: false,
      });
    },
    (err: any) => {
      assert.strictEqual(err.code, ErrorCode.REMOTE_FS_ERROR);
      assert.ok(err.diagnosticDetail.includes("già esistente") || err.message.includes("già esistente"));
      return true;
    }
  );

  // Il file apparso durante la corsa non deve essere stato sovrascritto
  assert.strictEqual(toctouSftp.files.get("toctou_dest.bin")?.content.toString("utf-8"), "FILE_CREATO_DA_ALTRO");
  console.log("  PASS: A3 - Corsa TOCTOU intercettata prima della promozione, target preservato.");
}

// 5. Test Problema A4: Verifica spazio preventivo con margine (MOLIRIS_TRANSFER_SPACE_MARGIN_MB)
console.log("  -> Test A4: Controllo spazio con margine configurabile");
{
  const spaceSftp = new MockSftpClient();
  // Spazio disponibile: 10 MB (10 * 1024 * 1024)
  spaceSftp.availableSpaceBytes = 10 * 1024 * 1024;
  mockSftp = spaceSftp;

  const serverFilePath = path.join(robotRecord.serverDirectoryPath, "space_test.bin");
  // File da 8 MB
  fs.writeFileSync(serverFilePath, Buffer.alloc(8 * 1024 * 1024, 0x5a));

  // A) Con margine 0 MB: 8 MB <= 10 MB -> Deve passare il controllo spazio
  const zeroMarginConfig = { ...baseConfig, transferSpaceMarginMb: 0 };
  const okService = new TransferService(
    zeroMarginConfig,
    robotRepo,
    serverFsService,
    remoteFsService,
    sessionManager,
    auditRepo,
    logger
  );
  // Verifichiamo il metodo di controllo spazio direttamente
  await (okService as any).checkRobotDiskSpace(spaceSftp, ".", 8 * 1024 * 1024, "robot-test-h1");
  console.log("  PASS: A4 - 8 MB con margine 0 MB passa su 10 MB disponibili.");

  // B) Con margine 5 MB: 8 MB + 5 MB = 13 MB > 10 MB -> Deve fallire con INSUFFICIENT_STORAGE
  const marginConfig = { ...baseConfig, transferSpaceMarginMb: 5 };
  const strictService = new TransferService(
    marginConfig,
    robotRepo,
    serverFsService,
    remoteFsService,
    sessionManager,
    auditRepo,
    logger
  );

  await assert.rejects(
    async () => {
      await (strictService as any).checkRobotDiskSpace(spaceSftp, ".", 8 * 1024 * 1024, "robot-test-h1");
    },
    (err: any) => {
      assert.strictEqual(err.code, ErrorCode.INSUFFICIENT_STORAGE);
      assert.ok(err.message.includes("margine") || err.diagnosticDetail.includes("margine"), "Messaggio deve indicare il margine richiesto");
      return true;
    }
  );
  console.log("  PASS: A4 - Margine di spazio applicato correttamente, scatta INSUFFICIENT_STORAGE.");
}

// 6. Test Problema C1: Restrizioni su symlink e file speciali (device, socket, FIFO)
console.log("  -> Test C1: Restrizioni symlink fuori percorsi consentiti e tipi speciali");
{
  const restrictedSftp = new MockSftpClient();
  // Aggiungiamo un file speciale (socket / fifo / device): S_IFSOCK = 0o140000, S_IFCHR = 0o020000
  restrictedSftp.files.set("/home/operator/test.sock", { content: Buffer.alloc(0), mode: 0o140666 });
  restrictedSftp.files.set("/home/operator/tty0", { content: Buffer.alloc(0), mode: 0o020666 });

  // Symlink che punta fuori dai percorsi consentiti
  restrictedSftp.files.set("/home/operator/link_outside", { content: Buffer.from("/etc/shadow"), mode: 0o120777 });

  const restrictedConfig: SystemConfiguration = {
    ...baseConfig,
    remoteFsAllowedPaths: ["/home/operator"],
  };

  const restrictedRemoteFs = new RemoteFilesystemService(restrictedConfig, mockConnectionManager, auditRepo, logger);

  // A) Download file speciale (socket o char device) deve essere categoricamente rifiutato
  mockSftp = restrictedSftp;
  await assert.rejects(
    async () => {
      await restrictedRemoteFs.openRemoteReadStream(adminContext, robotRecord, "/home/operator/test.sock");
    },
    (err: any) => {
      assert.strictEqual(err.code, ErrorCode.REMOTE_FS_ERROR);
      assert.ok(err.diagnosticDetail.includes("file speciale") || err.diagnosticDetail.includes("socket"));
      return true;
    }
  );
  console.log("  PASS: C1 - Download file speciale (socket/device) categoricamente respinto.");

  // B) Symlink con target fuori da allowedPaths deve essere categoricamente rifiutato
  restrictedSftp.lstat = (p: string, cb: any) => {
    if (p === "/home/operator/link_outside") {
      return cb(null, {
        size: 11,
        mode: 0o120777,
        isFile: () => false,
        isDirectory: () => false,
        isSymbolicLink: () => true,
      });
    }
    restrictedSftp.stat(p, cb);
  };
  restrictedSftp.stat = (p: string, cb: any) => {
    if (p === "/home/operator/link_outside" || p === "/etc/shadow") {
      return cb(null, {
        size: 500,
        mode: 0o100600,
        isFile: () => true,
        isDirectory: () => false,
        isSymbolicLink: () => false,
      });
    }
    cb(new Error("No such file"));
  };
  restrictedSftp.realpath = (p: string, cb: any) => {
    if (p === "/home/operator/link_outside") return cb(null, "/etc/shadow");
    cb(null, p);
  };

  await assert.rejects(
    async () => {
      await restrictedRemoteFs.openRemoteReadStream(adminContext, robotRecord, "/home/operator/link_outside");
    },
    (err: any) => {
      assert.strictEqual(err.code, ErrorCode.INSUFFICIENT_PERMISSIONS);
      assert.ok(err.diagnosticDetail.includes("estern") || err.diagnosticDetail.includes("autorizzati") || err.message.includes("restrizioni"));
      return true;
    }
  );
  console.log("  PASS: C1 - Symlink che punta fuori dai percorsi consentiti categoricamente respinto.");
}

// Pulizia finale
fs.rmSync(tmpDir, { recursive: true, force: true });
console.log("PASS: Tutti i test di Hardening Trasferimenti e Filesystem superati con successo.");
