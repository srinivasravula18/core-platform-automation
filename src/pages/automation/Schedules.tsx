import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { ChevronDown, Code2, Info, Loader2, Search, Trash2, CalendarClock, Plus, Pencil, Eye } from 'lucide-react';
import { showConfirm, showToast } from '@/src/lib/dialog';
import { Modal } from '@/src/components/Modal';
import { RequiredMark } from '@/src/components/RequiredMark';
import { AutomationRunArtifacts } from '@/src/components/AutomationRunArtifacts';
import { useRemoteAgentFlag, useSchedules, useRecordings, useJobs, useAgentEvents, jobStatusMeta, ACTIVE_JOB_STATUSES, type Schedule, type Job } from '@/src/lib/useAutomation';
import { casesForPlan, casesForSuite } from '@/src/lib/manualTestRun';
import { nextSort, sortRows, SortableHeader, type SortState } from '@/src/components/DataTable/sortable';

function fmt(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
}

type ScheduleTab = 'daily' | 'weekly' | 'monthly' | 'once' | 'cron';

const SCHEDULE_TABS: Array<{ id: ScheduleTab; label: string }> = [
  { id: 'daily', label: 'Daily' },
  { id: 'weekly', label: 'Weekly' },
  { id: 'monthly', label: 'Monthly' },
  { id: 'once', label: 'Specific Date' },
  { id: 'cron', label: 'Cron' },
];

// One representative IANA zone for every standard UTC offset in real-world use — the ~38-40 distinct
// whole/half/45-minute offsets that exist once local borders are accounted for (not the naive "24
// zones, one per 15° of longitude" count) — rather than the full ~400-zone database. The custom
// TimezoneSelect below has a real search box, so this can be exhaustive on offsets without becoming
// unscannable. The visitor's own detected zone is always added on top regardless of this list.
const COMMON_TIMEZONES = [
  'Pacific/Pago_Pago', 'Pacific/Honolulu', 'Pacific/Marquesas', 'America/Anchorage', 'America/Los_Angeles',
  'America/Denver', 'America/Chicago', 'America/New_York', 'America/Halifax', 'America/St_Johns',
  'America/Sao_Paulo', 'America/Noronha', 'Atlantic/Azores', 'UTC', 'Europe/London', 'Europe/Berlin',
  'Africa/Cairo', 'Africa/Johannesburg', 'Europe/Moscow', 'Asia/Tehran', 'Asia/Dubai', 'Asia/Kabul',
  'Asia/Karachi', 'Asia/Kolkata', 'Asia/Kathmandu', 'Asia/Dhaka', 'Asia/Yangon', 'Asia/Bangkok',
  'Asia/Singapore', 'Asia/Shanghai', 'Asia/Tokyo', 'Australia/Adelaide', 'Australia/Sydney',
  'Pacific/Guadalcanal', 'Pacific/Auckland', 'Pacific/Chatham', 'Pacific/Tongatapu', 'Pacific/Kiritimati',
];

// A few legacy IANA aliases whose canonical form already sits in COMMON_TIMEZONES — some browsers'
// resolvedOptions() report the alias (e.g. Chrome/Windows reporting "Asia/Calcutta" for IST) rather
// than the canonical "Asia/Kolkata", which would otherwise show up as a second, differently-labeled
// entry for the same place.
const TZ_ALIASES: Record<string, string> = {
  'Asia/Calcutta': 'Asia/Kolkata',
  'Asia/Katmandu': 'Asia/Kathmandu',
  'Asia/Rangoon': 'Asia/Yangon',
  'Asia/Saigon': 'Asia/Ho_Chi_Minh',
  'Europe/Kiev': 'Europe/Kyiv',
};

function detectTimezone(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    return TZ_ALIASES[tz] || tz;
  } catch { return 'UTC'; }
}

/** "Asia/Kolkata" -> "Kolkata (UTC+05:30)" — computed from the real offset (not a browser-formatted
 * "GMT"/"UTC" string, which varies by engine and produced a doubled "UTC (UTC+00:00)" label for UTC). */
function timezoneLabel(timeZone: string): string {
  const city = timeZone === 'UTC' ? 'UTC' : (timeZone.split('/').pop() || timeZone).replace(/_/g, ' ');
  if (timeZone === 'UTC') return city;
  const offsetMin = Math.round(tzOffsetMsAt(Date.now(), timeZone) / 60_000);
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `${city} (UTC${sign}${hh}:${mm})`;
}

/** Offset (ms) added to a UTC instant to get the wall-clock time in `timeZone` at that instant. */
function tzOffsetMsAt(ms: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(ms));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value || 0);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - ms;
}

/** `datetime-local` is timezone-naive; interpret its digits as wall-clock time in `timeZone`. */
function zonedInputToUtcIso(value: string, timeZone: string): string {
  const naive = Date.parse(`${value}:00Z`);
  if (!Number.isFinite(naive)) return '';
  let guess = naive;
  // Two passes converge even right across a DST transition.
  for (let i = 0; i < 2; i++) guess = naive - tzOffsetMsAt(guess, timeZone);
  return new Date(guess).toISOString();
}

/** The inverse of zonedInputToUtcIso: render a stored UTC instant as wall-clock digits in `timeZone`. */
function utcIsoToZonedInput(iso: string, timeZone: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return nextHourInZoneInput(timeZone);
  return new Date(ms + tzOffsetMsAt(ms, timeZone)).toISOString().slice(0, 16);
}

/** Default the picker to the next whole hour in `timeZone`, so it is never a past instant there. */
function nextHourInZoneInput(timeZone: string): string {
  const now = Date.now();
  const zoned = new Date(now + tzOffsetMsAt(now, timeZone));
  zoned.setUTCMinutes(0, 0, 0);
  zoned.setUTCHours(zoned.getUTCHours() + 1);
  return zoned.toISOString().slice(0, 16);
}

// Cron day-of-week is 0=Sunday. Letters repeat (S/T), so each pill carries the full name for a11y.
const WEEKDAYS = [
  { value: 0, letter: 'S', name: 'Sunday' },
  { value: 1, letter: 'M', name: 'Monday' },
  { value: 2, letter: 'T', name: 'Tuesday' },
  { value: 3, letter: 'W', name: 'Wednesday' },
  { value: 4, letter: 'T', name: 'Thursday' },
  { value: 5, letter: 'F', name: 'Friday' },
  { value: 6, letter: 'S', name: 'Saturday' },
];

const ordinal = (n: number) => `${n}${['th', 'st', 'nd', 'rd'][(n % 100 - n % 10 !== 10 && n % 10 < 4) ? n % 10 : 0]}`;

/**
 * Build the cron expression for a tab.
 *
 * Everything submits as kind 'cron' on purpose: the backend's 'daily'/'weekly'/'monthly' kinds are
 * plain interval arithmetic (now + 24h / 7d / 1 month) that ignores time-of-day and day selection,
 * so a "Daily at 09:00" schedule sent as kind 'daily' would fire at whatever time it was created.
 */
function buildCron(tab: ScheduleTab, time: string, weekdays: number[], monthDay: number): string {
  if (tab === 'once') return '';
  const [hours, minutes] = time.split(':');
  const h = Number(hours);
  const m = Number(minutes);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return '';
  if (tab === 'daily') return `${m} ${h} * * *`;
  if (tab === 'weekly') return weekdays.length ? `${m} ${h} * * ${[...weekdays].sort((a, b) => a - b).join(',')}` : '';
  return `${m} ${h} ${monthDay} * *`;
}

