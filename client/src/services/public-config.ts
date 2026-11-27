import { apiClient } from "./api-client.ts";

export interface PublicAppConfig {
  sessionInactivityTimeoutMinutes: number;
  sessionInactivityWarningMinutes: number;
  sshTerminalActiveTimeoutMinutes: number;
  terminalSessionWarningMinutes: number;
  maxConcurrentWebUsers: number;
  maxConcurrentTerminalsPerRobot: number;
  maxSessionsPerAccount: number;
  fleetPollingIntervalSeconds: number;
  maxConcurrentTransfers: number;
  sshConnectTimeoutSeconds: number;
  transferTimeoutMinutes: number;
  maxFileUploadBytes: number;
  transferResumeEnabled: boolean;
  futureExtensions?: {
    maxFleetRobots?: number;
    maxSessionsPerAccount?: number;
  };
  bulkUploadConfig?: {
    maxConcurrentFiles?: number;
    chunkSizeBytes?: number;
  };
}

let cachedConfig: PublicAppConfig | null = null;
let inFlightRequest: Promise<PublicAppConfig> | null = null;

export async function fetchPublicConfig(forceRefresh = false): Promise<PublicAppConfig> {
  if (!forceRefresh && cachedConfig) {
    return cachedConfig;
  }
  if (!forceRefresh && inFlightRequest) {
    return inFlightRequest;
  }

  const request = (async () => {
    const response = await apiClient.get("/api/config/public");
    if (!response.ok) {
      throw new Error(`Il server ha rifiutato la configurazione pubblica (${response.status}).`);
    }
    const config: unknown = await response.json();
    if (
      typeof config !== "object" ||
      config === null ||
      !("sessionInactivityTimeoutMinutes" in config) ||
      typeof (config as any).sessionInactivityTimeoutMinutes !== "number" ||
      !Number.isInteger((config as any).sessionInactivityTimeoutMinutes) ||
      (config as any).sessionInactivityTimeoutMinutes < 1
    ) {
      throw new Error("La configurazione pubblica contiene un timeout sessione non valido.");
    }
    cachedConfig = config as PublicAppConfig;
    return cachedConfig;
  })();

  inFlightRequest = request;
  try {
    return await request;
  } finally {
    if (inFlightRequest === request) {
      inFlightRequest = null;
    }
  }
}

export function resetPublicConfigCache(): void {
  cachedConfig = null;
  inFlightRequest = null;
}
