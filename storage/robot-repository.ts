// Requisiti soddisfatti: RNF-MNT-002, RF-ROB-001, RF-ROB-002, RF-ROB-003, RF-ROB-005,
// RF-ROB-006, RF-ROB-008, RF-ROB-010, RF-ROB-012, RF-ROB-013, RF-ROB-014, RF-MON-005,
// RNF-SEC-002, RNF-REL-002, SRS §8.2, §8.3, §8.4, §9, §10.1, §10.2, CA-ROB-003, CA-ROB-006, CA-ROB-011, CA-MON-004

import { type Db, type Collection } from "mongodb";
import {
  type RobotEntity,
  type AnagraphicState,
  type ConnectionState,
  type OperationalState,
  type LastAttemptOutcome,
  type RegistrationState,
  type ConnectionVerificationInfo,
  type HostKeyVerificationParams,
  type SftpParameters,
} from "./robot-models.ts";
import { MolirisAppError, ErrorCode } from "../errors/app-errors.ts";

/**
 * Parametri aggiornabili della configurazione (§8.3)
 */
export interface RobotConfigurationUpdate {
  displayName?: string;
  host?: string;
  sshPort?: number;
  sshAuthMethod?: "key" | "password";
  credentialReference?: string;
  hostKeyVerification?: HostKeyVerificationParams;
  stateFilePaths?: string[];
  remoteMonitoringPath?: string;
  sftpParameters?: SftpParameters;
  customParameters?: Record<string, unknown>;
  clientId?: string;
  customerName?: string;
  plantId?: string;
  plantName?: string;
}

/**
 * Interfaccia astratta del repository Robot (RNF-MNT-002)
 * Disaccoppia la logica applicativa dai dettagli di persistenza (MongoDB o InMemory).
 */
export interface RobotRepository {
  create(robot: RobotEntity): Promise<RobotEntity>;
  findById(id: string): Promise<RobotEntity | null>;
  findByUsername(remoteUsername: string): Promise<RobotEntity | null>;
  findByServerDirectory(serverDirectoryPath: string): Promise<RobotEntity | null>;
  findByHostPortUsername(host: string, sshPort: number, remoteUsername: string): Promise<RobotEntity | null>;
  list(): Promise<RobotEntity[]>;
  updateConfiguration(id: string, update: RobotConfigurationUpdate): Promise<RobotEntity>;
  updateConnectionState(id: string, connectionState: ConnectionState, outcome?: LastAttemptOutcome): Promise<RobotEntity>;
  updateOperationalState(id: string, operationalState: OperationalState, lastValidUpdateAt: Date): Promise<RobotEntity>;
  updateLastAttempt(id: string, outcome: LastAttemptOutcome): Promise<RobotEntity>;
  updateAnagraphicState(id: string, newState: AnagraphicState): Promise<RobotEntity>;
  updateRegistrationState(id: string, regState: RegistrationState, verificationInfo?: ConnectionVerificationInfo): Promise<RobotEntity>;
}

/**
 * Implementazione InMemory di RobotRepository.
 * Garantisce l'esecuzione di test deterministici, veloci e isolati (RNF-MNT-002).
 */
export class InMemoryRobotRepository implements RobotRepository {
  private robots: Map<string, RobotEntity> = new Map();
  private usernameUniqueness: "per_host" | "globale";

  constructor(usernameUniqueness: "per_host" | "globale" = "per_host") {
    this.usernameUniqueness = usernameUniqueness;
  }

