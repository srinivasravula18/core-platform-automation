/**
 * Deep PARALLEL code research — the Claude Code / Codex pattern.
 *
 * Before answering a question or writing test cases, decompose the request into several
 * DISTINCT investigation angles ("facets"), then research them ALL CONCURRENTLY: each
 * facet does fast native search + reads the real code and a worker call extracts grounded
 * findings for just that angle. A final caller-side step synthesizes the merged notes.
 *
 * Why fan-out: one sequential pass only sees a thin slice; N parallel workers cover the
 * feature in depth at roughly the wall-clock of a single worker (they run together). The
 * heavy expense (model calls) is parallelised, not serialised — unlike a tool loop that
 * makes one slow call per step.
 *
 * This engine is provider/repo-agnostic: the caller injects how to SEARCH and READ code
 * (git-grep over a repo path, or the project-scoped code index) so the SAME deep research
 * powers both the chat answer path and the deep-run case-grounding path.
 */
import { z } from 'zod';
import { getOrchestrator } from '../orchestrator';

const SEARCH_STOPWORDS = new Set([
  'what', 'which', 'how', 'many', 'much', 'does', 'the', 'are', 'and', 'for', 'from',
  'with', 'this', 'that', 'there', 'their', 'your', 'have', 'need', 'want', 'show',
  'tell', 'give', 'about', 'into', 'onto', 'then', 'than', 'when', 'where', 'why',
]);

function searchTokens(value: string): string[] {
  return Array.from(new Set(String(value || '').toLowerCase().match(/[a-z0-9]+/g) || []))
    .filter((token) => token.length >= 2 && !SEARCH_STOPWORDS.has(token));
}

function phraseVariants(value: string): string[] {
  const words = searchTokens(value);
  if (!words.length) return [];
  const joined = words.join(' ');
  const variants = new Set<string>([joined, ...words]);
  if (words.length > 1) {
    variants.add(words.join('-'));
    variants.add(words.join('_'));
    variants.add(words.join(''));
  }
  for (const word of words) {
    if (word.endsWith('s') && word.length > 3) variants.add(word.slice(0, -1));
    else variants.add(`${word}s`);
  }
  return Array.from(variants).filter((term) => term.length >= 2);
}

function intentExpansionTerms(words: string[]): string[] {
  const tokenSet = new Set(words);
  const terms = new Set<string>();
  const hasAny = (...items: string[]) => items.some((item) => tokenSet.has(item));
  if (hasAny('test', 'tests', 'case', 'cases', 'qa', 'coverage', 'scenario', 'scenarios', 'regression')) {
    [
      'validation', 'required', 'permission', 'permissions', 'role', 'roles', 'empty state',
      'error state', 'edge case', 'create', 'new', 'delete', 'bulk', 'export', 'inline edit',
    ].forEach((term) => terms.add(term));
  }
  if (hasAny('list', 'lists', 'table', 'tables', 'grid', 'grids', 'view', 'views')) {
    [
      'list view', 'list-view', 'list_view', 'list_views', 'table', 'grid', 'columns',
      'column', 'field', 'fields', 'filter', 'filters', 'sort', 'sorting', 'search',
      'pagination', 'toolbar', 'row actions', 'selected count', 'empty state',
    ].forEach((term) => terms.add(term));
  }
  return Array.from(terms);
}

