// Manual step-runner shared logic (Phase B1). Pure + framework-free so the backend routes and the
// frontend runner reuse one source of truth for the outcome vocabulary and roll-up rules.

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
