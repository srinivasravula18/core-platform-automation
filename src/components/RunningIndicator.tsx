import { useEffect, useRef, useState, useCallback } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { agentActivityCount, subscribeAgentActivity } from '../lib/agentActivity';

/** Top-bar spinner shown while an agent is working: a durable deep run (agent-runs) OR the pre-run
 * routing/understanding phase (agentActivity, no run record yet). Persists across pages/tabs; click → console. */
export default function RunningIndicator() {
  const navigate = useNavigate();
  const location = useLocation();
  const [runCount, setRunCount] = useState(0);
  const [activityCount, setActivityCount] = useState(0);
  const timer = useRef<number | null>(null);
  const aliveRef = useRef(true);

  const poll = useCallback(async () => {
    setActivityCount(agentActivityCount()); // pre-run head (cheap, local) — reflects even before a run exists
    try {
      const r = await fetch('/api/agent-runs', { headers: { 'Cache-Control': 'no-store' } });
      if (!r.ok || !aliveRef.current) return;
      const runs = await r.json();
      // Only genuinely active runs count — the endpoint heals orphaned/dead runs to a terminal status on read.
      const running = Array.isArray(runs) ? runs.filter((x: any) => x?.status === 'running').length : 0;
      if (aliveRef.current) setRunCount(running);
    } catch { /* best-effort */ }
  }, []);

  // Fresh read on every navigation so the chip reflects reality when you move between pages.
  useEffect(() => { void poll(); }, [location.pathname, poll]);

  // React instantly to pre-run activity changes (same tab via the listener set, cross-tab via `storage`).
  useEffect(() => subscribeAgentActivity(() => setActivityCount(agentActivityCount())), []);

  useEffect(() => {
    aliveRef.current = true;
    setActivityCount(agentActivityCount());
    timer.current = window.setInterval(poll, 8000);
    const onFocus = () => void poll();
    window.addEventListener('focus', onFocus);
    return () => {
      aliveRef.current = false;
      if (timer.current) window.clearInterval(timer.current);
      window.removeEventListener('focus', onFocus);
    };
  }, [poll]);

  // Pre-run activity clears (busy→false) before its deep run's agent-runs record appears, so the two do not
  // double-count in practice; summing correctly reflects distinct conversations working at once.
  const count = runCount + activityCount;
  if (count <= 0) return null;
  return (
    <button
      onClick={() => navigate('/')}
      title={`${count} agent run${count === 1 ? '' : 's'} in progress — click to open the Agent Console`}
      className="flex items-center gap-1.5 rounded-md border border-[var(--accent)]/40 bg-[var(--accent)]/10 px-2.5 py-1.5 text-xs font-medium text-[var(--accent)] hover:bg-[var(--accent)]/20 transition-colors"
    >
      <Loader2 className="w-3.5 h-3.5 animate-spin" />
      <span className="hidden sm:inline">{count} running</span>
    </button>
  );
}
