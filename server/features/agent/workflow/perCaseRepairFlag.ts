/** PER_CASE_REPAIR_V1 — on: a PARTIAL compile run (some scripts made, some cases dropped on unresolved
 * targets) routes back to targeted re-grounding to recover the dropped cases, instead of proceeding straight
 * to execution with them abandoned. Bounded by MAX_REDISCOVERY_ATTEMPTS so it can never loop.
 *
 * COST/CAVEAT (why it is opt-in): re-grounding re-runs discovery and RE-AUTHORS all cases, so it trades
 * latency + model cost for recovery, and — because discovery replaces the evidence wholesale — a live-DOM
 * variance could change which cases compile. The surgical long-term form is a TARGETED, ADDITIVE
 * re-inspection of only the unresolved targets that never re-authors the good cases; this flag is the bounded
 * routing mechanism. Off (default) = legacy behavior byte-for-byte (only re-ground when NOTHING compiled). */
export function isPerCaseRepairEnabled(): boolean {
  const raw = String(process.env.PER_CASE_REPAIR_V1 || '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}
