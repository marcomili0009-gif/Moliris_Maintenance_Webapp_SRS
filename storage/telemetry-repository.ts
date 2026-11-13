// Requisiti soddisfatti: Miglioria Architetturale 3 - Separazione Storico Telemetria Robot (RF-MON-001..006, §10.2)
// Isola la persistenza ad alta frequenza dei controlli periodici dalla scheda anagrafica principale del robot.

import { type Db, type Collection } from "mongodb";
import { type ConnectionState, type OperationalState, type LastAttemptOutcome } from "./robot-models.ts";
import { MolirisAppError, ErrorCode } from "../errors/app-errors.ts";

/**
 * Singolo record di controllo telemetrico/monitoraggio periodico
 */
export interface RobotTelemetryRecord {
  id: string;
  robotId: string;
  timestamp: Date;
  connectionState: ConnectionState;
  operationalState?: OperationalState;
  lastAttemptOutcome?: LastAttemptOutcome | null;
  createdAt: Date;
}

export interface TelemetryRepository {
  initIndexes?(retentionDays?: number): Promise<void>;
  record(telemetry: Omit<RobotTelemetryRecord, "id" | "createdAt">): Promise<RobotTelemetryRecord>;
  getLatestByRobot(robotId: string): Promise<RobotTelemetryRecord | null>;
  queryHistory(robotId: string, limit?: number): Promise<RobotTelemetryRecord[]>;
}

/**
 * Implementazione InMemory per suite di test veloci e disaccoppiate
 */
export class InMemoryTelemetryRepository implements TelemetryRepository {
  private records: RobotTelemetryRecord[] = [];
  private counter = 0;

  async record(telemetry: Omit<RobotTelemetryRecord, "id" | "createdAt">): Promise<RobotTelemetryRecord> {
    const doc: RobotTelemetryRecord = {
      id: `tel_${++this.counter}_${Date.now()}`,
      ...structuredClone(telemetry),
      createdAt: new Date(),
    };
    this.records.push(doc);
    return structuredClone(doc);
  }

  async getLatestByRobot(robotId: string): Promise<RobotTelemetryRecord | null> {
    const robotRecords = this.records
      .filter((r) => r.robotId === robotId)
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
    return robotRecords[0] ? structuredClone(robotRecords[0]) : null;
  }

  async queryHistory(robotId: string, limit = 50): Promise<RobotTelemetryRecord[]> {
    return this.records
      .filter((r) => r.robotId === robotId)
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
      .slice(0, limit)
      .map((r) => structuredClone(r));
  }
}

/**
 * Implementazione MongoDB della collection robot_telemetry_history
 * con indice composto ordinato su { robotId: 1, timestamp: -1 } e indice TTL opzionale.
 */
export class MongoTelemetryRepository implements TelemetryRepository {
  private collection: Collection<RobotTelemetryRecord>;

  constructor(db: Db, collectionName = "robot_telemetry_history") {
    this.collection = db.collection<RobotTelemetryRecord>(collectionName);
  }

  async initIndexes(retentionDays = 90): Promise<void> {
    try {
      // 1. Indice composto fondamentale per interrogazioni temporali veloci per robot
      await this.collection.createIndex({ robotId: 1, timestamp: -1 });

      // 2. Indice TTL automatico per eliminare lo storico di telemetria più vecchio di N giorni
      const retentionSeconds = retentionDays * 86400;
      await this.collection.createIndex(
        { timestamp: 1 },
        { expireAfterSeconds: retentionSeconds, name: "telemetry_ttl" }
      );
    } catch (err: any) {
      throw new MolirisAppError(
        ErrorCode.DB_PERSISTENCE_ERROR,
        `Errore inizializzazione indici telemetria MongoDB: ${err.message}`
      );
    }
  }

  async record(telemetry: Omit<RobotTelemetryRecord, "id" | "createdAt">): Promise<RobotTelemetryRecord> {
    try {
      const doc: RobotTelemetryRecord = {
        id: `tel_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
        ...structuredClone(telemetry),
        createdAt: new Date(),
      };
      await this.collection.insertOne(structuredClone(doc));
      return structuredClone(doc);
    } catch (err: any) {
      throw new MolirisAppError(
        ErrorCode.DB_PERSISTENCE_ERROR,
        `Errore inserimento telemetria su MongoDB: ${err.message}`
      );
    }
  }

  async getLatestByRobot(robotId: string): Promise<RobotTelemetryRecord | null> {
    try {
      const doc = await this.collection.findOne(
        { robotId },
        { sort: { timestamp: -1 }, projection: { _id: 0 } }
      );
      return doc ? (doc as RobotTelemetryRecord) : null;
    } catch (err: any) {
      throw new MolirisAppError(
        ErrorCode.DB_PERSISTENCE_ERROR,
        `Errore lettura ultimo stato telemetria MongoDB: ${err.message}`
      );
    }
  }

  async queryHistory(robotId: string, limit = 50): Promise<RobotTelemetryRecord[]> {
    try {
      const docs = await this.collection
        .find({ robotId }, { projection: { _id: 0 } })
        .sort({ timestamp: -1 })
        .limit(limit)
        .toArray();
      return docs as RobotTelemetryRecord[];
    } catch (err: any) {
      throw new MolirisAppError(
        ErrorCode.DB_PERSISTENCE_ERROR,
        `Errore query storico telemetria MongoDB: ${err.message}`
      );
    }
  }
}
