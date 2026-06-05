import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { cn } from '@/src/lib/utils';
import {
  GitBranch,
  ShieldCheck,
  AlertTriangle,
  FlaskConical,
  Code2,
  ChevronDown,
  CheckCircle2,
  Loader2,
  ArrowRight,
  FileDiff,
} from 'lucide-react';

/**
 * CodeChangeReview — renders the AI analysis of recent code changes inside the
 * Agent Console. It first shows whether EXISTING cases/scripts already cover the
 * changes; only if they don't does it offer to create the proposed gap tests.
 */

const TYPE_STYLES: Record<string, string> = {
  ui: 'border-sky-500/20 bg-sky-500/10 text-sky-400',
  functional: 'border-purple-500/20 bg-purple-500/10 text-purple-400',
  'business-logic': 'border-amber-500/20 bg-amber-500/10 text-amber-400',
  api: 'border-teal-500/20 bg-teal-500/10 text-teal-400',
  'db-schema': 'border-rose-500/20 bg-rose-500/10 text-rose-400',
  config: 'border-slate-500/20 bg-slate-500/10 text-slate-400',
  other: 'border-slate-500/20 bg-slate-500/10 text-slate-400',
};

export function CodeChangeReview({ analysis }: { analysis: any }) {
  const [applying, setApplying] = useState(false);
  const [applied, setApplied] = useState<{ createdCases: any[]; createdScripts: any[] } | null>(null);
  const [openCase, setOpenCase] = useState<number | null>(null);
  const navigate = useNavigate();

  const changes: any[] = analysis?.changes || [];
  const coverage = analysis?.coverage || { sufficient: true, coveredBy: [], gaps: [], reasoning: '' };
  const proposedCases: any[] = analysis?.proposedCases || [];
  const proposedScripts: any[] = analysis?.proposedScripts || [];
  const hasProposals = proposedCases.length > 0 || proposedScripts.length > 0;

  const apply = async () => {
    setApplying(true);
    try {
      const res = await fetch('/api/git-agent/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ proposedCases, proposedScripts, workspaceId: 'default' }),
      });
      const data = await res.json();
      setApplied({ createdCases: data.createdCases || [], createdScripts: data.createdScripts || [] });
    } finally {
      setApplying(false);
    }
  };

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-3">
      <div className="mb-2 flex items-center gap-2">
        <GitBranch className="h-4 w-4 text-[var(--accent)]" />
        <span className="text-sm font-semibold text-[var(--text-primary)]">Code change analysis</span>
        {analysis?.branch && (
          <span className="rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-1.5 py-0.5 text-[10px] text-[var(--text-muted)]">
            {analysis.branch} · {String(analysis.baseRef || '').slice(0, 10)}
          </span>
        )}
      </div>

      {analysis?.summary && <p className="mb-3 text-xs text-[var(--text-muted)]">{analysis.summary}</p>}

      {/* Classified changes */}
      {changes.length > 0 && (
        <div className="mb-3 space-y-1.5">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">What changed</div>
          {changes.map((c, i) => (
            <div key={i} className="rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] p-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className={cn('rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase', TYPE_STYLES[c.changeType] || TYPE_STYLES.other)}>
                  {String(c.changeType || 'other').replace('-', ' ')}
                </span>
                {c.apiChange && c.apiChange !== 'none' && (
                  <span className="rounded border border-teal-500/20 bg-teal-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-teal-400">
                    API {c.apiChange}
                  </span>
                )}
                {c.dbChange && (
                  <span className="rounded border border-rose-500/20 bg-rose-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-rose-400">
                    DB change
                  </span>
                )}
                <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--text-primary)]">{c.file}</span>
              </div>
              {c.whatChanged && <div className="mt-1 text-[11px] text-[var(--text-muted)]">{c.whatChanged}</div>}
              {c.testFocus && <div className="mt-0.5 text-[11px] text-[var(--text-primary)]"><span className="text-[var(--text-muted)]">Test focus:</span> {c.testFocus}</div>}
            </div>
          ))}
        </div>
      )}

      {/* Coverage verdict */}
      <div
        className={cn(
          'rounded-md border p-2.5',
          coverage.sufficient ? 'border-emerald-500/20 bg-emerald-500/5' : 'border-amber-500/20 bg-amber-500/5',
        )}
      >
        <div className="flex items-center gap-2">
          {coverage.sufficient ? (
            <ShieldCheck className="h-4 w-4 text-emerald-400" />
          ) : (
            <AlertTriangle className="h-4 w-4 text-amber-400" />
          )}
          <span className="text-xs font-semibold text-[var(--text-primary)]">
            {coverage.sufficient
              ? 'Your existing tests already cover these changes'
              : 'Existing tests are not enough to cover these changes'}
          </span>
        </div>
        {coverage.reasoning && <p className="mt-1 pl-6 text-[11px] text-[var(--text-muted)]">{coverage.reasoning}</p>}

        {coverage.coveredBy?.length > 0 && (
          <div className="mt-2 pl-6">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">Already covered by</div>
            <div className="mt-1 space-y-1">
              {coverage.coveredBy.map((cb: any, i: number) => (
                <div key={i} className="flex items-start gap-1.5 text-[11px]">
                  {cb.kind === 'script' ? <Code2 className="mt-0.5 h-3 w-3 shrink-0 text-indigo-400" /> : <FlaskConical className="mt-0.5 h-3 w-3 shrink-0 text-emerald-400" />}
                  <span className="text-[var(--text-primary)]">{cb.title}</span>
                  <span className="text-[var(--text-muted)]">— {cb.reason}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {!coverage.sufficient && coverage.gaps?.length > 0 && (
          <div className="mt-2 pl-6">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">Gaps</div>
            <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[11px] text-[var(--text-muted)]">
              {coverage.gaps.map((g: string, i: number) => <li key={i}>{g}</li>)}
            </ul>
          </div>
        )}
      </div>

      {/* Proposed new tests (only when needed) */}
      {!coverage.sufficient && hasProposals && !applied && (
        <div className="mt-3">
          <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
            <FileDiff className="h-3.5 w-3.5" /> I'll create these to cover the gaps
          </div>
          <div className="space-y-1.5">
            {proposedCases.map((c, i) => (
              <div key={i} className="rounded-md border border-[var(--border)] bg-[var(--bg-secondary)]">
                <button onClick={() => setOpenCase(openCase === i ? null : i)} className="flex w-full items-center gap-2 px-2.5 py-2 text-left">
                  <FlaskConical className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
                  <span className="rounded bg-[var(--bg-card)] px-1.5 py-0.5 text-[10px] font-bold uppercase text-[var(--text-muted)]">{c.priority || 'Med'}</span>
                  <span className="min-w-0 flex-1 truncate text-xs font-medium text-[var(--text-primary)]">{c.title}</span>
                  <span className="text-[10px] text-[var(--text-muted)]">{(c.steps || []).length} steps</span>
                  <ChevronDown className={cn('h-3.5 w-3.5 text-[var(--text-muted)] transition-transform', openCase === i && 'rotate-180')} />
                </button>
                {openCase === i && (
                  <div className="border-t border-[var(--border)] p-2">
                    {c.rationale && <p className="mb-1.5 text-[11px] text-[var(--text-muted)]">{c.rationale}</p>}
                    <div className="space-y-1">
                      {(c.steps || []).map((s: any, si: number) => (
                        <div key={si} className="grid grid-cols-2 gap-2 rounded bg-[var(--bg-card)] p-1.5 text-[11px]">
                          <span className="text-[var(--text-primary)]">{si + 1}. {s.action}</span>
                          <span className="text-[var(--text-muted)]">{s.expected}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ))}
            {proposedScripts.map((s, i) => (
              <div key={i} className="flex items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2.5 py-2">
                <Code2 className="h-3.5 w-3.5 shrink-0 text-indigo-400" />
                <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--text-primary)]">{s.filename}</span>
                <span className="text-[10px] text-[var(--text-muted)]">script</span>
              </div>
            ))}
          </div>
          <button
            onClick={apply}
            disabled={applying}
            className="mt-2.5 inline-flex items-center gap-1.5 rounded-md bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-white hover:bg-[var(--accent-hover)] disabled:opacity-50"
          >
            {applying ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
            Create {proposedCases.length} case(s){proposedScripts.length ? ` + ${proposedScripts.length} script(s)` : ''}
          </button>
        </div>
      )}

      {/* Applied result */}
      {applied && (
        <div className="mt-3 rounded-md border border-emerald-500/20 bg-emerald-500/5 p-2.5">
          <div className="flex items-center gap-2 text-xs font-medium text-emerald-400">
            <CheckCircle2 className="h-4 w-4" />
            Created {applied.createdCases.length} case(s){applied.createdScripts.length ? ` + ${applied.createdScripts.length} script(s)` : ''} — sent to your AI Inbox for approval.
          </div>
          <button
            onClick={() => navigate('/cases')}
            className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2.5 py-1 text-[11px] font-medium text-[var(--text-primary)] hover:border-[var(--accent)]"
          >
            <FlaskConical className="h-3.5 w-3.5 text-[var(--accent)]" /> Open Test Cases <ArrowRight className="h-3 w-3 text-[var(--text-muted)]" />
          </button>
        </div>
      )}
    </div>
  );
}
