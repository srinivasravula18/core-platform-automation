import { useCallback, useEffect, useMemo, useState } from 'react';
import { Bug, Check, X, Circle, Clock, ChevronLeft, ChevronRight, PanelLeftClose, PanelLeftOpen, Play, Search, Square } from 'lucide-react';
import { can } from '@/src/components/AuthGate';
import { withBasePath } from '@/src/lib/base-path';
import { showAlert } from '@/src/lib/dialog';
import { Timestamp } from '@/src/components/Timestamp';
import { computeRunRollup, isManualRunActive, type ManualOutcome } from '@/core/shared/manualRun';
import { OutcomeSelect, OutcomeDot, SELECTABLE_MANUAL_OUTCOMES } from './OutcomeSelect';
import { ManualStepRunner, type StepResult } from './ManualStepRunner';
import { RunSummaryPanel } from './RunSummaryPanel';
import { VersionPinSelect } from '@/src/components/VersionPinSelect';

async function api(url: string, body?: any) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'Request failed.');
  return data;
}

// Human duration: explicit ms, or startedAt→completedAt, or (while running) startedAt→now (live elapsed).
function formatDuration(result: any, now?: number): string {
  let ms = Number(result?.durationMs) || 0;
  if (!ms && result?.startedAt && result?.completedAt) ms = new Date(result.completedAt).getTime() - new Date(result.startedAt).getTime();
  if (!ms && result?.startedAt && !result?.completedAt) ms = (now || Date.now()) - new Date(result.startedAt).getTime();
  if (!ms || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem ? `${m}m ${rem}s` : `${m}m`;
}

function ManualExecutionArtifacts({ results, duration, status }: { results: any[]; duration: string; status: string }) {
  const outcomes = results.map((result) => String(result.outcome || 'Not Run'));
  const stats = {
    passed: outcomes.filter((outcome) => outcome === 'Passed').length,
    failed: outcomes.filter((outcome) => outcome === 'Failed').length,
    skipped: outcomes.filter((outcome) => outcome === 'Not Applicable').length,
    blocked: outcomes.filter((outcome) => outcome === 'Blocked').length,
    retest: outcomes.filter((outcome) => outcome === 'Retest').length,
    untested: outcomes.filter((outcome) => outcome === 'Not Run' || outcome === 'Paused').length,
  };
  const meta = status === 'Passed' ? 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10' : status === 'Failed' ? 'text-red-400 border-red-500/30 bg-red-500/10' : 'text-[var(--text-muted)] border-[var(--border)] bg-[var(--bg-secondary)]';
  return <div className="mx-5 mt-4 rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)]/30 px-5 py-4">
    <div className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">Manual execution <span className={`rounded-full border px-2 py-0.5 text-[10px] normal-case tracking-normal ${meta}`}>{status}</span></div>
    <div className="grid grid-cols-2 divide-x divide-y divide-[var(--border)] overflow-hidden rounded-md border border-[var(--border)] sm:grid-cols-4 xl:grid-cols-7 xl:divide-y-0">
      {Object.entries({ Passed: stats.passed, Failed: stats.failed, Skipped: stats.skipped, Blocked: stats.blocked, Retest: stats.retest, Untested: stats.untested, Duration: duration }).map(([label, value]) => <div key={label} className="bg-[var(--bg-card)] px-3 py-2.5 text-center"><div className={`text-lg font-semibold ${label === 'Passed' ? 'text-emerald-400' : label === 'Failed' ? 'text-red-400' : 'text-[var(--text-primary)]'}`}>{value}</div><div className="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">{label}</div></div>)}
    </div>
  </div>;
}

// The large Azure-style result status derived from a case outcome.
function resultStatus(outcome: string) {
  if (outcome === 'Passed') return { Icon: Check, label: 'Test Passed', cls: 'text-emerald-500' };
  if (outcome === 'Failed') return { Icon: X, label: 'Test Failed', cls: 'text-red-500' };
  if (!outcome || outcome === 'Not Run') return { Icon: Circle, label: 'Not Run', cls: 'text-[var(--text-muted)]' };
  return { Icon: Clock, label: 'In Progress', cls: 'text-amber-500' };
}

// Manual test runner: master (test-points list + bulk toolbar) / detail (selected case result) view,
// backed by the Phase-B1 /api/runs/:id/results endpoints.
export function ManualRunner({
  run,
  cases,
  plans,
  suites,
  onChanged,
}: {
  run: any;
  cases: any[];
  plans: any[];
  suites: any[];
  onChanged: () => void;
}) {
  const [results, setResults] = useState<any[]>([]);
  const [defects, setDefects] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showImages, setShowImages] = useState(true);
  const [selectedCase, setSelectedCase] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkOutcome, setBulkOutcome] = useState<ManualOutcome>('Passed');
  const [caseQuery, setCaseQuery] = useState('');
  const [caseFilter, setCaseFilter] = useState<'all' | 'failed' | 'passed' | 'not-run'>('all');
  const [busy, setBusy] = useState(false);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [isCasePanelMinimized, setIsCasePanelMinimized] = useState(false);
  const [now, setNow] = useState(() => Date.now()); // live clock for the in-progress duration

  const editable = can('runs:execute');
  const caseById = useMemo(() => new Map(cases.map((c) => [c.id, c])), [cases]);
  const planName = plans.find((p) => p.id === run.testPlanId)?.name || '';
  const suiteName = suites.find((s) => s.id === run.suiteId)?.name || run.suiteName || '';
  const rollup = computeRunRollup(results);
  const executionEditable = editable && isManualRunActive(run);

  const load = useCallback(async (showLoading = true) => {
    if (showLoading) setLoading(true);
    try {
      const [r, d] = await Promise.all([
        fetch(`/api/runs/${encodeURIComponent(run.id)}/results`).then((x) => x.json()),
        fetch('/api/defects').then((x) => x.json()).catch(() => []),
      ]);
      setResults(Array.isArray(r?.results) ? r.results : []);
      setDefects((Array.isArray(d) ? d : []).filter((x: any) => x.linkedRunId === run.id));
    } catch {
      setResults([]);
    } finally {
      if (showLoading) setLoading(false);
    }
  }, [run.id]);

  useEffect(() => { void load(); }, [load]);

  // Tick the clock every second while a result is in progress, so the header duration counts up live.
  useEffect(() => {
    if (!results.some((r) => r.startedAt && !r.completedAt)) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [results]);

  // Default selection to the first case; keep it valid as results change.
  useEffect(() => {
    if (results.length && (!selectedCase || !results.some((r) => r.caseId === selectedCase))) setSelectedCase(results[0].caseId);
  }, [results, selectedCase]);

  const mergeResult = (result: any) => setResults((prev) => prev.map((r) => (r.caseId === result.caseId ? result : r)));

  async function run_(fn: () => Promise<void>) {
    if (!editable || busy) return;
    setBusy(true);
    try { await fn(); onChanged(); } catch (e: any) { void showAlert(e?.message || 'Action failed.'); } finally { setBusy(false); }
  }

  const setCaseOutcome = (caseId: string, outcome: ManualOutcome) => run_(async () => {
    const data = await api(`/api/runs/${encodeURIComponent(run.id)}/results/${encodeURIComponent(caseId)}`, { outcome });
    mergeResult(data.result);
  });

  const setCaseField = (caseId: string, patch: Record<string, string>) => run_(async () => {
    const data = await api(`/api/runs/${encodeURIComponent(run.id)}/results/${encodeURIComponent(caseId)}`, patch);
    mergeResult(data.result);
  });

  const setStep = (caseId: string, index: number, patch: Partial<StepResult>) => run_(async () => {
    const data = await api(`/api/runs/${encodeURIComponent(run.id)}/results/${encodeURIComponent(caseId)}/steps/${index}`, patch);
    mergeResult(data.result);
  });

  const uploadShot = (caseId: string, index: number, dataUrl: string) => run_(async () => {
    const data = await api(`/api/runs/${encodeURIComponent(run.id)}/results/${encodeURIComponent(caseId)}/attachments`, { dataUrl, stepIndex: index });
    mergeResult(data.result);
  });

  const bulkSet = () => run_(async () => {
    const data = await api(`/api/runs/${encodeURIComponent(run.id)}/results/bulk`, { outcome: bulkOutcome, caseIds: [...selected] });
    setResults(Array.isArray(data.results) ? data.results : results);
    setSelected(new Set());
  });

  const createBug = (caseId: string) => run_(async () => {
    const data = await api(`/api/runs/${encodeURIComponent(run.id)}/results/${encodeURIComponent(caseId)}/bug`, {});
    if (data.defect) setDefects((prev) => [data.defect, ...prev]);
  });

  const addStep = (caseId: string) => run_(async () => {
    const data = await api(`/api/runs/${encodeURIComponent(run.id)}/results/${encodeURIComponent(caseId)}/steps`, { action: '', expected: '' });
    mergeResult(data.result);
  });

  const deleteStep = (caseId: string, index: number) => run_(async () => {
    const res = await fetch(`/api/runs/${encodeURIComponent(run.id)}/results/${encodeURIComponent(caseId)}/steps/${index}`, { method: 'DELETE' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error || 'Failed to delete step.');
    mergeResult(data.result);
  });

  // Start a manual run (no scripts) — begins the clock; the tester then records outcomes/evidence.
  const startRun = () => run_(async () => {
    await api(`/api/runs/${encodeURIComponent(run.id)}/start`, {});
    await load(false);
  });

  // Stop/finish a manual run — freezes the duration and marks it Completed.
  const stopRun = () => run_(async () => {
    await api(`/api/runs/${encodeURIComponent(run.id)}/stop`, {});
    await load(false);
  });

  const toggleSelect = (caseId: string) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(caseId)) next.delete(caseId); else next.add(caseId);
    return next;
  });
  const allSelected = results.length > 0 && selected.size === results.length;
  const visibleResults = results.filter((result) => (caseFilter === 'all' || (caseFilter === 'not-run' ? String(result.outcome || 'Not Run') === 'Not Run' : String(result.outcome || '').toLowerCase() === caseFilter)) && `${result.caseTitle || ''} ${result.caseId} ${(caseById.get(result.caseId)?.tags || []).join(' ')}`.toLowerCase().includes(caseQuery.toLowerCase()));
  const resultCount = (outcome: string) => results.filter((result) => String(result.outcome || 'Not Run') === outcome).length;

  const selectedResult = results.find((r) => r.caseId === selectedCase) || null;
  // A case-less manual run authors its own steps: one result keyed to the run itself. No left case list.
  const standalone = results.length === 1 && results[0]?.caseId === run.id;

  if (loading) return <div className="p-8 text-sm text-[var(--text-muted)]">Loading manual run…</div>;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <ManualExecutionArtifacts results={results} duration={formatDuration(run, now)} status={rollup.status} />
      <div className="flex min-h-0 flex-1 overflow-hidden bg-[var(--bg-secondary)]/20">
        {/* LEFT: bulk toolbar + test-points list (hidden for a standalone step-authored run) */}
        {!standalone && !isCasePanelMinimized && (
        <aside className="flex h-[calc(100dvh-10rem)] w-72 shrink-0 flex-col overflow-hidden border-r border-[var(--border)] bg-[var(--bg-card)]">
          <div className="border-b border-[var(--border)] p-3">
            <div className="flex items-center justify-between text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]"><span>Cases in this run</span><span className="normal-case tracking-normal">{results.length - resultCount('Not Run')} of {results.length} evaluated</span></div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[var(--bg-secondary)]"><div className="h-full bg-[var(--accent)] transition-[width]" style={{ width: `${results.length ? ((results.length - resultCount('Not Run')) / results.length) * 100 : 0}%` }} /></div>
            <label className="relative mt-3 block"><Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--text-muted)]" /><input value={caseQuery} onChange={(event) => setCaseQuery(event.target.value)} placeholder="Search cases…" className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] py-1.5 pl-8 pr-2 text-xs outline-none focus:border-[var(--accent)]" /></label>
            <div className="mt-2 flex flex-wrap gap-1">{([['all', `All ${results.length}`], ['failed', `Failed ${resultCount('Failed')}`], ['passed', `Passed ${resultCount('Passed')}`], ['not-run', `Not started ${resultCount('Not Run')}`]] as const).map(([value, label]) => <button key={value} type="button" onClick={() => setCaseFilter(value)} className={`rounded-full border px-2 py-1 text-[10px] font-medium ${caseFilter === value ? 'border-[var(--accent)]/30 bg-[var(--accent)]/15 text-[var(--accent)]' : 'border-[var(--border)] text-[var(--text-muted)]'}`}>{label}</button>)}</div>
          </div>
          {editable && (
            <div className="hidden flex-nowrap items-center gap-2 border-b border-[var(--border)] px-3 py-2.5">
              <label className="flex shrink-0 items-center gap-1.5 text-xs text-[var(--text-muted)]">
                <input type="checkbox" disabled={!executionEditable} checked={allSelected} onChange={() => setSelected(allSelected ? new Set() : new Set(results.map((r) => r.caseId)))} />
                {selected.size ? `${selected.size} selected` : 'All'}
              </label>
              <select disabled={!executionEditable} value={bulkOutcome} onChange={(e) => setBulkOutcome(e.target.value as ManualOutcome)} className="w-0 min-w-0 flex-1 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1 text-xs outline-none disabled:opacity-50">
                {SELECTABLE_MANUAL_OUTCOMES.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
              <button type="button" disabled={busy || !executionEditable} onClick={bulkSet} className="shrink-0 rounded-md bg-[var(--accent)] px-2.5 py-1 text-xs font-medium text-white hover:bg-[var(--accent-hover)] disabled:opacity-50">
                Apply{selected.size ? ` (${selected.size})` : ' all'}
              </button>
              <button type="button" onClick={() => setIsCasePanelMinimized(true)} title="Minimize test case panel" aria-label="Minimize test case panel" className="group shrink-0 rounded p-1 text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)]">
                <PanelLeftClose className="h-4 w-4 transition-transform duration-200 group-hover:-translate-x-0.5" />
              </button>
            </div>
          )}
          {!editable && <div className="flex justify-end border-b border-[var(--border)] px-3 py-2"><button type="button" onClick={() => setIsCasePanelMinimized(true)} title="Minimize test case panel" aria-label="Minimize test case panel" className="rounded p-1 text-[var(--text-muted)] hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)]"><PanelLeftClose className="h-4 w-4" /></button></div>}
          <div className="hidden border-b border-[var(--border)] px-3 py-2 text-xs text-[var(--text-muted)]">
            <span className="font-medium text-[var(--text-primary)]">{rollup.status}</span> · {rollup.progress}
          </div>
          <ul className="min-h-0 flex-1 overflow-y-auto">
            {results.length === 0 ? (
              <li className="px-4 py-8 text-center text-sm text-[var(--text-muted)]">No test points in this run.</li>
            ) : visibleResults.map((result) => {
              const isSelected = result.caseId === selectedCase;
              const title = result.caseTitle || caseById.get(result.caseId)?.title || result.caseId;
              return (
                <li key={result.caseId} className={isSelected ? 'border-l-2 border-[var(--accent)] bg-[var(--accent)]/10' : 'border-l-2 border-transparent hover:bg-[var(--bg-secondary)]/60'}>
                  <div className="flex items-center gap-2 px-3 py-2.5">
                    {editable && <input type="checkbox" disabled={!executionEditable} checked={selected.has(result.caseId)} onChange={() => toggleSelect(result.caseId)} onClick={(e) => e.stopPropagation()} />}
                    <button type="button" onClick={() => setSelectedCase(result.caseId)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
                      <OutcomeDot outcome={result.outcome || 'Not Run'} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm text-[var(--text-primary)]">{title}</span>
                        <span className="block truncate font-mono text-[10px] text-[var(--text-muted)]">{result.caseId}{!editable && result.revisionNo ? ` v${result.revisionNo}` : ''}</span>
                      </span>
                    </button>
                    {/* Change which version this run executes for the case; re-seeds the pinned steps (Not-Started runs). */}
                    {editable && result.caseId !== run.id && (
                      <VersionPinSelect
                        target="runs"
                        groupId={run.id}
                        caseId={result.caseId}
                        pinnedRevisionNo={(run.casePins || []).find((p: any) => String(p?.caseId) === String(result.caseId))?.revisionNo ?? null}
                        onChange={() => { void load(); onChanged(); }}
                      />
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
          <div className="flex items-center justify-between border-t border-[var(--border)] px-3 py-2">
            <button type="button" disabled={!selectedCase || results.findIndex((result) => result.caseId === selectedCase) === 0} onClick={() => { const index = results.findIndex((result) => result.caseId === selectedCase); if (index > 0) setSelectedCase(results[index - 1].caseId); }} aria-label="Previous test case" className="rounded p-1 text-[var(--text-muted)] hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)] disabled:opacity-30"><ChevronLeft className="h-4 w-4" /></button>
            <span className="text-[10px] text-[var(--text-muted)]">{results.findIndex((result) => result.caseId === selectedCase) + 1} / {results.length}</span>
            <button type="button" disabled={!selectedCase || results.findIndex((result) => result.caseId === selectedCase) === results.length - 1} onClick={() => { const index = results.findIndex((result) => result.caseId === selectedCase); if (index >= 0 && index < results.length - 1) setSelectedCase(results[index + 1].caseId); }} aria-label="Next test case" className="rounded p-1 text-[var(--text-muted)] hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)] disabled:opacity-30"><ChevronRight className="h-4 w-4" /></button>
          </div>
          {resultCount('Failed') > 0 && <button type="button" onClick={() => setSelectedCase(results.find((result) => String(result.outcome || '') === 'Failed')?.caseId || null)} className="mx-3 mb-2 rounded-md border border-[var(--border)] py-1.5 text-xs font-medium text-[var(--text-primary)] hover:border-[var(--accent)]">Jump to first failed</button>}
          {selectedResult && <div className="border-t border-[var(--border)] overflow-y-auto"><RunSummaryPanel run={run} planName={planName} suiteName={suiteName} result={selectedResult} linkedDefects={defects.filter((d: any) => d.linkedCaseId === selectedResult.caseId)} disabled={!executionEditable} authoringDisabled={!executionEditable} onFieldChange={(patch) => setCaseField(selectedResult.caseId, patch)} /></div>}
        </aside>
        )}

        {/* RIGHT: selected case result detail */}
        <section className="flex min-w-0 flex-1 flex-col overflow-auto">
          {!standalone && isCasePanelMinimized && <div className="border-b border-[var(--border)] px-3 py-2"><button type="button" onClick={() => setIsCasePanelMinimized(false)} className="group inline-flex animate-[pulse_0.35s_ease-out] items-center gap-1.5 rounded px-1 py-1 text-xs font-medium text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)]"><PanelLeftOpen className="h-4 w-4 transition-transform duration-200 group-hover:translate-x-0.5" /> Show test cases</button></div>}
          {!selectedResult ? (
            <div className="p-8 text-sm text-[var(--text-muted)]">Select a test case to view its result.</div>
          ) : (
            <ResultDetail
              key={selectedResult.caseId}
              run={run}
              planName={planName}
              suiteName={suiteName}
              result={selectedResult}
              defects={defects}
              editable={editable}
              busy={busy}
              showImages={showImages}
              onToggleImages={() => setShowImages((v) => !v)}
              onCaseOutcome={(o) => setCaseOutcome(selectedResult.caseId, o)}
              onFieldChange={(patch) => setCaseField(selectedResult.caseId, patch)}
              onStepChange={(i, patch) => setStep(selectedResult.caseId, i, patch)}
              onUploadScreenshot={(i, dataUrl) => uploadShot(selectedResult.caseId, i, dataUrl)}
              onOpenImage={(url) => setLightbox(url)}
              onCreateBug={() => createBug(selectedResult.caseId)}
              onAddStep={() => addStep(selectedResult.caseId)}
              onDeleteStep={(i) => deleteStep(selectedResult.caseId, i)}
              onStart={startRun}
              onStop={stopRun}
              now={now}
            />
          )}
        </section>
      </div>

      {lightbox && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" onClick={() => setLightbox(null)}>
          <img src={withBasePath(lightbox)} alt="Evidence" className="max-h-[90dvh] max-w-full rounded-lg object-contain" onClick={(e) => e.stopPropagation()} />
        </div>
      )}
    </div>
  );
}

function ResultDetail({
  run,
  planName,
  suiteName,
  result,
  defects,
  editable,
  busy,
  showImages,
  onToggleImages,
  onCaseOutcome,
  onFieldChange,
  onStepChange,
  onUploadScreenshot,
  onOpenImage,
  onCreateBug,
  onAddStep,
  onDeleteStep,
  onStart,
  onStop,
  now,
}: {
  run: any;
  planName: string;
  suiteName: string;
  result: any;
  defects: any[];
  editable: boolean;
  busy: boolean;
  showImages: boolean;
  onToggleImages: () => void;
  onCaseOutcome: (o: ManualOutcome) => void;
  onFieldChange: (patch: Record<string, string>) => void;
  onStepChange: (index: number, patch: Partial<StepResult>) => void;
  onUploadScreenshot: (index: number, dataUrl: string) => void;
  onOpenImage: (url: string) => void;
  onCreateBug: () => void;
  onAddStep: () => void;
  onDeleteStep: (index: number) => void;
  onStart: () => void;
  onStop: () => void;
  now: number;
}) {
  const steps: StepResult[] = Array.isArray(result.stepResults) ? result.stepResults : [];
  // Start/Stop is a RUN-level action, so it follows the RUN lifecycle — NOT the selected case's
  // completion. Marking one case Passed must not remove the tester's ability to Stop; the run ends
  // only when the tester clicks Stop.
  const runStopped = [run.status, run.state].some((value) => /^stopped$/i.test(String(value || '')))
    || run.progress === 'Stopped by user';
  const runCancelled = !runStopped && [run.status, run.state].some((value) => /^(cancelled|canceled)$/i.test(String(value || '')));
  const runTerminal = runStopped || runCancelled;
  const runNotStarted = !run.startedAt && !runTerminal;
  const runInProgress = Boolean(run.startedAt) && !run.completedAt && !runTerminal;
  const executionEditable = editable && isManualRunActive(run);
  const resultInProgress = Boolean(result.startedAt) && !result.completedAt;
  // A started-but-unevaluated case reads "In progress", not "Not run".
  const status = runStopped
    ? { Icon: Square, label: 'Stopped', cls: 'text-[var(--text-muted)]' }
    : runCancelled
    ? { Icon: Square, label: 'Cancelled', cls: 'text-[var(--text-muted)]' }
    : resultInProgress && (!result.outcome || result.outcome === 'Not Run')
    ? { Icon: Clock, label: 'In Progress', cls: 'text-amber-500' }
    : resultStatus(result.outcome || 'Not Run');

  return (
    <>
      {/* Result header bar */}
      <div className="sticky top-0 z-10 flex flex-wrap items-center gap-x-6 gap-y-3 border-b border-[var(--border)] bg-[var(--bg-card)] px-5 py-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-[var(--text-primary)]">{result.caseTitle || result.caseId}</div>
          <div className="mt-0.5 font-mono text-[10px] text-[var(--text-muted)]">{result.caseId}</div>
        </div>
        <div className="flex items-center gap-2">
          {/* Start run: a manual run needs no scripts — this just begins the run + duration clock.
              While in progress, Stop finishes it and freezes the duration. */}
          {editable && (runNotStarted || runTerminal) ? (
            <button type="button" disabled={busy} onClick={onStart} className="inline-flex items-center gap-2 rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50">
              <Play className="h-4 w-4" /> {runTerminal ? 'Restart run' : 'Start run'}
            </button>
          ) : (
            <>
              <status.Icon className={`h-6 w-6 ${status.cls}`} />
              <span className={`text-lg font-semibold ${status.cls}`}>{status.label}</span>
              {editable && runInProgress && (
                <button type="button" disabled={busy} onClick={onStop} className="ml-2 inline-flex items-center gap-1.5 rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50">
                  <Square className="h-3.5 w-3.5" /> Stop run
                </button>
              )}
            </>
          )}
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-[var(--text-muted)]">
          <span className="whitespace-nowrap">Start Time <span className="text-[var(--text-primary)]">{run.startedAt ? <Timestamp value={run.startedAt} /> : '—'}</span></span>
          <span className="whitespace-nowrap">Duration <span className="text-[var(--text-primary)]">{formatDuration(run, now)}</span></span>
          <label className="flex shrink-0 items-center gap-2 whitespace-nowrap text-[var(--text-primary)]">
            {/* Self-contained switch: inline-flex track + inline-block knob (no absolute), so the knob
                can't escape and overlap the label. */}
            <button
              type="button"
              role="switch"
              aria-checked={showImages}
              onClick={onToggleImages}
              className={`inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${showImages ? 'bg-[var(--accent)]' : 'bg-[var(--border)]'}`}
            >
              <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${showImages ? 'translate-x-4' : 'translate-x-0.5'}`} />
            </button>
            Show Images
          </label>
          {editable && (
            <button type="button" disabled={busy || !executionEditable} onClick={onCreateBug} className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-[var(--border)] px-3 py-1.5 text-sm font-medium text-[var(--text-primary)] hover:text-red-500 disabled:opacity-50">
              <Bug className="h-4 w-4" /> Create bug
            </button>
          )}
          {runTerminal ? (
            <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2.5 py-1.5 text-sm font-medium ${status.cls}`}>
              <status.Icon className="h-3.5 w-3.5" /> {status.label}
            </span>
          ) : executionEditable && (
            <span className="shrink-0"><OutcomeSelect value={result.outcome || 'Not Run'} onChange={onCaseOutcome} /></span>
          )}
        </div>
      </div>

      {/* Steps */}
      <div className="px-5 pb-6">
        <h3 className="mb-2 text-sm font-semibold">Steps</h3>
        <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-card)]">
          <ManualStepRunner
            steps={steps}
            showImages={showImages}
            disabled={!executionEditable}
            authoringDisabled={!executionEditable}
            onStepChange={onStepChange}
            onUploadScreenshot={onUploadScreenshot}
            onOpenImage={onOpenImage}
            onAddStep={onAddStep}
            onDeleteStep={onDeleteStep}
            now={now}
          />
        </div>
      </div>
    </>
  );
}
