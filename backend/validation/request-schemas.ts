import { z } from "zod";

const optionalText = z.string().optional();
const optionalBoolean = z.boolean().optional();

const hostKeyVerificationSchema = z.object({
  fingerprint: optionalText,
  knownHostsPath: optionalText,
  strictHostKeyChecking: optionalBoolean,
}).passthrough();

const sftpParametersSchema = z.object({
  host: optionalText,
  port: z.number().int().optional(),
  username: optionalText,
}).passthrough();

// I campi restano opzionali: i campi mancanti continuano a essere valutati dal
// servizio di registrazione, mentre tipi e strutture errati sono errori HTTP 400.
const robotEditableFields = {
  displayName: optionalText,
  host: optionalText,
  sshPort: z.number().int().optional(),
  sshAuthMethod: z.enum(["key", "password"]).optional(),
  password: optionalText,
  privateKey: optionalText,
  passphrase: optionalText,
  credentialReference: optionalText,
  hostKeyVerification: hostKeyVerificationSchema.optional(),
  fingerprint: optionalText,
  knownHostsPath: optionalText,
  strictHostKeyChecking: optionalBoolean,
  remoteMonitoringPath: optionalText,
  stateFilePaths: z.array(z.string()).optional(),
  sftpParameters: sftpParametersSchema.optional(),
  sftpHost: optionalText,
  sftpPort: z.number().int().optional(),
  sftpUser: optionalText,
  customParameters: z.record(z.string(), z.unknown()).optional(),
  customerName: optionalText,
  plantName: optionalText,
  clientId: optionalText,
  plantId: optionalText,
};

export const robotRegistrationBodySchema = z.object({
  ...robotEditableFields,
  id: optionalText,
  remoteUsername: optionalText,
}).passthrough();

export const robotConfigurationBodySchema = z.object(robotEditableFields).passthrough();

export const robotConfirmationBodySchema = z.object({
  confirmation: optionalBoolean,
}).passthrough();

export const transferBodySchema = z.object({
  direction: z.enum(["SERVER_TO_ROBOT", "ROBOT_TO_SERVER"]).optional(),
  serverRelativePath: optionalText,
  remotePath: optionalText,
  sourcePath: optionalText,
  targetPath: optionalText,
  overwrite: optionalBoolean,
  confirmed: optionalBoolean,
  expectedChecksum: optionalText,
  background: optionalBoolean,
}).passthrough();

export const serverRobotTransferBodySchema = transferBodySchema.extend({
  direction: z.enum(["SERVER_TO_ROBOT", "ROBOT_TO_SERVER"]),
  serverRelativePath: z.string(),
  remotePath: z.string(),
}).passthrough();

export const bulkTargetSchema = z.object({
  type: z.enum(["server", "robot"]),
  robotId: z.string().min(1),
  directory: optionalText,
}).passthrough();

export const bulkTargetsSchema = z.array(bulkTargetSchema);

export const bulkPreCheckBodySchema = z.object({
  filenames: z.array(z.string()),
  targets: z.array(bulkTargetSchema),
}).passthrough();

export const bulkServerSourceBodySchema = z.object({
  sourceScope: z.enum(["general", "server"]).optional(),
  sourceRobotId: optionalText,
  sourcePaths: z.array(z.string()),
  targets: z.array(bulkTargetSchema),
  overwrite: optionalBoolean,
}).passthrough();

export const robotToRobotBodySchema = z.object({
  sourceRobotId: z.string().min(1),
  sourceRemotePath: z.string().min(1),
  targetRobotIds: z.array(z.string().min(1)),
  targetRemotePaths: z.record(z.string(), z.string()).optional(),
  commonTargetDirectory: optionalText,
  isMove: optionalBoolean,
  confirmation: optionalBoolean,
  overwrite: optionalBoolean,
}).passthrough();

export const uploadQuerySchema = z.object({
  filename: optionalText,
  subPath: optionalText,
  remoteDirectory: optionalText,
  overwrite: optionalText,
  expectedChecksum: optionalText,
}).strict();

export const downloadQuerySchema = z.object({
  path: optionalText,
  preflight: optionalText,
}).strict();

export const transferListQuerySchema = z.object({
  envelope: optionalText,
  summary: optionalText,
  once: optionalText,
}).strict();

export const fleetListQuerySchema = z.object({
  limit: z.string().regex(/^\d+$/).max(6).optional(),
  offset: z.string().regex(/^\d+$/).max(9).optional(),
}).strict();

