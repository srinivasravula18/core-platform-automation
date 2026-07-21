/**
 * Input Processing Layer (NLU front-end) — sits ABOVE goal routing. It recovers spelling, detects entities,
 * and extracts intent signals from the raw user message, then emits a normalized "semantic query" the
 * downstream router + planner reason over. This is the top of the pipeline:
 *
 *   USER → [Spell Recovery · Entity Detection · Intent Signals] → Semantic Query → (router → planner → tools)
 *
 * It is deterministic and dependency-free. The LLM goal router remains the semantic fallback for phrasings
 * this layer can't confidently normalize — this layer only makes the input CLEANER, never routes on its own.
 */
import type { RoutingContext, RouteTarget } from './goals/types';

export interface ProcessedInput {
  /** The raw message, untouched — used for anything user-facing. */
  original: string;
  /** Spell-recovered + vocabulary-canonicalized text; feed THIS to the router/classifier. */
  normalized: string;
  /** Each token this layer rewrote, for transparency/telemetry. */
  corrections: Array<{ from: string; to: string }>;
  /** Detected artifact kinds ("cases", "runs", …) and named targets (apps/features) referenced. */
  entities: { kinds: string[]; targets: string[] };
  /** Coarse intent signals (non-exclusive) mirrored from the router's own vocabulary. */
  signals: { generate: boolean; execute: boolean; question: boolean; workspace: boolean; code: boolean };
}

// Canonical QA lexicon spell recovery corrects toward — single tokens PLUS the common glued compounds, so
// "tescases"/"testcaes" recover to "testcases" and then canonicalize to "test cases". App/entity names are
// added per-request from the routing context so a misspelled app name ("keyston") recovers too.
const QA_LEXICON = [
  'test', 'case', 'cases', 'testcase', 'testcases', 'script', 'scripts', 'testscript', 'testscripts',
  'run', 'runs', 'execution', 'executions', 'suite', 'suites', 'plan', 'plans', 'playwright',
  'defect', 'defects', 'bug', 'bugs', 'issue', 'issues', 'requirement', 'requirements',
  'coverage', 'scenario', 'scenarios', 'report', 'reports',
  'generate', 'create', 'write', 'draft', 'author', 'build', 'execute', 'review', 'analyze', 'analyse',
  'validation', 'boundary', 'negative', 'positive', 'regression', 'smoke', 'workflow', 'feature', 'features',
];

// Words this layer must never rewrite (common English/function words that can sit close to a QA noun).
const STOP = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'these', 'those', 'your', 'you', 'our', 'app', 'apps',
  'are', 'was', 'can', 'will', 'should', 'would', 'please', 'give', 'show', 'list', 'need', 'want', 'make',
  'about', 'into', 'over', 'have', 'has', 'not', 'all', 'any', 'each', 'some', 'more', 'also', 'when', 'what',
  'which', 'where', 'how', 'why', 'now', 'here', 'there', 'them', 'they', 'then', 'than', 'been', 'does', 'did',
  'provide', 'provided', 'parent', 'child', 'login', 'field', 'fields', 'value', 'values', 'using', 'above',
  'below', 'order', 'before', 'after', 'first', 'admin', 'user', 'users', 'page', 'pages', 'view', 'views',
]);

// Suffixes that mark ordinary English words (creation, running, management) — never "correct" these to a QA noun.
const REAL_WORD_SUFFIX = /(?:tion|sion|ing|ment|ness|able|ible|ance|ence|ity|ships?|ly)$/;

