// Requisiti soddisfatti: RNF-SEC-002, RNF-SEC-009, §10.4, §11.1, RNF-MNT-002

import { type Db, type Collection } from "mongodb";
import {
  type AuditEventDocument,
  type AuditOperation,
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

export interface AuditRepository {
  record(event: Omit<AuditEventDocument, "id">): Promise<AuditEventDocument>;
  query(filter?: AuditQueryFilter): Promise<AuditEventDocument[]>;
  purgeOlderThanDays(retentionDays: number): Promise<number>;
}

export class InMemoryAuditRepository implements AuditRepository {
  private events: AuditEventDocument[] = [];
  private counter: number = 0;

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
  private db: Db;

  constructor(db: Db) {
    this.db = db;
    this.collection = db.collection<AuditEventDocument>("audit_events");
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
            await this.collection.dropIndex(ttlIndex.name);
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
