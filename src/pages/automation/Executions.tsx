import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Loader2, Ban, Play, CalendarClock, Trash2, Code2, Radio, Download, FileVideo, Image as ImageIcon, FileArchive, FileText, ChevronDown } from 'lucide-react';
import { showConfirm, showToast } from '@/src/lib/dialog';
import { Modal } from '@/src/components/Modal';
import { ScheduleRecordingModal } from '@/src/components/ScheduleRecordingModal';
import { useRemoteAgentFlag, useRecordings, useJobs, useAgents, useAgentEvents, jobStatusMeta, type Job, type Recording } from '@/src/lib/useAutomation';

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

const RECSTATUS = {
  ready: { label: 'Ready', cls: 'bg-emerald-500/15 text-emerald-500 border-emerald-500/30' },
  recording: { label: 'Recording', cls: 'bg-blue-500/15 text-blue-500 border-blue-500/30' },
  draft: { label: 'Draft', cls: 'bg-slate-500/15 text-slate-400 border-slate-500/30' },
} as const;

export default function Executions() {
  const flag = useRemoteAgentFlag();
  const { recordings, loading: recLoading, refresh: refreshRecordings } = useRecordings();
  const { jobs, loading: jobLoading, refresh: refreshJobs } = useJobs();
  const { agents, refresh: refreshAgents } = useAgents();

  const [scheduleFor, setScheduleFor] = useState<string | null>(null);
  const [viewScript, setViewScript] = useState<Recording | null>(null);
  const [openJob, setOpenJob] = useState<string | null>(null);
  const [logs, setLogs] = useState<string[]>([]);

  useAgentEvents((evt) => {
    if (evt.scopeType === 'agent') { void refreshAgents(); return; }
    if (evt.scopeType === 'recording') { void refreshRecordings(); return; }
    if (evt.scopeType === 'job') {
      void refreshJobs();
      if (openJob && evt.scopeId === openJob && evt.type === 'job.log' && evt.data.line) setLogs((p) => [...p.slice(-499), String(evt.data.line)]);
    }
  });

  const connectedAgent = useMemo(() => agents.find((a) => !a.revoked && (a.status === 'online' || a.status === 'busy')), [agents]);

  if (flag === false) return <div className="p-6 text-sm text-[var(--text-muted)]">The local desktop agent feature is not enabled on this server.</div>;

  const runNow = async (recordingId: string) => {
    if (!connectedAgent) { showToast('No connected agent. Start your agent first.', { tone: 'error' }); return; }
    try {
      // Manual runs are headed: a browser window opens on the agent machine so the user can watch.
      const res = await fetch('/api/automation/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ recordingId, agentId: connectedAgent.id, headed: true }) });
      if (!res.ok) throw new Error();
      showToast('Run queued — a browser window will open on the agent machine so you can watch.', { tone: 'success' });
      void refreshJobs();
    } catch { showToast('Could not queue the run.', { tone: 'error' }); }
  };

  const removeRecording = async (id: string, name: string) => {
    if (!(await showConfirm(`Delete recording "${name}"?`))) return;
    try { await fetch(`/api/automation/recordings/${id}`, { method: 'DELETE' }); showToast('Recording deleted.', { tone: 'success' }); void refreshRecordings(); }
    catch { showToast('Could not delete the recording.', { tone: 'error' }); }
  };

  const cancel = async (id: string) => {
    try { await fetch(`/api/automation/jobs/${id}/cancel`, { method: 'POST' }); showToast('Cancellation requested.', { tone: 'success' }); void refreshJobs(); }
    catch { showToast('Could not cancel the run.', { tone: 'error' }); }
  };

  const toggleJob = (id: string) => { setLogs([]); setOpenJob((cur) => (cur === id ? null : id)); };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-[var(--text-primary)]">Executions</h1>
          <p className="mt-1 text-sm text-[var(--text-muted)]">Your recordings and every run, with step snapshots, video, and trace.</p>
        </div>
        <Link to="/automation/record" className="inline-flex items-center gap-2 rounded-md bg-[var(--accent)] px-3 py-2 text-sm font-medium text-white hover:bg-[var(--accent-hover)]">
          <Radio className="h-4 w-4" /> New Recording
        </Link>
      </div>

      {!connectedAgent && (recordings.length > 0 || jobs.length > 0) && (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-600 dark:text-amber-300">
          No agent is connected — start your local agent to run or schedule these recordings.
        </div>
      )}

      {/* Recordings — runnable / schedulable */}
      <div className="min-w-0 overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--bg-card)]">
        <div className="border-b border-[var(--border)] px-4 py-2.5 text-sm font-semibold text-[var(--text-primary)]">Recordings</div>
        {recLoading ? (
          <div className="flex items-center gap-2 px-4 py-8 text-sm text-[var(--text-muted)]"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>
        ) : recordings.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-[var(--text-muted)]">No recordings yet. <Link to="/automation/record" className="text-[var(--accent)] hover:underline">Record one</Link>.</div>
        ) : (
          <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="border-b border-[var(--border)] text-left text-xs uppercase tracking-wide text-[var(--text-muted)]">
              <th className="px-4 py-2 font-medium">Name</th><th className="hidden px-4 py-2 font-medium lg:table-cell">URL</th><th className="hidden px-4 py-2 font-medium sm:table-cell">Browser</th><th className="hidden px-4 py-2 font-medium md:table-cell">Status</th><th className="px-4 py-2 font-medium text-right">Actions</th>
            </tr></thead>
            <tbody>
              {recordings.map((rec) => {
                const st = RECSTATUS[rec.status as keyof typeof RECSTATUS] || RECSTATUS.draft;
                const runnable = rec.status === 'ready' && !!connectedAgent;
                return (
                  <tr key={rec.id} className="border-b border-[var(--border)] last:border-0 hover:bg-[var(--bg-secondary)]">
                    <td className="max-w-[16rem] truncate px-4 py-2 font-medium text-[var(--text-primary)]" title={rec.name}>{rec.name}</td>
                    <td className="hidden max-w-[14rem] truncate px-4 py-2 text-xs text-[var(--text-muted)] lg:table-cell" title={rec.appUrl}>{rec.appUrl}</td>
                    <td className="hidden px-4 py-2 text-[var(--text-primary)] sm:table-cell">{rec.browser}</td>
                    <td className="hidden px-4 py-2 md:table-cell"><span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${st.cls}`}>{st.label}</span></td>
                    <td className="px-4 py-2">
                      <div className="flex items-center justify-end gap-1.5 whitespace-nowrap">
                        <button onClick={() => setViewScript(rec)} title="View script" className="rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1 text-xs text-[var(--text-primary)] hover:border-[var(--accent)]"><Code2 className="h-3.5 w-3.5" /></button>
                        <button onClick={() => runNow(rec.id)} disabled={!runnable} title={runnable ? 'Run now — a browser opens on the agent machine so you can watch' : 'Recording must be ready and an agent connected'} className="inline-flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1 text-xs text-[var(--text-primary)] hover:border-[var(--accent)] disabled:opacity-40"><Play className="h-3.5 w-3.5" /> Run</button>
                        <button onClick={() => setScheduleFor(rec.id)} disabled={!connectedAgent} title={connectedAgent ? 'Schedule' : 'Connect an agent first'} className="inline-flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1 text-xs text-[var(--text-primary)] hover:border-[var(--accent)] disabled:opacity-40"><CalendarClock className="h-3.5 w-3.5" /> Schedule</button>
                        <button onClick={() => removeRecording(rec.id, rec.name)} title="Delete" className="rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1 text-xs text-red-400 hover:border-red-500"><Trash2 className="h-3.5 w-3.5" /></button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        )}
      </div>

      {/* Runs — with expandable snapshot/artifact detail */}
      <div className="min-w-0 overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--bg-card)]">
        <div className="border-b border-[var(--border)] px-4 py-2.5 text-sm font-semibold text-[var(--text-primary)]">Runs</div>
        {jobLoading ? (
          <div className="flex items-center gap-2 px-4 py-8 text-sm text-[var(--text-muted)]"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>
        ) : jobs.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-[var(--text-muted)]">No runs yet. Run a recording above to see it here.</div>
        ) : (
          <div className="divide-y divide-[var(--border)]">
            {jobs.map((job) => {
              const meta = jobStatusMeta(job.status);
              const running = ['queued', 'dispatched', 'running', 'uploading'].includes(job.status);
              const isOpen = openJob === job.id;
              return (
                <div key={job.id}>
                  <div className="flex items-center gap-3 px-4 py-2.5 text-sm hover:bg-[var(--bg-secondary)]">
                    <button onClick={() => toggleJob(job.id)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
                      <ChevronDown className={`h-4 w-4 flex-shrink-0 text-[var(--text-muted)] transition-transform ${isOpen ? '' : '-rotate-90'}`} />
                      <span className="truncate font-mono text-xs text-[var(--text-muted)]">{job.id}</span>
                      <span className="text-xs text-[var(--text-muted)]">· {job.trigger}</span>
                    </button>
                    <span className="text-xs text-[var(--text-muted)]">{job.summary?.passed != null ? `${job.summary.passed}✓ ${job.summary.failed ?? 0}✗` : ''}</span>
                    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${meta.cls}`}>{meta.label}</span>
                    {running && <button onClick={() => cancel(job.id)} title="Cancel" className="rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1 text-xs text-red-400 hover:border-red-500"><Ban className="h-3.5 w-3.5" /></button>}
                  </div>
                  {isOpen && <RunDetail job={job} logs={logs} />}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <ScheduleRecordingModal isOpen={!!scheduleFor} onClose={() => setScheduleFor(null)} recordingId={scheduleFor || ''} />
      <Modal isOpen={!!viewScript} onClose={() => setViewScript(null)} title={viewScript?.name || 'Recording'} size="xl">
        <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words rounded bg-slate-950 p-4 font-mono text-xs leading-5 text-slate-200"><code>{viewScript?.script || 'No script captured.'}</code></pre>
      </Modal>
    </div>
  );
}

function kindIcon(kind: string) {
  if (kind === 'video') return FileVideo;
  if (kind === 'screenshot') return ImageIcon;
  if (kind === 'trace') return FileArchive;
  return FileText;
}

function RunDetail({ job, logs }: { job: Job; logs: string[] }) {
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [showShots, setShowShots] = useState(false);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const a = await fetch(`/api/automation/jobs/${job.id}/artifacts`).then((r) => r.json());
        if (live) setArtifacts(Array.isArray(a?.artifacts) ? a.artifacts : []);
      } finally { if (live) setLoading(false); }
    })();
    return () => { live = false; };
  }, [job.id, job.status]);

  useEffect(() => {
    let urls: string[] = [];
    (async () => {
      for (const a of artifacts.filter((x) => x.kind === 'video' || x.kind === 'screenshot')) {
        try { const url = await fetchBlobUrl(job.id, a.id); urls.push(url); setPreviews((p) => ({ ...p, [a.id]: url })); } catch { /* skip */ }
      }
    })();
    return () => { urls.forEach((u) => URL.revokeObjectURL(u)); };
  }, [artifacts, job.id]);

  const s = job.summary || {};
  const screenshots = artifacts.filter((a) => a.kind === 'screenshot');
  const video = artifacts.find((a) => a.kind === 'video');
  const others = artifacts.filter((a) => a.kind !== 'screenshot' && a.kind !== 'video');

  return (
    <div className="border-t border-[var(--border)] bg-[var(--bg-secondary)]/40 px-4 py-4">
      <div className="grid gap-2 sm:grid-cols-4">
        <Stat label="Passed" value={s.passed ?? 0} /><Stat label="Failed" value={s.failed ?? 0} />
        <Stat label="Skipped" value={s.skipped ?? 0} /><Stat label="Duration" value={s.durationMs ? `${(s.durationMs / 1000).toFixed(1)}s` : '—'} />
      </div>
      {job.error && <div className="mt-2 rounded-md border border-red-500/30 bg-red-500/10 p-2 text-xs text-red-500">{job.error}</div>}

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
          {(others.length > 0) && (
            <div className="mt-3 flex flex-wrap gap-2">
              {others.map((a) => { const Icon = kindIcon(a.kind); return (
                <button key={a.id} onClick={() => saveArtifact(job.id, a)} className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--bg-card)] px-2.5 py-1.5 text-xs text-[var(--text-primary)] hover:border-[var(--accent)]"><Icon className="h-3.5 w-3.5" /> {a.filename} <Download className="h-3 w-3" /></button>
              ); })}
            </div>
          )}
          {artifacts.length === 0 && !logs.length && <div className="mt-3 text-xs text-[var(--text-muted)]">No snapshots yet{['queued', 'dispatched', 'running', 'uploading'].includes(job.status) ? ' — run in progress…' : '.'}</div>}
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
