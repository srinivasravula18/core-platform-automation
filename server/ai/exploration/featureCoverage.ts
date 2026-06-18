/**
 * DEEP feature + sub-feature coverage analysis (book Ch 7/11/19).
 *
 * This replaces the shallow token-overlap completeness check (verifier.assessFeatureCompleteness,
 * which only asks "does the sub-feature's NAME appear in a case") with a real, BEHAVIOR-LEVEL
 * coverage audit:
 *
 *   1. Decompose the feature into sub-features grounded in the REAL source code — reusing the
 *      existing FeatureDiscoveryAgent (discoverFeatureInventoryFromSource). Each sub-feature
 *      already carries its concrete businessRules, userActions, and testIdeas.
 *   2. For EACH sub-feature, reason (grounded, one model call per feature) about which of its
 *      individual business rules / user actions are actually EXERCISED by the existing test
 *      cases, and which are MISSING — then propose targeted cases for the gaps.
 *   3. Roll the per-behavior verdicts up to a per-sub-feature and feature-level coverage %.
 *
 * The unit of coverage is a single behavior (a business rule or a user action), not a keyword.
 * That is the difference between "fancy response" and an in-depth audit.
 */
import { z } from 'zod';
import { getOrchestrator } from '../orchestrator';
import { discoverFeatureInventoryFromSource, type FeatureInventory } from '../../features/requirements/requirementService';
import { gitGrep, readRepoFile } from '../../features/git-agent/gitAgentService';
import { expandByReferences, graphSummary } from './referenceGraph';

/**
 * FAST, TARGETED discovery via the reference graph (Claude-Code-style) instead of a repo-wide
 * scan. Grep a few seed files for the feature, follow their imports root -> child -> nth-child
 * to the CONNECTED set, read only those, and make ONE agent call to extract the feature's
 * sub-features (with their business rules + user actions). This is what lets the audit COMPLETE
 * on a large repo where the heavy whole-repo discovery (discoverFeatureInventoryFromSource)
 * times out. The agent still does all the reasoning; the graph just retrieves the right files.
 */
const graphInventorySchema = z.object({
  appName: z.string().default('Application'),
  features: z.array(z.object({
    name: z.string().default('Feature'),
    surface: z.string().default('Application'),
    subfeatures: z.array(z.object({
      name: z.string().default('Subfeature'),
      description: z.string().default(''),
      businessRules: z.array(z.string()).default([]),
      userActions: z.array(z.string()).default([]),
      testIdeas: z.array(z.string()).default([]),
      priority: z.string().default('Medium'),
    })).default([]),
  })).default([]),
});

