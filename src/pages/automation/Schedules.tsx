import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, ChevronRight, Code2, Folder, Info, Loader2, Search, Trash2, CalendarClock, Plus, Pencil, Eye } from 'lucide-react';
import { showConfirm, showToast } from '@/src/lib/dialog';
import { Modal } from '@/src/components/Modal';
import { RequiredMark } from '@/src/components/RequiredMark';
import { AutomationRunArtifacts } from '@/src/components/AutomationRunArtifacts';
import { useRemoteAgentFlag, useSchedules, useRecordings, useJobs, useAgentEvents, jobStatusMeta, ACTIVE_JOB_STATUSES, type Schedule, type Job } from '@/src/lib/useAutomation';

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
  const flag = useRemoteAgentFlag();
  const { schedules, loading, refresh } = useSchedules();
  const { recordings } = useRecordings();
  const { jobs, refresh: refreshJobs } = useJobs();
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<Schedule | null>(null);
  const [selectedScheduleId, setSelectedScheduleId] = useState<string | null>(null);

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

  // SSE pushes job.progress/job.done frames faster than the 8s poll — refresh jobs on any of them.
  useAgentEvents((event) => {
    if (event.scopeType === 'job') void refreshJobs();
  });

  const selectedSchedule = schedules.find((schedule) => schedule.id === selectedScheduleId) || null;
  const selectedRecording = selectedSchedule ? recordings.find((recording) => recording.id === selectedSchedule.recordingId) || null : null;
  const selectedActiveJob = selectedSchedule ? activeJobByScheduleId.get(selectedSchedule.id) || null : null;

  const nameFor = useMemo(() => {
    const m = new Map(recordings.map((r) => [r.id, r.name] as const));
    return (id: string) => m.get(id) || id;
  }, [recordings]);

  const toggle = async (id: string, enabled: boolean) => {
    try { const response = await fetch(`/api/automation/schedules/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: !enabled }) }); if (!response.ok) throw new Error(); void refresh(); }
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
                <th className="px-4 py-2.5 font-medium">Schedule</th>
                <th className="px-4 py-2.5 font-medium">Runs At</th>
                <th className="px-4 py-2.5 font-medium">Last Run</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
                <th className="px-4 py-2.5 font-medium">Enabled</th>
                <th className="px-4 py-2.5 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {schedules.map((s) => {
                const activeJob = activeJobByScheduleId.get(s.id) || null;
                return (
                <tr key={s.id} onClick={() => setSelectedScheduleId(s.id)} className="cursor-pointer border-b border-[var(--border)] last:border-0 hover:bg-[var(--bg-secondary)] focus-within:bg-[var(--bg-secondary)]">
                  <td className="px-4 py-2.5 font-medium text-[var(--text-primary)]">
                    <button type="button" onClick={() => setSelectedScheduleId(s.id)} className="inline-flex items-center gap-1.5 text-left hover:text-[var(--accent)]" title="Open scheduled test">
                      {s.title || nameFor(s.recordingId)} <Eye className="h-3.5 w-3.5" />
                    </button>
                    {s.title && <div className="text-xs font-normal text-[var(--text-muted)]">{nameFor(s.recordingId)}</div>}
                  </td>
                  <td className="px-4 py-2.5 text-xs text-[var(--text-muted)]">{fmt(s.nextRunAt)}</td>
                  <td className="px-4 py-2.5 text-xs text-[var(--text-muted)]">{fmt(s.lastRunAt)}</td>
                  <td className="px-4 py-2.5">
                    {activeJob ? (
                      <span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium ${jobStatusMeta(activeJob.status).cls}`}>
                        <Loader2 className="h-3 w-3 animate-spin" /> {jobStatusMeta(activeJob.status).label}
                      </span>
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

      <NewScheduleModal isOpen={createOpen} onClose={() => setCreateOpen(false)} onCreated={refresh} />
      {editing && <EditScheduleModal schedule={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); refresh(); }} />}
      <ScheduleRecordingModal schedule={selectedSchedule} recording={selectedRecording} activeJob={selectedActiveJob} onClose={() => setSelectedScheduleId(null)} />
    </div>
  );
}

