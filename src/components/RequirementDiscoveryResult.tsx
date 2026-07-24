import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { cn } from '@/src/lib/utils';
import { formatBusinessRulesMarkdown, formatRequirementSrs, type RequirementSrsModule } from '@/src/lib/requirementSrs';
import { MarkdownText } from '@/src/components/MarkdownText';
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
  ScrollText,
  TestTube2,
  Plug,
  Layers,
  GitBranch,
  Boxes,
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

function selectorRows(selectors: any): Array<{ label: string; values: string[] }> {
  if (!selectors || typeof selectors !== 'object') return [];
  const rows = [
    { label: 'aria-labels', values: selectors.ariaLabels || [] },
    { label: 'labels', values: selectors.labels || [] },
    { label: 'role names', values: (selectors.roleNames || []).map((r: any) => `${r.role}:${r.name}`) },
    { label: 'ui hooks', values: (selectors.uiHooks || []).map((h: any) => [h.surface && `${h.surface}:${h.tag}`, h.id && `#${h.id}`, h.ariaLabel && `aria="${h.ariaLabel}"`, h.placeholder && `placeholder="${h.placeholder}"`, h.role && `role="${h.role}"`, h.type && `type="${h.type}"`].filter(Boolean).join(' ')) },
    { label: 'test ids', values: selectors.testIds || [] },
    { label: 'css ids', values: (selectors.cssIds || []).map((id: string) => `#${id}`) },
    { label: 'css classes', values: (selectors.cssClasses || []).map((cls: string) => `.${cls}`) },
    { label: 'placeholders', values: selectors.placeholders || [] },
    { label: 'field ids', values: (selectors.fieldIds || []).map((f: any) => `${f.label}=>#${f.id}`) },
  ];
  return rows.map((row) => ({ ...row, values: (row.values || []).filter(Boolean).slice(0, 24) })).filter((row) => row.values.length);
}

