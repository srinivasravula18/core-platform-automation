import { cn } from '@/src/lib/utils';

/**
 * Rich professional defect report renderer (bug-investigation framework).
 * Renders the full structured payload the defect reporter files: repro steps, expected/actual,
 * environment, risk block, test data, console errors, evidence gallery, and (when the
 * investigation phases ran) classification + per-observation confidence + recovery attempts.
 * Legacy title-only defects render nothing extra — the page treats them as before.
 */

function Section({ title, children }: { title: string; children: any }) {
  return (
    <div className="mb-4">
      <div className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)] mb-1.5">{title}</div>
      {children}
    </div>
  );
}

function Pre({ text }: { text: string }) {
  return <pre className="text-xs whitespace-pre-wrap font-mono bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md p-3 text-[var(--text-primary)]">{text}</pre>;
}

function riskColor(level?: string) {
  return level === 'high' ? 'text-red-500 bg-red-500/10 border-red-500/30'
    : level === 'medium' ? 'text-orange-500 bg-orange-500/10 border-orange-500/30'
    : 'text-blue-500 bg-blue-500/10 border-blue-500/30';
}

export function hasRichReport(defect: any): boolean {
  const m = defect?.metadata || {};
  return Boolean(defect?.stepsToReproduce || defect?.expected || defect?.actual || m.signature || m.investigation);
}

