// Requisiti soddisfatti: RNF-SEC-002, RNF-SEC-009, §10.4, §11.1, RNF-MNT-002

import { ObjectId, type Db, type Collection, type WriteConcernSettings } from "mongodb";
import {
  type AuditEventDocument,
  AuditOperation,
  sanitizeAuditEvent,
} from "./audit-models.ts";
import { MolirisAppError, ErrorCode } from "../errors/app-errors.ts";

export interface AuditQueryFilter {
  userId?: string;
  robotId?: string;
  operation?: AuditOperation;
  outcome?: "SUCCESS" | "FAILURE";
  from?: Date;
  to?: Date;
}

export interface RobotRemovalAudit {
  eventId: string;
  robotId: string;
  robotCreatedAt: Date;
  userId: string;
  serverDirectoryPath: string;
}

type RobotRemovalIntent = Omit<RobotRemovalAudit, "eventId">;

function removalEvent(removal: RobotRemovalAudit): AuditEventDocument {
  return sanitizeAuditEvent({
    id: `audit_${removal.eventId}`,
    userId: removal.userId,
    robotId: removal.robotId,
    operation: AuditOperation.ROBOT_REMOVAL,
    outcome: "SUCCESS",
    timestamp: new Date(),
    details: {
      deletedFromDatabase: true,
      serverDirectoryPreserved: removal.serverDirectoryPath,
    },
  });
}

export interface AuditRepository {
  record(event: Omit<AuditEventDocument, "id">): Promise<AuditEventDocument>;
  query(filter?: AuditQueryFilter): Promise<AuditEventDocument[]>;
  purgeOlderThanDays(retentionDays: number): Promise<number>;
  findRobotRemoval(robotId: string): Promise<RobotRemovalAudit | null>;
  listPendingRobotRemovalIds(signal?: AbortSignal): AsyncIterable<string>;
  beginRobotRemoval(intent: RobotRemovalIntent): Promise<RobotRemovalAudit>;
  recordRobotRemoval(removal: RobotRemovalAudit): Promise<void>;
  clearRobotRemoval(removal: RobotRemovalAudit): Promise<void>;
}

export class InMemoryAuditRepository implements AuditRepository {
  private events: AuditEventDocument[] = [];
  private counter: number = 0;
  private pendingRemovals = new Map<string, RobotRemovalAudit>();

  async record(event: Omit<AuditEventDocument, "id">): Promise<AuditEventDocument> {
    try {
      const sanitized = sanitizeAuditEvent({
        id: `audit_${++this.counter}`,
        ...event,
      });
      this.events.push(sanitized);
      return structuredClone(sanitized);
    } catch (err: any) {
      throw new MolirisAppError(ErrorCode.DB_PERSISTENCE_ERROR, `Errore salvataggio audit in-memory: ${err.message}`);
    }
  }

  async findRobotRemoval(robotId: string): Promise<RobotRemovalAudit | null> {
    return structuredClone(this.pendingRemovals.get(robotId) ?? null);
  }

  async *listPendingRobotRemovalIds(): AsyncIterable<string> {
    yield* this.pendingRemovals.keys();
  }

  async beginRobotRemoval(intent: RobotRemovalIntent): Promise<RobotRemovalAudit> {
    const pending = this.pendingRemovals.get(intent.robotId) ?? {
      ...structuredClone(intent),
      eventId: new ObjectId().toHexString(),
    };
    this.pendingRemovals.set(intent.robotId, pending);
    return structuredClone(pending);
  }

  async recordRobotRemoval(removal: RobotRemovalAudit): Promise<void> {
    const event = removalEvent(removal);
    if (!this.events.some((existing) => existing.id === event.id)) {
      this.events.push(event);
    }
  }

  async clearRobotRemoval(removal: RobotRemovalAudit): Promise<void> {
    if (this.pendingRemovals.get(removal.robotId)?.eventId === removal.eventId) {
      this.pendingRemovals.delete(removal.robotId);
    }
  }