  async create(robot: RobotEntity): Promise<RobotEntity> {
    try {
      // 1. Unicità identificativo robot su TUTTI i record, compresi i rimossi (RF-ROB-006, Problema 1d)
      if (this.robots.has(robot.id)) {
        throw new MolirisAppError(
          ErrorCode.MISSING_ROBOT_PARAMS,
          `Violazione unicità: identificativo robot '${robot.id}' già registrato.`
        );
      }

      for (const existing of this.robots.values()) {
        // 2. Unicità directory server derivata su TUTTI i record, compresi i rimossi (RF-ROB-008, Problema 1d)
        if (existing.serverDirectoryPath === robot.serverDirectoryPath) {
          throw new MolirisAppError(
            ErrorCode.MISSING_ROBOT_PARAMS,
            `Violazione unicità directory server (§8.2): '${robot.serverDirectoryPath}' già assegnata a un altro robot.`
          );
        }

        // 3. Unicità combinazione (host, porta SSH, username remoto) tra robot NON rimossi (Problema 1b, 1d)
        if (existing.anagraphicState !== "rimosso") {
          if (
            existing.host === robot.host &&
            existing.sshPort === robot.sshPort &&
            existing.remoteUsername === robot.remoteUsername
          ) {
            throw new MolirisAppError(
              ErrorCode.MISSING_ROBOT_PARAMS,
              `Violazione unicità: account remoto '${robot.remoteUsername}' già registrato sullo stesso host '${robot.host}:${robot.sshPort}'.`
            );
          }
        }

        // 4. Se modalità globale: lo username non può essere duplicato in tutta la flotta
        if (this.usernameUniqueness === "globale") {
          if (existing.remoteUsername === robot.remoteUsername) {
            throw new MolirisAppError(
              ErrorCode.MISSING_ROBOT_PARAMS,
              `Violazione unicità (RF-ROB-006 globale): username remoto '${robot.remoteUsername}' già in uso.`
            );
          }
        }
      }

      const entity: RobotEntity = structuredClone(robot);
      this.robots.set(entity.id, entity);
      return structuredClone(entity);
    } catch (err: any) {
      if (err instanceof MolirisAppError) throw err;
      throw new MolirisAppError(ErrorCode.DB_PERSISTENCE_ERROR, `Errore creazione robot in-memory: ${err.message}`);
    }
  }

  async findById(id: string): Promise<RobotEntity | null> {
    const robot = this.robots.get(id);
    return robot ? structuredClone(robot) : null;
  }

  async findByUsername(remoteUsername: string): Promise<RobotEntity | null> {
    for (const robot of this.robots.values()) {
      if (robot.remoteUsername === remoteUsername) {
        return structuredClone(robot);
      }
    }
    return null;
  }

  async findByServerDirectory(serverDirectoryPath: string): Promise<RobotEntity | null> {
    for (const robot of this.robots.values()) {
      if (robot.serverDirectoryPath === serverDirectoryPath) {
        return structuredClone(robot);
      }
    }
    return null;
  }

  async findByHostPortUsername(host: string, sshPort: number, remoteUsername: string): Promise<RobotEntity | null> {
    for (const robot of this.robots.values()) {
      if (
        robot.anagraphicState !== "rimosso" &&
        robot.host === host &&
        robot.sshPort === sshPort &&
        robot.remoteUsername === remoteUsername
      ) {
        return structuredClone(robot);
      }
    }
    return null;
  }

  async list(): Promise<RobotEntity[]> {
    return Array.from(this.robots.values()).map(r => structuredClone(r));
  }

  async updateConfiguration(id: string, update: RobotConfigurationUpdate): Promise<RobotEntity> {
    const existing = this.robots.get(id);
    if (!existing) {
      throw new MolirisAppError(ErrorCode.MISSING_ROBOT_PARAMS, `Robot non trovato per id: ${id}`);
    }

    const updated: RobotEntity = {
      ...existing,
      ...update,
      updatedAt: new Date(),
    };
    if (update.customerName === "" || update.customerName === null) {
      delete updated.customerName;
      delete updated.clientId;
    }
    if (update.plantName === "" || update.plantName === null) {
      delete updated.plantName;
      delete updated.plantId;
    }
    this.robots.set(id, updated);
    return structuredClone(updated);
  }

  async updateConnectionState(id: string, connectionState: ConnectionState, outcome?: LastAttemptOutcome): Promise<RobotEntity> {
    const existing = this.robots.get(id);
    if (!existing) {
      throw new MolirisAppError(ErrorCode.MISSING_ROBOT_PARAMS, `Robot non trovato per id: ${id}`);
    }

    const updated: RobotEntity = {
      ...existing,
      connectionState,
      lastAttemptOutcome: outcome !== undefined ? outcome : existing.lastAttemptOutcome,
      updatedAt: new Date(),
    };
    this.robots.set(id, updated);
    return structuredClone(updated);
  }

  async updateOperationalState(id: string, operationalState: OperationalState, lastValidUpdateAt: Date): Promise<RobotEntity> {
    const existing = this.robots.get(id);
    if (!existing) {
      throw new MolirisAppError(ErrorCode.MISSING_ROBOT_PARAMS, `Robot non trovato per id: ${id}`);
    }

    const updated: RobotEntity = {
      ...existing,
      operationalState,
      lastValidUpdateAt,
      updatedAt: new Date(),
    };
    this.robots.set(id, updated);
    return structuredClone(updated);
  }

