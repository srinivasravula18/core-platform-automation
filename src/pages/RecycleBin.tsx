import { useCallback, useEffect, useMemo, useState } from 'react';
import { Trash2, RotateCcw, Search, Loader2, Info } from 'lucide-react';
import { Timestamp } from '@/src/components/Timestamp';
import { Modal } from '@/src/components/Modal';
import { showToast, showAlert } from '@/src/lib/dialog';
import { cn } from '@/src/lib/utils';

interface DeletedItem {
  type: string;
  noun: string;
  id: string;
  label: string;
  deletedAt: string;
  deletedBy: string;
  batchId: string;
}

/**
 * Recycle Bin — everything soft-deleted, newest first. Deletes have always retained the row; this is
 * the first surface that lets one come back. When an item was removed as part of a cascade, restoring
 * it asks whether to bring back just that item or the whole deletion.
 */
export default function RecycleBin() {
  const [items, setItems] = useState<DeletedItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [supported, setSupported] = useState(true);
  const [reason, setReason] = useState('');
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('all');
  const [restoring, setRestoring] = useState('');
  // Set when the chosen item was deleted alongside others — drives the restore-scope prompt.
  const [scopePrompt, setScopePrompt] = useState<{ item: DeletedItem; related: DeletedItem[] } | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await fetch('/api/recycle-bin').then((response) => response.json());
      setItems(Array.isArray(data?.items) ? data.items : []);
      setSupported(data?.supported !== false);
      setReason(String(data?.reason || ''));
    } catch {
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const types = useMemo(() => ['all', ...Array.from(new Set(items.map((item) => item.type)))], [items]);
  const visible = useMemo(() => items.filter((item) => {
    const matchesType = typeFilter === 'all' || item.type === typeFilter;
    const term = search.trim().toLowerCase();
    return matchesType && (!term || item.label.toLowerCase().includes(term) || item.id.toLowerCase().includes(term));
  }), [items, typeFilter, search]);

  const restore = async (item: DeletedItem, scope: 'self' | 'batch') => {
    setRestoring(`${item.type}:${item.id}`);
    try {
      const response = await fetch(`/api/recycle-bin/${item.type}/${encodeURIComponent(item.id)}/restore`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scope }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.error || 'Could not restore this item.');
      showToast(data.restored > 1 ? `Restored ${data.restored} items.` : `Restored ${item.noun}.`, { tone: 'success' });
      setScopePrompt(null);
      await load();
    } catch (error: any) {
      void showAlert(error?.message || 'Could not restore this item.');
    } finally {
      setRestoring('');
    }
  };

  // Ask the scope question only when the deletion actually removed more than this one row.
  const beginRestore = async (item: DeletedItem) => {
    if (!item.batchId) return restore(item, 'self');
    try {
      const data = await fetch(`/api/recycle-bin/${item.type}/${encodeURIComponent(item.id)}/restore-scope`).then((r) => r.json());
      const related: DeletedItem[] = Array.isArray(data?.related) ? data.related : [];
      if (!related.length) return restore(item, 'self');
      setScopePrompt({ item, related });
    } catch {
      return restore(item, 'self');
    }
  };

  return (
    <div className="flex h-full min-h-0 w-full flex-col px-4 pb-4">
      <div className="mb-5 flex flex-shrink-0 flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-[var(--text-primary)]">Recycle Bin</h1>
          <p className="mt-1 text-sm text-[var(--text-muted)]">Deleted plans, suites, cases and other artifacts. Restore what you still need.</p>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--bg-card)] shadow-sm">
        <div className="flex flex-wrap items-center gap-3 border-b border-[var(--border)] p-4">
          <div className="relative min-w-52 flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-muted)]" />
            <label htmlFor="recycle-search" className="sr-only">Search deleted items</label>
            <input
              id="recycle-search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search deleted items"
              className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] py-1.5 pl-9 pr-3 text-sm text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)] focus:border-[var(--accent)]"
            />
          </div>
          <label htmlFor="recycle-type" className="sr-only">Filter by type</label>
          <select
            id="recycle-type"
            value={typeFilter}
            onChange={(event) => setTypeFilter(event.target.value)}
            className="shrink-0 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-1.5 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
          >
            {types.map((type) => <option key={type} value={type}>{type === 'all' ? 'All types' : type}</option>)}
          </select>
          <span className="ml-auto shrink-0 font-mono text-xs text-[var(--text-muted)]">{visible.length} item(s)</span>
        </div>

        {!supported && (
          <div className="flex items-start gap-2 border-b border-[var(--border)] bg-amber-500/10 px-4 py-3 text-sm text-amber-600 dark:text-amber-300">
            <Info className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{reason || 'The recycle bin is not available on this storage backend.'}</span>
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-auto">
          {loading ? (
            <div className="flex items-center gap-2 p-8 text-sm text-[var(--text-muted)]"><Loader2 className="h-4 w-4 animate-spin" /> Loading deleted items…</div>
          ) : !visible.length ? (
            <div className="flex flex-col items-center gap-2 p-12 text-center text-sm text-[var(--text-muted)]">
              <Trash2 className="h-8 w-8 opacity-30" />
              {items.length ? 'No deleted items match this filter.' : 'The recycle bin is empty.'}
            </div>
          ) : (
            <table className="w-full min-w-[820px] border-collapse text-left text-sm">
              <thead className="sticky top-0 z-10 border-b border-[var(--border)] bg-[var(--bg-secondary)] text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                <tr>
                  <th className="px-4 py-3">Item</th>
                  <th className="w-32 px-4 py-3">Type</th>
                  <th className="w-40 px-4 py-3">Deleted</th>
                  <th className="w-32 px-4 py-3">By</th>
                  <th className="w-28 px-4 py-3"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border)]">
                {visible.map((item) => {
                  const busy = restoring === `${item.type}:${item.id}`;
                  return (
                    <tr key={`${item.type}-${item.id}`} className="align-top hover:bg-[var(--bg-secondary)]/40">
                      <td className="px-4 py-3">
                        <div className="font-medium text-[var(--text-primary)] [overflow-wrap:anywhere]">{item.label}</div>
                        <div className="mt-0.5 font-mono text-[10px] text-[var(--text-muted)]">{item.id}</div>
                      </td>
                      <td className="px-4 py-3"><span className="rounded bg-[var(--bg-secondary)] px-1.5 py-0.5 text-[10px] font-bold text-[var(--text-muted)]">{item.noun}</span></td>
                      <td className="px-4 py-3 text-xs text-[var(--text-muted)]"><Timestamp value={item.deletedAt} /></td>
                      <td className="truncate px-4 py-3 text-xs text-[var(--text-muted)]">{item.deletedBy || '—'}</td>
                      <td className="px-4 py-3 text-right">
                        <button
                          type="button"
                          onClick={() => void beginRestore(item)}
                          disabled={busy || !supported}
                          className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2.5 py-1.5 text-xs font-medium text-[var(--text-primary)] transition-colors hover:border-[var(--accent)] disabled:opacity-50"
                        >
                          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />} Restore
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <Modal
        isOpen={!!scopePrompt}
        onClose={() => setScopePrompt(null)}
        title="Restore related items?"
        size="md"
        footer={
          <div className="flex w-full flex-wrap justify-end gap-2">
            <button type="button" onClick={() => setScopePrompt(null)} className="rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-sm text-[var(--text-primary)]">Cancel</button>
            <button type="button" onClick={() => scopePrompt && void restore(scopePrompt.item, 'self')} className="rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-sm font-medium text-[var(--text-primary)] hover:border-[var(--accent)]">
              Only this {scopePrompt?.item.noun.toLowerCase()}
            </button>
            <button type="button" onClick={() => scopePrompt && void restore(scopePrompt.item, 'batch')} className="rounded-md bg-[var(--accent)] px-3 py-2 text-sm font-medium text-white hover:bg-[var(--accent-hover)]">
              Restore all {(scopePrompt?.related.length || 0) + 1} items
            </button>
          </div>
        }
      >
        {scopePrompt && (
          <div className="space-y-3 text-sm">
            <p className="text-[var(--text-primary)]">
              <strong>{scopePrompt.item.label}</strong> was deleted together with {scopePrompt.related.length} other item(s).
            </p>
            <p className="text-[var(--text-muted)]">Restoring only this item leaves the rest in the recycle bin.</p>
            <div className="max-h-56 overflow-auto rounded-md border border-[var(--border)] bg-[var(--bg-secondary)]/50">
              <ul className="divide-y divide-[var(--border)]">
                {scopePrompt.related.map((related) => (
                  <li key={`${related.type}-${related.id}`} className={cn('flex items-center gap-2 px-3 py-2')}>
                    <span className="shrink-0 rounded bg-[var(--bg-card)] px-1.5 py-0.5 text-[10px] font-bold text-[var(--text-muted)]">{related.noun}</span>
                    <span className="min-w-0 flex-1 truncate text-[var(--text-primary)]">{related.label}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
