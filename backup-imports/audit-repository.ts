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

  constructor(db: Db) {
    this.collection = db.collection<AuditEventDocument>("audit_events");
  }

  async initIndexes(): Promise<void> {
    try {
      await this.collection.createIndex({ timestamp: -1 });
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
