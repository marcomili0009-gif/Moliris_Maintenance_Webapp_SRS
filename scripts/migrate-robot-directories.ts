// Requisiti soddisfatti: RF-ROB-008, RF-ROB-009, RNF-FS-001..004, RNF-MNT-001, RNF-MNT-002
//
// SCRIPT DI MIGRAZIONE / RIALLINEAMENTO DIRECTORY SERVER DEI ROBOT
// ==============================================================================
// Allinea in modo sicuro e idempotente `robot.serverDirectoryPath` al valore corrente
// di `MOLIRIS_FS_ROOT` dopo lo spostamento del server o il ripristino del database,
// creando le directory mancanti con i permessi `MOLIRIS_DIR_PERMISSIONS` e le
// sottodirectory standard `MOLIRIS_STANDARD_SUBDIRS` senza mai sovrascrivere file.
//
// Uso:
//   npx tsx scripts/migrate-robot-directories.ts             (default: --dry-run)
//   npx tsx scripts/migrate-robot-directories.ts --dry-run
//   npx tsx scripts/migrate-robot-directories.ts --apply

import fs from "fs";
import path from "path";
import { pathToFileURL } from "url";
import { MongoClient } from "mongodb";
import { resolveMongoConfig } from "../config/mongodb.ts";
import { StandardRobotDirectoryNamingPolicy } from "../storage/robot-models.ts";
import { MongoRobotRepository, type RobotRepository } from "../storage/robot-repository.ts";
import { MongoAuditRepository, InMemoryAuditRepository, type AuditRepository } from "../storage/audit-repository.ts";
import { AuditOperation } from "../storage/audit-models.ts";
import { ServerFilesystemService } from "../storage/server-fs.ts";
import { MolirisLogger } from "../logging/logger.ts";

export type MigrationAction =
  | "already_ok"
  | "would_realign"
  | "would_create_dir"
  | "realigned"
  | "created_dir"
  | "skipped_removed"
  | "skipped_collision"
  | "error";

export interface RobotDirectoryMigrationItem {
  robotId: string;
  previousPath: string;
  targetPath: string;
  action: MigrationAction;
  createdSubdirectories?: string[];
  note?: string;
}

export interface RobotDirectoryMigrationReport {
  apply: boolean;
  fsRoot: string;
  directoryPermissions: string;
  standardSubdirectories: string[];
  totalRobots: number;
  realignedCount: number;
  createdDirCount: number;
  alreadyOkCount: number;
  skippedCount: number;
  errorCount: number;
  items: RobotDirectoryMigrationItem[];
}

export interface MigrateRobotDirectoriesOptions {
  robotRepository: RobotRepository;
  auditRepository?: AuditRepository;
  fsRoot: string;
  directoryPermissions?: string;
  standardSubdirectories?: string[];
  apply?: boolean;
  logger?: MolirisLogger;
  actor?: string;
}

function isSafeDirectoryBasename(name: string): boolean {
  return (
    name.length > 0 &&
    name !== "." &&
    name !== ".." &&
    !name.startsWith(".") &&
    name.toLowerCase() !== "general" &&
    !/[/\\\0]/.test(name)
  );
}

/**
 * Esegue il controllo o la migrazione sicura delle directory server dei robot.
 * - Non elimina mai file esistenti né vecchie cartelle (RNF-FS-003, RNF-FS-004).
 * - Rileva e previene collisioni tra robot prima di scrivere sul DB (RF-ROB-006, §8.2).
 * - Idempotente su esecuzioni ripetute.
 */
