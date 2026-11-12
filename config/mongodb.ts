// Configurazione MongoDB condivisa (DECISIONS.md §2.3)

import { isIP } from "node:net";

export interface MongoConfig {
  uri: string;
  dbName: string;
}

export function assertMongoCredentialsInProduction(uri: string, nodeEnv = process.env.NODE_ENV): void {
  if (nodeEnv !== "production") return;

  const uriParts = uri.match(/^mongodb(\+srv)?:\/\/([^/?#]+)(?:\/[^?#]*)?(?:\?([^#]*))?$/i);
  if (!uriParts) {
    throw new Error("Configurazione non sicura: URI MongoDB non valida per l'ambiente production.");
  }
  const isSrv = Boolean(uriParts[1]);
  const authority = uriParts[2];
  const atIndex = authority.lastIndexOf("@");
  const userInfo = atIndex >= 0 ? authority.slice(0, atIndex) : "";
  let username = "";
  let password = "";
  try {
    const separator = userInfo.indexOf(":");
    username = decodeURIComponent(separator >= 0 ? userInfo.slice(0, separator) : "");
    password = decodeURIComponent(separator >= 0 ? userInfo.slice(separator + 1) : "");
  } catch {
    throw new Error("Configurazione non sicura: credenziali MongoDB non valide in production.");
  }
  if (!username || !password) {
    throw new Error("Configurazione non sicura: l'URI MongoDB deve includere username e password in production.");
  }

  const hostList = authority?.slice((authority.lastIndexOf("@") + 1)).split(",") || [];
  const hosts = hostList.map((entry) => {
    if (entry.startsWith("[")) return entry.slice(1, entry.indexOf("]"));
    return entry.split(":")[0];
  });
  const isLoopback = (host: string) => {
    const unwrapped = host.toLowerCase().replace(/^\[|\]$/g, "");
    const ipVersion = isIP(unwrapped);
    return unwrapped === "localhost" || unwrapped === "::1" || (ipVersion === 4 && Number(unwrapped.split(".")[0]) === 127);
  };
  const remoteHosts = hosts.filter((host) => host && !isLoopback(host));
  const searchParams = new URLSearchParams(uriParts[3] || "");
  const tlsSettings = [...searchParams.getAll("tls"), ...searchParams.getAll("ssl")].map((value) => value.toLowerCase());
  const tlsDisabled = tlsSettings.includes("false");
  const tlsEnabled = tlsSettings.includes("true") || isSrv;
  if (tlsDisabled || (remoteHosts.length > 0 && !tlsEnabled)) {
    throw new Error("Configurazione non sicura: le connessioni MongoDB remote devono usare TLS in production.");
  }
  if (remoteHosts.length > 0 && ["tlsInsecure", "tlsAllowInvalidCertificates", "tlsAllowInvalidHostnames"].some((key) => searchParams.getAll(key).some((value) => value.toLowerCase() === "true"))) {
    throw new Error("Configurazione non sicura: non è consentito disabilitare la verifica del certificato TLS MongoDB in production.");
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
