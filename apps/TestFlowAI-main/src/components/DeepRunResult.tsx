import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { cn } from '@/src/lib/utils';
import {
  Loader2,
  CheckCircle2,
  XCircle,
  Download,
  FlaskConical,
  Code2,
  Image as ImageIcon,
  ChevronDown,
  ArrowRight,
  PlayCircle,
  ClipboardList,
  Plus,
  Trash2,
  Save,
  Send,
  SplitSquareHorizontal,
  Pencil,
} from 'lucide-react';

/**
 * DeepRunResult — renders a deep test-generation pipeline run inline in the
 * Agent Console, and lets the human do all the "drudge" case work without
 * leaving the conversation:
 *   - edit a case (title, description, priority, tags)
 *   - add a case manually
 *   - add / remove / edit individual steps
 *   - AI-expand a case to N steps
 *   - AI-rework a case from feedback
 *   - the review gate: Continue (generate scripts + evidence) / Save all
 *
 * The run is started in `review_cases` mode, so the pipeline pauses after the
 * cases are written. The human curates them, then continues.
 */

const PIPELINE: { key: string; label: string }[] = [
  { key: 'ApplicationInspector', label: 'Inspect app' },
  { key: 'TestGenerationAgent', label: 'Write cases' },
  { key: 'PlaywrightAgent', label: 'Generate scripts' },
  { key: 'EvidenceAgent', label: 'Capture evidence' },
];

const TERMINAL = ['completed', 'failed', 'review_required'];
const EXPAND_OPTIONS = [4, 5, 6, 8, 10, 12];

type Step = { action: string; expected: string };
type Case = {
  title: string;
  description?: string;
  priority?: string;
  type?: string;
  tags?: string[];
  steps?: Step[];
  captureEvidence?: boolean;
};

