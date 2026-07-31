import { useCallback, useEffect, useMemo, useState } from 'react';
import { Bug, Check, X, Circle, Clock, Play, Square } from 'lucide-react';
import { can } from '@/src/components/AuthGate';
import { withBasePath } from '@/src/lib/base-path';
import { showAlert } from '@/src/lib/dialog';
import { Timestamp } from '@/src/components/Timestamp';
import { MANUAL_OUTCOMES, computeRunRollup, type ManualOutcome } from '@/core/shared/manualRun';
import { OutcomeSelect, OutcomeDot } from './OutcomeSelect';
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

// The large Azure-style result status derived from a case outcome.
function resultStatus(outcome: string) {
  if (outcome === 'Passed') return { Icon: Check, label: 'Test passed', cls: 'text-emerald-500' };
  if (outcome === 'Failed') return { Icon: X, label: 'Test failed', cls: 'text-red-500' };
  if (!outcome || outcome === 'Not Run') return { Icon: Circle, label: 'Not run', cls: 'text-[var(--text-muted)]' };
  return { Icon: Clock, label: 'In progress', cls: 'text-amber-500' };
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
  const [busy, setBusy] = useState(false);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now()); // live clock for the in-progress duration

  const editable = can('runs:execute');
  const caseById = useMemo(() => new Map(cases.map((c) => [c.id, c])), [cases]);
  const planName = plans.find((p) => p.id === run.testPlanId)?.name || '';
  const suiteName = suites.find((s) => s.id === run.suiteId)?.name || run.suiteName || '';
  const rollup = computeRunRollup(results);

  const load = useCallback(async () => {
    setLoading(true);
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
      setLoading(false);
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
    await load();
  });

  // Stop/finish a manual run — freezes the duration and marks it Completed.
  const stopRun = () => run_(async () => {
    await api(`/api/runs/${encodeURIComponent(run.id)}/stop`, {});
    await load();
  });

  const toggleSelect = (caseId: string) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(caseId)) next.delete(caseId); else next.add(caseId);
    return next;
  });
  const allSelected = results.length > 0 && selected.size === results.length;

  const selectedResult = results.find((r) => r.caseId === selectedCase) || null;
  // A case-less manual run authors its own steps: one result keyed to the run itself. No left case list.
  const standalone = results.length === 1 && results[0]?.caseId === run.id;

  if (loading) return <div className="p-8 text-sm text-[var(--text-muted)]">Loading manual run…</div>;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* LEFT: bulk toolbar + test-points list (hidden for a standalone step-authored run) */}
        {!standalone && (
        <aside className="flex w-72 shrink-0 flex-col overflow-hidden border-r border-[var(--border)]">
          {editable && (
            <div className="flex flex-wrap items-center gap-2 border-b border-[var(--border)] px-3 py-2.5">
              <label className="flex items-center gap-1.5 text-xs text-[var(--text-muted)]">
                <input type="checkbox" checked={allSelected} onChange={() => setSelected(allSelected ? new Set() : new Set(results.map((r) => r.caseId)))} />
                {selected.size ? `${selected.size} selected` : 'All'}
              </label>
              <select value={bulkOutcome} onChange={(e) => setBulkOutcome(e.target.value as ManualOutcome)} className="rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1 text-xs outline-none">
                {MANUAL_OUTCOMES.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
              <button type="button" disabled={busy} onClick={bulkSet} className="rounded-md bg-[var(--accent)] px-2.5 py-1 text-xs font-medium text-white hover:bg-[var(--accent-hover)] disabled:opacity-50">
                Apply{selected.size ? ` (${selected.size})` : ' all'}
              </button>
            </div>
          )}
          <div className="border-b border-[var(--border)] px-3 py-2 text-xs text-[var(--text-muted)]">
            <span className="font-medium text-[var(--text-primary)]">{rollup.status}</span> · {rollup.progress}
          </div>
          <ul className="min-h-0 flex-1 overflow-y-auto">
            {results.length === 0 ? (
              <li className="px-4 py-8 text-center text-sm text-[var(--text-muted)]">No test points in this run.</li>
            ) : results.map((result) => {
              const isSelected = result.caseId === selectedCase;
              const title = result.caseTitle || caseById.get(result.caseId)?.title || result.caseId;
              return (
                <li key={result.caseId} className={isSelected ? 'bg-[var(--bg-secondary)]' : ''}>
                  <div className="flex items-center gap-2 px-3 py-2">
                    {editable && <input type="checkbox" checked={selected.has(result.caseId)} onChange={() => toggleSelect(result.caseId)} onClick={(e) => e.stopPropagation()} />}
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
        </aside>
        )}

        {/* RIGHT: selected case result detail */}
        <section className="flex min-w-0 flex-1 flex-col overflow-auto">
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
  const notStarted = !result.startedAt;
  const inProgress = Boolean(result.startedAt) && !result.completedAt;
  // A started-but-unevaluated run reads "In progress", not "Not run".
  const status = inProgress && (!result.outcome || result.outcome === 'Not Run')
    ? { Icon: Clock, label: 'In progress', cls: 'text-amber-500' }
    : resultStatus(result.outcome || 'Not Run');

  return (
    <>
      {/* Result header bar */}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3 border-b border-[var(--border)] px-5 py-3">
        <div className="flex items-center gap-2">
          {/* Start run: a manual run needs no scripts — this just begins the run + duration clock.
              While in progress, Stop finishes it and freezes the duration. */}
          {editable && notStarted ? (
            <button type="button" disabled={busy} onClick={onStart} className="inline-flex items-center gap-2 rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50">
              <Play className="h-4 w-4" /> Start run
            </button>
          ) : (
            <>
              <status.Icon className={`h-6 w-6 ${status.cls}`} />
              <span className={`text-lg font-semibold ${status.cls}`}>{status.label}</span>
              {editable && inProgress && (
                <button type="button" disabled={busy} onClick={onStop} className="ml-2 inline-flex items-center gap-1.5 rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50">
                  <Square className="h-3.5 w-3.5" /> Stop run
                </button>
              )}
            </>
          )}
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-[var(--text-muted)]">
          <span className="whitespace-nowrap">Start time <span className="text-[var(--text-primary)]">{result.startedAt ? <Timestamp value={result.startedAt} /> : '—'}</span></span>
          <span className="whitespace-nowrap">Duration <span className="text-[var(--text-primary)]">{formatDuration(result, now)}</span></span>
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
            Show images
          </label>
          {editable && (
            <button type="button" disabled={busy} onClick={onCreateBug} className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-[var(--border)] px-3 py-1.5 text-sm font-medium text-[var(--text-primary)] hover:text-red-500 disabled:opacity-50">
              <Bug className="h-4 w-4" /> Create bug
            </button>
          )}
          {editable && (
            <span className="shrink-0"><OutcomeSelect value={result.outcome || 'Not Run'} onChange={onCaseOutcome} /></span>
          )}
        </div>
      </div>

      <RunSummaryPanel
        run={run}
        planName={planName}
        suiteName={suiteName}
        result={result}
        linkedDefects={defects.filter((d: any) => d.linkedCaseId === result.caseId)}
        disabled={!editable}
        onFieldChange={onFieldChange}
      />

      {/* Steps */}
      <div className="px-5 pb-6">
        <h3 className="mb-2 text-sm font-semibold">Steps</h3>
        <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-card)]">
          <ManualStepRunner
            steps={steps}
            showImages={showImages}
            disabled={!editable}
            onStepChange={onStepChange}
            onUploadScreenshot={onUploadScreenshot}
            onOpenImage={onOpenImage}
            onAddStep={onAddStep}
            onDeleteStep={onDeleteStep}
          />
        </div>
      </div>
    </>
  );
}
