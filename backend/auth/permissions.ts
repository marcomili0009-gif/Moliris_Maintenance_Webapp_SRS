// Requisiti soddisfatti: SRS §2.2, §11.6, RF-AUTH-005, RF-ROB-001, RF-ROB-003, RF-ROB-004,
// RF-ROB-013, RF-MON-004, RF-MON-006, RF-SSH-001, RF-FS-001, RF-FS-004, RF-FS-005,
// RF-SRVFS-002, RF-SRVFS-003, RF-SRVFS-004, RF-TRF-002, RF-TRF-003, RNF-SEC-004, CA-SSH-005

import { type UserEntity } from "./user-models.ts";

/**
 * Catalogo tassativo dei permessi operativi prescritti dalla specifica (SRS §2.2, RF-AUTH-005).
 * Include uno e un solo permesso per ciascuna operazione effettivamente documentata.
 */
export const AppPermission = {
  // Visualizzare la flotta e il dettaglio robot (RF-ROB-001, RF-ROB-003)
  FLEET_VIEW: "FLEET_VIEW",

  // Visualizzare lo stato interpretato (RF-MON-006)
  STATUS_VIEW: "STATUS_VIEW",

  // Richiedere l'aggiornamento manuale dello stato (RF-MON-004)
  STATUS_REFRESH_MANUAL: "STATUS_REFRESH_MANUAL",

  // Aprire il terminale SSH (RF-SSH-001)
  TERMINAL_OPEN: "TERMINAL_OPEN",

  // Navigare il filesystem remoto del robot (RF-FS-001)
  FS_REMOTE_NAVIGATE: "FS_REMOTE_NAVIGATE",

  // Scaricare file dal filesystem remoto del robot (RF-FS-004)
  FS_REMOTE_DOWNLOAD: "FS_REMOTE_DOWNLOAD",

  // Caricare file verso il filesystem remoto del robot (RF-FS-005)
  FS_REMOTE_UPLOAD: "FS_REMOTE_UPLOAD",

  // Navigare il filesystem del server (RF-SRVFS-002)
  FS_SERVER_NAVIGATE: "FS_SERVER_NAVIGATE",

  // Caricare file sul filesystem del server (RF-SRVFS-003)
  FS_SERVER_UPLOAD: "FS_SERVER_UPLOAD",

  // Scaricare file dal filesystem del server (RF-SRVFS-004)
  FS_SERVER_DOWNLOAD: "FS_SERVER_DOWNLOAD",

  // Eseguire trasferimenti server-robot (RF-TRF-002)
  TRANSFER_SERVER_ROBOT: "TRANSFER_SERVER_ROBOT",

  // Eseguire trasferimenti computer-robot (RF-TRF-003)
  TRANSFER_CLIENT_ROBOT: "TRANSFER_CLIENT_ROBOT",

  // Registrare un nuovo robot (RF-ROB-004)
  ROBOT_REGISTER: "ROBOT_REGISTER",

  // Modificare la configurazione di un robot (§2.2, §8.3)
  ROBOT_CONFIG_UPDATE: "ROBOT_CONFIG_UPDATE",

  // Disabilitare un robot (RF-ROB-013, §8.4)
  ROBOT_DISABLE: "ROBOT_DISABLE",

  // Rimuovere un robot dall'anagrafica attiva (§8.4 punto 1)
  ROBOT_REMOVE: "ROBOT_REMOVE",

  // Permesso separato per eliminare i dati archiviati sul server (RF-ROB-013, §8.4 punto 2)
  // NOTA SRS: Permesso definito ma operazione NON implementata ("se implementata")
  FS_SERVER_DELETE: "FS_SERVER_DELETE",
} as const;

export type AppPermission = typeof AppPermission[keyof typeof AppPermission];

/**
 * Mappatura configurabile dei ruoli sui permessi (§2.2, §11.6, RF-AUTH-005).
 * Non cablata nel codice: configurabile a runtime.
 */
export type RolePermissionMapping = Record<string, AppPermission[]>;

/**
 * Mappatura predefinita derivata strettamente dalle due categorie logiche della SRS (§2.2):
 * 1. "Utente autorizzato" (operatore): sola consultazione, monitoraggio e funzioni operative autorizzate.
 * 2. "Amministratore o gestore flotta": funzioni operative + registrazione, configurazione, disabilitazione e rimozione robot.
 */