export function DeepRunResult({ taskId }: { taskId: string }) {
  const [run, setRun] = useState<any>(null);
  const [tab, setTab] = useState<'cases' | 'code' | 'evidence'>('cases');
  const [cases, setCases] = useState<Case[] | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [expandedScript, setExpandedScript] = useState<number | null>(null);
  const [feedback, setFeedback] = useState<Record<number, string>>({});
  const [expandCount, setExpandCount] = useState<Record<number, number>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const activeRef = useRef(true);
  const navigate = useNavigate();

  const tick = useCallback(async () => {
    if (!activeRef.current) return;
    try {
      const r = await fetch(`/api/agent-runs/${taskId}`);
      const data = await r.json();
      if (!activeRef.current) return;
      setRun(data);
      if (TERMINAL.includes(data?.status)) return;
    } catch {
      /* keep polling */
    }
    if (activeRef.current) setTimeout(tick, 2000);
  }, [taskId]);

  useEffect(() => {
    activeRef.current = true;
    tick();
    return () => {
      activeRef.current = false;
    };
  }, [tick]);

  // Seed the editable copy once the pipeline has written cases.
  useEffect(() => {
    if (cases === null && run?.generated_cases?.length) {
      setCases(run.generated_cases.map((c: Case) => ({ ...c, steps: (c.steps || []).map((s) => ({ ...s })) })));
    }
  }, [run, cases]);

  const status = run?.status;
  const scripts: any[] = run?.playwright_scripts || [];
  const evidence: any[] = run?.evidence_screenshots || [];
  const targetUrl: string = run?.app_url || '';
  const isRunning = !status || !TERMINAL.includes(status);
  const failed = status === 'failed';
  const reviewing = status === 'review_required';
  const list = cases || [];

  const agentState = (agent: string): string => {
    const msg = (run?.messages || []).filter((m: any) => m.agent === agent).pop();
    return msg?.status || 'pending';
  };

  /* ---------- local case editing ---------- */
  const patchCase = (i: number, patch: Partial<Case>) => {
    setCases((prev) => (prev ? prev.map((c, idx) => (idx === i ? { ...c, ...patch } : c)) : prev));
    setSaved(false);
  };
  const patchStep = (i: number, si: number, patch: Partial<Step>) => {
    const c = list[i];
    if (!c) return;
    const steps = [...(c.steps || [])];
    steps[si] = { ...steps[si], ...patch };
    patchCase(i, { steps });
  };
  const addStep = (i: number) => patchCase(i, { steps: [...(list[i]?.steps || []), { action: '', expected: '' }] });
  const removeStep = (i: number, si: number) =>
    patchCase(i, { steps: (list[i]?.steps || []).filter((_, idx) => idx !== si) });
  const addCase = () => {
    setCases((prev) => [
      ...(prev || []),
      { title: 'New test case', description: '', priority: 'Medium', type: 'Manual', tags: [], steps: [{ action: '', expected: '' }], captureEvidence: true },
    ]);
    setEditing((prev) => (prev === null ? (cases?.length || 0) : prev));
    setSaved(false);
  };
  const removeCase = (i: number) => {
    setCases((prev) => (prev ? prev.filter((_, idx) => idx !== i) : prev));
    setEditing(null);
    setSaved(false);
  };

  /* ---------- AI actions ---------- */
  const expandSteps = async (i: number) => {
    const c = list[i];
    if (!c) return;
    setBusy(`expand-${i}`);
    try {
      const res = await fetch('/api/agent/expand-case-steps', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ testCase: c, targetStepCount: expandCount[i] || 8, targetUrl }),
      });
      const data = await res.json();
      if (res.ok && Array.isArray(data.steps)) patchCase(i, { steps: data.steps });
    } finally {
      setBusy(null);
    }
  };
  const reworkCase = async (i: number) => {
    const c = list[i];
    if (!c) return;
    setBusy(`rework-${i}`);
    try {
      const res = await fetch('/api/agent/rework-case', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ testCase: c, feedback: feedback[i] || '', targetUrl }),
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
  const saveAll = async () => {
    if (!list.length) return;
    setBusy('save');
    try {
      await fetch('/api/agent/save-cases', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cases: list, taskId }),
      });
      setSaved(true);
    } finally {
      setBusy(null);
    }
  };
  const continueFlow = async () => {
    if (!list.length) return;
    setBusy('continue');
    try {
      const res = await fetch('/api/agent/continue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId, cases: list }),
      });
      if (res.ok) {
        setRun((prev: any) => (prev ? { ...prev, status: 'running' } : prev));
        activeRef.current = true;
        setTimeout(tick, 800); // resume polling for scripts + evidence
      }
    } finally {
      setBusy(null);
    }
  };

  const downloadScripts = () => {
    if (!scripts.length) return;
    const content = scripts
      .map((s: any) => `// ${s.filename || s.test_case_title || 'playwright-script'}\n${s.code || ''}`)
      .join('\n\n');
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `playwright-scripts-${taskId.slice(0, 8)}.ts`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-3">
      {/* Header */}
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <FlaskConical className="h-4 w-4 shrink-0 text-[var(--accent)]" />
          <span className="truncate text-sm font-semibold text-[var(--text-primary)]">
            {run?.artifactName || 'Deep test generation'}
          </span>
        </div>
        <span
          className={cn(
            'shrink-0 rounded-md border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider',
            failed
              ? 'border-red-500/20 bg-red-500/10 text-red-400'
              : status === 'completed'
                ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-400'
                : reviewing
                  ? 'border-amber-500/20 bg-amber-500/10 text-amber-400'
                  : 'border-[var(--accent)]/20 bg-[var(--accent)]/10 text-[var(--accent)]',
          )}
        >
          {failed ? 'failed' : status === 'completed' ? 'done' : reviewing ? 'review' : 'working'}
        </span>
      </div>

      {/* Pipeline */}
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        {PIPELINE.map((p, i) => {
          const st = agentState(p.key);
          return (
            <div key={p.key} className="flex items-center gap-1.5">
              <span
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] font-medium',
                  st === 'completed'
                    ? 'border-emerald-500/20 bg-emerald-500/5 text-emerald-400'
                    : st === 'running'
                      ? 'border-[var(--accent)]/30 bg-[var(--accent)]/5 text-[var(--accent)]'
                      : st === 'failed'
                        ? 'border-red-500/20 bg-red-500/5 text-red-400'
                        : 'border-[var(--border)] text-[var(--text-muted)]',
                )}
              >
                {st === 'completed' ? (
                  <CheckCircle2 className="h-3 w-3" />
                ) : st === 'running' ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : st === 'failed' ? (
                  <XCircle className="h-3 w-3" />
                ) : (
                  <span className="h-3 w-3 rounded-full border border-current opacity-40" />
                )}
                {p.label}
              </span>
              {i < PIPELINE.length - 1 && <span className="text-[var(--text-muted)]">·</span>}
            </div>
          );
        })}
      </div>

      {failed && (
        <div className="rounded-md bg-red-500/10 p-2 text-xs text-red-400">
          {(run?.messages || []).findLast?.((m: any) => m.status === 'failed')?.output ||
            'The pipeline failed. Check the server console for details.'}
        </div>
      )}

      {(list.length > 0 || scripts.length > 0 || evidence.length > 0) && (
        <>
          {/* Tabs */}
          <div className="mb-2 flex gap-1 border-b border-[var(--border)]">
            {[
              { id: 'cases', label: `Cases (${list.length})`, icon: FlaskConical },
              { id: 'code', label: `Scripts (${scripts.length})`, icon: Code2 },
              { id: 'evidence', label: `Evidence (${evidence.length})`, icon: ImageIcon },
            ].map((t) => (
              <button
                key={t.id}
                onClick={() => setTab(t.id as any)}
                className={cn(
                  'inline-flex items-center gap-1.5 border-b-2 px-2.5 py-1.5 text-xs font-medium transition-colors',
                  tab === t.id
                    ? 'border-[var(--accent)] text-[var(--accent)]'
                    : 'border-transparent text-[var(--text-muted)] hover:text-[var(--text-primary)]',
                )}
              >
                <t.icon className="h-3.5 w-3.5" />
                {t.label}
              </button>
            ))}
            {tab === 'code' && scripts.length > 0 && (
              <button
                onClick={downloadScripts}
                className="ml-auto inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-[var(--text-muted)] hover:text-[var(--text-primary)]"
              >
                <Download className="h-3.5 w-3.5" /> Download
              </button>
            )}
          </div>

          {/* CASES (editable) */}
          {tab === 'cases' && (
            <div>
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <button
                  onClick={addCase}
                  className="inline-flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2.5 py-1.5 text-xs font-medium text-[var(--text-primary)] hover:border-[var(--accent)]"
                >
                  <Plus className="h-3.5 w-3.5" /> Add case
                </button>
                <div className="ml-auto flex items-center gap-2">
                  <button
                    onClick={saveAll}
                    disabled={busy === 'save' || !list.length}
                    className="inline-flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2.5 py-1.5 text-xs font-medium text-[var(--text-primary)] hover:border-[var(--accent)] disabled:opacity-50"
                  >
                    {busy === 'save' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                    {saved ? 'Saved' : 'Save all'}
                  </button>
                  {reviewing && (
                    <button
                      onClick={continueFlow}
                      disabled={busy === 'continue' || !list.length}
                      className="inline-flex items-center gap-1 rounded-md bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-white hover:bg-[var(--accent-hover)] disabled:opacity-50"
                    >
                      {busy === 'continue' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                      Continue → scripts & evidence
                    </button>
                  )}
                </div>
              </div>

              {!list.length && (
                <div className="py-4 text-center text-xs text-[var(--text-muted)]">
                  <Loader2 className="mx-auto mb-1 h-4 w-4 animate-spin text-[var(--accent)]" /> Generating cases…
                </div>
              )}

              <div className="max-h-[28rem] space-y-1.5 overflow-y-auto pr-1">
                {list.map((c, i) => (
                  <div key={i} className="rounded-md border border-[var(--border)] bg-[var(--bg-secondary)]">
                    <div className="flex items-center gap-2 px-3 py-2">
                      <span className="rounded bg-[var(--bg-card)] px-1.5 py-0.5 text-[10px] font-bold uppercase text-[var(--text-muted)]">
                        {c.priority || 'Med'}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-xs font-medium text-[var(--text-primary)]">{c.title || 'Untitled'}</span>
                      <span className="text-[10px] text-[var(--text-muted)]">{(c.steps || []).length} steps</span>
                      <button
                        onClick={() => setEditing(editing === i ? null : i)}
                        className="rounded p-1 text-[var(--text-muted)] hover:text-[var(--accent)]"
                        title="Edit case"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <button
                        onClick={() => removeCase(i)}
                        className="rounded p-1 text-[var(--text-muted)] hover:text-red-500"
                        title="Delete case"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>

                    {editing === i && (
                      <div className="space-y-3 border-t border-[var(--border)] p-3">
                        <input
                          value={c.title || ''}
                          onChange={(e) => patchCase(i, { title: e.target.value })}
                          placeholder="Title"
                          className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-card)] px-2 py-1.5 text-xs text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
                        />
                        <textarea
                          value={c.description || ''}
                          onChange={(e) => patchCase(i, { description: e.target.value })}
                          placeholder="Description"
                          className="h-16 w-full rounded-md border border-[var(--border)] bg-[var(--bg-card)] px-2 py-1.5 text-xs text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
                        />
                        <div className="grid grid-cols-2 gap-2">
                          <select
                            value={c.priority || 'Medium'}
                            onChange={(e) => patchCase(i, { priority: e.target.value })}
                            className="rounded-md border border-[var(--border)] bg-[var(--bg-card)] px-2 py-1.5 text-xs text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
                          >
                            <option>Low</option>
                            <option>Medium</option>
                            <option>High</option>
                            <option>Critical</option>
                          </select>
                          <input
                            value={Array.isArray(c.tags) ? c.tags.join(', ') : c.tags || ''}
                            onChange={(e) => patchCase(i, { tags: e.target.value.split(',').map((t) => t.trim()).filter(Boolean) })}
                            placeholder="Tags (comma separated)"
                            className="rounded-md border border-[var(--border)] bg-[var(--bg-card)] px-2 py-1.5 text-xs text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
                          />
                        </div>

                        {/* Steps */}
                        <div className="space-y-1.5">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">Steps</span>
                            <div className="flex items-center gap-1.5">
                              <select
                                value={expandCount[i] || 8}
                                onChange={(e) => setExpandCount((p) => ({ ...p, [i]: Number(e.target.value) }))}
                                className="rounded-md border border-[var(--border)] bg-[var(--bg-card)] px-1.5 py-1 text-[11px] text-[var(--text-primary)] outline-none"
                              >
                                {EXPAND_OPTIONS.map((n) => (
                                  <option key={n} value={n}>{n} steps</option>
                                ))}
                              </select>
                              <button
                                onClick={() => expandSteps(i)}
                                disabled={busy === `expand-${i}`}
                                className="inline-flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--bg-card)] px-2 py-1 text-[11px] font-medium text-[var(--text-primary)] hover:border-[var(--accent)] disabled:opacity-50"
                              >
                                {busy === `expand-${i}` ? <Loader2 className="h-3 w-3 animate-spin" /> : <SplitSquareHorizontal className="h-3 w-3" />}
                                Expand with AI
                              </button>
                            </div>
                          </div>
                          {(c.steps || []).map((s, si) => (
                            <div key={si} className="grid grid-cols-1 gap-1.5 rounded-md border border-[var(--border)] bg-[var(--bg-card)] p-1.5 lg:grid-cols-[1fr_1fr_auto]">
                              <textarea
                                value={s.action || ''}
                                onChange={(e) => patchStep(i, si, { action: e.target.value })}
                                placeholder={`Step ${si + 1} action`}
                                className="min-h-[3rem] resize-y rounded border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1 text-[11px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
                              />
                              <textarea
                                value={s.expected || ''}
                                onChange={(e) => patchStep(i, si, { expected: e.target.value })}
                                placeholder="Expected result"
                                className="min-h-[3rem] resize-y rounded border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1 text-[11px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
                              />
                              <button onClick={() => removeStep(i, si)} className="rounded px-2 text-[11px] text-red-400 hover:bg-red-500/10">
                                <Trash2 className="h-3.5 w-3.5" />
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
                            className="h-14 w-full rounded-md border border-[var(--border)] bg-[var(--bg-card)] px-2 py-1.5 text-[11px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
                          />
                          <div className="flex justify-end">
                            <button
                              onClick={() => reworkCase(i)}
                              disabled={busy === `rework-${i}`}
                              className="inline-flex items-center gap-1 rounded-md bg-[var(--accent)] px-3 py-1.5 text-[11px] font-medium text-white hover:bg-[var(--accent-hover)] disabled:opacity-50"
                            >
                              {busy === `rework-${i}` ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}
                              Rework with AI
                            </button>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* SCRIPTS */}
          {tab === 'code' && (
            <div className="max-h-[28rem] overflow-y-auto pr-1">
              {scripts.length ? (
                <div className="space-y-1.5">
                  {scripts.map((s, i) => (
                    <div key={i} className="overflow-hidden rounded-md border border-[var(--border)]">
                      <button
                        onClick={() => setExpandedScript(expandedScript === i ? null : i)}
                        className="flex w-full items-center gap-2 bg-[var(--bg-secondary)] px-3 py-2 text-left"
                      >
                        <Code2 className="h-3.5 w-3.5 shrink-0 text-indigo-400" />
                        <span className="min-w-0 flex-1 truncate font-mono text-xs text-[var(--text-primary)]">{s.filename || `script-${i + 1}.spec.ts`}</span>
                        <ChevronDown className={cn('h-3.5 w-3.5 text-[var(--text-muted)] transition-transform', expandedScript === i && 'rotate-180')} />
                      </button>
                      {expandedScript === i && (
                        <pre className="max-h-72 overflow-auto bg-slate-950 p-3 font-mono text-[11px] leading-5 text-slate-200">
                          <code>{s.code}</code>
                        </pre>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="py-4 text-center text-xs text-[var(--text-muted)]">
                  {isRunning ? 'Scripts appear after you Continue.' : 'No scripts yet — click Continue on the Cases tab.'}
                </div>
              )}
            </div>
          )}

          {/* EVIDENCE */}
          {tab === 'evidence' && (
            <div className="max-h-[28rem] overflow-y-auto pr-1">
              {evidence.length ? (
                <div className="space-y-2">
                  {evidence.map((shot, i) => (
                    <div key={i} className="overflow-hidden rounded-md border border-[var(--border)]">
                      <div className="border-b border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-1.5 text-[11px]">
                        <div className="truncate font-medium text-[var(--text-primary)]">{shot.title || 'Evidence'}</div>
                        <div className="truncate text-[var(--text-muted)]">{shot.url}</div>
                      </div>
                      {shot.screenshotUrl && <img src={shot.screenshotUrl} alt={shot.title || 'evidence'} className="w-full bg-black object-contain" />}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="py-4 text-center text-xs text-[var(--text-muted)]">
                  {isRunning ? 'Evidence is captured after you Continue.' : 'No evidence captured (no reachable URL).'}
                </div>
              )}
            </div>
          )}
        </>
      )}

      {/* Drill-in once fully completed */}
      {status === 'completed' && (
        <div className="mt-3 flex flex-wrap gap-2 border-t border-[var(--border)] pt-3">
          <span className="self-center text-[11px] text-[var(--text-muted)]">Saved to your workspace:</span>
          {[
            { label: 'Test Cases', href: '/cases', icon: FlaskConical },
            { label: 'Test Runs', href: '/runs', icon: PlayCircle },
            { label: 'Reports', href: '/reports', icon: ClipboardList },
          ].map((l) => (
            <button
              key={l.href}
              onClick={() => navigate(l.href)}
              className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2.5 py-1 text-[11px] font-medium text-[var(--text-primary)] hover:border-[var(--accent)] transition-colors"
            >
              <l.icon className="h-3.5 w-3.5 text-[var(--accent)]" />
              {l.label}
              <ArrowRight className="h-3 w-3 text-[var(--text-muted)]" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
