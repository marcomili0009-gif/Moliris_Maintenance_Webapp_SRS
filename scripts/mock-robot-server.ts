// @ts-nocheck
/**
 * Mock Robot SSH/SFTP Server per test interattivo live (Moliris SRS v1.0).
 * Simula il robot 'robot-01' sulla porta 2222 con shell PTY, SFTP e monitoraggio.
 */

import ssh2 from "ssh2";
import * as crypto from "crypto";
import * as path from "path";

const Server = (ssh2 as any).Server || (ssh2 as any).default?.Server || ssh2;

const PORT = 2222;
const HOST = "127.0.0.1";

import * as fs from "fs";

const keyPath = "/tmp/moliris_mock_robot_hostkey.pem";
if (!fs.existsSync(keyPath)) {
  const hostKeyPair = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "pkcs1", format: "pem" },
  });
  fs.writeFileSync(keyPath, hostKeyPair.privateKey, { mode: 0o600 });
}
const serverHostKey = fs.readFileSync(keyPath, "utf-8");

// Filesystem virtuale remoto in-memory
const virtualFs = new Map<string, Buffer>();
virtualFs.set("/stato_robot.json", Buffer.from(JSON.stringify({
  battery: 92,
  temperature: 31.4,
  mode: "autonomous",
  health: "OK",
  active_mission: "logistics_route_7",
  updated_at: new Date().toISOString(),
}, null, 2)));

virtualFs.set("/telemetria.log", Buffer.from("2026-10-30T15:00:00Z INFO SYSTEM_OK Battery=92% Temp=31.4C\n2026-10-30T15:10:00Z INFO MISSION_RESUMED Target=Area_B\n"));
virtualFs.set("/camera_config.conf", Buffer.from("resolution=1920x1080\nframerate=30\nencoding=h264\n"));

