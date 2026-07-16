import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Loader2, Ban, FileText, X } from 'lucide-react';
import { showToast } from '@/src/lib/dialog';
import { useRemoteAgentFlag, useJobs, useAgentEvents, jobStatusMeta, type Job } from '@/src/lib/useAutomation';

export default function Executions() {
  const flag = useRemoteAgentFlag();
  const { jobs, loading, refresh } = useJobs();
  const [logJob, setLogJob] = useState<Job | null>(null);
  const [logs, setLogs] = useState<string[]>([]);

  useAgentEvents((evt) => {
    if (evt.scopeType !== 'job') return;
    void refresh();
    if (logJob && evt.scopeId === logJob.id && evt.type === 'job.log' && evt.data.line) {
      setLogs((prev) => [...prev.slice(-499), String(evt.data.line)]);
    }
  });

  const cancel = async (id: string) => {
    try { await fetch(`/api/automation/jobs/${id}/cancel`, { method: 'POST' }); showToast('Cancellation requested.', { tone: 'success' }); void refresh(); }
    catch { showToast('Could not cancel the run.', { tone: 'error' }); }
  };

  const openLogs = (job: Job) => { setLogJob(job); setLogs([]); };

  if (flag === false) return <div className="p-6 text-sm text-[var(--text-muted)]">The local desktop agent feature is not enabled on this server.</div>;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-[var(--text-primary)]">Executions</h1>
        <p className="mt-1 text-sm text-[var(--text-muted)]">Test runs dispatched to your local agents.</p>
      </div>

      <div className="min-w-0 overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--bg-card)]">
        {loading ? (
          <div className="flex items-center gap-2 px-4 py-10 text-sm text-[var(--text-muted)]"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>
        ) : jobs.length === 0 ? (
          <div className="px-4 py-10 text-center text-sm text-[var(--text-muted)]">No executions yet. Run a recording to see it here.</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--border)] text-left text-xs uppercase tracking-wide text-[var(--text-muted)]">
                <th className="px-4 py-2.5 font-medium">Run</th>
                <th className="px-4 py-2.5 font-medium">Trigger</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
                <th className="px-4 py-2.5 font-medium">Result</th>
                <th className="px-4 py-2.5 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((job) => {
                const meta = jobStatusMeta(job.status);
                const running = ['queued', 'dispatched', 'running', 'uploading'].includes(job.status);
                return (
                  <tr key={job.id} className="border-b border-[var(--border)] last:border-0 hover:bg-[var(--bg-secondary)]">
                    <td className="px-4 py-2.5 font-mono text-xs text-[var(--text-muted)]">{job.id}</td>
                    <td className="px-4 py-2.5 text-[var(--text-primary)]">{job.trigger}</td>
                    <td className="px-4 py-2.5"><span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${meta.cls}`}>{meta.label}</span></td>
                    <td className="px-4 py-2.5 text-xs text-[var(--text-muted)]">{job.summary?.passed != null ? `${job.summary.passed} passed · ${job.summary.failed ?? 0} failed` : job.error || '—'}</td>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center justify-end gap-2">
                        <button onClick={() => openLogs(job)} className="inline-flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1 text-xs text-[var(--text-primary)] hover:border-[var(--accent)]" title="Live logs"><FileText className="h-3.5 w-3.5" /></button>
                        <Link to={`/automation/reports/${job.id}`} className="rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1 text-xs text-[var(--text-primary)] hover:border-[var(--accent)]">Report</Link>
                        {running && <button onClick={() => cancel(job.id)} className="inline-flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1 text-xs text-red-400 hover:border-red-500" title="Cancel"><Ban className="h-3.5 w-3.5" /></button>}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {logJob && (
        <div className="min-w-0 overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--bg-card)]">
          <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-2.5">
            <div className="text-sm font-semibold text-[var(--text-primary)]">Live logs · <span className="font-mono text-xs text-[var(--text-muted)]">{logJob.id}</span></div>
            <button onClick={() => setLogJob(null)} className="rounded-md p-1 text-[var(--text-muted)] hover:text-[var(--text-primary)]"><X className="h-4 w-4" /></button>
          </div>
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words bg-slate-950 p-4 font-mono text-xs leading-5 text-slate-200">{logs.length ? logs.join('\n') : 'Waiting for output…'}</pre>
        </div>
      )}
    </div>
  );
}
