import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2 } from 'lucide-react';

/** Global top-bar indicator: shows a spinner on ANY page while an agent run is executing in the background,
 * so a run started in the Agent Console stays visible after navigating away. Clicking returns to the console. */
export default function RunningIndicator() {
  const navigate = useNavigate();
  const [count, setCount] = useState(0);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const r = await fetch('/api/agent-runs', { headers: { 'Cache-Control': 'no-store' } });
        if (!r.ok || !alive) return;
        const runs = await r.json();
        const running = Array.isArray(runs) ? runs.filter((x: any) => x?.status === 'running').length : 0;
        if (alive) setCount(running);
      } catch { /* best-effort */ }
    };
    poll();
    timer.current = window.setInterval(poll, 8000);
    const onFocus = () => poll();
    window.addEventListener('focus', onFocus);
    return () => {
      alive = false;
      if (timer.current) window.clearInterval(timer.current);
      window.removeEventListener('focus', onFocus);
    };
  }, []);

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