export async function migrateRobotDirectories(
  options: MigrateRobotDirectoriesOptions
): Promise<RobotDirectoryMigrationReport> {
  const apply = options.apply === true;
  const fsRoot = path.resolve(options.fsRoot.trim());
  const directoryPermissions = options.directoryPermissions?.trim() || "0750";
  const standardSubdirectories =
    options.standardSubdirectories && options.standardSubdirectories.length > 0
      ? options.standardSubdirectories
      : ["upload", "download", "shared", "logs", "configs", "backups"];
  const logger = options.logger || new MolirisLogger();
  const auditRepository = options.auditRepository || new InMemoryAuditRepository();
  const actor = options.actor || "system_migration_script";

  const namingPolicy = new StandardRobotDirectoryNamingPolicy();
  const serverFs = new ServerFilesystemService(fsRoot, auditRepository, logger);
  const robots = await options.robotRepository.list();

  // Traccia tutti i target path già assegnati o prenotati durante questo run per prevenire collisioni
  const reservedPaths = new Map<string, string>(); // normalizedTargetPath -> robotId
  for (const r of robots) {
    if (r.serverDirectoryPath && serverFs.isRobotDirectoryUnderFsRoot(r.serverDirectoryPath)) {
      reservedPaths.set(path.resolve(r.serverDirectoryPath), r.id);
    }
  }

  const items: RobotDirectoryMigrationItem[] = [];
  let realignedCount = 0;
  let createdDirCount = 0;
  let alreadyOkCount = 0;
  let skippedCount = 0;
  let errorCount = 0;

  for (const robot of robots) {
    if (robot.anagraphicState === "rimosso") {
      skippedCount++;
      items.push({
        robotId: robot.id,
        previousPath: robot.serverDirectoryPath,
        targetPath: robot.serverDirectoryPath,
        action: "skipped_removed",
        note: "Robot rimosso dall'anagrafica attiva: directory preservata senza modifiche.",
      });
      continue;
    }

    const previousPath = robot.serverDirectoryPath || "";
    const isUnderRoot = serverFs.isRobotDirectoryUnderFsRoot(previousPath);

    let targetPath: string;
    if (isUnderRoot) {
      targetPath = path.resolve(previousPath);
    } else {
      const standardPath = path.resolve(
        namingPolicy.resolveDirectoryPath(fsRoot, {
          id: robot.id,
          remoteUsername: robot.remoteUsername,
          host: robot.host,
        })
      );
      const rawBase = previousPath ? path.basename(previousPath.trim()) : "";
      const preferredPath = isSafeDirectoryBasename(rawBase)
        ? path.resolve(fsRoot, rawBase)
        : standardPath;

      const ownerPreferred = reservedPaths.get(preferredPath);
      if (!ownerPreferred || ownerPreferred === robot.id) {
        targetPath = preferredPath;
      } else {
        const ownerStandard = reservedPaths.get(standardPath);
        if (!ownerStandard || ownerStandard === robot.id) {
          targetPath = standardPath;
        } else {
          skippedCount++;
          items.push({
            robotId: robot.id,
            previousPath,
            targetPath: preferredPath,
            action: "skipped_collision",
            note: `Collisione rilevata: '${preferredPath}' è già assegnato al robot '${ownerPreferred}' e '${standardPath}' a '${ownerStandard}'.`,
          });
          continue;
        }
      }
      reservedPaths.set(targetPath, robot.id);
    }

    const needsPathUpdate = !isUnderRoot || path.resolve(previousPath) !== targetPath;
    const missingRootDir = !fs.existsSync(targetPath);
    const missingSubdirs = standardSubdirectories.filter(
      (sub) => !fs.existsSync(path.join(targetPath, sub))
    );
    const needsFsCreate = missingRootDir || missingSubdirs.length > 0;

    if (!needsPathUpdate && !needsFsCreate) {
      alreadyOkCount++;
      items.push({
        robotId: robot.id,
        previousPath,
        targetPath,
        action: "already_ok",
      });
      continue;
    }

    if (!apply) {
      items.push({
        robotId: robot.id,
        previousPath,
        targetPath,
        action: needsPathUpdate ? "would_realign" : "would_create_dir",
        createdSubdirectories: missingSubdirs,
        note: needsPathUpdate
          ? `Dry-run: serverDirectoryPath verrebbe riallineato sotto '${fsRoot}'.`
          : `Dry-run: verrebbero create directory/sottodirectory mancanti.`,
      });
      if (needsPathUpdate) realignedCount++;
      else createdDirCount++;
      continue;
    }

    try {
      let currentRobot = robot;
      if (needsPathUpdate) {
        currentRobot = await options.robotRepository.updateServerDirectoryPath(robot.id, targetPath);
      }
      const dirResult = await serverFs.ensureRobotDirectory(currentRobot, {
        standardSubdirectories,
        directoryPermissions,
      });

      await auditRepository.record({
        userId: actor,
        operation: AuditOperation.ROBOT_UPDATE,
        robotId: robot.id,
        outcome: "SUCCESS",
        timestamp: new Date(),
        details: {
          action: "MIGRATE_ROBOT_DIRECTORY",
          pathUpdated: needsPathUpdate,
          folderName: path.basename(targetPath),
          created: dirResult.created,
          standardSubdirectoriesCreated: dirResult.standardSubdirectoriesCreated,
        },
      });

      if (needsPathUpdate) {
        realignedCount++;
        items.push({
          robotId: robot.id,
          previousPath,
          targetPath,
          action: "realigned",
          createdSubdirectories: dirResult.standardSubdirectoriesCreated,
        });
      } else {
        createdDirCount++;
        items.push({
          robotId: robot.id,
          previousPath,
          targetPath,
          action: "created_dir",
          createdSubdirectories: dirResult.standardSubdirectoriesCreated,
        });
      }
    } catch (err: any) {
      errorCount++;
      items.push({
        robotId: robot.id,
        previousPath,
        targetPath,
        action: "error",
        note: err?.message || String(err),
      });
    }
  }

  return {
    apply,
    fsRoot,
    directoryPermissions,
    standardSubdirectories,
    totalRobots: robots.length,
    realignedCount,
    createdDirCount,
    alreadyOkCount,
    skippedCount,
    errorCount,
    items,
  };
}