export const DEFAULT_ROLE_PERMISSIONS: RolePermissionMapping = {
  operatore: [
    AppPermission.FLEET_VIEW,
    AppPermission.STATUS_VIEW,
    AppPermission.STATUS_REFRESH_MANUAL,
    // RF-04: TERMINAL_OPEN rimosso da operatore (riservato esclusivamente agli amministratori)
    AppPermission.FS_REMOTE_NAVIGATE,
    AppPermission.FS_REMOTE_DOWNLOAD,
    AppPermission.FS_REMOTE_UPLOAD,
    AppPermission.FS_SERVER_NAVIGATE,
    AppPermission.FS_SERVER_UPLOAD,
    AppPermission.FS_SERVER_DOWNLOAD,
    AppPermission.TRANSFER_SERVER_ROBOT,
    AppPermission.TRANSFER_CLIENT_ROBOT,
  ],
  admin: [
    AppPermission.FLEET_VIEW,
    AppPermission.STATUS_VIEW,
    AppPermission.STATUS_REFRESH_MANUAL,
    AppPermission.TERMINAL_OPEN,
    AppPermission.FS_REMOTE_NAVIGATE,
    AppPermission.FS_REMOTE_DOWNLOAD,
    AppPermission.FS_REMOTE_UPLOAD,
    AppPermission.FS_SERVER_NAVIGATE,
    AppPermission.FS_SERVER_UPLOAD,
    AppPermission.FS_SERVER_DOWNLOAD,
    AppPermission.TRANSFER_SERVER_ROBOT,
    AppPermission.TRANSFER_CLIENT_ROBOT,
    AppPermission.ROBOT_REGISTER,
    AppPermission.ROBOT_CONFIG_UPDATE,
    AppPermission.ROBOT_DISABLE,
    AppPermission.ROBOT_REMOVE,
  ],
  amministratore: [
    AppPermission.FLEET_VIEW,
    AppPermission.STATUS_VIEW,
    AppPermission.STATUS_REFRESH_MANUAL,
    AppPermission.TERMINAL_OPEN,
    AppPermission.FS_REMOTE_NAVIGATE,
    AppPermission.FS_REMOTE_DOWNLOAD,
    AppPermission.FS_REMOTE_UPLOAD,
    AppPermission.FS_SERVER_NAVIGATE,
    AppPermission.FS_SERVER_UPLOAD,
    AppPermission.FS_SERVER_DOWNLOAD,
    AppPermission.TRANSFER_SERVER_ROBOT,
    AppPermission.TRANSFER_CLIENT_ROBOT,
    AppPermission.ROBOT_REGISTER,
    AppPermission.ROBOT_CONFIG_UPDATE,
    AppPermission.ROBOT_DISABLE,
    AppPermission.ROBOT_REMOVE,
    // FS_SERVER_DELETE non viene assegnato di default, è facoltativo e isolato
  ],
};

/**
 * Valuta l'autorizzazione di un utente per un determinato permesso (RNF-SEC-004, RF-AUTH-005).
 * Supporta la valutazione di permessi globali e di permessi vincolati a uno specifico robot (CA-SSH-005).
 * Default fail-closed: restituisce false se non esplicitamente concesso.
 */
export function hasPermission(
  user: UserEntity,
  permission: AppPermission,
  targetRobotId?: string,
  roleMapping: RolePermissionMapping = DEFAULT_ROLE_PERMISSIONS
): boolean {
  if (!user.enabled) {
    return false;
  }

  // 1. Verifica se l'utente ha il permesso specifico vincolato a quel robot (CA-SSH-005)
  if (targetRobotId && user.robotPermissions && user.robotPermissions[targetRobotId]) {
    const robotPerms = user.robotPermissions[targetRobotId];
    if (robotPerms.includes(permission)) {
      return true;
    }
  }

  // 2. Verifica se l'utente possiede il permesso esplicito nei suoi permessi personali globali
  if (user.permissions && user.permissions.includes(permission)) {
    return true;
  }

  // 3. Verifica i permessi associati ai ruoli dell'utente secondo il roleMapping configurato
  for (const role of user.roles) {
    const perms = roleMapping[role];
    if (perms && perms.includes(permission)) {
      return true;
    }
  }

  // Default fail-closed: negato
  return false;
}