async function discoverViaGraph(feature: string, opts: {
  workspaceId?: string; userId?: string; repoPath?: string; onProgress?: (label: string) => void;
}): Promise<FeatureInventory> {
  const repoPath = opts.repoPath || process.env.GIT_AGENT_TARGET_REPO || process.env.CORE_PLATFORM_REPO || '';
  const orch = await getOrchestrator('featureDiscoveryAgent', { workspaceId: opts.workspaceId, userId: opts.userId });

  // The AGENT decides WHERE to look — it proposes the code-search terms for this feature. No
  // hardcoded keyword/stopword lists and no hand-coded "this folder matters more" path scoring:
  // the agent drives the deep search; grep + the reference graph are just retrieval tools.
  opts.onProgress?.('Planning the code search…');
  let terms: string[] = [];
  try {
    const tr = await orch.generateObject<{ terms: string[] }>({
      prompt: `Propose 6-12 concrete CODE SEARCH TERMS most likely to appear in the REAL source files that implement the feature "${feature}" — component/file-name fragments, identifiers, route fragments, UI label text, store/hook/service names. Return strict JSON {"terms":["...","..."]}.`,
      schema: z.object({ terms: z.array(z.string()).default([]) }),
      userMessage: feature,
    });
    terms = (((tr as any).object?.terms) || []).map((t: any) => String(t).trim()).filter(Boolean);
  } catch { /* fall back to the raw feature words below */ }
  if (!terms.length) terms = String(feature || '').split(/\s+/).map((w) => w.trim()).filter((w) => w.length >= 3);

  opts.onProgress?.(`Searching the codebase for ${terms.slice(0, 5).join(', ')}…`);
  // Seeds = the strongest grep hits (gitGrep already ranks by match strength); the only filter
  // is "real source, not test files". The reference graph then follows their imports to the
  // connected code — no hand-coded path-relevance bias.
  const seeds = Array.from(new Set(
    gitGrep(terms, undefined, 60, repoPath)
      .map((h) => h.path)
      .filter((p) => /\.(tsx?|jsx?|vue|svelte)$/i.test(p) && !/\.(spec|test|stories)\./i.test(p)),
  )).slice(0, 6);
  if (!seeds.length) return { appName: 'Application', features: [] } as unknown as FeatureInventory;

  opts.onProgress?.('Following imports (root → child → nth-child) to the connected code…');
  const nodes = await expandByReferences(seeds, { read: async (p, b) => readRepoFile(p, b, repoPath) }, { maxDepth: 2, maxFiles: 30 });
  opts.onProgress?.(graphSummary(nodes));

  const excerpts = (await Promise.all(nodes.slice(0, 30).map(async (n) => {
    try { return `FILE: ${n.path}\n${readRepoFile(n.path, 3000, repoPath)}`; } catch { return ''; }
  }))).filter(Boolean).join('\n\n---\n\n');
  if (!excerpts) return { appName: 'Application', features: [] } as unknown as FeatureInventory;

  opts.onProgress?.('Extracting features & sub-features from the connected code…');
  const basePrompt = `You are FeatureDiscoveryAgent. From the REAL connected source files below (gathered by following imports from the files that match the feature), decompose the feature into its testable SUB-FEATURES.

Describe the feature primarily from the USER's perspective — the things a tester would actually exercise in the UI: visible controls and columns, search/sort/filter/pagination, selecting rows and row/bulk actions, create/edit/delete, validation messages, empty and error states, permission-gated controls. Capture backend-enforced rules too, but frame each sub-feature as a user-facing capability when the code supports one. For each sub-feature capture its concrete businessRules (rules the code enforces) and userActions (what a user does), grounded ONLY in the code shown. Do not invent behaviour not present in the code.

FEATURE: ${feature}

CONNECTED SOURCE (root → child → nth-child):
${excerpts}

Return strict JSON for the schema. A sub-feature is testable on its own: a user action, a validation, a permission rule, a table/list behavior, an empty/error state, or a code branch. Prefer one sub-feature per user-visible capability or enforced rule.`;

  // Discovery is one model call and can occasionally return an empty features array on this
  // model. Retry once with a firmer instruction before giving up — an empty result then is
  // reported HONESTLY upstream ("coverage could not be assessed"), never as a false green.
  let inv: FeatureInventory = { appName: 'Application', features: [] } as unknown as FeatureInventory;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const res = await orch.generateObject<z.infer<typeof graphInventorySchema>>({
      prompt: attempt === 0
        ? basePrompt
        : `${basePrompt}\n\nIMPORTANT: a previous attempt returned NO sub-features, but the connected source above DOES implement this feature. Identify its concrete, user-testable sub-features now and return a NON-EMPTY features array.`,
      schema: graphInventorySchema,
      userMessage: feature,
    });
    if ((res as any).shortCircuit) break;
    inv = ((res as any).object || inv) as FeatureInventory;
    if (Array.isArray(inv?.features) && inv.features.length) break;
    if (attempt === 0) opts.onProgress?.('Discovery returned nothing — retrying once…');
  }
  return inv;
}

export interface ExistingCaseLike {
  title?: string;
  description?: string;
  tags?: string[];
  steps?: Array<{ action?: string; expected?: string }> | unknown;
}

export interface BehaviorVerdict {
  behavior: string;
  kind: 'business_rule' | 'user_action';
  covered: boolean;
  coveredByCaseTitle?: string;
  why: string;
}

