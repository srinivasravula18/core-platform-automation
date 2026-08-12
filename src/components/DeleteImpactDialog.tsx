import { useEffect, useState } from 'react';
import { AlertTriangle, Loader2, Trash2, Unlink } from 'lucide-react';
import { Modal } from '@/src/components/Modal';

interface ClosureNode { type: string; id: string; label: string }
interface DetachedLink { type: string; id: string; label: string; field: string; removedId: string }

const NOUN: Record<string, string> = { plans: 'Test Plan', suites: 'Test Suite', cases: 'Test Case' };

/**
 * Confirms a delete by showing what it will actually take with it. A plan/suite cascades to the
 * items it exclusively owns; anything another plan or suite still uses is only unlinked, never
 * deleted — so shared work can't disappear because someone tidied up a different plan.
 */
export function DeleteImpactDialog({ entity, id, label, onCancel, onDeleted }: {
  entity: string;
  id: string;
  label: string;
  onCancel: () => void;
  onDeleted: (result: { deleted: number; detached: number }) => void;
}) {
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [willDelete, setWillDelete] = useState<ClosureNode[]>([]);
  const [willDetach, setWillDetach] = useState<DetachedLink[]>([]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const data = await fetch(`/api/${entity}/${encodeURIComponent(id)}?preview=1`, { method: 'DELETE' }).then((r) => r.json());
        if (cancelled) return;
        setWillDelete(Array.isArray(data?.willDelete) ? data.willDelete : []);
        setWillDetach(Array.isArray(data?.willDetach) ? data.willDetach : []);
      } catch {
        if (!cancelled) setError('Could not work out what this delete would affect.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [entity, id]);

  const confirm = async () => {
    setBusy(true);
    try {
      const response = await fetch(`/api/${entity}/${encodeURIComponent(id)}`, { method: 'DELETE' });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.error || 'Delete failed.');
      onDeleted({ deleted: Number(data?.deleted || 1), detached: Number(data?.detached || 0) });
    } catch (err: any) {
      setError(err?.message || 'Delete failed.');
    } finally {
      setBusy(false);
    }
  };

  const group = (nodes: ClosureNode[]) => {
    const counts = new Map<string, number>();
    nodes.forEach((node) => counts.set(node.type, (counts.get(node.type) || 0) + 1));
    return [...counts.entries()].map(([type, count]) => `${count} ${NOUN[type] || type}${count === 1 ? '' : 's'}`).join(', ');
  };

  return (
    <Modal
      isOpen
      onClose={onCancel}
      title="Delete and everything under it?"
      size="md"
      footer={
        <div className="flex w-full justify-end gap-2">
          <button type="button" onClick={onCancel} className="rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-sm text-[var(--text-primary)]">Cancel</button>
          <button
            type="button"
            onClick={() => void confirm()}
            disabled={busy || loading}
            className="inline-flex items-center gap-2 rounded-md bg-red-600 px-3 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
            Delete {willDelete.length ? `${willDelete.length + 1} items` : 'it'}
          </button>
        </div>
      }
    >
      {loading ? (
        <div className="flex items-center gap-2 py-6 text-sm text-[var(--text-muted)]"><Loader2 className="h-4 w-4 animate-spin" /> Checking what this affects…</div>
      ) : (
        <div className="space-y-4 text-sm">
          {error && <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-red-500">{error}</div>}

          <p className="text-[var(--text-primary)]"><strong>{label}</strong> will be moved to the Recycle Bin.</p>

          {willDelete.length > 0 && (
            <section>
              <h3 className="mb-2 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-red-500">
                <Trash2 className="h-3.5 w-3.5" /> Also deleted ({group(willDelete)})
              </h3>
              <div className="max-h-44 overflow-auto rounded-md border border-[var(--border)] bg-[var(--bg-secondary)]/50">
                <ul className="divide-y divide-[var(--border)]">
                  {willDelete.map((node) => (
                    <li key={`${node.type}-${node.id}`} className="flex items-center gap-2 px-3 py-1.5">
                      <span className="shrink-0 rounded bg-[var(--bg-card)] px-1.5 py-0.5 text-[10px] font-bold text-[var(--text-muted)]">{NOUN[node.type] || node.type}</span>
                      <span className="min-w-0 flex-1 truncate text-[var(--text-primary)]">{node.label}</span>
                    </li>
                  ))}
                </ul>
              </div>
              <p className="mt-1.5 text-xs text-[var(--text-muted)]">These belong only to this item, so they go with it. All of it can be restored together from the Recycle Bin.</p>
            </section>
          )}

          {willDetach.length > 0 && (
            <section>
              <h3 className="mb-2 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-amber-500">
                <Unlink className="h-3.5 w-3.5" /> Kept, only unlinked ({willDetach.length})
              </h3>
              <div className="max-h-32 overflow-auto rounded-md border border-[var(--border)] bg-[var(--bg-secondary)]/50">
                <ul className="divide-y divide-[var(--border)]">
                  {willDetach.map((link) => (
                    <li key={`${link.type}-${link.id}-${link.field}`} className="flex items-center gap-2 px-3 py-1.5">
                      <span className="shrink-0 rounded bg-[var(--bg-card)] px-1.5 py-0.5 text-[10px] font-bold text-[var(--text-muted)]">{NOUN[link.type] || link.type}</span>
                      <span className="min-w-0 flex-1 truncate text-[var(--text-primary)]">{link.label}</span>
                    </li>
                  ))}
                </ul>
              </div>
              <p className="mt-1.5 text-xs text-[var(--text-muted)]">Still used elsewhere, so they are kept and simply unlinked from this item.</p>
            </section>
          )}

          {!willDelete.length && !willDetach.length && (
            <div className="flex items-start gap-2 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)]/50 px-3 py-2 text-[var(--text-muted)]">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
              <span>Nothing else references this item, so only it will be deleted.</span>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
