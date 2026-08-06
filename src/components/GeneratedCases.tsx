import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CheckSquare, Square, Pencil, Trash2, SplitSquareHorizontal, Loader2, Check, Sparkles } from 'lucide-react';
import { invalidateData } from '@/src/store/data';
import { AIReworkPanel } from '@/src/components/AIReworkPanel';
import { AIImageAttachmentPicker, appendAIImageAttachments, type AIImageAttachment } from '@/src/components/AIImageAttachmentPicker';
import {
  applyAIReworkProposal,
  isAIReworkProposalStale,
  singleCaseProposal,
  suiteCaseProposal,
  type AIReworkProposal,
} from '@/src/lib/aiRework';
import { normalizeTags } from '@/src/lib/tags';

/**
 * Renders the test cases the Agent Console just generated, inline in the chat,
 * and lets the human curate them right here — exactly like the deep-run cards:
 *   - edit title / description / priority / tags
 *   - add / remove / edit individual steps
 *   - AI-expand a case to N steps
 *   - AI-rework a case from feedback
 *   - save back to the stored case (PUT /api/cases/:id)
 * No AI Inbox hand-off. "Open in Test Cases" is just a convenience jump.
 */

interface Step {
  action: string;
  expected: string;
  proofStatus?: 'verified' | 'metadata-backed' | 'blocked';
  proofTokens?: string[];
}
interface Case {
  id: string;
  title: string;
  description?: string;
  preconditions?: string;
  priority?: string;
  type?: string;
  tags?: string[];
  steps?: Step[];
  captureEvidenceOnManualRun?: boolean;
  confidence?: string;
  automationReadiness?: 'verified' | 'metadata-backed' | 'blocked';
  proofSummary?: string;
  proofCounts?: {
    verified?: number;
    metadataBacked?: number;
    blocked?: number;
  };
}

const EXPAND_OPTIONS = [4, 6, 8, 10, 12, 15];

// Rework image attachments — client-side rules mirror the /api/agent/rework-case validation.
const BULK_CONCURRENCY = 4;

function priorityClasses(p?: string): string {
  switch ((p || '').toLowerCase()) {
    case 'high':
    case 'critical':
      return 'border-red-500/30 text-red-400 bg-red-500/10';
    case 'low':
      return 'border-slate-500/30 text-slate-400 bg-slate-500/10';
    default:
      return 'border-amber-500/30 text-amber-400 bg-amber-500/10';
  }
}

function proofClasses(status?: string): string {
  switch ((status || '').toLowerCase()) {
    case 'verified':
      return 'border-emerald-500/30 text-emerald-400 bg-emerald-500/10';
    case 'metadata-backed':
      return 'border-amber-500/30 text-amber-400 bg-amber-500/10';
    case 'blocked':
      return 'border-red-500/30 text-red-400 bg-red-500/10';
    default:
      return 'border-slate-500/30 text-slate-400 bg-slate-500/10';
  }
}