export interface SubFeatureCoverage {
  name: string;
  description: string;
  priority: string;
  behaviorsTotal: number;
  behaviorsCovered: number;
  coveragePercent: number;
  status: 'covered' | 'partial' | 'uncovered';
  behaviors: BehaviorVerdict[];
  proposedCases: Array<{ title: string; priority: string; rationale: string; steps: Array<{ action: string; expected: string }> }>;
}

export interface FeatureCoverage {
  name: string;
  surface: string;
  subFeatures: SubFeatureCoverage[];
  behaviorsTotal: number;
  behaviorsCovered: number;
  coveragePercent: number;
}

export interface FeatureCoverageReport {
  query: string;
  appName: string;
  features: FeatureCoverage[];
  summary: {
    featuresAnalyzed: number;
    subFeaturesTotal: number;
    subFeaturesCovered: number;
    subFeaturesPartial: number;
    subFeaturesUncovered: number;
    behaviorsTotal: number;
    behaviorsCovered: number;
    coveragePercent: number;
  };
}

const stepSchema = z.object({ action: z.string().default(''), expected: z.string().default('') });
const coverageCallSchema = z.object({
  subfeatures: z.array(z.object({
    name: z.string().default(''),
    behaviors: z.array(z.object({
      behavior: z.string().default(''),
      kind: z.enum(['business_rule', 'user_action']).default('business_rule'),
      covered: z.boolean().default(false),
      coveredByCaseTitle: z.string().default(''),
      why: z.string().default(''),
    })).default([]),
    proposedCases: z.array(z.object({
      title: z.string().default('Proposed case'),
      priority: z.string().default('Medium'),
      rationale: z.string().default(''),
      steps: z.array(stepSchema).default([]),
    })).default([]),
  })).default([]),
});

function caseDigest(cases: ExistingCaseLike[]): string {
  if (!cases.length) return '(no existing test cases — every behavior is a candidate gap)';
  return cases.slice(0, 120).map((c, i) => {
    const steps = Array.isArray(c.steps)
      ? (c.steps as Array<{ action?: string; expected?: string }>).map((s) => `${s?.action || ''} -> ${s?.expected || ''}`).filter((s) => s.trim() !== '->').slice(0, 8).join(' | ')
      : '';
    return `#${i + 1} "${c.title || 'Untitled'}"${c.tags?.length ? ` [${c.tags.join(', ')}]` : ''}${steps ? `\n     steps: ${steps}` : ''}`;
  }).join('\n');
}

function pct(covered: number, total: number): number {
  return total === 0 ? 100 : Math.round((covered / total) * 100);
}

