import { useMemo, useState } from 'react';
import { Loader2, Trash2, CalendarClock, Plus } from 'lucide-react';
import { showConfirm, showToast } from '@/src/lib/dialog';
import { Modal } from '@/src/components/Modal';
import { useRemoteAgentFlag, useSchedules, useRecordings } from '@/src/lib/useAutomation';

function fmt(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
}

export default function Schedules() {
  const flag = useRemoteAgentFlag();
  const { schedules, loading, refresh } = useSchedules();
  const { recordings } = useRecordings();
  const [createOpen, setCreateOpen] = useState(false);

  const nameFor = useMemo(() => {
    const m = new Map(recordings.map((r) => [r.id, r.name] as const));
    return (id: string) => m.get(id) || id;
  }, [recordings]);

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
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-[var(--text-primary)]">Schedules</h1>
          <p className="mt-1 text-sm text-[var(--text-muted)]">Pick recordings and a date &amp; time — they run on the server headless, no agent needed.</p>
        </div>
        <button onClick={() => setCreateOpen(true)} className="inline-flex items-center gap-2 rounded-md bg-[var(--accent)] px-3 py-2 text-sm font-medium text-white hover:bg-[var(--accent-hover)]">
          <Plus className="h-4 w-4" /> New Schedule
        </button>
      </div>

      <div className="min-w-0 overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--bg-card)]">
        {loading ? (
          <div className="flex items-center gap-2 px-4 py-10 text-sm text-[var(--text-muted)]"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>
        ) : schedules.length === 0 ? (
          <div className="flex flex-col items-center px-4 py-12 text-center text-sm text-[var(--text-muted)]">
            <CalendarClock className="mb-3 h-8 w-8 opacity-50" />
            No schedules yet. Click <strong className="mx-1 text-[var(--text-primary)]">New Schedule</strong> to pick recordings and a run time.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--border)] text-left text-xs uppercase tracking-wide text-[var(--text-muted)]">
                <th className="px-4 py-2.5 font-medium">Recording</th>
                <th className="px-4 py-2.5 font-medium">Runs at</th>
                <th className="px-4 py-2.5 font-medium">Last run</th>
                <th className="px-4 py-2.5 font-medium">Enabled</th>
                <th className="px-4 py-2.5 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {schedules.map((s) => (
                <tr key={s.id} className="border-b border-[var(--border)] last:border-0 hover:bg-[var(--bg-secondary)]">
                  <td className="px-4 py-2.5 font-medium text-[var(--text-primary)]">{nameFor(s.recordingId)}</td>
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

      <NewScheduleModal isOpen={createOpen} onClose={() => setCreateOpen(false)} onCreated={refresh} />
    </div>
  );
}

function NewScheduleModal({ isOpen, onClose, onCreated }: { isOpen: boolean; onClose: () => void; onCreated: () => void }) {
  const { recordings } = useRecordings();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [runAt, setRunAt] = useState('');
  const [busy, setBusy] = useState(false);

  const ready = recordings.filter((r) => r.status === 'ready');
  const toggle = (id: string) => setSelected((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const submit = async () => {
    if (selected.size === 0) { showToast('Select at least one recording.', { tone: 'error' }); return; }
    if (!runAt) { showToast('Pick a date and time.', { tone: 'error' }); return; }
    setBusy(true);
    try {
      const iso = new Date(runAt).toISOString();
      const results = await Promise.all([...selected].map((recordingId) =>
        fetch('/api/automation/schedules', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ recordingId, kind: 'once', runAt: iso }) }).then((r) => r.ok),
      ));
      const ok = results.filter(Boolean).length;
      if (ok === 0) throw new Error();
      showToast(`Scheduled ${ok} recording${ok > 1 ? 's' : ''} for ${new Date(runAt).toLocaleString()}.`, { tone: 'success' });
      setSelected(new Set()); setRunAt('');
      onCreated();
      onClose();
    } catch { showToast('Could not create the schedule.', { tone: 'error' }); }
    finally { setBusy(false); }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="New schedule" size="md"
      footer={<div className="flex justify-end gap-2">
        <button onClick={onClose} className="rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-sm text-[var(--text-primary)]">Cancel</button>
        <button onClick={submit} disabled={busy || selected.size === 0 || !runAt} className="inline-flex items-center gap-2 rounded-md bg-[var(--accent)] px-3 py-2 text-sm font-medium text-white hover:bg-[var(--accent-hover)] disabled:opacity-50">
          {busy && <Loader2 className="h-4 w-4 animate-spin" />} Create Schedule
        </button>
      </div>}>
      <div className="text-xs font-medium text-[var(--text-muted)]">Recordings ({selected.size} selected)</div>
      {ready.length === 0 ? (
        <p className="mt-2 text-sm text-[var(--text-muted)]">No ready recordings yet. Record a test first.</p>
      ) : (
        <div className="mt-1 max-h-56 overflow-auto rounded-md border border-[var(--border)]">
          {ready.map((r) => (
            <label key={r.id} className="flex cursor-pointer items-center gap-3 border-b border-[var(--border)] px-3 py-2 text-sm last:border-0 hover:bg-[var(--bg-secondary)]">
              <input type="checkbox" checked={selected.has(r.id)} onChange={() => toggle(r.id)} className="h-4 w-4 accent-[var(--accent)]" />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium text-[var(--text-primary)]">{r.name}</span>
                <span className="block truncate text-xs text-[var(--text-muted)]">{r.appUrl} · {r.browser}</span>
              </span>
            </label>
          ))}
        </div>
      )}
      <label className="mt-4 block text-xs font-medium text-[var(--text-muted)]">
        Run at (date &amp; time)
        <input type="datetime-local" value={runAt} onChange={(e) => setRunAt(e.target.value)}
          className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent)]" />
      </label>
      <p className="mt-3 text-xs text-[var(--text-muted)]">Selected recordings run on the server headless at this time. Step snapshots and video appear under Executions.</p>
    </Modal>
  );
}
