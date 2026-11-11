// Requisiti soddisfatti: RF-05 (Repository per entità collegate Cliente e Impianto su MongoDB e in-memory)

import crypto from "crypto";
import { type Db, type Collection } from "mongodb";
import { type ClientEntity, type PlantEntity } from "./client-plant-models.ts";
import { MolirisAppError, ErrorCode } from "../errors/app-errors.ts";

export interface ClientRepository {
  initIndexes?(): Promise<void>;
  create(client: ClientEntity): Promise<ClientEntity>;
  findById(id: string): Promise<ClientEntity | null>;
  findByName(name: string): Promise<ClientEntity | null>;
  findOrCreate(name: string): Promise<ClientEntity>;
  list(): Promise<ClientEntity[]>;
}

export interface PlantRepository {
  initIndexes?(): Promise<void>;
  create(plant: PlantEntity): Promise<PlantEntity>;
  findById(id: string): Promise<PlantEntity | null>;
  findByNameAndClient(clientId: string, name: string): Promise<PlantEntity | null>;
  findOrCreate(clientId: string, name: string): Promise<PlantEntity>;
  listByClient(clientId: string): Promise<PlantEntity[]>;
  list(): Promise<PlantEntity[]>;
}

/**
 * Implementazione InMemory di ClientRepository per test veloci e isolati
 */
export class InMemoryClientRepository implements ClientRepository {
  private clients: Map<string, ClientEntity> = new Map();

  async create(client: ClientEntity): Promise<ClientEntity> {
    const existing = await this.findByName(client.name);
    if (existing) {
      throw new MolirisAppError(
        ErrorCode.DB_PERSISTENCE_ERROR,
        `Cliente '${client.name}' già esistente.`
      );
    }
    const cloned = structuredClone(client);
    this.clients.set(cloned.id, cloned);
    return structuredClone(cloned);
  }

  async findById(id: string): Promise<ClientEntity | null> {
    const found = this.clients.get(id);
    return found ? structuredClone(found) : null;
  }

  async findByName(name: string): Promise<ClientEntity | null> {
    const trimmed = name.trim().toLowerCase();
    for (const client of this.clients.values()) {
      if (client.name.trim().toLowerCase() === trimmed) {
        return structuredClone(client);
      }
    }
    return null;
  }

  async findOrCreate(name: string): Promise<ClientEntity> {
    const existing = await this.findByName(name);
    if (existing) return existing;

    const newClient: ClientEntity = {
      id: "cli_" + crypto.randomUUID(),
      name: name.trim(),
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    return this.create(newClient);
  }

  async list(): Promise<ClientEntity[]> {
    return Array.from(this.clients.values()).map((c) => structuredClone(c));
  }
}

/**
 * Implementazione InMemory di PlantRepository
 */
export class InMemoryPlantRepository implements PlantRepository {
  private plants: Map<string, PlantEntity> = new Map();

  async create(plant: PlantEntity): Promise<PlantEntity> {
    const existing = await this.findByNameAndClient(plant.clientId, plant.name);
    if (existing) {
      throw new MolirisAppError(
        ErrorCode.DB_PERSISTENCE_ERROR,
        `Impianto '${plant.name}' già esistente per il cliente '${plant.clientId}'.`
      );
    }
    const cloned = structuredClone(plant);
    this.plants.set(cloned.id, cloned);
    return structuredClone(cloned);
  }

  async findById(id: string): Promise<PlantEntity | null> {
    const found = this.plants.get(id);
    return found ? structuredClone(found) : null;
  }

  async findByNameAndClient(clientId: string, name: string): Promise<PlantEntity | null> {
    const trimmed = name.trim().toLowerCase();
    for (const plant of this.plants.values()) {
      if (plant.clientId === clientId && plant.name.trim().toLowerCase() === trimmed) {
        return structuredClone(plant);
      }
    }
    return null;
  }

  async findOrCreate(clientId: string, name: string): Promise<PlantEntity> {
    const existing = await this.findByNameAndClient(clientId, name);
    if (existing) return existing;

    const newPlant: PlantEntity = {
      id: "plant_" + crypto.randomUUID(),
      clientId,
      name: name.trim(),
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    return this.create(newPlant);
  }

  async listByClient(clientId: string): Promise<PlantEntity[]> {
    const results: PlantEntity[] = [];
    for (const plant of this.plants.values()) {
      if (plant.clientId === clientId) {
        results.push(structuredClone(plant));
      }
    }
    return results;
  }

  async list(): Promise<PlantEntity[]> {
    return Array.from(this.plants.values()).map((p) => structuredClone(p));
  }
}

/**
 * Implementazione MongoDB di ClientRepository (Collezione 'clients')
 */
export class MongoClientRepository implements ClientRepository {
  private collection: Collection<ClientEntity>;

  constructor(db: Db) {
    this.collection = db.collection<ClientEntity>("clients");
  }

  async initIndexes(): Promise<void> {
    try {
      await this.collection.createIndex({ id: 1 }, { unique: true });
      await this.collection.createIndex(
        { name: 1 },
        { unique: true, collation: { locale: "en", strength: 2 }, name: "unique_client_name" }
      );
    } catch (err: any) {
      throw new MolirisAppError(ErrorCode.DB_PERSISTENCE_ERROR, `Errore indici MongoDB clients: ${err.message}`);
    }
  }

