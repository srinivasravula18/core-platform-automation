import { useEffect, useRef, useState, useCallback } from 'react';
import { withEventSourceAuth } from '@/src/lib/base-path';
import type { BrowserPermissionSettings } from '@/core/shared/browserPermissions';
export type { BrowserPermissionSettings } from '@/core/shared/browserPermissions';

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
  metadata?: { browserPermissions?: BrowserPermissionSettings; caseId?: string; scriptId?: string; [key: string]: any };
}

export interface Job {
  id: string; recordingId: string; agentId: string; trigger: string; status: string; scheduleId?: string | null;
  queuedAt: string; startedAt: string | null; finishedAt: string | null; exitCode: number | null;
  summary: Record<string, any>; error: string;
  /** Groups every job produced by one firing of a multi-test schedule. */
  scheduleExecutionId?: string;
}

/** Jobs still in flight — used to find the run currently backing a schedule/recording. */
export const ACTIVE_JOB_STATUSES = ['queued', 'dispatched', 'running', 'awaiting_user', 'uploading'];

export interface JobPause {
  id: string; jobId: string; pauseId: string; attempt: number; kind: 'input' | 'manual_action';
  prompt: string; hint?: string; masked: boolean; requiresHeaded: boolean; timeoutMs: number;
  onTimeout: 'fail' | 'skip'; outcome: 'open' | 'resolved' | 'skipped' | 'expired' | 'aborted';
  openedAt: string; expiresAt: string; resolvedAt?: string | null; resolvedBy?: string; valueLength?: number | null;
}

export interface Schedule {
  id: string; recordingId: string; agentId: string; title: string; kind: string; cron: string; timezone: string;
  enabled: boolean; nextRunAt: string | null; lastRunAt: string | null;
  executionMode?: 'sequential' | 'parallel'; failurePolicy?: 'stop' | 'continue'; maxConcurrency?: number;
  items?: Array<{ id: string; runnableType: 'recording' | 'script'; runnableId: string; recordingId: string; stageNo: number; position: number; enabled: boolean }>;
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
    case 'awaiting_user': return { label: 'Waiting for you', cls: 'bg-amber-500/15 text-amber-500 border-amber-500/30' };
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

export function useJobPauses(jobId: string) {
  const [pauses, setPauses] = useState<JobPause[]>([]);
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    if (!jobId) return;
    try {
      const data = await fetch(`/api/automation/jobs/${encodeURIComponent(jobId)}/pauses`).then((response) => response.json());
      setPauses(Array.isArray(data?.pauses) ? data.pauses : []);
    } catch { /* keep previous */ } finally { setLoading(false); }
  }, [jobId]);
  useEffect(() => { setPauses([]); setLoading(true); void refresh(); }, [refresh]);
  useAgentEvents((event) => {
    if (event.scopeType === 'job' && event.scopeId === jobId && (event.type === 'job.paused' || event.type === 'job.resumed')) void refresh();
  });
  return { pauses, loading, refresh };
}

// One EventSource for the whole app, refcounted across every useAgentEvents() call. Each SSE
// connection permanently occupies one of Chrome's 6 concurrent connections per origin — several
// components (run workspace, artifacts panel, pause prompt) each opening their own starved every
// other fetch on the page (job status, pauses, artifacts) fighting over the few connections left.
let sharedEventSource: EventSource | null = null;
const sharedEventListeners = new Set<(evt: AutomationEvent) => void>();

function ensureSharedEventSource(): void {
  if (sharedEventSource) return;
  const es = new EventSource(withEventSourceAuth('/api/automation/events'));
  es.onmessage = (e) => {
    let parsed: AutomationEvent;
    try { parsed = JSON.parse(e.data); } catch { return; }
    for (const listener of sharedEventListeners) listener(parsed);
  };
  sharedEventSource = es;
}

/**
 * Subscribe to the live automation event stream (SSE), sharing one connection across every caller.
 */
export function useAgentEvents(onEvent: (evt: AutomationEvent) => void): void {
  const handler = useRef(onEvent);
  handler.current = onEvent;
  useEffect(() => {
    const listener = (evt: AutomationEvent) => handler.current(evt);
    ensureSharedEventSource();
    sharedEventListeners.add(listener);
    return () => {
      sharedEventListeners.delete(listener);
      if (sharedEventListeners.size === 0 && sharedEventSource) {
        sharedEventSource.close();
        sharedEventSource = null;
      }
    };
  }, []);
}

export interface RecordingCaseMeta {
  testingType?: string; testingTypes?: string[]; priority?: string; folderId?: string;
  testPlanIds?: string[]; testSuiteIds?: string[];
  description?: string; preconditions?: string; defectIds?: string[];
}
export interface StartRecordingInput {
  name: string; appUrl: string; browser: string; environment: string; agentId: string; caseMeta?: RecordingCaseMeta;
  browserPermissions?: BrowserPermissionSettings;
}
export type RecordingPhase = 'setup' | 'recording' | 'finalizing' | 'summary';

/**
 * The record-a-flow state machine (setup → recording → summary), shared by the standalone Record
 * Test page and the New Case → Automation panel. Owns the codegen lifecycle calls, the live SSE
 * stream (script/stats/done), the elapsed timer, and the Stop safety-net fallback. UI concerns
 * (toasts, confirm dialogs) stay with the caller; start() resolves the new recording id or throws.
 */