/** Damerau–Levenshtein distance (counts a single adjacent transposition as ONE edit — the most common typo). */
function editDistance(a: string, b: string): number {
  const al = a.length, bl = b.length;
  if (!al) return bl;
  if (!bl) return al;
  const d: number[][] = Array.from({ length: al + 1 }, () => new Array(bl + 1).fill(0));
  for (let i = 0; i <= al; i++) d[i][0] = i;
  for (let j = 0; j <= bl; j++) d[0][j] = j;
  for (let i = 1; i <= al; i++) {
    for (let j = 1; j <= bl; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[al][bl];
}

/** Canonicalize QA vocabulary so wording variants read identically — "testcases"/"test-cases"/"tc" → "test cases". */
export function normalizeQaVocab(text: string): string {
  return text
    .replace(/\btest[\s_-]*cases?\b/g, (m) => (/cases\b/.test(m) ? 'test cases' : 'test case'))
    .replace(/\btest[\s_-]*scripts?\b/g, (m) => (/scripts\b/.test(m) ? 'test scripts' : 'test script'))
    .replace(/\btest[\s_-]*runs?\b/g, (m) => (/runs\b/.test(m) ? 'test runs' : 'test run'))
    .replace(/\btest[\s_-]*suites?\b/g, (m) => (/suites\b/.test(m) ? 'test suites' : 'test suite'))
    .replace(/\btest[\s_-]*plans?\b/g, (m) => (/plans\b/.test(m) ? 'test plans' : 'test plan'))
    .replace(/\btcs\b/g, 'test cases')
    .replace(/\btc\b/g, 'test case');
}

/** The max edits tolerated for a token of a given length — tighter for short words to avoid false positives. */
function maxEditsFor(len: number): number {
  if (len <= 4) return 1;
  if (len <= 10) return 2; // covers "tescases"/"testcaes" (8) → "testcases"; guards below keep it safe
  return 0; // very long tokens are rarely QA nouns; leave them alone
}

/**
 * Spell Recovery — correct each out-of-vocabulary token to its nearest QA/entity term, under strict guards:
 * only alphabetic tokens of length ≥4 that aren't stopwords or clearly-English words, only toward a candidate
 * sharing the first letter, and only within a length-scaled edit distance. Everything else is left verbatim.
 */
export function recoverSpelling(message: string, extraVocab: string[] = []): { text: string; corrections: Array<{ from: string; to: string }> } {
  const vocab = Array.from(new Set([...QA_LEXICON, ...extraVocab.map((v) => v.toLowerCase()).filter(Boolean)]));
  const vocabSet = new Set(vocab);
  const corrections: Array<{ from: string; to: string }> = [];
  const text = message.replace(/[A-Za-z][A-Za-z]+/g, (token) => {
    const lower = token.toLowerCase();
    if (lower.length < 4 || vocabSet.has(lower) || STOP.has(lower) || REAL_WORD_SUFFIX.test(lower)) return token;
    const budget = maxEditsFor(lower.length);
    if (budget === 0) return token;
    let best: string | null = null;
    let bestDist = budget + 1;
    for (const cand of vocab) {
      if (cand[0] !== lower[0] || Math.abs(cand.length - lower.length) > 2) continue;
      const dist = editDistance(lower, cand);
      if (dist < bestDist) { bestDist = dist; best = cand; }
    }
    if (best && bestDist <= budget && best !== lower) {
      corrections.push({ from: token, to: best });
      // Preserve leading capitalization so display stays natural if the corrected text is ever surfaced.
      return /^[A-Z]/.test(token) ? best.charAt(0).toUpperCase() + best.slice(1) : best;
    }
    return token;
  });
  return { text, corrections };
}

/** Entity Detection — the artifact kinds and named app/feature targets the message references. */
export function detectEntities(message: string, ctx: RoutingContext = {}): { kinds: string[]; targets: string[] } {
  const t = normalizeQaVocab(message.toLowerCase());
  const kinds: string[] = [];
  const KIND_RE: Array<[string, RegExp]> = [
    ['cases', /\btest cases?\b|\bcases?\b/], ['scripts', /\btest scripts?\b|\bscripts?\b|\bplaywright\b/],
    ['runs', /\btest runs?\b|\bruns?\b|\bexecutions?\b/], ['suites', /\bsuites?\b/], ['plans', /\bplans?\b/],
    ['defects', /\bdefects?\b|\bbugs?\b|\bissues?\b/], ['requirements', /\brequirements?\b/], ['reports', /\breports?\b/],
  ];
  for (const [kind, re] of KIND_RE) if (re.test(t)) kinds.push(kind);
  const named = [...(ctx.selectedApps || []), ...(ctx.availableApps || []), ctx.conversationTarget]
    .filter(Boolean) as RouteTarget[];
  const targets = Array.from(new Set(named
    .map((a) => String(a?.name || '').trim())
    .filter((name) => name && t.includes(name.toLowerCase()))));
  return { kinds, targets };
}

/** Intent Signals — coarse, non-exclusive verb signals mirrored from the router's own vocabulary. */
export function extractIntentSignals(text: string): ProcessedInput['signals'] {
  const t = text.toLowerCase();
  return {
    generate: /\b(generate|create|write|draft|author|build|make|give|provide|need)\b/.test(t) && /\b(test|case|coverage|scenario)\b/.test(t),
    execute: /\b(run|execute|rerun|re-run|playwright|e2e|end to end|end-to-end)\b/.test(t),
    question: /\?/.test(t) || /^\s*(what|which|how|where|why|do|does|did|can|could|should|would|is|are)\b/.test(t),
    workspace: /\b(plan|suite|folder|report|defect|move|organize|organise|navigate|open)\b/.test(t),
    code: /\b(analy[sz]e|review|diff|recent changes|repo|repository|codebase|code changes?)\b/.test(t),
  };
}

/** Run the whole Input Processing Layer and emit the normalized semantic query + extracted signals/entities. */
export function processInput(message: string, ctx: RoutingContext = {}): ProcessedInput {
  const original = String(message || '');
  const entityNames = [...(ctx.selectedApps || []), ...(ctx.availableApps || []), ctx.conversationTarget]
    .filter(Boolean)
    .flatMap((a) => String((a as RouteTarget)?.name || '').toLowerCase().split(/[^a-z0-9]+/))
    .filter((w) => w.length >= 3);
  const { text: recovered, corrections } = recoverSpelling(original, entityNames);
  const normalized = normalizeQaVocab(recovered.toLowerCase()).replace(/\s+/g, ' ').trim();
  return {
    original,
    normalized,
    corrections,
    entities: detectEntities(recovered, ctx),
    signals: extractIntentSignals(normalized),
  };
}
