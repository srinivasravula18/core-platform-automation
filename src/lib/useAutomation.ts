import { useEffect, useRef, useState, useCallback } from 'react';
import { withEventSourceAuth } from '@/src/lib/base-path';

// Client types mirror the cloud's PublicAgent / recording / job / schedule shapes (server/features/automation).
export interface Agent {
  id: string;
  name: string;
  machineName: string;
  os: string;
  version: string;
  playwrightVersion: string;
  browsers: string[];
  cpu: { model?: string; cores?: number; loadAvg?: number };
  memory: { totalMb?: number; freeMb?: number };
  status: 'offline' | 'online' | 'busy';
  lastHeartbeatAt: string | null;
  createdAt: string;
  revoked: boolean;
}

export interface Recording {
  id: string; name: string; appUrl: string; browser: string; environment: string;
  status: 'draft' | 'recording' | 'ready'; script: string; agentId: string | null;
  stats: Record<string, number>; createdAt: string; completedAt: string | null;
}

export interface Job {
  id: string; recordingId: string; agentId: string; trigger: string; status: string;
  queuedAt: string; startedAt: string | null; finishedAt: string | null; exitCode: number | null;
  summary: Record<string, number>; error: string;
}

export interface Schedule {
  id: string; recordingId: string; agentId: string; kind: string; cron: string; timezone: string;
  enabled: boolean; nextRunAt: string | null; lastRunAt: string | null;
}

export interface AutomationEvent {
  scopeType: 'agent' | 'job' | 'recording'; scopeId: string; type: string; data: Record<string, any>; seq?: number;
}

/** Tailwind classes + label for a job/run status pill (shared across the automation pages). */
export function jobStatusMeta(status: string): { label: string; cls: string } {
  switch (status) {
    case 'done': return { label: 'Passed', cls: 'bg-emerald-500/15 text-emerald-500 border-emerald-500/30' };
    case 'failed': return { label: 'Failed', cls: 'bg-red-500/15 text-red-500 border-red-500/30' };
    case 'running': return { label: 'Running', cls: 'bg-blue-500/15 text-blue-500 border-blue-500/30' };
    case 'uploading': return { label: 'Uploading', cls: 'bg-blue-500/15 text-blue-500 border-blue-500/30' };
    case 'dispatched': return { label: 'Dispatched', cls: 'bg-indigo-500/15 text-indigo-500 border-indigo-500/30' };
    case 'cancelled': return { label: 'Cancelled', cls: 'bg-slate-500/15 text-slate-400 border-slate-500/30' };
    default: return { label: 'Queued', cls: 'bg-amber-500/15 text-amber-500 border-amber-500/30' };
  }
}

// Cache the app-config probe so every consumer doesn't refetch it.
let cachedRemoteAgent: boolean | null = null;
let inflight: Promise<boolean> | null = null;

async function fetchRemoteAgentFlag(): Promise<boolean> {
  if (cachedRemoteAgent !== null) return cachedRemoteAgent;
  if (!inflight) {
    inflight = fetch('/api/app-config')
      .then((r) => r.json())
      .then((d) => { cachedRemoteAgent = !!d?.remoteAgent; return cachedRemoteAgent; })
      .catch(() => { cachedRemoteAgent = false; return false; });
  }
  return inflight;
}

/** Whether the Record & Play (local desktop agent) feature is enabled on the backend. */
export function useRemoteAgentFlag(): boolean | null {
  const [flag, setFlag] = useState<boolean | null>(cachedRemoteAgent);
  useEffect(() => { let live = true; void fetchRemoteAgentFlag().then((f) => { if (live) setFlag(f); }); return () => { live = false; }; }, []);
  return flag;
}

/** Fetch + poll the caller's agents. Returns list, loading, and a manual refresh. */
export function useAgents(pollMs = 10_000) {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/automation/agents');
      const data = await res.json();
      setAgents(Array.isArray(data?.agents) ? data.agents : []);
    } catch { /* keep previous */ } finally { setLoading(false); }
  }, []);
  useEffect(() => {
    void refresh();
    const t = setInterval(refresh, pollMs);
    return () => clearInterval(t);
  }, [refresh, pollMs]);
  return { agents, loading, refresh };
}

function useCollection<T>(url: string, key: string, pollMs = 8_000) {
  const [items, setItems] = useState<T[]>([]);
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    try {
      const data = await fetch(url).then((r) => r.json());
      setItems(Array.isArray(data?.[key]) ? data[key] : []);
    } catch { /* keep previous */ } finally { setLoading(false); }
  }, [url, key]);
  useEffect(() => {
    void refresh();
    const t = setInterval(refresh, pollMs);
    return () => clearInterval(t);
  }, [refresh, pollMs]);
  return { items, loading, refresh };
}

export function useJobs() { const { items, loading, refresh } = useCollection<Job>('/api/automation/jobs', 'jobs'); return { jobs: items, loading, refresh }; }
export function useRecordings() { const { items, loading, refresh } = useCollection<Recording>('/api/automation/recordings', 'recordings'); return { recordings: items, loading, refresh }; }
export function useSchedules() { const { items, loading, refresh } = useCollection<Schedule>('/api/automation/schedules', 'schedules'); return { schedules: items, loading, refresh }; }

/**
 * Subscribe to the live automation event stream (SSE). The handler ref is kept current so the
 * EventSource itself is created once and survives handler changes (no reconnect storms).
 */
export function useAgentEvents(onEvent: (evt: AutomationEvent) => void): void {
  const handler = useRef(onEvent);
  handler.current = onEvent;
  useEffect(() => {
    const es = new EventSource(withEventSourceAuth('/api/automation/events'));
    es.onmessage = (e) => {
      try { handler.current(JSON.parse(e.data)); } catch { /* ignore malformed frame */ }
    };
    return () => es.close();
  }, []);
}