/** Analyze coverage of ONE feature's sub-features against the existing cases (one model call). */
async function analyzeOneFeature(
  feature: any,
  cases: ExistingCaseLike[],
  opts: { workspaceId?: string; userId?: string },
): Promise<FeatureCoverage> {
  const subfeatures = Array.isArray(feature?.subfeatures) ? feature.subfeatures : [];
  const orch = await getOrchestrator('featureAnalyst', opts);
  const digest = caseDigest(cases);

  const buildBlueprint = (chunk: any[]) => chunk.map((sf: any, i: number) => {
    const rules = (sf?.businessRules || []).map((r: string) => `      [business_rule] ${r}`);
    const actions = (sf?.userActions || []).map((a: string) => `      [user_action] ${a}`);
    const ideas = (sf?.testIdeas || []).length ? `      testIdeas: ${(sf.testIdeas || []).join('; ')}` : '';
    return `  Sub-feature ${i + 1}: ${sf?.name || 'Subfeature'} (priority=${sf?.priority || 'Medium'})\n    Behaviors to cover:\n${[...rules, ...actions].join('\n') || '      (no explicit behaviors discovered)'}${ideas ? `\n${ideas}` : ''}`;
  }).join('\n\n');

  // Audit in small BATCHES (4 sub-features/call). A single call over many sub-features tends to
  // truncate / go off-schema and previously failed the WHOLE feature; batching keeps each
  // response well-formed, and a failed batch only leaves ITS sub-features unmatched → they fall
  // through to UNCOVERED below (honest), never throwing the whole feature into a false-green.
  const CHUNK = 4;
  const chunks: any[][] = [];
  for (let i = 0; i < subfeatures.length; i += CHUNK) chunks.push(subfeatures.slice(i, i + CHUNK));

  const auditChunk = async (chunk: any[], idx: number): Promise<any[]> => {
    try {
      const res = await orch.generateObject<z.infer<typeof coverageCallSchema>>({
        prompt: `You are auditing TEST COVERAGE of a feature, sub-feature by sub-feature, behavior by behavior. For each sub-feature below, decide — for EACH listed behavior (a business rule or a user action) — whether an EXISTING test case actually exercises it. A behavior is "covered" only when a case's title/steps would genuinely test that specific behavior (not merely mention the same words). Cite the covering case title. For every UNCOVERED behavior, propose a concrete test case (title + ordered steps with expected results) that would cover it.

FEATURE: ${feature?.name || 'Feature'} (${feature?.surface || 'Application'})

SUB-FEATURES AND THEIR BEHAVIORS (the coverage checklist — derived from the real source code):
${buildBlueprint(chunk)}

EXISTING TEST CASES (judge coverage against THESE):
${digest}

Return strict JSON for the schema: for every sub-feature, an entry with its behaviors (each: behavior text, kind, covered true/false, coveredByCaseTitle when covered, a short why) and proposedCases for the gaps. Be strict: when in doubt, mark a behavior UNCOVERED rather than generously covered — an honest gap is more useful than a false green. Do not invent behaviors beyond those listed.`,
        schema: coverageCallSchema,
        userMessage: `coverage audit: ${feature?.name || 'feature'} [batch ${idx + 1}]`,
      });
      return (res as any).shortCircuit ? [] : ((res as any).object?.subfeatures || []);
    } catch {
      return []; // a failed batch → its sub-features stay unmatched → UNCOVERED below (honest, not fatal)
    }
  };

  // PARALLELIZE the batches (book Ch 3): they are independent, so wall-clock ≈ one batch
  // instead of the sum — which is what made the sequential version exceed the run budget.
  const byName = new Map<string, any>();
  const batchResults = await Promise.all(chunks.map((chunk, idx) => auditChunk(chunk, idx)));
  for (const arr of batchResults) {
    for (const s of arr) byName.set(String(s?.name || '').toLowerCase().trim(), s);
  }

  const subResults: SubFeatureCoverage[] = subfeatures.map((sf: any) => {
    const name = String(sf?.name || 'Subfeature');
    const declared = [
      ...(sf?.businessRules || []).map((r: string) => ({ behavior: r, kind: 'business_rule' as const })),
      ...(sf?.userActions || []).map((a: string) => ({ behavior: a, kind: 'user_action' as const })),
    ];
    const judged = byName.get(name.toLowerCase().trim());
    const judgedByText = new Map<string, any>();
    for (const b of judged?.behaviors || []) judgedByText.set(String(b?.behavior || '').toLowerCase().trim(), b);

    // Anchor on the DECLARED behaviors (from code), enriched with the model's verdict. A
    // behavior with no matching verdict is treated as UNCOVERED (honest default).
    const behaviors: BehaviorVerdict[] = declared.map((d) => {
      const v = judgedByText.get(d.behavior.toLowerCase().trim());
      const covered = !!v?.covered;
      return {
        behavior: d.behavior,
        kind: d.kind,
        covered,
        coveredByCaseTitle: covered ? String(v?.coveredByCaseTitle || '') || undefined : undefined,
        why: String(v?.why || (covered ? 'covered' : 'no existing case exercises this behavior')),
      };
    });
    const behaviorsCovered = behaviors.filter((b) => b.covered).length;
    const coveragePercent = pct(behaviorsCovered, behaviors.length);
    const status: SubFeatureCoverage['status'] = behaviors.length === 0
      ? 'covered'
      : behaviorsCovered === 0 ? 'uncovered' : behaviorsCovered === behaviors.length ? 'covered' : 'partial';
    const proposedCases = (judged?.proposedCases || []).map((p: any) => ({
      title: String(p?.title || 'Proposed case'),
      priority: String(p?.priority || 'Medium'),
      rationale: String(p?.rationale || ''),
      steps: (p?.steps || []).map((s: any) => ({ action: String(s?.action || ''), expected: String(s?.expected || '') })),
    }));
    return { name, description: String(sf?.description || ''), priority: String(sf?.priority || 'Medium'), behaviorsTotal: behaviors.length, behaviorsCovered, coveragePercent, status, behaviors, proposedCases };
  });

  const behaviorsTotal = subResults.reduce((n, s) => n + s.behaviorsTotal, 0);
  const behaviorsCovered = subResults.reduce((n, s) => n + s.behaviorsCovered, 0);
  return {
    name: String(feature?.name || 'Feature'),
    surface: String(feature?.surface || 'Application'),
    subFeatures: subResults,
    behaviorsTotal,
    behaviorsCovered,
    coveragePercent: pct(behaviorsCovered, behaviorsTotal),
  };
}

