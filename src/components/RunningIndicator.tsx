import { useEffect, useRef, useState, useCallback } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Loader2, X, Square, ExternalLink } from 'lucide-react';
import { clearAgentActive, freshActivities, subscribeAgentActivity, type AgentActivity } from '../lib/agentActivity';

interface RunningRun { id: string; prompt: string; conversationId: string | null; }

/** Top-bar spinner shown while an agent is working. Clicking it opens a popover listing every in-flight
 * process — durable deep runs (real Terminate, kills the background work) and pre-run routing/understanding
 * (Dismiss). Persists across pages/tabs. */
export default function RunningIndicator() {
  const navigate = useNavigate();
  const location = useLocation();
  const [runs, setRuns] = useState<RunningRun[]>([]);
  const [activities, setActivities] = useState<AgentActivity[]>(freshActivities());
  const [open, setOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const timer = useRef<number | null>(null);
  const aliveRef = useRef(true);
  const boxRef = useRef<HTMLDivElement | null>(null);

  const poll = useCallback(async () => {
    setActivities(freshActivities());
    try {
      const r = await fetch('/api/agent-runs', { headers: { 'Cache-Control': 'no-store' } });
      if (!r.ok || !aliveRef.current) return;
      const data = await r.json();
      // Only genuinely active runs count — the endpoint heals orphaned/dead runs to a terminal status on read.
      const running = (Array.isArray(data) ? data : [])
        .filter((x: any) => x?.status === 'running')
        .map((x: any) => ({ id: String(x.id), prompt: String(x.prompt || ''), conversationId: x.conversationId ?? null }));
      if (aliveRef.current) setRuns(running);
    } catch { /* best-effort */ }
  }, []);

  useEffect(() => { void poll(); }, [location.pathname, poll]);
  useEffect(() => subscribeAgentActivity(() => setActivities(freshActivities())), []);

  useEffect(() => {
    aliveRef.current = true;
    void poll();
    timer.current = window.setInterval(poll, 8000);
    const onFocus = () => void poll();
    window.addEventListener('focus', onFocus);
    return () => {
      aliveRef.current = false;
      if (timer.current) window.clearInterval(timer.current);
      window.removeEventListener('focus', onFocus);
    };
  }, [poll]);

  // Close the popover on outside click.
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => { if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  // A durable run's conversation may still carry a stale pre-run marker — show it once (as the run), never twice.
  const runConvIds = new Set(runs.map((r) => r.conversationId).filter(Boolean));
  const preRuns = activities.filter((a) => !runConvIds.has(a.conversationId));
  const count = runs.length + preRuns.length;

  const openConversation = (conversationId: string | null) => {
    setOpen(false);
    navigate(conversationId ? `/chat/${conversationId}` : '/');
  };

  // Real kill: cancels the run + terminates its in-flight Playwright process server-side.
  const terminate = useCallback(async (id: string) => {
    setBusyId(id);
    try {
      await fetch('/api/agent/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ taskId: id }) });
      setRuns((prev) => prev.filter((r) => r.id !== id));
    } catch { /* best-effort */ } finally {
      setBusyId(null);
      void poll();
    }
  }, [poll]);

  // Pre-run work isn't a killable server process yet — clearing its marker stops it counting (and the owning
  // console aborts on its own / via the marker's TTL).
  const dismiss = useCallback((conversationId: string) => {
    clearAgentActive(conversationId);
    setActivities(freshActivities());
  }, []);

  if (count <= 0) return null;

  return (
    <div ref={boxRef} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        title={`${count} agent run${count === 1 ? '' : 's'} in progress — click to view and manage`}
        className="flex items-center gap-1.5 rounded-md border border-[var(--accent)]/40 bg-[var(--accent)]/10 px-2.5 py-1.5 text-xs font-medium text-[var(--accent)] hover:bg-[var(--accent)]/20 transition-colors"
      >
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
        <span className="hidden sm:inline">{count} running</span>
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-2 w-[min(24rem,calc(100vw-2rem))] rounded-xl border border-[var(--border)] bg-[var(--bg-card)] shadow-2xl z-50 overflow-hidden">
          <div className="flex items-center justify-between border-b border-[var(--border)] px-3 py-2.5">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">Running Now ({count})</span>
            <button onClick={() => setOpen(false)} className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-secondary)]"><X className="w-3.5 h-3.5" /></button>
          </div>

          <div className="max-h-[min(22rem,60dvh)] overflow-y-auto py-1">
            {runs.map((run) => (
              <div key={run.id} className="flex items-start gap-2 px-3 py-2 hover:bg-[var(--bg-secondary)]">
                <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-[var(--accent)]" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm text-[var(--text-primary)]" title={run.prompt}>{run.prompt || 'Agent run'}</div>
                  <div className="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">Deep Run</div>
                </div>
                <button onClick={() => openConversation(run.conversationId)} title="Open this run" className="shrink-0 rounded p-1 text-[var(--text-muted)] hover:text-[var(--accent)] hover:bg-[var(--bg-card)]"><ExternalLink className="w-3.5 h-3.5" /></button>
                <button
                  onClick={() => void terminate(run.id)}
                  disabled={busyId === run.id}
                  title="Terminate this run (stops the background process)"
                  className="inline-flex shrink-0 items-center gap-1 rounded-md border border-red-500/40 px-2 py-1 text-[11px] font-medium text-red-400 hover:bg-red-500/10 disabled:opacity-50"
                >
                  {busyId === run.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Square className="w-3 h-3" />} Terminate
                </button>
              </div>
            ))}

            {preRuns.map((a) => (
              <div key={a.conversationId} className="flex items-start gap-2 px-3 py-2 hover:bg-[var(--bg-secondary)]">
                <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-[var(--text-muted)]" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm text-[var(--text-primary)]" title={a.label}>{a.label || 'Working…'}</div>
                  <div className="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">Preparing</div>
                </div>
                <button onClick={() => openConversation(a.conversationId)} title="Open this chat" className="shrink-0 rounded p-1 text-[var(--text-muted)] hover:text-[var(--accent)] hover:bg-[var(--bg-card)]"><ExternalLink className="w-3.5 h-3.5" /></button>
                <button
                  onClick={() => dismiss(a.conversationId)}
                  title="Dismiss (this pre-run phase is not a killable process yet)"
                  className="inline-flex shrink-0 items-center gap-1 rounded-md border border-[var(--border)] px-2 py-1 text-[11px] font-medium text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-card)]"
                >
                  <X className="w-3 h-3" /> Dismiss
                </button>
              </div>
            ))}
          </div>

          <button onClick={() => { setOpen(false); navigate('/'); }} className="w-full border-t border-[var(--border)] px-3 py-2 text-left text-xs font-medium text-[var(--accent)] hover:bg-[var(--bg-secondary)]">
            Open Agent Console
          </button>
        </div>
      )}
    </div>
  );
}