  async create(client: ClientEntity): Promise<ClientEntity> {
    try {
      await this.collection.insertOne(structuredClone(client));
      return structuredClone(client);
    } catch (err: any) {
      if (err.code === 11000) {
        throw new MolirisAppError(
          ErrorCode.DB_PERSISTENCE_ERROR,
          `Cliente '${client.name}' già esistente.`
        );
      }
      throw new MolirisAppError(ErrorCode.DB_PERSISTENCE_ERROR, `Errore MongoDB create client: ${err.message}`);
    }
  }

  async findById(id: string): Promise<ClientEntity | null> {
    try {
      const doc = await this.collection.findOne({ id }, { projection: { _id: 0 } });
      return doc ? (doc as ClientEntity) : null;
    } catch (err: any) {
      throw new MolirisAppError(ErrorCode.DB_PERSISTENCE_ERROR, `Errore MongoDB findById client: ${err.message}`);
    }
  }

  async findByName(name: string): Promise<ClientEntity | null> {
    try {
      const doc = await this.collection.findOne(
        { name },
        { projection: { _id: 0 }, collation: { locale: "en", strength: 2 } }
      );
      return doc ? (doc as ClientEntity) : null;
    } catch (err: any) {
      throw new MolirisAppError(ErrorCode.DB_PERSISTENCE_ERROR, `Errore MongoDB findByName client: ${err.message}`);
    }
  }

  async findOrCreate(name: string): Promise<ClientEntity> {
    const existing = await this.findByName(name);
    if (existing) return existing;

    const newClient: ClientEntity = {
      id: "cli_" + crypto.randomUUID(),
      name: name.trim(),
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    try {
      return await this.create(newClient);
    } catch (err: any) {
      const race = await this.findByName(name);
      if (race) return race;
      throw err;
    }
  }

  async list(): Promise<ClientEntity[]> {
    try {
      const docs = await this.collection.find({}, { projection: { _id: 0 } }).toArray();
      return docs as ClientEntity[];
    } catch (err: any) {
      throw new MolirisAppError(ErrorCode.DB_PERSISTENCE_ERROR, `Errore MongoDB list clients: ${err.message}`);
    }
  }
}

/**
 * Implementazione MongoDB di PlantRepository (Collezione 'plants')
 */
export class MongoPlantRepository implements PlantRepository {
  private collection: Collection<PlantEntity>;

  constructor(db: Db) {
    this.collection = db.collection<PlantEntity>("plants");
  }

  async initIndexes(): Promise<void> {
    try {
      await this.collection.createIndex({ id: 1 }, { unique: true });
      await this.collection.createIndex(
        { clientId: 1, name: 1 },
        { unique: true, collation: { locale: "en", strength: 2 }, name: "unique_plant_per_client" }
      );
    } catch (err: any) {
      throw new MolirisAppError(ErrorCode.DB_PERSISTENCE_ERROR, `Errore indici MongoDB plants: ${err.message}`);
    }
  }

  async create(plant: PlantEntity): Promise<PlantEntity> {
    try {
      await this.collection.insertOne(structuredClone(plant));
      return structuredClone(plant);
    } catch (err: any) {
      if (err.code === 11000) {
        throw new MolirisAppError(
          ErrorCode.DB_PERSISTENCE_ERROR,
          `Impianto '${plant.name}' già esistente per il cliente specificato.`
        );
      }
      throw new MolirisAppError(ErrorCode.DB_PERSISTENCE_ERROR, `Errore MongoDB create plant: ${err.message}`);
    }
  }

  async findById(id: string): Promise<PlantEntity | null> {
    try {
      const doc = await this.collection.findOne({ id }, { projection: { _id: 0 } });
      return doc ? (doc as PlantEntity) : null;
    } catch (err: any) {
      throw new MolirisAppError(ErrorCode.DB_PERSISTENCE_ERROR, `Errore MongoDB findById plant: ${err.message}`);
    }
  }

  async findByNameAndClient(clientId: string, name: string): Promise<PlantEntity | null> {
    try {
      const doc = await this.collection.findOne(
        { clientId, name },
        { projection: { _id: 0 }, collation: { locale: "en", strength: 2 } }
      );
      return doc ? (doc as PlantEntity) : null;
    } catch (err: any) {
      throw new MolirisAppError(ErrorCode.DB_PERSISTENCE_ERROR, `Errore MongoDB findByNameAndClient plant: ${err.message}`);
    }
  }

  async findOrCreate(clientId: string, name: string): Promise<PlantEntity> {
    const existing = await this.findByNameAndClient(clientId, name);
    if (existing) return existing;

    const newPlant: PlantEntity = {
      id: "plant_" + crypto.randomUUID(),
      clientId,
      name: name.trim(),
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    try {
      return await this.create(newPlant);
    } catch (err: any) {
      const race = await this.findByNameAndClient(clientId, name);
      if (race) return race;
      throw err;
    }
  }

  async listByClient(clientId: string): Promise<PlantEntity[]> {
    try {
      const docs = await this.collection.find({ clientId }, { projection: { _id: 0 } }).toArray();
      return docs as PlantEntity[];
    } catch (err: any) {
      throw new MolirisAppError(ErrorCode.DB_PERSISTENCE_ERROR, `Errore MongoDB listByClient plants: ${err.message}`);
    }
  }

  async list(): Promise<PlantEntity[]> {
    try {
      const docs = await this.collection.find({}, { projection: { _id: 0 } }).toArray();
      return docs as PlantEntity[];
    } catch (err: any) {
      throw new MolirisAppError(ErrorCode.DB_PERSISTENCE_ERROR, `Errore MongoDB list plants: ${err.message}`);
    }
  }
}
