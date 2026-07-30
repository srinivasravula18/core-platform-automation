import { useEffect, useState } from 'react';
import { Loader2, Trash2, Plus, Check } from 'lucide-react';
import { Modal } from './Modal';
import { fetchTagCatalog, type TagCatalogEntry } from '@/src/lib/entityLinking';
import { showConfirm } from '@/src/lib/dialog';

// Tags are always @-prefixed (server-normalized) — show the prefix as soon as typing starts.
const withAtPrefix = (raw: string) => (raw && !raw.startsWith('@') ? `@${raw}` : raw);

/**
 * Tag Manager — the surface for the shared tag catalog. Lists every tag with its usage
 * count, and lets you create, rename (write-through to every case/suite/plan/run), recolor,
 * and delete tags. Backed by the Phase-1 /api/tags routes.
 *
 * Tags found inline on entities but never explicitly registered come back with an empty id;
 * the first edit registers them (POST) so they gain a catalog id, then applies the change.
 */
const SWATCHES = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899', '#64748b'];

export function TagManagerModal({ isOpen, onClose, onChanged }: { isOpen: boolean; onClose: () => void; onChanged?: () => void }) {
  const [tags, setTags] = useState<TagCatalogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState('');
  const [newName, setNewName] = useState('');
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const load = () => {
    setLoading(true);
    fetchTagCatalog().then(setTags).catch(() => setTags([])).finally(() => setLoading(false));
  };
  useEffect(() => { if (isOpen) { load(); setNewName(''); setDrafts({}); } }, [isOpen]);

  const notify = () => { load(); onChanged?.(); };

  // Return a real catalog id for a tag, registering it first if it exists only inline.
  const ensureId = async (t: TagCatalogEntry): Promise<string> => {
    if (t.id) return t.id;
    const res = await fetch('/api/tags', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: t.name, color: t.color || '' }),
    });
    return res.ok ? (await res.json()).tag?.id || '' : '';
  };

  const createTag = async () => {
    const name = newName.trim();
    if (!name) return;
    setBusy('new');
    try {
      await fetch('/api/tags', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
      setNewName('');
      notify();
    } finally { setBusy(''); }
  };

  const rename = async (t: TagCatalogEntry) => {
    const next = (drafts[t.name] ?? t.name).trim();
    if (!next || next === t.name) return;
    setBusy(t.name);
    try {
      const id = await ensureId(t);
      if (!id) return;
      const res = await fetch(`/api/tags/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: next }) });
      if (!res.ok) { const e = await res.json().catch(() => ({})); await showConfirm(e.error || 'Rename failed.'); }
      notify();
    } finally { setBusy(''); }
  };

  const recolor = async (t: TagCatalogEntry, color: string) => {
    setBusy(t.name);
    try {
      const id = await ensureId(t);
      if (!id) return;
      await fetch(`/api/tags/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ color }) });
      notify();
    } finally { setBusy(''); }
  };

  const remove = async (t: TagCatalogEntry) => {
    const strip = await showConfirm(`Delete tag "${t.name}"? Choose OK to also remove it from all ${t.count} tagged item(s).`);
    setBusy(t.name);
    try {
      const id = await ensureId(t);
      if (!id) return;
      await fetch(`/api/tags/${id}${strip ? '?strip=1' : ''}`, { method: 'DELETE' });
      notify();
    } finally { setBusy(''); }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Manage Tags" size="md">
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <input
            value={newName}
            onChange={(e) => setNewName(withAtPrefix(e.target.value))}
            onFocus={() => setNewName((n) => n || '@')}
            onKeyDown={(e) => e.key === 'Enter' && createTag()}
            placeholder="New tag name…"
            className="flex-1 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-1.5 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
          />
          <button type="button" onClick={createTag} disabled={!newName.trim() || busy === 'new'} className="inline-flex items-center gap-1.5 rounded-md bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-white hover:bg-[var(--accent-hover)] disabled:opacity-50">
            {busy === 'new' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />} Add
          </button>
        </div>

        <div className="max-h-[52vh] overflow-auto rounded-md border border-[var(--border)]">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-8 text-sm text-[var(--text-muted)]"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>
          ) : tags.length === 0 ? (
            <div className="py-8 text-center text-sm text-[var(--text-muted)]">No tags yet.</div>
          ) : tags.map((t) => (
            <div key={t.name} className="flex items-center gap-2 border-b border-[var(--border)] px-3 py-2 last:border-0">
              <span className="h-3 w-3 shrink-0 rounded-full border border-[var(--border)]" style={{ backgroundColor: t.color || 'transparent' }} />
              <input
                value={drafts[t.name] ?? t.name}
                onChange={(e) => setDrafts((d) => ({ ...d, [t.name]: withAtPrefix(e.target.value) }))}
                onBlur={() => rename(t)}
                onKeyDown={(e) => e.key === 'Enter' && rename(t)}
                className="min-w-0 flex-1 rounded border border-transparent bg-transparent px-1.5 py-1 text-sm text-[var(--text-primary)] outline-none hover:border-[var(--border)] focus:border-[var(--accent)]"
              />
              <span className="shrink-0 rounded-full bg-[var(--bg-secondary)] px-2 py-0.5 text-xs text-[var(--text-muted)]">{t.count}</span>
              <div className="flex shrink-0 items-center gap-1">
                {SWATCHES.map((c) => (
                  <button key={c} type="button" onClick={() => recolor(t, c)} title={c} className="h-4 w-4 rounded-full border border-[var(--border)] transition-transform hover:scale-110" style={{ backgroundColor: c }}>
                    {t.color === c && <Check className="h-3 w-3 text-white" strokeWidth={3} />}
                  </button>
                ))}
              </div>
              <button type="button" onClick={() => remove(t)} disabled={busy === t.name} className="shrink-0 rounded p-1 text-[var(--text-muted)] hover:bg-red-500/10 hover:text-red-400 disabled:opacity-50" title="Delete tag">
                {busy === t.name ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
              </button>
            </div>
          ))}
        </div>
      </div>
    </Modal>
  );
}
