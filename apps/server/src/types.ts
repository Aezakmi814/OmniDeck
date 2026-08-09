export type UserRole = "admin" | "viewer";

export interface SessionUser {
  id: string;
  username: string;
  displayName: string;
  role: UserRole;
  mustChangePassword: boolean;
  email: string | null;
  locale: string;
  timezone: string;
}

export interface UserRow {
  id: string;
  username: string;
  display_name: string;
  password_hash: string;
  role: UserRole;
  disabled: number;
  must_change_password: number;
  created_at: string;
  updated_at: string;
  last_login_at: string | null;
  email: string | null;
  locale: string;
  timezone: string;
  deleted_at: string | null;
}

export interface NodeRow {
  id: string;
  name: string;
  platform: string;
  kind: string;
  labels: string;
  token_hash: string;
  alert_on_offline: number;
  offline_after_seconds: number;
  enabled: number;
  created_at: string;
  updated_at: string;
  last_seen_at: string | null;
  agent_version: string | null;
}

export interface EndpointRow {
  id: string;
  name: string;
  url: string;
  method: string;
  expected_status: number;
  timeout_seconds: number;
  interval_seconds: number;
  enabled: number;
  verify_tls: number;
  headers_encrypted: string | null;
  created_at: string;
  updated_at: string;
}

export interface AiTargetRow {
  id: string;
  name: string;
  base_url: string;
  chat_path: string;
  model: string;
  api_key_encrypted: string;
  prompt: string;
  interval_seconds: number;
  timeout_seconds: number;
  enabled: number;
  balance_url: string | null;
  balance_path: string | null;
  balance_interval_seconds: number;
  created_at: string;
  updated_at: string;
}

export interface AgentReport {
  timestamp: string;
  hostname: string;
  platform: string;
  version: string;
  uptimeSeconds: number;
  cpuPercent: number;
  memoryTotalBytes: number;
  memoryUsedBytes: number;
  load1?: number;
  disks: Array<{
    mount: string;
    totalBytes: number;
    usedBytes: number;
  }>;
  networks: Array<{
    name: string;
    rxBytes: number;
    txBytes: number;
  }>;
  services?: Array<{
    name: string;
    state: string;
  }>;
}
