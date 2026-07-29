/**
 * Goal-term extraction — the intent vocabulary a run's evidence should cover (RC-2 coverage gate).
 *
 * App-agnostic by construction: terms come ENTIRELY from the user's goal text, never from any hardcoded
 * app/object/feature list. Stopwords are generic English + generic QA verbs (create/edit/test/…), so the
 * residue is the goal's real nouns ("account", "invoice", "list", "filter") whatever the target app is.
 */

/** Generic English + QA-verb stopwords — mirrors the inline set testRunGraph.ts used for object-name hints. */
const GOAL_STOPWORDS = new Set([
  'create', 'creating', 'new', 'add', 'adding', 'edit', 'update', 'updating', 'delete', 'remove',
  'test', 'tests', 'testing', 'case', 'cases', 'the', 'for', 'and', 'with', 'that', 'into', 'from',
  'user', 'app', 'apps', 'page', 'form', 'record', 'records', 'write', 'generate', 'verify', 'validate',
  'check', 'ensure', 'should', 'when', 'then', 'this', 'have', 'has', 'are', 'was', 'its', 'view',
  'able', 'want', 'need', 'make', 'using', 'use', 'via', 'get', 'set', 'all', 'any', 'some',
]);

/**
 * Extract the goal's intent terms (lowercased nouns ≥3 chars, stopwords removed, deduped, bounded).
 * Returns [] for empty/generic goals — callers treat an empty term set as "no coverage signal" (permissive).
 */
export function extractGoalTerms(goal: string | null | undefined, limit = 12): string[] {
  const words = String(goal || '').toLowerCase().match(/[a-z][a-z0-9_]{2,}/g) || [];
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const w of words) {
    if (GOAL_STOPWORDS.has(w) || seen.has(w)) continue;
    seen.add(w);
    terms.push(w);
    if (terms.length >= limit) break;
  }
  return terms;
}

/**
 * Which goal terms appear (as substrings) in the evidence vocabulary (target semantic names + labels).
 * Deliberately lexical + permissive — a match is any term contained in any vocab entry. Returns the
 * partition so the gate/coverage-report can reason about it; the gate NEVER hard-blocks on this alone.
 */
export function goalTermCoverage(goalTerms: string[], vocabulary: string[]): { covered: string[]; missing: string[] } {
  if (!goalTerms.length) return { covered: [], missing: [] };
  const hay = vocabulary.map((v) => String(v || '').toLowerCase()).filter(Boolean);
  const covered: string[] = [];
  const missing: string[] = [];
  for (const term of goalTerms) {
    (hay.some((v) => v.includes(term)) ? covered : missing).push(term);
  }
  return { covered, missing };
}