/** Plain-English echo of the current selection, so nobody has to read the cron to trust it. */
function describeSchedule(tab: ScheduleTab, time: string, weekdays: number[], monthDay: number, tzLabel: string): string {
  if (tab === 'daily') return `Everyday at ${time} ${tzLabel}`;
  if (tab === 'weekly') {
    if (!weekdays.length) return 'Pick at least one day';
    const names = [...weekdays].sort((a, b) => a - b).map((d) => WEEKDAYS[d].name);
    return `Every ${names.join(', ')} at ${time} ${tzLabel}`;
  }
  if (tab === 'monthly') return `On the ${ordinal(monthDay)} of every month at ${time} ${tzLabel}`;
  return '';
}

/** Human echo for a one-off, rendered in the zone it was picked in (not the UTC instant that gets stored). */
function describeRunAt(runAt: string, timeZone: string, tzLabel: string): string {
  if (!runAt) return 'Pick a date and time';
  const ms = Date.parse(runAt);
  if (!Number.isFinite(ms)) return 'Pick a date and time';
  const zoned = new Date(ms + tzOffsetMsAt(ms, timeZone));
  return `Once on ${zoned.toISOString().slice(0, 10)} at ${zoned.toISOString().slice(11, 16)} ${tzLabel}`;
}

export default function Schedules() {
  const navigate = useNavigate();
  const flag = useRemoteAgentFlag();
  const { schedules, loading, refresh } = useSchedules();
  const { recordings } = useRecordings();
  const { jobs, refresh: refreshJobs } = useJobs();
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<Schedule | null>(null);
  const [selectedScheduleId, setSelectedScheduleId] = useState<string | null>(null);
  const [sort, setSort] = useState<SortState>(null);

  // The job that started when a schedule most recently fired, while it is still running — keyed by
  // scheduleId so the row can show live progress instead of only the stale "Last Run" timestamp.
  const activeJobByScheduleId = useMemo(() => {
    const map = new Map<string, Job>();
    for (const job of jobs) {
      if (!job.scheduleId || !ACTIVE_JOB_STATUSES.includes(job.status)) continue;
      const existing = map.get(job.scheduleId);
      if (!existing || Date.parse(job.queuedAt) > Date.parse(existing.queuedAt)) map.set(job.scheduleId, job);
    }
    return map;
  }, [jobs]);

  // The most recent job regardless of status — this is how "how do I see the run results" gets
  // answered: once a run finishes it drops out of activeJobByScheduleId, so without this the row
  // (and the detail modal's video/screenshots/logs panel) would go blank the moment a run completed.
  const lastJobByScheduleId = useMemo(() => {
    const map = new Map<string, Job>();
    for (const job of jobs) {
      if (!job.scheduleId) continue;
      const existing = map.get(job.scheduleId);
      const at = (job: Job) => Date.parse(job.finishedAt || job.startedAt || job.queuedAt);
      if (!existing || at(job) > at(existing)) map.set(job.scheduleId, job);
    }
    return map;
  }, [jobs]);

  // SSE pushes job.progress/job.done frames faster than the 8s poll — refresh jobs on any of them.
  useAgentEvents((event) => {
    if (event.scopeType === 'job') void refreshJobs();
  });

  const selectedSchedule = schedules.find((schedule) => schedule.id === selectedScheduleId) || null;
  const selectedRecording = selectedSchedule ? recordings.find((recording) => recording.id === selectedSchedule.recordingId) || null : null;
  const selectedActiveJob = selectedSchedule ? activeJobByScheduleId.get(selectedSchedule.id) || null : null;
  const selectedResultJob = selectedActiveJob || (selectedSchedule ? lastJobByScheduleId.get(selectedSchedule.id) || null : null);

  const nameFor = useMemo(() => {
    const m = new Map(recordings.map((r) => [r.id, r.name] as const));
    return (id: string) => m.get(id) || id;
  }, [recordings]);
  const itemsFor = useCallback((schedule: Schedule) => schedule.items?.length
    ? schedule.items
    : [{ id: `legacy-${schedule.id}`, recordingId: schedule.recordingId, runnableId: schedule.recordingId, runnableType: 'recording' as const, stageNo: 1, position: 1, enabled: true }], []);

  const openSchedule = async (schedule: Schedule) => {
    const job = lastJobByScheduleId.get(schedule.id);
    const terminal = job && (Boolean(job.finishedAt) || ['done', 'failed', 'cancelled'].includes(job.status));
    if (terminal) {
      try {
        const runs = await fetch('/api/runs').then((response) => response.json());
        const linkedRun = (Array.isArray(runs) ? runs : []).find((run: any) => run.triggerMeta?.automationJobId === job.id);
        if (linkedRun?.id) { navigate(`/runs/${linkedRun.id}`); return; }
      } catch { /* Fall back to the schedule detail when the linked run is unavailable. */ }
    }
    setSelectedScheduleId(schedule.id);
  };

  const toggle = async (id: string, enabled: boolean) => {
    try { const response = await fetch(`/api/automation/schedules/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: !enabled }) }); if (!response.ok) throw new Error(); void refresh(); }
    catch { showToast('Could not update the schedule.', { tone: 'error' }); }
  };

  const remove = async (id: string) => {
    if (!(await showConfirm('Delete this schedule?'))) return;
    try { await fetch(`/api/automation/schedules/${id}`, { method: 'DELETE' }); showToast('Schedule deleted.', { tone: 'success' }); void refresh(); }
    catch { showToast('Could not delete the schedule.', { tone: 'error' }); }
  };

  const sortedSchedules = sortRows(schedules, sort, {
    schedule: (s) => s.title || nameFor(s.recordingId), runsAt: (s) => s.nextRunAt,
    lastRun: (s) => s.lastRunAt, status: (s) => activeJobByScheduleId.get(s.id)?.status || lastJobByScheduleId.get(s.id)?.status,
    enabled: (s) => s.enabled,
  });

  if (flag === false) return <div className="p-6 text-sm text-[var(--text-muted)]">The local desktop agent feature is not enabled on this server.</div>;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-[var(--text-primary)]">Schedules</h1>
          <p className="mt-1 text-sm text-[var(--text-muted)]">Pick your scripts and when to run them. TestFlow runs them for you, so your computer does not need to be switched on.</p>
        </div>
        <button onClick={() => setCreateOpen(true)} className="inline-flex items-center gap-2 rounded-md bg-[var(--accent)] px-3 py-2 text-sm font-medium text-white hover:bg-[var(--accent-hover)]">
          <Plus className="h-4 w-4" /> New Schedule
        </button>
      </div>

      <div className="min-w-0 overflow-x-auto rounded-lg border border-[var(--border)] bg-[var(--bg-card)]">
        {loading ? (
          <div className="flex items-center gap-2 px-4 py-10 text-sm text-[var(--text-muted)]"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>
        ) : schedules.length === 0 ? (
          <div className="flex flex-col items-center px-4 py-12 text-center text-sm text-[var(--text-muted)]">
            <CalendarClock className="mb-3 h-8 w-8 opacity-50" />
            No schedules yet. Click <strong className="mx-1 text-[var(--text-primary)]">New Schedule</strong> to pick scripts and a run time.
          </div>
        ) : (
          <table className="w-full min-w-[720px] whitespace-nowrap text-sm">
            <thead>
              <tr className="border-b border-[var(--border)] text-left text-xs uppercase tracking-wide text-[var(--text-muted)]">
                <SortableHeader label="Schedule" column="schedule" sort={sort} onSort={(key) => setSort((current) => nextSort(current, key))} className="px-4 py-2.5 font-medium" />
                <SortableHeader label="Runs At" column="runsAt" sort={sort} onSort={(key) => setSort((current) => nextSort(current, key))} className="px-4 py-2.5 font-medium" />
                <SortableHeader label="Last Run" column="lastRun" sort={sort} onSort={(key) => setSort((current) => nextSort(current, key))} className="px-4 py-2.5 font-medium" />
                <SortableHeader label="Status" column="status" sort={sort} onSort={(key) => setSort((current) => nextSort(current, key))} className="px-4 py-2.5 font-medium" />
                <SortableHeader label="Enabled" column="enabled" sort={sort} onSort={(key) => setSort((current) => nextSort(current, key))} className="px-4 py-2.5 font-medium" />
                <th className="px-4 py-2.5 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {sortedSchedules.map((s) => {
                const activeJob = activeJobByScheduleId.get(s.id) || null;
                const lastJob = lastJobByScheduleId.get(s.id) || null;
                const scheduledItems = itemsFor(s);
                const scheduledNames = scheduledItems.map((item) => nameFor(item.recordingId));
                return (
                <tr key={s.id} onClick={() => { void openSchedule(s); }} className="cursor-pointer border-b border-[var(--border)] last:border-0 hover:bg-[var(--bg-secondary)] focus-within:bg-[var(--bg-secondary)]">
                  <td className="px-4 py-2.5 font-medium text-[var(--text-primary)]">
                    <button type="button" onClick={(event) => { event.stopPropagation(); void openSchedule(s); }} className="flex max-w-[26rem] items-center gap-1.5 text-left hover:text-[var(--accent)]" title="Open scheduled test">
                      <span className="truncate">{s.title || nameFor(s.recordingId)}</span> <Eye className="h-3.5 w-3.5 shrink-0" />
                    </button>
                    <div className="max-w-[26rem] truncate text-xs font-normal text-[var(--text-muted)]" title={scheduledNames.join('\n')}>
                      {scheduledItems.length === 1 ? scheduledNames[0] : `${scheduledItems.length} selected tests · ${scheduledNames.slice(0, 2).join(' · ')}${scheduledItems.length > 2 ? '…' : ''}`}
                    </div>
                  </td>
                  <td className="px-4 py-2.5 text-xs text-[var(--text-muted)]">{fmt(s.nextRunAt)}</td>
                  <td className="px-4 py-2.5 text-xs text-[var(--text-muted)]">{fmt(s.lastRunAt)}</td>
                  <td className="px-4 py-2.5">
                    {activeJob ? (
                      <span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium ${jobStatusMeta(activeJob.status).cls}`}>
                        <Loader2 className="h-3 w-3 animate-spin" /> {jobStatusMeta(activeJob.status).label}
                      </span>
                    ) : lastJob ? (
                      <button
                        type="button"
                        onClick={(event) => { event.stopPropagation(); setSelectedScheduleId(s.id); }}
                        title="Open to view video, screenshots, and logs from this run"
                        className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium hover:opacity-80 ${jobStatusMeta(lastJob.status).cls}`}
                      >
                        {jobStatusMeta(lastJob.status).label}
                      </button>
                    ) : (
                      <span className="text-xs text-[var(--text-muted)]">—</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    <button onClick={(event) => { event.stopPropagation(); void toggle(s.id, s.enabled); }} className={`inline-flex h-5 w-9 items-center rounded-full px-0.5 transition-colors ${s.enabled ? 'bg-[var(--accent)]' : 'bg-slate-500/40'}`}>
                      <span className={`h-4 w-4 rounded-full bg-white transition-transform ${s.enabled ? 'translate-x-4' : ''}`} />
                    </button>
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <button onClick={(event) => { event.stopPropagation(); setEditing(s); }} className="mr-2 inline-flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1 text-xs text-[var(--text-primary)] hover:border-[var(--accent)]" title="Edit schedule"><Pencil className="h-3.5 w-3.5" /></button>
                    <button onClick={(event) => { event.stopPropagation(); void remove(s.id); }} className="inline-flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1 text-xs text-red-400 hover:border-red-500"><Trash2 className="h-3.5 w-3.5" /></button>
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <NewScheduleModal isOpen={createOpen} onClose={() => setCreateOpen(false)} onCreated={refresh} recordings={recordings} />
      {editing && <NewScheduleModal isOpen schedule={editing} recordings={recordings} onClose={() => setEditing(null)} onCreated={() => { setEditing(null); refresh(); }} />}
      <ScheduleRecordingModal schedule={selectedSchedule} recording={selectedRecording} recordings={recordings} resultJob={selectedResultJob} resultJobIsLive={Boolean(selectedActiveJob)} onClose={() => setSelectedScheduleId(null)} />
    </div>
  );
}

function ScheduleRecordingModal({ schedule, recording, recordings, resultJob, resultJobIsLive, onClose }: { schedule: Schedule | null; recording: any | null; recordings: any[]; resultJob: Job | null; resultJobIsLive: boolean; onClose: () => void }) {
  const scheduledItems = schedule?.items?.length
    ? schedule.items
    : schedule ? [{ id: `legacy-${schedule.id}`, recordingId: schedule.recordingId, runnableId: schedule.recordingId, runnableType: 'recording' as const, stageNo: 1, position: 1, enabled: true }] : [];
  const recordingById = new Map(recordings.map((item) => [item.id, item]));
  return <Modal isOpen={!!schedule} onClose={onClose} title="Scheduled test" size="xl"
    footer={<div className="flex justify-end"><button type="button" onClick={onClose} className="rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-sm text-[var(--text-primary)]">Close</button></div>}>
    {!schedule ? null : <div className="space-y-4">
      <div><div className="text-lg font-medium text-[var(--text-primary)]">{scheduledItems.length === 1 ? recording?.name || schedule.recordingId : `${scheduledItems.length} scheduled tests`}</div><p className="mt-1 text-sm text-[var(--text-muted)]">All selected tests run when this schedule fires.</p></div>
      <div className="rounded-md border border-[var(--border)] bg-[var(--bg-secondary)]/40 p-3">
        <div className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">Selected tests ({scheduledItems.length})</div>
        <ol className="max-h-40 space-y-1 overflow-auto text-sm text-[var(--text-primary)]">{scheduledItems.map((item, index) => <li key={item.id}>{index + 1}. {recordingById.get(item.recordingId)?.name || item.recordingId}</li>)}</ol>
      </div>
      <dl className="grid gap-3 text-sm sm:grid-cols-2">
        {schedule.title && <div><dt className="text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">Title</dt><dd className="mt-1 text-[var(--text-primary)]">{schedule.title}</dd></div>}
        <div><dt className="text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">Next run</dt><dd className="mt-1 text-[var(--text-primary)]">{fmt(schedule.nextRunAt)}</dd></div>
        <div><dt className="text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">Schedule</dt><dd className="mt-1 font-mono text-[var(--text-primary)]">{schedule.cron || schedule.kind} <span className="font-sans text-xs text-[var(--text-muted)]">({timezoneLabel(schedule.timezone || 'UTC')})</span></dd></div>
        <div><dt className="text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">{scheduledItems.length > 1 ? 'First target URL' : 'Target URL'}</dt><dd className="mt-1 break-all text-[var(--text-primary)]">{recording?.appUrl || 'Not available'}</dd></div>
        <div><dt className="text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">{scheduledItems.length > 1 ? 'First test case' : 'Test case'}</dt><dd className="mt-1 text-[var(--text-primary)]">{recording?.metadata?.caseId || 'Not linked'}</dd></div>
      </dl>
      {resultJob && (
        <div>
          <div className="mb-2 text-sm font-semibold text-[var(--text-primary)]">{resultJobIsLive ? 'Running now' : 'Latest run results'}</div>
          <AutomationRunArtifacts jobId={resultJob.id} />
        </div>
      )}
      <div>
        <div className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">Scripts ({scheduledItems.length})</div>
        <div className="space-y-2">{scheduledItems.map((item, index) => {
          const itemRecording = recordingById.get(item.recordingId);
          return <details key={item.id} className="rounded-md border border-[var(--border)] bg-[var(--bg-secondary)]">
            <summary className="cursor-pointer px-3 py-2 text-sm font-medium text-[var(--text-primary)]">{index + 1}. {itemRecording?.name || item.recordingId}</summary>
            {itemRecording?.script ? <pre className="max-h-80 overflow-auto border-t border-[var(--border)] p-3 text-xs leading-5 text-[var(--text-primary)]"><code>{itemRecording.script}</code></pre> : <div className="border-t border-[var(--border)] p-3 text-sm text-amber-300">This recording is no longer available.</div>}
          </details>;
        })}</div>
      </div>
    </div>}
  </Modal>;
}

/**
 * Timezone picker shared by both modals: a custom searchable panel (matching MultiSelectDropdown's
 * look) rather than a native <select> — with ~20 options a native listbox renders in raw OS/browser
 * chrome that clashes with the rest of the app's styling, and it has no real search, just typeahead.
 */
function TimezoneSelect({ value, onChange }: { value: string; onChange: (tz: string) => void }) {
  const detected = useMemo(detectTimezone, []);
  const options = useMemo(() => Array.from(new Set([detected, ...COMMON_TIMEZONES, value])), [detected, value]);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const ref = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [menuRect, setMenuRect] = useState<{ top: number; left: number; width: number } | null>(null);

  const placeMenu = useCallback(() => {
    const trigger = ref.current?.getBoundingClientRect();
    if (!trigger) return;
    const panelHeight = 288;
    const spaceBelow = window.innerHeight - trigger.bottom - 12;
    const top = spaceBelow >= panelHeight || spaceBelow >= trigger.top
      ? trigger.bottom + 4
      : Math.max(12, trigger.top - panelHeight - 4);
    setMenuRect({ top, left: trigger.left, width: trigger.width });
  }, []);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!ref.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return undefined;
    placeMenu();
    window.addEventListener('scroll', placeMenu, true);
    window.addEventListener('resize', placeMenu);
    return () => {
      window.removeEventListener('scroll', placeMenu, true);
      window.removeEventListener('resize', placeMenu);
    };
  }, [open, placeMenu]);

  const labelOf = (tz: string) => tz === detected ? `${timezoneLabel(tz)} — auto detected` : timezoneLabel(tz);
  const filtered = options.filter((tz) => {
    const q = query.trim().toLowerCase();
    return !q || labelOf(tz).toLowerCase().includes(q) || tz.toLowerCase().includes(q);
  });

  return (
    <div ref={ref} className="relative">
      <span className="block text-xs font-medium text-[var(--text-muted)]">Timezone</span>
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="mt-1 flex w-full items-center justify-between gap-2 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none hover:border-[var(--accent)]"
      >
        <span className="truncate">{labelOf(value)}</span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-70" />
      </button>
      {open && menuRect && createPortal(
        <div ref={menuRef} role="listbox" style={{ position: 'fixed', top: menuRect.top, left: menuRect.left, width: menuRect.width, zIndex: 70 }} className="flex max-h-72 flex-col overflow-hidden rounded-md border border-[var(--border)] bg-[var(--bg-card)] shadow-xl">
          <div className="border-b border-[var(--border)] p-1.5">
            <input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search timezone…"
              className="w-full rounded border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1 text-xs text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
            />
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-1">
            {filtered.length === 0 ? (
              <div className="px-2 py-1.5 text-xs text-[var(--text-muted)]">No match.</div>
            ) : filtered.map((tz) => (
              <button
                key={tz}
                type="button"
                onClick={() => { onChange(tz); setOpen(false); setQuery(''); }}
                className={`block w-full truncate rounded px-2 py-1.5 text-left text-xs ${tz === value ? 'bg-[var(--accent)]/15 font-medium text-[var(--accent)]' : 'text-[var(--text-primary)] hover:bg-[var(--bg-secondary)]'}`}
              >
                {labelOf(tz)}
              </button>
            ))}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}

/** Info-icon toggle, sitting inline next to a "Cron expression" label — shared by both modals. */
function CronHelpButton({ show, onToggle }: { show: boolean; onToggle: () => void }) {
  return (
    <button type="button" onClick={onToggle} aria-label="Show cron expression examples" aria-expanded={show} className="rounded p-0.5 text-[var(--accent)] hover:bg-[var(--bg-secondary)]">
      <Info className="h-4 w-4" />
    </button>
  );
}

/** The "how do I write a cron expression" examples panel the button above toggles — shared by both modals. */
function CronHelpPanel() {
  return (
    <div role="note" className="mt-2 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] p-3 text-xs text-[var(--text-muted)]">
      <div className="font-medium text-[var(--text-primary)]">English examples</div>
      <ul className="mt-1 space-y-1">
        <li><code>every 15 minutes</code> — runs every 15 minutes</li>
        <li><code>at 9am</code> — runs daily at 09:00</li>
        <li><code>at 5pm on Monday</code> — runs every Monday at 17:00</li>
        <li><code>at 09:00 on weekdays</code> — runs Monday through Friday</li>
        <li><code>at 04:05 on day-of-month 5</code> — runs on the 5th of every month</li>
      </ul>
      <div className="mt-2">Cron format: <code>minute hour day-of-month month day-of-week</code>. Example: <code>0 9 * * 1-5</code>.</div>
    </div>
  );
}

function EditScheduleModal({ schedule, onClose, onSaved }: { schedule: Schedule; onClose: () => void; onSaved: () => void }) {
  const [kind, setKind] = useState<'once' | 'cron'>(schedule.kind === 'once' ? 'once' : 'cron');
  const [title, setTitle] = useState(schedule.title || '');
  const [cron, setCron] = useState(schedule.cron || '');
  const [timezone, setTimezone] = useState(schedule.timezone || detectTimezone());
  const [runAt, setRunAt] = useState(schedule.nextRunAt ? utcIsoToZonedInput(schedule.nextRunAt, timezone) : nextHourInZoneInput(timezone));
  const [busy, setBusy] = useState(false);
  const [showCronHelp, setShowCronHelp] = useState(false);
  const tzLabel = timezoneLabel(timezone);
  const save = async () => {
    const nextRunAt = kind === 'once' ? zonedInputToUtcIso(runAt, timezone) : '';
    if (!title.trim()) { showToast('Enter a schedule title.', { tone: 'error' }); return; }
    if (kind === 'once' && (!nextRunAt || Date.parse(nextRunAt) <= Date.now())) { showToast(`Pick a future date and time (${tzLabel}).`, { tone: 'error' }); return; }
    if (kind === 'cron' && !cron.trim()) { showToast('Enter a cron expression.', { tone: 'error' }); return; }
    setBusy(true);
    try {
      const response = await fetch(`/api/automation/schedules/${schedule.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(kind === 'once' ? { kind, runAt: nextRunAt, timezone, title: title.trim(), enabled: true } : { kind, cron: cron.trim(), timezone, title: title.trim(), enabled: true }) });
      if (!response.ok) throw new Error((await response.json().catch(() => ({})))?.error || 'Could not update the schedule.');
      showToast('Schedule updated.', { tone: 'success' });
      onSaved();
    } catch (error: any) { showToast(error?.message || 'Could not update the schedule.', { tone: 'error' }); }
    finally { setBusy(false); }
  };
  return <Modal isOpen onClose={onClose} title="Edit schedule" size="md" footer={<div className="flex justify-end gap-2"><button onClick={onClose} className="rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-sm text-[var(--text-primary)]">Cancel</button><button onClick={save} disabled={busy || !title.trim()} className="inline-flex items-center gap-2 rounded-md bg-[var(--accent)] px-3 py-2 text-sm font-medium text-white hover:bg-[var(--accent-hover)] disabled:opacity-50">{busy && <Loader2 className="h-4 w-4 animate-spin" />} Save Changes</button></div>}>
    <label className="block text-xs font-medium text-[var(--text-muted)]">Schedule title<RequiredMark />
      <input type="text" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="e.g. Nightly regression — Keystone" maxLength={200} className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent)]" />
    </label>
    <label className="mt-3 block text-xs font-medium text-[var(--text-muted)]">Schedule type
      <select value={kind} onChange={(event) => setKind(event.target.value as 'once' | 'cron')} className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"><option value="cron">Recurring (cron)</option><option value="once">Specific date</option></select>
    </label>
    <div className="mt-3">
      <TimezoneSelect value={timezone} onChange={(tz) => {
        // Re-express the same picked instant in the new zone's wall-clock digits, not a blank reset.
        const instant = zonedInputToUtcIso(runAt, timezone);
        setRunAt(instant ? utcIsoToZonedInput(instant, tz) : nextHourInZoneInput(tz));
        setTimezone(tz);
      }} />
    </div>
    {kind === 'once' ? (
      <label className="mt-3 block text-xs font-medium text-[var(--text-muted)]">Date &amp; Time ({tzLabel})
        <input type="datetime-local" value={runAt} onChange={(event) => setRunAt(event.target.value)} className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent)] [color-scheme:dark]" />
      </label>
    ) : (
      <div className="mt-3">
        <div className="flex items-center gap-1.5 text-xs font-medium text-[var(--text-muted)]">
          <label htmlFor="edit-cron-expression">Cron expression ({tzLabel})</label>
          <CronHelpButton show={showCronHelp} onToggle={() => setShowCronHelp((open) => !open)} />
        </div>
        <input id="edit-cron-expression" value={cron} onChange={(event) => setCron(event.target.value)} placeholder="0 9 * * 1-5" className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 font-mono text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent)]" />
        <span className="mt-1 block text-xs font-normal text-[var(--text-muted)]">Minute hour day-of-month month day-of-week, in {tzLabel}</span>
        {showCronHelp && <CronHelpPanel />}
      </div>
    )}
  </Modal>;
}

