/**
 * Queue prioritization (book Ch 20: Prioritization).
 *
 * When a project's concurrency limit is saturated, queued test runs compete for
 * the next slot. This module DECIDES which one goes first — pure, deterministic,
 * and unit-testable, the same shape as decideRoute(): no LLM, no I/O, no imports.
 * Keeping the policy here (not in a scheduler's side effects) means the ranking
 * is reproducible and can be asserted in tests with a fixed `now`.
 *
 *   scoreRun()        — a single number combining urgency, age, deps, intent, cost.
 *   assignPriority()  — bucket that score into P0/P1/P2 (manual override wins).
 *   prioritizeQueue() — sort a NEW copy of the queue, annotated with reasons.
 *
 * Status: verified by `npm run eval:prioritization` (offline). NOT yet wired into a
 * caller — there is no run queue/concurrency gate today; this plugs into that layer
 * (background execution / scheduler) when it is built. Kept because the policy is the
 * hard part and is already correct; wiring is mechanical once a queue exists.
 */

export type Priority = 'P0' | 'P1' | 'P2';

export interface QueuedRun {
  id: string;
  createdAt?: string;        // ISO; older = waited longer
  isBlocking?: boolean;      // a prerequisite other work depends on
  wantsExecution?: boolean;  // a real run vs a draft/generate
  estCostUsd?: number;       // cost/benefit input
  deadlineAt?: string;       // ISO; sooner = more urgent
  projectId?: string;
  manualPriority?: Priority; // explicit human override, wins if set
}

export interface RankedRun extends QueuedRun {
  priority: Priority;
  score: number;
  reason: string;
}

/**
 * Scoring weights. Tuned so that a single blocking run, or an overdue deadline,
 * dominates ordinary age/intent signals — those are the levers that cause cascade
 * stalls or missed SLAs, so they must outrank a slightly-older draft.
 */
const W = {
  BLOCKING: 1000,      // a prerequisite others wait on — unblock the graph first.
  OVERDUE: 800,        // deadline already passed — every minute late compounds.
  URGENCY_MAX: 400,    // max boost as a future deadline approaches.
  EXECUTION: 120,      // a real run beats a draft/generate when otherwise tied.
  WAIT_MAX: 600,       // anti-starvation cap so old items eventually win.
  COST_PENALTY: 5,     // small per-USD penalty: prefer cheap wins, break ties.
};

// Time constants for normalizing urgency/age into the weight ranges above.
const HOUR_MS = 60 * 60 * 1000;
const URGENCY_HORIZON_MS = 24 * HOUR_MS; // deadlines >24h out contribute ~0 urgency.
const WAIT_SATURATION_MS = 24 * HOUR_MS; // age boost saturates at WAIT_MAX after 24h.

