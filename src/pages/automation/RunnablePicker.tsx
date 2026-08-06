import { useEffect, useMemo, useState } from 'react';
import { ChevronRight, Code2, FileText, Loader2, Search, Tag, Video, X } from 'lucide-react';

// A runnable = anything the data engine can bind to: a Test Case's script, or a captured recording.
export interface Runnable {
  kind: 'script' | 'recording';
  scriptId?: string; recordingId?: string; caseId?: string; caseName?: string;
  name: string; folderId?: string | null; targetUrl?: string; updatedAt?: string;
  tags?: string[]; // from the linked Test Case — drives tag filtering (e.g. "regression")
}
export const runnableKey = (item: Runnable) => item.scriptId || item.recordingId || item.name;

const UNGROUPED = '__ungrouped__';

async function json(url: string) {
  const response = await fetch(url);
  return response.json();
}

function RunnableRow({ item, selected, onSelect }: { item: Runnable; selected: boolean; onSelect: (item: Runnable) => void }) {
  const tags = (item.tags || []).slice(0, 3);
  return <button type="button" onClick={() => onSelect(item)}
    className={`flex w-full items-center gap-2 py-1.5 pl-8 pr-2 text-left text-sm ${selected ? 'bg-[var(--accent)]/10 text-[var(--accent)]' : 'text-[var(--text-primary)] hover:bg-[var(--bg-secondary)]'}`}>
    {item.kind === 'recording' ? <Video className="h-4 w-4 shrink-0 text-[var(--text-muted)]" /> : <Code2 className="h-4 w-4 shrink-0 text-[var(--accent)]" />}
    <span className="min-w-0 flex-1 truncate">{item.name}</span>
    {tags.map((tag) => <span key={tag} className="hidden shrink-0 rounded bg-[var(--bg-secondary)] px-1.5 py-0.5 text-[10px] text-[var(--text-muted)] sm:inline">{tag}</span>)}
  </button>;
}