/**
 * Run the full DEEP coverage audit for a feature query. Discovers the feature/sub-feature
 * inventory from real source (unless one is supplied), then audits each feature's sub-features
 * behavior-by-behavior against the existing cases. One model call per feature (bounded).
 */
export async function analyzeFeatureCoverage(opts: {
  feature: string;
  inventory?: FeatureInventory;
  existingCases?: ExistingCaseLike[];
  workspaceId?: string;
  userId?: string;
  repoPath?: string;
  maxFeatures?: number;
  /** Opt-in: fall back to the heavy whole-repo discovery if the fast graph path finds nothing. */
  deepDiscovery?: boolean;
  onProgress?: (label: string) => void;
}): Promise<FeatureCoverageReport> {
  const cases = opts.existingCases || [];
  const maxFeatures = Math.max(1, Math.min(12, opts.maxFeatures ?? 6));

  let inventory = opts.inventory;
  if (!inventory) {
    // DEFAULT: fast, targeted reference-graph discovery (completes on large repos).
    inventory = await discoverViaGraph(opts.feature, {
      workspaceId: opts.workspaceId,
      userId: opts.userId,
      repoPath: opts.repoPath,
      onProgress: opts.onProgress,
    });
    // OPT-IN: the heavy repo-wide discovery, only if explicitly requested AND the fast path
    // found nothing (it scans the whole repo, so it is slow / can time out on big codebases).
    if (opts.deepDiscovery && !(Array.isArray(inventory?.features) && inventory.features.length)) {
      opts.onProgress?.('Falling back to full repo-wide discovery…');
      const disc = await discoverFeatureInventoryFromSource(opts.feature, {
        workspaceId: opts.workspaceId,
        userId: opts.userId,
        repoPath: opts.repoPath,
      });
      inventory = disc.inventory;
    }
  }

  const features = (Array.isArray(inventory?.features) ? inventory.features : []).slice(0, maxFeatures);
  const results: FeatureCoverage[] = [];
  for (const f of features) {
    opts.onProgress?.(`Auditing coverage of "${f?.name || 'feature'}" sub-feature by sub-feature…`);
    try {
      results.push(await analyzeOneFeature(f, cases, { workspaceId: opts.workspaceId, userId: opts.userId }));
    } catch (err: any) {
      // HONEST DEGRADATION (never fake-green): a feature whose audit call FAILS is reported as
      // fully UNVERIFIED — every declared behaviour counts toward the total and NONE as covered,
      // so the rollup is 0%, not 0/0→100%. Each behaviour is materialised as uncovered with a
      // clear reason so the report shows the gap instead of silently swallowing the failure.
      const subs = Array.isArray(f?.subfeatures) ? f.subfeatures : [];
      const subFeatures: SubFeatureCoverage[] = subs.map((sf: any) => {
        const behaviors: BehaviorVerdict[] = [
          ...(sf?.businessRules || []).map((r: string) => ({ behavior: r, kind: 'business_rule' as const, covered: false, why: 'coverage audit failed for this feature — unverified' })),
          ...(sf?.userActions || []).map((a: string) => ({ behavior: a, kind: 'user_action' as const, covered: false, why: 'coverage audit failed for this feature — unverified' })),
        ];
        return {
          name: String(sf?.name || 'Subfeature'), description: String(sf?.description || ''), priority: String(sf?.priority || 'Medium'),
          behaviorsTotal: behaviors.length, behaviorsCovered: 0, coveragePercent: 0,
          status: 'uncovered' as const, behaviors, proposedCases: [],
        };
      });
      const behaviorsTotal = subFeatures.reduce((n, s) => n + s.behaviorsTotal, 0);
      results.push({
        name: String(f?.name || 'Feature'), surface: String(f?.surface || 'Application'),
        subFeatures, behaviorsTotal, behaviorsCovered: 0, coveragePercent: 0,
      });
    }
  }

  const subAll = results.flatMap((f) => f.subFeatures);
  const behaviorsTotal = results.reduce((n, f) => n + f.behaviorsTotal, 0);
  const behaviorsCovered = results.reduce((n, f) => n + f.behaviorsCovered, 0);
  return {
    query: opts.feature,
    appName: String(inventory?.appName || 'Application'),
    features: results,
    summary: {
      featuresAnalyzed: results.length,
      subFeaturesTotal: subAll.length,
      subFeaturesCovered: subAll.filter((s) => s.status === 'covered').length,
      subFeaturesPartial: subAll.filter((s) => s.status === 'partial').length,
      subFeaturesUncovered: subAll.filter((s) => s.status === 'uncovered').length,
      behaviorsTotal,
      behaviorsCovered,
      // HONESTY: when nothing was discovered/audited there is NO coverage to report — 0%, never
      // pct(0,0)=100%. A vacuous "100%" here would be a false-green (no behaviours == not "all
      // covered"). Discovery returning empty is a failure to assess, reported as such by the renderer.
      coveragePercent: behaviorsTotal === 0 ? 0 : pct(behaviorsCovered, behaviorsTotal),
    },
  };
}

