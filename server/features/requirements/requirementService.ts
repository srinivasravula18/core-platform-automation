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
import { Cases, Requirements, RequirementLinks, isPgEnabled } from '../../db/repository';
import { persistDataInBackground, addActivity } from '../../shared/storage';
import { normalizeCaseSteps, normalizeCaseTags } from '../../shared/testCases';
import { pushInboxItem } from '../inbox/routes';
import { gitGrep, readRepoFile, GIT_AGENT_TARGET_REPO } from '../git-agent/gitAgentService';

/* ---------- schemas ---------- */

const featureAnalystSchema = z.object({
  title: z.string(),
  description: z.string(),
  businessRules: z.array(z.string()).default([]),
  dataPopulationNotes: z.string().default(''),
  adminBehavior: z.string().default(''),
  keystoneBehavior: z.string().default(''),
  metadataRefs: z.array(z.object({ object: z.string(), note: z.string().default('') })).default([]),
  sourceFiles: z.array(z.object({ path: z.string(), why: z.string().default('') })).default([]),
  candidateScenarios: z.array(z.object({
    title: z.string(),
    priority: z.string().default('Medium'),
    rationale: z.string().default(''),
    steps: z.array(z.object({ action: z.string(), expected: z.string() })).default([]),
  })).default([]),
});

const reconcileSchema = z.object({
  coverage: z.object({
    sufficient: z.boolean(),
    coveredBy: z.array(z.object({ id: z.string(), title: z.string().default(''), reason: z.string().default('') })).default([]),
    gaps: z.array(z.string()).default([]),
    reasoning: z.string().default(''),
  }),
  proposedCases: z.array(z.object({
    title: z.string(),
    type: z.string().default('Manual'),
    priority: z.string().default('Medium'),
    tags: z.array(z.string()).default([]),
    rationale: z.string().default(''),
    steps: z.array(z.object({ action: z.string(), expected: z.string() })).default([]),
  })).default([]),
});

export type FeatureUnderstanding = z.infer<typeof featureAnalystSchema>;
export type Reconciliation = z.infer<typeof reconcileSchema>;

/* ---------- keyword derivation ---------- */

const STOP = new Set([
  'test', 'tests', 'testing', 'feature', 'features', 'section', 'sections', 'module', 'modules',
  'the', 'for', 'do', 'and', 'requirement', 'requirements', 'based', 'please', 'can', 'you',
  'flow', 'flows', 'functionality', 'coverage', 'check', 'verify', 'validate', 'about', 'what',
  'happens', 'want', 'need', 'app', 'application', 'how', 'does', 'work', 'works', 'this',
]);

// Map user vocabulary onto the words that actually appear in the core-platform source.
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

/* ---------- source gathering ---------- */

function gatherSourceExcerpts(keywords: string[]): { files: Array<{ path: string; area: string; surface: string }>; excerpts: string } {
  const hits = gitGrep(keywords);
  // Take a balanced sample across surfaces so the analyst sees Service, Admin,
  // Keystone, and metadata rather than 12 files from one directory.
  const bySurface: Record<string, Array<{ path: string; area: string; surface: string }>> = {};
  for (const h of hits) {
    (bySurface[h.surface] ||= []).push(h);
  }
  const picked: Array<{ path: string; area: string; surface: string }> = [];
  for (const surface of Object.keys(bySurface)) {
    picked.push(...bySurface[surface].slice(0, 4));
  }
  const limited = picked.slice(0, 12);

  const parts: string[] = [];
  for (const f of limited) {
    let content = '';
    try {
      content = readRepoFile(f.path, 4000);
    } catch {
      content = '';
    }
    if (content.trim()) parts.push(`FILE: ${f.path}  [area: ${f.area}]\n${content}`);
  }
  return { files: limited, excerpts: parts.join('\n\n---\n\n') };
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
  opts: { workspaceId?: string; userId?: string } = {},
): Promise<DiscoverResult> {
  const workspaceId = opts.workspaceId || 'default';
  const cleanQuery = String(query || '').trim();
  if (!cleanQuery) throw new Error('A feature or section to test is required.');

  const keywords = deriveKeywords(cleanQuery);
  const { files, excerpts } = gatherSourceExcerpts(keywords);

  // 1) Feature analyst: produce a grounded requirement understanding from the source.
  const analyst = await getOrchestrator('featureAnalyst', opts);
  const analystRes = await analyst.generateObject<FeatureUnderstanding>({
    prompt: `Feature/section to analyze (user query): "${cleanQuery}"

Search keywords used: ${keywords.join(', ')}

Code excerpts from the target application's git repository (path + area). Ground your understanding ONLY in these:
${excerpts || '(no matching source found — say so in the description and keep businessRules minimal rather than inventing them)'}

Produce the requirement understanding as strict JSON matching the schema:
- title: a concise requirement title for this feature.
- description: 1-3 sentences on what the feature does and why it matters.
- businessRules: the concrete, testable rules the code enforces.
- dataPopulationNotes: what the Service module populates in the background as preconditions for this feature (if shown in the excerpts).
- adminBehavior vs keystoneBehavior: configuration/management (Admin) vs end-user behavior (Keystone / apps/shockwave).
- metadataRefs: metadata objects/fields that are the source of truth for this feature.
- sourceFiles: the specific files (real paths from the excerpts) that justify your understanding, each with a one-line reason.
- candidateScenarios: a first cut of test scenarios with concrete steps.`,
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

  // 2) Reconcile against existing cases — reuse the analysisService coverage pattern.
  const existingCases = (await Cases.list()).slice(0, 100).map((c: any) => ({
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
