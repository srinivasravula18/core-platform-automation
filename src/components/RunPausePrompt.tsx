import { useEffect, useState } from 'react';
import { AlertTriangle, Eye, EyeOff, Loader2, Square } from 'lucide-react';
import { showConfirm } from '@/src/lib/dialog';
import { useJobPauses } from '@/src/lib/useAutomation';

export function RunPausePrompt({ jobId }: { jobId: string }) {
  const { pauses, refresh } = useJobPauses(jobId);
  const pause = pauses.find((item) => item.outcome === 'open');
  const [value, setValue] = useState('');
  const [showValue, setShowValue] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => { setValue(''); setShowValue(false); setError(''); }, [pause?.id]);
  useEffect(() => {
    if (!pause) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [pause]);
  if (!pause) return null;

  const remaining = Math.max(0, Date.parse(pause.expiresAt) - now);
  const submit = async (action: 'resume' | 'skip') => {
    setBusy(action); setError('');
    try {
      const response = await fetch(`/api/automation/jobs/${encodeURIComponent(jobId)}/pauses/${encodeURIComponent(pause.pauseId)}/${action}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ attempt: pause.attempt, ...(action === 'resume' && pause.kind === 'input' ? { value } : {}) }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || `Could not ${action} the run.`);
      await refresh();
    } catch (cause: any) { setError(cause.message || 'Could not resume the run.'); }
    finally { setBusy(''); }
  };
  const abort = async () => {
    if (!await showConfirm('Stop this run instead of completing the requested action?', { title: 'Abort Run', confirmText: 'Stop Run', tone: 'danger' })) return;
    setBusy('abort'); setError('');
    try {
      const response = await fetch(`/api/automation/jobs/${encodeURIComponent(jobId)}/cancel`, { method: 'POST' });
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || 'Could not stop the run.');
      await refresh();
    } catch (cause: any) { setError(cause.message || 'Could not stop the run.'); }
    finally { setBusy(''); }
  };

  return (
    <section className="mb-4 rounded-lg border border-amber-500/40 bg-amber-500/10 p-4" role="alert" aria-live="polite">
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-400" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-semibold text-[var(--text-primary)]">Action required</h2>
            <span className="rounded-full border border-amber-500/30 px-2 py-0.5 text-xs font-medium text-amber-400">Waiting for you · {formatRemaining(remaining)}</span>
          </div>
          <p className="mt-1 text-sm text-[var(--text-primary)]">{pause.prompt}</p>
          {pause.hint ? <p className="mt-1 text-xs text-[var(--text-muted)]">{pause.hint}</p> : null}
          {pause.kind === 'input' ? (
            <label className="mt-3 block text-xs font-medium text-[var(--text-muted)]">
              Response
              <span className="mt-1 flex gap-2">
                <input autoFocus type={pause.masked && !showValue ? 'password' : 'text'} value={value} onChange={(event) => setValue(event.target.value)}
                  disabled={!!busy || remaining === 0} className="min-w-0 flex-1 rounded-md border border-[var(--border)] bg-[var(--bg-card)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent)] disabled:opacity-50" />
                {pause.masked ? <button type="button" onClick={() => setShowValue((shown) => !shown)} aria-label={showValue ? 'Hide response' : 'Show response'} className="rounded-md border border-[var(--border)] px-2 text-[var(--text-muted)] hover:text-[var(--text-primary)]">{showValue ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}</button> : null}
              </span>
            </label>
          ) : <p className="mt-3 text-xs text-[var(--text-muted)]">Complete the action in the open browser, then resume.</p>}
          {error ? <p className="mt-2 text-xs text-red-400">{error}</p> : null}
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" disabled={!!busy || remaining === 0 || (pause.kind === 'input' && !value)} onClick={() => void submit('resume')} className="rounded-md bg-[var(--accent)] px-3 py-2 text-sm font-medium text-white disabled:opacity-50">{busy === 'resume' ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Resume'}</button>
            <button type="button" disabled={!!busy || remaining === 0} onClick={() => void submit('skip')} className="rounded-md border border-[var(--border)] px-3 py-2 text-sm text-[var(--text-primary)] disabled:opacity-50">Skip</button>
            <button type="button" disabled={!!busy} onClick={() => void abort()} className="inline-flex items-center gap-1.5 rounded-md border border-red-500/40 px-3 py-2 text-sm text-red-400 disabled:opacity-50"><Square className="h-3 w-3 fill-current" /> Abort</button>
          </div>
        </div>
      </div>
    </section>
  );
}

function formatRemaining(ms: number): string {
  if (ms <= 0) return 'Expired';
  const seconds = Math.ceil(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} remaining`;
}
