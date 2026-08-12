/**
 * Record & Play — shared types for the local desktop agent module.
 *
 * These describe the cloud-side entities and the agent wire protocol. The agent
 * workspace (agent/) keeps a build-time copy of the protocol frame shapes; keep the
 * `AgentFrameType` union and payloads here the single source of truth for the contract.
 */

export type AgentStatus = 'offline' | 'online' | 'busy';

export type RecordingStepType = 'fill' | 'press' | 'check' | 'uncheck' | 'select' | 'upload';
export type RecordingFieldKind = 'text' | 'number' | 'email' | 'phone' | 'date' | 'boolean' | 'select' | 'file' | 'unknown';
export type DatasetProviderType = 'csv' | 'xlsx';
export type DatasetColumnKind = 'text' | 'number' | 'email' | 'phone' | 'date' | 'boolean';

export interface DatasetColumn {
  id: string;
  name: string;
  ordinal: number;
  kind: DatasetColumnKind;
  nullable: boolean;
}

export interface AutomationDataset {
  id: string;
  name: string;
  provider: DatasetProviderType;
  sourceFilename: string;
  sourceHash: string;
  columns: DatasetColumn[];
  rowCount: number;
  status: 'ready' | 'failed';
  createdAt: string;
  updatedAt: string;
  projectId: string;
  appId: string;
  ownerId: string;
}

/** Immutable, safe-to-display action metadata derived from a finalized codegen script. */
export interface RecordingStep {
  id: string;
  recordingId: string;
  ordinal: number;
  type: RecordingStepType;
  locator: string;
  locatorStrategy: 'role' | 'label' | 'placeholder' | 'testId' | 'unknown';
  fieldKind: RecordingFieldKind;
  originalValue: string | boolean | null;
  currentOverride: string | boolean | null;
  readOnly: boolean;
  metadata: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
}

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

export type JobStatus = 'queued' | 'dispatched' | 'running' | 'awaiting_user' | 'uploading' | 'done' | 'failed' | 'cancelled';
export type JobTrigger = 'manual' | 'schedule' | 'webhook' | 'ci' | 'live-recording';
export type ScheduleKind = 'now' | 'once' | 'daily' | 'weekly' | 'monthly' | 'cron' | 'webhook';
export type ScheduleExecutionMode = 'sequential' | 'parallel';
export type ScheduleFailurePolicy = 'stop' | 'continue';
export type ScheduleExecutionStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
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
  | 'job.paused'
  | 'job.done'
  | 'error'
  // cloud → agent
  | 'record.start'
  | 'record.pause'
  | 'record.resume'
  | 'record.stop'
  | 'job.dispatch'
  | 'pause.resume'
  | 'pause.cancel'
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
