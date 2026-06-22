import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { cn } from '@/src/lib/utils';
import {
  Target,
  ShieldCheck,
  AlertTriangle,
  FlaskConical,
  Sparkles,
  ChevronDown,
  ArrowRight,
  FileCode2,
  Database,
  Settings2,
  Users,
  ScrollText,
  TestTube2,
} from 'lucide-react';

/**
 * RequirementDiscoveryResult — renders the Feature Analyst's requirement-based
 * testing result inside the Agent Console: the grounded understanding of the
 * feature (from the target app's source), the EXISTING cases that already cover
 * it, and the NEW cases proposed to close the gaps. Editing/rework happens on the
 * Requirements and Traceability pages.
 */

const COVERAGE_BADGE: Record<string, { label: string; cls: string }> = {
  covered: { label: 'Covered', cls: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400' },
  partial: { label: 'Partial coverage', cls: 'border-amber-500/30 bg-amber-500/10 text-amber-400' },
  'gaps-proposed': { label: 'Gaps — new cases proposed', cls: 'border-sky-500/30 bg-sky-500/10 text-sky-400' },
  none: { label: 'No coverage yet', cls: 'border-rose-500/30 bg-rose-500/10 text-rose-400' },
  unknown: { label: 'Coverage unknown', cls: 'border-slate-500/30 bg-slate-500/10 text-slate-400' },
};

export function RequirementDiscoveryResult({ result, onGenerateTests }: { result: any; onGenerateTests?: (context: string) => void }) {
  const [openCase, setOpenCase] = useState<number | null>(null);
  const navigate = useNavigate();

  const requirement = result?.requirement || {};
  const understanding = result?.understanding || {};
  const coverage = result?.coverage || { sufficient: false, gaps: [], reasoning: '' };
  const existingLinks: any[] = result?.existingLinks || [];
  const generatedCases: any[] = result?.generatedCases || [];
  const businessRules: string[] = understanding?.businessRules || [];
  const metadataRefs: any[] = understanding?.metadataRefs || [];
  const sourceFiles: any[] = understanding?.sourceFiles || [];
  const scenarios: any[] = understanding?.candidateScenarios || [];
  const badge = COVERAGE_BADGE[requirement?.coverageStatus || 'unknown'] || COVERAGE_BADGE.unknown;

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Target className="h-4 w-4 text-[var(--accent)]" />
        <span className="text-sm font-semibold text-[var(--text-primary)]">{requirement?.title || 'Requirement'}</span>
        <span className={cn('rounded-md border px-1.5 py-0.5 text-[10px] font-semibold uppercase', badge.cls)}>{badge.label}</span>
        {result?.repoPath && (
          <span className="rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--text-muted)]">
            {result.repoPath}
          </span>
        )}
      </div>

      {understanding?.description && <p className="mb-3 text-xs text-[var(--text-muted)]">{understanding.description}</p>}

      {/* Business rules */}
      {businessRules.length > 0 && (
        <div className="mb-3">
          <div className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
            <ScrollText className="h-3.5 w-3.5" /> Business rules
          </div>
          <ul className="list-disc space-y-0.5 pl-5 text-[11px] text-[var(--text-primary)]">
            {businessRules.map((r, i) => <li key={i}>{r}</li>)}
          </ul>
        </div>
      )}

      {/* Admin vs Keystone vs data population */}
      <div className="mb-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
        {understanding?.adminBehavior && (
          <div className="rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] p-2">
            <div className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]"><Settings2 className="h-3.5 w-3.5" /> Admin</div>
            <p className="text-[11px] text-[var(--text-primary)]">{understanding.adminBehavior}</p>
          </div>
        )}
        {understanding?.keystoneBehavior && (
          <div className="rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] p-2">
            <div className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]"><Users className="h-3.5 w-3.5" /> Keystone</div>
            <p className="text-[11px] text-[var(--text-primary)]">{understanding.keystoneBehavior}</p>
          </div>
        )}
        {understanding?.dataPopulationNotes && (
          <div className="rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] p-2">
            <div className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]"><Database className="h-3.5 w-3.5" /> Data population</div>
            <p className="text-[11px] text-[var(--text-primary)]">{understanding.dataPopulationNotes}</p>
          </div>
        )}
      </div>

      {/* Metadata source of truth */}
      {metadataRefs.length > 0 && (
        <div className="mb-3">
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">Source of truth (metadata)</div>
          <div className="flex flex-wrap gap-1.5">
            {metadataRefs.map((m, i) => (
              <span key={i} className="rounded border border-[var(--border)] bg-[var(--bg-secondary)] px-1.5 py-0.5 text-[10px] text-[var(--text-primary)]" title={m.note}>
                {m.object}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Cited source files (code <-> requirement trace) */}
      {sourceFiles.length > 0 && (
        <div className="mb-3">
          <div className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]"><FileCode2 className="h-3.5 w-3.5" /> Source files</div>
          <div className="space-y-0.5">
            {sourceFiles.map((f, i) => (
              <div key={i} className="flex items-start gap-1.5 text-[11px]">
                <span className="shrink-0 font-mono text-[var(--accent)]">{f.path}</span>
                {f.why && <span className="text-[var(--text-muted)]">— {f.why}</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Coverage verdict */}
      <div className={cn('rounded-md border p-2.5', coverage.sufficient ? 'border-emerald-500/20 bg-emerald-500/5' : 'border-amber-500/20 bg-amber-500/5')}>
        <div className="flex items-center gap-2">
          {coverage.sufficient ? <ShieldCheck className="h-4 w-4 text-emerald-400" /> : <AlertTriangle className="h-4 w-4 text-amber-400" />}
          <span className="text-xs font-semibold text-[var(--text-primary)]">
            {coverage.sufficient ? 'Existing tests already cover this requirement' : 'New tests are needed to cover this requirement'}
          </span>
        </div>
        {coverage.reasoning && <p className="mt-1 pl-6 text-[11px] text-[var(--text-muted)]">{coverage.reasoning}</p>}

        {existingLinks.length > 0 && (
          <div className="mt-2 pl-6">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">Already covered by</div>
            <div className="mt-1 space-y-1">
              {existingLinks.map((cb, i) => (
                <div key={i} className="flex items-start gap-1.5 text-[11px]">
                  <FlaskConical className="mt-0.5 h-3 w-3 shrink-0 text-emerald-400" />
                  <span className="font-mono text-[10px] text-[var(--text-muted)]">{cb.caseId}</span>
                  <span className="text-[var(--text-primary)]">{cb.title}</span>
                  {cb.reason && <span className="text-[var(--text-muted)]">— {cb.reason}</span>}
                </div>
              ))}
            </div>
          </div>
        )}

        {coverage.gaps?.length > 0 && (
          <div className="mt-2 pl-6">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">Gaps</div>
            <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[11px] text-[var(--text-muted)]">
              {coverage.gaps.map((g: string, i: number) => <li key={i}>{g}</li>)}
            </ul>
          </div>
        )}
      </div>

      {/* Generated (gap) cases — pending review */}
      {generatedCases.length > 0 && (
        <div className="mt-3">
          <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
            <Sparkles className="h-3.5 w-3.5" /> New cases proposed to close the gaps — pending your review
          </div>
          <div className="space-y-1.5">
            {generatedCases.map((c, i) => {
              const scenario = scenarios.find((s) => s.title === c.title);
              return (
                <div key={c.id} className="rounded-md border border-[var(--border)] bg-[var(--bg-secondary)]">
                  <button onClick={() => setOpenCase(openCase === i ? null : i)} className="flex w-full items-center gap-2 px-2.5 py-2 text-left">
                    <FlaskConical className="h-3.5 w-3.5 shrink-0 text-sky-400" />
                    <span className="font-mono text-[10px] text-[var(--text-muted)]">{c.id}</span>
                    <span className="min-w-0 flex-1 truncate text-xs font-medium text-[var(--text-primary)]">{c.title}</span>
                    {scenario?.steps?.length ? <span className="text-[10px] text-[var(--text-muted)]">{scenario.steps.length} steps</span> : null}
                    <ChevronDown className={cn('h-3.5 w-3.5 text-[var(--text-muted)] transition-transform', openCase === i && 'rotate-180')} />
                  </button>
                  {openCase === i && scenario && (
                    <div className="border-t border-[var(--border)] p-2">
                      {scenario.rationale && <p className="mb-1.5 text-[11px] text-[var(--text-muted)]">{scenario.rationale}</p>}
                      <div className="space-y-1">
                        {(scenario.steps || []).map((s: any, si: number) => (
                          <div key={si} className="grid grid-cols-2 gap-2 rounded bg-[var(--bg-card)] p-1.5 text-[11px]">
                            <span className="text-[var(--text-primary)]">{si + 1}. {s.action}</span>
                            <span className="text-[var(--text-muted)]">{s.expected}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="mt-3 flex flex-wrap gap-2 border-t border-[var(--border)] pt-3">
        <button
          onClick={() => navigate(`/traceability?req=${encodeURIComponent(requirement.id || '')}`)}
          className="inline-flex items-center gap-1.5 rounded-md bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-white hover:bg-[var(--accent-hover)]"
        >
          <Target className="h-3.5 w-3.5" /> Open in Traceability <ArrowRight className="h-3 w-3" />
        </button>
        <button
          onClick={() => navigate('/requirements')}
          className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-1.5 text-xs font-medium text-[var(--text-primary)] hover:border-[var(--accent)]"
        >
          <ScrollText className="h-3.5 w-3.5 text-[var(--accent)]" /> Open Requirements
        </button>
        {onGenerateTests && (
          <button
            onClick={() => {
              const lines: string[] = [`Requirement: ${requirement.title || 'Untitled'}`];
              if (understanding.description) lines.push(`Description: ${understanding.description}`);
              if ((understanding.businessRules || []).length) {
                lines.push('Business rules:');
                (understanding.businessRules as string[]).forEach((r) => lines.push(`  - ${r}`));
              }
              if (understanding.adminBehavior) lines.push(`Admin surface: ${understanding.adminBehavior}`);
              if (understanding.keystoneBehavior) lines.push(`End-user surface: ${understanding.keystoneBehavior}`);
              if ((understanding.metadataRefs || []).length) {
                lines.push('Metadata objects: ' + (understanding.metadataRefs as any[]).map((m) => m.name || m).join(', '));
              }
              if (sourceFiles.length) {
                lines.push('Key source files: ' + sourceFiles.slice(0, 6).map((f: any) => f.path || f).join(', '));
              }
              if (scenarios.length) {
                lines.push(`Candidate scenarios (${scenarios.length}):`);
                scenarios.forEach((s: any) => lines.push(`  - ${s.title}`));
              }
              onGenerateTests(lines.join('\n'));
            }}
            className="inline-flex items-center gap-1.5 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-1.5 text-xs font-medium text-emerald-400 hover:bg-emerald-500/20"
          >
            <TestTube2 className="h-3.5 w-3.5" /> Generate Tests
          </button>
        )}
      </div>
    </div>
  );
}