  async query(filter?: AuditQueryFilter): Promise<AuditEventDocument[]> {
    let result = [...this.events];

    if (filter) {
      if (filter.userId) {
        result = result.filter(e => e.userId === filter.userId);
      }
      if (filter.robotId) {
        result = result.filter(e => e.robotId === filter.robotId);
      }
      if (filter.operation) {
        result = result.filter(e => e.operation === filter.operation);
      }
      if (filter.outcome) {
        result = result.filter(e => e.outcome === filter.outcome);
      }
      if (filter.from) {
        result = result.filter(e => e.timestamp >= filter.from!);
      }
      if (filter.to) {
        result = result.filter(e => e.timestamp <= filter.to!);
      }
    }

    return result.map(e => structuredClone(e));
  }

  async purgeOlderThanDays(retentionDays: number): Promise<number> {
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
    const initialCount = this.events.length;
    this.events = this.events.filter(e => e.timestamp >= cutoff);
    return initialCount - this.events.length;
  }
}

export class MongoAuditRepository implements AuditRepository {
  private collection: Collection<AuditEventDocument>;
  private pendingRemovals: Collection<{ _id: string; removal: RobotRemovalAudit }>;
  private removalWriteConcern: WriteConcernSettings;
  private db: Db;

  constructor(db: Db) {
    this.db = db;
    this.collection = db.collection<AuditEventDocument>("audit_events");
    this.pendingRemovals = db.collection("pending_robot_removals");
    this.removalWriteConcern = {
      w: db.writeConcern?.w || "majority",
      journal: true,
      wtimeoutMS: db.writeConcern?.wtimeoutMS || 10_000,
    };
  }

  /**
   * Inizializza gli indici di audit su MongoDB, incluso il vero indice TTL per la retention (RNF-SEC-009, §10.4).
   * Se il periodo di conservazione cambia in configurazione, l'indice viene aggiornato dinamicamente
   * via collMod senza perdita di dati prematura.
   */
  async initIndexes(retentionDays: number = 365): Promise<void> {
    try {
      const retentionSeconds = Math.max(1, retentionDays * 86400);

      // Ispezione indici esistenti per verificare la presenza del TTL su timestamp
      const existingIndexes = await this.collection.indexes().catch(() => []);
      const ttlIndex = existingIndexes.find(
        (idx: any) => idx.key && idx.key.timestamp !== undefined && idx.expireAfterSeconds !== undefined
      );

      if (ttlIndex) {
        if (ttlIndex.expireAfterSeconds !== retentionSeconds) {
          // Aggiornamento dinamico senza cancellare la collezione né perdere eventi
          try {
            await this.db.command({
              collMod: this.collection.collectionName,
              index: {
                keyPattern: ttlIndex.key,
                expireAfterSeconds: retentionSeconds,
              },
            });
          } catch {
            // Se collMod non è supportato per differente keyPattern, ricrea l'indice
            if (ttlIndex.name) {
              await this.collection.dropIndex(ttlIndex.name);
            }
            await this.collection.createIndex({ timestamp: 1 }, { expireAfterSeconds: retentionSeconds, name: "timestamp_ttl" });
          }
        }
      } else {
        await this.collection.createIndex(
          { timestamp: 1 },
          { expireAfterSeconds: retentionSeconds, name: "timestamp_ttl" }
        );
      }

      await this.collection.createIndex({ userId: 1 });
      await this.collection.createIndex({ robotId: 1 });
      await this.collection.createIndex({ operation: 1 });

      // Indici composti per query temporali filtrate per utente o robot (§10.4, audit ottimizzato)
      await this.collection.createIndex({ userId: 1, timestamp: -1 });
      await this.collection.createIndex({ robotId: 1, timestamp: -1 });
    } catch (err: any) {
      throw new MolirisAppError(
        ErrorCode.DB_PERSISTENCE_ERROR,
        `Errore inizializzazione indici audit MongoDB: ${err.message}`
      );
    }
  }

