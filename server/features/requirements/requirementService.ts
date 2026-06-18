/**
 * Requirement-based testing — discovery service.
 *
 * Given a feature/section query, the agent team searches the target application's
 * git source (D:\core-platform) to understand the feature: business logic in the
 * Service module, background data population, what Admin vs Keystone do, and the
 * metadata source of truth. It then reconciles that understanding against the
 * EXISTING test cases (so we don't duplicate) and proposes NEW cases for the gaps.
 * The result is a first-class Requirement with traceability links to both the
 * existing covering cases and the newly generated ones.
 *
 * This reuses the proven "reconcile a source of truth against existing coverage,
 * propose only the gaps" pattern from ../git-agent/analysisService.ts.
 */

import { z } from 'zod';
import { getOrchestrator } from '../../ai/orchestrator';
import { deepParallelResearch, relevantSourcePaths } from '../../ai/research/deepResearch';
import { Cases, Requirements, RequirementLinks, isPgEnabled } from '../../db/repository';
import { persistDataInBackground, addActivity } from '../../shared/storage';
import { normalizeCaseSteps, normalizeCaseTags } from '../../shared/testCases';
import { pushInboxItem } from '../inbox/routes';
import { gitGrep, readRepoFile, GIT_AGENT_TARGET_REPO } from '../git-agent/gitAgentService';

/* ---------- schemas ---------- */

const featureAnalystSchema = z.object({
  title: z.string().default('Feature under test'),
  description: z.string().default(''),
  businessRules: z.array(z.string()).default([]),
  dataPopulationNotes: z.string().default(''),
  adminBehavior: z.string().default(''),
  keystoneBehavior: z.string().default(''),
  metadataRefs: z.array(z.object({ object: z.string(), note: z.string().default('') })).default([]),
  sourceFiles: z.array(z.object({ path: z.string(), why: z.string().default('') })).default([]),
  candidateScenarios: z.array(z.object({
    title: z.string().default('Scenario'),
    priority: z.string().default('Medium'),
    rationale: z.string().default(''),
    steps: z.array(z.object({ action: z.string().default(''), expected: z.string().default('') })).default([]),
  })).default([]),
});

const featureInventorySchema = z.object({
  appName: z.string().default('Application'),
  summary: z.string().default(''),
  features: z.array(z.object({
    name: z.string().default('Feature'),
    surface: z.string().default('Application'),
    description: z.string().default(''),
    sourceFiles: z.array(z.object({ path: z.string(), why: z.string().default('') })).default([]),
    subfeatures: z.array(z.object({
      name: z.string().default('Subfeature'),
      description: z.string().default(''),
      businessRules: z.array(z.string()).default([]),
      userActions: z.array(z.string()).default([]),
      testIdeas: z.array(z.string()).default([]),
      priority: z.string().default('Medium'),
      tags: z.array(z.string()).default([]),
    })).default([]),
  })).default([]),
  e2eFlows: z.array(z.object({
    name: z.string().default('End-to-end flow'),
    description: z.string().default(''),
    entryPoint: z.string().default(''),
    coveredFeatures: z.array(z.string()).default([]),
    userJourney: z.array(z.string()).default([]),
    businessRules: z.array(z.string()).default([]),
    sourceFiles: z.array(z.object({ path: z.string(), why: z.string().default('') })).default([]),
    priority: z.string().default('High'),
    tags: z.array(z.string()).default([]),
  })).default([]),
});

const e2eFlowSchema = z.object({
  e2eFlows: featureInventorySchema.shape.e2eFlows,
});

