import { useEffect, useState, type ReactElement } from 'react';
import { useNavigate } from 'react-router-dom';
import { FlaskConical, Pencil, SplitSquareHorizontal, Send, Loader2, Check, Link2Off } from 'lucide-react';
import { showAlert } from '@/src/lib/dialog';

/**
 * A single test case rendered as an inline-editable card — the same editing
 * experience as the Agent Console's generated cases:
 *   - edit title / description / priority / status / tags
 *   - add / remove / edit individual steps
 *   - AI-expand a case to N steps (POST /api/agent/expand-case-steps)
 *   - AI-rework a case from feedback (POST /api/agent/rework-case)
 *   - save back to the stored case (PUT /api/cases/:id)
 * Reused by Traceability so linked cases are editable in place.
 */

interface Step {
  action: string;
  expected: string;
}
export interface EditableCase {
  id: string;
  title: string;
  description?: string;
  priority?: string;
  status?: string;
  type?: string;
  tags?: string[];
  steps?: Step[];
  missing?: boolean;
}

const EXPAND_OPTIONS = [4, 6, 8, 10, 12, 15];
const CASE_STATUSES = ['Draft', 'Under Review', 'Approved', 'Automated', 'Deprecated'];

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

interface Props {
  key?: string;
  initial: EditableCase;
  linkType?: 'existing' | 'generated';
  selected?: boolean;
  onToggleSelected?: () => void;
  onUnlink?: () => void;
  /** Called after a successful save / AI edit so the parent can refresh. */
  onSaved?: () => void;
}

