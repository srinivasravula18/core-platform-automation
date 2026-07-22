import { useEffect, useState } from 'react';
import { Loader2, History, RotateCcw, Check, Pin, X } from 'lucide-react';
import { Modal } from '@/src/components/Modal';
import { showToast, showConfirm } from '@/src/lib/dialog';

/**
 * Test Case Versioning — revision history viewer (Phase A2).
 *
 * Lists a case's append-only revisions (newest first), lets you inspect the frozen steps of any
 * revision, and restore one (which writes a NEW rollback revision — history is never mutated). Backed
 * by GET /api/cases/:id/revisions and POST /api/cases/:id/rollback/:revisionId. When CASE_VERSIONING
 * is off the revisions list is empty and the modal says so.
 */

interface Revision {
  revisionId: string;
  revisionNo: number;
  changeKind: string;
  changeSummary?: string | null;
  author?: string | null;
  createdAt?: string;
  title?: string;
  description?: string;
  preconditions?: string;
  steps?: Array<{ action: string; expected: string }>;
}

const KIND_STYLES: Record<string, string> = {
  initial: 'border-slate-500/30 bg-slate-500/10 text-slate-400',
  baseline: 'border-slate-500/30 bg-slate-500/10 text-slate-400',
  manual: 'border-sky-500/30 bg-sky-500/10 text-sky-400',
  ai: 'border-violet-500/30 bg-violet-500/10 text-violet-400',
  recorded: 'border-amber-500/30 bg-amber-500/10 text-amber-400',
  rollback: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400',
};

function when(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString();
}

