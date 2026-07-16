/**
 * Record & Play — shared types for the local desktop agent module.
 *
 * These describe the cloud-side entities and the agent wire protocol. The agent
 * workspace (agent/) keeps a build-time copy of the protocol frame shapes; keep the
 * `AgentFrameType` union and payloads here the single source of truth for the contract.
 */

export type AgentStatus = 'offline' | 'online' | 'busy';

export interface AgentRecord {
  id: string;
  name: string;
  machineName: string;
  os: string;
  fingerprint: string;
  tokenHash: string;
  refreshHash: string;
  version: string;
  playwrightVersion: string;
  browsers: string[];
  cpu: Record<string, any>;
  memory: Record<string, any>;
  status: AgentStatus;
  lastHeartbeatAt: string | null;
  createdAt: string;
  updatedAt: string;
  revokedAt: string | null;
  projectId: string;
  appId: string;
  ownerId: string;
}

/** Agent record with secrets stripped — the only shape ever returned over the API. */
export interface PublicAgent {
  id: string;
  name: string;
  machineName: string;
  os: string;
  version: string;
  playwrightVersion: string;
  browsers: string[];
  cpu: Record<string, any>;
  memory: Record<string, any>;
  status: AgentStatus;
  lastHeartbeatAt: string | null;
  createdAt: string;
  revoked: boolean;
  projectId: string;
  appId: string;
  ownerId: string;
}

export type JobStatus = 'queued' | 'dispatched' | 'running' | 'uploading' | 'done' | 'failed' | 'cancelled';
export type JobTrigger = 'manual' | 'schedule' | 'webhook' | 'ci';
export type ScheduleKind = 'now' | 'once' | 'daily' | 'weekly' | 'monthly' | 'cron' | 'webhook';
export type ArtifactKind = 'video' | 'trace' | 'screenshot' | 'html' | 'junit' | 'log' | 'other';

/** Agent → cloud WebSocket frame types (Phase 2 gateway consumes these). */
export type AgentFrameType =
  | 'hello'
  | 'heartbeat'
  | 'record.status'
  | 'record.chunk'
  | 'record.done'
  | 'job.progress'
  | 'job.log'
  | 'job.done'
  | 'error'
  // cloud → agent
  | 'record.start'
  | 'record.stop'
  | 'job.dispatch'
  | 'cancel';

export interface AgentFrame<T = any> {
  type: AgentFrameType;
  agentId: string;
  seq: number;
  payload: T;
}

/** Machine facts an agent reports on registration + heartbeat. */
export interface AgentTelemetry {
  machineName: string;
  os: string;
  version: string;
  playwrightVersion: string;
  browsers: string[];
  cpu: Record<string, any>;
  memory: Record<string, any>;
}
