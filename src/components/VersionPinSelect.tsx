import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { GitBranch, ChevronDown, Loader2 } from 'lucide-react';
import { fetchCaseRevisions, setCasePin, type CaseRevision } from '@/src/lib/entityLinking';

/**
 * Version-as-tag picker: pin a case in a run/suite/plan to a specific @vN, or follow @latest. Keeps the
 * whole model in the tag world — the label is `@latest` / `@v{n}`, backed by the case revision graph.
 *
 * The menu is rendered through a PORTAL with fixed positioning so it is never clipped by the scrolling
 * table/overflow containers it lives inside (the row's `overflow-auto` would otherwise cut it off).
 */
const MENU_W = 176; // px (w-44)

export function VersionPinSelect({
  target, groupId, caseId, pinnedRevisionNo, onChange,
}: {
  target: 'runs' | 'suites' | 'plans';
  groupId: string;
  caseId: string;
  pinnedRevisionNo?: number | null;
  onChange?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [revisions, setRevisions] = useState<CaseRevision[]>([]);
  const [current, setCurrent] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; placement: 'down' | 'up' }>({ top: 0, left: 0, placement: 'down' });
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // Anchor the fixed menu to the trigger; flip up when there isn't room below.
  const reposition = () => {
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return;
    const spaceBelow = window.innerHeight - r.bottom;
    const placement: 'down' | 'up' = spaceBelow < 240 && r.top > spaceBelow ? 'up' : 'down';
    const left = Math.max(8, Math.min(r.right - MENU_W, window.innerWidth - MENU_W - 8));
    setPos({ top: placement === 'down' ? r.bottom + 4 : r.top - 4, left, placement });
  };

  useLayoutEffect(() => { if (open) reposition(); }, [open]);

  useEffect(() => {
    if (!open || revisions.length) return;
    setLoading(true);
    fetchCaseRevisions(caseId)
      .then((d) => { setRevisions(d.revisions || []); setCurrent(d.currentRevision); })
      .finally(() => setLoading(false));
  }, [open, caseId, revisions.length]);

  // Close on outside click, and on scroll/resize (a fixed menu shouldn't drift from its anchor).
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (btnRef.current?.contains(e.target as Node) || menuRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    const close = (event: Event) => {
      // The menu itself is scrollable; capture-phase window scroll also receives that event.
      if (menuRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', away, true);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('mousedown', away, true);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [open]);

  const pin = async (revisionNo: number | null) => {
    setSaving(true);
    const ok = await setCasePin(target, groupId, caseId, revisionNo);
    setSaving(false);
    if (ok) { setOpen(false); onChange?.(); }
  };

  const label = pinnedRevisionNo != null ? `@v${pinnedRevisionNo}` : '@latest';

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Pin the version this case runs at"
        className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors ${pinnedRevisionNo != null ? 'border-[var(--accent)] text-[var(--accent)]' : 'border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text-primary)]'}`}
      >
        {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <GitBranch className="h-3 w-3" />}
        {label}
        <ChevronDown className="h-3 w-3 opacity-60" />
      </button>
      {open && createPortal(
        <div
          ref={menuRef}
          style={{ position: 'fixed', left: pos.left, width: MENU_W, ...(pos.placement === 'down' ? { top: pos.top } : { bottom: window.innerHeight - pos.top }) }}
          className="z-[60] max-h-56 overflow-auto rounded-md border border-[var(--border)] bg-[var(--bg-card)] p-1 shadow-xl"
        >
          {loading ? (
            <div className="flex items-center gap-2 px-2 py-2 text-xs text-[var(--text-muted)]"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…</div>
          ) : (
            <>
              <button
                type="button"
                onClick={() => pin(null)}
                className={`flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-xs hover:bg-[var(--bg-secondary)] ${pinnedRevisionNo == null ? 'text-[var(--accent)]' : 'text-[var(--text-primary)]'}`}
              >
                @latest {current != null && <span className="opacity-60">v{current}</span>}
              </button>
              {revisions.map((r) => (
                <button
                  key={r.revisionNo}
                  type="button"
                  onClick={() => pin(r.revisionNo)}
                  title={r.changeSummary || ''}
                  className={`flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-xs hover:bg-[var(--bg-secondary)] ${pinnedRevisionNo === r.revisionNo ? 'text-[var(--accent)]' : 'text-[var(--text-primary)]'}`}
                >
                  <span>@v{r.revisionNo}</span>
                  {r.changeKind && <span className="ml-2 truncate opacity-60">{r.changeKind}</span>}
                </button>
              ))}
              {revisions.length === 0 && <div className="px-2 py-2 text-xs text-[var(--text-muted)]">No prior versions.</div>}
            </>
          )}
        </div>,
        document.body,
      )}
    </>
  );
}