const server = new Server({ hostKeys: [serverHostKey] }, (client: any) => {
  client.on("error", () => {
    // Ignore client connection errors safely
  });

  if ((client as any)._sock) {
    (client as any)._sock.setNoDelay(true);
  }

  client.on("authentication", (ctx) => {
    // Accetta qualsiasi autenticazione per il mock
    ctx.accept();
  });

  client.on("ready", () => {
    client.on("session", (acceptSession) => {
      const session = acceptSession();

      // 1. Gestione comando Exec (usato da monitoring e verification)
      session.on("exec", (acceptExec, _rejectExec, info) => {
        const stream = acceptExec();
        const cmd = info.command;

        if (cmd.includes("test -r") || cmd.includes("test -f")) {
          stream.write("READABLE\n");
          stream.exit(0);
        } else if (cmd.includes("cat")) {
          const content = virtualFs.get("/stato_robot.json")?.toString("utf-8") || '{"status":"ok","battery":90}\n';
          stream.write(content);
          stream.exit(0);
        } else {
          stream.write("OK\n");
          stream.exit(0);
        }
        stream.end();
      });

      // 2. Gestione PTY
      session.on("pty", (acceptPty) => {
        acceptPty();
      });

      // 3. Gestione Shell Interattiva (Terminale WebSocket PTY)
      session.on("shell", (acceptShell) => {
        const stream = acceptShell();
        stream.write("\r\n==========================================================\r\n");
        stream.write("  Moliris Robot OS v1.0 - Robot Logistica Alfa (robot-01)\r\n");
        stream.write("  Interactive Maintenance Shell - Ready\r\n");
        stream.write("==========================================================\r\n");
        stream.write("robot-01:~$ ");

        let currentLine = "";
        stream.on("data", (data: Buffer) => {
          const str = data.toString("utf-8");

          for (let i = 0; i < str.length; i++) {
            const char = str[i];
            if (char === "\r" || char === "\n") {
              stream.write("\r\n");
              const trimmed = currentLine.trim();
              if (trimmed === "help") {
                stream.write("Available commands: help, status, ls, uname, clear, exit\r\n");
              } else if (trimmed === "status") {
                stream.write("Status: OPERATIONAL | Battery: 92% | Mode: AUTONOMOUS\r\n");
              } else if (trimmed === "ls") {
                stream.write(Array.from(virtualFs.keys()).map(k => k.replace(/^\//, "")).join("  ") + "\r\n");
              } else if (trimmed === "uname" || trimmed === "uname -a") {
                stream.write("Linux moliris-robot-01 6.8.0-robot-generic #42 SMP x86_64 GNU/Linux\r\n");
              } else if (trimmed === "clear") {
                stream.write("\x1b[2J\x1b[H");
              } else if (trimmed === "exit") {
                stream.write("Logout.\r\n");
                stream.end();
                return;
              } else if (trimmed.length > 0) {
                stream.write(`bash: ${trimmed}: command not found\r\n`);
              }
              currentLine = "";
              stream.write("robot-01:~$ ");
            } else if (char === "\x7f" || char === "\b") { // Backspace
              if (currentLine.length > 0) {
                currentLine = currentLine.slice(0, -1);
                stream.write("\b \b");
              }
            } else if (char === "\x03") { // Ctrl+C
              stream.write("^C\r\nrobot-01:~$ ");
              currentLine = "";
            } else if (char >= " ") {
              currentLine += char;
              stream.write(char); // Echo
            }
          }
        });
      });

      // 4. Gestione SFTP Subsystem
      session.on("sftp", (acceptSftp) => {
        const sftp = acceptSftp();
        const openHandles = new Map<string, { filename: string; buffer: Buffer; isDir?: boolean; dirRead?: boolean }>();
        let handleCounter = 0;

        sftp.on("REALPATH", (reqid, p) => {
          sftp.name(reqid, [{ filename: p || "/" }]);
        });

        sftp.on("STAT", (reqid, p) => {
          const norm = path.posix.normalize(p || "/");
          if (norm === "/" || norm === ".") {
            return sftp.attrs(reqid, { mode: 0o040755, size: 4096, atime: Math.floor(Date.now() / 1000), mtime: Math.floor(Date.now() / 1000) } as any);
          }
          const buf = virtualFs.get(norm) || virtualFs.get("/" + norm.replace(/^\//, ""));
          if (buf) {
            return sftp.attrs(reqid, { mode: 0o100644, size: buf.length, atime: Math.floor(Date.now() / 1000), mtime: Math.floor(Date.now() / 1000) } as any);
          }
          return sftp.status(reqid, 2 /* SSH_FX_NO_SUCH_FILE */);
        });

        sftp.on("LSTAT", (reqid, p) => {
          const norm = path.posix.normalize(p || "/");
          if (norm === "/" || norm === ".") {
            return sftp.attrs(reqid, { mode: 0o040755, size: 4096, atime: Math.floor(Date.now() / 1000), mtime: Math.floor(Date.now() / 1000) } as any);
          }
          const buf = virtualFs.get(norm) || virtualFs.get("/" + norm.replace(/^\//, ""));
          if (buf) {
            return sftp.attrs(reqid, { mode: 0o100644, size: buf.length, atime: Math.floor(Date.now() / 1000), mtime: Math.floor(Date.now() / 1000) } as any);
          }
          return sftp.status(reqid, 2 /* SSH_FX_NO_SUCH_FILE */);
        });

        sftp.on("OPENDIR", (reqid, p) => {
          const hId = `dir_h_${++handleCounter}`;
          openHandles.set(hId, { filename: p || "/", buffer: Buffer.alloc(0), isDir: true, dirRead: false });
          sftp.handle(reqid, Buffer.from(hId));
        });

        sftp.on("READDIR", (reqid, handle) => {
          const h = openHandles.get(handle.toString());
          if (!h || h.dirRead) {
            return sftp.status(reqid, 1 /* SSH_FX_EOF */);
          }
          h.dirRead = true;

          const entries = Array.from(virtualFs.entries()).map(([k, v]) => ({
            filename: k.replace(/^\//, ""),
            longname: `-rw-r--r-- 1 robot robot ${v.length} Oct 30 15:00 ${k.replace(/^\//, "")}`,
            attrs: { mode: 0o100644, size: v.length, atime: 100, mtime: 100 } as any,
          }));

          sftp.name(reqid, entries);
        });

        sftp.on("OPEN", (reqid, filename, flags) => {
          const hId = `file_h_${++handleCounter}`;
          const norm = path.posix.normalize(filename.startsWith("/") ? filename : "/" + filename);
          const existing = virtualFs.get(norm) || Buffer.alloc(0);
          openHandles.set(hId, { filename: norm, buffer: existing });
          sftp.handle(reqid, Buffer.from(hId));
        });

        sftp.on("READ", (reqid, handle, offset, len) => {
          const h = openHandles.get(handle.toString());
          if (!h) return sftp.status(reqid, 4 /* SSH_FX_FAILURE */);
          const buf = virtualFs.get(h.filename) || h.buffer;
          if (offset >= buf.length) return sftp.status(reqid, 1 /* SSH_FX_EOF */);
          const chunk = buf.subarray(offset, Math.min(offset + len, buf.length));
          sftp.data(reqid, chunk);
        });

        sftp.on("WRITE", (reqid, handle, offset, data) => {
          const h = openHandles.get(handle.toString());
          if (!h) return sftp.status(reqid, 4 /* SSH_FX_FAILURE */);
          const needed = offset + data.length;
          if (h.buffer.length < needed) {
            const newBuf = Buffer.alloc(needed);
            h.buffer.copy(newBuf, 0, 0, h.buffer.length);
            h.buffer = newBuf;
          }
          data.copy(h.buffer, offset);
          sftp.status(reqid, 0 /* SSH_FX_OK */);
        });

        sftp.on("CLOSE", (reqid, handle) => {
          const h = openHandles.get(handle.toString());
          if (h && !h.isDir && h.filename) {
            virtualFs.set(h.filename, h.buffer);
          }
          openHandles.delete(handle.toString());
          sftp.status(reqid, 0 /* SSH_FX_OK */);
        });

        sftp.on("RENAME", (reqid, oldPath, newPath) => {
          const normOld = path.posix.normalize(oldPath.startsWith("/") ? oldPath : "/" + oldPath);
          const normNew = path.posix.normalize(newPath.startsWith("/") ? newPath : "/" + newPath);
          const buf = virtualFs.get(normOld);
          if (buf) {
            virtualFs.set(normNew, buf);
            virtualFs.delete(normOld);
          }
          sftp.status(reqid, 0 /* SSH_FX_OK */);
        });

        sftp.on("REMOVE", (reqid, p) => {
          const norm = path.posix.normalize(p.startsWith("/") ? p : "/" + p);
          virtualFs.delete(norm);
          sftp.status(reqid, 0 /* SSH_FX_OK */);
        });
      });
    });
  });
});

server.listen(PORT, HOST, () => {
  console.log(`[MockRobotServer] In ascolto su ${HOST}:${PORT} (robot-01 virtuale con Shell PTY e SFTP attivo)`);
});
