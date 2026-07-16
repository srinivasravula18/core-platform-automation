import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Modal } from '@/src/components/Modal';
import { showToast } from '@/src/lib/dialog';

/**
 * Schedule a recording to run at an exact date & time (one-shot). Scheduled runs execute on the
 * server headless. Shared by Record Test (summary) and the Executions library.
 */
export function ScheduleRecordingModal({ isOpen, onClose, recordingId }: { isOpen: boolean; onClose: () => void; recordingId: string }) {
  const [runAt, setRunAt] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!recordingId) return;
    if (!runAt) { showToast('Pick a date and time.', { tone: 'error' }); return; }
    setBusy(true);
    try {
      const res = await fetch('/api/automation/schedules', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recordingId, kind: 'once', runAt: new Date(runAt).toISOString() }),
      });
      if (!res.ok) throw new Error((await res.json())?.error);
      showToast(`Scheduled for ${new Date(runAt).toLocaleString()}.`, { tone: 'success' });
      setRunAt('');
      onClose();
    } catch { showToast('Could not create the schedule.', { tone: 'error' }); }
    finally { setBusy(false); }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Schedule this test" size="md"
      footer={<div className="flex justify-end gap-2">
        <button onClick={onClose} className="rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-sm text-[var(--text-primary)]">Cancel</button>
        <button onClick={submit} disabled={busy || !runAt} className="inline-flex items-center gap-2 rounded-md bg-[var(--accent)] px-3 py-2 text-sm font-medium text-white hover:bg-[var(--accent-hover)] disabled:opacity-50">
          {busy && <Loader2 className="h-4 w-4 animate-spin" />} Schedule
        </button>
      </div>}>
      <label className="block text-xs font-medium text-[var(--text-muted)]">
        Run at (date &amp; time)
        <input type="datetime-local" value={runAt} onChange={(e) => setRunAt(e.target.value)}
          className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent)]" />
      </label>
      <p className="mt-3 text-xs text-[var(--text-muted)]">The run executes on the server headless at this time — your local agent does not need to be online.</p>
    </Modal>
  );
}
