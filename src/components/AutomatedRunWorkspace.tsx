import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bug, ChevronLeft, ChevronRight, Code2, Search } from 'lucide-react';
import { cn } from '@/src/lib/utils';
import { Timestamp } from '@/src/components/Timestamp';
import { ManualStepRunner, type StepResult } from './manualRunner/ManualStepRunner';
import { OutcomeDot, outcomeStyle } from './manualRunner/OutcomeSelect';
import { RunSummaryPanel } from './manualRunner/RunSummaryPanel';
import { applyExecutionProgress, type ExecutionStepProgress, type CaseStepProgress } from '@/core/shared/automationProgress';
import { useAgentEvents } from '@/src/lib/useAutomation';
import { runExecutionState } from '@/src/lib/manualTestRun';

function outcomeFor(steps: any[]) {
  const statuses = steps.map((step) => String(step?.outcome || step?.status || ''));
  if (statuses.some((status) => /fail/i.test(status))) return 'Failed';
  if (statuses.some((status) => /block/i.test(status))) return 'Blocked';
  if (statuses.some((status) => /retest/i.test(status))) return 'Retest';
  if (statuses.some((status) => /pass/i.test(status))) return 'Passed';
  return 'Not Run';
}

function stepsForCase(run: any, testCase: any, executionSteps: ExecutionStepProgress[], caseSteps: CaseStepProgress[]): StepResult[] {
  const all = Array.isArray(run.steps) ? run.steps : [];
  const matched = all.filter((step: any) => String(step.testCaseId || '') === String(testCase.id)
    || String(step.testCaseTitle || '') === String(testCase.title || ''));
  const source = matched.length ? matched : (Array.isArray(testCase.steps) ? testCase.steps : []);
  const authored: StepResult[] = source.map((step: any) => ({
    action: step.action || step.description || step.name || '—',
    expected: step.expected || step.expectedResult || '—',
    outcome: step.outcome || step.status || 'Not Run',
    durationMs: Number(step.durationMs) || undefined,
    screenshots: Array.isArray(step.screenshots) ? step.screenshots : [],
    sourceStepIds: Array.isArray(step.sourceStepIds) ? step.sourceStepIds : undefined,
  }));
  const progressed = applyExecutionProgress<StepResult>(authored, executionSteps, caseSteps);
  const isOnlyCase = Array.isArray(run.caseIds) && run.caseIds.length === 1 && String(run.caseIds[0]) === String(testCase.id);
  const savedOutcome = outcomeFor(matched.length ? matched : (isOnlyCase ? all : []));
  return savedOutcome === 'Not Run' || progressed.some((step) => step.outcome !== 'Not Run')
    ? progressed
    : progressed.map((step) => ({ ...step, outcome: savedOutcome }));
}

