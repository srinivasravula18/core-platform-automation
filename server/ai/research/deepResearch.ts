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

const SRC_EXT = /\.(tsx?|jsx?|vue|svelte|py|go|java|rb|cs|php)$/i;
const NOISE_PATH = /(^|\/)(node_modules|dist|build|coverage|\.next|\.github|\.playwright-cli|\.husky|evidence|seeds|fixtures|__tests__|e2e|tests?|migrations)\//i;
const NOISE_EXT = /\.(ya?ml|json|lock|md|txt|env.*|cfg|toml|ini|csv|snap|log)$/i;

/**
 * Select the RELEVANT source files for a set of terms — with a DYNAMIC count, not a fixed
 * top-N. Files are scored (source-ext + term-in-name/path, minus noise) and everything
 * within a band of the top score is kept: a broad feature naturally yields more files, a
 * narrow one fewer. The number of files "searched" therefore scales to the request.
 */
export function relevantSourcePaths(paths: string[], terms: string[]): string[] {
  const lc = terms.map((t) => t.toLowerCase()).filter(Boolean);
  const scored = paths.map((path) => {
    const p = String(path || '').toLowerCase();
    const base = p.split('/').pop() || '';
    let s = 0;
    if (NOISE_PATH.test(`/${p}`)) s -= 100;
    if (SRC_EXT.test(p)) s += 5;
    if (NOISE_EXT.test(p)) s -= 6;
    for (const t of lc) {
      if (base.includes(t)) s += 4;       // term in filename = strong signal
      else if (p.includes(t)) s += 1;     // term elsewhere in the path
    }
    return { path, s };
  }).filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
  if (!scored.length) return paths.filter((p) => SRC_EXT.test(p) && !NOISE_PATH.test(`/${p}`));
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
      prompt: `Decompose this request into up to ${max} DISTINCT investigation angles for searching an application's SOURCE CODE, so parallel searches cover the feature in depth (the way a senior engineer would split up exploring an unfamiliar codebase). Each angle must target a different sub-area — e.g. for a "list view" feature: saved/default views, filtering & sorting, columns & pagination, roles & permissions, bulk actions, export, inline edit, recycle bin. For each angle give a short name and 3-6 concrete search terms likely to appear in the real code (identifiers, route fragments, UI labels, function names, synonyms).

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

/** Research ONE facet: native search + read its code, then one worker call to extract grounded findings. */
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
    try { return `FILE: ${p}\n${await opts.io.read(p, bytesPerFile)}`; } catch { return ''; }
  }))).filter(Boolean).join('\n\n---\n\n');
  if (!excerpts) return { name: facet.name, findings: '' };

  try {
    const { text, shortCircuit } = await orch.generateText({
      prompt: `You are investigating ONE aspect of an application by reading its REAL source code. Report ONLY grounded findings for this aspect — used downstream to answer questions and write test cases.

ASPECT: ${facet.name}
OVERALL REQUEST (for context): ${opts.question}

From the code below, extract concise bullet findings for THIS aspect: concrete business rules, validations, required fields/limits/defaults, role/permission differences, branches & states, edge/negative cases (errors, empty states, invalid input), data preconditions, and REAL user-facing anchors (labels, button/link text, headings, table/column names, route fragments). Ground every bullet in the code shown; do NOT invent behaviour or meta-concepts. If the code below does not actually cover this aspect, reply exactly "no relevant code found".

CODE:
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
 * Run the full parallel investigation and return merged research notes (markdown), or ''
 * when planning yields nothing (the caller then falls back to a single-pass search).
 */
export async function deepParallelResearch(opts: DeepResearchOptions): Promise<string> {
  const max = opts.maxFacets ?? 6;
  const orch = await getOrchestrator(opts.orchestratorAgent, { workspaceId: opts.workspaceId, userId: opts.userId });

  opts.onProgress?.('Planning the investigation…');
  const facets = await planFacets(opts, orch, max);
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
