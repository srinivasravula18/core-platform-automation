import { useEffect, useMemo, useRef, useState } from 'react';
import { Search, Tag as TagIcon, Loader2 } from 'lucide-react';
import { Modal } from './Modal';
import { buildListQuery, fetchTagCatalog, type EntityKind, type TagCatalogEntry } from '@/src/lib/entityLinking';

/**
 * The one unified "Link / Map" picker, reused everywhere cases/suites/plans/runs are
 * associated — and for tag-driven assembly of new groupings. It fetches candidates through
 * the server-side search endpoint (text + tag + folder), shows the shared tag catalog as a
 * chip filter, and returns the selected ids to the caller (which persists membership).
 *
 * It is intentionally persistence-agnostic: it surfaces the final selection via onConfirm,
 * so the same component serves membership edits (diff vs initialSelectedIds → link/unlink)
 * and "Create X from selection" (collect ids → create a new suite/plan/run).
 */
export interface EntityLinkerProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  /** Which entity type is being picked. */
  target: EntityKind;
  /** Ids already linked (pre-checked) — the baseline the caller diffs against. */
  initialSelectedIds?: string[];
  /** Ids to hide from the candidate list (e.g. the source entity itself). */
  excludeIds?: string[];
  confirmLabel?: string;
  /** Called with the full selected id set when the user confirms. */
  onConfirm: (selectedIds: string[]) => void | Promise<void>;
  /** Optional pre-applied tag filter (e.g. opened from a tag chip on a list page). */
  initialTags?: string[];
}

const LABEL_KEY: Record<EntityKind, 'title' | 'name'> = {
  cases: 'title',
  suites: 'name',
  plans: 'name',
  runs: 'name',
};

