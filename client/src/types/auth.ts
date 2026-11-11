export interface User {
  id: string;
  username: string;
  roles: string[];
  enabled: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface AuthSessionResponse {
  success: boolean;
  user: User;
  token?: string;
  expiresInMinutes?: number;
}