function questionTerms(question: string): string[] {
  const phrases = Array.from(String(question || '').matchAll(/["'`]([^"'`]{2,80})["'`]/g))
    .map((m) => m[1]);
  const words = searchTokens(question);
  const adjacent = words.slice(0, -1).map((word, index) => `${word} ${words[index + 1]}`);
  const all = [...phrases, ...adjacent, ...words, ...intentExpansionTerms(words)].flatMap(phraseVariants);
  return Array.from(new Set(all)).slice(0, 36);
}

function numberLines(content: string): string {
  return String(content || '')
    .split(/\r?\n/)
    .map((line, index) => `${index + 1}: ${line}`)
    .join('\n');
}

/**
 * Select the RELEVANT source files for a set of terms — with a DYNAMIC count, not a fixed
 * top-N. Files are scored (source-ext + term-in-name/path, minus noise) and everything
 * within a band of the top score is kept: a broad feature naturally yields more files, a
 * narrow one fewer. The number of files "searched" therefore scales to the request.
 */
export function relevantSourcePaths(paths: string[], terms: string[]): string[] {
  const lc = terms.map((t) => t.toLowerCase()).filter(Boolean);
  const termTokens = new Set(lc.flatMap(searchTokens));
  const scored = paths.map((path) => {
    const p = String(path || '').toLowerCase();
    const base = p.split('/').pop() || '';
    const pathTokens = new Set(searchTokens(p));
    const baseTokens = new Set(searchTokens(base));
    let s = 0;
    for (const t of lc) {
      if (base.includes(t)) s += 5;
      else if (p.includes(t)) s += 2;
    }
    for (const token of termTokens) {
      if (baseTokens.has(token)) s += 4;
      else if (pathTokens.has(token)) s += 1;
    }
    return { path, s };
  }).filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
  if (!scored.length) return paths;
  // DYNAMIC cutoff: keep every file within ~40% of the top relevance score. Count emerges
  // from the result distribution — no hardcoded file count.
  const top = scored[0].s;
  const cutoff = Math.max(1, top * 0.4);
  return scored.filter((x) => x.s >= cutoff).map((x) => x.path);
}

/** How to reach the code. Injected by the caller so the engine works over any repo/scope. */
export interface ResearchIO {
  /** Return matching file paths for the given terms, best-ranked first. */
  search: (terms: string[], limit: number) => Promise<string[]>;
  /** Read a file's contents, bounded to maxBytes. */
  read: (path: string, maxBytes: number) => Promise<string>;
}

export interface DeepResearchOptions {
  question: string;
  io: ResearchIO;
  /** Which configured agent powers the planning + worker calls (e.g. 'chatAssistant', 'featureAnalyst'). */
  orchestratorAgent: string;
  workspaceId?: string;
  userId?: string;
  onProgress?: (label: string) => void;
  /** Max parallel facets (token-cost bound). Default 6. */
  maxFacets?: number;
  /** Bytes read per file. Default 3500. */
  bytesPerFile?: number;
}

const facetPlanSchema = z.object({
  facets: z.array(z.object({
    name: z.string().default('aspect'),
    terms: z.array(z.string()).default([]),
  })).default([]),
});

const NO_FINDINGS = /no relevant code found/i;

/** Plan the investigation angles. One model call; deterministic-empty on failure so the caller can fall back. */
async function planFacets(opts: DeepResearchOptions, orch: any, max: number): Promise<Array<{ name: string; terms: string[] }>> {
  try {
    const res = await orch.generateObject({
      prompt: `Decompose this request into the RIGHT number of DISTINCT investigation angles for searching an application's codebase files — as few as 2 for a simple, focused feature and up to ${max} for a broad, multi-part, or end-to-end one. Match the feature's REAL breadth the way a senior engineer would split up exploring an unfamiliar codebase: do NOT pad a simple feature with filler angles, and do NOT split a single concern into several. Each angle must target a genuinely different sub-area implied by the request. For each angle give a short name and 3-6 concrete search terms likely to appear in the real codebase (identifiers, route fragments, UI labels, config keys, test names, synonyms). Do not use documentation or Markdown files as a source.

REQUEST: ${opts.question}

Return strict JSON: {"facets":[{"name":"...","terms":["...","..."]}]}. Make the angles specific to THIS request — do not invent angles the request doesn't imply.`,
      schema: facetPlanSchema,
      userMessage: opts.question,
    });
    if ((res as any).shortCircuit) return [];
    const facets = ((res as any).object?.facets || [])
      .map((f: any) => ({ name: String(f.name || 'aspect'), terms: (f.terms || []).map((t: any) => String(t)).filter(Boolean) }))
      .filter((f: any) => f.terms.length);
    return facets.slice(0, max);
  } catch {
    return [];
  }
}

function fallbackFacets(question: string, max: number): Array<{ name: string; terms: string[] }> {
  const terms = questionTerms(question);
  if (!terms.length) return [];
  const facets: Array<{ name: string; terms: string[] }> = [];
  const windowSize = Math.max(4, Math.ceil(terms.length / Math.max(1, Math.min(max, 4))));
  for (let i = 0; i < terms.length && facets.length < max; i += windowSize) {
    const slice = terms.slice(i, i + windowSize);
    if (slice.length) facets.push({ name: `request terms ${facets.length + 1}`, terms: slice.slice(0, 8) });
  }
  return facets;
}

function mergeFacets(
  planned: Array<{ name: string; terms: string[] }>,
  fallback: Array<{ name: string; terms: string[] }>,
  max: number,
): Array<{ name: string; terms: string[] }> {
  const out: Array<{ name: string; terms: string[] }> = [];
  const seenNames = new Set<string>();
  const seenTermSets = new Set<string>();
  const ordered = fallback.length ? [fallback[0], ...planned, ...fallback.slice(1)] : planned;
  for (const facet of ordered) {
    const terms = Array.from(new Set((facet.terms || []).flatMap(phraseVariants))).filter(Boolean).slice(0, 8);
    if (!terms.length) continue;
    const name = String(facet.name || `request terms ${out.length + 1}`).trim();
    const termKey = terms.map((term) => term.toLowerCase()).sort().join('|');
    const nameKey = name.toLowerCase();
    if (seenNames.has(nameKey) || seenTermSets.has(termKey)) continue;
    seenNames.add(nameKey);
    seenTermSets.add(termKey);
    out.push({ name, terms });
    if (out.length >= max) break;
  }
  return out;
}

