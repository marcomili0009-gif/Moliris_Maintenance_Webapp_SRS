// Requisiti soddisfatti: RF-TRF-006..013, RNF-MNT-002, RNF-REL-004, RNF-SEC-009
// Persistenza strutturata dello storico dei trasferimenti (attivi, completati, falliti, annullati)
// per garantire coerenza di avanzamento, velocità media ed errori tra refresh pagina, riavvii backend e vista Log.

import { type Db, type Collection } from "mongodb";
import { type TransferDirection, type TransferStatus, TransferStatus as TS } from "../backend/transfer/transfer-models.ts";

export interface TransferHistoryDocument {
  transferId: string;
  batchId?: string;
  userId: string;
  username?: string;
  robotId: string;
  direction: TransferDirection;
  filename: string;
  sourcePath: string;
  destinationPath: string;
  totalBytes: number | null;
  transferredBytes: number;
  percent: number | null;
  status: TransferStatus;
  error: string | null;
  errorCode?: string;
  checksum: string | null;
  checksumAlgorithm: string | null;
  integrityLabel?: string;
  integrityVerification?: {
    verified: boolean;
    label: string;
    mode: "stream" | "readback" | "none";
    details?: string;
  };
  startedAt: string; // ISO 8601
  activeStartedAt: string | null; // ISO 8601 (inizio effettivo trasferimento, esclusa coda)
  completedAt: string | null; // ISO 8601
  durationMs: number | null; // Durata attiva effettiva in ms (escluse coda e pause)
  pausedDurationMs: number;
  currentSpeedBytesPerSec: number | null;
  averageSpeedBytesPerSec: number | null;
  speedBytesPerSec: number | null;
  etaSeconds: number | null;
  /** Se true, nascosto dall'elenco "Recenti" su rimozione utente, ma MAI eliminato dai LOG. */
  hiddenFromRecent?: boolean;
  updatedAt: string; // ISO 8601
}

export interface TransferHistoryFilter {
  userId?: string;
  isAdmin?: boolean;
  robotId?: string;
  batchId?: string;
  status?: string;
  includeHiddenFromRecent?: boolean;
  limit?: number;
  offset?: number;
}

export interface TransferRepository {
  ensureIndexes?(): Promise<void>;
  upsert(doc: TransferHistoryDocument): Promise<void>;
  findById(transferId: string): Promise<TransferHistoryDocument | null>;
  list(filter?: TransferHistoryFilter): Promise<TransferHistoryDocument[]>;
  markHiddenFromRecent(transferId: string): Promise<boolean>;
  markStaleActiveAsInterrupted(reason: string): Promise<number>;
}

const ACTIVE_STATUSES: TransferStatus[] = [
  TS.QUEUED,
  TS.IN_PROGRESS,
  TS.INTEGRITY_CHECKING,
  TS.PAUSED,
];

export class InMemoryTransferRepository implements TransferRepository {
  private docs = new Map<string, TransferHistoryDocument>();

  async upsert(doc: TransferHistoryDocument): Promise<void> {
    const existing = this.docs.get(doc.transferId);
    this.docs.set(doc.transferId, structuredClone({
      ...doc,
      hiddenFromRecent: doc.hiddenFromRecent ?? existing?.hiddenFromRecent ?? false,
    }));
  }

  async findById(transferId: string): Promise<TransferHistoryDocument | null> {
    const doc = this.docs.get(transferId);
    return doc ? structuredClone(doc) : null;
  }

  async list(filter: TransferHistoryFilter = {}): Promise<TransferHistoryDocument[]> {
    let items = Array.from(this.docs.values());
    if (!filter.includeHiddenFromRecent) {
      items = items.filter((d) => !d.hiddenFromRecent);
    }
    if (filter.robotId) {
      items = items.filter((d) => d.robotId === filter.robotId);
    }
    if (filter.batchId) {
      items = items.filter((d) => d.batchId === filter.batchId);
    }
    if (filter.status && filter.status !== "ALL") {
      items = items.filter((d) => d.status === filter.status);
    }
    if (!filter.isAdmin && filter.userId) {
      items = items.filter((d) => d.userId === filter.userId);
    }
    items.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
    const offset = Math.max(0, filter.offset ?? 0);
    const limit = filter.limit && filter.limit > 0 ? filter.limit : items.length;
    return items.slice(offset, offset + limit).map((d) => structuredClone(d));
  }