const reconcileSchema = z.object({
  // Tolerant: the model (esp. codex) sometimes omits coverage fields. Defaulting them
  // keeps the run alive instead of failing the whole "Write cases" stage on a missing
  // boolean. sufficient defaults false → we then propose gap cases, which is the safe path.
  coverage: z.object({
    sufficient: z.boolean().default(false),
    coveredBy: z.array(z.object({ id: z.string(), title: z.string().default(''), reason: z.string().default('') })).default([]),
    gaps: z.array(z.string()).default([]),
    reasoning: z.string().default(''),
  }).default({ sufficient: false, coveredBy: [], gaps: [], reasoning: '' }),
  proposedCases: z.array(z.object({
    title: z.string().default('Proposed test case'),
    type: z.string().default('Manual'),
    priority: z.string().default('Medium'),
    tags: z.array(z.string()).default([]),
    rationale: z.string().default(''),
    steps: z.array(z.object({ action: z.string().default(''), expected: z.string().default('') })).default([]),
  })).default([]),
});

export type FeatureUnderstanding = z.infer<typeof featureAnalystSchema>;
export type FeatureInventory = z.infer<typeof featureInventorySchema>;
export type Reconciliation = z.infer<typeof reconcileSchema>;

/* ---------- keyword derivation ---------- */

const STOP = new Set([
  'test', 'tests', 'testing', 'feature', 'features', 'section', 'sections', 'module', 'modules',
  'the', 'for', 'do', 'and', 'requirement', 'requirements', 'based', 'please', 'can', 'you',
  'flow', 'flows', 'functionality', 'coverage', 'check', 'verify', 'validate', 'about', 'what',
  'happens', 'want', 'need', 'app', 'application', 'how', 'does', 'work', 'works', 'this',
]);

// Generic QA/software vocabulary expansion (NOT app-specific): map a user's word onto
// common synonyms so the code search casts a wider net for ANY application's source.
const SYNONYMS: Record<string, string[]> = {
  login: ['auth', 'signin', 'session'],
  signin: ['auth', 'login', 'session'],
  auth: ['login', 'permission', 'access'],
  permission: ['access', 'grant', 'role'],
  permissions: ['access', 'grant', 'role'],
  access: ['permission', 'grant', 'role'],
  list: ['list-view'],
  listview: ['list-view'],
  search: ['search'],
  export: ['export'],
  import: ['data-import'],
  record: ['records'],
  records: ['record'],
  layout: ['layouts', 'form'],
  layouts: ['layout'],
  trigger: ['triggers'],
  triggers: ['trigger'],
  validation: ['validations'],
  validations: ['validation'],
  flow: ['flows'],
  flows: ['flow'],
  field: ['fields'],
  fields: ['field'],
  metadata: ['schema'],
  schedule: ['scheduler', 'cron'],
  scheduler: ['schedule', 'cron'],
  audit: ['audit-log'],
  recycle: ['recycle-bin'],
  button: ['buttons'],
  buttons: ['button'],
};

const FULL_APP_DISCOVERY_TERMS = [
  'route', 'routes', 'router', 'navigation', 'menu', 'page', 'pages',
  'screen', 'screens', 'feature', 'features', 'workflow', 'workflows',
  'form', 'forms', 'table', 'tables', 'list', 'grid', 'create', 'edit',
  'update', 'delete', 'bulk', 'search', 'filter', 'sort', 'export',
  'import', 'settings', 'dashboard', 'auth', 'login', 'permission',
  'validation', 'empty state', 'error state',
];

function isBroadDiscoveryQuery(query: string): boolean {
  const text = String(query || '').toLowerCase();
  return /\b(all|every|entire|whole|across|application|app|features?|sub[-\s]?features?|modules?|screens?|pages?|workflows?|journeys?|end\s*to\s*end|e2e|coverage|test\s*areas?|each\s+feature)\b/.test(text);
}

function deriveKeywords(query: string): string[] {
  const tokens = (String(query || '').toLowerCase().match(/[a-z0-9-]+/g) || ([] as string[])).filter((t) => t.length >= 3);
  const meaningful = tokens.filter((t) => !STOP.has(t));
  const base = meaningful.length ? meaningful : tokens; // fall back to all tokens if the query was all stopwords
  const set = new Set<string>();
  for (const t of base) {
    set.add(t);
    for (const s of SYNONYMS[t] || []) set.add(s);
  }
  return Array.from(set).slice(0, 12);
}

