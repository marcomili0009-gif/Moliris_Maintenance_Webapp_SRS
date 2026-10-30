import http from 'http';
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { WebSocketServer } from 'ws';
import { Client } from 'ssh2';
import { connectDB } from './config/db.js';
import { Robot } from './models/Robot.js';
import { RobotService } from './services/robotService.js';

dotenv.config();

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws/terminal' });

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Connessione a MongoDB
connectDB();

// 1. API: Lista di tutti i robot registrati
app.get('/api/fleet', async (req, res) => {
  try {
    const robots = await Robot.find().sort({ createdAt: -1 });
    res.json({ success: true, count: robots.length, data: robots });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 2. API: Registrazione nuovo robot
app.post('/api/fleet/register', async (req, res) => {
  try {
    const { authCredentials, ...robotData } = req.body;
    const robot = await RobotService.registerRobot(robotData, authCredentials);
    res.status(201).json({ success: true, message: 'Robot registrato con successo', data: robot });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// 3. Gestore WebSocket per Shell Linux PTY interattiva nel browser
wss.on('connection', (ws, req) => {
  console.log('[Terminal WS] Nuovo client collegato');

  const sshClient = new Client();
  let sshStream = null;

  ws.on('message', (message) => {
    try {
      const parsed = JSON.parse(message);

      // Inizializzazione sessione SSH
      if (parsed.type === 'init') {
        const { host, port = 22, username, password } = parsed.config;

        sshClient.on('ready', () => {
          ws.send(JSON.stringify({ type: 'status', data: '\r\n[SSH] Connessione riuscita. Avvio terminale...\r\n' }));

          sshClient.shell({ term: 'xterm-color', cols: 80, rows: 24 }, (err, stream) => {
            if (err) {
              ws.send(JSON.stringify({ type: 'error', data: err.message }));
              return ws.close();
            }

            sshStream = stream;

            // Inoltra l'output della shell remota al client browser
            sshStream.on('data', (chunk) => {
              ws.send(JSON.stringify({ type: 'output', data: chunk.toString('utf-8') }));
            });

            sshStream.on('close', () => {
              ws.send(JSON.stringify({ type: 'status', data: '\r\n[SSH] Sessione terminata dal server remoto.\r\n' }));
              ws.close();
            });
          });
        });

        sshClient.on('error', (err) => {
          ws.send(JSON.stringify({ type: 'error', data: `[SSH Errore] ${err.message}\r\n` }));
        });

        sshClient.connect({ host, port, username, password });
      }

      // Input da tastiera dell'utente inoltrato alla shell remota
      if (parsed.type === 'input' && sshStream) {
        sshStream.write(parsed.data);
      }

      // Ridimensionamento finestra terminale
      if (parsed.type === 'resize' && sshStream) {
        sshStream.setWindow(parsed.rows, parsed.cols, parsed.height, parsed.width);
      }
    } catch (err) {
      console.error('[Terminal WS] Errore parsing messaggio:', err);
    }
  });

  ws.on('close', () => {
    if (sshStream) sshStream.end();
    sshClient.end();
    console.log('[Terminal WS] Connessione chiusa');
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`[Server] Moliris Maintenance attivo su http://127.0.0.1:${PORT}`);
});
