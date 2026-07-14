/**
 * Existing-test-case reuse search. Given a new request, find already-stored cases that genuinely cover
 * the same behavior so the user can reuse them instead of regenerating. Deliberately LEXICAL (no
 * embeddings/vector DB — out of scope per the architecture plan); the care is in the scoring, not the
 * infrastructure. The ranker combines four signals, each addressing a specific false-positive/negative
 * of naive keyword counting:
 *   1. IDF-lite term weighting — a shared rare term ("pagination") means far more than a shared common
 *      one ("list"); plain overlap over-rewards generic words.
 *   2. Phrase (bigram) anchoring — two adjacent query words appearing together is strong evidence the
 *      candidate is about the same feature, not two coincidentally-shared single words.
 *   3. Scope alignment — a case tagged/targeted at the SAME module/object as the mission is far more
 *      likely relevant; a same-worded case in a different module usually is not.
 *   4. Length normalization — a long case description trivially contains many query words; scoring is
 *      normalized by query coverage, not raw candidate hits, so verbose cases don't dominate.
 * Output is a normalized 0..1 relevance with human-readable reasons, so the coverage card can explain
 * WHY each case surfaced and the user can trust (or delete) each suggestion.
 */

const STOP = new Set([
  'the', 'and', 'for', 'test', 'tests', 'case', 'cases', 'with', 'that', 'this', 'from', 'into',
  'your', 'will', 'must', 'should', 'verify', 'check', 'have', 'page', 'app', 'application',
  'when', 'then', 'using', 'about', 'flow', 'flows', 'scenario', 'scenarios', 'write', 'create', 'generate',
  'are', 'was', 'not', 'its', 'has', 'all', 'any', 'can', 'but', 'you', 'they', 'them',
]);

const words = (value: unknown): string[] => String(value || '').toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) || [];

/** Light stem so paraphrases align: sorting/sorted/sorts → sort; filters → filter. Not linguistic — just the
 * common English inflections that otherwise split one concept into several non-matching tokens. */
function stem(token: string): string {
  let t = token;
  for (const suffix of ['ations', 'ation', 'ings', 'ing', 'ers', 'er', 'ies', 'es', 'ed', 's']) {
    if (t.length > suffix.length + 2 && t.endsWith(suffix)) { t = t.slice(0, -suffix.length); break; }
  }
  return t.replace(/ie$/, 'y');
}

function contentTokens(value: unknown): string[] {
  return words(value).filter((w) => !STOP.has(w)).map(stem);
}

function bigrams(tokens: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < tokens.length - 1; i += 1) out.push(`${tokens[i]} ${tokens[i + 1]}`);
  return out;
}

export interface ReuseCandidate {
  id?: string;
  title?: string;
  description?: string;
  tags?: string[];
  /** Scope hints stored on the case — matched against the mission's module/object for the scope bonus. */
  module?: string;
  object?: string;
  targetObject?: string;
}

export interface ReuseQuery {
  /** The request text (prompt + approved understanding + feature title) that defines what to cover. */
  text: string;
  /** Mission scope for the alignment signal — a case in the same module/object is more likely relevant. */
  module?: string;
  object?: string;
}

export interface ReuseMatch<T = ReuseCandidate> {
  case: T;
  /** Normalized 0..1 relevance. */
  relevance: number;
  matched: boolean;
  /** Human-readable, e.g. ["shared terms: pagination, sort", "same module: objects"]. */
  reasons: string[];
  /** The strongest shared phrase, when one exists (drives the "about the same feature" confidence). */
  anchor: string;
}

/** Match threshold — below this, a candidate is coincidental overlap, not genuine coverage. Tuned so a
 * single shared rare term OR two shared common terms with no phrase/scope support does NOT surface. */
const MATCH_THRESHOLD = 0.34;

/**
 * Rank stored cases against a request. `poolTexts` (all candidate haystacks) drives IDF-lite weighting,
 * so "rare within this project's cases" terms count more. Pure function; deterministic given its inputs.
 */