export function RequirementDiscoveryResult({ result, onGenerateTests }: { result: any; onGenerateTests?: (context: string) => void }) {
  const [openCase, setOpenCase] = useState<number | null>(null);
  const [openApi, setOpenApi] = useState<number | null>(null);
  const [openMeta, setOpenMeta] = useState<number | null>(null);
  const navigate = useNavigate();

  const requirement = result?.requirement || {};
  const understanding = result?.understanding || {};
  const srsModules: RequirementSrsModule[] = Array.isArray(understanding?.srsModules) ? understanding.srsModules : [];
  const coverage = result?.coverage || { sufficient: false, gaps: [], reasoning: '' };
  const existingLinks: any[] = result?.existingLinks || [];
  const generatedCases: any[] = result?.generatedCases || [];
  const businessRules: string[] = understanding?.businessRules || [];
  const metadataRefs: any[] = understanding?.metadataRefs || [];
  const uiSelectorRows = selectorRows(understanding?.uiSelectors || requirement?.uiSelectors);
  const sourceFiles: any[] = understanding?.sourceFiles || [];
  const scenarios: any[] = understanding?.candidateScenarios || [];
  const badge = COVERAGE_BADGE[requirement?.coverageStatus || 'unknown'] || COVERAGE_BADGE.unknown;
  const apiAnalysis: any = result?.apiAnalysis || null;
  const apis: any[] = apiAnalysis?.apis || [];
  const metaObjects: any[] = apiAnalysis?.metadataObjects || [];
  const dataPopulation: any = apiAnalysis?.dataPopulation || null;
  const serviceConnections: any[] = apiAnalysis?.serviceConnections || [];

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

      {srsModules.length > 0 && (
        <div className="mb-3 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-xs leading-relaxed text-[var(--text-primary)]">
          <MarkdownText value={formatRequirementSrs(srsModules)} />
        </div>
      )}

      {srsModules.length === 0 && understanding?.description && <p className="mb-3 text-xs text-[var(--text-muted)]">{understanding.description}</p>}

      {/* Business rules */}
      {srsModules.length === 0 && businessRules.length > 0 && (
        <div className="mb-3 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-xs text-[var(--text-primary)]">
          <MarkdownText value={formatBusinessRulesMarkdown(businessRules)} />
        </div>
      )}

      {/* Data population */}
      <div className="mb-3">
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

      {uiSelectorRows.length > 0 && (
        <div className="mb-3">
          <div className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]"><FileCode2 className="h-3.5 w-3.5" /> Repo UI hooks for testing</div>
          <div className="space-y-1 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] p-2">
            {uiSelectorRows.map((row) => (
              <div key={row.label} className="text-[11px]">
                <span className="mr-1 font-semibold text-[var(--text-muted)]">{row.label}:</span>
                <span className="font-mono text-[var(--text-primary)]">{row.values.join(' | ')}</span>
              </div>
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

      {/* ── API Contracts ──────────────────────────────────────────────────── */}
      {apis.length > 0 && (
        <div className="mt-3">
          <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
            <Plug className="h-3.5 w-3.5" /> API Contracts ({apis.length})
          </div>
          <div className="space-y-1.5">
            {apis.map((api: any, i: number) => (
              <div key={i} className="rounded-md border border-[var(--border)] bg-[var(--bg-secondary)]">
                <button onClick={() => setOpenApi(openApi === i ? null : i)} className="flex w-full items-center gap-2 px-2.5 py-2 text-left">
                  <span className={cn('rounded px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase', {
                    'bg-emerald-500/20 text-emerald-400': api.method === 'GET',
                    'bg-sky-500/20 text-sky-400': api.method === 'POST',
                    'bg-amber-500/20 text-amber-400': api.method === 'PUT' || api.method === 'PATCH',
                    'bg-red-500/20 text-red-400': api.method === 'DELETE',
                    'bg-slate-500/20 text-slate-400': !['GET','POST','PUT','PATCH','DELETE'].includes(api.method || ''),
                  })}>{api.method || 'GET'}</span>
                  <span className="font-mono text-[11px] text-[var(--accent)]">{api.path || api.endpoint}</span>
                  {api.authRequired && <span className="rounded bg-amber-500/10 px-1 py-0.5 text-[9px] text-amber-400">auth</span>}
                  {(api.roles || []).length > 0 && <span className="text-[9px] text-[var(--text-muted)]">{api.roles.join(', ')}</span>}
                  <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--text-muted)]">{api.description}</span>
                  <ChevronDown className={cn('h-3.5 w-3.5 shrink-0 text-[var(--text-muted)] transition-transform', openApi === i && 'rotate-180')} />
                </button>
                {openApi === i && (
                  <div className="space-y-2 border-t border-[var(--border)] p-2.5 text-[11px]">
                    {(api.requestParams || []).length > 0 && (
                      <div>
                        <div className="mb-1 text-[10px] font-semibold text-[var(--text-muted)] uppercase">Request parameters</div>
                        <div className="space-y-0.5">
                          {api.requestParams.map((p: any, pi: number) => (
                            <div key={pi} className="flex gap-2">
                              <span className="font-mono text-[var(--accent)]">{p.name}</span>
                              <span className="rounded bg-[var(--bg-card)] px-1 text-[var(--text-muted)]">{p.type}</span>
                              <span className="rounded bg-[var(--bg-card)] px-1 text-[9px] text-[var(--text-muted)]">{p.in}</span>
                              {p.required && <span className="text-red-400">required</span>}
                              {p.description && <span className="text-[var(--text-muted)]">— {p.description}</span>}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    {api.requestBodyExample && (
                      <div>
                        <div className="mb-0.5 text-[10px] font-semibold text-[var(--text-muted)] uppercase">Request example</div>
                        <pre className="overflow-x-auto rounded bg-[var(--bg-card)] p-1.5 font-mono text-[10px] text-[var(--text-primary)]">{api.requestBodyExample}</pre>
                      </div>
                    )}
                    {api.responseShape && (
                      <div>
                        <div className="mb-0.5 text-[10px] font-semibold text-[var(--text-muted)] uppercase">Response</div>
                        <p className="text-[var(--text-primary)]">{api.responseShape}</p>
                      </div>
                    )}
                    {api.responseExample && (
                      <div>
                        <pre className="overflow-x-auto rounded bg-[var(--bg-card)] p-1.5 font-mono text-[10px] text-[var(--text-primary)]">{api.responseExample}</pre>
                      </div>
                    )}
                    {(api.errorCodes || []).length > 0 && (
                      <div className="flex flex-wrap gap-1.5">
                        {api.errorCodes.map((e: any, ei: number) => (
                          <span key={ei} className="rounded border border-red-500/20 bg-red-500/5 px-1.5 py-0.5 text-[10px] text-red-400">
                            {e.code}: {e.description}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Metadata Objects ───────────────────────────────────────────────── */}
      {metaObjects.length > 0 && (
        <div className="mt-3">
          <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
            <Layers className="h-3.5 w-3.5" /> Metadata / Models ({metaObjects.length})
          </div>
          <div className="space-y-1.5">
            {metaObjects.map((obj: any, i: number) => (
              <div key={i} className="rounded-md border border-[var(--border)] bg-[var(--bg-secondary)]">
                <button onClick={() => setOpenMeta(openMeta === i ? null : i)} className="flex w-full items-center gap-2 px-2.5 py-2 text-left">
                  <Boxes className="h-3.5 w-3.5 shrink-0 text-purple-400" />
                  <span className="font-mono text-xs font-medium text-[var(--text-primary)]">{obj.name}</span>
                  <span className="rounded border border-purple-500/20 bg-purple-500/10 px-1 py-0.5 text-[9px] text-purple-400">{obj.kind}</span>
                  <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--text-muted)]">{obj.description}</span>
                  <ChevronDown className={cn('h-3.5 w-3.5 shrink-0 text-[var(--text-muted)] transition-transform', openMeta === i && 'rotate-180')} />
                </button>
                {openMeta === i && (
                  <div className="space-y-2 border-t border-[var(--border)] p-2.5 text-[11px]">
                    {(obj.fields || []).length > 0 && (
                      <div>
                        <div className="mb-1 text-[10px] font-semibold text-[var(--text-muted)] uppercase">Fields</div>
                        <div className="space-y-0.5">
                          {obj.fields.map((f: any, fi: number) => (
                            <div key={fi} className="flex gap-2">
                              <span className="font-mono text-[var(--accent)]">{f.name}</span>
                              <span className="rounded bg-[var(--bg-card)] px-1 text-[var(--text-muted)]">{f.type}</span>
                              {f.required && <span className="text-red-400 text-[10px]">required</span>}
                              {f.defaultValue && <span className="text-[var(--text-muted)]">default: {f.defaultValue}</span>}
                              {f.description && <span className="text-[var(--text-muted)]">— {f.description}</span>}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    {(obj.relationships || []).length > 0 && (
                      <div>
                        <div className="mb-1 text-[10px] font-semibold text-[var(--text-muted)] uppercase">Relationships</div>
                        <div className="space-y-0.5">
                          {obj.relationships.map((r: any, ri: number) => (
                            <div key={ri} className="flex gap-2 text-[11px]">
                              <span className="font-mono text-[var(--accent)]">{r.field}</span>
                              <span className="text-[var(--text-muted)]">→</span>
                              <span className="font-mono text-purple-400">{r.relatedTo}</span>
                              <span className="rounded bg-purple-500/10 px-1 text-[9px] text-purple-400">{r.cardinality}</span>
                              {r.description && <span className="text-[var(--text-muted)]">— {r.description}</span>}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Data Population ────────────────────────────────────────────────── */}
      {dataPopulation && (dataPopulation.requiredState || (dataPopulation.seedObjects || []).length > 0) && (
        <div className="mt-3 rounded-md border border-sky-500/20 bg-sky-500/5 p-2.5">
          <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-sky-400">
            <Database className="h-3.5 w-3.5" /> Data Population Requirements
          </div>
          {dataPopulation.requiredState && (
            <p className="mb-2 text-[11px] text-[var(--text-primary)]">{dataPopulation.requiredState}</p>
          )}
          {(dataPopulation.seedObjects || []).length > 0 && (
            <div className="mb-2 space-y-1">
              <div className="text-[10px] font-semibold text-[var(--text-muted)] uppercase">Seed objects needed</div>
              {dataPopulation.seedObjects.map((s: any, si: number) => (
                <div key={si} className="rounded bg-[var(--bg-secondary)] p-1.5 text-[11px]">
                  <span className="font-mono font-medium text-sky-400">{s.model}</span>
                  {s.description && <span className="ml-2 text-[var(--text-muted)]">— {s.description}</span>}
                  {Object.keys(s.exampleFields || {}).length > 0 && (
                    <pre className="mt-1 overflow-x-auto font-mono text-[10px] text-[var(--text-muted)]">{JSON.stringify(s.exampleFields, null, 2)}</pre>
                  )}
                </div>
              ))}
            </div>
          )}
          {(dataPopulation.creationOrder || []).length > 0 && (
            <p className="text-[11px] text-[var(--text-muted)]">
              <span className="font-medium text-[var(--text-primary)]">Creation order:</span> {dataPopulation.creationOrder.join(' → ')}
            </p>
          )}
          {dataPopulation.testNotes && (
            <p className="mt-1 text-[11px] text-[var(--text-muted)]">{dataPopulation.testNotes}</p>
          )}
        </div>
      )}

      {/* ── Service Connections ─────────────────────────────────────────────── */}
      {serviceConnections.length > 0 && (
        <div className="mt-3">
          <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
            <GitBranch className="h-3.5 w-3.5" /> Service Connections
          </div>
          <div className="space-y-1">
            {serviceConnections.map((c: any, ci: number) => (
              <div key={ci} className="flex items-center gap-2 text-[11px]">
                <span className="font-mono text-[var(--accent)]">{c.from}</span>
                <span className="text-[var(--text-muted)]">→</span>
                <span className="font-mono text-[var(--text-primary)]">{c.to}</span>
                <span className="rounded border border-[var(--border)] bg-[var(--bg-secondary)] px-1.5 py-0.5 text-[9px] text-[var(--text-muted)]">{c.via}</span>
                {c.description && <span className="text-[var(--text-muted)]">— {c.description}</span>}
              </div>
            ))}
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
              if ((understanding.metadataRefs || []).length) {
                lines.push('Metadata objects: ' + (understanding.metadataRefs as any[])
                  .map((m) => typeof m === 'string' ? m : (m.object || m.name || m.api_name || m.apiName || ''))
                  .filter(Boolean)
                  .join(', '));
              }
              if (uiSelectorRows.length) {
                lines.push('Repo UI hooks for testing:');
                uiSelectorRows.forEach((row) => lines.push(`  - ${row.label}: ${row.values.join(' | ')}`));
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