export function useRecordingSession(opts?: { onAgentEvent?: () => void }): {
  phase: RecordingPhase; recordingId: string; script: string; stats: Record<string, number>;
  elapsed: number; mmss: string; busy: boolean; caseId: string; empty: boolean; videoJobId: string; renamedTitle: string;
  paused: boolean;
  start: (input: StartRecordingInput) => Promise<string>; stop: () => Promise<void>;
  setPaused: (paused: boolean) => Promise<void>;
  discard: () => Promise<void>; reset: () => void;
} {
  const [phase, setPhase] = useState<RecordingPhase>('setup');
  const [recordingId, setRecordingId] = useState('');
  const [script, setScript] = useState('');
  const [stats, setStats] = useState<Record<string, number>>({});
  const [elapsed, setElapsed] = useState(0);
  const [busy, setBusy] = useState(false);
  const [caseId, setCaseId] = useState('');
  // The agent records video alongside the live codegen session and uploads it to this job as its
  // own artifact — no replay is needed to show a preview once recording finishes.
  const [videoJobId, setVideoJobId] = useState('');
  // Set when a title collision forced the case to save as "<title> (n)" — surfaced so the caller can
  // warn the user instead of it changing silently (see recordingService.ts availableTitle).
  const [renamedTitle, setRenamedTitle] = useState('');
  // True when the finished recording captured no interactions, so no test case was created.
  const [empty, setEmpty] = useState(false);
  // Mirrors the agent's recorder mode — the elapsed clock and step capture both stop while paused.
  const [paused, setPausedState] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const stopTimer = () => { if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; } };
  const runTimer = () => { timerRef.current = setInterval(() => setElapsed((e) => e + 1), 1000); };
  const startTimer = () => { setElapsed(0); runTimer(); };
  useEffect(() => () => { stopTimer(); }, []);

  useAgentEvents((evt) => {
    if (evt.scopeType === 'agent') { opts?.onAgentEvent?.(); return; }
    if (evt.scopeId !== recordingId) return;
    if (evt.type === 'recording.chunk' && typeof evt.data.script === 'string') setScript(evt.data.script);
    if (evt.type === 'recording.status') {
      if (evt.data.stats) setStats((s) => ({ ...s, ...evt.data.stats }));
      if (typeof evt.data.paused === 'boolean') setPausedState(evt.data.paused);
    }
    if (evt.type === 'recording.done') {
      const rec = evt.data.recording as Recording | undefined;
      if (rec) { setScript(rec.script || ''); setStats(rec.stats || {}); }
      if (typeof evt.data.caseId === 'string') setCaseId(evt.data.caseId);
      setEmpty(evt.data.empty === true);
      setRenamedTitle(typeof evt.data.renamedTitle === 'string' ? evt.data.renamedTitle : '');
      stopTimer();
      setPhase('summary');
    }
  });

  useEffect(() => {
    if (phase !== 'finalizing' || !recordingId) return;
    const check = async () => {
      try {
        const response = await fetch(`/api/automation/recordings/${encodeURIComponent(recordingId)}`);
        const recording = (await response.json().catch(() => ({}))).recording as Recording | undefined;
        if (recording?.status !== 'ready') return;
        setScript(recording.script || '');
        setStats(recording.stats || {});
        setCaseId(String(recording.metadata.caseId || ''));
        setRenamedTitle(String(recording.metadata.renamedTitle || ''));
        setPhase('summary');
      } catch { /* SSE can still complete the session. */ }
    };
    void check();
    const poll = setInterval(() => { void check(); }, 1000);
    return () => clearInterval(poll);
  }, [phase, recordingId]);

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
      const startedBody = await started.json().catch(() => ({}));
      if (!started.ok) throw new Error(startedBody?.error || 'start failed');
      setRecordingId(id); setScript(''); setStats({}); setCaseId(''); setEmpty(false); setRenamedTitle(''); setPausedState(false); setVideoJobId(String(startedBody?.videoJobId || '')); setPhase('recording'); startTimer();
      return id;
    } finally { setBusy(false); }
  };

  const stop = async (): Promise<void> => {
    if (!recordingId || busy) return;
    setBusy(true);
    // Stop the clock immediately — don't keep counting while we wait on the agent's round-trip.
    stopTimer();
    setPhase('finalizing');
    try { await fetch(`/api/automation/recordings/${recordingId}/stop`, { method: 'POST' }); }
    catch { /* ignore */ } finally { setBusy(false); }
  };

  const setPaused = async (next: boolean): Promise<void> => {
    if (!recordingId || busy || next === paused) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/automation/recordings/${recordingId}/pause`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paused: next }),
      });
      if (!response.ok) throw new Error((await response.json().catch(() => ({})))?.error || 'Could not pause the recording.');
      setPausedState(next);
      if (next) stopTimer(); else { stopTimer(); runTimer(); }
    } finally { setBusy(false); }
  };

  const discard = async (): Promise<void> => {
    stopTimer();
    if (recordingId) await fetch(`/api/automation/recordings/${recordingId}`, { method: 'DELETE' }).catch(() => {});
    setRecordingId(''); setScript(''); setStats({}); setCaseId(''); setVideoJobId(''); setRenamedTitle(''); setPausedState(false); setPhase('setup');
  };

  const reset = () => { setPhase('setup'); setRecordingId(''); setScript(''); setStats({}); setCaseId(''); setEmpty(false); setVideoJobId(''); setRenamedTitle(''); setPausedState(false); };

  const mmss = `${String(Math.floor(elapsed / 60)).padStart(2, '0')}:${String(elapsed % 60).padStart(2, '0')}`;
  return { phase, recordingId, script, stats, elapsed, mmss, busy, caseId, empty, videoJobId, renamedTitle, paused, start, stop, setPaused, discard, reset };
}