export function GeneratedCases({ cases: initial, onCasesChange }: { cases: Case[]; onCasesChange?: (cases: Case[]) => void }) {
  const navigate = useNavigate();
  const [cases, setCases] = useState<Case[]>(() =>
    (initial || []).map((c) => ({ ...c, steps: (c.steps || []).map((s) => ({ ...s })) })),
  );
  // Propagate edits + adopted ids up to the persisted turn so savedness survives navigation/reload.
  const onCasesChangeRef = useRef(onCasesChange);
  onCasesChangeRef.current = onCasesChange;
  const firstSyncRef = useRef(true);
  useEffect(() => {
    if (firstSyncRef.current) { firstSyncRef.current = false; return; }
    onCasesChangeRef.current?.(cases);
  }, [cases]);
  const [editing, setEditing] = useState<number | null>(null);
  const [expandCount, setExpandCount] = useState<Record<number, number>>({});
  const [feedback, setFeedback] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [savedIdx, setSavedIdx] = useState<number | null>(null);
  // Indices edited since their last save — an id-bearing case only shows "Saved" while clean.
  const [dirtyIdx, setDirtyIdx] = useState<Set<number>>(new Set());
  const [saveError, setSaveError] = useState<Record<number, string>>({});
  // Per-case rework attachments (index-keyed like feedback).
  const [attachments, setAttachments] = useState<Record<number, AIImageAttachment[]>>({});
  const [attachError, setAttachError] = useState<Record<number, string>>({});
  // Bulk rework — selection and per-case status are keyed by case.id (stable under concurrency).
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkPrompt, setBulkPrompt] = useState('');
  const [bulkAttachments, setBulkAttachments] = useState<AIImageAttachment[]>([]);
  const [bulkAttachError, setBulkAttachError] = useState('');
  const [bulkStatus, setBulkStatus] = useState<Record<string, 'pending' | 'running' | 'done' | 'failed'>>({});
  const [bulkErrors, setBulkErrors] = useState<Record<string, string>>({});
  const [bulkRunning, setBulkRunning] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const [reworkProposal, setReworkProposal] = useState<AIReworkProposal<Case> | null>(null);
  const [reworkProposalOwner, setReworkProposalOwner] = useState<string | null>(null);
  const [reworkUndoStack, setReworkUndoStack] = useState<Case[][]>([]);
  const [reworkDirtySnapshot, setReworkDirtySnapshot] = useState<Set<number>>(new Set());
  const [reworkAppliedMessage, setReworkAppliedMessage] = useState<string | null>(null);
  const [reworkAppliedOwner, setReworkAppliedOwner] = useState<string | null>(null);

  // Cancel any in-flight bulk requests when the component unmounts.
  useEffect(() => () => abortRef.current?.abort(), []);

  if (!cases.length) return null;

  /* ---------- local editing ---------- */
  const patchCase = (i: number, patch: Partial<Case>) => {
    setCases((prev) => prev.map((c, idx) => (idx === i ? { ...c, ...patch } : c)));
    setSavedIdx(null);
    // Adopting a freshly-created id is not a user edit — everything else marks the case dirty.
    if (!('id' in patch && Object.keys(patch).length === 1)) setDirtyIdx((prev) => new Set(prev).add(i));
  };
  const patchStep = (i: number, si: number, patch: Partial<Step>) => {
    const steps = [...(cases[i]?.steps || [])];
    steps[si] = { ...steps[si], ...patch };
    patchCase(i, { steps });
  };
  const addStep = (i: number) => patchCase(i, { steps: [...(cases[i]?.steps || []), { action: '', expected: '' }] });
  const removeStep = (i: number, si: number) =>
    patchCase(i, { steps: (cases[i]?.steps || []).filter((_, idx) => idx !== si) });

  /* ---------- persistence ---------- */
  const saveCase = async (i: number, thenCollapse = false) => {
    const c = cases[i];
    if (!c) return;
    setBusy(`save-${i}`);
    setSaveError((p) => ({ ...p, [i]: '' }));
    const body = JSON.stringify({
      title: c.title,
      description: c.description || '',
      preconditions: c.preconditions || '',
      steps: c.steps || [],
      tags: c.tags || [],
      type: c.type || 'Manual',
      priority: c.priority || 'Medium',
    });
    try {
      let saved = false;
      if (c.id) {
        const res = await fetch(`/api/cases/${c.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body,
        });
        if (res.ok) saved = true;
        else if (res.status !== 404) throw new Error(`Save failed (${res.status})`);
      }
      if (!saved) {
        // Case isn't a persisted row yet (no id, or stale id 404s): create it instead of dropping the save.
        const res = await fetch('/api/cases', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        });
        if (!res.ok) throw new Error(`Save failed (${res.status})`);
        const data = await res.json().catch(() => ({}));
        // If the API returns the created id, adopt it so future saves update instead of duplicating.
        if (data?.id) patchCase(i, { id: String(data.id) });
      }
      setSavedIdx(i);
      setDirtyIdx((prev) => { const next = new Set(prev); next.delete(i); return next; });
      // Signal open Repository / Test Cases views to refetch.
      invalidateData();
      if (thenCollapse) setEditing(null);
    } catch (e: any) {
      setSaveError((p) => ({ ...p, [i]: e?.message || 'Save failed' }));
    } finally {
      setBusy(null);
    }
  };

  /* ---------- AI actions ---------- */
  const expandSteps = async (i: number) => {
    const c = cases[i];
    if (!c) return;
    setBusy(`expand-${i}`);
    try {
      const res = await fetch('/api/agent/expand-case-steps', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ testCase: c, targetStepCount: expandCount[i] || 8, targetUrl: '' }),
      });
      const data = await res.json();
      if (res.ok && Array.isArray(data.steps)) patchCase(i, { steps: data.steps });
    } finally {
      setBusy(null);
    }
  };
  const addCaseAttachments = async (i: number, files: FileList | null) => {
    const { next, error } = await appendAIImageAttachments(attachments[i] || [], files);
    setAttachments((p) => ({ ...p, [i]: next }));
    setAttachError((p) => ({ ...p, [i]: error }));
  };
  const removeCaseAttachment = (i: number, ai: number) =>
    setAttachments((p) => ({ ...p, [i]: (p[i] || []).filter((_, idx) => idx !== ai) }));

  const reworkCase = async (i: number) => {
    const c = cases[i];
    if (!c) return;
    const files = attachments[i] || [];
    setBusy(`rework-${i}`);
    try {
      const res = await fetch('/api/agent/rework-case', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ testCase: c, feedback: feedback[i] || '', targetUrl: '', attachments: files.length ? files : undefined }),
      });
      const data = await res.json();
      if (res.ok) {
        setReworkProposal(singleCaseProposal(c, { ...c, ...data }, i));
        setReworkProposalOwner(`case-${i}`);
      }
    } finally {
      setBusy(null);
    }
  };

  /* ---------- bulk rework ---------- */
  const selectableIds = cases.map((c) => c.id).filter(Boolean);
  const allSelected = selectableIds.length > 0 && selectableIds.every((id) => selectedIds.has(id));
  const toggleSelected = (id: string) => setSelectedIds((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const toggleSelectAll = () => setSelectedIds(allSelected ? new Set() : new Set(selectableIds));

  const addBulkAttachments = async (files: FileList | null) => {
    const { next, error } = await appendAIImageAttachments(bulkAttachments, files);
    setBulkAttachments(next);
    setBulkAttachError(error);
  };

  // N parallel single-case reworks (concurrency 4); each result patches back into `cases` by id.
  const runBulkRework = async () => {
    const ids = cases.filter((c) => c.id && selectedIds.has(c.id)).map((c) => c.id);
    if (!ids.length || !bulkPrompt.trim() || bulkRunning) return;
    const byId = new Map(cases.map((c) => [c.id, c]));
    const controller = new AbortController();
    abortRef.current = controller;
    setBulkRunning(true);
    setBulkStatus(Object.fromEntries(ids.map((id) => [id, 'pending' as const])));
    setBulkErrors({});
    let failed = 0;
    const proposedUpdates: Array<{ index: number; testCase: Case }> = [];
    // Each worker drains the shared queue — one case failing never stops the others.
    const queue = [...ids];
    const worker = async () => {
      for (;;) {
        const id = queue.shift();
        if (!id || controller.signal.aborted) return;
        setBulkStatus((p) => ({ ...p, [id]: 'running' }));
        try {
          const res = await fetch('/api/agent/rework-case', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: controller.signal,
            body: JSON.stringify({ testCase: byId.get(id), feedback: bulkPrompt, targetUrl: '', attachments: bulkAttachments.length ? bulkAttachments : undefined }),
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data?.error || `Rework failed (${res.status})`);
          // Patch in place by id — order is preserved even with concurrent completions.
          const sourceIndex = cases.findIndex((c) => c.id === id);
          if (sourceIndex >= 0) proposedUpdates.push({ index: sourceIndex, testCase: { ...cases[sourceIndex], ...data } });
          setBulkStatus((p) => ({ ...p, [id]: 'done' }));
        } catch (e: any) {
          if (controller.signal.aborted) return;
          failed += 1;
          setBulkStatus((p) => ({ ...p, [id]: 'failed' }));
          setBulkErrors((p) => ({ ...p, [id]: e?.message || 'Rework failed' }));
        }
      }
    };
    await Promise.allSettled(Array.from({ length: Math.min(BULK_CONCURRENCY, ids.length) }, () => worker()));
    abortRef.current = null;
    if (!controller.signal.aborted) {
      setBulkRunning(false);
      if (proposedUpdates.length) {
        proposedUpdates.sort((a, b) => a.index - b.index);
        setReworkProposal(suiteCaseProposal(cases, {
          updatedCases: proposedUpdates,
          note: failed ? `${proposedUpdates.length} proposals ready; ${failed} cases could not be generated.` : `${proposedUpdates.length} case proposals ready to review.`,
        }));
        setReworkProposalOwner('bulk');
      }
    }
  };

  const discardReworkProposal = () => {
    setReworkProposal(null);
    setReworkProposalOwner(null);
  };
  const applyReworkProposal = (selectedKeys: Set<string>) => {
    if (!reworkProposal) return;
    try {
      const result = applyAIReworkProposal(cases, reworkProposal, selectedKeys);
      const changedIndexes = reworkProposal.items
        .filter((item) => selectedKeys.has(item.key) && item.sourceIndex != null)
        .map((item) => item.sourceIndex!);
      setReworkUndoStack(result.undoSnapshots);
      setReworkDirtySnapshot(dirtyIdx);
      setReworkAppliedOwner(reworkProposalOwner);
      setCases(result.cases);
      setDirtyIdx((current) => new Set([...current, ...changedIndexes]));
      setReworkAppliedMessage(`${result.appliedCount} AI change${result.appliedCount === 1 ? '' : 's'} applied to the draft. Save to persist.`);
      if (reworkProposalOwner === 'bulk') {
        setBulkPrompt('');
        setBulkAttachments([]);
        setBulkAttachError('');
        setBulkStatus({});
      } else if (reworkProposalOwner?.startsWith('case-')) {
        const index = Number(reworkProposalOwner.slice(5));
        setFeedback((current) => ({ ...current, [index]: '' }));
        setAttachments((current) => ({ ...current, [index]: [] }));
        setAttachError((current) => ({ ...current, [index]: '' }));
      }
      discardReworkProposal();
    } catch (error: any) {
      setBulkAttachError(error?.message || 'Could not apply the AI proposal.');
    }
  };
  const undoRework = () => {
    const snapshot = reworkUndoStack.at(-1);
    if (!snapshot) return;
    const remaining = reworkUndoStack.slice(0, -1);
    setCases(snapshot);
    setReworkUndoStack(remaining);
    if (!remaining.length) setDirtyIdx(reworkDirtySnapshot);
    setReworkAppliedMessage(remaining.length
      ? `1 AI change undone. ${remaining.length} AI change${remaining.length === 1 ? '' : 's'} remain.`
      : 'AI changes undone.');
  };

  const bulkTotal = Object.keys(bulkStatus).length;
  const bulkDone = Object.values(bulkStatus).filter((s) => s === 'done').length;
  const bulkFailed = Object.values(bulkStatus).filter((s) => s === 'failed').length;

  const inputCls =
    'w-full rounded-md border border-[var(--border)] bg-[var(--bg-card)] px-2 py-1.5 text-xs text-[var(--text-primary)] outline-none focus:border-[var(--accent)]';

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs text-[var(--text-muted)]">
          {cases.length} test case{cases.length === 1 ? '' : 's'} generated — edit them right here, or open in Test Cases.
        </div>
        {selectableIds.length > 0 && (
          <button
            onClick={toggleSelectAll}
            disabled={bulkRunning}
            className="rounded-md border border-[var(--border)] bg-[var(--bg-card)] px-2 py-1 text-[11px] font-medium text-[var(--text-muted)] hover:border-[var(--accent)] hover:text-[var(--text-primary)] disabled:opacity-50"
          >
            {allSelected ? 'Select None' : 'Select All'}
          </button>
        )}
      </div>

      {/* Bulk rework preview — shown while at least one case is selected */}
      {selectedIds.size > 0 && (
        <AIReworkPanel
          scopeLabel={`${selectedIds.size} selected case${selectedIds.size === 1 ? '' : 's'}`}
          value={bulkPrompt}
          onChange={setBulkPrompt}
          onPreview={() => void runBulkRework()}
          loading={bulkRunning}
          error={bulkAttachError}
          proposal={reworkProposalOwner === 'bulk' ? reworkProposal : null}
          stale={Boolean(reworkProposalOwner === 'bulk' && reworkProposal && isAIReworkProposalStale(cases, reworkProposal))}
          onApply={applyReworkProposal}
          onDiscard={discardReworkProposal}
          appliedMessage={reworkAppliedOwner === 'bulk' ? reworkAppliedMessage : null}
          onUndo={reworkAppliedOwner === 'bulk' && reworkUndoStack.length ? undoRework : undefined}
          accessory={(
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
              <AIImageAttachmentPicker
                attachments={bulkAttachments}
                error=""
                disabled={bulkRunning}
                onAdd={(files) => void addBulkAttachments(files)}
                onRemove={(idx) => setBulkAttachments((prev) => prev.filter((_, x) => x !== idx))}
              />
              <span aria-live="polite" className="text-[11px] text-[var(--text-muted)]">
                {bulkTotal > 0 ? `${bulkDone}/${bulkTotal} ready${bulkFailed ? `, ${bulkFailed} failed` : ''}` : ''}
              </span>
            </div>
          )}
        />
      )}
      {cases.map((c, i) => (
        <div key={c.id || i} className="rounded-2xl border border-[var(--border)] bg-[var(--bg-card)] p-4">
          {/* header */}
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 items-start gap-2.5">
              {!!c.id && (
                <input
                  type="checkbox"
                  checked={selectedIds.has(c.id)}
                  onChange={() => toggleSelected(c.id)}
                  disabled={bulkRunning}
                  aria-label={`Select ${c.title} for bulk rework`}
                  className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-[var(--accent)] disabled:opacity-50"
                />
              )}
              <h3 className="min-w-0 text-sm font-semibold text-[var(--text-primary)]">{c.title}</h3>
            </div>
            <span className="flex shrink-0 items-center gap-1.5 text-[11px] font-medium text-[var(--text-muted)]">
              {bulkStatus[c.id] === 'running' && (
                <span className="inline-flex items-center gap-1 text-[var(--accent)]"><Loader2 className="h-3 w-3 animate-spin" /> Reworking…</span>
              )}
              {bulkStatus[c.id] === 'done' && (
                <span className="inline-flex items-center gap-1 text-emerald-400"><Check className="h-3 w-3" /> Reworked</span>
              )}
              {c.captureEvidenceOnManualRun !== false ? (
                <CheckSquare className="h-3.5 w-3.5 text-[var(--accent)]" />
              ) : (
                <Square className="h-3.5 w-3.5" />
              )}
              Evidence
            </span>
          </div>
          {bulkStatus[c.id] === 'failed' && !!bulkErrors[c.id] && (
            <p role="alert" className="mt-1 text-[11px] text-red-400">{bulkErrors[c.id]}</p>
          )}
          {c.description && editing !== i && <p className="mt-1 text-xs text-[var(--text-muted)]">{c.description}</p>}
          {c.preconditions && editing !== i && <p className="mt-1 text-xs text-[var(--text-muted)]"><span className="font-medium text-[var(--text-primary)]">Preconditions:</span> {c.preconditions}</p>}
          {editing !== i && (c.automationReadiness || c.proofSummary) && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {c.automationReadiness && (
                <span className={`rounded-md border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${proofClasses(c.automationReadiness)}`}>
                  {c.automationReadiness}
                </span>
              )}
              {c.proofSummary && <span className="text-[11px] text-[var(--text-muted)]">{c.proofSummary}</span>}
            </div>
          )}

          {/* tags (read) */}
          {editing !== i && !!c.tags?.length && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {c.tags.map((t, ti) => (
                <span key={ti} className="rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-0.5 text-[11px] text-[var(--text-muted)]">
                  {t.startsWith('@') ? t : `@${t}`}
                </span>
              ))}
            </div>
          )}

          {/* ---------------- READ VIEW ---------------- */}
          {editing !== i && (
            <>
              {!!c.steps?.length && (
                <div className="mt-3 overflow-hidden rounded-lg border border-[var(--border)]">
                  <table className="w-full border-collapse text-left text-xs">
                    <thead>
                      <tr className="bg-[var(--bg-secondary)] text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                        <th className="w-1/2 border-b border-[var(--border)] px-3 py-2">Test Steps</th>
                        <th className="w-1/2 border-b border-[var(--border)] px-3 py-2">Expected Result</th>
                      </tr>
                    </thead>
                    <tbody>
                      {c.steps.map((s, si) => (
                        <tr key={si} className="align-top">
                          <td className="border-b border-[var(--border)] px-3 py-2 text-[var(--text-primary)]">
                            <div className="space-y-1">
                              <div>
                                <span className="text-[var(--text-muted)]">{si + 1}.</span> {s.action}
                              </div>
                              {s.proofStatus && (
                                <div className="flex flex-wrap items-center gap-1.5">
                                  <span className={`rounded-md border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider ${proofClasses(s.proofStatus)}`}>
                                    {s.proofStatus}
                                  </span>
                                  {!!s.proofTokens?.length && (
                                    <span className="text-[10px] text-[var(--text-muted)]">{s.proofTokens.join(', ')}</span>
                                  )}
                                </div>
                              )}
                            </div>
                          </td>
                          <td className="border-b border-[var(--border)] px-3 py-2 text-[var(--text-muted)]">{s.expected}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <div className="mt-3 flex items-center justify-between">
                <span className={`rounded-md border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${priorityClasses(c.priority)}`}>
                  {c.priority || 'Medium'}
                </span>
                <div className="flex items-center gap-3">
                  {(savedIdx === i || (c.id && !dirtyIdx.has(i))) && (
                    <span className="inline-flex items-center gap-1 text-[11px] text-emerald-400"><Check className="h-3.5 w-3.5" /> Saved</span>
                  )}
                  <button
                    onClick={() => navigate(`/cases?search=${encodeURIComponent(c.id)}`)}
                    className="text-xs font-medium text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:underline"
                  >
                    Open in Test Cases
                  </button>
                  <button
                    onClick={() => setEditing(i)}
                    disabled={bulkRunning}
                    className="inline-flex min-h-8 items-center gap-1.5 rounded px-1.5 text-xs font-medium text-[var(--text-muted)] hover:bg-[var(--accent)]/10 hover:text-[var(--accent)] disabled:opacity-50"
                  >
                    <Sparkles className="h-3.5 w-3.5" /> Rework
                  </button>
                  <button
                    onClick={() => setEditing(i)}
                    disabled={bulkRunning}
                    className="inline-flex items-center gap-1.5 text-xs font-medium text-[var(--accent)] hover:underline disabled:opacity-50"
                  >
                    <Pencil className="h-3.5 w-3.5" /> Edit
                  </button>
                </div>
              </div>
            </>
          )}

          {/* ---------------- EDIT VIEW ---------------- */}
          {editing === i && (
            <div className="mt-3 space-y-3">
              <input value={c.title || ''} onChange={(e) => patchCase(i, { title: e.target.value })} placeholder="Title" className={inputCls} />
              <textarea value={c.description || ''} onChange={(e) => patchCase(i, { description: e.target.value })} placeholder="Description" className={`${inputCls} h-16`} />
              <textarea value={c.preconditions || ''} onChange={(e) => patchCase(i, { preconditions: e.target.value })} placeholder="Preconditions (state that must be true before the steps run)" className={`${inputCls} h-16`} />
              <div className="grid grid-cols-2 gap-2">
                <select value={c.priority || 'Medium'} onChange={(e) => patchCase(i, { priority: e.target.value })} className={inputCls}>
                  <option>Low</option>
                  <option>Medium</option>
                  <option>High</option>
                  <option>Critical</option>
                </select>
                <input
                  value={Array.isArray(c.tags) ? c.tags.join(', ') : (c.tags as any) || ''}
                  onChange={(e) => patchCase(i, { tags: normalizeTags(e.target.value.split(',')) })}
                  placeholder="Tags (comma separated)"
                  className={inputCls}
                />
              </div>

              {/* Steps editor */}
              <div className="space-y-1.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">Test Steps</span>
                  <div className="flex items-center gap-1.5">
                    <span className="text-[11px] text-[var(--text-muted)]">Expand to</span>
                    <select
                      value={expandCount[i] || 8}
                      onChange={(e) => setExpandCount((p) => ({ ...p, [i]: Number(e.target.value) }))}
                      className="rounded-md border border-[var(--border)] bg-[var(--bg-card)] px-1.5 py-1 text-[11px] text-[var(--text-primary)] outline-none"
                    >
                      {EXPAND_OPTIONS.map((n) => (
                        <option key={n} value={n}>{n}</option>
                      ))}
                    </select>
                    <button
                      onClick={() => expandSteps(i)}
                      disabled={bulkRunning || busy === `expand-${i}`}
                      className="inline-flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--bg-card)] px-2 py-1 text-[11px] font-medium text-[var(--text-primary)] hover:border-[var(--accent)] disabled:opacity-50"
                    >
                      {busy === `expand-${i}` ? <Loader2 className="h-3 w-3 animate-spin" /> : <SplitSquareHorizontal className="h-3 w-3" />}
                      Expand Steps
                    </button>
                  </div>
                </div>
                {(c.steps || []).map((s, si) => (
                  <div key={si} className="grid grid-cols-1 gap-1.5 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] p-1.5 lg:grid-cols-[1fr_1fr_auto]">
                    <textarea
                      value={s.action || ''}
                      onChange={(e) => patchStep(i, si, { action: e.target.value })}
                      placeholder={`Step ${si + 1} action`}
                      className="min-h-[3rem] resize-y rounded border border-[var(--border)] bg-[var(--bg-card)] px-2 py-1 text-[11px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
                    />
                    <textarea
                      value={s.expected || ''}
                      onChange={(e) => patchStep(i, si, { expected: e.target.value })}
                      placeholder="Expected result"
                      className="min-h-[3rem] resize-y rounded border border-[var(--border)] bg-[var(--bg-card)] px-2 py-1 text-[11px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
                    />
                    <button onClick={() => removeStep(i, si)} className="rounded px-2 text-[11px] font-medium text-red-400 hover:bg-red-500/10">
                      Remove
                    </button>
                  </div>
                ))}
                <button onClick={() => addStep(i)} className="text-[11px] font-medium text-[var(--accent)] hover:underline">
                  + Add step
                </button>
              </div>

              <div className="space-y-2 border-t border-[var(--border)] pt-2">
                <AIReworkPanel
                  compact
                  scopeLabel={c.title || `Case ${i + 1}`}
                  showScopeLabel={false}
                  value={feedback[i] || ''}
                  onChange={(value) => setFeedback((current) => ({ ...current, [i]: value }))}
                  onPreview={() => void reworkCase(i)}
                  loading={busy === `rework-${i}`}
                  error={attachError[i] || saveError[i]}
                  proposal={reworkProposalOwner === `case-${i}` ? reworkProposal : null}
                  stale={Boolean(reworkProposalOwner === `case-${i}` && reworkProposal && isAIReworkProposalStale(cases, reworkProposal))}
                  onApply={applyReworkProposal}
                  onDiscard={discardReworkProposal}
                  appliedMessage={reworkAppliedOwner === `case-${i}` ? reworkAppliedMessage : null}
                  onUndo={reworkAppliedOwner === `case-${i}` && reworkUndoStack.length ? undoRework : undefined}
                  accessory={(
                    <div className="mt-2">
                      <AIImageAttachmentPicker
                        attachments={attachments[i] || []}
                        error=""
                        disabled={bulkRunning}
                        onAdd={(files) => void addCaseAttachments(i, files)}
                        onRemove={(idx) => removeCaseAttachment(i, idx)}
                      />
                    </div>
                  )}
                />
                <div className="flex justify-end">
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setEditing(null)}
                      className="rounded-md border border-[var(--border)] bg-[var(--bg-card)] px-3 py-1.5 text-[11px] font-medium text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:border-[var(--accent)]"
                    >
                      Close
                    </button>
                    <button
                      onClick={() => saveCase(i, true)}
                      disabled={bulkRunning || busy === `save-${i}`}
                      className="inline-flex items-center gap-1.5 rounded-md bg-[var(--accent)] px-3 py-1.5 text-[11px] font-medium text-white hover:bg-[var(--accent-hover)] disabled:opacity-50"
                    >
                      {busy === `save-${i}` ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                      Save Changes
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
