import { useEffect, useMemo, useRef, useState } from 'react';
import { Search, Tag as TagIcon, Loader2 } from 'lucide-react';
import { Modal } from './Modal';
import { buildListQuery, fetchTagCatalog, type EntityKind, type TagCatalogEntry, type TagQuery } from '@/src/lib/entityLinking';

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
  /** Called with the selected id set + the tag query used, so callers can persist a tag-defined
   *  group (definition.tagQuery) and later surface review-gated drift. */
  onConfirm: (selectedIds: string[], meta: { tagQuery: TagQuery }) => void | Promise<void>;
  /** Optional pre-applied tag filter (e.g. opened from a tag chip on a list page). */
  initialTags?: string[];
}

// Compare/count tags ignoring case + the leading @/# marker.
const tagKey = (t: any) => String(t || '').trim().toLowerCase().replace(/^[@#]+/, '');

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
  const [tagMatch, setTagMatch] = useState<'all' | 'any'>('all');
  const [items, setItems] = useState<any[]>([]);
  const [catalog, setCatalog] = useState<TagCatalogEntry[]>([]);
  // All items of THIS target (unfiltered) — used to count tags for the current entity type, so chip
  // counts reflect e.g. "suites with @validation" rather than the global cross-entity catalog count.
  const [allTargetItems, setAllTargetItems] = useState<any[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set(initialSelectedIds));
  // While true (fresh compose, no manual edits yet), the selection tracks the tag-matched items so
  // picking a tag actually SELECTS its cases (not just filters). Turns off on any manual item toggle.
  const [autoSelect, setAutoSelect] = useState(initialSelectedIds.length === 0);
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
    setTagMatch('all');
    setQuery('');
    setAutoSelect(initialSelectedIds.length === 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  // Compose-by-tag: when a tag filter is active and the user hasn't manually edited the selection yet,
  // keep the selection equal to the matched items — so choosing a tag selects its cases automatically.
  useEffect(() => {
    if (!isOpen || !autoSelect || !activeTags.length) return;
    setSelected(new Set(items.map((it: any) => it.id)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, autoSelect, isOpen]);

  // Load the tag catalog + all target items (for target-scoped tag counts) when opened.
  useEffect(() => {
    if (!isOpen) return;
    fetchTagCatalog().then(setCatalog).catch(() => setCatalog([]));
    fetch(`/api/${target}`).then((r) => r.json()).then((d) => setAllTargetItems(Array.isArray(d) ? d : [])).catch(() => setAllTargetItems([]));
  }, [isOpen, target]);

  // Debounced candidate fetch through the server-side tag-query search (include any/all + exclude).
  useEffect(() => {
    if (!isOpen) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    setLoading(true);
    debounceRef.current = setTimeout(async () => {
      try {
        const qs = buildListQuery({ q: query, tags: activeTags, tagMatch });
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
  }, [isOpen, query, tagsKey, tagMatch, target, excludeKey]);

  const labelKey = LABEL_KEY[target];
  // Tag counts for THIS target entity (not the global catalog), so a chip shows how many
  // suites/cases/plans/runs actually carry it.
  const tagCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const it of allTargetItems) {
      for (const tg of (Array.isArray(it?.tags) ? it.tags : [])) m.set(tagKey(tg), (m.get(tagKey(tg)) || 0) + 1);
    }
    return m;
  }, [allTargetItems]);
  // Chips relevant to this target: catalog names that appear on ≥1 target item, by descending count.
  const chips = useMemo(() => catalog
    .map((t) => ({ name: t.name, count: tagCounts.get(tagKey(t.name)) || 0 }))
    .filter((t) => t.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 24), [catalog, tagCounts]);

  // Simple include toggle: click to include the tag in the query, click again to clear it.
  const toggleTag = (name: string) =>
    setActiveTags((c) => (c.includes(name) ? c.filter((t) => t !== name) : [...c, name]));
  const toggleItem = (id: string) => {
    setAutoSelect(false); // manual edit — stop tracking the tag matches
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const allShownSelected = items.length > 0 && items.every((it) => selected.has(it.id));
  const selectAllMatching = () => {
    setAutoSelect(false);
    setSelected((cur) => {
      const next = new Set(cur);
      if (allShownSelected) items.forEach((it) => next.delete(it.id));
      else items.forEach((it) => next.add(it.id));
      return next;
    });
  };

  // The tag query the user composed with (chips + All/Any) — persisted as the group's definition so
  // future matching cases surface as review-gated drift. Empty when composing purely by search.
  const buildTagQuery = (): TagQuery =>
    (activeTags.length ? (tagMatch === 'all' ? { all: [...activeTags] } : { any: [...activeTags] }) : {});

  const confirm = async () => {
    setSaving(true);
    try {
      await onConfirm(Array.from(selected), { tagQuery: buildTagQuery() });
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
          {/* Match mode for the INCLUDE tags: All (intersection) vs Any (union). */}
          <div className="inline-flex overflow-hidden rounded-md border border-[var(--border)] text-xs">
            {(['all', 'any'] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setTagMatch(m)}
                className={`px-2.5 py-1.5 font-medium capitalize transition-colors ${tagMatch === m ? 'bg-[var(--accent)] text-white' : 'bg-[var(--bg-secondary)] text-[var(--text-muted)] hover:text-[var(--text-primary)]'}`}
                title={m === 'all' ? 'Match cases with ALL selected tags' : 'Match cases with ANY selected tag'}
              >
                {m}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={selectAllMatching}
            disabled={!items.length}
            className="rounded-md border border-[var(--border)] px-2.5 py-1.5 text-xs font-medium text-[var(--accent)] hover:bg-[var(--bg-secondary)] disabled:opacity-40"
          >
            {allShownSelected ? 'Clear matching' : 'Select all matching'}
          </button>
        </div>

        {/* Tag chips scoped to THIS target. Count = how many of this entity carry the tag.
            Click to include; click again to clear. */}
        {chips.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <TagIcon className="h-3.5 w-3.5 text-[var(--text-muted)]" />
            {chips.map((t) => {
              const inc = activeTags.includes(t.name);
              const cls = inc
                ? 'border-[var(--accent)] bg-[var(--accent)] text-white'
                : 'border-[var(--border)] bg-[var(--bg-secondary)] text-[var(--text-muted)] hover:border-[var(--accent)]';
              return (
                <button
                  key={t.name}
                  type="button"
                  onClick={() => toggleTag(t.name)}
                  className={`rounded-full border px-2 py-0.5 text-xs transition-colors ${cls}`}
                  title={inc ? 'Included — click to remove' : `${t.count} ${target} tagged — click to include`}
                >
                  {t.name} <span className="opacity-60">{t.count}</span>
                </button>
              );
            })}
          </div>
        )}

        {/* Live count of what the current query matches, so the number always reflects the list below. */}
        <div className="text-xs text-[var(--text-muted)]">
          {loading ? 'Searching…' : `${items.length} ${target} match${(activeTags.length || query.trim()) ? ' the current filter' : ''}`}
        </div>

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
