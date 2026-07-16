import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Loader2, Download, FileVideo, Image as ImageIcon, FileArchive, FileText, ArrowLeft } from 'lucide-react';
import { showToast } from '@/src/lib/dialog';
import { useRemoteAgentFlag, useJobs, jobStatusMeta, type Job } from '@/src/lib/useAutomation';

interface Artifact { id: string; jobId: string; kind: string; filename: string; size: number; }

async function fetchBlobUrl(jobId: string, id: string): Promise<string> {
  const res = await fetch(`/api/automation/jobs/${jobId}/artifacts/${id}/download`);
  if (!res.ok) throw new Error('download failed');
  return URL.createObjectURL(await res.blob());
}

async function saveArtifact(jobId: string, a: Artifact) {
  try {
    const url = await fetchBlobUrl(jobId, a.id);
    const el = document.createElement('a'); el.href = url; el.download = a.filename; el.click();
    URL.revokeObjectURL(url);
  } catch { showToast('Could not download the artifact.', { tone: 'error' }); }
}

function kindIcon(kind: string) {
  if (kind === 'video') return FileVideo;
  if (kind === 'screenshot') return ImageIcon;
  if (kind === 'trace') return FileArchive;
  return FileText;
}

function ReportDetail({ jobId }: { jobId: string }) {
  const [job, setJob] = useState<Job | null>(null);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const [j, a] = await Promise.all([
          fetch(`/api/automation/jobs/${jobId}`).then((r) => r.json()),
          fetch(`/api/automation/jobs/${jobId}/artifacts`).then((r) => r.json()),
        ]);
        if (!live) return;
        setJob(j?.job || null);
        setArtifacts(Array.isArray(a?.artifacts) ? a.artifacts : []);
      } finally { if (live) setLoading(false); }
    })();
    return () => { live = false; };
  }, [jobId]);

  // Lazily fetch previewable artifacts (video/screenshot) as authenticated blob URLs.
  useEffect(() => {
    let urls: string[] = [];
    (async () => {
      for (const a of artifacts.filter((x) => x.kind === 'video' || x.kind === 'screenshot')) {
        try { const url = await fetchBlobUrl(jobId, a.id); urls.push(url); setPreviews((p) => ({ ...p, [a.id]: url })); } catch { /* skip */ }
      }
    })();
    return () => { urls.forEach((u) => URL.revokeObjectURL(u)); };
  }, [artifacts, jobId]);

  if (loading) return <div className="flex items-center gap-2 p-6 text-sm text-[var(--text-muted)]"><Loader2 className="h-4 w-4 animate-spin" /> Loading report…</div>;
  if (!job) return <div className="p-6 text-sm text-[var(--text-muted)]">Report not found.</div>;

  const meta = jobStatusMeta(job.status);
  const s = job.summary || {};

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div className="flex items-center gap-3">
        <Link to="/automation/executions" className="rounded-md p-1.5 text-[var(--text-muted)] hover:text-[var(--text-primary)]"><ArrowLeft className="h-4 w-4" /></Link>
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-[var(--text-primary)]">Execution report</h1>
          <div className="mt-0.5 font-mono text-xs text-[var(--text-muted)]">{job.id}</div>
        </div>
        <span className={`ml-auto inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium ${meta.cls}`}>{meta.label}</span>
      </div>

      <div className="grid gap-3 sm:grid-cols-4">
        <Stat label="Passed" value={s.passed ?? 0} />
        <Stat label="Failed" value={s.failed ?? 0} />
        <Stat label="Skipped" value={s.skipped ?? 0} />
        <Stat label="Duration" value={s.durationMs ? `${(s.durationMs / 1000).toFixed(1)}s` : '—'} />
      </div>
      {job.error && <div className="rounded-md border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-500">{job.error}</div>}

      <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-card)] p-4">
        <div className="text-sm font-semibold text-[var(--text-primary)]">Artifacts</div>
        {artifacts.length === 0 ? (
          <div className="py-6 text-center text-sm text-[var(--text-muted)]">No artifacts were uploaded for this run.</div>
        ) : (
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {artifacts.map((a) => {
              const Icon = kindIcon(a.kind);
              return (
                <div key={a.id} className="rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] p-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2 text-sm text-[var(--text-primary)]"><Icon className="h-4 w-4 flex-shrink-0 text-[var(--text-muted)]" /><span className="truncate">{a.filename}</span></div>
                    <button onClick={() => saveArtifact(jobId, a)} className="inline-flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--bg-card)] px-2 py-1 text-xs text-[var(--text-primary)] hover:border-[var(--accent)]"><Download className="h-3.5 w-3.5" /></button>
                  </div>
                  {a.kind === 'screenshot' && previews[a.id] && <img src={previews[a.id]} alt={a.filename} className="mt-2 max-h-64 w-full rounded border border-[var(--border)] object-contain" />}
                  {a.kind === 'video' && previews[a.id] && <video src={previews[a.id]} controls className="mt-2 max-h-64 w-full rounded border border-[var(--border)]" />}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-card)] p-3 text-center">
      <div className="text-xl font-semibold text-[var(--text-primary)]">{value}</div>
      <div className="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">{label}</div>
    </div>
  );
}

export default function AutomationReports() {
  const flag = useRemoteAgentFlag();
  const { jobId } = useParams();
  const { jobs, loading } = useJobs();

  if (flag === false) return <div className="p-6 text-sm text-[var(--text-muted)]">The local desktop agent feature is not enabled on this server.</div>;
  if (jobId) return <ReportDetail jobId={jobId} />;

  const finished = jobs.filter((j) => ['done', 'failed', 'cancelled'].includes(j.status));

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-[var(--text-primary)]">Reports</h1>
        <p className="mt-1 text-sm text-[var(--text-muted)]">Completed executions with screenshots, video, and traces.</p>
      </div>
      <div className="min-w-0 overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--bg-card)]">
        {loading ? (
          <div className="flex items-center gap-2 px-4 py-10 text-sm text-[var(--text-muted)]"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>
        ) : finished.length === 0 ? (
          <div className="px-4 py-10 text-center text-sm text-[var(--text-muted)]">No completed runs yet.</div>
        ) : (
          <div className="divide-y divide-[var(--border)]">
            {finished.map((job) => {
              const meta = jobStatusMeta(job.status);
              return (
                <Link key={job.id} to={`/automation/reports/${job.id}`} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm hover:bg-[var(--bg-secondary)]">
                  <span className="truncate font-mono text-xs text-[var(--text-muted)]">{job.id}</span>
                  <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${meta.cls}`}>{meta.label}</span>
                </Link>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