  async record(event: Omit<AuditEventDocument, "id">): Promise<AuditEventDocument> {
    try {
      const sanitized = sanitizeAuditEvent({
        id: `audit_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
        ...event,
      });

      await this.collection.insertOne(structuredClone(sanitized));
      return structuredClone(sanitized);
    } catch (err: any) {
      throw new MolirisAppError(ErrorCode.DB_PERSISTENCE_ERROR, `Errore registrazione evento audit su MongoDB: ${err.message}`);
    }
  }

  async findRobotRemoval(robotId: string): Promise<RobotRemovalAudit | null> {
    return (await this.pendingRemovals.findOne({ _id: robotId }))?.removal ?? null;
  }

  async *listPendingRobotRemovalIds(signal?: AbortSignal): AsyncIterable<string> {
    const pending = this.pendingRemovals.find({}, {
      projection: { _id: 1 }, batchSize: 50, maxTimeMS: 5_000, signal,
    });
    for await (const { _id } of pending) yield _id;
  }

  async beginRobotRemoval(intent: RobotRemovalIntent): Promise<RobotRemovalAudit> {
    const pending = await this.pendingRemovals.findOneAndUpdate(
      { _id: intent.robotId },
      { $setOnInsert: { removal: { ...intent, eventId: new ObjectId().toHexString() } } },
      { upsert: true, returnDocument: "after", writeConcern: this.removalWriteConcern }
    );
    if (!pending) {
      throw new MolirisAppError(ErrorCode.DB_PERSISTENCE_ERROR, "Rimozione robot non registrata.");
    }
    return pending.removal;
  }

  async recordRobotRemoval(removal: RobotRemovalAudit): Promise<void> {
    // L'identità Mongo è già univoca, anche se il primo upsert è riuscito senza risposta.
    await this.collection.updateOne(
      { _id: new ObjectId(removal.eventId) },
      { $setOnInsert: removalEvent(removal) },
      { upsert: true, writeConcern: this.removalWriteConcern }
    );
  }

  async clearRobotRemoval(removal: RobotRemovalAudit): Promise<void> {
    await this.pendingRemovals.deleteOne(
      { _id: removal.robotId, "removal.eventId": removal.eventId },
      { writeConcern: this.removalWriteConcern }
    );
  }

  async query(filter?: AuditQueryFilter): Promise<AuditEventDocument[]> {
    try {
      const mongoFilter: Record<string, unknown> = {};

      if (filter?.userId) mongoFilter.userId = filter.userId;
      if (filter?.robotId) mongoFilter.robotId = filter.robotId;
      if (filter?.operation) mongoFilter.operation = filter.operation;
      if (filter?.outcome) mongoFilter.outcome = filter.outcome;

      if (filter?.from || filter?.to) {
        const timeFilter: Record<string, Date> = {};
        if (filter.from) timeFilter.$gte = filter.from;
        if (filter.to) timeFilter.$lte = filter.to;
        mongoFilter.timestamp = timeFilter;
      }

      const docs = await this.collection.find(mongoFilter, { projection: { _id: 0 } }).sort({ timestamp: -1 }).toArray();
      return docs as AuditEventDocument[];
    } catch (err: any) {
      throw new MolirisAppError(ErrorCode.DB_PERSISTENCE_ERROR, `Errore query audit su MongoDB: ${err.message}`);
    }
  }

  async purgeOlderThanDays(retentionDays: number): Promise<number> {
    try {
      const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
      const res = await this.collection.deleteMany({ timestamp: { $lt: cutoff } });
      return res.deletedCount;
    } catch (err: any) {
      throw new MolirisAppError(ErrorCode.DB_PERSISTENCE_ERROR, `Errore purge audit su MongoDB: ${err.message}`);
    }
  }
}
