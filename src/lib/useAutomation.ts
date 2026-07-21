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

export interface RecordingCaseMeta {
  testingType?: string; priority?: string; folderId?: string;
  testPlanIds?: string[]; testSuiteIds?: string[];
}
export interface StartRecordingInput {
  name: string; appUrl: string; browser: string; environment: string; agentId: string; caseMeta?: RecordingCaseMeta;
}
export type RecordingPhase = 'setup' | 'recording' | 'summary';

/**
 * The record-a-flow state machine (setup → recording → summary), shared by the standalone Record
 * Test page and the New Case → Automation panel. Owns the codegen lifecycle calls, the live SSE
 * stream (script/stats/done), the elapsed timer, and the Stop safety-net fallback. UI concerns
 * (toasts, confirm dialogs) stay with the caller; start() resolves the new recording id or throws.
 */
export function useRecordingSession(opts?: { onAgentEvent?: () => void }): {
  phase: RecordingPhase; recordingId: string; script: string; stats: Record<string, number>;
  elapsed: number; mmss: string; busy: boolean; caseId: string;
  start: (input: StartRecordingInput) => Promise<string>; stop: () => Promise<void>;
  discard: () => Promise<void>; reset: () => void;
} {
  const [phase, setPhase] = useState<RecordingPhase>('setup');
  const [recordingId, setRecordingId] = useState('');
  const [script, setScript] = useState('');
  const [stats, setStats] = useState<Record<string, number>>({});
  const [elapsed, setElapsed] = useState(0);
  const [busy, setBusy] = useState(false);
  const [caseId, setCaseId] = useState('');
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Safety net for Stop: the UI leaves 'recording' when recording.done lands. If that event is
  // delayed/lost, this fallback still moves us to summary so the timer can't count forever.
  const stopFallbackRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearStopFallback = () => { if (stopFallbackRef.current) { clearTimeout(stopFallbackRef.current); stopFallbackRef.current = null; } };
  const stopTimer = () => { if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; } };
  const startTimer = () => { setElapsed(0); timerRef.current = setInterval(() => setElapsed((e) => e + 1), 1000); };
  useEffect(() => () => { stopTimer(); clearStopFallback(); }, []);

  useAgentEvents((evt) => {
    if (evt.scopeType === 'agent') { opts?.onAgentEvent?.(); return; }
    if (evt.scopeId !== recordingId) return;
    if (evt.type === 'recording.chunk' && typeof evt.data.script === 'string') setScript(evt.data.script);
    if (evt.type === 'recording.status' && evt.data.stats) setStats((s) => ({ ...s, ...evt.data.stats }));
    if (evt.type === 'recording.done') {
      clearStopFallback();
      const rec = evt.data.recording as Recording | undefined;
      if (rec) { setScript(rec.script || ''); setStats(rec.stats || {}); }
      if (typeof evt.data.caseId === 'string') setCaseId(evt.data.caseId);
      stopTimer();
      setPhase('summary');
    }
  });

  const start = async (input: StartRecordingInput): Promise<string> => {
    if (busy) throw new Error('A recording is already starting.');
    setBusy(true);
    try {
      const created = await fetch('/api/automation/recordings', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
      }).then((r) => r.json());
      const id = created?.recording?.id;
      if (!id) throw new Error('create failed');
      const started = await fetch(`/api/automation/recordings/${id}/start`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agentId: input.agentId }),
      });
      if (!started.ok) throw new Error((await started.json())?.error || 'start failed');
      setRecordingId(id); setScript(''); setStats({}); setCaseId(''); setPhase('recording'); startTimer();
      return id;
    } finally { setBusy(false); }
  };

  const stop = async (): Promise<void> => {
    if (!recordingId || busy) return;
    setBusy(true);
    // Stop the clock immediately — don't keep counting while we wait on the agent's round-trip.
    stopTimer();
    try { await fetch(`/api/automation/recordings/${recordingId}/stop`, { method: 'POST' }); }
    catch { /* ignore */ } finally { setBusy(false); }
    clearStopFallback();
    stopFallbackRef.current = setTimeout(() => { setPhase((p) => (p === 'recording' ? 'summary' : p)); }, 8000);
  };

  const discard = async (): Promise<void> => {
    stopTimer();
    if (recordingId) await fetch(`/api/automation/recordings/${recordingId}`, { method: 'DELETE' }).catch(() => {});
    setRecordingId(''); setScript(''); setStats({}); setCaseId(''); setPhase('setup');
  };

  const reset = () => { setPhase('setup'); setRecordingId(''); setScript(''); setStats({}); setCaseId(''); };

  const mmss = `${String(Math.floor(elapsed / 60)).padStart(2, '0')}:${String(elapsed % 60).padStart(2, '0')}`;
  return { phase, recordingId, script, stats, elapsed, mmss, busy, caseId, start, stop, discard, reset };
}
