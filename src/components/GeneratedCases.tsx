import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CheckSquare, Square, Pencil, Trash2, SplitSquareHorizontal, Send, Loader2, Check } from 'lucide-react';

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
    if (!c?.id) return;
    setBusy(`save-${i}`);
    try {
      await fetch(`/api/cases/${c.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: c.title,
          description: c.description || '',
          steps: c.steps || [],
          tags: c.tags || [],
          type: c.type || 'Manual',
          priority: c.priority || 'Medium',
        }),
      });
      setSavedIdx(i);
      if (thenCollapse) setEditing(null);
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
  const reworkCase = async (i: number) => {
    const c = cases[i];
    if (!c) return;
    setBusy(`rework-${i}`);
    try {
      const res = await fetch('/api/agent/rework-case', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ testCase: c, feedback: feedback[i] || '', targetUrl: '' }),
      });
      const data = await res.json();
      if (res.ok) {
        patchCase(i, data);
        setFeedback((p) => ({ ...p, [i]: '' }));
      }
    } finally {
      setBusy(null);
    }
  };

  const inputCls =
    'w-full rounded-md border border-[var(--border)] bg-[var(--bg-card)] px-2 py-1.5 text-xs text-[var(--text-primary)] outline-none focus:border-[var(--accent)]';

  return (
    <div className="space-y-3">
      <div className="text-xs text-[var(--text-muted)]">
        {cases.length} test case{cases.length === 1 ? '' : 's'} generated — edit them right here, or open in Test Cases.
      </div>
      {cases.map((c, i) => (
        <div key={c.id || i} className="rounded-2xl border border-[var(--border)] bg-[var(--bg-card)] p-4">
          {/* header */}
          <div className="flex items-start justify-between gap-3">
            <h3 className="min-w-0 text-sm font-semibold text-[var(--text-primary)]">{c.title}</h3>
            <span className="flex shrink-0 items-center gap-1.5 text-[11px] font-medium text-[var(--text-muted)]">
              {c.captureEvidenceOnManualRun !== false ? (
                <CheckSquare className="h-3.5 w-3.5 text-[var(--accent)]" />
              ) : (
                <Square className="h-3.5 w-3.5" />
              )}
              Evidence
            </span>
          </div>
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
                    className="inline-flex items-center gap-1.5 text-xs font-medium text-[var(--accent)] hover:underline"
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
                      disabled={busy === `expand-${i}`}
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
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <button
                    onClick={() => reworkCase(i)}
                    disabled={busy === `rework-${i}` || !(feedback[i] || '').trim()}
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
                      disabled={busy === `save-${i}`}
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
