// Requisiti soddisfatti: RF-SSH-004, RF-SSH-005, RF-SSH-006, RF-SSH-008,
// RNF-SEC-004, RNF-SEC-007, RNF-REL-005, SRS §5.4, §6.4 passi 4-7, §11.6

import { type ClientChannel } from "ssh2";
import { type ManagedRobotConnection } from "../connection/robot-connection-manager.ts";
import { type AuthorizedContext } from "../auth/session-manager.ts";
import { type UserEntity } from "../auth/user-models.ts";

export type TerminalSessionState = "connecting" | "active" | "closing" | "closed" | "error";

/**
 * Cause formali di chiusura e rilascio delle risorse (RF-SSH-005, §6.4 passo 7, CA-SSH-004)
 */
export type TerminalCloseReason =
  | "USER_EXPLICIT"            // Chiusura esplicita dell'utente dal frontend (CA-SSH-004)
  | "CLIENT_DISCONNECT"         // Disconnessione del browser o interruzione WebSocket
  | "IDLE_TIMEOUT"              // Timeout di inattività della sessione terminale
  | "USER_SESSION_TERMINATED"   // Logout o scadenza della sessione utente Moliris
  | "ROBOT_DISCONNECT"          // Disconnessione, errore di rete o timeout del robot
  | "REMOTE_EXIT"               // Chiusura normale della shell remota (exit, Ctrl+D)
  | "SERVICE_SHUTDOWN"          // Arresto controllato del servizio backend
  | "ERROR"                     // Errore irreversibile del canale PTY o della connessione SSH
  | "ADMIN_DISABLED";           // Robot disabilitato con politica "chiudi_immediatamente"

export interface TerminalSessionDimensions {
  cols: number;
  rows: number;
}

/**
 * Oggetto che rappresenta una sessione di terminale interattivo (RF-SSH-004, §5.4).
 * Rigorosamente associata a utente, robot e contesto autorizzato (RF-SSH-006, RNF-SEC-007).
 */
export interface TerminalSession {
  sessionId: string;
  userId: string;
  username: string;
  robotId: string;
  authorizedContext: AuthorizedContext;
  state: TerminalSessionState;
  cols: number;
  rows: number;
  createdAt: Date;
  lastActivityAt: Date;
  managedConnection: ManagedRobotConnection;
  ptyChannel: ClientChannel;
  webSocket?: any; // Instanza WebSocket (@fastify/websocket o ws)
  closeReason?: TerminalCloseReason;
  diagnosticError?: string;
}

/**
 * Interfaccia di estensione per supervisione e condivisione sessioni (§11.6, RF-SSH-006).
 * La SRS stabilisce: "Un utente non può accedere alla sessione di un altro utente senza un'autorizzazione esplicita".
 * Poiché la SRS non definisce alcun meccanismo di condivisione o supervisione,
 * l'implementazione predefinita adotta un rifiuto categorico fail-closed: ogni tentativo
 * da parte di utenti non titolari è negato e segnalato come violazione di sicurezza.
 */
export interface TerminalSessionSharingPolicy {
  canAccessSession(requestingUser: UserEntity, session: TerminalSession): boolean;
}

export class DefaultDenyTerminalSessionSharingPolicy implements TerminalSessionSharingPolicy {
  canAccessSession(requestingUser: UserEntity, session: TerminalSession): boolean {
    // Solo il titolare della sessione è autorizzato (RF-SSH-006, CA-SSH-005)
    return requestingUser.id === session.userId;
  }
}