// One Test Case's runnables, collapsible. The Test Case is the primary organizing axis (not folders).
function CaseGroup({ group, selectedKey, onSelect }: {
  group: { id: string; name: string; items: Runnable[] }; selectedKey: string; onSelect: (item: Runnable) => void;
}) {
  const [open, setOpen] = useState(true);
  if (!group.items.length) return null;
  const ungrouped = group.id === UNGROUPED;
  return <div>
    <button type="button" onClick={() => setOpen((value) => !value)} aria-label={`${open ? 'Collapse' : 'Expand'} ${group.name}`}
      className="flex w-full items-center gap-1 rounded-md py-1.5 pr-2 text-[var(--text-muted)] hover:bg-[var(--bg-secondary)]">
      <ChevronRight className={`ml-1 h-3.5 w-3.5 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} />
      {ungrouped ? <Video className="h-3.5 w-3.5 shrink-0" /> : <FileText className="h-3.5 w-3.5 shrink-0" />}
      <span className="min-w-0 flex-1 truncate text-left text-xs font-medium uppercase tracking-wide">{group.name}</span>
      <span className="tabular-nums text-xs opacity-70">{group.items.length}</span>
    </button>
    {open && group.items.map((item) => <RunnableRow key={runnableKey(item)} item={item} selected={selectedKey === runnableKey(item)} onSelect={onSelect} />)}
  </div>;
}

// Searchable, Test-Case-grouped, tag-first picker of runnables (primary "RUN WHAT" selector).
// You find a script through its Test Case or by tag — folders are no longer the organizing axis.
export function RunnablePicker({ selectedKey, onSelect }: { selectedKey: string; onSelect: (item: Runnable) => void }) {
  const [runnables, setRunnables] = useState<Runnable[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [activeTags, setActiveTags] = useState<string[]>([]);
  const toggleTag = (tag: string) => setActiveTags((prev) => prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]);

  useEffect(() => {
    setLoading(true);
    json('/api/automation/runnables')
      .then((data) => setRunnables(Array.isArray(data?.runnables) ? data.runnables : []))
      .catch(() => undefined)
      .finally(() => setLoading(false));
  }, []);

  // Distinct tags across all runnables (for the tag-filter chips), sorted by name.
  const allTags = useMemo(() => {
    const set = new Set<string>();
    for (const item of runnables) for (const tag of item.tags || []) set.add(tag);
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [runnables]);

  // A runnable matches when its name/case-name/tags contain the query AND (if tag chips are picked) it carries one.
  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return runnables.filter((item) => {
      const tags = item.tags || [];
      const haystack = `${item.name} ${item.caseName || ''}`.toLowerCase();
      const textOk = !query || haystack.includes(query) || tags.some((t) => t.toLowerCase().includes(query));
      const tagsOk = !activeTags.length || tags.some((t) => activeTags.includes(t));
      return textOk && tagsOk;
    });
  }, [runnables, search, activeTags]);

  // Group the matches by Test Case; case-less runnables (raw recordings) fall into one "Ungrouped" bucket last.
  const groups = useMemo(() => {
    const byCase = new Map<string, { id: string; name: string; items: Runnable[] }>();
    for (const item of filtered) {
      const id = item.caseId || UNGROUPED;
      const name = item.caseName || (item.caseId ? 'Untitled Case' : 'Ungrouped');
      const group = byCase.get(id) || byCase.set(id, { id, name, items: [] }).get(id)!;
      group.items.push(item);
    }
    return Array.from(byCase.values()).sort((a, b) =>
      a.id === UNGROUPED ? 1 : b.id === UNGROUPED ? -1 : a.name.localeCompare(b.name));
  }, [filtered]);

  return <div className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--bg-card)]">
    <div className="shrink-0 border-b border-[var(--border)] p-2">
      <div className="mb-2 px-1 text-sm font-semibold">Run What<span className="ml-1 text-[11px] font-normal text-[var(--text-muted)]">by test case · tag</span></div>
      <label className="relative block">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-muted)]" />
        <input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search by test case, name, or tag (e.g. regression)" aria-label="Search runnables by test case, name, or tag"
          className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] py-1.5 pl-8 pr-3 text-sm outline-none focus:border-[var(--accent)]" />
      </label>
      {allTags.length > 0 && <div className="mt-2 flex flex-wrap items-center gap-1">
        <Tag className="h-3 w-3 text-[var(--text-muted)]" />
        {allTags.map((tag) => {
          const on = activeTags.includes(tag);
          return <button key={tag} type="button" onClick={() => toggleTag(tag)} aria-pressed={on}
            className={`rounded-full border px-2 py-0.5 text-[11px] ${on ? 'border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--accent)]' : 'border-[var(--border)] text-[var(--text-muted)] hover:border-[var(--accent)]'}`}>{tag}</button>;
        })}
        {activeTags.length > 0 && <button type="button" onClick={() => setActiveTags([])} className="ml-1 inline-flex items-center gap-0.5 text-[11px] text-[var(--text-muted)] hover:text-[var(--text-primary)]"><X className="h-3 w-3" />clear</button>}
      </div>}
    </div>
    <div className="min-h-0 flex-1 overflow-y-auto p-1">
      {loading ? <div className="flex items-center gap-2 p-4 text-sm text-[var(--text-muted)]"><Loader2 className="h-4 w-4 animate-spin" />Loading…</div>
        : !runnables.length ? <div className="p-4 text-sm text-[var(--text-muted)]">No test cases, scripts, or recordings yet.</div>
        : !groups.length ? <div className="p-4 text-sm text-[var(--text-muted)]">No Runnables Match{activeTags.length ? ` tag ${activeTags.map((t) => `“${t}”`).join(', ')}` : ' your search'}.</div>
        : groups.map((group) => <CaseGroup key={group.id} group={group} selectedKey={selectedKey} onSelect={onSelect} />)}
    </div>
  </div>;
}
