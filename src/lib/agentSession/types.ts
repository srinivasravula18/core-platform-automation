export type AgentExecutionStatus = 'idle' | 'queued' | 'running' | 'reconnecting' | 'completed' | 'failed' | 'cancelled' | 'stalled';

export interface AgentExecutionSnapshot {
  id: string;
  /** Server-side durable identifier: currently an agent-run task id. */
  serverId: string;
  kind: 'agent-run' | 'chat-stream' | 'understanding-job';
  status: AgentExecutionStatus;
  progress?: Record<string, unknown>;
  updatedAt: string;
  reconnectAttempts: number;
  lastError?: string;
}

export interface AgentSessionSnapshot {
  id: string;
  conversationId: string;
  workspaceId: string;
  projectId?: string;
  appId?: string;
  executionIds: string[];
  updatedAt: string;
}

export const TERMINAL_AGENT_EXECUTION_STATUSES: readonly AgentExecutionStatus[] = [
  'completed', 'failed', 'cancelled', 'stalled',
];

export function isTerminalAgentExecution(status: AgentExecutionStatus): boolean {
  return TERMINAL_AGENT_EXECUTION_STATUSES.includes(status);
}
