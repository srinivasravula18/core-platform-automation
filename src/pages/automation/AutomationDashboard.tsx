import { useMemo } from 'react';
import type { ElementType } from 'react';
import { Link } from 'react-router-dom';
import { HardDrive, Radio, PlayCircle, CalendarClock, CheckCircle2, XCircle } from 'lucide-react';
import { useRemoteAgentFlag, useAgents, useJobs, useRecordings, useSchedules, useAgentEvents, jobStatusMeta } from '@/src/lib/useAutomation';

function Metric({ icon: Icon, label, value, to }: { icon: ElementType; label: string; value: number | string; to: string }) {
  return (
    <Link to={to} className="rounded-lg border border-[var(--border)] bg-[var(--bg-card)] p-4 transition-colors hover:border-[var(--accent)]">
      <div className="flex items-center gap-2 text-[var(--text-muted)]"><Icon className="h-4 w-4" /><span className="text-xs font-medium uppercase tracking-wide">{label}</span></div>
      <div className="mt-2 text-2xl font-semibold text-[var(--text-primary)]">{value}</div>
    </Link>
  );
}

export default function AutomationDashboard() {
  const flag = useRemoteAgentFlag();
  const { agents, refresh: refreshAgents } = useAgents();
  const { jobs, refresh: refreshJobs } = useJobs();
  const { recordings } = useRecordings();
  const { schedules } = useSchedules();

  useAgentEvents((evt) => { if (evt.scopeType === 'agent') void refreshAgents(); if (evt.scopeType === 'job') void refreshJobs(); });

  const onlineAgents = agents.filter((a) => !a.revoked && (a.status === 'online' || a.status === 'busy')).length;
  const recent = useMemo(() => jobs.slice(0, 8), [jobs]);
  const passed = jobs.filter((j) => j.status === 'done').length;
  const failed = jobs.filter((j) => j.status === 'failed').length;

  if (flag === false) return <div className="p-6 text-sm text-[var(--text-muted)]">The local desktop agent feature is not enabled on this server.</div>;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-[var(--text-primary)]">Automation</h1>
        <p className="mt-1 text-sm text-[var(--text-muted)]">Record, schedule, and run Playwright tests on your local agents.</p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Metric icon={HardDrive} label="Agents online" value={onlineAgents} to="/automation/agent" />
        <Metric icon={Radio} label="Recordings" value={recordings.length} to="/automation/record" />
        <Metric icon={CalendarClock} label="Schedules" value={schedules.filter((s) => s.enabled).length} to="/automation/schedules" />
        <Metric icon={PlayCircle} label="Executions" value={jobs.length} to="/automation/executions" />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-card)] p-4">
          <div className="flex items-center gap-2 text-sm text-emerald-500"><CheckCircle2 className="h-4 w-4" /> Passed</div>
          <div className="mt-1 text-2xl font-semibold text-[var(--text-primary)]">{passed}</div>
        </div>
        <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-card)] p-4">
          <div className="flex items-center gap-2 text-sm text-red-500"><XCircle className="h-4 w-4" /> Failed</div>
          <div className="mt-1 text-2xl font-semibold text-[var(--text-primary)]">{failed}</div>
        </div>
      </div>

      <div className="min-w-0 overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--bg-card)]">
        <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
          <div className="text-sm font-semibold text-[var(--text-primary)]">Recent executions</div>
          <Link to="/automation/executions" className="text-xs text-[var(--accent)] hover:underline">View all</Link>
        </div>
        {recent.length === 0 ? (
          <div className="px-4 py-10 text-center text-sm text-[var(--text-muted)]">No executions yet.</div>
        ) : (
          <div className="divide-y divide-[var(--border)]">
            {recent.map((job) => {
              const meta = jobStatusMeta(job.status);
              return (
                <Link key={job.id} to="/automation/executions" className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm hover:bg-[var(--bg-secondary)]">
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