async function runCli(): Promise<void> {
  await import("dotenv/config");
  const args = new Set(process.argv.slice(2));
  const apply = args.has("--apply");

  const fsRoot = process.env.MOLIRIS_FS_ROOT?.trim();
  if (!fsRoot) {
    console.error("ERRORE: variabile d'ambiente MOLIRIS_FS_ROOT non impostata.");
    process.exit(1);
  }

  const directoryPermissions = process.env.MOLIRIS_DIR_PERMISSIONS?.trim() || "0750";
  const rawSubdirs = process.env.MOLIRIS_STANDARD_SUBDIRS?.trim();
  const standardSubdirectories = rawSubdirs
    ? rawSubdirs.split(",").map((s) => s.trim()).filter(Boolean)
    : ["upload", "download", "shared", "logs", "configs", "backups"];

  const mongoConfig = resolveMongoConfig(process.env);
  const client = new MongoClient(mongoConfig.uri);
  const logger = new MolirisLogger();

  try {
    await client.connect();
    const db = client.db(mongoConfig.dbName);
    const robotRepository = new MongoRobotRepository(db);
    const auditRepository = new MongoAuditRepository(db);

    const report = await migrateRobotDirectories({
      robotRepository,
      auditRepository,
      fsRoot,
      directoryPermissions,
      standardSubdirectories,
      apply,
      logger,
    });

    console.log("==========================================================================");
    console.log(
      `MOLIRIS - MIGRAZIONE DIRECTORY SERVER ROBOT (${report.apply ? "APPLY" : "DRY-RUN"})`
    );
    console.log("==========================================================================");
    console.log(`MOLIRIS_FS_ROOT       : ${report.fsRoot}`);
    console.log(`Permessi directory    : ${report.directoryPermissions}`);
    console.log(`Sottodirectory std    : ${report.standardSubdirectories.join(", ")}`);
    console.log(`Robot esaminati       : ${report.totalRobots}`);
    console.log(`Riallineati / da all. : ${report.realignedCount}`);
    console.log(`Directory create      : ${report.createdDirCount}`);
    console.log(`Già conformi          : ${report.alreadyOkCount}`);
    console.log(`Saltati (rimossi/coll): ${report.skippedCount}`);
    console.log(`Errori                : ${report.errorCount}`);
    console.log("--------------------------------------------------------------------------");
    for (const item of report.items) {
      console.log(
        `[${item.action.toUpperCase()}] robot=${item.robotId} | ${item.previousPath} -> ${item.targetPath}${item.note ? ` (${item.note})` : ""}`
      );
    }
    if (!report.apply && (report.realignedCount > 0 || report.createdDirCount > 0)) {
      console.log("\nNessuna modifica applicata (modalità --dry-run). Eseguire con --apply per applicare.");
    }
    if (report.errorCount > 0) {
      process.exitCode = 1;
    }
  } finally {
    await client.close().catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runCli().catch((err) => {
    console.error("Errore fatale durante la migrazione delle directory robot:", err?.message || err);
    process.exit(1);
  });
}