function ScheduleRecordingModal({ schedule, recording, activeJob, onClose }: { schedule: Schedule | null; recording: any | null; activeJob: Job | null; onClose: () => void }) {
  return <Modal isOpen={!!schedule} onClose={onClose} title="Scheduled test" size="xl"
    footer={<div className="flex justify-end"><button type="button" onClick={onClose} className="rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-sm text-[var(--text-primary)]">Close</button></div>}>
    {!schedule ? null : <div className="space-y-4">
      <div><div className="text-lg font-medium text-[var(--text-primary)]">{recording?.name || schedule.recordingId}</div><p className="mt-1 text-sm text-[var(--text-muted)]">This recording runs when the schedule fires.</p></div>
      <dl className="grid gap-3 text-sm sm:grid-cols-2">
        {schedule.title && <div><dt className="text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">Title</dt><dd className="mt-1 text-[var(--text-primary)]">{schedule.title}</dd></div>}
        <div><dt className="text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">Next run</dt><dd className="mt-1 text-[var(--text-primary)]">{fmt(schedule.nextRunAt)}</dd></div>
        <div><dt className="text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">Schedule</dt><dd className="mt-1 font-mono text-[var(--text-primary)]">{schedule.cron || schedule.kind} <span className="font-sans text-xs text-[var(--text-muted)]">({timezoneLabel(schedule.timezone || 'UTC')})</span></dd></div>
        <div><dt className="text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">Target URL</dt><dd className="mt-1 break-all text-[var(--text-primary)]">{recording?.appUrl || 'Not available'}</dd></div>
        <div><dt className="text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">Test case</dt><dd className="mt-1 text-[var(--text-primary)]">{recording?.metadata?.caseId || 'Not linked'}</dd></div>
      </dl>
      {activeJob && <AutomationRunArtifacts jobId={activeJob.id} />}
      {recording?.script ? <pre className="max-h-80 overflow-auto rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] p-3 text-xs leading-5 text-[var(--text-primary)]"><code>{recording.script}</code></pre> : <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-300">The recording is no longer available.</div>}
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

  const labelOf = (tz: string) => tz === detected ? `${timezoneLabel(tz)} — detected` : timezoneLabel(tz);
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
  return <Modal isOpen onClose={onClose} title="Edit schedule" size="md" footer={<div className="flex justify-end gap-2"><button onClick={onClose} className="rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-sm text-[var(--text-primary)]">Cancel</button><button onClick={save} disabled={busy} className="inline-flex items-center gap-2 rounded-md bg-[var(--accent)] px-3 py-2 text-sm font-medium text-white hover:bg-[var(--accent-hover)] disabled:opacity-50">{busy && <Loader2 className="h-4 w-4 animate-spin" />} Save Changes</button></div>}>
    <label className="block text-xs font-medium text-[var(--text-muted)]">Schedule title
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

type FolderNode = { id: string; name: string; parentId?: string | null; children: FolderNode[] };
type RepositoryScript = { id: string; name?: string; title?: string; filename?: string; folderId?: string | null; code?: string };
const UNCATEGORIZED_ID = '__uncategorized__';

function buildFolderTree(folders: Omit<FolderNode, 'children'>[]): FolderNode[] {
  const byId = new Map(folders.map((folder) => [folder.id, { ...folder, children: [] } as FolderNode]));
  const roots: FolderNode[] = [];
  byId.forEach((folder) => {
    const parent = folder.parentId ? byId.get(folder.parentId) : undefined;
    (parent ? parent.children : roots).push(folder);
  });
  const sort = (nodes: FolderNode[]) => nodes.sort((a, b) => a.name.localeCompare(b.name)).forEach((node) => sort(node.children));
  sort(roots);
  return roots;
}

function FolderPicker({ node, selectedId, counts, onSelect, depth = 0 }: { key?: string; node: FolderNode; selectedId: string; counts: Map<string, number>; onSelect: (id: string) => void; depth?: number }) {
  const [open, setOpen] = useState(true);
  const hasChildren = node.children.length > 0;
  return <div>
    <div className={`flex items-center rounded-md ${selectedId === node.id ? 'bg-[var(--accent)]/10 text-[var(--accent)]' : 'text-[var(--text-muted)] hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)]'}`}>
      <button type="button" onClick={() => hasChildren && setOpen((value) => !value)} aria-label={`${open ? 'Collapse' : 'Expand'} ${node.name}`} className="ml-1 rounded p-1 disabled:opacity-0" disabled={!hasChildren}>
        <ChevronRight className={`h-3.5 w-3.5 transition-transform ${open ? 'rotate-90' : ''}`} />
      </button>
      <button type="button" onClick={() => onSelect(node.id)} className="flex min-w-0 flex-1 items-center gap-2 py-2 pr-2 text-left text-sm" style={{ paddingLeft: `${depth * 12}px` }}>
        <Folder className="h-4 w-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{node.name}</span>
        <span className="text-xs tabular-nums opacity-70">{counts.get(node.id) || 0}</span>
      </button>
    </div>
    {open && node.children.map((child) => <FolderPicker key={child.id} node={child} selectedId={selectedId} counts={counts} onSelect={onSelect} depth={depth + 1} />)}
  </div>;
}

function NewScheduleModal({ isOpen, onClose, onCreated }: { isOpen: boolean; onClose: () => void; onCreated: () => void }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
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
  const [folders, setFolders] = useState<FolderNode[]>([]);
  const [scripts, setScripts] = useState<RepositoryScript[]>([]);
  const [selectedFolderId, setSelectedFolderId] = useState('');
  const [search, setSearch] = useState('');

  useEffect(() => {
    if (!isOpen) return;
    setLoading(true);
    setSelected(new Set());
    setTitle('');
    setSearch('');
    Promise.all([fetch('/api/folders').then((r) => r.json()), fetch('/api/scripts').then((r) => r.json())])
      .then(([folderData, scriptData]) => {
        const available = (Array.isArray(scriptData) ? scriptData : [])
          .filter((script: RepositoryScript) => String(script.code || '').trim())
          .map((script: RepositoryScript) => ({ ...script, folderId: script.folderId == null ? null : String(script.folderId) }));
        const normalizedFolders = (Array.isArray(folderData) ? folderData : []).map((folder) => ({ ...folder, id: String(folder.id), parentId: folder.parentId == null ? null : String(folder.parentId) }));
        const tree = buildFolderTree(normalizedFolders);
        tree.unshift({ id: UNCATEGORIZED_ID, name: 'Uncategorized', children: [] });
        setFolders(tree);
        setScripts(available);
        setSelectedFolderId(available[0]?.folderId || UNCATEGORIZED_ID);
      })
      .catch(() => showToast('Could not load repository scripts.', { tone: 'error' }))
      .finally(() => setLoading(false));
  }, [isOpen]);

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

  const counts = useMemo(() => {
    const result = new Map<string, number>();
    scripts.forEach((script) => result.set(script.folderId || UNCATEGORIZED_ID, (result.get(script.folderId || UNCATEGORIZED_ID) || 0) + 1));
    return result;
  }, [scripts]);
  const visibleScripts = useMemo(() => {
    const query = search.trim().toLowerCase();
    return scripts.filter((script) => query
      ? [script.name, script.title, script.filename].some((value) => String(value || '').toLowerCase().includes(query))
      : (script.folderId || UNCATEGORIZED_ID) === selectedFolderId);
  }, [scripts, search, selectedFolderId]);
  const toggle = (id: string) => setSelected((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const toggleWeekday = (day: number) => setWeekdays((prev) => (prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day]));
  const tzLabel = timezoneLabel(timezone);
  const cron = tab === 'cron' ? cronResolved.expression : buildCron(tab, time, weekdays, monthDay);
  const runAt = tab === 'once' ? zonedInputToUtcIso(onceAt, timezone) : '';
  const summary = tab === 'once' ? describeRunAt(runAt, timezone, tzLabel) : tab === 'cron' ? (cronResolved.description || cronResolved.error || 'Type a schedule or a cron expression') : describeSchedule(tab, time, weekdays, monthDay, tzLabel);
  const scheduleReady = tab === 'once' ? Boolean(runAt) : Boolean(cron) && !(tab === 'cron' && cronResolved.error);

  const submit = async () => {
    if (selected.size === 0) { showToast('Select at least one item.', { tone: 'error' }); return; }
    if (!scheduleReady) { showToast(tab === 'weekly' ? 'Pick at least one day of the week.' : tab === 'cron' ? (cronResolved.error || 'Enter a schedule we can read.') : 'Pick a date and time.', { tone: 'error' }); return; }
    // A one-off in the past would be dispatched by the very next scheduler tick.
    if (tab === 'once' && Date.parse(runAt) <= Date.now()) { showToast(`Pick a future date and time (${tzLabel}).`, { tone: 'error' }); return; }
    setBusy(true);
    try {
      const results = await Promise.all([...selected].map(async (id) => {
        const response = await fetch('/api/automation/schedules', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(tab === 'once' ? { scriptId: id, kind: 'once', runAt, timezone, title: title.trim() } : { scriptId: id, kind: 'cron', cron, timezone, title: title.trim() }) });
        if (!response.ok) throw new Error((await response.json().catch(() => ({})))?.error || 'Could not create the schedule.');
        return true;
      }));
      const ok = results.filter(Boolean).length;
      if (ok === 0) throw new Error();
      showToast(`Created ${ok} cron schedule${ok > 1 ? 's' : ''}.`, { tone: 'success' });
      if (ok < selected.size) showToast(`${selected.size - ok} script${selected.size - ok > 1 ? 's were' : ' was'} skipped.`, { tone: 'error' });
      setSelected(new Set());
      onCreated();
      onClose();
    } catch (error: any) { showToast(error?.message || 'Could not create the schedule.', { tone: 'error' }); }
    finally { setBusy(false); }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="New schedule" size="xl"
      footer={<div className="flex justify-end gap-2">
        <button onClick={onClose} className="rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-sm text-[var(--text-primary)]">Cancel</button>
        <button onClick={submit} disabled={busy || selected.size === 0 || !scheduleReady} className="inline-flex items-center gap-2 rounded-md bg-[var(--accent)] px-3 py-2 text-sm font-medium text-white hover:bg-[var(--accent-hover)] disabled:opacity-50">
          {busy && <Loader2 className="h-4 w-4 animate-spin" />} Create Schedule
        </button>
      </div>}>
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-medium text-[var(--text-primary)]">Select Scripts from Test Repository<RequiredMark /></div>
          <div className="mt-0.5 text-xs text-[var(--text-muted)]">{selected.size} selected</div>
        </div>
        <label className="relative block w-full max-w-xs">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-muted)]" />
          <input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search scripts"
            className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] py-2 pl-8 pr-3 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent)]" />
        </label>
      </div>
      <div className="grid min-h-64 grid-cols-[minmax(180px,0.8fr)_minmax(0,2fr)] overflow-hidden rounded-md border border-[var(--border)]">
        <div className="max-h-72 overflow-auto border-r border-[var(--border)] bg-[var(--bg-secondary)]/40 p-2">
          {folders.map((folder) => <FolderPicker key={folder.id} node={folder} selectedId={selectedFolderId} counts={counts} onSelect={(id) => { setSelectedFolderId(id); setSearch(''); }} />)}
        </div>
        <div className="max-h-72 overflow-auto">
          {loading ? <div className="flex items-center gap-2 p-4 text-sm text-[var(--text-muted)]"><Loader2 className="h-4 w-4 animate-spin" /> Loading scripts…</div>
            : visibleScripts.length === 0 ? <div className="p-4 text-sm text-[var(--text-muted)]">{search ? 'No scripts match your search.' : 'No scripts in this folder.'}</div>
            : visibleScripts.map((script) => (
              <label key={script.id} className="flex cursor-pointer items-center gap-3 border-b border-[var(--border)] px-3 py-2.5 text-sm last:border-0 hover:bg-[var(--bg-secondary)]">
                <input type="checkbox" checked={selected.has(script.id)} onChange={() => toggle(script.id)} className="h-4 w-4 shrink-0 accent-[var(--accent)]" />
                <Code2 className="h-4 w-4 shrink-0 text-[var(--accent)]" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium text-[var(--text-primary)]">{script.name || script.title || script.filename}</span>
                  <span className="block truncate text-xs text-[var(--text-muted)]">{script.filename || script.id}</span>
                </span>
              </label>
            ))}
        </div>
      </div>
      <label className="mt-4 block text-xs font-medium text-[var(--text-muted)]">
        Schedule title
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
