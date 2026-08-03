import { useCallback, useEffect, useMemo, useState } from 'react';
import { GitCommitHorizontal, RotateCcw, Loader2 } from 'lucide-react';
import { cn } from '@/src/lib/utils';
import { Timestamp } from '@/src/components/Timestamp';
import { showConfirm, showAlert } from '@/src/lib/dialog';

// A revision node — the git-commit analogue. Cases carry title/desc/preconditions/steps; scripts carry code.
interface Revision {
  revisionId: string;
  revisionNo: number;
  parentRevision?: string | null;
  changeKind?: string;
  changeSummary?: string;
  author?: string;
  createdAt?: string;
  title?: string;
  description?: string;
  preconditions?: string;
  steps?: Array<{ action?: string; expected?: string }>;
  code?: string;
}

const KIND_STYLE: Record<string, string> = {
  initial: 'text-slate-400 border-slate-500/40',
  baseline: 'text-slate-400 border-slate-500/40',
  manual: 'text-[var(--accent)] border-[var(--accent)]/40',
  ai: 'text-violet-400 border-violet-500/40',
  recorded: 'text-cyan-400 border-cyan-500/40',
  regenerated: 'text-cyan-400 border-cyan-500/40',
  rollback: 'text-amber-400 border-amber-500/40',
};

// The Git-style version history: an immutable timeline of revisions with diff + non-destructive restore.
// `entity` selects the case vs script revision API (identical shape, mirrored endpoints).
export function VersionHistoryPanel({
  entity,
  id,
  onRestored,
}: {
  entity: 'cases' | 'scripts';
  id: string;
  onRestored?: () => void;
}) {
  const [revisions, setRevisions] = useState<Revision[]>([]);
  const [currentRevision, setCurrentRevision] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedNo, setSelectedNo] = useState<number | null>(null);
  const [restoring, setRestoring] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetch(`/api/${entity}/${encodeURIComponent(id)}/revisions`).then((r) => r.json());
      const revs: Revision[] = Array.isArray(data?.revisions) ? data.revisions : [];
      setRevisions(revs);
      setCurrentRevision(data?.currentRevision ?? null);
      setSelectedNo(revs.length ? revs[0].revisionNo : null);
    } catch {
      setRevisions([]);
    } finally {
      setLoading(false);
    }
  }, [entity, id]);

  useEffect(() => { void load(); }, [load]);

  const selected = useMemo(() => revisions.find((r) => r.revisionNo === selectedNo) || null, [revisions, selectedNo]);
  // Previous node in the immutable chain (next-older revisionNo) — the default diff base.
  const previous = useMemo(() => {
    if (!selected) return null;
    return revisions.filter((r) => r.revisionNo < selected.revisionNo).sort((a, b) => b.revisionNo - a.revisionNo)[0] || null;
  }, [revisions, selected]);

  const restore = async (rev: Revision) => {
    if (!await showConfirm(`Restore version v${rev.revisionNo}? This appends a new revision (history is preserved) and makes v${rev.revisionNo}'s content current.`)) return;
    setRestoring(rev.revisionId);
    try {
      const res = await fetch(`/api/${entity}/${encodeURIComponent(id)}/rollback/${encodeURIComponent(rev.revisionId)}`, { method: 'POST' });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Restore failed.');
      await load();
      onRestored?.();
    } catch (e: any) {
      void showAlert(e?.message || 'Restore failed.');
    } finally {
      setRestoring('');
    }
  };

  if (loading) return <div className="p-8 text-sm text-[var(--text-muted)]"><Loader2 className="mr-2 inline h-4 w-4 animate-spin" />Loading history…</div>;
  if (!revisions.length) return <div className="p-8 text-center text-sm text-[var(--text-muted)]">No version history yet. Edits will appear here as immutable revisions.</div>;

  return (
    <div className="grid gap-4 md:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
      {/* Git-style timeline */}
      <div className="max-h-[62vh] overflow-auto pr-1">
        <ol className="relative border-l border-[var(--border)]">
          {revisions.map((rev) => {
            const isHead = rev.revisionNo === currentRevision;
            const isSel = rev.revisionNo === selectedNo;
            return (
              <li key={rev.revisionId} className="ml-4 pb-4">
                <span className={cn('absolute -left-[7px] mt-1 h-3 w-3 rounded-full border-2 bg-[var(--bg-card)]', isSel ? 'border-[var(--accent)]' : 'border-[var(--border)]')} />
                <button type="button" onClick={() => setSelectedNo(rev.revisionNo)} className={cn('w-full rounded-md border px-3 py-2 text-left transition-colors', isSel ? 'border-[var(--accent)] bg-[var(--accent)]/5' : 'border-[var(--border)] hover:bg-[var(--bg-secondary)]')}>
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm font-semibold">v{rev.revisionNo}</span>
                    {isHead && <span className="rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-400">HEAD</span>}
                    <span className={cn('rounded-full border px-1.5 py-0.5 text-[10px] font-medium capitalize', KIND_STYLE[String(rev.changeKind || 'manual')] || KIND_STYLE.manual)}>{rev.changeKind || 'manual'}</span>
                  </div>
                  <div className="mt-1 truncate text-xs text-[var(--text-primary)]">{rev.changeSummary || '(no summary)'}</div>
                  <div className="mt-0.5 text-[11px] text-[var(--text-muted)]">{rev.author || 'system'} · {rev.createdAt ? <Timestamp value={rev.createdAt} /> : ''}</div>
                </button>
                {!isHead && (
                  <button type="button" disabled={restoring === rev.revisionId} onClick={() => restore(rev)} className="mt-1 inline-flex items-center gap-1 text-[11px] font-medium text-amber-400 hover:text-amber-300 disabled:opacity-50">
                    {restoring === rev.revisionId ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCcw className="h-3 w-3" />} Restore This Version
                  </button>
                )}
              </li>
            );
          })}
        </ol>
      </div>

      {/* Diff / content of the selected revision vs its predecessor */}
      <div className="min-w-0 rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)]/40 p-4">
        {!selected ? (
          <div className="text-sm text-[var(--text-muted)]">Select a revision to view its content and diff.</div>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <GitCommitHorizontal className="h-4 w-4 text-[var(--accent)]" />
              v{selected.revisionNo}{previous ? <span className="text-[var(--text-muted)]"> vs v{previous.revisionNo}</span> : <span className="text-[var(--text-muted)]"> (initial)</span>}
            </div>
            {entity === 'scripts'
              ? <ScriptDiff current={selected} prev={previous} />
              : <CaseDiff current={selected} prev={previous} />}
          </div>
        )}
      </div>
    </div>
  );
}

