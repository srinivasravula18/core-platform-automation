import { withEventSourceAuth } from '@/src/lib/base-path';
import { useAgentSessionStore } from '@/src/store/agentSession';
import type { AgentExecutionSnapshot, AgentExecutionStatus, AgentSessionSnapshot } from './types';
import { isTerminalAgentExecution } from './types';

const MAX_RECONNECTS = 8;
const CHANNEL = 'tfa-agent-session-v1';
const LEASE_TTL_MS = 12_000;

/**
 * Application-lifetime owner for agent execution transports. React views may attach and detach
 * freely; only explicit cancellation is allowed to stop a durable server execution.
 */
export class AgentSessionManager {
  private sources = new Map<string, EventSource>();
  private reconnectTimers = new Map<string, number>();
  private leaseTimers = new Map<string, number>();
  private channel: BroadcastChannel | null = null;
  private disposed = false;
  private readonly tabId = crypto.randomUUID();

  start(): void {
    useAgentSessionStore.getState().hydrate();
    if ('BroadcastChannel' in window) {
      this.channel = new BroadcastChannel(CHANNEL);
      this.channel.onmessage = (event: MessageEvent<AgentExecutionSnapshot>) => {
        if (event.data?.id && event.data?.serverId) useAgentSessionStore.getState().upsertExecution(event.data);
      };
    }
    window.addEventListener('online', this.reconnectActive);
    for (const execution of Object.values(useAgentSessionStore.getState().executions)) {
      if (!isTerminalAgentExecution(execution.status) && execution.kind === 'agent-run') this.connectRun(execution.id);
    }
  }

  stop(): void {
    this.disposed = true;
    window.removeEventListener('online', this.reconnectActive);
    for (const [executionId, source] of this.sources) { source.close(); this.releaseLease(executionId); }
    this.sources.clear();
    for (const timer of this.reconnectTimers.values()) window.clearTimeout(timer);
    this.reconnectTimers.clear();
    for (const timer of this.leaseTimers.values()) window.clearInterval(timer);
    this.leaseTimers.clear();
    this.channel?.close();
    this.channel = null;
  }

  createOrActivateSession(input: Omit<AgentSessionSnapshot, 'id' | 'executionIds' | 'updatedAt'> & { id?: string }): string {
    const id = input.id || crypto.randomUUID();
    const now = new Date().toISOString();
    const existing = useAgentSessionStore.getState().sessions[id];
    useAgentSessionStore.getState().upsertSession({ ...existing, ...input, id, executionIds: existing?.executionIds || [], updatedAt: now });
    useAgentSessionStore.getState().setActiveSession(id);
    return id;
  }

  registerRun(sessionId: string, taskId: string): string {
    const store = useAgentSessionStore.getState();
    const session = store.sessions[sessionId];
    if (!session) throw new Error(`Unknown agent session ${sessionId}`);
    const existing = Object.values(store.executions).find((item) => item.serverId === taskId && item.kind === 'agent-run');
    const id = existing?.id || crypto.randomUUID();
    const now = new Date().toISOString();
    store.upsertExecution({ id, serverId: taskId, kind: 'agent-run', status: existing?.status || 'running', progress: existing?.progress, updatedAt: now, reconnectAttempts: 0 });
    store.upsertSession({ ...session, executionIds: session.executionIds.includes(id) ? session.executionIds : [...session.executionIds, id], updatedAt: now });
    this.connectRun(id);
    return id;
  }

  /** Attach an existing durable run (for restored conversations and legacy deep-run cards). */
  observeRun(taskId: string): string {
    const existing = Object.values(useAgentSessionStore.getState().executions)
      .find((item) => item.serverId === taskId && item.kind === 'agent-run');
    if (existing) {
      this.connectRun(existing.id);
      return existing.id;
    }
    const sessionId = this.createOrActivateSession({
      id: `recovered:${taskId}`,
      conversationId: '',
      workspaceId: 'default',
    });
    return this.registerRun(sessionId, taskId);
  }

  async refreshRun(executionId: string): Promise<any | null> {
    const execution = useAgentSessionStore.getState().executions[executionId];
    if (!execution || execution.kind !== 'agent-run') return null;
    const response = await fetch(`/api/agent-runs/${execution.serverId}/details`, { cache: 'no-store' });
    if (!response.ok) throw new Error(response.status === 404 ? 'This agent run is no longer available. Start a new run to continue.' : `Failed to load run (${response.status}).`);
    const details = await response.json();
    this.applyRunStatus(executionId, details);
    return details;
  }

  updateRun(executionId: string, update: any | ((previous: any) => any)): void {
    const current = useAgentSessionStore.getState().executions[executionId];
    if (!current) return;
    const previous = current.progress || {};
    const progress = typeof update === 'function' ? update(previous) : update;
    this.applyRunStatus(executionId, progress);
  }

  private reconnectActive = (): void => {
    for (const execution of Object.values(useAgentSessionStore.getState().executions)) {
      if (!isTerminalAgentExecution(execution.status) && execution.kind === 'agent-run') this.connectRun(execution.id);
    }
  };