type Runnable = { kind: 'script' | 'recording'; scriptId?: string; recordingId?: string; caseId?: string; caseName?: string; name?: string; folderId?: string | null; tags?: string[] };
type RepositoryCase = { id: string; title?: string; tags?: string[]; steps?: unknown[]; testPlanId?: string; testPlanIds?: string[]; testSuiteId?: string; testSuiteIds?: string[] };
type RepositoryGroup = { id: string; name?: string; title?: string };
const runnableKey = (runnable: Runnable) => `${runnable.kind}:${runnable.kind === 'recording' ? runnable.recordingId : runnable.scriptId}`;
const matchesSearch = (values: unknown[], tags: string[] = [], search: string) => {
  const terms = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const normalizedTags = tags.map((tag) => String(tag).toLowerCase().replace(/^@/, ''));
  return terms.every((term) => term.startsWith('@')
    ? normalizedTags.some((tag) => tag.includes(term.slice(1)))
    : [...values, ...tags].some((value) => String(value || '').toLowerCase().includes(term)));
};

function NewScheduleModal({ isOpen, onClose, onCreated, schedule, recordings = [] }: { isOpen: boolean; onClose: () => void; onCreated: () => void; schedule?: Schedule | null; recordings?: any[] }) {
  const isEditing = Boolean(schedule);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selectedPlanIds, setSelectedPlanIds] = useState<Set<string>>(new Set());
  const [selectedSuiteIds, setSelectedSuiteIds] = useState<Set<string>>(new Set());
  const [title, setTitle] = useState('');
  const [tab, setTab] = useState<ScheduleTab>('daily');
  const [time, setTime] = useState('02:00');
  const [weekdays, setWeekdays] = useState<number[]>([1]);
  const [monthDay, setMonthDay] = useState(1);
  const [timezone, setTimezone] = useState(detectTimezone);
  const [onceAt, setOnceAt] = useState(() => nextHourInZoneInput(detectTimezone()));
  const [cronInput, setCronInput] = useState('At 04:05 on day-of-month 5');
  const [cronResolved, setCronResolved] = useState<{ expression: string; description: string; nextRuns: string[]; error?: string }>({ expression: '', description: '', nextRuns: [] });
  const [cronResolving, setCronResolving] = useState(false);
  const [showCronHelp, setShowCronHelp] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [runnables, setRunnables] = useState<Runnable[]>([]);
  const [cases, setCases] = useState<RepositoryCase[]>([]);
  const [plans, setPlans] = useState<RepositoryGroup[]>([]);
  const [suites, setSuites] = useState<RepositoryGroup[]>([]);
  const [selectionSource, setSelectionSource] = useState<'individual' | 'plan' | 'suite'>('individual');
  const [search, setSearch] = useState('');
  const [executionMode, setExecutionMode] = useState<'sequential' | 'parallel'>('parallel');
  const [failurePolicy, setFailurePolicy] = useState<'stop' | 'continue'>('continue');
  const [maxConcurrency, setMaxConcurrency] = useState(3);

  useEffect(() => {
    if (!isOpen) return;
    const initialTimezone = schedule?.timezone || detectTimezone();
    setLoading(true);
    setSelected(new Set());
    setSelectedPlanIds(new Set());
    setSelectedSuiteIds(new Set());
    setTitle(schedule?.title || '');
    setTab(schedule?.kind === 'once' ? 'once' : schedule ? 'cron' : 'daily');
    setTimezone(initialTimezone);
    setOnceAt(schedule?.nextRunAt ? utcIsoToZonedInput(schedule.nextRunAt, initialTimezone) : nextHourInZoneInput(initialTimezone));
    setCronInput(schedule?.cron || 'At 04:05 on day-of-month 5');
    setExecutionMode(schedule?.executionMode || 'parallel');
    setFailurePolicy(schedule?.failurePolicy || 'continue');
    setMaxConcurrency(schedule?.maxConcurrency || 3);
    setSearch('');
    setSelectionSource('individual');
    Promise.all([fetch('/api/automation/runnables').then((r) => r.json()), fetch('/api/cases').then((r) => r.json()), fetch('/api/plans').then((r) => r.json()), fetch('/api/suites').then((r) => r.json())])
      .then(([runnableData, caseData, planData, suiteData]) => {
        const available = (Array.isArray(runnableData?.runnables) ? runnableData.runnables : [])
          .map((runnable: Runnable) => ({ ...runnable, folderId: runnable.folderId == null ? null : String(runnable.folderId) }));
        setRunnables(available);
        setCases(Array.isArray(caseData) ? caseData : []);
        setPlans(Array.isArray(planData) ? planData : []);
        setSuites(Array.isArray(suiteData) ? suiteData : []);
        const initial = schedule?.items?.length
          ? schedule.items.map((item) => `${item.runnableType}:${item.runnableId}`)
          : schedule ? [runnableKey(available.find((runnable) => runnable.recordingId === schedule.recordingId) || { kind: 'recording', recordingId: schedule.recordingId } as Runnable)] : [];
        setSelected(new Set(initial));
      })
      .catch(() => showToast('Could not load repository scripts.', { tone: 'error' }))
      .finally(() => setLoading(false));
  }, [isOpen, schedule?.id]);

  // Resolve through the server so the preview uses the same parser the scheduler fires on.
  useEffect(() => {
    if (tab !== 'cron') return;
    const text = cronInput.trim();
    if (!text) { setCronResolved({ expression: '', description: '', nextRuns: [] }); return; }
    setCronResolving(true);
    const timer = setTimeout(() => {
      fetch('/api/automation/cron/resolve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input: text, timezone }) })
        .then((r) => r.json())
        .then((data) => setCronResolved(data))
        .catch(() => setCronResolved({ expression: '', description: '', nextRuns: [], error: 'Could not check that expression.' }))
        .finally(() => setCronResolving(false));
    }, 300);
    return () => clearTimeout(timer);
  }, [tab, cronInput, timezone]);

  const visibleRunnables = useMemo(() => {
    return runnables.filter((runnable) => !search.trim() || matchesSearch([runnable.name, runnable.caseName], runnable.tags, search));
  }, [runnables, search]);
  const matchingManualCases = useMemo(() => {
    if (!search.trim()) return [];
    const runnableCaseIds = new Set(runnables.map((runnable) => String(runnable.caseId || '')).filter(Boolean));
    return cases.filter((testCase) => !runnableCaseIds.has(String(testCase.id)) && Array.isArray(testCase.steps) && testCase.steps.length > 0
      && matchesSearch([testCase.title], testCase.tags, search));
  }, [cases, runnables, search]);
  const casesInGroup = useCallback((groupId: string, kind: 'plan' | 'suite') => kind === 'plan'
    ? casesForPlan(cases, suites, groupId)
    : casesForSuite(cases, suites, groupId), [cases, suites]);
  const runnableIdsForGroup = useCallback((groupId: string, kind: 'plan' | 'suite') => {
    const caseIds = new Set(casesInGroup(groupId, kind).map((testCase) => String(testCase.id)));
    return runnables.filter((runnable) => caseIds.has(String(runnable.caseId || ''))).map(runnableKey);
  }, [casesInGroup, runnables]);
  const plansWithRunnableCounts = useMemo(() => plans.map((plan) => ({ ...plan, caseCount: casesInGroup(plan.id, 'plan').length, runnableCount: runnableIdsForGroup(plan.id, 'plan').length })), [plans, casesInGroup, runnableIdsForGroup]);
  const suitesWithRunnableCounts = useMemo(() => suites.map((suite) => ({ ...suite, caseCount: casesInGroup(suite.id, 'suite').length, runnableCount: runnableIdsForGroup(suite.id, 'suite').length })), [suites, casesInGroup, runnableIdsForGroup]);
  const selectedIds = useMemo(() => {
    const ids = new Set(selected);
    selectedPlanIds.forEach((id) => runnableIdsForGroup(id, 'plan').forEach((key) => ids.add(key)));
    selectedSuiteIds.forEach((id) => runnableIdsForGroup(id, 'suite').forEach((key) => ids.add(key)));
    return ids;
  }, [selected, selectedPlanIds, selectedSuiteIds, runnableIdsForGroup]);
  const selectedRunnables = useMemo(() => [...selectedIds].map((id) => runnables.find((runnable) => runnableKey(runnable) === id)).filter(Boolean) as Runnable[], [selectedIds, runnables]);
  const visibleGroups = useMemo(() => {
    const groups = selectionSource === 'plan' ? plansWithRunnableCounts : suitesWithRunnableCounts;
    const query = search.trim().toLowerCase();
    return query ? groups.filter((group) => String(group.name || group.title || group.id).toLowerCase().includes(query)) : groups;
  }, [selectionSource, plansWithRunnableCounts, suitesWithRunnableCounts, search]);
  const toggle = (id: string) => setSelected((prev) => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });
  const toggleGroup = (id: string, kind: 'plan' | 'suite') => {
    const setter = kind === 'plan' ? setSelectedPlanIds : setSelectedSuiteIds;
    setter((previous) => {
      const next = new Set(previous);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };
  const toggleWeekday = (day: number) => setWeekdays((prev) => (prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day]));
  const tzLabel = timezoneLabel(timezone);
  const cron = tab === 'cron' ? cronResolved.expression : buildCron(tab, time, weekdays, monthDay);
  const runAt = tab === 'once' ? zonedInputToUtcIso(onceAt, timezone) : '';
  const summary = tab === 'once' ? describeRunAt(runAt, timezone, tzLabel) : tab === 'cron' ? (cronResolved.description || cronResolved.error || 'Type a schedule or a cron expression') : describeSchedule(tab, time, weekdays, monthDay, tzLabel);
  const scheduleReady = tab === 'once' ? Boolean(runAt) : Boolean(cron) && !(tab === 'cron' && cronResolved.error);

  const submit = async () => {
    if (selectedIds.size === 0) { showToast('Select at least one runnable test case.', { tone: 'error' }); return; }
    if (!title.trim()) { showToast('Enter a schedule title.', { tone: 'error' }); return; }
    if (!scheduleReady) { showToast(tab === 'weekly' ? 'Pick at least one day of the week.' : tab === 'cron' ? (cronResolved.error || 'Enter a schedule we can read.') : 'Pick a date and time.', { tone: 'error' }); return; }
    // A one-off in the past would be dispatched by the very next scheduler tick.
    if (tab === 'once' && Date.parse(runAt) <= Date.now()) { showToast(`Pick a future date and time (${tzLabel}).`, { tone: 'error' }); return; }
    setBusy(true);
    try {
      const selectedItems = [...selectedIds].map((id, index) => {
        const runnable = runnables.find((item) => runnableKey(item) === id);
        if (!runnable) return null;
        return runnable.kind === 'recording'
          ? { runnableType: 'recording', runnableId: runnable.recordingId, recordingId: runnable.recordingId, stageNo: executionMode === 'sequential' ? index + 1 : 1 }
          : { runnableType: 'script', runnableId: runnable.scriptId, stageNo: executionMode === 'sequential' ? index + 1 : 1 };
      }).filter(Boolean);
      if (selectedItems.length !== selectedIds.size) throw new Error('One or more selected tests are no longer available. Refresh and try again.');
      const payload = tab === 'once'
        ? { kind: 'once', runAt, timezone, title: title.trim() }
        : { kind: 'cron', cron, timezone, title: title.trim() };
      const workflow = { items: selectedItems, executionMode, failurePolicy, maxConcurrency: executionMode === 'sequential' ? 1 : maxConcurrency };
      if (schedule) {
        const response = await fetch(`/api/automation/schedules/${schedule.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...payload, ...workflow, enabled: schedule.enabled }) });
        if (!response.ok) throw new Error((await response.json().catch(() => ({})))?.error || 'Could not update the schedule.');
        showToast('Schedule updated.', { tone: 'success' });
        onCreated();
        onClose();
        return;
      }
      const response = await fetch('/api/automation/schedules', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...payload, ...workflow }) });
      if (!response.ok) throw new Error((await response.json().catch(() => ({})))?.error || 'Could not create the schedule.');
      showToast('Schedule created.', { tone: 'success' });
      setSelected(new Set());
      setSelectedPlanIds(new Set());
      setSelectedSuiteIds(new Set());
      onCreated();
      onClose();
    } catch (error: any) { showToast(error?.message || 'Could not create the schedule.', { tone: 'error' }); }
    finally { setBusy(false); }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={isEditing ? 'Edit schedule' : 'New schedule'} size="xl"
      footer={<div className="flex justify-end gap-2">
        <button onClick={onClose} className="rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-sm text-[var(--text-primary)]">Cancel</button>
        <button onClick={submit} disabled={busy || selectedIds.size === 0 || !title.trim() || !scheduleReady} className="inline-flex items-center gap-2 rounded-md bg-[var(--accent)] px-3 py-2 text-sm font-medium text-white hover:bg-[var(--accent-hover)] disabled:opacity-50">
          {busy && <Loader2 className="h-4 w-4 animate-spin" />} {isEditing ? 'Save Changes' : 'Create Schedule'}
        </button>
      </div>}>
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-medium text-[var(--text-primary)]">Select schedule scope<RequiredMark /></div>
          <div className="mt-0.5 text-xs text-[var(--text-muted)]">Choose any number of plans, suites, or runnable test cases.</div>
        </div>
        <label className="relative block w-full max-w-lg">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-muted)]" />
          <input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder={selectionSource === 'individual' ? 'Search test cases by name or @tag' : `Search test ${selectionSource}s`}
            className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] py-2 pl-8 pr-3 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent)]" />
        </label>
      </div>
      <div className="mb-3 flex gap-1 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)]/50 p-1" aria-label="Select tests from">
        {([['individual', 'Test cases', selected.size], ['plan', 'Test plans', selectedPlanIds.size], ['suite', 'Test suites', selectedSuiteIds.size]] as const).map(([id, label, count]) => <button key={id} type="button" onClick={() => { setSelectionSource(id); setSearch(''); }} aria-pressed={selectionSource === id} className={`flex flex-1 items-center justify-center gap-2 rounded px-3 py-2 text-sm font-medium ${selectionSource === id ? 'bg-[var(--accent)] text-white' : 'text-[var(--text-muted)] hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)]'}`}>{label}{count > 0 && <span className="rounded-full bg-black/20 px-1.5 py-0.5 text-[10px] tabular-nums">{count}</span>}</button>)}
      </div>
      {selectionSource === 'individual' ? <div className="min-h-64 max-h-72 overflow-auto rounded-md border border-[var(--border)]">
          {loading ? <div className="flex items-center gap-2 p-4 text-sm text-[var(--text-muted)]"><Loader2 className="h-4 w-4 animate-spin" /> Loading scripts…</div>
            : visibleRunnables.length === 0 && matchingManualCases.length === 0 ? <div className="p-4 text-sm text-[var(--text-muted)]">No tests match your search.</div>
            : visibleRunnables.map((runnable) => (
              <label key={runnableKey(runnable)} className="flex cursor-pointer items-center gap-3 border-b border-[var(--border)] px-3 py-2.5 text-sm last:border-0 hover:bg-[var(--bg-secondary)]">
                <input type="checkbox" checked={selected.has(runnableKey(runnable))} onChange={() => toggle(runnableKey(runnable))} className="h-4 w-4 shrink-0 accent-[var(--accent)]" />
                <Code2 className="h-4 w-4 shrink-0 text-[var(--accent)]" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium text-[var(--text-primary)]">{runnable.caseName || runnable.name}</span>
                  <span className="block truncate text-xs text-[var(--text-muted)]">{runnable.caseName ? runnable.name : (runnable.kind === 'recording' ? 'Record & Play' : 'Repository script')}</span>
                </span>
              </label>
            ))}
          {matchingManualCases.map((testCase) => (
            <div key={testCase.id} className="flex items-center gap-3 border-b border-[var(--border)] px-3 py-2.5 text-sm text-[var(--text-muted)]" title="Manual step-only cases cannot run on a headless schedule.">
              <Code2 className="h-4 w-4 shrink-0 opacity-50" />
              <span className="min-w-0 flex-1"><span className="block truncate font-medium">{testCase.title || testCase.id}</span><span className="block truncate text-xs">Manual steps · cannot be scheduled automatically</span></span>
            </div>
          ))}
      </div> : <div className="max-h-72 min-h-64 overflow-auto rounded-md border border-[var(--border)]">
        <div className="border-b border-[var(--border)] bg-[var(--bg-secondary)]/40 px-4 py-2 text-xs text-[var(--text-muted)]">Select any number of test {selectionSource}s. Overlapping cases are included only once.</div>
        {visibleGroups.length ? visibleGroups.map((group) => <label key={group.id} className={`flex items-center gap-3 border-b border-[var(--border)] px-4 py-3 text-left text-sm last:border-0 ${group.runnableCount ? 'cursor-pointer hover:bg-[var(--bg-secondary)]' : 'cursor-not-allowed opacity-60'}`}>
          <input type="checkbox" disabled={!group.runnableCount} checked={(selectionSource === 'plan' ? selectedPlanIds : selectedSuiteIds).has(group.id)} onChange={() => toggleGroup(group.id, selectionSource)} className="h-4 w-4 shrink-0 accent-[var(--accent)]" />
          <span className="min-w-0 flex-1 truncate font-medium text-[var(--text-primary)]">{group.name || group.title || group.id}</span>
          <span className="shrink-0 text-xs text-[var(--text-muted)]">{group.caseCount} case{group.caseCount === 1 ? '' : 's'}</span>
          <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ${group.runnableCount ? 'bg-[var(--accent)]/15 text-[var(--accent)]' : 'bg-[var(--border)] text-[var(--text-muted)]'}`}>{group.runnableCount} script{group.runnableCount === 1 ? '' : 's'}</span>
        </label>) : <div className="p-4 text-sm text-[var(--text-muted)]">No test {selectionSource}s match your search.</div>}
      </div>}
      <div className="mt-3 flex flex-wrap items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)]/40 px-3 py-2 text-xs text-[var(--text-muted)]">
        <span className="font-medium text-[var(--text-primary)]">Selected:</span>
        <span>{selectedPlanIds.size} plan{selectedPlanIds.size === 1 ? '' : 's'}</span><span>·</span>
        <span>{selectedSuiteIds.size} suite{selectedSuiteIds.size === 1 ? '' : 's'}</span><span>·</span>
        <span>{selected.size} individual case{selected.size === 1 ? '' : 's'}</span><span>·</span>
        <span className="rounded-full bg-[var(--accent)]/15 px-2 py-0.5 font-semibold text-[var(--accent)]">{selectedIds.size} runnable script{selectedIds.size === 1 ? '' : 's'}</span>
      </div>
      {selectedRunnables.length > 0 && <div className="mt-3 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)]/40 p-3">
        <div className="mb-2 text-xs font-medium text-[var(--text-muted)]">Workflow order</div>
        <ol className="max-h-40 space-y-1 overflow-auto text-sm text-[var(--text-primary)]">{selectedRunnables.map((runnable, index) => <li key={runnableKey(runnable)}>{index + 1}. {runnable.caseName || runnable.name}</li>)}</ol>
      </div>}
      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <label className="text-xs font-medium text-[var(--text-muted)]">Execution mode
          <select value={executionMode} onChange={(event) => setExecutionMode(event.target.value as 'sequential' | 'parallel')} className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent)]">
            <option value="parallel">Parallel</option><option value="sequential">Sequential</option>
          </select>
        </label>
        <label className="text-xs font-medium text-[var(--text-muted)]">On failure
          <select value={failurePolicy} onChange={(event) => setFailurePolicy(event.target.value as 'stop' | 'continue')} className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent)]">
            <option value="continue">Continue remaining tests</option><option value="stop">Stop remaining tests</option>
          </select>
        </label>
        <label className="text-xs font-medium text-[var(--text-muted)]">Parallel limit
          <input type="number" min={1} max={20} value={executionMode === 'sequential' ? 1 : maxConcurrency} disabled={executionMode === 'sequential'} onChange={(event) => setMaxConcurrency(Math.min(20, Math.max(1, Number(event.target.value) || 1)))} className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent)] disabled:opacity-50" />
        </label>
      </div>
      <label className="mt-4 block text-xs font-medium text-[var(--text-muted)]">
        Schedule title<RequiredMark />
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="e.g. Nightly regression — Keystone"
          maxLength={200}
          className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
        />
      </label>
      <div className="mt-4 flex flex-wrap items-end justify-between gap-3">
        <div className="text-sm font-medium text-[var(--text-primary)]">Schedule<RequiredMark /></div>
        <div className="w-full max-w-[16rem]">
          <TimezoneSelect value={timezone} onChange={(tz) => {
            // Re-express the same picked instant in the new zone's wall-clock digits, not a blank reset.
            const instant = zonedInputToUtcIso(onceAt, timezone);
            setOnceAt(instant ? utcIsoToZonedInput(instant, tz) : nextHourInZoneInput(tz));
            setTimezone(tz);
          }} />
        </div>
      </div>
      <div className="mt-2 flex gap-6 border-b border-[var(--border)] text-sm" role="tablist" aria-label="Schedule frequency">
        {SCHEDULE_TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            onClick={() => setTab(item.id)}
            className={`border-b-2 pb-2 ${tab === item.id ? 'border-[var(--accent)] text-[var(--accent)]' : 'border-transparent text-[var(--text-muted)] hover:text-[var(--text-primary)]'}`}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="mt-3">
        {tab === 'weekly' && (
          <div className="mb-3">
            <div className="mb-1.5 text-xs font-medium text-[var(--text-muted)]">Repeat On</div>
            <div className="flex gap-1.5">
              {WEEKDAYS.map((day) => (
                <button
                  key={day.value}
                  type="button"
                  aria-label={day.name}
                  aria-pressed={weekdays.includes(day.value)}
                  onClick={() => toggleWeekday(day.value)}
                  className={`h-9 w-9 rounded-full border text-sm font-medium transition-colors ${weekdays.includes(day.value)
                    ? 'border-[var(--accent)] bg-[var(--accent)] text-white'
                    : 'border-[var(--border)] bg-[var(--bg-secondary)] text-[var(--text-muted)] hover:border-[var(--accent)] hover:text-[var(--text-primary)]'}`}
                >
                  {day.letter}
                </button>
              ))}
            </div>
          </div>
        )}

        {tab === 'monthly' && (
          <label className="mb-3 block text-xs font-medium text-[var(--text-muted)]">
            Day Of Month
            <select
              value={monthDay}
              onChange={(e) => setMonthDay(Number(e.target.value))}
              className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
            >
              {Array.from({ length: 31 }, (_, i) => i + 1).map((day) => <option key={day} value={day}>{ordinal(day)}</option>)}
            </select>
            {monthDay > 28 && <span className="mt-1 block font-normal">Months without day {monthDay} are skipped.</span>}
          </label>
        )}

        {tab === 'cron' ? (
          <div>
            <div className="flex items-center gap-1.5 text-xs font-medium text-[var(--text-muted)]">
              <label htmlFor="cron-expression">Schedule or cron expression</label>
              <CronHelpButton show={showCronHelp} onToggle={() => setShowCronHelp((open) => !open)} />
            </div>
            <label className="block text-xs font-medium text-[var(--text-muted)]">
              <input
                id="cron-expression"
                value={cronInput}
                onChange={(e) => setCronInput(e.target.value)}
                placeholder="At 04:05 on day-of-month 5   —   or   —   5 4 5 * *"
                className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
              />
              <span className="mt-1 block font-normal">Write it in plain English or as a five-part cron expression. Times use {tzLabel}.</span>
            </label>
            {showCronHelp && <CronHelpPanel />}

            <div className="mt-3 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)]/40 p-3">
              {cronResolving ? (
                <div className="flex items-center gap-2 text-xs text-[var(--text-muted)]"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Checking…</div>
              ) : cronResolved.error ? (
                <div className="text-xs text-red-400">{cronResolved.error}</div>
              ) : cronResolved.expression ? (
                <>
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">Cron</span>
                    <code className="rounded bg-[var(--bg-card)] px-2 py-0.5 font-mono text-sm text-[var(--accent)]">{cronResolved.expression}</code>
                    <span className="text-xs text-[var(--text-primary)]">{cronResolved.description}</span>
                  </div>
                  {cronResolved.nextRuns.length > 0 && (
                    <div className="mt-2 text-xs text-[var(--text-muted)]">
                      Next: {cronResolved.nextRuns.map((run) => utcIsoToZonedInput(run, timezone).replace('T', ' ')).join(' · ')} {tzLabel}
                    </div>
                  )}
                </>
              ) : (
                <div className="text-xs text-[var(--text-muted)]">Type a schedule above to see the exact cron expression.</div>
              )}
            </div>
          </div>
        ) : tab === 'once' ? (
          <label className="block text-xs font-medium text-[var(--text-muted)]">
            Date &amp; Time ({tzLabel})
            <input
              type="datetime-local"
              value={onceAt}
              onChange={(e) => setOnceAt(e.target.value)}
              className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent)] [color-scheme:dark]"
            />
            <span className="mt-1 block font-normal">Runs once at this instant, then switches itself off.</span>
          </label>
        ) : (
          <label className="block text-xs font-medium text-[var(--text-muted)]">
            Time ({tzLabel})
            <input
              type="time"
              value={time}
              onChange={(e) => setTime(e.target.value)}
              className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent)] [color-scheme:dark]"
            />
          </label>
        )}
      </div>

      <p className="mt-3 text-xs text-[var(--text-muted)]">
        <span className="text-[var(--text-primary)]">{summary}</span> · Snapshots and video appear under Test Runs.
      </p>
    </Modal>
  );
}
