export interface User {
  id: string;
  username: string;
  roles: string[];
  enabled: boolean;
  allowedPaths?: string[];
  createdAt?: string;
  updatedAt?: string;
}

export interface AuthSessionResponse {
  success: boolean;
  user: User;
  token?: string;
  expiresInMinutes?: number;
}

export interface IdleWarningInfo {
  active: boolean;
  context: "sessione" | "terminale";
  remainingSeconds: number;
  message?: string;
  targetName?: string;
}
