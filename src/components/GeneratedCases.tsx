import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CheckSquare, Square, Pencil, Trash2, SplitSquareHorizontal, Send, Loader2, Check, Paperclip, X } from 'lucide-react';
import { invalidateData } from '@/src/store/data';

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
interface ReworkAttachment { name: string; mimeType: string; dataBase64: string }
const ATTACH_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const MAX_ATTACHMENTS = 4;
const MAX_ATTACH_BYTES = 5 * 1024 * 1024;
const BULK_CONCURRENCY = 4;

// Reads a File into raw base64 (the data: URL prefix stripped).
function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
    reader.readAsDataURL(file);
  });
}

// Validate + read picked image files into base64 attachments (max 4, 5MB, png/jpeg/webp/gif).
async function appendAttachments(current: ReworkAttachment[], files: FileList | null): Promise<{ next: ReworkAttachment[]; error: string }> {
  const errs: string[] = [];
  const next = [...current];
  for (const f of Array.from(files || [])) {
    if (next.length >= MAX_ATTACHMENTS) { errs.push(`Max ${MAX_ATTACHMENTS} images per rework.`); break; }
    if (!ATTACH_TYPES.includes(f.type)) { errs.push(`${f.name}: only PNG, JPEG, WebP or GIF images are allowed.`); continue; }
    if (f.size > MAX_ATTACH_BYTES) { errs.push(`${f.name}: exceeds the 5MB limit.`); continue; }
    try { next.push({ name: f.name, mimeType: f.type, dataBase64: await readFileAsBase64(f) }); }
    catch (e: any) { errs.push(e?.message || `Could not read ${f.name}`); }
  }
  return { next, error: errs.join(' ') };
}

