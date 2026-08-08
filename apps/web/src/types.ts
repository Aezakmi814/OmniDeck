export type Role = "admin" | "viewer";

export interface User {
  id: string;
  username: string;
  displayName: string;
  role: Role;
  disabled?: boolean;
  mustChangePassword: boolean;
  createdAt?: string;
  lastLoginAt?: string | null;
}

export interface NodeMetric {
  sampledAt: string;
  cpuPercent: number;
  memoryTotalBytes: number;
  memoryUsedBytes: number;
  uptimeSeconds: number;
  disks: Array<{ mount: string; totalBytes: number; usedBytes: number }>;
  services: Array<{ name: string; state: string }>;
}

export interface NodeItem {
  id: string;
  name: string;
  platform: string;
  kind: "server" | "nas" | "laptop" | "vm";
  labels: Record<string, string>;
  alertOnOffline: boolean;
  offlineAfterSeconds: number;
  enabled: boolean;
  online: boolean;
  createdAt: string;
  lastSeenAt: string | null;
  agentVersion: string | null;
  latest: NodeMetric | null;
}

export interface LatestCheck {
  checkedAt: string;
  success: boolean;
  statusCode: number | null;
  ttfbMs: number | null;
  totalMs: number | null;
  error: string | null;
  location: string;
}

export interface EndpointItem {
  id: string;
  name: string;
  url: string;
  method: "GET" | "HEAD";
  expectedStatus: number;
  timeoutSeconds: number;
  intervalSeconds: number;
  enabled: boolean;
  verifyTls: boolean;
  hasHeaders: boolean;
  probeNodeIds: string[];
  createdAt: string;
  latest: LatestCheck | null;
}

export interface AiTargetItem {
  id: string;
  name: string;
  baseUrl: string;
  chatPath: string;
  model: string;
  prompt: string;
  intervalSeconds: number;
  timeoutSeconds: number;
  enabled: boolean;
  balanceUrl: string | null;
  balancePath: string | null;
  balanceIntervalSeconds: number;
  hasApiKey: boolean;
  probeNodeIds: string[];
  createdAt: string;
  latest: (LatestCheck & { responseValid: boolean; balance: number | null }) | null;
}

export interface AlertItem {
  id: string;
  source_type: string;
  source_id: string;
  severity: string;
  title: string;
  message: string;
  status: "open" | "resolved";
  opened_at: string;
  resolved_at: string | null;
}