function FieldRow({ label, prev, next }: { label: string; prev?: string; next?: string }) {
  const changed = (prev || '') !== (next || '');
  return (
    <div className="text-sm">
      <div className="text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">{label}{changed && <span className="ml-2 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-400">changed</span>}</div>
      <div className={cn('mt-0.5 whitespace-pre-wrap rounded px-2 py-1', changed ? 'bg-emerald-500/5' : '')}>{next || <span className="text-[var(--text-muted)]">(empty)</span>}</div>
    </div>
  );
}

function CaseDiff({ current, prev }: { current: Revision; prev: Revision | null }) {
  const curSteps = Array.isArray(current.steps) ? current.steps : [];
  const prevSteps = Array.isArray(prev?.steps) ? prev!.steps! : [];
  const stepState = (i: number) => {
    const a = prevSteps[i]; const b = curSteps[i];
    if (!a) return 'added';
    if (JSON.stringify(a) !== JSON.stringify(b)) return 'changed';
    return 'same';
  };
  return (
    <div className="space-y-3">
      <FieldRow label="Title" prev={prev?.title} next={current.title} />
      <FieldRow label="Description" prev={prev?.description} next={current.description} />
      <FieldRow label="Preconditions" prev={prev?.preconditions} next={current.preconditions} />
      <div>
        <div className="text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">Steps ({curSteps.length})</div>
        <ol className="mt-1 space-y-1">
          {curSteps.map((s, i) => {
            const st = stepState(i);
            return (
              <li key={i} className={cn('rounded px-2 py-1 text-sm', st === 'added' ? 'bg-emerald-500/10' : st === 'changed' ? 'bg-amber-500/10' : 'bg-[var(--bg-card)]')}>
                <span className="mr-2 font-mono text-xs text-[var(--text-muted)]">{i + 1}</span>
                <span className="text-[var(--text-primary)]">{s.action}</span>
                {s.expected ? <span className="text-[var(--text-muted)]"> → {s.expected}</span> : null}
                {st !== 'same' && <span className="ml-2 text-[10px] uppercase text-[var(--text-muted)]">{st}</span>}
              </li>
            );
          })}
          {prevSteps.length > curSteps.length && (
            <li className="rounded bg-red-500/10 px-2 py-1 text-sm text-red-400">{prevSteps.length - curSteps.length} step(s) removed</li>
          )}
        </ol>
      </div>
    </div>
  );
}

function ScriptDiff({ current, prev }: { current: Revision; prev: Revision | null }) {
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      {prev && (
        <div>
          <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">v{prev.revisionNo}</div>
          <pre className="max-h-[42vh] overflow-auto rounded-md bg-slate-950 p-3 text-[11px] leading-5 text-slate-300"><code>{prev.code || ''}</code></pre>
        </div>
      )}
      <div className={cn(!prev && 'lg:col-span-2')}>
        <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">v{current.revisionNo} (selected)</div>
        <pre className="max-h-[42vh] overflow-auto rounded-md bg-slate-950 p-3 text-[11px] leading-5 text-slate-200"><code>{current.code || ''}</code></pre>
      </div>
    </div>
  );
}