export default function CaseHistoryModal({ caseId, isOpen, onClose, onRolledBack }: {
  caseId: string;
  isOpen: boolean;
  onClose: () => void;
  onRolledBack?: () => void;
}) {
  const [loading, setLoading] = useState(false);
  const [revisions, setRevisions] = useState<Revision[]>([]);
  const [currentRevision, setCurrentRevision] = useState<number | null>(null);
  const [selectedId, setSelectedId] = useState<string>('');
  const [busy, setBusy] = useState(false);
  // Release pinning (Layer 2): which releases/plans this case is frozen into, plus the plan picker.
  const [plans, setPlans] = useState<Array<{ id: string; name: string }>>([]);
  const [pins, setPins] = useState<Array<{ planId: string; pinnedRevisionNo: number }>>([]);
  const [pinPlanId, setPinPlanId] = useState('');
  const [pinBusy, setPinBusy] = useState(false);

  const loadPins = () => fetch(`/api/cases/${caseId}/pins`).then((r) => r.json()).then((d) => setPins(Array.isArray(d?.pins) ? d.pins : [])).catch(() => setPins([]));

  useEffect(() => {
    if (!isOpen || !caseId) return;
    setLoading(true);
    Promise.all([
      fetch(`/api/cases/${caseId}/revisions`).then((r) => r.json()).then((d) => {
        const revs: Revision[] = Array.isArray(d?.revisions) ? d.revisions : [];
        setRevisions(revs);
        setCurrentRevision(typeof d?.currentRevision === 'number' ? d.currentRevision : null);
        setSelectedId(revs[0]?.revisionId || '');
      }).catch(() => setRevisions([])),
      fetch('/api/plans').then((r) => r.json()).then((d) => setPlans((Array.isArray(d) ? d : d?.plans || []).map((p: any) => ({ id: p.id, name: p.name })))).catch(() => setPlans([])),
      loadPins(),
    ]).finally(() => setLoading(false));
  }, [isOpen, caseId]);

  const selected = revisions.find((r) => r.revisionId === selectedId) || null;
  const planName = (id: string) => plans.find((p) => p.id === id)?.name || id;

  const pinSelected = async () => {
    if (!selected || !pinPlanId) return;
    setPinBusy(true);
    try {
      const res = await fetch(`/api/plans/${pinPlanId}/pins`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ caseId, revisionNo: selected.revisionNo }),
      });
      if (!res.ok) throw new Error();
      showToast(`Pinned revision ${selected.revisionNo} to ${planName(pinPlanId)}.`, { tone: 'success' });
      setPinPlanId('');
      await loadPins();
    } catch { showToast('Could not pin that revision.', { tone: 'error' }); }
    finally { setPinBusy(false); }
  };

  const unpin = async (pinPlan: string) => {
    setPinBusy(true);
    try {
      await fetch(`/api/plans/${pinPlan}/pins/${caseId}`, { method: 'DELETE' });
      await loadPins();
    } finally { setPinBusy(false); }
  };

  const restore = async (rev: Revision) => {
    if (!(await showConfirm(`Restore revision ${rev.revisionNo}? This creates a new revision with that content.`))) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/cases/${caseId}/rollback/${rev.revisionId}`, { method: 'POST' });
      if (!res.ok) throw new Error();
      showToast(`Restored revision ${rev.revisionNo}.`, { tone: 'success' });
      onRolledBack?.();
      onClose();
    } catch { showToast('Could not restore that revision.', { tone: 'error' }); }
    finally { setBusy(false); }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Revision History" size="xl"
      footer={<div className="flex justify-end"><button onClick={onClose} className="px-4 py-2 text-sm font-medium text-[var(--text-muted)] hover:text-[var(--text-primary)]">Close</button></div>}>
      {loading ? (
        <div className="flex items-center gap-2 p-6 text-sm text-[var(--text-muted)]"><Loader2 className="h-4 w-4 animate-spin" /> Loading history…</div>
      ) : revisions.length === 0 ? (
        <div className="flex flex-col items-center gap-2 p-8 text-center text-sm text-[var(--text-muted)]">
          <History className="h-6 w-6" />
          <p>No revision history for this case yet.</p>
          <p className="text-xs">History is captured once test-case versioning is enabled; edits after that appear here.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-[280px_1fr]">
          {/* revision list */}
          <div className="max-h-[60vh] overflow-y-auto rounded-lg border border-[var(--border)]">
            {revisions.map((rev) => {
              const isSel = rev.revisionId === selectedId;
              const isHead = currentRevision != null && rev.revisionNo === currentRevision;
              return (
                <button key={rev.revisionId} onClick={() => setSelectedId(rev.revisionId)}
                  className={`flex w-full flex-col gap-1 border-b border-[var(--border)] px-3 py-2 text-left last:border-b-0 ${isSel ? 'bg-[var(--accent)]/10' : 'hover:bg-[var(--bg-secondary)]'}`}>
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold text-[var(--text-primary)]">Revision {rev.revisionNo}</span>
                    {isHead && <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase text-emerald-400">Current</span>}
                    <span className={`rounded border px-1.5 py-0.5 text-[9px] font-semibold uppercase ${KIND_STYLES[rev.changeKind] || KIND_STYLES.manual}`}>{rev.changeKind}</span>
                  </div>
                  <span className="text-[11px] text-[var(--text-muted)]">{when(rev.createdAt)}{rev.author ? ` · ${rev.author}` : ''}</span>
                  {rev.changeSummary && <span className="truncate text-[11px] text-[var(--text-muted)]">{rev.changeSummary}</span>}
                </button>
              );
            })}
          </div>

          {/* selected revision detail */}
          <div className="min-w-0">
            {selected ? (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <h4 className="truncate text-sm font-semibold text-[var(--text-primary)]">{selected.title || '(untitled)'}</h4>
                    <p className="text-[11px] text-[var(--text-muted)]">{(selected.steps?.length ?? 0)} step{(selected.steps?.length ?? 0) === 1 ? '' : 's'}</p>
                  </div>
                  {currentRevision != null && selected.revisionNo === currentRevision ? (
                    <span className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-400"><Check className="h-3.5 w-3.5" /> Current revision</span>
                  ) : (
                    <button onClick={() => restore(selected)} disabled={busy}
                      className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--bg-card)] px-3 py-1.5 text-xs font-medium text-[var(--text-primary)] hover:border-[var(--accent)] disabled:opacity-50">
                      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />} Restore this revision
                    </button>
                  )}
                </div>
                {selected.description && <p className="text-xs text-[var(--text-muted)]">{selected.description}</p>}

                {/* Release pinning: freeze this revision into a release (plan). */}
                <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] p-3">
                  <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]"><Pin className="h-3 w-3" /> Releases</div>
                  {pins.length > 0 ? (
                    <div className="mb-2 flex flex-wrap gap-1.5">
                      {pins.map((p) => (
                        <span key={p.planId} className="inline-flex items-center gap-1 rounded-md border border-[var(--accent)]/40 bg-[var(--accent)]/10 px-2 py-0.5 text-[11px] text-[var(--text-primary)]">
                          {planName(p.planId)} → rev {p.pinnedRevisionNo}
                          <button type="button" onClick={() => unpin(p.planId)} disabled={pinBusy} aria-label={`Unpin from ${planName(p.planId)}`} className="hover:text-red-400"><X className="h-3 w-3" /></button>
                        </span>
                      ))}
                    </div>
                  ) : (
                    <p className="mb-2 text-[11px] text-[var(--text-muted)]">Not pinned to any release — releases follow the current revision.</p>
                  )}
                  <div className="flex flex-wrap items-center gap-2">
                    <select value={pinPlanId} onChange={(e) => setPinPlanId(e.target.value)}
                      className="min-w-0 flex-1 rounded-md border border-[var(--border)] bg-[var(--bg-card)] px-2 py-1.5 text-xs text-[var(--text-primary)] outline-none focus:border-[var(--accent)]">
                      <option value="">Select a release (test plan)…</option>
                      {plans.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                    <button onClick={pinSelected} disabled={!pinPlanId || pinBusy}
                      className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--bg-card)] px-3 py-1.5 text-xs font-medium text-[var(--text-primary)] hover:border-[var(--accent)] disabled:opacity-50">
                      {pinBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Pin className="h-3.5 w-3.5" />} Pin revision {selected.revisionNo}
                    </button>
                  </div>
                </div>

                {!!selected.steps?.length && (
                  <div className="overflow-hidden rounded-lg border border-[var(--border)]">
                    <table className="w-full border-collapse text-left text-xs">
                      <thead>
                        <tr className="bg-[var(--bg-secondary)] text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                          <th className="w-1/2 border-b border-[var(--border)] px-3 py-2">Test Steps</th>
                          <th className="w-1/2 border-b border-[var(--border)] px-3 py-2">Expected Result</th>
                        </tr>
                      </thead>
                      <tbody>
                        {selected.steps.map((s, i) => (
                          <tr key={i} className="align-top">
                            <td className="border-b border-[var(--border)] px-3 py-2 text-[var(--text-primary)]"><span className="text-[var(--text-muted)]">{i + 1}.</span> {s.action}</td>
                            <td className="border-b border-[var(--border)] px-3 py-2 text-[var(--text-muted)]">{s.expected}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            ) : (
              <p className="p-6 text-sm text-[var(--text-muted)]">Select a revision to view its steps.</p>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}
