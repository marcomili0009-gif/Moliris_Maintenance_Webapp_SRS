// Requisiti soddisfatti: RNF-MNT-002, RF-AUTH-001, RNF-SEC-002, SRS §9, §10.1

import { type Db, type Collection } from "mongodb";
import { type UserEntity } from "./user-models.ts";
import { MolirisAppError, ErrorCode } from "../../errors/app-errors.ts";

export interface UserRepository {
  findByUsername(username: string): Promise<UserEntity | null>;
  findById(id: string): Promise<UserEntity | null>;
  create(user: UserEntity): Promise<UserEntity>;
  update(id: string, update: Partial<UserEntity>): Promise<UserEntity>;
}

export class InMemoryUserRepository implements UserRepository {
  private users: Map<string, UserEntity> = new Map();
  private pendingUsernames: Set<string> = new Set();

  async findByUsername(username: string): Promise<UserEntity | null> {
    for (const u of this.users.values()) {
      if (u.username.toLowerCase() === username.toLowerCase()) {
        return structuredClone(u);
      }
    }
    return null;
  }

  async findById(id: string): Promise<UserEntity | null> {
    const user = this.users.get(id);
    return user ? structuredClone(user) : null;
  }

  async create(user: UserEntity): Promise<UserEntity> {
    const lower = user.username.toLowerCase();
    if (this.pendingUsernames.has(lower)) {
      throw new MolirisAppError(
        ErrorCode.DB_PERSISTENCE_ERROR,
        `Nome utente '${user.username}' già utilizzato. Scegliere uno username differente.`,
        `Nome utente '${user.username}' già utilizzato. Scegliere uno username differente.`
      );
    }
    this.pendingUsernames.add(lower);
    try {
      const existing = await this.findByUsername(user.username);
      if (existing) {
        throw new MolirisAppError(
          ErrorCode.DB_PERSISTENCE_ERROR,
          `Nome utente '${user.username}' già utilizzato. Scegliere uno username differente.`,
          `Nome utente '${user.username}' già utilizzato. Scegliere uno username differente.`
        );
      }
      const cloned = structuredClone(user);
      this.users.set(cloned.id, cloned);
      return structuredClone(cloned);
    } finally {
      this.pendingUsernames.delete(lower);
    }
  }

  async update(id: string, update: Partial<UserEntity>): Promise<UserEntity> {
    const existing = this.users.get(id);
    if (!existing) {
      throw new MolirisAppError(ErrorCode.DB_PERSISTENCE_ERROR, `Utente non trovato per id: ${id}`);
    }
    const updated: UserEntity = {
      ...existing,
      ...update,
      updatedAt: new Date(),
    };
    this.users.set(id, updated);
    return structuredClone(updated);
  }
}

export class MongoUserRepository implements UserRepository {
  private collection: Collection<UserEntity>;

  constructor(db: Db) {
    this.collection = db.collection<UserEntity>("users");
  }

  async initIndexes(): Promise<void> {
    try {
      await this.collection.createIndex(
        { username: 1 },
        { unique: true, collation: { locale: "en", strength: 2 }, name: "unique_username_case_insensitive" }
      );
      await this.collection.createIndex({ id: 1 }, { unique: true });
    } catch (err: any) {
      throw new MolirisAppError(ErrorCode.DB_PERSISTENCE_ERROR, `Errore inizializzazione indici utenti: ${err.message}`);
    }
  }

  async findByUsername(username: string): Promise<UserEntity | null> {
    try {
      const doc = await this.collection.findOne(
        { username },
        { projection: { _id: 0 }, collation: { locale: "en", strength: 2 } }
      );
      return doc ? (doc as UserEntity) : null;
    } catch (err: any) {
      throw new MolirisAppError(ErrorCode.DB_PERSISTENCE_ERROR, `Errore query utente per username: ${err.message}`);
    }
  }

  async findById(id: string): Promise<UserEntity | null> {
    try {
      const doc = await this.collection.findOne({ id }, { projection: { _id: 0 } });
      return doc ? (doc as UserEntity) : null;
    } catch (err: any) {
      throw new MolirisAppError(ErrorCode.DB_PERSISTENCE_ERROR, `Errore query utente per id: ${err.message}`);
    }
  }

  async create(user: UserEntity): Promise<UserEntity> {
    const existing = await this.findByUsername(user.username);
    if (existing) {
      throw new MolirisAppError(
        ErrorCode.DB_PERSISTENCE_ERROR,
        `Nome utente '${user.username}' già utilizzato. Scegliere uno username differente.`,
        `Nome utente '${user.username}' già utilizzato. Scegliere uno username differente.`
      );
    }
    try {
      await this.collection.insertOne(structuredClone(user));
      return structuredClone(user);
    } catch (err: any) {
      if (err.code === 11000) {
        throw new MolirisAppError(
          ErrorCode.DB_PERSISTENCE_ERROR,
          `Nome utente '${user.username}' già utilizzato. Scegliere uno username differente.`,
          `Nome utente '${user.username}' già utilizzato. Scegliere uno username differente.`
        );
      }
      throw new MolirisAppError(ErrorCode.DB_PERSISTENCE_ERROR, `Errore creazione utente: ${err.message}`);
    }
  }

  async update(id: string, update: Partial<UserEntity>): Promise<UserEntity> {
    try {
      const result = await this.collection.findOneAndUpdate(
        { id },
        {
          $set: {
            ...update,
            updatedAt: new Date(),
          },
        },
        { returnDocument: "after", projection: { _id: 0 } }
      );
      if (!result) {
        throw new MolirisAppError(ErrorCode.DB_PERSISTENCE_ERROR, `Utente non trovato per id: ${id}`);
      }
      return result as UserEntity;
    } catch (err: any) {
      throw new MolirisAppError(ErrorCode.DB_PERSISTENCE_ERROR, `Errore aggiornamento utente: ${err.message}`);
    }
  }
}