  private connectRun(executionId: string): void {
    if (this.disposed || this.sources.has(executionId) || !navigator.onLine) return;
    const execution = useAgentSessionStore.getState().executions[executionId];
    if (!execution || isTerminalAgentExecution(execution.status)) return;
    // One tab owns a transport for a run. Other tabs render BroadcastChannel projections and
    // retry after the renewable lease expires, preventing duplicate EventSources and listeners.
    if (!this.acquireLease(executionId)) {
      this.deferFollowerRetry(executionId);
      return;
    }
    const source = new EventSource(withEventSourceAuth(`/api/agent-runs/${execution.serverId}/events`));
    this.sources.set(executionId, source);
    const apply = (payload: any) => this.applyRunStatus(executionId, payload);
    source.addEventListener('status', (event) => apply(JSON.parse((event as MessageEvent).data)));
    source.addEventListener('done', (event) => { apply(JSON.parse((event as MessageEvent).data)); this.closeSource(executionId); });
    source.onerror = () => {
      this.closeSource(executionId);
      this.scheduleReconnect(executionId);
    };
  }

  private applyRunStatus(executionId: string, payload: any): void {
    const current = useAgentSessionStore.getState().executions[executionId];
    if (!current) return;
    const status = String(payload?.status || current.status) as AgentExecutionStatus;
    const progress = { ...(current.progress || {}), ...(payload || {}) };
    const next: AgentExecutionSnapshot = { ...current, status, progress, updatedAt: new Date().toISOString(), reconnectAttempts: 0, lastError: undefined };
    useAgentSessionStore.getState().upsertExecution(next);
    this.channel?.postMessage(next);
    if (isTerminalAgentExecution(status)) this.closeSource(executionId);
  }

  private closeSource(executionId: string): void {
    this.sources.get(executionId)?.close();
    this.sources.delete(executionId);
    this.releaseLease(executionId);
  }

  private scheduleReconnect(executionId: string): void {
    const current = useAgentSessionStore.getState().executions[executionId];
    if (!current || isTerminalAgentExecution(current.status) || this.reconnectTimers.has(executionId)) return;
    const attempts = current.reconnectAttempts + 1;
    const delay = Math.min(30_000, 750 * 2 ** Math.min(attempts, 5)) + Math.round(Math.random() * 250);
    useAgentSessionStore.getState().upsertExecution({ ...current, status: attempts >= MAX_RECONNECTS ? 'stalled' : 'reconnecting', reconnectAttempts: attempts, updatedAt: new Date().toISOString(), lastError: 'Live updates disconnected.' });
    if (attempts >= MAX_RECONNECTS) return;
    const timer = window.setTimeout(() => { this.reconnectTimers.delete(executionId); this.connectRun(executionId); }, delay);
    this.reconnectTimers.set(executionId, timer);
  }

  private leaseKey(executionId: string): string { return `tfa_agent_session_lease:${executionId}`; }

  private acquireLease(executionId: string): boolean {
    try {
      const now = Date.now();
      const stored = JSON.parse(localStorage.getItem(this.leaseKey(executionId)) || 'null') as { owner?: string; expiresAt?: number } | null;
      if (stored?.owner && stored.owner !== this.tabId && Number(stored.expiresAt) > now) return false;
      localStorage.setItem(this.leaseKey(executionId), JSON.stringify({ owner: this.tabId, expiresAt: now + LEASE_TTL_MS }));
      const confirmed = JSON.parse(localStorage.getItem(this.leaseKey(executionId)) || '{}');
      if (confirmed.owner !== this.tabId) return false;
      if (!this.leaseTimers.has(executionId)) {
        this.leaseTimers.set(executionId, window.setInterval(() => {
          try { localStorage.setItem(this.leaseKey(executionId), JSON.stringify({ owner: this.tabId, expiresAt: Date.now() + LEASE_TTL_MS })); } catch { /* storage unavailable */ }
        }, LEASE_TTL_MS / 2));
      }
      return true;
    } catch {
      // Private-mode storage failures should not prevent a single-tab console from receiving updates.
      return true;
    }
  }

  private releaseLease(executionId: string): void {
    const timer = this.leaseTimers.get(executionId);
    if (timer) window.clearInterval(timer);
    this.leaseTimers.delete(executionId);
    try {
      const stored = JSON.parse(localStorage.getItem(this.leaseKey(executionId)) || '{}');
      if (stored.owner === this.tabId) localStorage.removeItem(this.leaseKey(executionId));
    } catch { /* best effort */ }
  }

  private deferFollowerRetry(executionId: string): void {
    if (this.reconnectTimers.has(executionId)) return;
    const timer = window.setTimeout(() => {
      this.reconnectTimers.delete(executionId);
      this.connectRun(executionId);
    }, LEASE_TTL_MS + 250);
    this.reconnectTimers.set(executionId, timer);
  }
}