export default function EditableCaseCard({ initial, linkType, selected, onToggleSelected, onUnlink, onSaved }: Props): ReactElement {
  const navigate = useNavigate();
  const [c, setC] = useState<EditableCase>(() => ({ ...initial, steps: (initial.steps || []).map((s) => ({ ...s })) }));
  const [editing, setEditing] = useState(false);
  const [expandCount, setExpandCount] = useState(8);
  const [feedback, setFeedback] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Re-seed when the underlying case identity changes (e.g. after a parent refresh).
  useEffect(() => {
    setC({ ...initial, steps: (initial.steps || []).map((s) => ({ ...s })) });
  }, [initial.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const isGenerated = linkType === 'generated';
  const linkBadgeCls = isGenerated
    ? 'border-sky-500/30 bg-sky-500/10 text-sky-400'
    : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400';

  /* ---------- local editing ---------- */
  const patch = (p: Partial<EditableCase>) => { setC((prev) => ({ ...prev, ...p })); setSaved(false); };
  const patchStep = (si: number, p: Partial<Step>) => {
    const steps = [...(c.steps || [])];
    steps[si] = { ...steps[si], ...p };
    patch({ steps });
  };
  const addStep = () => patch({ steps: [...(c.steps || []), { action: '', expected: '' }] });
  const removeStep = (si: number) => patch({ steps: (c.steps || []).filter((_, idx) => idx !== si) });

  /* ---------- persistence ---------- */
  const persist = async (body: Record<string, any>, key: string) => {
    if (!c.id) return false;
    setBusy(key);
    try {
      const res = await fetch(`/api/cases/${c.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        void showAlert(data.error || 'Failed to update test case.');
        return false;
      }
      return true;
    } finally {
      setBusy(null);
    }
  };

  const saveCase = async () => {
    const ok = await persist({
      title: c.title,
      description: c.description || '',
      steps: c.steps || [],
      tags: c.tags || [],
      type: c.type || 'Manual',
      priority: c.priority || 'Medium',
      status: c.status || 'Draft',
    }, 'save');
    if (ok) { setSaved(true); setEditing(false); onSaved?.(); }
  };

  // Quick status change from the read view (no need to enter edit mode).
  const quickStatus = async (status: string) => {
    patch({ status });
    const ok = await persist({ status }, 'status');
    if (ok) onSaved?.();
  };

  /* ---------- AI actions ---------- */
  const expandSteps = async () => {
    setBusy('expand');
    try {
      const res = await fetch('/api/agent/expand-case-steps', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ testCase: c, targetStepCount: expandCount, targetUrl: '' }),
      });
      const data = await res.json();
      if (res.ok && Array.isArray(data.steps)) patch({ steps: data.steps });
    } finally {
      setBusy(null);
    }
  };
  const reworkCase = async () => {
    setBusy('rework');
    try {
      const res = await fetch('/api/agent/rework-case', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ testCase: c, feedback, targetUrl: '' }),
      });
      const data = await res.json();
      if (res.ok) { patch(data); setFeedback(''); }
    } finally {
      setBusy(null);
    }
  };

  const inputCls = 'w-full rounded-md border border-[var(--border)] bg-[var(--bg-card)] px-2 py-1.5 text-xs text-[var(--text-primary)] outline-none focus:border-[var(--accent)]';

  /* ---------- deleted/missing case ---------- */
  if (c.missing) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--bg-card)] px-3 py-2 text-xs">
        <FlaskConical className="h-3.5 w-3.5 text-[var(--text-muted)]" />
        <span className="font-mono text-[11px] text-[var(--text-muted)]">{c.id}</span>
        <span className="flex-1 italic text-[var(--text-muted)]">{c.title || '(deleted case)'}</span>
        {onUnlink && (
          <button onClick={onUnlink} title="Unlink from requirement" className="rounded p-1 text-[var(--text-muted)] hover:bg-[var(--border)]">
            <Link2Off className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-4">
      {/* header */}
      <div className="flex items-start gap-2.5">
        {onToggleSelected && (
          <input
            type="checkbox"
            checked={!!selected}
            onChange={onToggleSelected}
            className="mt-0.5 rounded border-[var(--border)] text-[var(--accent)] focus:ring-[var(--accent)]"
          />
        )}
        <FlaskConical className={`mt-0.5 h-4 w-4 shrink-0 ${isGenerated ? 'text-sky-400' : 'text-emerald-400'}`} />
        <h3 className="min-w-0 flex-1 text-sm font-semibold text-[var(--text-primary)]">
          {c.title}
          <span className="ml-2 font-mono text-[11px] font-normal text-[var(--text-muted)]">{c.id}</span>
        </h3>
        {linkType && (
          <span className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase ${linkBadgeCls}`}>
            {isGenerated ? 'Generated' : 'Existing'}
          </span>
        )}
      </div>

      {c.description && !editing && <p className="mt-1 pl-6 text-xs text-[var(--text-muted)]">{c.description}</p>}

      {/* tags (read) */}
      {!editing && !!c.tags?.length && (
        <div className="mt-2 flex flex-wrap gap-1.5 pl-6">
          {c.tags.map((t, ti) => (
            <span key={ti} className="rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-0.5 text-[11px] text-[var(--text-muted)]">
              {t.startsWith('@') ? t : `@${t}`}
            </span>
          ))}
        </div>
      )}

      {/* ---------------- READ VIEW ---------------- */}
      {!editing && (
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
                        <span className="text-[var(--text-muted)]">{si + 1}.</span> {s.action}
                      </td>
                      <td className="border-b border-[var(--border)] px-3 py-2 text-[var(--text-muted)]">{s.expected}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className={`rounded-md border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${priorityClasses(c.priority)}`}>
                {c.priority || 'Medium'}
              </span>
              <select
                value={c.status || 'Draft'}
                onChange={(e) => quickStatus(e.target.value)}
                disabled={busy === 'status'}
                className="rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1 text-xs font-medium text-[var(--text-primary)] outline-none transition-colors hover:border-[var(--accent)] focus:border-[var(--accent)]"
              >
                {CASE_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div className="flex items-center gap-3">
              {saved && <span className="inline-flex items-center gap-1 text-[11px] text-emerald-400"><Check className="h-3.5 w-3.5" /> Saved</span>}
              <button onClick={() => navigate(`/cases?search=${encodeURIComponent(c.id)}`)} className="text-xs font-medium text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:underline">
                Open in Test Cases
              </button>
              <button onClick={() => setEditing(true)} className="inline-flex items-center gap-1.5 text-xs font-medium text-[var(--accent)] hover:underline">
                <Pencil className="h-3.5 w-3.5" /> Edit
              </button>
              {onUnlink && (
                <button onClick={onUnlink} title="Unlink from requirement" className="inline-flex items-center gap-1.5 text-xs font-medium text-[var(--text-muted)] hover:text-red-400">
                  <Link2Off className="h-3.5 w-3.5" /> Unlink
                </button>
              )}
            </div>
          </div>
        </>
      )}

      {/* ---------------- EDIT VIEW ---------------- */}
      {editing && (
        <div className="mt-3 space-y-3">
          <input value={c.title || ''} onChange={(e) => patch({ title: e.target.value })} placeholder="Title" className={inputCls} />
          <textarea value={c.description || ''} onChange={(e) => patch({ description: e.target.value })} placeholder="Description" className={`${inputCls} h-16`} />
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <select value={c.priority || 'Medium'} onChange={(e) => patch({ priority: e.target.value })} className={inputCls}>
              <option>Low</option>
              <option>Medium</option>
              <option>High</option>
              <option>Critical</option>
            </select>
            <select value={c.status || 'Draft'} onChange={(e) => patch({ status: e.target.value })} className={inputCls}>
              {CASE_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            <input
              value={Array.isArray(c.tags) ? c.tags.join(', ') : (c.tags as any) || ''}
              onChange={(e) => patch({ tags: e.target.value.split(',').map((t) => t.trim()).filter(Boolean) })}
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
                <select value={expandCount} onChange={(e) => setExpandCount(Number(e.target.value))} className="rounded-md border border-[var(--border)] bg-[var(--bg-card)] px-1.5 py-1 text-[11px] text-[var(--text-primary)] outline-none">
                  {EXPAND_OPTIONS.map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
                <button onClick={expandSteps} disabled={busy === 'expand'} className="inline-flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--bg-card)] px-2 py-1 text-[11px] font-medium text-[var(--text-primary)] hover:border-[var(--accent)] disabled:opacity-50">
                  {busy === 'expand' ? <Loader2 className="h-3 w-3 animate-spin" /> : <SplitSquareHorizontal className="h-3 w-3" />}
                  Expand steps
                </button>
              </div>
            </div>
            {(c.steps || []).map((s, si) => (
              <div key={si} className="grid grid-cols-1 gap-1.5 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] p-1.5 lg:grid-cols-[1fr_1fr_auto]">
                <textarea value={s.action || ''} onChange={(e) => patchStep(si, { action: e.target.value })} placeholder={`Step ${si + 1} action`} className="min-h-[3rem] resize-y rounded border border-[var(--border)] bg-[var(--bg-card)] px-2 py-1 text-[11px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]" />
                <textarea value={s.expected || ''} onChange={(e) => patchStep(si, { expected: e.target.value })} placeholder="Expected result" className="min-h-[3rem] resize-y rounded border border-[var(--border)] bg-[var(--bg-card)] px-2 py-1 text-[11px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]" />
                <button onClick={() => removeStep(si)} className="rounded px-2 text-[11px] font-medium text-red-400 hover:bg-red-500/10">Remove</button>
              </div>
            ))}
            <button onClick={addStep} className="text-[11px] font-medium text-[var(--accent)] hover:underline">+ Add step</button>
          </div>

          {/* Rework with AI */}
          <div className="space-y-1.5 border-t border-[var(--border)] pt-2">
            <textarea value={feedback} onChange={(e) => setFeedback(e.target.value)} placeholder="Tell the AI how to rework this case (e.g. add negative + boundary checks)…" className={`${inputCls} h-14`} />
            <div className="flex flex-wrap items-center justify-between gap-2">
              <button onClick={reworkCase} disabled={busy === 'rework' || !feedback.trim()} className="inline-flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--bg-card)] px-3 py-1.5 text-[11px] font-medium text-[var(--text-primary)] hover:border-[var(--accent)] disabled:opacity-50">
                {busy === 'rework' ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}
                Rework with AI
              </button>
              <div className="flex items-center gap-2">
                <button onClick={() => { setEditing(false); setC({ ...initial, steps: (initial.steps || []).map((s) => ({ ...s })) }); }} className="rounded-md border border-[var(--border)] bg-[var(--bg-card)] px-3 py-1.5 text-[11px] font-medium text-[var(--text-muted)] hover:border-[var(--accent)] hover:text-[var(--text-primary)]">
                  Cancel
                </button>
                <button onClick={saveCase} disabled={busy === 'save'} className="inline-flex items-center gap-1.5 rounded-md bg-[var(--accent)] px-3 py-1.5 text-[11px] font-medium text-white hover:bg-[var(--accent-hover)] disabled:opacity-50">
                  {busy === 'save' ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                  Save changes
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