  async updateLastAttempt(id: string, outcome: LastAttemptOutcome): Promise<RobotEntity> {
    const existing = this.robots.get(id);
    if (!existing) {
      throw new MolirisAppError(ErrorCode.MISSING_ROBOT_PARAMS, `Robot non trovato per id: ${id}`);
    }

    // Regola RF-MON-005, CA-MON-004: l'esito dell'ultimo tentativo NON sovrascrive l'ultimo stato valido
    const updated: RobotEntity = {
      ...existing,
      lastAttemptOutcome: outcome,
      updatedAt: new Date(),
    };
    this.robots.set(id, updated);
    return structuredClone(updated);
  }

  async updateAnagraphicState(id: string, newState: AnagraphicState): Promise<RobotEntity> {
    const existing = this.robots.get(id);
    if (!existing) {
      throw new MolirisAppError(ErrorCode.MISSING_ROBOT_PARAMS, `Robot non trovato per id: ${id}`);
    }

    // Regola RF-ROB-013, CA-ROB-011: la disabilitazione o rimozione dall'anagrafica attiva
    // altera ESCLUSIVAMENTE lo stato logico, senza MAI toccare o cancellare i file sul server
    const updated: RobotEntity = {
      ...existing,
      anagraphicState: newState,
      updatedAt: new Date(),
    };
    this.robots.set(id, updated);
    return structuredClone(updated);
  }

  async updateRegistrationState(
    id: string,
    regState: RegistrationState,
    verificationInfo?: ConnectionVerificationInfo
  ): Promise<RobotEntity> {
    const existing = this.robots.get(id);
    if (!existing) {
      throw new MolirisAppError(ErrorCode.MISSING_ROBOT_PARAMS, `Robot non trovato per id: ${id}`);
    }

    const updated: RobotEntity = {
      ...existing,
      registrationState: regState,
      lastConnectionVerification: verificationInfo !== undefined ? verificationInfo : existing.lastConnectionVerification,
      updatedAt: new Date(),
    };
    this.robots.set(id, updated);
    return structuredClone(updated);
  }
}

/**
 * Implementazione MongoDB di RobotRepository (SRS §5.2, §10.1).
 */
export class MongoRobotRepository implements RobotRepository {
  private collection: Collection<RobotEntity>;
  private usernameUniqueness: "per_host" | "globale";

  constructor(db: Db, usernameUniqueness: "per_host" | "globale" = "per_host") {
    this.collection = db.collection<RobotEntity>("robots");
    this.usernameUniqueness = usernameUniqueness;
  }

  /**
   * Crea gli indici di unicità su identificativo, directory del server e combinazione host/porta/username (RF-ROB-006, §8.2, Problema 1b, 1d).
   */
  async initIndexes(): Promise<void> {
    try {
      // Pulizia fail-safe di eventuali indici legacy con naming snake_case
      try { await this.collection.dropIndex("robot_id_1"); } catch {}
      try { await this.collection.dropIndex("remote_username_1_host_1_ssh_port_1"); } catch {}

      // 1. Unicità identificativo robot su TUTTI i record, compresi rimossi (Problema 1d)
      await this.collection.createIndex({ id: 1 }, { unique: true });

      // 2. Unicità directory server derivata su TUTTI i record, compresi rimossi (Problema 1d)
      await this.collection.createIndex({ serverDirectoryPath: 1 }, { unique: true });

      // 3. Unicità (host, porta, username) solo per robot NON rimossi (Problema 1b, 1d)
      // Nota architetturale: MongoDB rifiuta l'operatore $ne in partialFilterExpression ($not non consentito);
      // viene impiegato l'operatore $in: ["attivo", "disabilitato"] per escludere con precisione i robot in stato "rimosso".
      await this.collection.createIndex(
        { host: 1, sshPort: 1, remoteUsername: 1 },
        {
          unique: true,
          partialFilterExpression: { anagraphicState: { $in: ["attivo", "disabilitato"] } },
          name: "host_1_sshPort_1_remoteUsername_1_active",
        }
      );

      // 4. Se configurata unicità globale (§11.3, RF-ROB-006)
      if (this.usernameUniqueness === "globale") {
        await this.collection.createIndex({ remoteUsername: 1 }, { unique: true });
      }
    } catch (err: any) {
      throw new MolirisAppError(
        ErrorCode.DB_PERSISTENCE_ERROR,
        `Errore inizializzazione indici MongoDB: ${err.message}`
      );
    }
  }

