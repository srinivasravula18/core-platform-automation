import { useCallback, useEffect, useState } from 'react';
import { Loader2, Download, FileVideo, Image as ImageIcon, FileArchive, FileText, Copy } from 'lucide-react';
import { showToast } from '@/src/lib/dialog';
import { useAgentEvents, useJobPauses, jobStatusMeta, type Job } from '@/src/lib/useAutomation';
import { automationProgressPercent, type ExecutionStepProgress } from '@/core/shared/automationProgress';

/**
 * Execution artifacts for one automation job — video, step screenshots, trace/JUnit/log downloads,
 * and live logs — served by the agent job engine. Self-contained: given a jobId it fetches the job,
 * its artifacts, and streams live logs, so both the Automation Executions page and Test Runs detail
 * render the same panel. Artifacts stream from /api/automation/jobs/:id/artifacts/:id/download.
 */
interface Artifact { id: string; jobId: string; kind: string; filename: string; size: number; }

async function fetchBlobUrl(jobId: string, id: string): Promise<string> {
  const res = await fetch(`/api/automation/jobs/${jobId}/artifacts/${id}/download`);
  if (!res.ok) throw new Error('download failed');
  return URL.createObjectURL(await res.blob());
}

async function saveArtifact(jobId: string, a: Artifact) {
  try {
    const url = await fetchBlobUrl(jobId, a.id);
    // Keep the link in the DOM through the click and defer revoke — revoking synchronously aborts
    // the download in some browsers (why the buttons appeared to "do nothing").
    const el = document.createElement('a');
    el.href = url; el.download = a.filename; el.rel = 'noopener';
    document.body.appendChild(el); el.click(); el.remove();
    setTimeout(() => URL.revokeObjectURL(url), 15000);
  } catch { showToast('Could not download the artifact.', { tone: 'error' }); }
}

function kindIcon(kind: string) {
  if (kind === 'video') return FileVideo;
  if (kind === 'screenshot') return ImageIcon;
  if (kind === 'trace') return FileArchive;
  return FileText;
}