export default function DefectReport({ defect }: { defect: any }) {
  const m = defect?.metadata || {};
  const risk = m.risk || null;
  const investigation: any = m.investigation || null;
  const evidence: any[] = Array.isArray(defect?.evidence) ? defect.evidence : [];
  const env: Record<string, string> = m.environment || {};
  const testData: Array<{ field: string; value: string }> = Array.isArray(m.testDataUsed) ? m.testDataUsed : [];
  const consoleErrors: Array<{ type?: string; text?: string }> = Array.isArray(m.consoleErrors) ? m.consoleErrors : [];
  const recovery: any[] = Array.isArray(m.recoveryAttempts) ? m.recoveryAttempts : [];

  return (
    <div className="p-4 bg-[var(--bg-primary)] border-t border-[var(--border)]">
      {/* Summary chips */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        {risk && (
          <span className={cn('inline-flex items-center px-2 py-0.5 rounded border text-xs font-bold', riskColor(risk.level))}>
            Risk {risk.score}/100 · {String(risk.level || '').toUpperCase()}
          </span>
        )}
        {typeof m.frequency === 'number' && m.frequency > 1 && (
          <span className="inline-flex items-center px-2 py-0.5 rounded border border-[var(--border)] text-xs text-[var(--text-muted)]">
            {m.frequency} tests affected
          </span>
        )}
        {m.regression && (
          <span className="inline-flex items-center px-2 py-0.5 rounded border border-red-500/30 bg-red-500/10 text-xs font-bold text-red-500">
            REGRESSION{m.lastPassedRunId ? ` — passed in ${m.lastPassedRunId}` : ''}
          </span>
        )}
        {typeof m.occurrences === 'number' && m.occurrences > 1 && (
          <span className="inline-flex items-center px-2 py-0.5 rounded border border-amber-500/30 bg-amber-500/10 text-xs text-amber-500">
            Seen in {m.occurrences} runs
          </span>
        )}
        {m.suspiciousPass && (
          <span className="inline-flex items-center px-2 py-0.5 rounded border border-purple-500/30 bg-purple-500/10 text-xs font-bold text-purple-500">
            SUSPICIOUS PASS — assertions passed but the intent was not satisfied
          </span>
        )}
        {m.errorKind && (
          <span className="inline-flex items-center px-2 py-0.5 rounded border border-[var(--border)] text-xs font-mono text-[var(--text-muted)]">
            {m.errorKind}{m.failingTarget ? ` @ ${m.failingTarget}` : ''}
          </span>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-x-6">
        <div>
          {defect.description && <Section title="Description"><Pre text={defect.description} /></Section>}
          {defect.stepsToReproduce && <Section title="Steps to Reproduce"><Pre text={defect.stepsToReproduce} /></Section>}
          {(defect.expected || defect.actual) && (
            <Section title="Expected vs Actual">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                <div>
                  <div className="text-[10px] font-semibold text-emerald-500 mb-1">EXPECTED</div>
                  <Pre text={defect.expected || '—'} />
                </div>
                <div>
                  <div className="text-[10px] font-semibold text-red-500 mb-1">ACTUAL</div>
                  <Pre text={defect.actual || '—'} />
                </div>
              </div>
            </Section>
          )}
          {testData.length > 0 && (
            <Section title="Test Data Used">
              <table className="text-xs w-full">
                <tbody>
                  {testData.map((d, i) => (
                    <tr key={i} className="border-b border-[var(--border)] last:border-0">
                      <td className="py-1 pr-3 text-[var(--text-muted)]">{d.field}</td>
                      <td className="py-1 font-mono">{d.value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Section>
          )}
        </div>

        <div>
          {risk?.factors?.length > 0 && (
            <Section title="Risk Factors">
              <ul className="text-xs list-disc pl-4 space-y-0.5 text-[var(--text-primary)]">
                {risk.factors.map((f: string, i: number) => <li key={i}>{f}</li>)}
              </ul>
            </Section>
          )}
          {Object.keys(env).length > 0 && (
            <Section title="Environment">
              <table className="text-xs w-full">
                <tbody>
                  {Object.entries(env).filter(([, v]) => v).map(([k, v]) => (
                    <tr key={k} className="border-b border-[var(--border)] last:border-0">
                      <td className="py-1 pr-3 text-[var(--text-muted)]">{k}</td>
                      <td className="py-1 font-mono break-all">{String(v)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Section>
          )}
          {consoleErrors.length > 0 && (
            <Section title="Console Errors">
              <div className="space-y-1">
                {consoleErrors.map((c, i) => (
                  <div key={i} className="text-xs font-mono text-red-400 bg-red-500/5 border border-red-500/20 rounded px-2 py-1">
                    [{c.type || 'error'}] {c.text}
                  </div>
                ))}
              </div>
            </Section>
          )}
          {investigation && (
            <Section title="Investigation">
              <div className="text-xs space-y-1.5 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md p-3">
                {investigation.classification && (
                  <div><span className="text-[var(--text-muted)]">Classification: </span><span className="font-semibold">{investigation.classification}</span>
                    {typeof investigation.confidence === 'number' && <span className="text-[var(--text-muted)]"> ({Math.round(investigation.confidence * 100)}% confidence)</span>}
                  </div>
                )}
                {investigation.rootCauseArea && (
                  <div><span className="text-[var(--text-muted)]">Root cause area: </span>{investigation.rootCauseArea}</div>
                )}
                {Array.isArray(investigation.observations) && investigation.observations.map((o: any, i: number) => (
                  <div key={i} className="border-l-2 border-[var(--border)] pl-2">
                    {o.statement}
                    <span className="text-[var(--text-muted)]"> — {Math.round((o.confidence ?? 0) * 100)}%{Array.isArray(o.verifiedBy) && o.verifiedBy.length ? `, via ${o.verifiedBy.join(', ')}` : ''}</span>
                  </div>
                ))}
                {investigation.suggestedAreas?.length > 0 && (
                  <div><span className="text-[var(--text-muted)]">Suggested investigation: </span>{investigation.suggestedAreas.join('; ')}</div>
                )}
              </div>
            </Section>
          )}
          {recovery.length > 0 && (
            <Section title="Recovery Attempts">
              <ul className="text-xs list-disc pl-4 space-y-0.5">
                {recovery.map((r: any, i: number) => (
                  <li key={i}>{typeof r === 'string' ? r : `${r.kind || 'attempt'}: ${r.outcome || JSON.stringify(r)}`}</li>
                ))}
              </ul>
            </Section>
          )}
        </div>
      </div>

      {evidence.length > 0 && (
        <Section title={`Evidence (${evidence.length})`}>
          <div className="flex gap-2 overflow-x-auto pb-2">
            {evidence.map((e: any, i: number) => (
              e?.screenshotUrl ? (
                <a key={i} href={e.screenshotUrl} target="_blank" rel="noreferrer" className="flex-shrink-0 group">
                  <img src={e.screenshotUrl} alt={e.title || `evidence ${i + 1}`} className="h-28 rounded border border-[var(--border)] group-hover:border-red-500 transition-colors" />
                  <div className="text-[10px] text-[var(--text-muted)] mt-0.5 max-w-[180px] truncate">{e.title || ''}</div>
                </a>
              ) : null
            ))}
          </div>
        </Section>
      )}
    </div>
  );
}
