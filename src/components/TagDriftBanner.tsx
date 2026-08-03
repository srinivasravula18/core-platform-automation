import { useCallback, useEffect, useState } from 'react';
import { Sparkles, Plus, X, ChevronDown, ChevronRight, Loader2, Check, GitBranch, ArrowUpCircle } from 'lucide-react';
import {
  fetchTagDrift, acceptTagMatches, dismissTagMatches, setCasePin, fetchCaseDiff,
  type EntityKind, type TagDrift, type TagDriftCase, type RevisionSnapshot,
} from '@/src/lib/entityLinking';

// Per-step diff status vs the previous revision (by index): added / changed / same.
function stepStatus(prev: any[] | undefined, i: number, cur: any[]): 'added' | 'changed' | 'same' {
  const a = (prev || [])[i]; const b = cur[i];
  if (!a) return 'added';
  return JSON.stringify(a) !== JSON.stringify(b) ? 'changed' : 'same';
}

// Compact previous→current diff for a case pinned behind HEAD (fields + steps).
function OutdatedDiff({ caseId, pinnedNo, headNo }: { caseId: string; pinnedNo: number; headNo: number }) {
  const [diff, setDiff] = useState<{ a: RevisionSnapshot; b: RevisionSnapshot } | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let live = true;
    fetchCaseDiff(caseId, pinnedNo, headNo).then((d) => { if (live) { setDiff(d); setLoading(false); } });
    return () => { live = false; };
  }, [caseId, pinnedNo, headNo]);

  if (loading) return <div className="px-2 py-2 text-xs text-[var(--text-muted)]"><Loader2 className="inline h-3.5 w-3.5 animate-spin" /> Loading changes…</div>;
  if (!diff) return <div className="px-2 py-2 text-xs text-[var(--text-muted)]">Couldn’t load changes.</div>;
  const prev = diff.a; const cur = diff.b;
  const curSteps = Array.isArray(cur.steps) ? cur.steps : [];
  const prevSteps = Array.isArray(prev.steps) ? prev.steps : [];
  const fieldRows: Array<[string, string, string]> = [
    ['Title', prev.title || '', cur.title || ''],
    ['Description', prev.description || '', cur.description || ''],
    ['Preconditions', prev.preconditions || '', cur.preconditions || ''],
  ].filter(([, a, b]) => a !== b) as Array<[string, string, string]>;

  return (
    <div className="mt-1 rounded border border-[var(--border)] bg-[var(--bg-card)] p-2 text-xs">
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">@v{pinnedNo} (pinned) → @v{headNo} (latest)</div>
      {fieldRows.map(([label, a, b]) => (
        <div key={label} className="mb-1">
          <span className="font-medium text-[var(--text-primary)]">{label}</span>
          <div className="mt-0.5 rounded bg-red-500/10 px-2 py-1 text-red-300 line-through">{a || '(empty)'}</div>
          <div className="mt-0.5 rounded bg-emerald-500/10 px-2 py-1 text-emerald-300">{b || '(empty)'}</div>
        </div>
      ))}
      <div className="mt-1 font-medium text-[var(--text-primary)]">Steps ({curSteps.length})</div>
      <ol className="mt-0.5 space-y-0.5">
        {curSteps.map((s: any, i: number) => {
          const st = stepStatus(prevSteps, i, curSteps);
          const prevS = (prevSteps as any[])[i];
          const line = (step: any) => `${step?.action || ''}${step?.expected ? ` → ${step.expected}` : ''}`;
          return (
            <li key={i} className={`rounded px-2 py-1 ${st === 'added' ? 'bg-emerald-500/10' : st === 'changed' ? 'bg-amber-500/10' : 'bg-[var(--bg-secondary)]/40'}`}>
              <div className="flex items-start gap-1">
                <span className="text-[var(--text-muted)]">{i + 1}.</span>
                <div className="min-w-0 flex-1">
                  {/* For a changed step show previous (struck) then current, so you see old → new. */}
                  {st === 'changed' && <div className="text-red-300 line-through">{line(prevS)}</div>}
                  <div className={st === 'same' ? 'text-[var(--text-primary)]' : 'text-emerald-300'}>{line(s)}</div>
                </div>
                {st !== 'same' && <span className="shrink-0 text-[10px] uppercase opacity-70">{st}</span>}
              </div>
            </li>
          );
        })}
        {prevSteps.length > curSteps.length && (prevSteps as any[]).slice(curSteps.length).map((s: any, i: number) => (
          <li key={`rm-${i}`} className="rounded bg-red-500/10 px-2 py-1 text-red-300">
            <span className="text-red-300/70">{curSteps.length + i + 1}. </span>
            <span className="line-through">{s?.action || ''}{s?.expected ? ` → ${s.expected}` : ''}</span>
            <span className="ml-1 text-[10px] uppercase opacity-70">removed</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/**
 * Review-gated drift notification for a tag-defined suite/plan/run. When cases newly match the
 * group's tag query but aren't yet in its reviewed membership, this surfaces them with the
 * three-way choice the user asked for: ADD to this group, CREATE a new group from them, or DISMISS.
 * Renders nothing when the group has no tag query or nothing new matches (stays out of the way).
 *
 * Execution/membership is unaffected until the user acts — the server only ever runs the accepted
 * set (Option A). `onCreateNew` is provided by the host page since creating a new suite/run/plan is
 * page-specific; `onChanged` lets the host refresh its own membership view after an accept.
 */
export function TagDriftBanner({
  target, id, onChanged, onCreateNew,
}: {
  target: EntityKind;
  id: string;
  onChanged?: () => void;
  onCreateNew?: (caseIds: string[], drift: TagDrift) => void | Promise<void>;
}) {
  const [drift, setDrift] = useState<TagDrift | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [openDiff, setOpenDiff] = useState<Set<string>>(new Set()); // outdated caseIds whose diff is expanded

  const load = useCallback(async () => {
    setLoading(true);
    const d = await fetchTagDrift(target, id);
    setDrift(d);
    setSelected(new Set((d?.newMatches || []).map((c) => c.id)));
    setLoading(false);
  }, [target, id]);

  useEffect(() => { void load(); }, [load]);

  if (loading || !drift || (drift.newMatchCount === 0 && (drift.outdatedCount || 0) === 0)) return null;

  const matches = drift.newMatches;
  const chosen = () => matches.filter((c) => selected.has(c.id)).map((c) => c.id);
  const toggle = (cid: string) =>
    setSelected((cur) => { const n = new Set(cur); n.has(cid) ? n.delete(cid) : n.add(cid); return n; });
  const allChosen = matches.length > 0 && matches.every((c) => selected.has(c.id));

  const doAccept = async () => {
    const ids = chosen(); if (!ids.length) return;
    setBusy(true);
    const after = await acceptTagMatches(target, id, ids);
    if (after) setDrift(after);
    setSelected(new Set((after?.newMatches || []).map((c) => c.id)));
    setBusy(false);
    onChanged?.();
  };
  const doDismiss = async () => {
    const ids = chosen(); if (!ids.length) return;
    setBusy(true);
    const after = await dismissTagMatches(target, id, ids);
    if (after) setDrift(after);
    setSelected(new Set((after?.newMatches || []).map((c) => c.id)));
    setBusy(false);
  };
  const doCreateNew = async () => {
    const ids = chosen(); if (!ids.length || !onCreateNew) return;
    setBusy(true);
    await onCreateNew(ids, drift);
    setBusy(false);
    await load();
  };
  // Content drift: clear a case's pin so this group follows the latest version again.
  const updateToLatest = async (caseId: string) => {
    setBusy(true);
    await setCasePin(target as 'runs' | 'suites' | 'plans', id, caseId, null);
    setBusy(false);
    await load();
    onChanged?.();
  };

  const noun = target.slice(0, -1); // runs → run
  const outdated = drift.outdatedPins || [];

  return (
    <div className="flex flex-col gap-2">
    {drift.newMatchCount > 0 && (
    <div className="rounded-md border border-[var(--accent)]/40 bg-[var(--accent)]/5 p-3 text-sm">
      <div className="flex items-center gap-2">
        <span className="relative inline-flex">
          <Sparkles className="h-4 w-4 text-[var(--accent)]" />
          <span className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-[var(--accent)]" />
        </span>
        <span className="font-medium text-[var(--text-primary)]">
          {drift.newMatchCount} new case{drift.newMatchCount === 1 ? '' : 's'} match this {noun}’s tags
        </span>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="ml-auto inline-flex items-center gap-1 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)]"
        >
          {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          {expanded ? 'Hide' : 'Review'}
        </button>
      </div>

      {expanded && (
        <div className="mt-2 max-h-56 overflow-auto rounded border border-[var(--border)] bg-[var(--bg-secondary)]/40">
          <label className="flex cursor-pointer items-center gap-2 border-b border-[var(--border)] px-3 py-1.5 text-xs text-[var(--text-muted)]">
            <input
              type="checkbox"
              checked={allChosen}
              onChange={() => setSelected(allChosen ? new Set() : new Set(matches.map((c) => c.id)))}
            />
            Select all ({selected.size}/{matches.length})
          </label>
          {matches.map((c: TagDriftCase) => (
            <label key={c.id} className="flex cursor-pointer items-start gap-2 border-b border-[var(--border)] px-3 py-2 last:border-0 hover:bg-[var(--bg-secondary)]">
              <input type="checkbox" className="mt-0.5" checked={selected.has(c.id)} onChange={() => toggle(c.id)} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[var(--text-primary)]">{c.title || c.id}</span>
                {c.tags?.length > 0 && (
                  <span className="mt-0.5 flex flex-wrap gap-1">
                    {c.tags.slice(0, 6).map((t) => (
                      <span key={t} className="rounded-full bg-[var(--bg-card)] px-1.5 py-0.5 text-[10px] text-[var(--text-muted)]">{t}</span>
                    ))}
                  </span>
                )}
              </span>
            </label>
          ))}
        </div>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={doAccept}
          disabled={busy || !selected.size}
          className="inline-flex items-center gap-1.5 rounded-md bg-[var(--accent)] px-2.5 py-1.5 text-xs font-medium text-white hover:bg-[var(--accent-hover)] disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
          Add to this {noun}
        </button>
        {onCreateNew && (
          <button
            type="button"
            onClick={doCreateNew}
            disabled={busy || !selected.size}
            className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border)] px-2.5 py-1.5 text-xs font-medium text-[var(--accent)] hover:bg-[var(--bg-secondary)] disabled:opacity-50"
          >
            <Plus className="h-3.5 w-3.5" /> Create New {noun}
          </button>
        )}
        <button
          type="button"
          onClick={doDismiss}
          disabled={busy || !selected.size}
          className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border)] px-2.5 py-1.5 text-xs font-medium text-[var(--text-muted)] hover:bg-[var(--bg-secondary)] disabled:opacity-50"
        >
          <X className="h-3.5 w-3.5" /> Dismiss
        </button>
      </div>
    </div>
    )}

    {outdated.length > 0 && (
      <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
        <div className="flex items-center gap-2">
          <GitBranch className="h-4 w-4 text-amber-500" />
          <span className="font-medium text-[var(--text-primary)]">
            {outdated.length} case{outdated.length === 1 ? ' has' : 's have'} a newer version than pinned in this {noun}
          </span>
        </div>
        <div className="mt-2 flex flex-col gap-1.5">
          {outdated.map((p) => {
            const showing = openDiff.has(p.caseId);
            return (
            <div key={p.caseId} className="rounded border border-[var(--border)] bg-[var(--bg-secondary)]/40 px-2.5 py-1.5">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-[var(--text-primary)]">{p.title || p.caseId}</span>
                <span className="shrink-0 text-xs text-[var(--text-muted)]">@v{p.pinnedRevisionNo} → @v{p.headRevisionNo}</span>
                <button
                  type="button"
                  onClick={() => setOpenDiff((cur) => { const n = new Set(cur); n.has(p.caseId) ? n.delete(p.caseId) : n.add(p.caseId); return n; })}
                  className="inline-flex shrink-0 items-center gap-1 rounded-md border border-[var(--border)] px-2 py-1 text-xs font-medium text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                >
                  {showing ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />} View Changes
                </button>
                <button
                  type="button"
                  onClick={() => updateToLatest(p.caseId)}
                  disabled={busy}
                  className="inline-flex shrink-0 items-center gap-1 rounded-md border border-amber-500/50 px-2 py-1 text-xs font-medium text-amber-600 hover:bg-amber-500/10 disabled:opacity-50"
                >
                  <ArrowUpCircle className="h-3.5 w-3.5" /> Update to latest
                </button>
              </div>
              {showing && <OutdatedDiff caseId={p.caseId} pinnedNo={p.pinnedRevisionNo} headNo={p.headRevisionNo} />}
            </div>
            );
          })}
        </div>
      </div>
    )}
    </div>
  );
}