function duration(ms: number): string {
  if (!ms || ms < 0) return '--';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function stepTone(status: ExecutionStepProgress['status']): string {
  if (status === 'Passed') return 'text-emerald-400';
  if (status === 'Failed') return 'text-red-400';
  if (status === 'Skipped') return 'text-slate-400';
  return 'text-blue-400';
}

export function AutomationRunArtifacts({ jobId, videoOnly = false, runSummary, runDuration }: { jobId: string; videoOnly?: boolean; runSummary?: { passed: number; failed: number; skipped: number; blocked: number; retest: number; untested: number }; runDuration?: string }) {
  const [job, setJob] = useState<Job | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [showShots, setShowShots] = useState(false);
  const [clock, setClock] = useState(() => Date.now());
  const { pauses } = useJobPauses(jobId);

  const loadJob = useCallback(async () => {
    try { const d = await fetch(`/api/automation/jobs/${jobId}`).then((r) => r.json()); setJob(d?.job || null); } catch { /* keep */ }
  }, [jobId]);
  const loadArtifacts = useCallback(async () => {
    try { const a = await fetch(`/api/automation/jobs/${jobId}/artifacts`).then((r) => r.json()); setArtifacts(Array.isArray(a?.artifacts) ? a.artifacts : []); }
    finally { setLoading(false); }
  }, [jobId]);

  useEffect(() => { setLogs([]); void loadJob(); void loadArtifacts(); }, [loadJob, loadArtifacts]);

  // SSE can be missed while a tab is hidden or reconnecting; poll until the durable job is terminal.
  useEffect(() => {
    if (job && !['queued', 'dispatched', 'running', 'awaiting_user', 'uploading'].includes(job.status)) return;
    const timer = window.setInterval(() => { void loadJob(); void loadArtifacts(); }, 2000);
    return () => window.clearInterval(timer);
  }, [job?.status, loadJob, loadArtifacts]);

  useAgentEvents((evt) => {
    if (evt.scopeType !== 'job' || evt.scopeId !== jobId) return;
    void loadJob();
    if (evt.type === 'job.log' && evt.data.line) setLogs((p) => [...p.slice(-499), String(evt.data.line)]);
    if (evt.type === 'job.uploading' || evt.type === 'job.done') void loadArtifacts();
  });

  useEffect(() => {
    let urls: string[] = [];
    (async () => {
      for (const a of artifacts.filter((x) => x.kind === 'video' || x.kind === 'screenshot')) {
        try { const url = await fetchBlobUrl(jobId, a.id); urls.push(url); setPreviews((p) => ({ ...p, [a.id]: url })); } catch { /* skip */ }
      }
    })();
    return () => { urls.forEach((u) => URL.revokeObjectURL(u)); };
  }, [artifacts, jobId]);

  const s = job?.summary || {};
  const status = job?.status || 'queued';
  const meta = jobStatusMeta(status);
  const screenshots = artifacts.filter((a) => a.kind === 'screenshot');
  const video = artifacts.find((a) => a.kind === 'video');
  const others = artifacts.filter((a) => a.kind !== 'screenshot' && a.kind !== 'video');
  const running = ['queued', 'dispatched', 'running', 'awaiting_user', 'uploading'].includes(status);
  const steps = (Array.isArray((s as any).executionSteps) ? (s as any).executionSteps : []) as ExecutionStepProgress[];
  const currentStep = steps.find((step) => step.status === 'Running');
  const completedSteps = steps.filter((step) => step.status !== 'Running').length;
  const stepTotal = Math.max(Number((s as any).stepTotal) || 0, steps.length);
  const elapsedMs = job?.startedAt ? Math.max(0, (job.finishedAt ? Date.parse(job.finishedAt) : clock) - Date.parse(job.startedAt)) : 0;
  const progress = automationProgressPercent(status === 'awaiting_user' ? 'running' : status, Number((s as any).stepCompleted) || completedSteps, stepTotal, String((s as any).event || ''));

  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setClock(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [running]);

  if (videoOnly) {
    return video && previews[video.id]
      ? <video src={previews[video.id]} controls className="max-h-[70vh] w-full rounded border border-[var(--border)] bg-black" />
      : <div className="flex min-h-32 items-center justify-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] p-4 text-sm text-[var(--text-muted)]"><Loader2 className="h-4 w-4 animate-spin" /> Generating video preview…</div>;
  }

  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)]/40 px-4 py-4">
      <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-[var(--text-primary)]">
        Execution Artifacts
        <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${meta.cls}`}>{meta.label}</span>
      </div>
      <div className="grid gap-2 grid-cols-2 sm:grid-cols-4 xl:grid-cols-7">
        <Stat label="Passed" value={runSummary?.passed ?? (s as any).passed ?? 0} />
        <Stat label="Failed" value={runSummary?.failed ?? (s as any).failed ?? 0} />
        <Stat label="Skipped" value={runSummary?.skipped ?? (s as any).skipped ?? 0} />
        <Stat label="Blocked" value={runSummary?.blocked ?? 0} />
        <Stat label="Retest" value={runSummary?.retest ?? 0} />
        <Stat label="Untested" value={runSummary?.untested ?? 0} />
        <Stat label="Duration" value={runDuration || duration(Number((s as any).durationMs) || elapsedMs)} />
      </div>
      {(running || steps.length > 0) && (
        <div className="mt-3 rounded-md border border-[var(--border)] bg-[var(--bg-card)] p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-sm font-semibold text-[var(--text-primary)]">Execution Progress</div>
            <div className="text-xs text-[var(--text-muted)]">
              Step {Math.min(completedSteps + (currentStep ? 1 : 0), stepTotal || 0)} of {stepTotal || '?'} | Elapsed {duration(elapsedMs)}
            </div>
          </div>
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-[var(--bg-secondary)]" role="progressbar" aria-label="Execution progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}>
            <div className="h-full rounded-full bg-blue-500 transition-[width] duration-300" style={{ width: `${progress}%` }} />
          </div>
          <div className="mt-1 text-right text-xs font-medium text-[var(--text-muted)]">{progress}%</div>

          {currentStep && (
            <div className="mt-2 rounded border border-blue-500/30 bg-blue-500/10 px-3 py-2 text-xs text-[var(--text-primary)]">
              Current activity: {currentStep.title} <span className="text-[var(--text-muted)]">({duration(clock - currentStep.startedAt)})</span>
            </div>
          )}

          {steps.length > 0 && (
            <div className="mt-3 overflow-x-auto rounded border border-[var(--border)]">
              <table className="w-full min-w-[34rem] text-left text-xs">
                <thead className="bg-[var(--bg-secondary)] text-[var(--text-muted)]">
                  <tr><th className="px-3 py-2">#</th><th className="px-3 py-2">Playwright Step</th><th className="px-3 py-2">Status</th><th className="px-3 py-2 text-right">Time</th></tr>
                </thead>
                <tbody className="divide-y divide-[var(--border)]">
                  {steps.map((step) => (
                    <tr key={step.id}>
                      <td className="px-3 py-2 text-[var(--text-muted)]">{step.index}</td>
                      <td className="max-w-xl px-3 py-2 text-[var(--text-primary)]">
                        <div className="break-words">{step.title}</div>
                        {step.error && <div className="mt-1 break-words text-red-400">{step.error}</div>}
                      </td>
                      <td className={`px-3 py-2 font-medium ${stepTone(step.status)}`}>{step.status}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-[var(--text-muted)]">{duration(step.status === 'Running' ? clock - step.startedAt : step.durationMs)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="mt-3 flex flex-wrap gap-2 text-[11px]">
            {[
              ['Preparing', status === 'queued' || status === 'dispatched' ? 'RUN' : 'DONE'],
              ['Browser started', currentStep || completedSteps ? 'DONE' : running ? 'WAIT' : 'DONE'],
              ['Executing steps', currentStep ? 'RUN' : completedSteps && running ? 'RUN' : completedSteps ? 'DONE' : 'WAIT'],
              ['Uploading evidence', status === 'uploading' ? 'RUN' : running ? 'WAIT' : 'DONE'],
              ['Finalizing results', running ? 'WAIT' : 'DONE'],
            ].map(([label, state]) => (
              <span key={label} className="rounded border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1 text-[var(--text-muted)]">[{state}] {label}</span>
            ))}
          </div>
        </div>
      )}
      {job?.error && <div className="mt-2 whitespace-pre-wrap rounded-md border border-red-500/30 bg-red-500/10 p-2 text-xs text-red-500">{job.error}</div>}

      {pauses.length > 0 && (
        <div className="mt-3 overflow-x-auto rounded border border-[var(--border)]">
          <table className="w-full min-w-[34rem] text-left text-xs">
            <thead className="bg-[var(--bg-secondary)] text-[var(--text-muted)]"><tr><th className="px-3 py-2">Assistance</th><th className="px-3 py-2">Outcome</th><th className="px-3 py-2">Resolved by</th><th className="px-3 py-2 text-right">Time</th></tr></thead>
            <tbody className="divide-y divide-[var(--border)]">{pauses.map((pause) => (
              <tr key={`${pause.pauseId}:${pause.attempt}`}><td className="px-3 py-2 text-[var(--text-primary)]">{pause.prompt}</td><td className="px-3 py-2 capitalize text-[var(--text-muted)]">{pause.outcome === 'open' ? 'Waiting' : pause.outcome}</td><td className="px-3 py-2 text-[var(--text-muted)]">{pause.resolvedBy || '—'}</td><td className="px-3 py-2 text-right tabular-nums text-[var(--text-muted)]">{duration(Math.max(0, Date.parse(pause.resolvedAt || new Date(clock).toISOString()) - Date.parse(pause.openedAt)))}</td></tr>
            ))}</tbody>
          </table>
        </div>
      )}

      {loading ? (
        <div className="mt-3 flex items-center gap-2 text-xs text-[var(--text-muted)]"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading snapshots…</div>
      ) : (
        <>
          {video && previews[video.id] && (
            <div className="mt-3">
              <div className="mb-1 text-xs font-medium text-[var(--text-muted)]">Video (Every Action)</div>
              <video src={previews[video.id]} controls className="max-h-72 w-full rounded border border-[var(--border)]" />
            </div>
          )}
          {screenshots.length > 0 && (
            <div className="mt-3">
              <button onClick={() => setShowShots((v) => !v)} className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--bg-card)] px-2.5 py-1.5 text-xs font-medium text-[var(--text-primary)] hover:border-[var(--accent)]">
                <ImageIcon className="h-3.5 w-3.5" /> {showShots ? 'Hide' : 'Show'} step snapshots ({screenshots.length})
              </button>
              {showShots && (
                <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
                  {screenshots.map((a) => previews[a.id] && <img key={a.id} src={previews[a.id]} alt={a.filename} className="max-h-48 w-full rounded border border-[var(--border)] object-contain" />)}
                </div>
              )}
            </div>
          )}
          {others.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {others.map((a) => { const Icon = kindIcon(a.kind); return (
                <button key={a.id} onClick={() => saveArtifact(jobId, a)} className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--bg-card)] px-2.5 py-1.5 text-xs text-[var(--text-primary)] hover:border-[var(--accent)]"><Icon className="h-3.5 w-3.5" /> {a.filename} <Download className="h-3 w-3" /></button>
              ); })}
            </div>
          )}
          {artifacts.length === 0 && !logs.length && <div className="mt-3 text-xs text-[var(--text-muted)]">No Snapshots Yet{running ? ' — run in progress…' : '.'}</div>}
        </>
      )}

      {logs.length > 0 && (
        <div className="mt-3">
          <div className="mb-1 flex items-center justify-between gap-2">
            <div className="text-xs font-medium text-[var(--text-muted)]">Live Logs</div>
            <button
              type="button"
              onClick={() => navigator.clipboard.writeText(logs.join('\n'))
                .then(() => showToast('Logs copied.'))
                .catch(() => showToast('Could not copy the logs.', { tone: 'error' }))}
              className="inline-flex items-center gap-1 rounded border border-[var(--border)] bg-[var(--bg-card)] px-2 py-1 text-xs font-medium text-[var(--text-muted)] hover:border-[var(--accent)] hover:text-[var(--text-primary)]"
            >
              <Copy className="h-3.5 w-3.5" /> Copy Logs
            </button>
          </div>
          <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded bg-slate-950 p-3 font-mono text-xs leading-5 text-slate-200">{logs.join('\n')}</pre>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-md border border-[var(--border)] bg-[var(--bg-card)] p-2 text-center">
      <div className="text-lg font-semibold text-[var(--text-primary)]">{value}</div>
      <div className="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">{label}</div>
    </div>
  );
}