export function rankReuseCandidates<T extends ReuseCandidate>(query: ReuseQuery, candidates: T[]): ReuseMatch<T>[] {
  const qTokens = contentTokens(query.text);
  if (!qTokens.length || !candidates.length) return [];
  const qSet = new Set(qTokens);
  const qBigrams = new Set(bigrams(qTokens));
  const qModule = stem(String(query.module || '').toLowerCase());
  const qObject = stem(String(query.object || '').toLowerCase());

  // IDF-lite: how many candidates contain each query term. A term in every case (df == N) is worthless;
  // a term in one or two cases is a strong discriminator. weight = ln(1 + N / (1 + df)).
  const n = candidates.length;
  const candTokenSets = candidates.map((c) => new Set(contentTokens(`${c.title || ''} ${c.description || ''} ${(c.tags || []).join(' ')}`)));
  const df = new Map<string, number>();
  for (const term of qSet) {
    let count = 0;
    for (const set of candTokenSets) if (set.has(term)) count += 1;
    df.set(term, count);
  }
  const idf = (term: string): number => Math.log(1 + n / (1 + (df.get(term) ?? 0)));
  const maxPossible = Array.from(qSet).reduce((sum, term) => sum + idf(term), 0) || 1;

  const results: ReuseMatch<T>[] = [];
  for (let i = 0; i < candidates.length; i += 1) {
    const cand = candidates[i];
    const candTokens = candTokenSets[i];
    // (1)+(4): IDF-weighted coverage of the QUERY's terms (normalized by query mass, not candidate size).
    let overlapMass = 0;
    const sharedTerms: string[] = [];
    for (const term of qSet) {
      if (candTokens.has(term)) { overlapMass += idf(term); sharedTerms.push(term); }
    }
    const coverage = overlapMass / maxPossible;

    // (2): phrase anchor — the strongest shared bigram present in the candidate text.
    const candBigrams = new Set(bigrams(contentTokens(`${cand.title || ''} ${cand.description || ''}`)));
    let anchor = '';
    for (const bg of qBigrams) if (candBigrams.has(bg)) { anchor = bg; break; }

    // (3): scope alignment — case tags/module/object overlapping the mission scope.
    const candScope = [cand.module, cand.object, cand.targetObject, ...(cand.tags || [])]
      .map((s) => stem(String(s || '').toLowerCase())).filter(Boolean);
    const scopeHit = (qModule && candScope.includes(qModule)) || (qObject && candScope.includes(qObject));

    // Blend: coverage is the backbone; a phrase anchor and a scope hit each add a bounded, decaying bonus
    // (never lets one weak signal alone clear the bar). Capped at 1.
    let relevance = coverage;
    if (anchor) relevance += 0.15 * (1 - relevance);
    if (scopeHit) relevance += 0.12 * (1 - relevance);
    relevance = Math.min(1, relevance);

    // Matched requires real coverage AND at least one corroborating signal (≥2 shared terms, a phrase, or
    // a scope hit) — coverage alone from one lucky rare term is not enough to claim reuse.
    const corroborated = sharedTerms.length >= 2 || !!anchor || scopeHit;
    const matched = relevance >= MATCH_THRESHOLD && corroborated;

    if (relevance <= 0) continue;
    const reasons: string[] = [];
    if (sharedTerms.length) reasons.push(`shared terms: ${sharedTerms.slice(0, 6).join(', ')}`);
    if (anchor) reasons.push(`same phrase: "${anchor}"`);
    if (scopeHit) reasons.push(`same ${qModule && candScope.includes(qModule) ? 'module' : 'object'}`);
    results.push({ case: cand, relevance: Number(relevance.toFixed(3)), matched, reasons, anchor });
  }

  return results.filter((r) => r.matched).sort((a, b) => b.relevance - a.relevance);
}

/* ------------------------------------------------------------------------------------------------
 * Backward-compatible legacy exports (the pre-existing binary keyword scorer). Retained so the legacy
 * pipeline's findRelatedExistingCases keeps compiling; new code should use rankReuseCandidates.
 * ---------------------------------------------------------------------------------------------- */

/** Require a feature phrase match before broad keyword overlap can suggest an existing case. */
export function scoreCaseReuse(query: string, candidate: string, keywords: string[]) {
  const legacyWords = (value: unknown) => String(value || '').toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) || [];
  const queryWords = legacyWords(query).filter((word) => !STOP.has(word));
  const anchors = queryWords.slice(0, -1).map((word, index) => `${word} ${queryWords[index + 1]}`);
  const haystack = String(candidate || '').toLowerCase();
  const anchor = anchors.find((phrase) => haystack.includes(phrase)) || '';
  const reasons = [...new Set(keywords.filter((keyword) => haystack.includes(keyword)))];
  return { score: reasons.length, reasons, anchor, matched: reasons.length >= 2 && (!!anchor || anchors.length === 0) };
}

/** Reused cases are stored once, but must remain linked to every requirement that reuses them. */
export function linkedExistingCases(existingMatches: any[], cases: any[]): any[] {
  const found = new Map<string, any>();
  for (const item of [...(existingMatches || []), ...(cases || []).filter((c) => c?.reused && c?.existingCaseId)]) {
    const id = String(item?.existingCaseId || item?.id || '').trim();
    if (id) found.set(id, item);
  }
  return [...found.values()];
}
