import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Wrench } from 'lucide-react';
import { analyzeFailure } from '../lib/failureAnalysis';

/** Developer-actionable failure breakdown for one failed test — replaces the raw Playwright dump. */
export default function FailureCard({ error }: { error: string }) {
  const a = useMemo(() => analyzeFailure(error), [error]);
  const [showRaw, setShowRaw] = useState(false);

  return (
    <div className="mt-1 rounded-md border border-red-500/20 bg-red-500/5 p-2 text-[11px]">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="rounded border border-red-500/30 bg-red-500/10 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-red-400">{a.label}</span>
        <span className="text-[var(--text-secondary)]">Tried to {a.attempted}</span>
      </div>

      <div className="mt-1.5 grid grid-cols-1 gap-1.5 md:grid-cols-2">
        <div className="rounded border border-emerald-500/20 bg-emerald-500/5 p-1.5">
          <div className="mb-0.5 text-[9px] font-bold uppercase tracking-wider text-emerald-400">Expected</div>
          <div className="text-[var(--text-primary)]">{a.expected}</div>
        </div>
        <div className="rounded border border-red-500/20 bg-red-500/5 p-1.5">
          <div className="mb-0.5 text-[9px] font-bold uppercase tracking-wider text-red-400">Actual</div>
          <div className="text-[var(--text-primary)]">{a.actual}</div>
        </div>
      </div>

      <div className="mt-1.5">
        <span className="font-semibold text-[var(--text-secondary)]">Likely cause: </span>
        <span className="text-[var(--text-primary)]">{a.likelyCause}</span>
      </div>

      {a.suggestedFixes.length > 0 && (
        <div className="mt-1.5 rounded border border-[var(--border)] bg-[var(--bg-secondary)] p-1.5">
          <div className="mb-0.5 flex items-center gap-1 text-[10px] font-semibold text-[var(--text-secondary)]"><Wrench className="h-3 w-3" /> How to fix</div>
          <ul className="list-disc space-y-0.5 pl-4 text-[var(--text-primary)]">
            {a.suggestedFixes.map((f, i) => <li key={i}>{f}</li>)}
          </ul>
        </div>
      )}

      {a.resolvedElement && (
        <div className="mt-1.5 overflow-x-auto">
          <span className="text-[10px] font-semibold text-[var(--text-muted)]">Resolved element: </span>
          <code className="font-mono text-[10px] text-[var(--text-secondary)]">{a.resolvedElement.slice(0, 200)}</code>
        </div>
      )}

      <button
        type="button"
        onClick={() => setShowRaw((v) => !v)}
        className="mt-1.5 inline-flex items-center gap-0.5 text-[10px] text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
      >
        {showRaw ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        Raw error
      </button>
      {showRaw && (
        <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-slate-950 p-2 font-mono text-[10px] text-slate-300">{error}</pre>
      )}
    </div>
  );
}