/** Compact human-readable rendering of a coverage report (for logs / Agent Console). */
export function renderCoverageReport(report: FeatureCoverageReport): string {
  const lines: string[] = [];
  const s = report.summary;
  lines.push(`Coverage audit for "${report.query}" — app: ${report.appName}`);
  // Honest top line: if discovery found no sub-features/behaviors, say coverage could NOT be
  // assessed — do not print a misleading "100%".
  if (s.featuresAnalyzed === 0 || s.behaviorsTotal === 0) {
    lines.push('⚠ Coverage could NOT be assessed — no features/sub-features were discovered for this query (this is NOT a pass). Try a more specific feature name or check the repo connection.');
    return lines.join('\n');
  }
  lines.push(`Overall: ${s.behaviorsCovered}/${s.behaviorsTotal} behaviors covered (${s.coveragePercent}%) across ${s.subFeaturesTotal} sub-feature(s): ${s.subFeaturesCovered} covered, ${s.subFeaturesPartial} partial, ${s.subFeaturesUncovered} uncovered.`);
  for (const f of report.features) {
    lines.push(`\n■ FEATURE: ${f.name} — ${f.behaviorsCovered}/${f.behaviorsTotal} (${f.coveragePercent}%)`);
    for (const sf of f.subFeatures) {
      const mark = sf.status === 'covered' ? '✓' : sf.status === 'partial' ? '◐' : '✗';
      lines.push(`   ${mark} ${sf.name} — ${sf.behaviorsCovered}/${sf.behaviorsTotal} (${sf.coveragePercent}%)`);
      for (const b of sf.behaviors.filter((x) => !x.covered)) lines.push(`        MISSING [${b.kind}] ${b.behavior}`);
      for (const p of sf.proposedCases.slice(0, 4)) lines.push(`        + propose: ${p.title}`);
    }
  }
  return lines.join('\n');
}