export function EntityLinker({
  isOpen,
  onClose,
  title,
  target,
  initialSelectedIds = [],
  excludeIds = [],
  confirmLabel,
  onConfirm,
  initialTags = [],
}: EntityLinkerProps) {
  const [query, setQuery] = useState('');
  const [activeTags, setActiveTags] = useState<string[]>(initialTags);
  const [folderId, setFolderId] = useState('');
  const [items, setItems] = useState<any[]>([]);
  const [catalog, setCatalog] = useState<TagCatalogEntry[]>([]);
  const [folders, setFolders] = useState<any[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set(initialSelectedIds));
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Stable keys so the fetch effect doesn't re-run every render on fresh array identities.
  const excludeKey = excludeIds.join(',');
  const tagsKey = activeTags.join(',');
  const excluded = useMemo(() => new Set(excludeIds), [excludeKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reset local state each time the linker is (re)opened so a stale selection never leaks
  // between two different sources.
  useEffect(() => {
    if (!isOpen) return;
    setSelected(new Set(initialSelectedIds));
    setActiveTags(initialTags);
    setQuery('');
    setFolderId('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  // Load the tag catalog + folders once when opened.
  useEffect(() => {
    if (!isOpen) return;
    fetchTagCatalog().then(setCatalog).catch(() => setCatalog([]));
    fetch('/api/folders').then((r) => r.json()).then((d) => setFolders(Array.isArray(d) ? d : [])).catch(() => setFolders([]));
  }, [isOpen]);

  // Debounced candidate fetch through the server-side search endpoint (Phase 2).
  useEffect(() => {
    if (!isOpen) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    setLoading(true);
    debounceRef.current = setTimeout(async () => {
      try {
        const qs = buildListQuery({ q: query, tags: activeTags, folderId, tagMatch: 'all' });
        const res = await fetch(`/api/${target}${qs}`);
        const data = res.ok ? await res.json() : [];
        setItems(Array.isArray(data) ? data.filter((it: any) => !excluded.has(it.id)) : []);
      } catch {
        setItems([]);
      } finally {
        setLoading(false);
      }
    }, 250);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, query, tagsKey, folderId, target, excludeKey]);

  const labelKey = LABEL_KEY[target];
  const toggleTag = (name: string) =>
    setActiveTags((cur) => (cur.includes(name) ? cur.filter((t) => t !== name) : [...cur, name]));
  const toggleItem = (id: string) =>
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  const allShownSelected = items.length > 0 && items.every((it) => selected.has(it.id));
  const selectAllMatching = () =>
    setSelected((cur) => {
      const next = new Set(cur);
      if (allShownSelected) items.forEach((it) => next.delete(it.id));
      else items.forEach((it) => next.add(it.id));
      return next;
    });

  const confirm = async () => {
    setSaving(true);
    try {
      await onConfirm(Array.from(selected));
    } finally {
      setSaving(false);
    }
  };

  const footer = (
    <div className="flex items-center justify-between gap-3">
      <span className="text-xs text-[var(--text-muted)]">{selected.size} selected</span>
      <div className="flex items-center gap-2">
        <button type="button" onClick={onClose} className="rounded-md border border-[var(--border)] px-3 py-1.5 text-sm text-[var(--text-primary)] hover:bg-[var(--bg-secondary)]">Cancel</button>
        <button
          type="button"
          onClick={confirm}
          disabled={saving}
          className="inline-flex items-center gap-2 rounded-md bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-white hover:bg-[var(--accent-hover)] disabled:opacity-50"
        >
          {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {confirmLabel || `Use ${selected.size} selected`}
        </button>
      </div>
    </div>
  );

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={title} footer={footer}>
      <div className="flex flex-col gap-3">
        {/* Toolbar: search + folder + select-all */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[220px] flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--text-muted)]" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={`Search ${target}…`}
              className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] py-1.5 pl-8 pr-2.5 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
            />
          </div>
          <select
            value={folderId}
            onChange={(e) => setFolderId(e.target.value)}
            className="rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2.5 py-1.5 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
          >
            <option value="">All folders</option>
            {folders.map((f) => <option key={f.id} value={f.id}>{f.path || f.name}</option>)}
          </select>
          <button
            type="button"
            onClick={selectAllMatching}
            disabled={!items.length}
            className="rounded-md border border-[var(--border)] px-2.5 py-1.5 text-xs font-medium text-[var(--accent)] hover:bg-[var(--bg-secondary)] disabled:opacity-40"
          >
            {allShownSelected ? 'Clear matching' : 'Select all matching'}
          </button>
        </div>

        {/* Tag chip filter (from the shared catalog) */}
        {catalog.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <TagIcon className="h-3.5 w-3.5 text-[var(--text-muted)]" />
            {catalog.slice(0, 24).map((t) => {
              const on = activeTags.includes(t.name);
              return (
                <button
                  key={t.name}
                  type="button"
                  onClick={() => toggleTag(t.name)}
                  className={`rounded-full border px-2 py-0.5 text-xs transition-colors ${on
                    ? 'border-[var(--accent)] bg-[var(--accent)] text-white'
                    : 'border-[var(--border)] bg-[var(--bg-secondary)] text-[var(--text-muted)] hover:border-[var(--accent)]'}`}
                  style={!on && t.color ? { borderColor: t.color, color: t.color } : undefined}
                  title={`${t.count} tagged`}
                >
                  {t.name} <span className="opacity-60">{t.count}</span>
                </button>
              );
            })}
          </div>
        )}

        {/* Candidate list */}
        <div className="max-h-[46vh] min-h-[160px] overflow-auto rounded-md border border-[var(--border)] bg-[var(--bg-secondary)]/40">
          {loading ? (
            <div className="flex items-center justify-center gap-2 px-3 py-8 text-sm text-[var(--text-muted)]">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </div>
          ) : items.length === 0 ? (
            <div className="px-3 py-8 text-center text-sm text-[var(--text-muted)]">
              No {target} match the current search and filters.
            </div>
          ) : items.map((it) => (
            <label key={it.id} className="flex cursor-pointer items-start gap-2 border-b border-[var(--border)] px-3 py-2 text-sm last:border-0 hover:bg-[var(--bg-secondary)]">
              <input type="checkbox" className="mt-0.5" checked={selected.has(it.id)} onChange={() => toggleItem(it.id)} />
              <span className="shrink-0 pt-0.5 font-mono text-xs text-[var(--text-muted)]">{it.id}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[var(--text-primary)]">{it[labelKey] || it.name || it.title || '(untitled)'}</span>
                {Array.isArray(it.tags) && it.tags.length > 0 && (
                  <span className="mt-0.5 flex flex-wrap gap-1">
                    {it.tags.slice(0, 6).map((tag: string) => (
                      <span key={tag} className="rounded-full bg-[var(--bg-card)] px-1.5 py-0.5 text-[10px] text-[var(--text-muted)]">{tag}</span>
                    ))}
                  </span>
                )}
              </span>
            </label>
          ))}
        </div>
      </div>
    </Modal>
  );
}
