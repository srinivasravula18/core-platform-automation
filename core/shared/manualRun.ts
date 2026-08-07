// Manual step-runner shared logic (Phase B1). Pure + framework-free so the backend routes and the
// frontend runner reuse one source of truth for the outcome vocabulary and roll-up rules.

// A case's script may be linked by caseId, or (for agent output) by title within its run, or be that
// run's only script. Mirrors scriptsForCases in src/lib/manualTestRun.ts.
export function caseHasScript(testCase: any, scripts: any[]): boolean {
  const live = scripts.filter((script) => !script?.deletedAt);
  if (live.some((script) => String(script?.caseId || '') === String(testCase?.id || ''))) return true;
  const runId = String(testCase?.agentRunId || testCase?.sourceRunId || '');
  if (!runId) return false;
  const candidates = live.filter((script) => String(script?.agentRunId || script?.sourceRunId || '') === runId);
  const title = String(testCase?.title || '').trim().toLowerCase();
  if (title && candidates.some((script) => [script?.title, script?.test_case_title]
    .some((value) => String(value || '').trim().toLowerCase() === title))) return true;
  return candidates.length === 1;
}

// Per-step + per-case outcome vocabulary (generic QA, not app-specific). "Attention needed" == Blocked.
export const MANUAL_OUTCOMES = ['Not Run', 'Passed', 'Failed', 'Blocked', 'Retest', 'Not Applicable', 'Paused'] as const;
export type ManualOutcome = (typeof MANUAL_OUTCOMES)[number];

export function isManualOutcome(v: unknown): v is ManualOutcome {
  return (MANUAL_OUTCOMES as readonly string[]).includes(String(v || '').trim());
}

// Roll a case's outcome up from its step outcomes (worst-wins, N/A ignored). Any Failed → Failed,
// then Blocked, then Retest; all-Passed (with ≥1 executed) → Passed; executed but none terminal →
// Paused; nothing executed → Not Run (or Not Applicable when every step is N/A).
export function rollupCaseOutcome(stepResults: Array<{ outcome?: string }> = []): ManualOutcome {
  const outs = (stepResults || []).map((s) => String(s?.outcome || 'Not Run'));
  if (!outs.length) return 'Not Run';
  if (outs.includes('Failed')) return 'Failed';
  if (outs.includes('Blocked')) return 'Blocked';
  if (outs.includes('Retest')) return 'Retest';
  const executed = outs.filter((o) => o !== 'Not Run' && o !== 'Not Applicable');
  if (!executed.length) return outs.every((o) => o === 'Not Applicable') ? 'Not Applicable' : 'Not Run';
  // Some steps executed and none are terminal-bad. Only 'Passed' when nothing is still pending.
  if (outs.includes('Not Run')) return 'Paused';
  return 'Passed';
}

// Completing one step starts the next step's clock. The case duration is the sum of completed steps,
// excluding time spent between steps or on another case.
export function advanceManualStepTiming(steps: any[], index: number, completedAt: string, fallbackStartedAt?: string | null) {
  const next = steps.map((step) => ({ ...step }));
  const step = next[index];
  if (!step) return { steps: next, durationMs: 0 };
  if (!step.startedAt) step.startedAt = fallbackStartedAt || completedAt;
  if (!/^(Not Run|Paused)$/i.test(String(step.outcome || ''))) {
    step.completedAt ||= completedAt;
    step.durationMs = Math.max(0, Date.parse(step.completedAt) - Date.parse(step.startedAt));
    const following = next[index + 1];
    if (following && !following.startedAt && String(following.outcome || 'Not Run') === 'Not Run') following.startedAt = completedAt;
  }
  return { steps: next, durationMs: next.reduce((total, item) => total + Math.max(0, Number(item.durationMs) || 0), 0) };
}

export function isManualRunActive(run: any): boolean {
  return Boolean(run?.startedAt) && !run?.completedAt && !/^(stopped|cancelled|canceled)$/i.test(String(run?.status || run?.state || ''));
}

export interface RunRollup {
  passed: number;
  failed: number;
  totalExecutions: number;
  status: string;
  state: string;
  progress: string;
}

// Roll run-level aggregate + status/state from its per-case results.
export function computeRunRollup(results: Array<{ outcome?: string }> = []): RunRollup {
  const outcomes = results.map((r) => String(r?.outcome || 'Not Run'));
  const passed = outcomes.filter((o) => o === 'Passed').length;
  const failed = outcomes.filter((o) => o === 'Failed').length;
  const blocked = outcomes.filter((o) => o === 'Blocked').length;
  const done = outcomes.length > 0 && outcomes.every((o) => o !== 'Not Run');
  const anyStarted = outcomes.some((o) => o !== 'Not Run');
  const status = failed > 0 && done ? 'Failed'
    : blocked > 0 && done ? 'Blocked'
    : done ? 'Passed'
    : anyStarted ? 'In Progress' : 'Not Started';
  const state = done ? 'Completed' : anyStarted ? 'In Progress' : 'Not Started';
  return {
    passed,
    failed,
    totalExecutions: results.length,
    status,
    state,
    progress: `${outcomes.filter((o) => o !== 'Not Run').length}/${results.length} evaluated`,
  };
}
