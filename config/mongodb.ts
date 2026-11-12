// Configurazione MongoDB condivisa (DECISIONS.md §2.3)

export interface MongoConfig {
  uri: string;
  dbName: string;
}

export function assertMongoCredentialsInProduction(uri: string, nodeEnv = process.env.NODE_ENV): void {
  if (nodeEnv !== "production") return;

  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw new Error("Configurazione non sicura: URI MongoDB non valida per l'ambiente production.");
  }
  if (!parsed.username || !parsed.password) {
    throw new Error("Configurazione non sicura: l'URI MongoDB deve includere username e password in production.");
  }
}

export function resolveMongoConfig(
  env: Record<string, string | undefined> = process.env,
  overrides?: { uri?: string; dbName?: string },
): MongoConfig {
  const uri =
    overrides?.uri?.trim() ||
    env["MOLIRIS_MONGODB_URI"]?.trim() ||
    env["MOLIRIS_MONGO_URI"]?.trim() ||
    "mongodb://127.0.0.1:27017/moliris";

  const explicitDbName =
    overrides?.dbName?.trim() ||
    env["MOLIRIS_DB_NAME"]?.trim();

  const uriPath = uri.match(/^[a-zA-Z][a-zA-Z\d+.-]*:\/\/[^/?#]*(?:\/([^?#]*))?/);
  const uriDbName = uriPath?.[1]
    ? decodeURIComponent(uriPath[1])
    : undefined;

  return {
    uri,
    dbName: explicitDbName || uriDbName || "moliris",
  };
}