// Small "Attach" button + removable chip list, shared by the per-case and bulk rework blocks.
function AttachmentPicker({ attachments, error, disabled, onAdd, onRemove }: {
  attachments: ReworkAttachment[];
  error?: string;
  disabled?: boolean;
  onAdd: (files: FileList | null) => void;
  onRemove: (index: number) => void;
}) {
  return (
    <>
      <div className="flex flex-wrap items-center gap-1.5">
        <label className={`inline-flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--bg-card)] px-2 py-1 text-[11px] font-medium text-[var(--text-muted)] ${disabled ? 'opacity-50' : 'cursor-pointer hover:border-[var(--accent)] hover:text-[var(--text-primary)]'}`}>
          <Paperclip className="h-3 w-3" /> Attach
          <input type="file" accept="image/*" multiple disabled={disabled} className="sr-only" onChange={(e) => { onAdd(e.target.files); e.target.value = ''; }} />
        </label>
        {attachments.map((a, ai) => (
          <span key={ai} className="inline-flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-0.5 text-[11px] text-[var(--text-muted)]">
            {a.name}
            <button type="button" onClick={() => onRemove(ai)} disabled={disabled} aria-label={`Remove ${a.name}`} className="hover:text-red-400 disabled:opacity-50">
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
      </div>
      {error && <p role="alert" className="text-[11px] text-red-400">{error}</p>}
    </>
  );
}

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

export function GeneratedCases({ cases: initial }: { cases: Case[] }) {
  const navigate = useNavigate();
  const [cases, setCases] = useState<Case[]>(() =>
    (initial || []).map((c) => ({ ...c, steps: (c.steps || []).map((s) => ({ ...s })) })),
  );
  const [editing, setEditing] = useState<number | null>(null);
  const [expandCount, setExpandCount] = useState<Record<number, number>>({});
  const [feedback, setFeedback] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [savedIdx, setSavedIdx] = useState<number | null>(null);
  const [saveError, setSaveError] = useState<Record<number, string>>({});
  // Per-case rework attachments (index-keyed like feedback).
  const [attachments, setAttachments] = useState<Record<number, ReworkAttachment[]>>({});
  const [attachError, setAttachError] = useState<Record<number, string>>({});
  // Bulk rework — selection and per-case status are keyed by case.id (stable under concurrency).
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkPrompt, setBulkPrompt] = useState('');
  const [bulkAttachments, setBulkAttachments] = useState<ReworkAttachment[]>([]);
  const [bulkAttachError, setBulkAttachError] = useState('');
  const [bulkStatus, setBulkStatus] = useState<Record<string, 'pending' | 'running' | 'done' | 'failed'>>({});
  const [bulkErrors, setBulkErrors] = useState<Record<string, string>>({});
  const [bulkRunning, setBulkRunning] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  // Cancel any in-flight bulk requests when the component unmounts.
  useEffect(() => () => abortRef.current?.abort(), []);

  if (!cases.length) return null;

  /* ---------- local editing ---------- */
  const patchCase = (i: number, patch: Partial<Case>) => {
    setCases((prev) => prev.map((c, idx) => (idx === i ? { ...c, ...patch } : c)));
    setSavedIdx(null);
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
    const { next, error } = await appendAttachments(attachments[i] || [], files);
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
        patchCase(i, data);
        setFeedback((p) => ({ ...p, [i]: '' }));
        setAttachments((p) => ({ ...p, [i]: [] }));
        setAttachError((p) => ({ ...p, [i]: '' }));
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
    const { next, error } = await appendAttachments(bulkAttachments, files);
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
          setCases((prev) => prev.map((c) => (c.id === id ? { ...c, ...data } : c)));
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
      // A fully clean run consumes the shared prompt + attachments.
      if (failed === 0) { setBulkPrompt(''); setBulkAttachments([]); setBulkAttachError(''); }
    }
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
            {allSelected ? 'Select none' : 'Select all'}
          </button>
        )}
      </div>

      {/* Bulk rework bar — shown while at least one case is selected */}
      {selectedIds.size > 0 && (
        <div className="space-y-1.5 rounded-2xl border border-[var(--border)] bg-[var(--bg-card)] p-3">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
            Rework {selectedIds.size} selected case{selectedIds.size === 1 ? '' : 's'} with AI
          </div>
          <textarea
            value={bulkPrompt}
            onChange={(e) => setBulkPrompt(e.target.value)}
            disabled={bulkRunning}
            placeholder="Tell the AI how to rework the selected cases (applies to every selected case)…"
            className={`${inputCls} h-14 disabled:opacity-50`}
          />
          <AttachmentPicker
            attachments={bulkAttachments}
            error={bulkAttachError}
            disabled={bulkRunning}
            onAdd={(files) => void addBulkAttachments(files)}
            onRemove={(idx) => setBulkAttachments((prev) => prev.filter((_, x) => x !== idx))}
          />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <button
              onClick={() => void runBulkRework()}
              disabled={bulkRunning || !bulkPrompt.trim()}
              className="inline-flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--bg-card)] px-3 py-1.5 text-[11px] font-medium text-[var(--text-primary)] hover:border-[var(--accent)] disabled:opacity-50"
            >
              {bulkRunning ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}
              Rework selected with AI
            </button>
            <span aria-live="polite" className="text-[11px] text-[var(--text-muted)]">
              {bulkTotal > 0 ? `${bulkDone}/${bulkTotal} done${bulkFailed ? `, ${bulkFailed} failed` : ''}` : ''}
            </span>
          </div>
        </div>
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
                  {savedIdx === i && (
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
              <div className="grid grid-cols-2 gap-2">
                <select value={c.priority || 'Medium'} onChange={(e) => patchCase(i, { priority: e.target.value })} className={inputCls}>
                  <option>Low</option>
                  <option>Medium</option>
                  <option>High</option>
                  <option>Critical</option>
                </select>
                <input
                  value={Array.isArray(c.tags) ? c.tags.join(', ') : (c.tags as any) || ''}
                  onChange={(e) => patchCase(i, { tags: e.target.value.split(',').map((t) => t.trim()).filter(Boolean) })}
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
                      Expand steps
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

              {/* Rework with AI */}
              <div className="space-y-1.5 border-t border-[var(--border)] pt-2">
                <textarea
                  value={feedback[i] || ''}
                  onChange={(e) => setFeedback((p) => ({ ...p, [i]: e.target.value }))}
                  placeholder="Tell the AI how to rework this case (e.g. add negative + boundary checks)…"
                  className={`${inputCls} h-14`}
                />
                <AttachmentPicker
                  attachments={attachments[i] || []}
                  error={attachError[i]}
                  disabled={bulkRunning}
                  onAdd={(files) => void addCaseAttachments(i, files)}
                  onRemove={(idx) => removeCaseAttachment(i, idx)}
                />
                {saveError[i] && (
                  <p role="alert" className="text-[11px] text-red-400">{saveError[i]}</p>
                )}
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <button
                    onClick={() => reworkCase(i)}
                    disabled={bulkRunning || busy === `rework-${i}` || !(feedback[i] || '').trim()}
                    className="inline-flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--bg-card)] px-3 py-1.5 text-[11px] font-medium text-[var(--text-primary)] hover:border-[var(--accent)] disabled:opacity-50"
                  >
                    {busy === `rework-${i}` ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}
                    Rework with AI
                  </button>
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
                      Save changes
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