export function AutomatedRunWorkspace({ run, cases, plans, suites, onChanged }: { run: any; cases: any[]; plans: any[]; suites: any[]; onChanged?: () => void }) {
  const [selectedCaseId, setSelectedCaseId] = useState<string | null>(null);
  const [showImages, setShowImages] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | 'failed' | 'passed' | 'not-run'>('all');
  const [executionSteps, setExecutionSteps] = useState<ExecutionStepProgress[]>([]);
  const [caseSteps, setCaseSteps] = useState<CaseStepProgress[]>([]);
  const jobId = String(run.triggerMeta?.automationJobId || '');
  const executionStepsInFlight = useRef(false);
  const loadedRef = useRef(false);
  const loadExecutionSteps = useCallback(async () => {
    if (!jobId) { setExecutionSteps([]); setCaseSteps([]); return; }
    if (executionStepsInFlight.current) return;
    executionStepsInFlight.current = true;
    try {
      // Bounded so a stalled/dropped request can't wedge this in-flight guard forever — without a
      // timeout, one failed request permanently blocks every future retry (including the poll below).
      const data = await fetch(`/api/automation/jobs/${encodeURIComponent(jobId)}`, { signal: AbortSignal.timeout(20000) }).then((response) => response.json());
      setExecutionSteps(Array.isArray(data?.job?.summary?.executionSteps) ? data.job.summary.executionSteps : []);
      setCaseSteps(Array.isArray(data?.job?.summary?.caseSteps) ? data.job.summary.caseSteps : []);
      loadedRef.current = true;
    } catch { /* keep the last durable result; retried below */ }
    finally { executionStepsInFlight.current = false; }
  }, [jobId]);
  // The parent polls the linked run while execution is active. Reload the job summary when that
  // run becomes terminal too; otherwise this workspace keeps the initial queued step list and
  // renders Not Run even though the server already recorded the final result.
  useEffect(() => { loadedRef.current = false; setExecutionSteps([]); setCaseSteps([]); void loadExecutionSteps(); }, [loadExecutionSteps, run.status, run.completedAt]);
  useAgentEvents((event) => { if (event.scopeType === 'job' && event.scopeId === jobId) void loadExecutionSteps(); });

  // SSE is the primary channel here; poll as a fallback and resync on visibility/focus regain,
  // matching AutomationRunArtifacts/TestRuns so this panel can't fall behind them.
  const running = runExecutionState(run).running;
  useEffect(() => {
    if (!jobId) return;
    // A finished run only gets the one mount-time fetch above — if that single attempt is ever slow,
    // dropped, or lost to connection-limit queueing, there was previously no retry at all and the
    // panel stayed stuck on "Not Run" forever. Keep polling (bounded) until real data lands even when
    // the run isn't actively running, not just while it is.
    if (!running && loadedRef.current) return;
    const maxAttempts = running ? Infinity : 6;
    let attempts = 0;
    const timer = window.setInterval(() => {
      if (!running && (loadedRef.current || attempts >= maxAttempts)) { window.clearInterval(timer); return; }
      attempts += 1;
      void loadExecutionSteps();
    }, 2000);
    return () => window.clearInterval(timer);
  }, [running, jobId, loadExecutionSteps]);
  useEffect(() => {
    if (!running || !jobId) return;
    const onVisible = () => { if (document.visibilityState === 'visible') void loadExecutionSteps(); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => { document.removeEventListener('visibilitychange', onVisible); window.removeEventListener('focus', onVisible); };
  }, [running, jobId, loadExecutionSteps]);
  const results = useMemo(() => cases.map((testCase) => {
    const stepResults = stepsForCase(run, testCase, executionSteps, caseSteps);
    const summary = run.definition?.caseSummary?.[testCase.id] || {};
    return { caseId: testCase.id, caseTitle: testCase.title, priority: summary.priority || testCase.priority, configuration: summary.configuration || '', tags: testCase.tags || [], outcome: outcomeFor(stepResults), stepResults };
  }), [cases, executionSteps, caseSteps, run]);
  useEffect(() => { if (results.length && !results.some((result) => result.caseId === selectedCaseId)) setSelectedCaseId(results[0].caseId); }, [results, selectedCaseId]);

  const active = results.find((result) => result.caseId === selectedCaseId) || null;
  const evaluated = results.filter((result) => result.outcome !== 'Not Run').length;
  const visibleResults = results.filter((result) => (filter === 'all' || (filter === 'not-run' ? result.outcome === 'Not Run' : result.outcome.toLowerCase() === filter)) && `${result.caseTitle} ${result.caseId} ${result.tags.join(' ')}`.toLowerCase().includes(query.toLowerCase()));
  const count = (outcome: string) => results.filter((result) => result.outcome === outcome).length;
  const allSelected = results.length > 0 && selected.size === results.length;
  const toggle = (id: string) => setSelected((current) => { const next = new Set(current); next.has(id) ? next.delete(id) : next.add(id); return next; });
  const planName = plans.find((plan) => plan.id === run.testPlanId)?.name || '';
  const suiteName = suites.find((suite) => suite.id === run.suiteId)?.name || run.suiteName || '';
  const updateSummary = async (caseId: string, patch: Record<string, string>) => {
    const response = await fetch(`/api/runs/${encodeURIComponent(run.id)}/summary/${encodeURIComponent(caseId)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
    if (response.ok) onChanged?.();
  };

  const activeIndex = results.findIndex((result) => result.caseId === selectedCaseId);
  return <div className="flex min-h-[30rem] border-b border-[var(--border)] bg-[var(--bg-secondary)]/20">
    <aside className="flex h-[calc(100dvh-10rem)] w-72 shrink-0 flex-col overflow-hidden border-r border-[var(--border)] bg-[var(--bg-card)]">
      <div className="border-b border-[var(--border)] p-3">
        <div className="flex items-center justify-between text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]"><span>Cases in this run</span><span className="normal-case tracking-normal">{evaluated} of {results.length} evaluated</span></div>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[var(--bg-secondary)]"><div className="h-full bg-[var(--accent)] transition-[width]" style={{ width: `${results.length ? (evaluated / results.length) * 100 : 0}%` }} /></div>
        <label className="relative mt-3 block"><Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--text-muted)]" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search cases…" className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] py-1.5 pl-8 pr-2 text-xs outline-none focus:border-[var(--accent)]" /></label>
        <div className="mt-2 flex flex-wrap gap-1">{([['all', `All ${results.length}`], ['failed', `Failed ${count('Failed')}`], ['passed', `Passed ${count('Passed')}`], ['not-run', `Not started ${count('Not Run')}`]] as const).map(([value, label]) => <button key={value} type="button" onClick={() => setFilter(value)} className={cn('rounded-full border px-2 py-1 text-[10px] font-medium', filter === value ? 'border-[var(--accent)]/30 bg-[var(--accent)]/15 text-[var(--accent)]' : 'border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text-primary)]')}>{label}</button>)}</div>
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto">
        {visibleResults.map((result) => <li key={result.caseId} className={cn('border-l-2 border-transparent hover:bg-[var(--bg-secondary)]/60', result.caseId === selectedCaseId && 'border-[var(--accent)] bg-[var(--accent)]/10')}>
          <div className="flex items-center gap-2 px-3 py-2.5"><button type="button" onClick={() => setSelectedCaseId(result.caseId)} className="flex min-w-0 flex-1 items-center gap-2 text-left"><OutcomeDot outcome={result.outcome} /><span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium text-[var(--text-primary)]">{result.caseTitle || result.caseId}</span><span className="block truncate font-mono text-[10px] text-[var(--text-muted)]">{result.caseId}</span></span></button></div>
        </li>)}
      </ul>
      <div className="flex items-center justify-between border-t border-[var(--border)] px-3 py-2">
        <button type="button" disabled={activeIndex <= 0} onClick={() => setSelectedCaseId(results[activeIndex - 1]?.caseId || null)} aria-label="Previous test case" className="rounded p-1 text-[var(--text-muted)] hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)] disabled:opacity-30"><ChevronLeft className="h-4 w-4" /></button>
        <span className="text-[10px] text-[var(--text-muted)]">{activeIndex + 1} / {results.length}</span>
        <button type="button" disabled={activeIndex < 0 || activeIndex === results.length - 1} onClick={() => setSelectedCaseId(results[activeIndex + 1]?.caseId || null)} aria-label="Next test case" className="rounded p-1 text-[var(--text-muted)] hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)] disabled:opacity-30"><ChevronRight className="h-4 w-4" /></button>
      </div>
      {count('Failed') > 0 && <button type="button" onClick={() => setSelectedCaseId(results.find((result) => result.outcome === 'Failed')?.caseId || null)} className="mx-3 mb-2 rounded-md border border-[var(--border)] py-1.5 text-xs font-medium text-[var(--text-primary)] hover:border-[var(--accent)]">Jump to first failed</button>}
      {active && <div className="border-t border-[var(--border)] overflow-y-auto"><RunSummaryPanel run={run} planName={planName} suiteName={suiteName} result={active} linkedDefects={[]} disabled={running} onFieldChange={(patch) => { void updateSummary(active.caseId, patch); }} /></div>}
    </aside>
    <section className="min-w-0 flex-1 overflow-auto">
      {!active ? <div className="p-8 text-sm text-[var(--text-muted)]">{run.triggerMeta?.automationJobId
        // A script that isn't linked to a test case executes fine but has nothing to list here —
        // say that, instead of implying the run was empty.
        ? 'This run executed a script that is not linked to a test case, so there are no per-case results. Its video, screenshots and logs are below.'
        : 'No test cases in this run.'}</div> : <>
        <div className="sticky top-0 z-10 flex flex-wrap items-center gap-x-6 gap-y-3 border-b border-[var(--border)] bg-[var(--bg-card)] px-5 py-3"><div className="min-w-0"><div className="truncate text-sm font-semibold text-[var(--text-primary)]">{active.caseTitle || active.caseId}</div><div className="mt-0.5 font-mono text-[10px] text-[var(--text-muted)]">{active.caseId}</div></div><span className="inline-flex items-center gap-1.5 text-sm font-medium text-violet-300"><Code2 className="h-4 w-4" /> Automated</span><div className="ml-auto flex items-center gap-4 text-sm text-[var(--text-muted)]"><span>Start Time <span className="text-[var(--text-primary)]">{run.startedAt ? <Timestamp value={run.startedAt} /> : '—'}</span></span><span>Duration {run.executionTime || '—'}</span><label className="flex items-center gap-2 text-[var(--text-primary)]"><button type="button" role="switch" aria-checked={showImages} onClick={() => setShowImages((value) => !value)} className={cn('inline-flex h-5 w-9 items-center rounded-full', showImages ? 'bg-[var(--accent)]' : 'bg-[var(--border)]')}><span className={cn('h-4 w-4 rounded-full bg-white shadow transition-transform', showImages ? 'translate-x-4' : 'translate-x-0.5')} /></button>Show Images</label><span className="inline-flex items-center gap-1.5 text-[var(--text-muted)]"><Bug className="h-4 w-4" /> Create bug</span><span className={cn('inline-flex items-center gap-1.5 rounded border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1 font-medium', outcomeStyle(active.outcome).text)}><OutcomeDot outcome={active.outcome} />{active.outcome}</span></div></div>
        <div className="px-5 pb-6"><h3 className="mb-2 text-sm font-semibold">Steps</h3><div className="rounded-lg border border-[var(--border)] bg-[var(--bg-card)]"><ManualStepRunner steps={active.stepResults} showImages={showImages} disabled authoringDisabled onStepChange={() => {}} onUploadScreenshot={() => {}} onOpenImage={() => {}} /></div></div>
      </>}
    </section>
  </div>;
}