  async create(robot: RobotEntity): Promise<RobotEntity> {
    try {
      await this.collection.insertOne(structuredClone(robot));
      return structuredClone(robot);
    } catch (err: any) {
      if (err.code === 11000) {
        throw new MolirisAppError(
          ErrorCode.MISSING_ROBOT_PARAMS,
          `Violazione unicità MongoDB (RF-ROB-006, §8.2): ${JSON.stringify(err.keyValue)} già esistente.`
        );
      }
      throw new MolirisAppError(ErrorCode.DB_PERSISTENCE_ERROR, `Errore MongoDB durante create: ${err.message}`);
    }
  }

  async findById(id: string): Promise<RobotEntity | null> {
    try {
      const doc = await this.collection.findOne({ id }, { projection: { _id: 0 } });
      return doc ? (doc as RobotEntity) : null;
    } catch (err: any) {
      throw new MolirisAppError(ErrorCode.DB_PERSISTENCE_ERROR, `Errore MongoDB durante findById: ${err.message}`);
    }
  }

  async findByUsername(remoteUsername: string): Promise<RobotEntity | null> {
    try {
      const doc = await this.collection.findOne({ remoteUsername }, { projection: { _id: 0 } });
      return doc ? (doc as RobotEntity) : null;
    } catch (err: any) {
      throw new MolirisAppError(ErrorCode.DB_PERSISTENCE_ERROR, `Errore MongoDB durante findByUsername: ${err.message}`);
    }
  }

  async findByServerDirectory(serverDirectoryPath: string): Promise<RobotEntity | null> {
    try {
      const doc = await this.collection.findOne({ serverDirectoryPath }, { projection: { _id: 0 } });
      return doc ? (doc as RobotEntity) : null;
    } catch (err: any) {
      throw new MolirisAppError(ErrorCode.DB_PERSISTENCE_ERROR, `Errore MongoDB durante findByServerDirectory: ${err.message}`);
    }
  }

  async findByHostPortUsername(host: string, sshPort: number, remoteUsername: string): Promise<RobotEntity | null> {
    try {
      const doc = await this.collection.findOne(
        { host, sshPort, remoteUsername, anagraphicState: { $in: ["attivo", "disabilitato"] } },
        { projection: { _id: 0 } }
      );
      return doc ? (doc as RobotEntity) : null;
    } catch (err: any) {
      throw new MolirisAppError(ErrorCode.DB_PERSISTENCE_ERROR, `Errore MongoDB durante findByHostPortUsername: ${err.message}`);
    }
  }

  async list(): Promise<RobotEntity[]> {
    try {
      const docs = await this.collection.find({}, { projection: { _id: 0 } }).toArray();
      return docs as RobotEntity[];
    } catch (err: any) {
      throw new MolirisAppError(ErrorCode.DB_PERSISTENCE_ERROR, `Errore MongoDB durante list: ${err.message}`);
    }
  }

  async updateConfiguration(id: string, update: RobotConfigurationUpdate): Promise<RobotEntity> {
    try {
      const $set: Record<string, unknown> = {
        updatedAt: new Date(),
      };
      const $unset: Record<string, unknown> = {};

      for (const [key, val] of Object.entries(update)) {
        if (val === undefined) {
          continue;
        } else if (val === null || val === "") {
          if (key === "customerName" || key === "clientId" || key === "plantName" || key === "plantId") {
            $unset[key] = "";
          } else {
            $set[key] = val;
          }
        } else {
          $set[key] = val;
        }
      }

      const updateDoc: Record<string, unknown> = { $set };
      if (Object.keys($unset).length > 0) {
        updateDoc.$unset = $unset;
      }

      const result = await this.collection.findOneAndUpdate(
        { id },
        updateDoc,
        { returnDocument: "after", projection: { _id: 0 } }
      );
      if (!result) {
        throw new MolirisAppError(ErrorCode.MISSING_ROBOT_PARAMS, `Robot non trovato per id: ${id}`);
      }
      return result as RobotEntity;
    } catch (err: any) {
      if (err instanceof MolirisAppError) throw err;
      throw new MolirisAppError(ErrorCode.DB_PERSISTENCE_ERROR, `Errore MongoDB durante updateConfiguration: ${err.message}`);
    }
  }

