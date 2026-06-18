import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { cn } from '@/src/lib/utils';
import { withBasePath } from '@/src/lib/base-path';
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
  RotateCcw,
  Clock,
  Recycle,
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
  { key: 'CodeAnalyst', label: 'Understand code' },
  { key: 'FeatureDiscoveryAgent', label: 'Map features' },
  { key: 'E2EFlowAgent', label: 'Map E2E flows' },
  { key: 'CoverageScout', label: 'Find existing' },
  { key: 'TestGenerationAgent', label: 'Write cases' },
  { key: 'PlaywrightAgent', label: 'Generate scripts' },
  { key: 'SelectorVerifier', label: 'Verify selectors' },
  { key: 'EvidenceAgent', label: 'Capture evidence' },
];

// Statuses that halt polling and await a human decision or are final.
const TERMINAL = ['completed', 'failed', 'review_required', 'coverage_options', 'cancelled'];
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
  const [pwRunning, setPwRunning] = useState(false);
  const [pwResult, setPwResult] = useState<any>(null);
  const [reportOpen, setReportOpen] = useState(false);
  // The run can be retried after a failure; track the live task id internally so
  // the same card switches to the new run without the parent re-rendering it.
  const [activeTaskId, setActiveTaskId] = useState(taskId);
  const [retrying, setRetrying] = useState(false);
  const activeRef = useRef(true);
  const navigate = useNavigate();

  const tick = useCallback(async () => {
    if (!activeRef.current) return;
    try {
      const r = await fetch(`/api/agent-runs/${activeTaskId}`, { cache: 'no-store' });
      if (!r.ok) {
        if (!activeRef.current) return;
        setRun((prev: any) => prev || {
          id: activeTaskId,
          status: 'failed',
          messages: [{ agent: 'System', status: 'failed', output: r.status === 404 ? 'This agent run is no longer available. Start a new run to continue.' : `Failed to load run (${r.status}).` }],
          generated_cases: [],
          playwright_scripts: [],
          evidence_screenshots: [],
        });
        return;
      }
      const data = await r.json();
      if (!activeRef.current) return;
      setRun(data);
      if (TERMINAL.includes(data?.status)) return;
    } catch (error: any) {
      if (!activeRef.current) return;
      setRun((prev: any) => prev || {
        id: activeTaskId,
        status: 'failed',
        messages: [{ agent: 'System', status: 'failed', output: error?.message || 'Failed to reach the backend for this run.' }],
        generated_cases: [],
        playwright_scripts: [],
        evidence_screenshots: [],
      });
      return;
    }
    if (activeRef.current) setTimeout(tick, 2000);
  }, [activeTaskId]);

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

  // G6: the deep run already executes the scripts and stores the result, so show
  // that pass/fail directly — no need to press "Run all scripts" again. A manual
  // re-run still overrides this seed.
  useEffect(() => {
    if (!pwResult && run?.execution_result && (run.execution_result.tests?.length || run.execution_result.error)) {
      setPwResult(run.execution_result);
    }
  }, [run, pwResult]);

  const status = run?.status;
  const scripts: any[] = run?.playwright_scripts || [];
  const evidence: any[] = run?.evidence_screenshots || [];
  const targetUrl: string = run?.app_url || '';
  const isRunning = !status || !TERMINAL.includes(status);
  const failed = status === 'failed';
  const reviewing = status === 'review_required';
  const coverageGate = status === 'coverage_options';
  const existingMatches: Case[] = run?.existing_matches || [];
  // Cases the user removed from the coverage card (by index) — dropped before reuse/gaps.
  const [removedMatches, setRemovedMatches] = useState<Set<number>>(new Set());
  const keptMatches = existingMatches.filter((_, i) => !removedMatches.has(i));
  const matchKey = (c: any) => String(c?.id ?? c?.existingCaseId ?? c?.title);
  const list = cases || [];

  const agentState = (agent: string): string => {
    const msg = (run?.messages || []).filter((m: any) => m.agent === agent).pop();
    return msg?.status || 'pending';
  };

  /* ---------- timing (per-phase + total) ---------- */
  const fmtDuration = (ms: number | null): string => {
    if (ms == null || ms < 0) return '';
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return rem ? `${m}m ${rem}s` : `${m}m`;
  };
  // Duration of one phase from its 'running' stamp to its terminal stamp. The
  // still-running phase has no terminal yet, so it ticks live off Date.now().
  const phaseMs = (agent: string): number | null => {
    const msgs = (run?.messages || []).filter((m: any) => m.agent === agent);
    const start = msgs.find((m: any) => m.status === 'running' && m.at);
    if (!start?.at) return null;
    const end = [...msgs].reverse().find((m: any) => ['completed', 'failed', 'skipped'].includes(m.status) && m.at);
    const endAt = end?.at ? Date.parse(end.at) : (isRunning ? Date.now() : null);
    if (endAt == null) return null;
    return Math.max(0, endAt - Date.parse(start.at));
  };
  // Wall-clock from run start to finish, minus any human case-review pause, so the
  // headline number reflects automation time rather than how long the user deliberated.
  const totalMs: number | null = (() => {
    if (!run?.created_at) return null;
    const start = Date.parse(run.created_at);
    if (Number.isNaN(start)) return null;
    const end = run.completed_at ? Date.parse(run.completed_at) : (isRunning ? Date.now() : null);
    if (end == null) return null;
    return Math.max(0, end - start - (run.paused_ms || 0));
  })();
  // While the run is working, animate the first not-yet-done stage so the card
  // never looks frozen between status updates.
  const activePipelineIdx = isRunning
    ? PIPELINE.findIndex((p) => !['completed', 'failed', 'skipped'].includes(agentState(p.key)))
    : -1;

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
        body: JSON.stringify({ cases: list, taskId: activeTaskId }),
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
        body: JSON.stringify({ taskId: activeTaskId, cases: list }),
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

  // Resolve the early reuse gate: reuse the matched existing cases, extend them with
  // only the gaps, or generate a fresh set. The run then resumes from case-writing.
  const coverageDecide = async (action: 'reuse' | 'gaps' | 'fresh') => {
    setBusy(`cov-${action}`);
    try {
      const res = await fetch('/api/agent/coverage-decision', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Only the cases the user kept (didn't delete from the card) are reused/extended.
        body: JSON.stringify({ taskId: activeTaskId, action, keep: keptMatches.map(matchKey) }),
      });
      if (res.ok) {
        setRun((prev: any) => (prev ? { ...prev, status: 'running' } : prev));
        activeRef.current = true;
        setTimeout(tick, 800); // resume polling for cases → scripts → evidence
      }
    } finally {
      setBusy(null);
    }
  };

  // Retry from the latest useful checkpoint. If cases already exist, continue
  // from script/evidence generation instead of starting inspection/case writing
  // from scratch. Only fall back to a fresh run when no cases were produced.
  const retry = async () => {
    if (retrying) return;
    setRetrying(true);
    try {
      // Resume from the phase that failed (reusing the completed inspection / code
      // understanding / coverage matches) instead of re-running the whole pipeline.
      const resumeRes = await fetch('/api/agent/retry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId: activeTaskId }),
      });
      const resume = await resumeRes.json().catch(() => ({}));
      if (resumeRes.ok && resume?.success) {
        setPwResult(null);
        setRun((prev: any) => (prev ? { ...prev, status: 'running', completed_at: null } : prev));
        setTab('cases');
        activeRef.current = true;
        setTimeout(tick, 800);
        return;
      }

      // Backend says it can't cheaply resume (no inspection yet) → fresh run from scratch.
      const res = await fetch('/api/agent/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          app_url: run?.app_url || '',
          websiteId: run?.website_id || run?.websiteId || undefined,
          prompt: run?.prompt || '',
          testCaseCount: run?.generated_cases?.length || 3,
          flowMode: 'review_cases',
          folderMention: run?.folder_path && run.folder_path !== 'Uncategorized' ? run.folder_path : undefined,
        }),
      });
      const data = await res.json();
      if (data?.task_id) {
        // Reset the card and follow the fresh run.
        setRun(null);
        setCases(null);
        setPwResult(null);
        setEditing(null);
        setSaved(false);
        setTab('cases');
        activeRef.current = true;
        setActiveTaskId(data.task_id);
      }
    } finally {
      setRetrying(false);
    }
  };

  const runScripts = async () => {
    if (!scripts.length || pwRunning) return;
    setPwRunning(true);
    setPwResult(null);
    try {
      const res = await fetch('/api/playwright/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scripts: scripts.map((s: any) => ({ filename: s.filename, title: s.title, code: s.code })),
          baseUrl: targetUrl,
          runId: `${activeTaskId}-pw`,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `Playwright run failed (${res.status})`);
      setPwResult(data);
    } catch (e: any) {
      setPwResult({ ok: false, error: e?.message || 'Run failed', tests: [] });
    } finally {
      setPwRunning(false);
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
    a.download = `playwright-scripts-${activeTaskId.slice(0, 8)}.ts`;
    a.click();
    URL.revokeObjectURL(url);
  };

  /* ---------- downloadable test report (CSV / HTML / PDF) ---------- */
  const resultForCase = (c: Case) => {
    const tests = pwResult?.tests || [];
    return tests.find((t: any) => String(t.title || '').trim() === String(c.title || '').trim()) || null;
  };
  const reportFilename = (ext: string) =>
    `test-report-${String(run?.artifactName || 'agent-run').replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 40)}-${activeTaskId.slice(0, 6)}.${ext}`;

  const buildReportCsv = () => {
    const esc = (v: any) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const header = ['Title', 'Priority', 'Type', 'Tags', 'Steps', 'Result', 'Error'];
    const rows = list.map((c) => {
      const r = resultForCase(c);
      return [c.title, c.priority || '', c.type || 'Manual', (c.tags || []).join(' '), (c.steps || []).length, r ? r.status : 'not run', r?.error || ''];
    });
    return [header, ...rows].map((row) => row.map(esc).join(',')).join('\r\n');
  };

  const buildReportHtml = () => {
    const esc = (s: any) => String(s ?? '').replace(/[&<>]/g, (m) => (({ '&': '&amp;', '<': '&lt;', '>': '&gt;' } as Record<string, string>)[m]));
    const summary = pwResult && !pwResult.error
      ? `${pwResult.passed} passed · ${pwResult.failed} failed · ${pwResult.total} total`
      : `${list.length} test case(s) — not executed`;
    const casesHtml = list.map((c, i) => {
      const r = resultForCase(c);
      const badge = r ? `<span class="b ${esc(r.status)}">${esc(r.status)}</span>` : '';
      const steps = (c.steps || []).map((s, si) => `<tr><td>${si + 1}. ${esc(s.action)}</td><td>${esc(s.expected)}</td></tr>`).join('');
      return `<div class="c"><h3>${i + 1}. ${esc(c.title)} ${badge}</h3><div class="m">${esc(c.priority || 'Medium')} · ${esc(c.type || 'Manual')}${(c.tags || []).length ? ' · ' + (c.tags || []).map(esc).join(', ') : ''}</div>${c.description ? `<p>${esc(c.description)}</p>` : ''}<table><thead><tr><th>Step</th><th>Expected result</th></tr></thead><tbody>${steps || '<tr><td colspan="2">No steps</td></tr>'}</tbody></table>${r?.error ? `<pre class="e">${esc(r.error)}</pre>` : ''}</div>`;
    }).join('');
    // Downloaded HTML is opened outside the app, so screenshot links must be absolute (origin + base path).
    const absShot = (u: string) => (u && u.startsWith('/') ? `${window.location.origin}${withBasePath(u)}` : u);
    const evHtml = (evidence || []).map((shot) => `<div class="ev"><div class="m">${esc(shot.title || 'Evidence')} — ${esc(shot.url || '')}</div>${shot.screenshotUrl ? `<img src="${esc(absShot(shot.screenshotUrl))}"/>` : ''}</div>`).join('');
    return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(run?.artifactName || 'Test Report')}</title><style>body{font-family:Arial,Helvetica,sans-serif;margin:28px;color:#111}h1{margin:0;font-size:22px}.s{color:#555;margin:6px 0 18px}.c{border:1px solid #e2e2e2;border-radius:8px;padding:12px 14px;margin:10px 0;page-break-inside:avoid}.c h3{margin:0 0 4px;font-size:15px}.m{color:#666;font-size:12px;margin-bottom:6px}table{width:100%;border-collapse:collapse;font-size:12.5px;margin-top:6px}th,td{border:1px solid #eee;padding:6px 8px;text-align:left;vertical-align:top}th{background:#fafafa}.b{font-size:11px;padding:1px 7px;border-radius:10px;color:#fff}.b.passed{background:#16a34a}.b.failed,.b.timedOut,.b.interrupted{background:#dc2626}.b.skipped{background:#9ca3af}.e{background:#fef2f2;color:#b91c1c;padding:8px;white-space:pre-wrap;font-size:12px;border-radius:6px;margin-top:6px}.ev img{max-width:100%;border:1px solid #ddd;border-radius:6px}h2{margin-top:24px;border-top:1px solid #eee;padding-top:14px}</style></head><body><h1>${esc(run?.artifactName || 'Agent Test Report')}</h1><div class="s">${esc(run?.app_url || 'No target URL')} · ${esc(summary)} · ${new Date().toLocaleString()}</div><h2>Test cases (${list.length})</h2>${casesHtml}${(evidence || []).length ? `<h2>Evidence (${evidence.length})</h2>${evHtml}` : ''}</body></html>`;
  };

  const downloadFile = (content: string, filename: string, type: string) => {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const exportReport = (fmt: 'csv' | 'html' | 'pdf') => {
    setReportOpen(false);
    if (fmt === 'csv') return downloadFile('﻿' + buildReportCsv(), reportFilename('csv'), 'text/csv;charset=utf-8');
    if (fmt === 'html') return downloadFile(buildReportHtml(), reportFilename('html'), 'text/html');
    const w = window.open('', '_blank');
    if (!w) return;
    w.document.write(buildReportHtml());
    w.document.close();
    w.focus();
    setTimeout(() => { try { w.print(); } catch { /* ignore */ } }, 350);
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
        <div className="flex shrink-0 items-center gap-2">
          {isRunning && (
            <button
              onClick={async () => {
                try { await fetch('/api/agent/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ taskId: activeTaskId }) }); } catch { /* ignore */ }
                setRun((prev: any) => (prev ? { ...prev, status: 'cancelled' } : prev));
              }}
              title="Stop this run"
              className="inline-flex items-center gap-1 rounded-md border border-red-500/30 bg-red-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-red-400 hover:bg-red-500/20"
            >
              <XCircle className="h-3.5 w-3.5" /> Stop
            </button>
          )}
          {totalMs != null && (
            <span
              className="inline-flex items-center gap-1 text-[11px] font-medium text-[var(--text-muted)]"
              title={status === 'completed' || failed ? 'Total time to complete this run (excludes case-review time)' : 'Elapsed so far'}
            >
              <Clock className="h-3 w-3" />
              {fmtDuration(totalMs)}
            </span>
          )}
          <span
            className={cn(
              'rounded-md border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider',
              failed || status === 'cancelled'
                ? 'border-red-500/20 bg-red-500/10 text-red-400'
                : status === 'completed'
                  ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-400'
                  : reviewing || coverageGate
                    ? 'border-amber-500/20 bg-amber-500/10 text-amber-400'
                    : 'border-[var(--accent)]/20 bg-[var(--accent)]/10 text-[var(--accent)]',
            )}
          >
            {status === 'cancelled' ? 'stopped' : failed ? 'failed' : status === 'completed' ? 'done' : coverageGate ? 'reuse?' : reviewing ? 'review' : 'working'}
          </span>
        </div>
      </div>

      {/* Honest verdict — combines the grounded gates (did we SEE the app, were the
          cases grounded, did the scripts actually pass?). No more unconditional green. */}
      {run?.verdict && !isRunning && (
        <div
          className={cn(
            'mb-3 rounded-lg border px-3 py-2 text-[11px]',
            run.verdict.overall === 'verified'
              ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-300'
              : run.verdict.overall === 'failed'
                ? 'border-red-500/20 bg-red-500/10 text-red-300'
                : 'border-amber-500/20 bg-amber-500/10 text-amber-300',
          )}
        >
          <div className="font-semibold uppercase tracking-wider">
            {run.verdict.overall === 'verified' ? 'Verified' : run.verdict.overall === 'failed' ? 'Failed' : 'Inconclusive'}
          </div>
          <div className="mt-0.5 text-[var(--text-muted)]">
            Saw the app: <b>{run.verdict.inspection}</b> · Cases grounded: <b>{run.verdict.grounding}</b> · Execution: <b>{run.verdict.execution}</b>
          </div>
        </div>
      )}

      {/* Pipeline */}
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        {PIPELINE.map((p, i) => {
          const st = agentState(p.key);
          const runFailed = status === 'failed';
          const runStopped = status === 'cancelled';
          // Don't keep spinning a step once the whole run has halted — the in-flight step is
          // where it stopped. A failed run shows it as failed; a user-stopped run shows it as
          // a neutral (non-spinning) step instead of "loading".
          const halted = runFailed || runStopped;
          const isActive = !halted && i === activePipelineIdx && st !== 'completed' && st !== 'failed';
          const effState = runFailed && st === 'running'
            ? 'failed'
            : runStopped && st === 'running'
              ? 'stopped'
              : isActive ? 'running' : st;
          return (
            <div key={p.key} className="flex items-center gap-1.5">
              <span
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] font-medium transition-colors',
                  effState === 'completed'
                    ? 'border-emerald-500/20 bg-emerald-500/5 text-emerald-400'
                    : effState === 'running'
                      ? 'border-[var(--accent)]/30 bg-[var(--accent)]/5 text-[var(--accent)]'
                      : effState === 'failed'
                        ? 'border-red-500/20 bg-red-500/5 text-red-400'
                        : 'border-[var(--border)] text-[var(--text-muted)]',
                  isActive && 'animate-pulse',
                )}
              >
                {effState === 'completed' ? (
                  <CheckCircle2 className="h-3 w-3" />
                ) : effState === 'running' ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : effState === 'failed' ? (
                  <XCircle className="h-3 w-3" />
                ) : (
                  <span className="h-3 w-3 rounded-full border border-current opacity-40" />
                )}
                {p.label}
                {(() => {
                  const d = phaseMs(p.key);
                  return d != null && (effState === 'completed' || effState === 'running' || effState === 'failed' || effState === 'stopped')
                    ? <span className="opacity-70 tabular-nums">· {fmtDuration(d)}</span>
                    : null;
                })()}
              </span>
              {i < PIPELINE.length - 1 && <span className="text-[var(--text-muted)]">·</span>}
            </div>
          );
        })}
      </div>

      {failed && (
        <div className="rounded-md bg-red-500/10 p-2 text-xs text-red-400">
          <div className="whitespace-pre-wrap">
            {(run?.messages || []).findLast?.((m: any) => m.status === 'failed')?.output ||
              'The pipeline failed. Check the server console for details.'}
          </div>
          <div className="mt-2 flex justify-end">
            <button
              onClick={retry}
              disabled={retrying}
              className="inline-flex items-center gap-1.5 rounded-md bg-red-500/20 px-3 py-1.5 text-xs font-medium text-red-300 hover:bg-red-500/30 disabled:opacity-50"
            >
              {retrying ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
              {retrying ? 'Retrying…' : 'Retry'}
            </button>
          </div>
        </div>
      )}

      {/* Early reuse gate: existing cases already cover this — reuse / extend / fresh */}
      {coverageGate && (
        <div className="rounded-md border border-amber-500/20 bg-amber-500/5 p-3">
          <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-amber-300">
            <Recycle className="h-4 w-4" />
            Found {keptMatches.length} existing test case{keptMatches.length === 1 ? '' : 's'} related to this request{removedMatches.size ? ` (${removedMatches.size} removed)` : ''}
          </div>
          <p className="mb-2.5 text-[11px] text-[var(--text-muted)]">
            You already have coverage for this. Reuse the existing cases as-is, keep them and add only the missing scenarios, or generate a brand-new set from scratch.
          </p>
          <div className="mb-3 max-h-48 space-y-1 overflow-y-auto pr-1">
            {existingMatches.map((c, i) => removedMatches.has(i) ? null : (
              <div key={i} className="flex items-center gap-2 rounded border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1.5 text-[11px]">
                <span className="rounded bg-[var(--bg-card)] px-1.5 py-0.5 text-[9px] font-bold uppercase text-[var(--text-muted)]">{c.priority || 'Med'}</span>
                <span className="min-w-0 flex-1 truncate text-[var(--text-primary)]">{c.title || 'Untitled'}</span>
                {(c.tags || []).slice(0, 3).map((t) => (
                  <span key={t} className="hidden shrink-0 rounded border border-[var(--border)] bg-[var(--bg-card)] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-[var(--text-muted)] sm:inline">
                    {String(t).startsWith('@') ? t : `@${t}`}
                  </span>
                ))}
                <span className="shrink-0 text-[10px] text-[var(--text-muted)]">{(c.steps || []).length} steps</span>
                <button
                  onClick={() => setRemovedMatches((prev) => { const next = new Set(prev); next.add(i); return next; })}
                  title="Remove this case from the set (it won't be reused or extended)"
                  className="shrink-0 rounded p-0.5 text-[var(--text-muted)] hover:text-red-500"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
            {keptMatches.length === 0 && (
              <div className="px-2 py-1.5 text-[11px] text-[var(--text-muted)]">All matched cases removed — choose “Generate fresh”.</div>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => coverageDecide('reuse')}
              disabled={!!busy || keptMatches.length === 0}
              title="Use these existing cases as-is (generate no new cases) and run scripts + evidence against them"
              className="inline-flex items-center gap-1.5 rounded-md bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-white hover:bg-[var(--accent-hover)] disabled:opacity-50"
            >
              {busy === 'cov-reuse' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Recycle className="h-3.5 w-3.5" />}
              Reuse these
            </button>
            <button
              onClick={() => coverageDecide('gaps')}
              disabled={!!busy || keptMatches.length === 0}
              title="Keep the existing cases above and generate only the scenarios they don't already cover"
              className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-1.5 text-xs font-medium text-[var(--text-primary)] hover:border-[var(--accent)] disabled:opacity-50"
            >
              {busy === 'cov-gaps' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
              Existing + gaps
            </button>
            <button
              onClick={() => coverageDecide('fresh')}
              disabled={!!busy}
              title="Ignore the existing cases and generate a brand-new set from scratch"
              className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-1.5 text-xs font-medium text-[var(--text-primary)] hover:border-[var(--accent)] disabled:opacity-50"
            >
              {busy === 'cov-fresh' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FlaskConical className="h-3.5 w-3.5" />}
              Generate fresh
            </button>
            <button
              onClick={() => navigate('/cases')}
              className="ml-auto inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium text-[var(--text-muted)] hover:text-[var(--text-primary)]"
            >
              Open in workspace
              <ArrowRight className="h-3 w-3" />
            </button>
          </div>
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
                  <div className="relative">
                    <button
                      onClick={() => setReportOpen((o) => !o)}
                      disabled={!list.length}
                      className="inline-flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2.5 py-1.5 text-xs font-medium text-[var(--text-primary)] hover:border-[var(--accent)] disabled:opacity-50"
                    >
                      <Download className="h-3.5 w-3.5" /> Report
                      <ChevronDown className="h-3 w-3" />
                    </button>
                    {reportOpen && (
                      <>
                        <div className="fixed inset-0 z-10" onClick={() => setReportOpen(false)} />
                        <div className="absolute right-0 z-20 mt-1 w-40 overflow-hidden rounded-md border border-[var(--border)] bg-[var(--bg-card)] shadow-lg">
                          <div className="border-b border-[var(--border)] px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">Download as</div>
                          <button onClick={() => exportReport('pdf')} className="block w-full px-3 py-2 text-left text-xs hover:bg-[var(--bg-secondary)]">PDF (print)</button>
                          <button onClick={() => exportReport('html')} className="block w-full px-3 py-2 text-left text-xs hover:bg-[var(--bg-secondary)]">HTML</button>
                          <button onClick={() => exportReport('csv')} className="block w-full px-3 py-2 text-left text-xs hover:bg-[var(--bg-secondary)]">Excel (CSV)</button>
                        </div>
                      </>
                    )}
                  </div>
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

              <div className="max-h-[min(28rem,60dvh)] space-y-1.5 overflow-y-auto pr-1">
                {list.map((c, i) => (
                  <div key={i} className="rounded-md border border-[var(--border)] bg-[var(--bg-secondary)]">
                    <div
                      onClick={() => setEditing(editing === i ? null : i)}
                      className="flex cursor-pointer items-center gap-2 px-3 py-2"
                    >
                      <span className="rounded bg-[var(--bg-card)] px-1.5 py-0.5 text-[10px] font-bold uppercase text-[var(--text-muted)]">
                        {c.priority || 'Med'}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-xs font-medium text-[var(--text-primary)]">{c.title || 'Untitled'}</span>
                      {(c.tags || []).slice(0, 4).map((t) => (
                        <span key={t} className="hidden shrink-0 rounded border border-[var(--border)] bg-[var(--bg-card)] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-[var(--text-muted)] sm:inline">
                          {String(t).startsWith('@') ? t : `@${t}`}
                        </span>
                      ))}
                      <span className="text-[10px] text-[var(--text-muted)]">{(c.steps || []).length} steps</span>
                      <button
                        onClick={(e) => { e.stopPropagation(); setEditing(editing === i ? null : i); }}
                        className="rounded p-1 text-[var(--text-muted)] hover:text-[var(--accent)]"
                        title={editing === i ? 'Collapse' : 'Open'}
                      >
                        <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', editing === i && 'rotate-180')} />
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); removeCase(i); }}
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
                          <div className="flex justify-end gap-2">
                            <button
                              onClick={() => { setFeedback((p) => ({ ...p, [i]: '' })); setEditing(null); }}
                              disabled={busy === `rework-${i}`}
                              className="inline-flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--bg-card)] px-3 py-1.5 text-[11px] font-medium text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:border-[var(--accent)] disabled:opacity-50"
                            >
                              <XCircle className="h-3 w-3" /> Cancel
                            </button>
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
            <div>
              {scripts.length > 0 && (
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span className="text-[11px] text-[var(--text-muted)]">
                    {pwResult ? `Ran ${pwResult.total ?? 0} test(s)` : 'Drafts — not executed yet.'}
                  </span>
                  <button
                    onClick={runScripts}
                    disabled={pwRunning}
                    className="inline-flex items-center gap-1.5 rounded-md bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-white hover:bg-[var(--accent-hover)] disabled:opacity-50"
                  >
                    {pwRunning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <PlayCircle className="h-3.5 w-3.5" />}
                    {pwRunning ? 'Running…' : pwResult ? 'Re-run all scripts' : 'Run all scripts'}
                  </button>
                </div>
              )}

              {pwResult && (
                <div
                  className={cn(
                    'mb-2 rounded-md border p-2.5',
                    pwResult.error
                      ? 'border-red-500/20 bg-red-500/5'
                      : pwResult.failed > 0
                        ? 'border-amber-500/20 bg-amber-500/5'
                        : 'border-emerald-500/20 bg-emerald-500/5',
                  )}
                >
                  {pwResult.error ? (
                    <div className="text-[11px] text-red-400">
                      {pwResult.error}
                      {pwResult.stderrTail && (
                        <pre className="mt-1.5 max-h-32 overflow-auto whitespace-pre-wrap rounded bg-slate-950 p-2 font-mono text-[10px] text-slate-300">{pwResult.stderrTail}</pre>
                      )}
                    </div>
                  ) : (
                    <>
                      <div className="flex flex-wrap items-center gap-2 text-[11px]">
                        <span className="font-semibold text-emerald-400">{pwResult.passed} passed</span>
                        <span className={cn('font-semibold', pwResult.failed > 0 ? 'text-red-400' : 'text-[var(--text-muted)]')}>{pwResult.failed} failed</span>
                        {pwResult.skipped > 0 && <span className="text-[var(--text-muted)]">{pwResult.skipped} skipped</span>}
                        <span className="text-[var(--text-muted)]">· {((pwResult.durationMs || 0) / 1000).toFixed(1)}s</span>
                      </div>
                      <div className="mt-1.5 space-y-1">
                        {(pwResult.tests || []).map((t: any, i: number) => (
                          <div key={i} className="flex items-start gap-1.5 text-[11px]">
                            {t.status === 'passed' ? (
                              <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0 text-emerald-400" />
                            ) : t.status === 'skipped' ? (
                              <span className="mt-0.5 h-3 w-3 shrink-0 rounded-full border border-slate-400" />
                            ) : (
                              <XCircle className="mt-0.5 h-3 w-3 shrink-0 text-red-400" />
                            )}
                            <span className="min-w-0 flex-1">
                              <span className="text-[var(--text-primary)]">{t.title}</span>
                              {t.error && <span className="mt-0.5 block whitespace-pre-wrap font-mono text-[10px] text-red-400">{t.error}</span>}
                            </span>
                            <span className="shrink-0 text-[var(--text-muted)]">{(t.durationMs / 1000).toFixed(1)}s</span>
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              )}

              {scripts.length ? (
                <div className="max-h-[min(24rem,60dvh)] space-y-1.5 overflow-y-auto pr-1">
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
            <div className="max-h-[min(28rem,60dvh)] overflow-y-auto pr-1">
              {evidence.length ? (
                <div className="space-y-2">
                  {evidence.map((shot, i) => (
                    <div key={i} className="overflow-hidden rounded-md border border-[var(--border)]">
                      <div className="border-b border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-1.5 text-[11px]">
                        <div className="flex flex-wrap items-center gap-2">
                          <div className="min-w-0 flex-1 truncate font-medium text-[var(--text-primary)]">{shot.title || 'Evidence'}</div>
                          {shot.status && (
                            <span className={cn(
                              'shrink-0 rounded border px-1.5 py-0.5 text-[9px] font-semibold uppercase',
                              shot.status === 'passed'
                                ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
                                : 'border-red-500/30 bg-red-500/10 text-red-400',
                            )}>
                              {shot.status}
                            </span>
                          )}
                          {shot.traceUrl && (
                            <a
                              href={withBasePath(shot.traceUrl)}
                              target="_blank"
                              rel="noreferrer"
                              title="Download the Playwright trace, then open it at trace.playwright.dev to replay the run step by step"
                              className="shrink-0 rounded border border-[var(--accent)]/30 bg-[var(--accent)]/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase text-[var(--accent)] hover:bg-[var(--accent)]/20"
                            >
                              Trace ↓
                            </a>
                          )}
                        </div>
                        <div className="truncate text-[var(--text-muted)]">{shot.url}</div>
                        {shot.reason && <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap rounded bg-red-500/10 p-1.5 font-mono text-[10px] text-red-300">{shot.reason}</pre>}
                      </div>
                      {shot.screenshotUrl && <img src={withBasePath(shot.screenshotUrl)} alt={shot.title || 'evidence'} className="w-full bg-black object-contain" />}
                      {Array.isArray(shot.stepScreenshots) && shot.stepScreenshots.length > 0 && (
                        <div className="grid grid-cols-2 gap-1.5 border-t border-[var(--border)] bg-[var(--bg-secondary)] p-2 md:grid-cols-3">
                          {shot.stepScreenshots.map((url: string, stepIndex: number) => (
                            <a key={url} href={withBasePath(url)} target="_blank" rel="noreferrer" className="overflow-hidden rounded border border-[var(--border)] bg-black">
                              <div className="bg-[var(--bg-card)] px-1.5 py-1 text-[9px] font-semibold text-[var(--text-muted)]">Step {stepIndex + 1}</div>
                              <img src={withBasePath(url)} alt={`${shot.title || 'evidence'} step ${stepIndex + 1}`} className="h-28 w-full object-cover" />
                            </a>
                          ))}
                        </div>
                      )}
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