/** Parse an ISO timestamp to epoch ms, or null when absent/invalid (treated as neutral). */
function parseTime(iso: string | undefined): number | null {
  if (typeof iso !== 'string' || iso.trim() === '') return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/** Coerce an arbitrary value to a finite number, or 0 when missing/invalid. */
function finiteOrZero(n: unknown): number {
  const v = Number(n);
  return Number.isFinite(v) ? v : 0;
}

/**
 * Pure score for a single run; higher = should run sooner. Built from five
 * additive signals so each is independently inspectable and testable:
 *
 *   dependency  — isBlocking adds W.BLOCKING outright (unblock dependents first).
 *   urgency     — by deadline: overdue adds W.OVERDUE + a lateness ramp; a future
 *                 deadline contributes up to W.URGENCY_MAX as it nears (linear over
 *                 URGENCY_HORIZON). Absent deadline → 0 (neutral, not penalized).
 *   wait        — age of createdAt ramps linearly to W.WAIT_MAX over WAIT_SATURATION
 *                 to defeat starvation. Absent/invalid createdAt → 0.
 *   intent      — wantsExecution adds W.EXECUTION (a real run over a draft).
 *   cost        — estCostUsd subtracts W.COST_PENALTY per USD (prefer cheap wins).
 */
export function scoreRun(run: QueuedRun, now: number = Date.now()): number {
  const r = run || ({} as QueuedRun);
  let score = 0;

  // Dependency: blocking work gates everything downstream — boost it hard.
  if (r.isBlocking === true) score += W.BLOCKING;

  // Urgency from deadline proximity.
  const deadline = parseTime(r.deadlineAt);
  if (deadline !== null) {
    if (deadline <= now) {
      // Overdue: flat penalty for missing it + a bounded ramp by how late we are.
      const lateMs = now - deadline;
      score += W.OVERDUE + Math.min(W.URGENCY_MAX, (lateMs / URGENCY_HORIZON_MS) * W.URGENCY_MAX);
    } else {
      // Approaching: closer deadlines score higher, zero beyond the horizon.
      const remaining = deadline - now;
      const proximity = Math.max(0, 1 - remaining / URGENCY_HORIZON_MS);
      score += proximity * W.URGENCY_MAX;
    }
  }

  // Wait time: linear anti-starvation ramp, capped at WAIT_MAX.
  const created = parseTime(r.createdAt);
  if (created !== null) {
    const ageMs = Math.max(0, now - created); // future createdAt → 0, never negative.
    score += Math.min(W.WAIT_MAX, (ageMs / WAIT_SATURATION_MS) * W.WAIT_MAX);
  }

  // Execution intent: a real run outranks a draft/generate.
  if (r.wantsExecution === true) score += W.EXECUTION;

  // Cost/benefit: small penalty for expensive runs (negative cost ignored).
  const cost = Math.max(0, finiteOrZero(r.estCostUsd));
  score -= cost * W.COST_PENALTY;

  return score;
}

/**
 * Thresholds bucketing scoreRun() into priority bands. Chosen so that either a
 * blocking run (>= W.BLOCKING) or an overdue deadline (>= W.OVERDUE) lands in P0,
 * while ordinary urgency/age/intent sits in P1, and quiet drafts fall to P2.
 */
const P0_THRESHOLD = W.OVERDUE; // 800 — blocking or overdue clears this.
const P1_THRESHOLD = W.EXECUTION; // 120 — any meaningful urgency/intent/age.

/**
 * Map a run to a priority band. A human's manualPriority always wins — it is an
 * explicit override and must not be second-guessed by the heuristic.
 */
export function assignPriority(run: QueuedRun, now: number = Date.now()): Priority {
  const manual = (run || ({} as QueuedRun)).manualPriority;
  if (manual === 'P0' || manual === 'P1' || manual === 'P2') return manual;

  const score = scoreRun(run, now);
  if (score >= P0_THRESHOLD) return 'P0';
  if (score >= P1_THRESHOLD) return 'P1';
  return 'P2';
}

/** Short human-readable justification for a ranking decision. */
function buildReason(run: QueuedRun, priority: Priority, now: number): string {
  if (run && (run.manualPriority === 'P0' || run.manualPriority === 'P1' || run.manualPriority === 'P2')) {
    return `${priority}: manual override`;
  }
  const parts: string[] = [];
  if (run && run.isBlocking === true) parts.push('blocking');
  const deadline = parseTime(run && run.deadlineAt);
  if (deadline !== null) parts.push(deadline <= now ? 'overdue deadline' : 'deadline approaching');
  const created = parseTime(run && run.createdAt);
  if (created !== null && now - created >= WAIT_SATURATION_MS / 2) parts.push('long wait');
  if (run && run.wantsExecution === true) parts.push('real run');
  if (parts.length === 0) parts.push('routine draft');
  return `${priority}: ${parts.join(' + ')}`;
}

/**
 * Rank a queue, highest-priority-first, returning a NEW array (input untouched).
 * Tie-break is STABLE and deterministic: by score desc, then older createdAt
 * first (fairness — the earlier arrival wins a true tie), then id asc.
 */
export function prioritizeQueue(runs: QueuedRun[], now: number = Date.now()): RankedRun[] {
  const list = Array.isArray(runs) ? runs : [];

  const ranked: RankedRun[] = list.map((run) => {
    const r = run || ({} as QueuedRun);
    const score = scoreRun(r, now);
    const priority = assignPriority(r, now);
    return { ...r, priority, score, reason: buildReason(r, priority, now) };
  });

  // Sort a copy's-worth of derived objects; original `runs` is never mutated.
  ranked.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    // Older createdAt first; missing timestamps sort after present ones.
    const ta = parseTime(a.createdAt);
    const tb = parseTime(b.createdAt);
    if (ta !== null && tb !== null && ta !== tb) return ta - tb;
    if (ta === null && tb !== null) return 1;
    if (tb === null && ta !== null) return -1;
    // Final deterministic tie-break by id.
    return String(a.id || '').localeCompare(String(b.id || ''));
  });

  return ranked;
}
