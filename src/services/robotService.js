import fs from 'fs/promises';
import path from 'path';
import { Client } from 'ssh2';
import { Robot } from '../models/Robot.js';

export class RobotService {
  /**
   * Crea l'alberatura delle directory sul server per il robot in modo idempotente.
   */
  static async prepareRobotDirectory(username, host) {
    const sanitizedHost = host.replace(/[^a-zA-Z0-9.-]/g, '_');
    const sanitizedUser = username.replace(/[^a-zA-Z0-9._-]/g, '_');
    const dirName = `${sanitizedUser}_${sanitizedHost}`;
    
    const rootDir = process.env.ROBOTS_ROOT_DIR || '/home/robots';
    const robotDir = path.join(rootDir, dirName);

    // Crea la cartella principale e le sottodirectory standard
    await fs.mkdir(robotDir, { recursive: true, mode: 0o750 });
    await fs.mkdir(path.join(robotDir, 'upload'), { recursive: true, mode: 0o750 });
    await fs.mkdir(path.join(robotDir, 'download'), { recursive: true, mode: 0o750 });
    await fs.mkdir(path.join(robotDir, 'shared'), { recursive: true, mode: 0o750 });

    return robotDir;
  }

  /**
   * Verifica la connettività SSH verso il robot eseguendo un test non distruttivo.
   */
  static verifySSHConnection(config) {
    return new Promise((resolve) => {
      const conn = new Client();
      let hasResolved = false;

      const finish = (success, message = '') => {
        if (!hasResolved) {
          hasResolved = true;
          conn.end();
          resolve({ success, message });
        }
      };

      conn.on('ready', () => {
        // Esegue controllo rapido di lettura senza alterare nulla sul robot
        conn.exec('uptime', (err, stream) => {
          if (err) {
            return finish(false, `Errore esecuzione comando: ${err.message}`);
          }
          stream.on('close', () => finish(true, 'Connessione verificata con successo'));
        });
      });

      conn.on('error', (err) => finish(false, `Errore SSH: ${err.message}`));

      conn.connect({
        host: config.host,
        port: config.ssh_port || 22,
        username: config.remote_username,
        password: config.password,
        privateKey: config.privateKey,
        readyTimeout: 5000
      });
    });
  }

  /**
   * Registrazione completa del robot nel sistema.
   */
  static async registerRobot(data, authCredentials = {}) {
    // 1. Verifica duplicati per regola unicità
    const existing = await Robot.findOne({
      remote_username: data.remote_username,
      host: data.host,
      ssh_port: data.ssh_port || 22
    });

    if (existing) {
      throw new Error('Un robot con questa combinazione username, host e porta è già registrato.');
    }

    // 2. Prepara la cartella sul filesystem del server
    const serverDirectory = await this.prepareRobotDirectory(data.remote_username, data.host);

    // 3. Test connessione SSH opzionale/richiesto
    let connectionStatus = 'unverified';
    if (authCredentials.password || authCredentials.privateKey) {
      const testResult = await this.verifySSHConnection({
        host: data.host,
        ssh_port: data.ssh_port,
        remote_username: data.remote_username,
        ...authCredentials
      });
      connectionStatus = testResult.success ? 'online' : 'offline';
    }

    // 4. Salva anagrafica nel database
    const robot = new Robot({
      ...data,
      server_directory: serverDirectory,
      connection_status: connectionStatus,
      last_connection_attempt: new Date()
    });

    await robot.save();
    return robot;
  }
}