function deriveInventoryKeywords(query: string): string[] {
  const set = new Set(deriveKeywords(query));
  if (isBroadDiscoveryQuery(query) || set.size === 0) {
    FULL_APP_DISCOVERY_TERMS.forEach((term) => set.add(term));
  }
  return Array.from(set).slice(0, 42);
}

/* ---------- source gathering ---------- */

// Harvest distinct identifiers / route+label strings from a file so a second grep round can
// "follow references" into the modules it depends on — broad coverage via fast native search.
function harvestReferenceTerms(content: string): string[] {
  const out = new Set<string>();
  for (const m of content.matchAll(/\b([A-Za-z][A-Za-z0-9_]{4,28})\b/g)) {
    const w = m[1];
    if (/[a-z][A-Z]/.test(w) || /^[A-Z][a-z]+[A-Z]/.test(w)) out.add(w);
  }
  for (const m of content.matchAll(/['"`](\/[A-Za-z][\w\/-]{2,40}|[A-Z][A-Za-z ]{2,30})['"`]/g)) {
    out.add(m[1].trim());
  }
  return Array.from(out);
}

// DEEP, deterministic source gathering: a broad grep, then a SECOND round that follows the
// identifiers used by the strongest files (so referenced modules are pulled in), then read
// the RELEVANT files (count is dynamic — scales to how much relevant code exists, no fixed N).
// The searching is fast native grep; the one model call is the analyst.
function gatherSourceExcerpts(
  keywords: string[],
  repoPath?: string,
  opts: { maxFiles?: number; maxBytesPerFile?: number } = {},
): { files: Array<{ path: string; area: string; surface: string }>; excerpts: string } {
  const hits = gitGrep(keywords, undefined, opts.maxFiles, repoPath);
  const byPath = new Map(hits.map((h) => [h.path, h]));

  // Round 2 — follow references found in the strongest (most relevant) files.
  const seed = relevantSourcePaths(hits.map((h) => h.path), keywords);
  const refTerms = new Set<string>();
  for (const p of seed) {
    try {
      for (const t of harvestReferenceTerms(readRepoFile(p, 4000, repoPath))) {
        if (!keywords.includes(t)) refTerms.add(t);
      }
    } catch { /* best-effort */ }
  }
  if (refTerms.size) {
    try {
      for (const h of gitGrep(Array.from(refTerms), undefined, opts.maxFiles, repoPath)) {
        if (!byPath.has(h.path)) byPath.set(h.path, h);
      }
    } catch { /* best-effort */ }
  }

  // Read the RELEVANT files (dynamic count) across the merged candidate pool.
  const allTerms = Array.from(new Set([...keywords, ...refTerms]));
  const chosen = relevantSourcePaths(Array.from(byPath.keys()), allTerms);
  const files = chosen.map((p) => byPath.get(p)).filter(Boolean) as Array<{ path: string; area: string; surface: string }>;
  const parts: string[] = [];
  for (const f of files) {
    let content = '';
    try {
      content = readRepoFile(f.path, opts.maxBytesPerFile || 4500, repoPath);
    } catch {
      content = '';
    }
    if (content.trim()) parts.push(`FILE: ${f.path}  [area: ${f.area}]\n${content}`);
  }
  return { files, excerpts: parts.join('\n\n---\n\n') };
}

function summarizeFeatureInventoryForPrompt(inventory: FeatureInventory): string {
  const lines: string[] = [];
  if (inventory.appName) lines.push(`Application: ${inventory.appName}`);
  if (inventory.summary) lines.push(`Summary: ${inventory.summary}`);
  for (const feature of (inventory.features || []).slice(0, 30)) {
    lines.push(`Feature: ${feature.name} [${feature.surface || 'Application'}] - ${feature.description || ''}`.trim());
    for (const sub of (feature.subfeatures || []).slice(0, 12)) {
      lines.push(`  Subfeature: ${sub.name} | priority=${sub.priority || 'Medium'} | actions=${(sub.userActions || []).join('; ')} | rules=${(sub.businessRules || []).join('; ')} | testIdeas=${(sub.testIdeas || []).join('; ')}`);
    }
  }
  if (inventory.e2eFlows?.length) {
    lines.push('End-to-end flows:');
    for (const flow of inventory.e2eFlows.slice(0, 20)) {
      lines.push(`  E2E: ${flow.name} | priority=${flow.priority || 'High'} | features=${(flow.coveredFeatures || []).join(' > ')} | journey=${(flow.userJourney || []).join(' -> ')}`);
    }
  }
  return lines.join('\n').slice(0, 12000);
}

/* ---------- reusable feature understanding (git-agent deep read) ---------- */

/**
 * Read the target application's REAL source (git agent over D:\core-platform) and
 * produce a grounded, structured understanding of the requested feature: the
 * business rules the code enforces, Admin vs Keystone/Shockwave behavior, the
 * metadata source of truth, and a first cut of scenarios scaled to what the code
 * actually does. This is the depth-of-understanding step the Agent Console uses to
 * drive how many cases to write, the steps, and the scripts — instead of a fixed
 * template. Pure analysis: no requirement/inbox side effects (that stays in
 * discoverRequirement, which now reuses this).
 */
export async function analyzeFeatureFromSource(
  query: string,
  opts: { workspaceId?: string; userId?: string; repoPath?: string } = {},
): Promise<{ understanding: FeatureUnderstanding; files: Array<{ path: string; area: string; surface: string }>; keywords: string[] }> {
  const cleanQuery = String(query || '').trim();
  const keywords = deriveKeywords(cleanQuery);
  // Always gather a deterministic deep sample (reliable grounding + the file list we return).
  const { files, excerpts } = gatherSourceExcerpts(keywords, opts.repoPath);

  // CLAUDE-CODE-STYLE deep parallel research: decompose the feature into angles and
  // investigate them concurrently across the real source before structuring — so cases and
  // scripts are grounded in genuinely deep coverage. Falls back to the deterministic sample.
  const repoPath = opts.repoPath;
  let researchNotes = '';
  try {
    researchNotes = await deepParallelResearch({
      question: cleanQuery,
      io: {
        // Dynamic, relevance-filtered file set (count scales to the request — no fixed N).
        search: async (terms) => relevantSourcePaths(gitGrep(terms, undefined, undefined, repoPath).map((h) => h.path), terms),
        read: async (p, b) => readRepoFile(p, b, repoPath),
      },
      orchestratorAgent: 'featureAnalyst',
      workspaceId: opts.workspaceId,
      userId: opts.userId,
    });
  } catch {
    researchNotes = '';
  }
  const groundingBlock = researchNotes
    ? `DEEP PARALLEL RESEARCH NOTES — compiled by reading the application's REAL source across many areas of the codebase concurrently. PRIMARY grounding; treat as authoritative:\n${researchNotes}\n\nSupporting raw code (path + area):\n${excerpts || '(none)'}`
    : `Code read from the target application's real source across the codebase (path + area). Ground your understanding ONLY in these:\n${excerpts || '(no matching source found — say so in the description and keep businessRules minimal rather than inventing them)'}`;

  const analyst = await getOrchestrator('featureAnalyst', opts);
  const analystRes = await analyst.generateObject<FeatureUnderstanding>({
    prompt: `Feature/section to analyze (user query): "${cleanQuery}"

Search keywords used: ${keywords.join(', ')}

${groundingBlock}

INFER the application's architecture from the research notes and excerpts above — do NOT assume any specific product, framework, or surface names. Let the code tell you. Use ONLY behaviour the research actually establishes; never invent meta-concepts (CI/seeding/regression scaffolding) that aren't real user features. Produce the requirement understanding as strict JSON matching the schema:
- title: a concise requirement title for this feature.
- description: 1-3 sentences on what the feature does and why it matters.
- businessRules: the concrete, testable rules the code enforces.
- dataPopulationNotes: what the backend populates/seeds/syncs in the background as preconditions for this feature (only if the research shows it).
- adminBehavior vs keystoneBehavior: if the app has distinct surfaces, put the configuration/admin-surface behavior in adminBehavior and the end-user-surface behavior in keystoneBehavior; if it has only one surface, describe it in whichever fits and leave the other empty. Do not invent a surface the code does not show.
- metadataRefs: if the app is metadata-/config-driven, the objects/fields that are the source of truth for this feature; otherwise leave empty.
- sourceFiles: the specific files (real paths from the research/excerpts) that justify your understanding, each with a one-line reason.
- candidateScenarios: cover the feature in proportion to its real complexity — every distinct business rule, branch, role/permission difference, and edge/negative case visible in the code should get a scenario. Each scenario's steps must be DETAILED and concrete: each step a specific user/system action with the REAL on-screen label/field/button and a matching observable expected result (not vague "verify it works"). Do not pad with trivial duplicates; do not under-cover a complex feature.`,
    schema: featureAnalystSchema,
    userMessage: cleanQuery,
  });

  if ((analystRes as any).shortCircuit) {
    throw new Error(String((analystRes as any).shortCircuit));
  }
  const understanding: FeatureUnderstanding = (analystRes as any).object || {
    title: cleanQuery,
    description: '',
    businessRules: [],
    dataPopulationNotes: '',
    adminBehavior: '',
    keystoneBehavior: '',
    metadataRefs: [],
    sourceFiles: files.map((f) => ({ path: f.path, why: f.area })),
    candidateScenarios: [],
  };
  return { understanding, files, keywords };
}

/**
 * Build a source-grounded feature map for broad QA requests. This is deliberately
 * separate from analyzeFeatureFromSource(): the analyst above explains one
 * requested feature, while this inventory decomposes an application into testable
 * feature/subfeature units plus end-to-end user journeys.
 */
export async function discoverFeatureInventoryFromSource(
  query: string,
  opts: { workspaceId?: string; userId?: string; repoPath?: string } = {},
): Promise<{ inventory: FeatureInventory; files: Array<{ path: string; area: string; surface: string }>; keywords: string[] }> {
  const cleanQuery = String(query || '').trim() || 'Discover all testable features, subfeatures, and end-to-end flows in this application.';
  const keywords = deriveInventoryKeywords(cleanQuery);
  const repoPath = opts.repoPath;
  const { files, excerpts } = gatherSourceExcerpts(keywords, repoPath, { maxFiles: 80, maxBytesPerFile: 2800 });

  let researchNotes = '';
  try {
    researchNotes = await deepParallelResearch({
      question: `${cleanQuery}

Discover feature-level, subfeature-level, and end-to-end QA coverage across the selected application. Split the app by user-visible capabilities and backend-enforced rules. Do not stop at top-level pages.`,
      io: {
        search: async (terms) => {
          const merged = Array.from(new Set([...keywords, ...(terms || [])])).slice(0, 48);
          return relevantSourcePaths(gitGrep(merged, undefined, 90, repoPath).map((h) => h.path), merged);
        },
        read: async (p, b) => readRepoFile(p, b, repoPath),
      },
      orchestratorAgent: 'featureDiscoveryAgent',
      workspaceId: opts.workspaceId,
      userId: opts.userId,
      maxFacets: 8,
      bytesPerFile: 3000,
    });
  } catch {
    researchNotes = '';
  }

  const groundingBlock = researchNotes
    ? `PARALLEL SOURCE RESEARCH NOTES (primary grounding):\n${researchNotes}\n\nSupporting raw source excerpts:\n${excerpts || '(none)'}`
    : `Raw source excerpts from broad feature discovery searches:\n${excerpts || '(no matching source found; return empty feature arrays rather than inventing)'}`;

  const featureAgent = await getOrchestrator('featureDiscoveryAgent', opts);
  const featureRes = await featureAgent.generateObject<FeatureInventory>({
    prompt: `You are FeatureDiscoveryAgent. Build a granular QA feature inventory from the target application's REAL source.

User request:
${cleanQuery}

Search keywords:
${keywords.join(', ')}

${groundingBlock}

Return strict JSON matching the schema.

Rules:
- Do NOT return only top-level pages/modules. Decompose into feature -> subfeatures.
- A subfeature is testable as its own case: a user action, validation, permission rule, data state, table behavior, or branch.
- Capture backend-enforced business rules and frontend-visible actions under the matching subfeature.
- Prefer one subfeature per user-visible capability or code-enforced branch: create/edit/delete, filters/search, import/export, validation failures, permissions, empty/error states, async/background behavior, etc.
- Use sourceFiles with real repo-relative paths from the evidence only.
- Keep unrelated framework plumbing out unless it changes user-visible or API behavior.
- Leave e2eFlows empty in this response; E2EFlowAgent fills them next.`,
    schema: featureInventorySchema,
    userMessage: cleanQuery,
    hasHistory: true,
  });
  if ((featureRes as any).shortCircuit) throw new Error(String((featureRes as any).shortCircuit));

  const inventory: FeatureInventory = (featureRes as any).object || {
    appName: 'Application',
    summary: '',
    features: [],
    e2eFlows: [],
  };

  const e2eAgent = await getOrchestrator('e2eFlowAgent', opts);
  const e2eRes = await e2eAgent.generateObject<z.infer<typeof e2eFlowSchema>>({
    prompt: `You are E2EFlowAgent. Identify end-to-end user journeys across the application from source-grounded evidence and the feature inventory.

User request:
${cleanQuery}

FEATURE INVENTORY FROM FEATUREDISCOVERYAGENT:
${summarizeFeatureInventoryForPrompt(inventory)}

SOURCE GROUNDING:
${groundingBlock}

Return strict JSON matching the schema.

Rules:
- An E2E flow must cross multiple features, screens, APIs, roles, or persisted states.
- Do not duplicate single subfeature cases; those are handled by FeatureDiscoveryAgent.
- Each userJourney step must be concrete and ordered enough for a test case.
- coveredFeatures must reference feature/subfeature names from the inventory where possible.
- Include business rules and sourceFiles that justify the flow.
- If the evidence does not establish any cross-feature journey, return an empty e2eFlows array.`,
    schema: e2eFlowSchema,
    userMessage: cleanQuery,
    hasHistory: true,
  });
  if ((e2eRes as any).shortCircuit) throw new Error(String((e2eRes as any).shortCircuit));

  inventory.e2eFlows = (e2eRes as any).object?.e2eFlows || [];
  return { inventory, files, keywords };
}

/**
 * Given a feature understanding and the EXISTING cases that look related, ask the
 * QA model which behaviors are still uncovered and propose ONLY those gap cases
 * (with concrete steps). Used by the Agent Console "Add only the gaps" reuse action
 * so we extend coverage instead of regenerating everything from scratch.
 */
export async function proposeGapCases(
  understanding: FeatureUnderstanding | null,
  existingCases: Array<{ id: string; title: string; tags?: string[]; type?: string; priority?: string; stepCount?: number }>,
  opts: { workspaceId?: string; userId?: string } = {},
): Promise<Reconciliation['proposedCases']> {
  const reconciler = await getOrchestrator('caseWriter', opts);
  const res = await reconciler.generateObject<Reconciliation>({
    prompt: `You are a senior QA engineer EXTENDING coverage for a feature. Propose ONLY the test cases the existing ones do NOT already cover — never duplicate existing coverage.

REQUIREMENT UNDERSTANDING (from the application's real source):
${JSON.stringify(understanding || {}, null, 2)}

EXISTING related test cases already in the QA repository (do NOT re-propose these):
${JSON.stringify(existingCases)}

Return strict JSON matching the schema. In coverage.gaps list the behaviors the existing cases miss; in proposedCases add only NEW cases (with concrete, executable steps and expected results) that close those gaps. If the existing cases already cover the feature, return an empty proposedCases array.`,
    schema: reconcileSchema,
    userMessage: 'propose only the gap cases to extend coverage',
  });
  if ((res as any).shortCircuit) throw new Error(String((res as any).shortCircuit));
  return ((res as any).object?.proposedCases) || [];
}

/* ---------- helpers ---------- */

function genId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
}

function deriveCoverageStatus(sufficient: boolean, existingCount: number, generatedCount: number): string {
  if (sufficient && existingCount > 0) return 'covered';
  if (existingCount > 0) return 'partial';
  if (generatedCount > 0) return 'gaps-proposed';
  return 'none';
}

export interface DiscoverResult {
  requirement: any;
  understanding: FeatureUnderstanding;
  coverage: Reconciliation['coverage'];
  existingLinks: Array<{ caseId: string; title: string; reason: string }>;
  generatedCases: Array<{ id: string; title: string }>;
  inboxItemId?: string;
  searchedFiles: Array<{ path: string; area: string; surface: string }>;
  repoPath: string;
}

/* ---------- main entry ---------- */

export async function discoverRequirement(
  query: string,
  opts: { workspaceId?: string; userId?: string; role?: string; repoPath?: string } = {},
): Promise<DiscoverResult> {
  const workspaceId = opts.workspaceId || 'default';
  const ownerId = opts.userId || '';
  const cleanQuery = String(query || '').trim();
  if (!cleanQuery) throw new Error('A feature or section to test is required.');

  // 1) Feature analyst: produce a grounded requirement understanding from the source.
  const { understanding, files } = await analyzeFeatureFromSource(cleanQuery, opts);

  // 2) Reconcile against existing cases — only the discovering user's own cases when
  // they're a tester, so isolation holds (admins reconcile against everything).
  const allCases = await Cases.list();
  const scopedCases = ownerId
    ? allCases.filter((c: any) => (c.ownerId || '') === ownerId)
    : allCases;
  const existingCases = scopedCases.slice(0, 100).map((c: any) => ({
    id: c.id,
    title: c.title,
    tags: c.tags || [],
    type: c.type,
    priority: c.priority,
    stepCount: (c.steps || []).length,
  }));

  const reconciler = await getOrchestrator('caseWriter', opts);
  const reconcileRes = await reconciler.generateObject<Reconciliation>({
    prompt: `You are a senior QA engineer deciding what tests a requirement needs. Reconcile the requirement understanding against the EXISTING test cases before proposing anything.

REQUIREMENT UNDERSTANDING:
${JSON.stringify(understanding, null, 2)}

EXISTING test cases already in the QA repository:
${JSON.stringify(existingCases)}

Do the following and return strict JSON matching the schema:
1) In coverage.coveredBy, list the EXISTING case ids (use ids that appear verbatim above) that already test this requirement, each with a short reason. Set coverage.sufficient = true ONLY if the existing cases genuinely cover the requirement's business rules.
2) In coverage.gaps, list the specific behaviors the existing cases do NOT cover.
3) If coverage is NOT sufficient, in proposedCases propose the MINIMUM set of new test cases (with concrete, executable steps and expected results) to close the gaps. Prefer the requirement's candidateScenarios where they fit. Do NOT duplicate existing coverage. If coverage IS sufficient, leave proposedCases empty.`,
    schema: reconcileSchema,
    userMessage: 'reconcile requirement coverage against existing cases',
  });

  if ((reconcileRes as any).shortCircuit) {
    throw new Error(String((reconcileRes as any).shortCircuit));
  }
  const reconciliation: Reconciliation = (reconcileRes as any).object || {
    coverage: { sufficient: false, coveredBy: [], gaps: [], reasoning: '' },
    proposedCases: [],
  };

  // 3) Persist the requirement.
  const requirementId = genId('REQ');
  const existingIds = new Set(existingCases.map((c) => c.id));
  const validCovered = (reconciliation.coverage.coveredBy || []).filter((cb) => existingIds.has(cb.id));

  // Create the gap cases (pending review) and remember them for linking.
  const generatedCases: Array<{ id: string; title: string }> = [];
  for (const pc of reconciliation.proposedCases || []) {
    const caseId = genId('TC-REQ');
    const tags = normalizeCaseTags(pc.tags && pc.tags.length ? [...pc.tags, '@requirement'] : ['@requirement']);
    await Cases.upsert({
      id: caseId,
      title: pc.title,
      description: pc.rationale || '',
      steps: normalizeCaseSteps(pc.steps),
      status: 'Draft',
      tags,
      type: pc.type || 'Manual',
      priority: pc.priority || 'Medium',
      sources: [requirementId],
      createdBy: 'Feature Analyst',
      proposedBy: 'Feature Analyst',
      approvalState: 'pending_review',
      ownerId,
    });
    generatedCases.push({ id: caseId, title: pc.title });
  }

  const coverageStatus = deriveCoverageStatus(
    reconciliation.coverage.sufficient,
    validCovered.length,
    generatedCases.length,
  );

  const requirement = await Requirements.upsert({
    id: requirementId,
    title: understanding.title || cleanQuery,
    description: understanding.description || '',
    featureQuery: cleanQuery,
    businessRules: understanding.businessRules || [],
    dataPopulationNotes: understanding.dataPopulationNotes || '',
    adminBehavior: understanding.adminBehavior || '',
    keystoneBehavior: understanding.keystoneBehavior || '',
    metadataRefs: understanding.metadataRefs || [],
    sourceFiles: (understanding.sourceFiles && understanding.sourceFiles.length
      ? understanding.sourceFiles
      : files.map((f) => ({ path: f.path, why: f.area }))),
    coverageStatus,
    status: 'Draft',
    approvalState: 'proposed',
    proposedBy: 'Feature Analyst',
    ownerId,
  });

  // 4) Link existing covering cases and the generated gap cases.
  const existingLinks: Array<{ caseId: string; title: string; reason: string }> = [];
  for (const cb of validCovered) {
    await RequirementLinks.upsert({ requirementId, caseId: cb.id, linkType: 'existing', note: cb.reason || '' });
    existingLinks.push({ caseId: cb.id, title: cb.title, reason: cb.reason });
  }
  for (const gc of generatedCases) {
    await RequirementLinks.upsert({ requirementId, caseId: gc.id, linkType: 'generated', note: 'Generated to close a coverage gap.' });
  }

  // 5) Queue the generated cases for human approval in the AI Inbox.
  let inboxItemId: string | undefined;
  if (generatedCases.length) {
    const inbox = await pushInboxItem({
      workspaceId,
      source: 'case',
      sourceId: generatedCases[0].id,
      title: `Approve ${generatedCases.length} case(s) for requirement: ${requirement.title}`,
      summary: `Generated from requirement-based analysis of "${cleanQuery}" to cover gaps not tested by existing cases.`,
      confidence: 78,
      proposedBy: 'Feature Analyst',
      payload: { requirementId, caseIds: generatedCases.map((c) => c.id) },
      links: [
        { label: 'Open Traceability', href: '/traceability' },
        { label: 'Open Requirements', href: '/requirements' },
      ],
    });
    inboxItemId = inbox.id;
  }

  if (!isPgEnabled()) persistDataInBackground('requirement discovery');
  addActivity(`Feature Analyst discovered requirement "${requirement.title}" with ${existingLinks.length} existing and ${generatedCases.length} new case(s).`);

  return {
    requirement,
    understanding,
    coverage: reconciliation.coverage,
    existingLinks,
    generatedCases,
    inboxItemId,
    searchedFiles: files,
    repoPath: GIT_AGENT_TARGET_REPO,
  };
}

/**
 * Resolve a requirement with its linked cases (existing + generated) for the
 * Traceability and Requirements pages.
 */
export async function getRequirementWithCases(id: string): Promise<any | null> {
  const requirement = await Requirements.get(id);
  if (!requirement) return null;
  const links = await RequirementLinks.list(id);
  const allCases = await Cases.list();
  const byId = new Map(allCases.map((c: any) => [c.id, c]));
  const linkedCases = links.map((l: any) => ({
    linkType: l.linkType,
    note: l.note,
    case: byId.get(l.caseId) || { id: l.caseId, title: '(deleted case)', missing: true },
  }));
  return { ...requirement, links, linkedCases };
}