  async updateConnectionState(id: string, connectionState: ConnectionState, outcome?: LastAttemptOutcome): Promise<RobotEntity> {
    try {
      const updateDoc: Record<string, unknown> = {
        connectionState,
        updatedAt: new Date(),
      };
      if (outcome !== undefined) {
        updateDoc.lastAttemptOutcome = outcome;
      }

      const result = await this.collection.findOneAndUpdate(
        { id },
        { $set: updateDoc },
        { returnDocument: "after", projection: { _id: 0 } }
      );
      if (!result) {
        throw new MolirisAppError(ErrorCode.MISSING_ROBOT_PARAMS, `Robot non trovato per id: ${id}`);
      }
      return result as RobotEntity;
    } catch (err: any) {
      if (err instanceof MolirisAppError) throw err;
      throw new MolirisAppError(ErrorCode.DB_PERSISTENCE_ERROR, `Errore MongoDB durante updateConnectionState: ${err.message}`);
    }
  }

  async updateOperationalState(id: string, operationalState: OperationalState, lastValidUpdateAt: Date): Promise<RobotEntity> {
    try {
      const result = await this.collection.findOneAndUpdate(
        { id },
        {
          $set: {
            operationalState,
            lastValidUpdateAt,
            updatedAt: new Date(),
          },
        },
        { returnDocument: "after", projection: { _id: 0 } }
      );
      if (!result) {
        throw new MolirisAppError(ErrorCode.MISSING_ROBOT_PARAMS, `Robot non trovato per id: ${id}`);
      }
      return result as RobotEntity;
    } catch (err: any) {
      if (err instanceof MolirisAppError) throw err;
      throw new MolirisAppError(ErrorCode.DB_PERSISTENCE_ERROR, `Errore MongoDB durante updateOperationalState: ${err.message}`);
    }
  }

  async updateLastAttempt(id: string, outcome: LastAttemptOutcome): Promise<RobotEntity> {
    try {
      // CA-MON-004: aggiorna ESCLUSIVAMENTE lastAttemptOutcome senza alterare operationalState o lastValidUpdateAt
      const result = await this.collection.findOneAndUpdate(
        { id },
        {
          $set: {
            lastAttemptOutcome: outcome,
            updatedAt: new Date(),
          },
        },
        { returnDocument: "after", projection: { _id: 0 } }
      );
      if (!result) {
        throw new MolirisAppError(ErrorCode.MISSING_ROBOT_PARAMS, `Robot non trovato per id: ${id}`);
      }
      return result as RobotEntity;
    } catch (err: any) {
      if (err instanceof MolirisAppError) throw err;
      throw new MolirisAppError(ErrorCode.DB_PERSISTENCE_ERROR, `Errore MongoDB durante updateLastAttempt: ${err.message}`);
    }
  }

  async updateAnagraphicState(id: string, newState: AnagraphicState): Promise<RobotEntity> {
    try {
      // RF-ROB-013, CA-ROB-011: aggiornamento puramente anagrafico su DB, nessun filesystem touch
      const result = await this.collection.findOneAndUpdate(
        { id },
        {
          $set: {
            anagraphicState: newState,
            updatedAt: new Date(),
          },
        },
        { returnDocument: "after", projection: { _id: 0 } }
      );
      if (!result) {
        throw new MolirisAppError(ErrorCode.MISSING_ROBOT_PARAMS, `Robot non trovato per id: ${id}`);
      }
      return result as RobotEntity;
    } catch (err: any) {
      if (err instanceof MolirisAppError) throw err;
      throw new MolirisAppError(ErrorCode.DB_PERSISTENCE_ERROR, `Errore MongoDB durante updateAnagraphicState: ${err.message}`);
    }
  }

  async updateRegistrationState(
    id: string,
    regState: RegistrationState,
    verificationInfo?: ConnectionVerificationInfo
  ): Promise<RobotEntity> {
    try {
      const updateDoc: Record<string, unknown> = {
        registrationState: regState,
        updatedAt: new Date(),
      };
      if (verificationInfo !== undefined) {
        updateDoc.lastConnectionVerification = verificationInfo;
      }

      const result = await this.collection.findOneAndUpdate(
        { id },
        { $set: updateDoc },
        { returnDocument: "after", projection: { _id: 0 } }
      );
      if (!result) {
        throw new MolirisAppError(ErrorCode.MISSING_ROBOT_PARAMS, `Robot non trovato per id: ${id}`);
      }
      return result as RobotEntity;
    } catch (err: any) {
      if (err instanceof MolirisAppError) throw err;
      throw new MolirisAppError(ErrorCode.DB_PERSISTENCE_ERROR, `Errore MongoDB durante updateRegistrationState: ${err.message}`);
    }
  }
}