  async markHiddenFromRecent(transferId: string): Promise<boolean> {
    const existing = this.docs.get(transferId);
    if (!existing) return false;
    existing.hiddenFromRecent = true;
    existing.updatedAt = new Date().toISOString();
    return true;
  }

  async markStaleActiveAsInterrupted(reason: string): Promise<number> {
    let count = 0;
    const now = new Date().toISOString();
    for (const doc of this.docs.values()) {
      if (ACTIVE_STATUSES.includes(doc.status)) {
        doc.status = TS.FAILED;
        doc.error = doc.error || reason;
        doc.completedAt = doc.completedAt || now;
        doc.etaSeconds = null;
        doc.currentSpeedBytesPerSec = null;
        doc.updatedAt = now;
        count++;
      }
    }
    return count;
  }
}

export class MongoTransferRepository implements TransferRepository {
  private collection: Collection<TransferHistoryDocument>;

  constructor(db: Db) {
    this.collection = db.collection<TransferHistoryDocument>("transfers");
  }

  async ensureIndexes(): Promise<void> {
    await this.collection.createIndex({ transferId: 1 }, { unique: true });
    await this.collection.createIndex({ startedAt: -1 });
    await this.collection.createIndex({ batchId: 1, startedAt: -1 });
    await this.collection.createIndex({ userId: 1, startedAt: -1 });
    await this.collection.createIndex({ status: 1, startedAt: -1 });
  }

  async upsert(doc: TransferHistoryDocument): Promise<void> {
    const { hiddenFromRecent, ...rest } = doc;
    const update: Record<string, any> = {
      $set: rest,
      $setOnInsert: { hiddenFromRecent: hiddenFromRecent ?? false },
    };
    if (hiddenFromRecent !== undefined) {
      update.$set.hiddenFromRecent = hiddenFromRecent;
      delete update.$setOnInsert;
    }
    await this.collection.updateOne(
      { transferId: doc.transferId },
      update,
      { upsert: true }
    );
  }

  async findById(transferId: string): Promise<TransferHistoryDocument | null> {
    const doc = await this.collection.findOne({ transferId }, { projection: { _id: 0 } });
    return doc ? (doc as TransferHistoryDocument) : null;
  }

  async list(filter: TransferHistoryFilter = {}): Promise<TransferHistoryDocument[]> {
    const query: Record<string, any> = {};
    if (!filter.includeHiddenFromRecent) {
      query.hiddenFromRecent = { $ne: true };
    }
    if (filter.robotId) {
      query.robotId = filter.robotId;
    }
    if (filter.batchId) {
      query.batchId = filter.batchId;
    }
    if (filter.status && filter.status !== "ALL") {
      query.status = filter.status;
    }
    if (!filter.isAdmin && filter.userId) {
      query.userId = filter.userId;
    }

    const cursor = this.collection
      .find(query, { projection: { _id: 0 } })
      .sort({ startedAt: -1 });
    if (filter.offset && filter.offset > 0) cursor.skip(filter.offset);
    if (filter.limit && filter.limit > 0) cursor.limit(filter.limit);
    return (await cursor.toArray()) as TransferHistoryDocument[];
  }

  async markHiddenFromRecent(transferId: string): Promise<boolean> {
    const res = await this.collection.updateOne(
      { transferId },
      { $set: { hiddenFromRecent: true, updatedAt: new Date().toISOString() } }
    );
    return res.matchedCount > 0;
  }

  async markStaleActiveAsInterrupted(reason: string): Promise<number> {
    const now = new Date().toISOString();
    const res = await this.collection.updateMany(
      { status: { $in: ACTIVE_STATUSES } },
      {
        $set: {
          status: TS.FAILED,
          error: reason,
          completedAt: now,
          etaSeconds: null,
          currentSpeedBytesPerSec: null,
          updatedAt: now,
        },
      }
    );
    return res.modifiedCount;
  }
}