/** Research ONE facet: native search + read its evidence, then one worker call to extract grounded findings. */
async function researchFacet(
  facet: { name: string; terms: string[] },
  opts: DeepResearchOptions,
  orch: any,
): Promise<{ name: string; findings: string }> {
  const bytesPerFile = opts.bytesPerFile ?? 3500;
  let paths: string[] = [];
  try {
    // The caller's io.search already returns a DYNAMIC, relevance-filtered set (no fixed N).
    paths = await opts.io.search(facet.terms, 80);
  } catch {
    paths = [];
  }
  const excerpts = (await Promise.all(paths.map(async (p) => {
    try { return `FILE: ${p}\n${numberLines(await opts.io.read(p, bytesPerFile))}`; } catch { return ''; }
  }))).filter(Boolean).join('\n\n---\n\n');
  if (!excerpts) return { name: facet.name, findings: '' };

  try {
    const { text, shortCircuit } = await orch.generateText({
      prompt: `You are investigating ONE aspect of an application by reading its REAL codebase files. Report ONLY grounded findings for this aspect — used downstream to answer questions and write test cases. Markdown/documentation files are not allowed as sources.

ASPECT: ${facet.name}
OVERALL REQUEST (for context): ${opts.question}

From the evidence below, extract concise bullet findings for THIS aspect: concrete business rules, validations, required fields/limits/defaults, role/permission differences, branches & states, edge/negative cases (errors, empty states, invalid input), data preconditions, and REAL user-facing anchors (labels, button/link text, headings, table/column names, route fragments). Ground every bullet in the evidence shown; include supporting codebase references as path:line when the line is visible. Do NOT invent behaviour, meta-concepts, or citations. If the evidence below does not actually cover this aspect, reply exactly "no relevant code found".

EVIDENCE:
${excerpts}`,
      userMessage: facet.name,
      hasHistory: true,
    });
    return { name: facet.name, findings: shortCircuit || text || '' };
  } catch {
    return { name: facet.name, findings: '' };
  }
}

/**
 * Pick an UPPER BOUND on investigation angles from the request's apparent breadth. The
 * planner then chooses the actual number within this ceiling, so the count scales with
 * complexity: a focused single-feature prompt gets a small ceiling; a broad / E2E /
 * regression / multi-object prompt gets a larger one. Replaces the old fixed cap of 6.
 */
export function facetCeiling(question: string): number {
  const q = String(question || '').toLowerCase();
  let ceiling = 5; // base for a normal single-feature request
  // Breadth signals — these requests genuinely span many sub-areas.
  if (/\b(e2e|end[-\s]?to[-\s]?end|regression|across|entire|whole|full|every|all\b|life\s?cycle|workflow|traceability|chain|multi[-\s]?(object|step)|app\s?scope|cross[-\s]?object|relationship)\b/.test(q)) {
    ceiling += 4;
  }
  // Conjunctions imply multiple distinct things to investigate ("X and Y then Z").
  const conjunctions = (q.match(/\b(and|then|plus)\b|,/g) || []).length;
  ceiling += Math.min(4, conjunctions);
  // Longer, more detailed asks tend to imply more angles.
  if (q.length > 140) ceiling += 2;
  // Keep it sane: never fewer than 3, never a runaway fan-out.
  return Math.max(3, Math.min(14, ceiling));
}

/**
 * Run the full parallel investigation and return merged research notes (markdown), or ''
 * when planning yields nothing (the caller then falls back to a single-pass search).
 */
export async function deepParallelResearch(opts: DeepResearchOptions): Promise<string> {
  // Ceiling on investigation angles. The planner picks the ACTUAL count within this
  // bound from the feature's real breadth — so simple prompts use few angles and broad
  // / E2E prompts use more, instead of every request collapsing to a fixed number.
  const max = opts.maxFacets ?? facetCeiling(opts.question);
  const orch = await getOrchestrator(opts.orchestratorAgent, { workspaceId: opts.workspaceId, userId: opts.userId });

  opts.onProgress?.('Planning the investigation…');
  // IMPORTANT: the heuristic fallback is used ONLY when the planner returns nothing — it is
  // NOT used to pad a genuine (possibly small) plan up to `max`. That padding is exactly what
  // forced every request to the same count regardless of complexity.
  const planned = await planFacets(opts, orch, max);
  const facets = planned.length
    ? mergeFacets(planned, [], max)
    : mergeFacets([], fallbackFacets(opts.question, max), max);
  if (!facets.length) return '';

  opts.onProgress?.(`Searching ${facets.length} areas of the codebase in parallel…`);
  // FAN-OUT: every facet researched concurrently — wall-clock ≈ the slowest single facet.
  const results = await Promise.all(
    facets.map((f) => researchFacet(f, opts, orch).catch(() => ({ name: f.name, findings: '' }))),
  );

  const notes = results
    .filter((r) => r.findings && !NO_FINDINGS.test(r.findings))
    .map((r) => `## ${r.name}\n${r.findings.trim()}`)
    .join('\n\n');
  return notes.trim();
}
