/**
 * Offline eval for the queue-prioritization policy (server/ai/prioritization.ts).
 *
 * The module is pure and deterministic (no LLM, no I/O), so it can be asserted with a
 * fixed `now`. This locks its contract until it is wired into the run queue/scheduler
 * (the background-execution layer). Run: `npm run eval:prioritization`.
 */
import { scoreRun, assignPriority, prioritizeQueue, type QueuedRun } from '../server/ai/prioritization';

const NOW = Date.parse('2026-07-04T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const iso = (ms: number) => new Date(ms).toISOString();

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean) {
  if (cond) { passed += 1; console.log(`OK  | ${label}`); }
  else { failed += 1; console.log(`FAIL| ${label}`); }
}

// --- assignPriority buckets ---------------------------------------------------
check('blocking run -> P0', assignPriority({ id: 'a', isBlocking: true }, NOW) === 'P0');
check('overdue deadline -> P0', assignPriority({ id: 'b', deadlineAt: iso(NOW - HOUR) }, NOW) === 'P0');
check('manual override wins over heuristic',
  assignPriority({ id: 'c', isBlocking: true, manualPriority: 'P2' }, NOW) === 'P2');
check('real run (execution intent) -> at least P1',
  assignPriority({ id: 'd', wantsExecution: true }, NOW) === 'P1');
check('quiet draft (no signals) -> P2', assignPriority({ id: 'e' }, NOW) === 'P2');

// --- scoreRun signals ---------------------------------------------------------
check('blocking outscores a fresh real run',
  scoreRun({ id: 'a', isBlocking: true }, NOW) > scoreRun({ id: 'd', wantsExecution: true }, NOW));
check('overdue outscores approaching deadline',
  scoreRun({ id: 'b', deadlineAt: iso(NOW - HOUR) }, NOW) > scoreRun({ id: 'f', deadlineAt: iso(NOW + 12 * HOUR) }, NOW));
check('older wait outscores newer (anti-starvation)',
  scoreRun({ id: 'g', createdAt: iso(NOW - 20 * HOUR) }, NOW) > scoreRun({ id: 'h', createdAt: iso(NOW - 1 * HOUR) }, NOW));
check('cheaper run outscores costlier when otherwise tied',
  scoreRun({ id: 'i', wantsExecution: true, estCostUsd: 0.1 }, NOW) > scoreRun({ id: 'j', wantsExecution: true, estCostUsd: 50 }, NOW));
check('missing/invalid fields are neutral, not NaN',
  Number.isFinite(scoreRun({ id: 'k', createdAt: 'not-a-date', deadlineAt: '', estCostUsd: undefined }, NOW)));

// --- prioritizeQueue ordering + purity ---------------------------------------
const queue: QueuedRun[] = [
  { id: 'draft-old', createdAt: iso(NOW - 10 * HOUR) },
  { id: 'blocker', isBlocking: true },
  { id: 'overdue', deadlineAt: iso(NOW - 2 * HOUR) },
  { id: 'draft-new', createdAt: iso(NOW - 5 * 60 * 1000) },
  { id: 'run', wantsExecution: true },
];
const frozen = JSON.stringify(queue);
const ranked = prioritizeQueue(queue, NOW);

check('prioritizeQueue does not mutate its input', JSON.stringify(queue) === frozen);
check('prioritizeQueue returns a new array of same length', ranked !== (queue as unknown) && ranked.length === queue.length);
check('output is sorted by score descending',
  ranked.every((r, i) => i === 0 || ranked[i - 1].score >= r.score));
check('a P0 (blocker or overdue) ranks first',
  ranked[0].priority === 'P0' && (ranked[0].id === 'blocker' || ranked[0].id === 'overdue'));
check('the quiet-newest draft ranks last', ranked[ranked.length - 1].id === 'draft-new');
check('every ranked run carries a non-empty reason', ranked.every((r) => typeof r.reason === 'string' && r.reason.length > 0));

// Determinism: same input + same `now` → identical ranking.
check('ranking is deterministic for a fixed now',
  JSON.stringify(prioritizeQueue(queue, NOW)) === JSON.stringify(ranked));

console.log(`\nprioritization eval: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
