import { type FastifyReply } from "fastify";
import { type z } from "zod";

export type RequestInputLocation = "body" | "query" | "params";

const ERROR_BY_LOCATION: Record<RequestInputLocation, { code: string; message: string }> = {
  body: {
    code: "INVALID_REQUEST_BODY",
    message: "Richiesta non valida: controllare il body JSON.",
  },
  query: {
    code: "INVALID_REQUEST_QUERY",
    message: "Richiesta non valida: controllare i parametri query.",
  },
  params: {
    code: "INVALID_REQUEST_PARAMS",
    message: "Richiesta non valida: identificativo di rotta non valido.",
  },
};

/**
 * Valida l'input prima che raggiunga i servizi di dominio. Gli errori di
 * struttura vengono esposti con un messaggio uniforme, senza riflettere i dati
 * ricevuti o gli eventuali segreti presenti nella richiesta.
 */
export function parseRequestInput<T>(
  schema: z.ZodType<T>,
  input: unknown,
  reply: FastifyReply,
  location: RequestInputLocation
): T | null {
  const parsed = schema.safeParse(input);
  if (parsed.success) return parsed.data;

  const error = ERROR_BY_LOCATION[location];
  void reply.status(400).send({
    code: error.code,
    message: error.message,
    classification: "recuperabile",
  });
  return null;
}
