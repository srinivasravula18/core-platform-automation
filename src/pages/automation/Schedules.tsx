import { useEffect, useMemo, useState } from 'react';
import { ChevronRight, Code2, Folder, Loader2, Search, Trash2, CalendarClock, Plus } from 'lucide-react';
import { showConfirm, showToast } from '@/src/lib/dialog';
import { Modal } from '@/src/components/Modal';
import { RequiredMark } from '@/src/components/RequiredMark';
import { useRemoteAgentFlag, useSchedules, useRecordings } from '@/src/lib/useAutomation';

function fmt(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
}

type ScheduleTab = 'daily' | 'weekly' | 'monthly' | 'once';

const SCHEDULE_TABS: Array<{ id: ScheduleTab; label: string }> = [
  { id: 'daily', label: 'Daily' },
  { id: 'weekly', label: 'Weekly' },
  { id: 'monthly', label: 'Monthly' },
  { id: 'once', label: 'Specific Date' },
];

/** `datetime-local` is timezone-naive; this modal is UTC throughout, so read it as UTC. */
function runAtFromUtcInput(value: string): string {
  const parsed = Date.parse(`${value}:00Z`);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : '';
}

/** Default the picker to the next whole hour, in UTC, so it is never a past instant. */
function nextHourUtcInput(): string {
  const d = new Date();
  d.setUTCMinutes(0, 0, 0);
  d.setUTCHours(d.getUTCHours() + 1);
  return d.toISOString().slice(0, 16);
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
function describeSchedule(tab: ScheduleTab, time: string, weekdays: number[], monthDay: number): string {
  if (tab === 'daily') return `Everyday at ${time} UTC`;
  if (tab === 'weekly') {
    if (!weekdays.length) return 'Pick at least one day';
    const names = [...weekdays].sort((a, b) => a - b).map((d) => WEEKDAYS[d].name);
    return `Every ${names.join(', ')} at ${time} UTC`;
  }
  if (tab === 'monthly') return `On the ${ordinal(monthDay)} of every month at ${time} UTC`;
  return '';
}

/** Human echo for a one-off, rendered from the UTC instant that will actually be stored. */
function describeRunAt(runAt: string): string {
  if (!runAt) return 'Pick a date and time';
  const d = new Date(runAt);
  return `Once on ${d.toISOString().slice(0, 10)} at ${d.toISOString().slice(11, 16)} UTC`;
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
                <th className="px-4 py-2.5 font-medium">Recording</th>
                <th className="px-4 py-2.5 font-medium">Runs At</th>
                <th className="px-4 py-2.5 font-medium">Last Run</th>
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
  const [tab, setTab] = useState<ScheduleTab>('daily');
  const [time, setTime] = useState('02:00');
  const [weekdays, setWeekdays] = useState<number[]>([1]);
  const [monthDay, setMonthDay] = useState(1);
  const [onceAt, setOnceAt] = useState(nextHourUtcInput());
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
  const cron = buildCron(tab, time, weekdays, monthDay);
  const runAt = tab === 'once' ? runAtFromUtcInput(onceAt) : '';
  const summary = tab === 'once' ? describeRunAt(runAt) : describeSchedule(tab, time, weekdays, monthDay);
  const scheduleReady = tab === 'once' ? Boolean(runAt) : Boolean(cron);

  const submit = async () => {
    if (selected.size === 0) { showToast('Select at least one item.', { tone: 'error' }); return; }
    if (!scheduleReady) { showToast(tab === 'weekly' ? 'Pick at least one day of the week.' : 'Pick a date and time.', { tone: 'error' }); return; }
    // A one-off in the past would be dispatched by the very next scheduler tick.
    if (tab === 'once' && Date.parse(runAt) <= Date.now()) { showToast('Pick a future date and time (UTC).', { tone: 'error' }); return; }
    setBusy(true);
    try {
      const results = await Promise.all([...selected].map(async (id) => {
        const response = await fetch('/api/automation/schedules', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(tab === 'once' ? { scriptId: id, kind: 'once', runAt, timezone: 'UTC' } : { scriptId: id, kind: 'cron', cron, timezone: 'UTC' }) });
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
      <div className="mt-4 text-sm font-medium text-[var(--text-primary)]">Schedule (UTC)<RequiredMark /></div>
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

        {tab === 'once' ? (
          <label className="block text-xs font-medium text-[var(--text-muted)]">
            Date &amp; Time (UTC)
            <input
              type="datetime-local"
              value={onceAt}
              onChange={(e) => setOnceAt(e.target.value)}
              className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent)] [color-scheme:dark]"
            />
            <span className="mt-1 block font-normal">Runs once at this UTC instant, then switches itself off.</span>
          </label>
        ) : (
          <label className="block text-xs font-medium text-[var(--text-muted)]">
            Time (UTC)
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
