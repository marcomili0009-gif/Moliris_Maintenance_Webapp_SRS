// Requisiti soddisfatti: RNF-SEC-001, SRS §2.4 vincolo 3

import Fastify, { type FastifyInstance } from "fastify";
import fs from "fs";
import { type SystemConfiguration, loadAndValidateConfig } from "../config/configuration.ts";
import { MolirisLogger } from "../logging/logger.ts";

export function createServer(config: SystemConfiguration, logger: MolirisLogger): FastifyInstance {
  // Verifica esistenza certificati TLS obbligatori per HTTPS esclusivo (RNF-SEC-001)
  if (!fs.existsSync(config.tlsCertPath) || !fs.existsSync(config.tlsKeyPath)) {
    throw new Error(`File certificato o chiave TLS mancante: ${config.tlsCertPath}, ${config.tlsKeyPath}`);
  }

  const httpsOptions = {
    key: fs.readFileSync(config.tlsKeyPath),
    cert: fs.readFileSync(config.tlsCertPath),
  };

  const app = Fastify({
    https: httpsOptions,
    logger: false, // Disabilitato il logger standard in favore del logger applicativo con redazione attiva
  });

  // Singolo endpoint tecnico di verifica dello stato del servizio (senza dati sensibili)
  app.get("/healthz", async (_request, reply) => {
    return reply.status(200).send({
      status: "OK",
      timestamp: new Date().toISOString(),
    });
  });

  return app;
}

// Avvio del server se eseguito direttamente
if (process.argv[1] && process.argv[1].endsWith("server.ts")) {
  const logger = new MolirisLogger();
  try {
    const config = loadAndValidateConfig(process.env);
    const server = createServer(config, logger);
    const port = Number(process.env["MOLIRIS_SERVER_PORT"]) || 8443;
    const host = process.env["MOLIRIS_SERVER_HOST"] || "0.0.0.0";

    server.listen({ port, host }, (err, address) => {
      if (err) {
        logger.error("Errore fatale avvio server HTTPS", err.message);
        process.exit(1);
      }
      logger.info(`Backend HTTPS avviato con successo su ${address}`);
    });
  } catch (error: any) {
    logger.error("Errore inizializzazione backend", error.message);
    process.exit(1);
  }
}
