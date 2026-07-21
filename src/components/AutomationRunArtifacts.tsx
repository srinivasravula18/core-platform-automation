import { useCallback, useEffect, useState } from 'react';
import { Loader2, Download, FileVideo, Image as ImageIcon, FileArchive, FileText } from 'lucide-react';
import { showToast } from '@/src/lib/dialog';
import { useAgentEvents, jobStatusMeta, type Job } from '@/src/lib/useAutomation';

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

export function AutomationRunArtifacts({ jobId }: { jobId: string }) {
  const [job, setJob] = useState<Job | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [showShots, setShowShots] = useState(false);

  const loadJob = useCallback(async () => {
    try { const d = await fetch(`/api/automation/jobs/${jobId}`).then((r) => r.json()); setJob(d?.job || null); } catch { /* keep */ }
  }, [jobId]);
  const loadArtifacts = useCallback(async () => {
    try { const a = await fetch(`/api/automation/jobs/${jobId}/artifacts`).then((r) => r.json()); setArtifacts(Array.isArray(a?.artifacts) ? a.artifacts : []); }
    finally { setLoading(false); }
  }, [jobId]);

  useEffect(() => { setLogs([]); void loadJob(); void loadArtifacts(); }, [loadJob, loadArtifacts]);

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
  const running = ['queued', 'dispatched', 'running', 'uploading'].includes(status);

  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)]/40 px-4 py-4">
      <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-[var(--text-primary)]">
        Execution artifacts
        <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${meta.cls}`}>{meta.label}</span>
      </div>
      <div className="grid gap-2 sm:grid-cols-4">
        <Stat label="Passed" value={(s as any).passed ?? 0} /><Stat label="Failed" value={(s as any).failed ?? 0} />
        <Stat label="Skipped" value={(s as any).skipped ?? 0} /><Stat label="Duration" value={(s as any).durationMs ? `${((s as any).durationMs / 1000).toFixed(1)}s` : '—'} />
      </div>
      {job?.error && <div className="mt-2 rounded-md border border-red-500/30 bg-red-500/10 p-2 text-xs text-red-500">{job.error}</div>}

      {loading ? (
        <div className="mt-3 flex items-center gap-2 text-xs text-[var(--text-muted)]"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading snapshots…</div>
      ) : (
        <>
          {video && previews[video.id] && (
            <div className="mt-3">
              <div className="mb-1 text-xs font-medium text-[var(--text-muted)]">Video (every action)</div>
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
          {artifacts.length === 0 && !logs.length && <div className="mt-3 text-xs text-[var(--text-muted)]">No snapshots yet{running ? ' — run in progress…' : '.'}</div>}
        </>
      )}

      {logs.length > 0 && (
        <div className="mt-3">
          <div className="mb-1 text-xs font-medium text-[var(--text-muted)]">Live logs</div>
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
