import { Loader2, Trash2, CalendarClock } from 'lucide-react';
import { showConfirm, showToast } from '@/src/lib/dialog';
import { useRemoteAgentFlag, useSchedules } from '@/src/lib/useAutomation';

function fmt(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
}

export default function Schedules() {
  const flag = useRemoteAgentFlag();
  const { schedules, loading, refresh } = useSchedules();

  const toggle = async (id: string, enabled: boolean) => {
    try { await fetch(`/api/automation/schedules/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: !enabled }) }); void refresh(); }
    catch { showToast('Could not update the schedule.', { tone: 'error' }); }
  };

  const remove = async (id: string) => {
    if (!(await showConfirm('Delete this schedule?'))) return;
    try { await fetch(`/api/automation/schedules/${id}`, { method: 'DELETE' }); showToast('Schedule deleted.', { tone: 'success' }); void refresh(); }
    catch { showToast('Could not delete the schedule.', { tone: 'error' }); }
  };

  if (flag === false) return <div className="p-6 text-sm text-[var(--text-muted)]">The local desktop agent feature is not enabled on this server.</div>;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-[var(--text-primary)]">Schedules</h1>
        <p className="mt-1 text-sm text-[var(--text-muted)]">Recurring runs dispatched to your agents. Create one from a recording's summary screen.</p>
      </div>

      <div className="min-w-0 overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--bg-card)]">
        {loading ? (
          <div className="flex items-center gap-2 px-4 py-10 text-sm text-[var(--text-muted)]"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>
        ) : schedules.length === 0 ? (
          <div className="flex flex-col items-center px-4 py-12 text-center text-sm text-[var(--text-muted)]">
            <CalendarClock className="mb-3 h-8 w-8 opacity-50" />
            No schedules yet. Record a test, then choose <strong className="mx-1 text-[var(--text-primary)]">Schedule</strong> on the summary screen.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--border)] text-left text-xs uppercase tracking-wide text-[var(--text-muted)]">
                <th className="px-4 py-2.5 font-medium">Recording</th>
                <th className="px-4 py-2.5 font-medium">Frequency</th>
                <th className="px-4 py-2.5 font-medium">Next run</th>
                <th className="px-4 py-2.5 font-medium">Last run</th>
                <th className="px-4 py-2.5 font-medium">Enabled</th>
                <th className="px-4 py-2.5 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {schedules.map((s) => (
                <tr key={s.id} className="border-b border-[var(--border)] last:border-0 hover:bg-[var(--bg-secondary)]">
                  <td className="px-4 py-2.5 font-mono text-xs text-[var(--text-muted)]">{s.recordingId}</td>
                  <td className="px-4 py-2.5 text-[var(--text-primary)]">{s.kind}{s.kind === 'cron' && s.cron ? ` (${s.cron})` : ''}</td>
                  <td className="px-4 py-2.5 text-xs text-[var(--text-muted)]">{fmt(s.nextRunAt)}</td>
                  <td className="px-4 py-2.5 text-xs text-[var(--text-muted)]">{fmt(s.lastRunAt)}</td>
                  <td className="px-4 py-2.5">
                    <button onClick={() => toggle(s.id, s.enabled)} className={`inline-flex h-5 w-9 items-center rounded-full px-0.5 transition-colors ${s.enabled ? 'bg-[var(--accent)]' : 'bg-slate-500/40'}`}>
                      <span className={`h-4 w-4 rounded-full bg-white transition-transform ${s.enabled ? 'translate-x-4' : ''}`} />
                    </button>
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <button onClick={() => remove(s.id)} className="inline-flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1 text-xs text-red-400 hover:border-red-500"><Trash2 className="h-3.5 w-3.5" /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
