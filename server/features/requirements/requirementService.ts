/**
 * Requirement-based testing — discovery service.
 *
 * Given a feature/section query, the agent team searches the target application's
 * git source to understand the feature: business logic in the
 * Service module, background data population, what each surface does, and the
 * metadata source of truth. It then reconciles that understanding against the
 * EXISTING test cases (so we don't duplicate) and proposes NEW cases for the gaps.
 * The result is a first-class Requirement with traceability links to both the
 * existing covering cases and the newly generated ones.
 *
 * This reuses the proven "reconcile a source of truth against existing coverage,
 * propose only the gaps" pattern from ../git-agent/analysisService.ts.
 */

import { readFileSync, existsSync } from 'fs';
import { z } from 'zod';
import { getOrchestrator } from '../../ai/orchestrator';
import { deepParallelResearch, relevantSourcePaths, facetCeiling } from '../../ai/research/deepResearch';
import { expandByReferences } from '../../ai/exploration/referenceGraph';
import { Cases, Requirements, RequirementLinks, isPgEnabled } from '../../db/repository';
import { persistDataInBackground, addActivity } from '../../shared/storage';
import { normalizeCaseSteps, normalizeCaseTags } from '../../shared/testCases';
import { pushInboxItem } from '../inbox/routes';
import { gitGrep, listRepoSourceFiles, readRepoFile, resolveTargetRepo } from '../git-agent/gitAgentService';
import { analyzeApiAndMetadataFromSource, type ApiAnalysis } from './apiAnalystService';
import { fetchCorePlatformObjectCatalog } from '../../ai/tools/corePlatformData';
import { getApp } from '../projects/projectService';
import { resolveCredentials } from '../credentials/credentialsService';
import { extractSelectorMap, type SelectorMap } from '../agent/selectorMap';

/* ---------- schemas ---------- */

const textField = (fallback = '') =>
  z.preprocess((value) => {
    if (value == null) return fallback;
    if (Array.isArray(value)) return value.filter(Boolean).map(String).join('; ');
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  }, z.string().default(fallback));

const arrayField = <T extends z.ZodTypeAny>(item: T) =>
  z.preprocess((value) => (Array.isArray(value) ? value : []), z.array(item).default([]));

const metadataRefSchema = z.preprocess((value) => {
  // The model is inconsistent about the key it uses for the object/table name — it may
  // emit `object`, `name`, `api_name`, `table`, `label`, etc. The old schema only read
  // `object`, so any synonym silently parsed to an empty ref. Coalesce the common key
  // variants so a metadata ref the model DID produce is not thrown away.
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const v = value as Record<string, unknown>;
    const object = v.object ?? v.name ?? v.api_name ?? v.apiName ?? v.objectApiName ?? v.table ?? v.label ?? '';
    const note = v.note ?? v.why ?? v.description ?? v.reason ?? '';
    return { object: object == null ? '' : String(object), note: note == null ? '' : String(note) };
  }
  return { object: value == null ? '' : String(value), note: '' };
}, z.object({ object: textField(''), note: textField('') }));

const sourceFileRefSchema = z.preprocess((value) => {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  return { path: value == null ? '' : String(value), why: '' };
}, z.object({ path: textField(''), why: textField('') }));

const uiSelectorsSchema = z.object({
  ariaLabels: arrayField(textField('')),
  labels: arrayField(textField('')),
  roleNames: arrayField(z.object({ role: textField(''), name: textField('') })),
  uiHooks: arrayField(z.object({
    surface: textField(''),
    tag: textField(''),
    id: textField(''),
    ariaLabel: textField(''),
    placeholder: textField(''),
    role: textField(''),
    type: textField(''),
    classes: arrayField(textField('')),
    file: textField(''),
  })),
  testIds: arrayField(textField('')),
  cssIds: arrayField(textField('')),
  cssClasses: arrayField(textField('')),
  placeholders: arrayField(textField('')),
  fieldIds: arrayField(z.object({ label: textField(''), id: textField('') })),
  fileCount: z.number().default(0),
});

/**
 * Optional learned-skill text injected into the analyst prompt. This is the SkillOpt
 * "trainable state": a plain-markdown skill the optimization loop edits and validation-gates.
 * App-agnostic — it carries only general QA-drafting guidance, never app-specific facts.
 * Read at request time so loop edits take effect without a restart. Empty unless the env
 * path is set, so production behavior is unchanged until a skill is deployed.
 */
function readDraftingSkill(): string {
  const p = process.env.DRAFTING_SKILL_PATH;
  if (!p) return '';
  try { return existsSync(p) ? readFileSync(p, 'utf8').trim() : ''; } catch { return ''; }
}

const featureAnalystSchema = z.object({
  title: textField('Feature under test'),
  description: textField(''),
  businessRules: arrayField(textField('')),
  srsModules: arrayField(z.object({
    title: textField('Functional Requirements'),
    requirements: arrayField(z.object({
      title: textField('Requirement'),
      statement: textField(''),
      details: arrayField(textField('')),
    })),
  })),
  dataPopulationNotes: textField(''),
  sharedComponents: arrayField(z.object({
    name: textField(''),
    kind: textField('component'),
    sourceFiles: arrayField(sourceFileRefSchema),
    reusedBy: arrayField(textField('')),
    controlsOrBehaviors: arrayField(textField('')),
    metadataOrPermissionGates: arrayField(textField('')),
    testFocus: arrayField(textField('')),
  })),
  metadataRefs: arrayField(metadataRefSchema),
  uiSelectors: uiSelectorsSchema.default({
    ariaLabels: [],
    labels: [],
    roleNames: [],
    uiHooks: [],
    testIds: [],
    cssIds: [],
    cssClasses: [],
    placeholders: [],
    fieldIds: [],
    fileCount: 0,
  }),
  sourceFiles: arrayField(sourceFileRefSchema),
  candidateScenarios: arrayField(z.object({
    title: textField('Scenario'),
    priority: textField('Medium'),
    rationale: textField(''),
    steps: arrayField(z.preprocess((value) => {
      // The model sometimes emits a step as a bare string ("Click Sign in") instead of
      // an {action, expected} object. Coerce strings (and other shapes) into the object
      // form so a valid, code-grounded draft is not thrown away over a formatting quirk.
      if (typeof value === 'string') return { action: value, expected: '' };
      if (value && typeof value === 'object' && !Array.isArray(value)) return value;
      return { action: value == null ? '' : String(value), expected: '' };
    }, z.object({ action: textField(''), expected: textField('') }))),
  })),
});

const featureInventorySchema = z.object({
  appName: z.string().default('Application'),
  summary: z.string().default(''),
  coverageAudit: z.object({
    structuralFilesReviewed: z.array(z.string()).default([]),
    omittedStructuralFiles: z.array(z.object({
      path: z.string().default(''),
      reason: z.string().default(''),
    })).default([]),
    riskNotes: z.array(z.string()).default([]),
  }).default({ structuralFilesReviewed: [], omittedStructuralFiles: [], riskNotes: [] }),
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
  coverageAudit: featureInventorySchema.shape.coverageAudit,
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

function selectorTokens(text: string): Set<string> {
  return new Set(String(text || '').toLowerCase().split(/[^a-z0-9_-]+/).filter((w) => w.length > 2));
}

function selectorRelevant(value: string, tokens: Set<string>): boolean {
  const raw = String(value || '').trim();
  if (!raw) return false;
  const low = raw.toLowerCase();
  if (tokens.has(low)) return true;
  const parts = low.split(/[^a-z0-9_-]+/).filter((w) => w.length > 2);
  if (!parts.length) return false;
  return parts.some((part) => tokens.has(part)) || [...tokens].some((token) => token.length > 3 && low.includes(token));
}

function capRelevant(values: string[], tokens: Set<string>, limit: number): string[] {
  return Array.from(new Set(values.filter((value) => selectorRelevant(value, tokens)))).slice(0, limit);
}

function buildRequirementUiSelectors(map: SelectorMap, understanding: Partial<FeatureUnderstanding>, query: string) {
  const scenarioText = (understanding.candidateScenarios || [])
    .flatMap((scenario: any) => [
      scenario?.title,
      scenario?.rationale,
      ...(Array.isArray(scenario?.steps) ? scenario.steps.flatMap((step: any) => [step?.action, step?.expected]) : []),
    ])
    .filter(Boolean)
    .join(' ');
  const sourceText = [
    query,
    understanding.title,
    understanding.description,
    ...(understanding.businessRules || []),
    understanding.dataPopulationNotes,
    scenarioText,
  ].filter(Boolean).join(' ');
  const tokens = selectorTokens(sourceText);
  const fieldIds = map.fieldIds
    .filter((field) => selectorRelevant(field.label, tokens) || selectorRelevant(field.id, tokens))
    .slice(0, 40);
  const roleNames = map.roleNames
    .filter((role) => selectorRelevant(role.name, tokens) || selectorRelevant(role.role, tokens))
    .slice(0, 40);
  return {
    ariaLabels: capRelevant(map.ariaLabels, tokens, 60),
    labels: capRelevant(map.labels, tokens, 60),
    roleNames,
    uiHooks: map.uiHooks.filter((hook) =>
      selectorRelevant(hook.id || '', tokens)
      || selectorRelevant(hook.ariaLabel || '', tokens)
      || selectorRelevant(hook.placeholder || '', tokens)
      || selectorRelevant(hook.role || '', tokens)
      || selectorRelevant(hook.type || '', tokens)
      || (hook.classes || []).some((cls) => selectorRelevant(cls, tokens))
      || selectorRelevant(hook.file, tokens),
    ).slice(0, 80),
    testIds: capRelevant(map.testIds, tokens, 40),
    cssIds: capRelevant(map.cssIds, tokens, 60),
    cssClasses: capRelevant(map.cssClasses, tokens, 80),
    placeholders: capRelevant(map.placeholders, tokens, 40),
    fieldIds,
    fileCount: map.fileCount,
  };
}

function selectorsSummary(selectors: any): string {
  if (!selectors || typeof selectors !== 'object') return '';
  const parts: string[] = [];
  const push = (label: string, values: string[]) => {
    const clean = (values || []).map(String).filter(Boolean).slice(0, 30);
    if (clean.length) parts.push(`${label}: ${clean.join(' | ')}`);
  };
  push('aria-labels', selectors.ariaLabels || []);
  push('labels', selectors.labels || []);
  push('role names', (selectors.roleNames || []).map((r: any) => `${r.role}:${r.name}`));
  push('ui hooks', (selectors.uiHooks || []).map((h: any) => {
    const bits = [`${h.surface}:${h.tag}`];
    if (h.id) bits.push(`#${h.id}`);
    if (h.ariaLabel) bits.push(`aria="${h.ariaLabel}"`);
    if (h.placeholder) bits.push(`placeholder="${h.placeholder}"`);
    if (h.role) bits.push(`role="${h.role}"`);
    if (h.type) bits.push(`type="${h.type}"`);
    if (Array.isArray(h.classes) && h.classes.length) bits.push(`classes=${h.classes.map((c: string) => `.${c}`).join(',')}`);
    return bits.join(' ');
  }));
  push('test ids', selectors.testIds || []);
  push('css ids', (selectors.cssIds || []).map((id: string) => `#${id}`));
  push('css classes', (selectors.cssClasses || []).map((cls: string) => `.${cls}`));
  push('placeholders', selectors.placeholders || []);
  push('field label -> id', (selectors.fieldIds || []).map((f: any) => `${f.label}=>#${f.id}`));
  return parts.join('\n');
}
export type Reconciliation = z.infer<typeof reconcileSchema>;

/* ---------- keyword derivation ---------- */

const STOP = new Set([
  'test', 'tests', 'testing', 'feature', 'features', 'section', 'sections', 'module', 'modules',
  'the', 'for', 'do', 'and', 'requirement', 'requirements', 'based', 'please', 'can', 'you',
  'functionality', 'coverage', 'check', 'verify', 'validate', 'about', 'what',
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

type SourceFileMeta = { path: string; area: string; surface: string };

const SOURCE_NOISE_RE = /(^|\/)(\.[^/]+|node_modules|dist|build|coverage|docs?|e2e|tests?|__tests__|test-results|playwright-report|evidence|generated|vendor|public|assets)(\/|$)|\.(test|spec|stories)\.[tj]sx?$|\.d\.ts$/i;
const STRUCTURAL_PATH_RE = /(^|\/)(app|apps|pages|routes|router|navigation|nav|menu|sidebar|screens|views|features|feature|modules|workflows|flows|api|apis|services|controllers|handlers|schema|schemas|metadata|config|permissions?|auth)(\/|\.|-|_)/i;
const MANIFEST_PATH_RE = /(^|\/)(app|main|index|routes?|router|navigation|nav|menu|sidebar|layout|tabs|shell)\.[tj]sx?$|(^|\/)(routes?|router|navigation|nav|menu|sidebar|layout|tabs|shell)(\/|$)/i;
const UI_SOURCE_RE = /\.(tsx|jsx|vue|svelte|html)$/i;
const SERVICE_SOURCE_RE = /\.(ts|js|mjs|cjs|py|go|java|kt|rb|cs|php|rs|swift|scala)$/i;

function sourcePathTokens(value: string): string[] {
  return Array.from(new Set(String(value || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 2 && !STOP.has(token))));
}

function structuralScore(file: SourceFileMeta, terms: string[], broad: boolean): number {
  const p = file.path.replace(/\\/g, '/');
  const lower = p.toLowerCase();
  if (SOURCE_NOISE_RE.test(lower)) return -100;

  let score = 0;
  if (MANIFEST_PATH_RE.test(lower)) score += 18;
  if (STRUCTURAL_PATH_RE.test(lower)) score += 10;
  if (/(^|\/)(page|screen|view|route|controller|handler|service|schema|config)\.[tj]sx?$/i.test(lower)) score += 8;
  if (/(^|\/)(api|apis|services?|controllers?|handlers?)(\/|$)/i.test(lower)) score += 6;
  if (/(^|\/)(schema|schemas|metadata|config|permissions?|auth)(\/|$)/i.test(lower)) score += 5;
  if (UI_SOURCE_RE.test(lower)) score += 4;
  else if (SERVICE_SOURCE_RE.test(lower)) score += 2;

  const pathTokens = new Set(sourcePathTokens(p));
  for (const term of terms) {
    const clean = String(term || '').toLowerCase().trim();
    if (!clean) continue;
    if (lower.includes(clean)) score += clean.length > 3 ? 5 : 2;
    for (const token of sourcePathTokens(clean)) {
      if (pathTokens.has(token)) score += 4;
    }
  }

  if (broad && STRUCTURAL_PATH_RE.test(lower)) score += 4;
  return score;
}

function structuralGroupKey(pathValue: string): string {
  const parts = String(pathValue || '').replace(/\\/g, '/').split('/').filter(Boolean);
  const idx = parts.findIndex((part) => /^(app|apps|pages|routes|screens|views|features|feature|modules|workflows|flows|api|apis|services|schema|schemas|metadata|config)$/i.test(part));
  if (idx >= 0) return parts.slice(0, Math.min(parts.length, idx + 2)).join('/');
  return parts.slice(0, Math.min(parts.length, 2)).join('/') || pathValue;
}

function discoverStructuralSourceFiles(query: string, keywords: string[], repoPath?: string, limit = 180): SourceFileMeta[] {
  let all: SourceFileMeta[] = [];
  try {
    all = listRepoSourceFiles(repoPath, 10000);
  } catch {
    return [];
  }
  const broad = isBroadDiscoveryQuery(query);
  const terms = Array.from(new Set([...keywords, ...sourcePathTokens(query), ...FULL_APP_DISCOVERY_TERMS]));
  const scored = all
    .map((file) => ({ file, score: structuralScore(file, terms, broad) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.file.path.localeCompare(b.file.path));

  const manifests = scored.filter((item) => MANIFEST_PATH_RE.test(item.file.path)).slice(0, 45);
  const byGroup = new Map<string, Array<{ file: SourceFileMeta; score: number }>>();
  for (const item of scored) {
    const key = structuralGroupKey(item.file.path);
    const bucket = byGroup.get(key) || [];
    if (bucket.length < 4) bucket.push(item);
    byGroup.set(key, bucket);
  }

  const picked: SourceFileMeta[] = [];
  const seen = new Set<string>();
  const add = (file: SourceFileMeta) => {
    if (!file?.path || seen.has(file.path)) return;
    seen.add(file.path);
    picked.push(file);
  };
  manifests.forEach((item) => add(item.file));
  Array.from(byGroup.values())
    .flat()
    .sort((a, b) => b.score - a.score || a.file.path.localeCompare(b.file.path))
    .forEach((item) => add(item.file));
  return picked.slice(0, limit);
}

function selectStructuralFilesForTerms(files: SourceFileMeta[], terms: string[], limit = 32): string[] {
  const scored = files
    .map((file) => ({ file, score: structuralScore(file, terms, true) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.file.path.localeCompare(b.file.path));
  return scored.slice(0, limit).map((item) => item.file.path);
}

function extractSourceAnchors(content: string): string[] {
  const anchors = new Set<string>();
  const add = (value: string) => {
    const clean = String(value || '').replace(/\s+/g, ' ').trim();
    if (clean.length >= 2 && clean.length <= 80 && !/^[{}[\](),.;:=]+$/.test(clean)) anchors.add(clean);
  };
  for (const m of content.matchAll(/['"`](\/[A-Za-z0-9][A-Za-z0-9/_:.-]{0,90})['"`]/g)) add(m[1]);
  for (const m of content.matchAll(/\b(?:path|route|href|to|url|label|title|name|text|aria-label)\s*[:=]\s*['"`]([^'"`]{2,80})['"`]/gi)) add(m[1]);
  for (const m of content.matchAll(/\b(?:export\s+default\s+function|function|const|class)\s+([A-Z][A-Za-z0-9_]{2,50})\b/g)) add(m[1]);
  for (const m of content.matchAll(/>\s*([A-Z][A-Za-z0-9][^<>{}\n]{1,60})\s*</g)) add(m[1]);
  return Array.from(anchors).slice(0, 10);
}

function buildStructuralMapForPrompt(files: SourceFileMeta[], repoPath?: string, maxFiles = 150, maxChars = 18000): string {
  const lines: string[] = [];
  for (const file of files.slice(0, maxFiles)) {
    let anchors: string[] = [];
    try {
      anchors = extractSourceAnchors(readRepoFile(file.path, 2600, repoPath));
    } catch {
      anchors = [];
    }
    lines.push(`${file.path} [${file.area}]${anchors.length ? ` anchors: ${anchors.join(' | ')}` : ''}`);
  }
  return lines.join('\n').slice(0, maxChars);
}

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

/**
 * Dynamic, BFS-driven source discovery — Claude-Code style.
 *
 * 1. Keyword extraction → broad git grep → relevance-ranked seed files.
 * 2. expandByReferences: real import-graph BFS from those seeds following actual
 *    TS/JS `import` statements depth-first through child → grandchild … → leaf nodes.
 *    Relevance-pruned beyond freeDepth=1 so the walk terminates naturally at the
 *    boundary of the feature's subgraph — no artificial file-count or byte budget.
 * 3. Return nodes in BFS order (seeds → direct imports → transitive dependencies).
 *
 * Termination is purely graph-driven: when there are no more reachable nodes whose
 * path or content matches the keywords, the BFS stops. Per-file read size (maxBytesPerFile)
 * prevents any single large file from dominating, but the total set size is emergent.
 */
async function dynamicBfsDiscovery(
  keywords: string[],
  repoPath?: string,
  opts: { structuralSeeds?: SourceFileMeta[] } = {},
): Promise<{ files: Array<{ path: string; area: string; surface: string }>; excerpts: string }> {
  // Step 1: grep → relevance-ranked seed paths.
  const grepHits = gitGrep(keywords, undefined, 80, repoPath);
  const hitMeta = new Map(grepHits.map((h) => [h.path, h]));
  for (const s of opts.structuralSeeds || []) {
    if (s?.path && !hitMeta.has(s.path)) hitMeta.set(s.path, s);
  }
  const seedPaths = relevantSourcePaths(Array.from(hitMeta.keys()), keywords).slice(0, 24);

  // Step 2: BFS over the actual import graph.
  // - freeDepth=1: every direct import of a seed is followed unconditionally.
  // - Beyond depth 1: only nodes whose path OR content contains a keyword are enqueued.
  //   This naturally terminates at the feature's subgraph without an artificial cap.
  const graphNodes = await expandByReferences(
    seedPaths,
    { read: async (p, b) => readRepoFile(p, b, repoPath) },
    { terms: keywords, maxDepth: 6, maxFiles: 80, maxBytesPerFile: 2000, freeDepth: 1 },
  );

  // Step 3: build the ordered file list.
  // BFS order (shallower = more directly relevant = first). Structural seeds not reached
  // by the import walk are appended at the end — they are top-level files (routes, manifests)
  // that nothing imports but are still structurally important entry points.
  const seenPaths = new Set<string>();
  const ordered: string[] = [];
  for (const node of graphNodes) {
    if (!seenPaths.has(node.path)) { seenPaths.add(node.path); ordered.push(node.path); }
  }
  for (const [p] of hitMeta) {
    if (!seenPaths.has(p)) { seenPaths.add(p); ordered.push(p); }
  }

  // Step 4: read every node in BFS order and assemble the excerpts block.
  // expandByReferences already read each file up to maxBytesPerFile during the walk;
  // we re-read here to get the content for the prompt (same byte cap).
  const files: Array<{ path: string; area: string; surface: string }> = [];
  const parts: string[] = [];
  for (const p of ordered) {
    try {
      const content = readRepoFile(p, 3000, repoPath);
      if (!content.trim()) continue;
      const meta = hitMeta.get(p);
      files.push({ path: p, area: meta?.area ?? 'code', surface: (meta as any)?.surface ?? '' });
      parts.push(`FILE: ${p}  [area: ${meta?.area ?? 'code'}]\n${content}`);
    } catch { /* unreadable — skip */ }
  }

  const EXCERPT_CHAR_CAP = 200_000;
  const joined = parts.join('\n\n---\n\n');
  return { files, excerpts: joined.length > EXCERPT_CHAR_CAP ? joined.slice(0, EXCERPT_CHAR_CAP) + '\n\n[truncated — too large]' : joined };
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
 * Read the target application's REAL source and
 * produce a grounded, structured understanding of the requested feature: the
 * business rules the code enforces, surface-specific behavior, the
 * metadata source of truth, and a first cut of scenarios scaled to what the code
 * actually does. This is the depth-of-understanding step the Agent Console uses to
 * drive how many cases to write, the steps, and the scripts — instead of a fixed
 * template. Pure analysis: no requirement/inbox side effects (that stays in
 * discoverRequirement, which now reuses this).
 */
export async function analyzeFeatureFromSource(
  query: string,
  opts: { workspaceId?: string; userId?: string; repoPath?: string; projectId?: string; appId?: string; applicationContextPrompt?: string; conversationContextPrompt?: string; onProgress?: (label: string) => void } = {},
): Promise<{ understanding: FeatureUnderstanding; files: Array<{ path: string; area: string; surface: string }>; keywords: string[] }> {
  const cleanQuery = String(query || '').trim();
  const keywords = deriveKeywords(cleanQuery);
  const inventoryKeywords = deriveInventoryKeywords(cleanQuery);
  const repoPath = opts.repoPath;
  opts.onProgress?.('Scanning route, feature, service, metadata, and UI structure...');
  const structuralFiles = discoverStructuralSourceFiles(cleanQuery, inventoryKeywords, repoPath, 120);
  const structuralMap = buildStructuralMapForPrompt(structuralFiles, repoPath, 80, 12000);

  // BFS import-graph discovery: keyword → grep seeds → follow actual TS/JS imports
  // depth-first until the feature's subgraph is fully traversed. No hardcoded file count.
  opts.onProgress?.(`Searching source files for ${keywords.slice(0, 5).join(', ') || 'the requirement'}...`);
  const { files, excerpts } = await dynamicBfsDiscovery(
    Array.from(new Set([...keywords, ...inventoryKeywords])),
    repoPath,
    { structuralSeeds: structuralFiles },
  );

  // Deep parallel research: decompose the feature into investigation angles and research
  // each concurrently. Each facet's io.search also uses BFS so it gets transitive imports,
  // not just the files whose names happen to match the search terms.
  let researchNotes = '';
  try {
    opts.onProgress?.(`Exploring ${Math.max(1, keywords.length)} code area(s) in parallel...`);
    researchNotes = await deepParallelResearch({
      question: cleanQuery,
      io: {
        search: async (terms) => {
          const hits = relevantSourcePaths(gitGrep(terms, undefined, 80, repoPath).map((h) => h.path), terms);
          const graph = await expandByReferences(
            hits.slice(0, 14),
            { read: async (p, b) => readRepoFile(p, b, repoPath) },
            { terms, maxDepth: 5, maxFiles: 40, maxBytesPerFile: 1500, freeDepth: 1 },
          );
          return Array.from(new Set([...hits, ...graph.map((n) => n.path)]));
        },
        read: async (p, b) => readRepoFile(p, b, repoPath),
      },
      orchestratorAgent: 'featureAnalyst',
      workspaceId: opts.workspaceId,
      userId: opts.userId,
      onProgress: opts.onProgress,
    });
  } catch {
    researchNotes = '';
  }
  const groundingBlock = researchNotes
    ? `DEEP PARALLEL RESEARCH NOTES — compiled by reading the application's REAL source across many areas of the codebase concurrently. PRIMARY grounding; treat as authoritative:\n${researchNotes}\n\nSupporting raw code (path + area):\n${excerpts || '(none)'}`
    : `Code read from the target application's real source across the codebase (path + area). Ground your understanding ONLY in these:\n${excerpts || '(no matching source found — say so in the description and keep businessRules minimal rather than inventing them)'}`;


  // Ground metadataRefs in the app's LIVE metadata object catalog (best-effort — never blocks
  // the draft). Giving the model the real api_names up front yields exact refs ("trigger_audit_log",
  // "tab", "field") instead of descriptive guesses, and lets it leave a ref out rather than invent one.
  let metaCatalogBlock = '';
  try {
    opts.onProgress?.('Loading live metadata object catalog for grounding...');
    // Per-app grounding: use the SELECTED app's base URL (+ optional spec path) so the swagger
    // catalog is fetched from whatever app this draft targets — not a single global env URL.
    // Falls back to the global config when no app is selected or it has no base URL.
    let appConn: { baseUrl?: string; specPath?: string; catalogStrategy?: string; username?: string; password?: string } | undefined;
    try {
      const activeApp = opts.appId ? getApp(opts.appId) : undefined;
      if (activeApp?.baseUrl) {
        appConn = {
          baseUrl: activeApp.baseUrl,
          specPath: activeApp.specPath,
          catalogStrategy: activeApp.catalogStrategy,
        };
        // Per-app credentials: resolve THIS app's stored login, scoped to the owner, so the
        // business-objects half authenticates as the tenant's own read-only user — never a
        // shared/global credential, and never another tenant's.
        try {
          const cred = resolveCredentials({ baseUrl: activeApp.baseUrl, ownerId: opts.userId });
          if (cred?.username && cred?.password) {
            appConn.username = cred.username;
            appConn.password = cred.password;
          }
        } catch { /* fall back to global creds */ }
      }
    } catch { /* ignore — fall back to global */ }
    const catalog = await fetchCorePlatformObjectCatalog(appConn);
    if (catalog.length) {
      const lines = catalog
        .map((c) => `- ${c.api_name} (${c.label}) [app: ${c.app}]`)
        .join('\n');
      // Examples are derived from THIS connected app's own catalog — never hardcoded — so the
      // grounding stays correct when the platform is pointed at a different application.
      const examples = catalog.slice(0, 4).map((c) => `"${c.api_name}"`).join(', ');
      metaCatalogBlock = `\n\nLIVE METADATA OBJECT CATALOG — the REAL metadata object api_names from the connected application's own database (fetched at runtime). These are the ONLY valid values for metadataRefs.object. Use the EXACT api_name verbatim${examples ? ` (for example, drawn from this app: ${examples})` : ''} — never a descriptive phrase, label, or invented name. If a feature's source of truth is not one of these objects, leave metadataRefs empty:\n${lines}`;
    }
  } catch {
    metaCatalogBlock = '';
  }

  let repoSelectorMap: SelectorMap | null = null;
  let selectorCatalogBlock = '';
  try {
    if (repoPath) {
      repoSelectorMap = extractSelectorMap(repoPath);
      const querySelectors = buildRequirementUiSelectors(repoSelectorMap, {
        title: cleanQuery,
        description: cleanQuery,
        businessRules: keywords,
        candidateScenarios: [],
      } as any, cleanQuery);
      const rendered = selectorsSummary(querySelectors);
      selectorCatalogBlock = rendered
        ? `\n\nREPO UI SELECTOR CATALOG FOR THIS REQUIREMENT - exact strings extracted from source. Candidate scenario steps must use these labels/aria-labels/ids/classes when they refer to UI controls. If a needed control is not listed here, mention the missing hook in preconditions instead of inventing a label:\n${rendered}`
        : `\n\nREPO UI SELECTOR CATALOG FOR THIS REQUIREMENT - source scan found ${repoSelectorMap.fileCount} UI source files but no selector strings matched this requirement query. Do not invent labels; keep UI-specific steps conditional/preconditioned unless source evidence above proves the control name.`;
    }
  } catch {
    repoSelectorMap = null;
    selectorCatalogBlock = '\n\nREPO UI SELECTOR CATALOG FOR THIS REQUIREMENT - unavailable. Do not invent labels or ids.';
  }

  const analyst = await getOrchestrator('featureAnalyst', opts);
  opts.onProgress?.('Extracting requirement rules from source evidence...');
  const applicationContextBlock = opts.applicationContextPrompt
    ? `\n\nSELECTED APPLICATION CONTEXT - authoritative. Use this to avoid guessing app identity, repo roots, object api_names, field api_names, sample data, and knowledge-pack rules. If a detail is not present here or in source evidence, leave it unknown instead of inventing it:\n${opts.applicationContextPrompt}`
    : '';
  // Ongoing-chat context so follow-up drafts ("also add requirements for X", "the same module")
  // enrich the running scope instead of resetting it; the user query stays the primary subject.
  const conversationContextBlock = opts.conversationContextPrompt
    ? `\n\nCONVERSATION CONTEXT - the chat that led to this request. Use it ONLY to resolve references (pronouns, "the same page/module", earlier decisions and constraints) and to carry forward scope already agreed in the conversation. Do not let it override the user query or the source evidence:\n${opts.conversationContextPrompt}`
    : '';
  const analystRes = await analyst.generateObject<FeatureUnderstanding>({
    prompt: `Feature/section to analyze (user query): "${cleanQuery}"

Search keywords used: ${keywords.join(', ')}

${groundingBlock}${metaCatalogBlock}${selectorCatalogBlock}${applicationContextBlock}${conversationContextBlock}

INFER the application's architecture from the research notes and excerpts above — do NOT assume any specific product, framework, or surface names. Let the code tell you. Use ONLY behaviour the research actually establishes; never invent meta-concepts (CI/seeding/regression scaffolding) that aren't real user features.
${readDraftingSkill() ? `\nLEARNED DRAFTING SKILL (general QA-drafting guidance refined over prior runs — apply it):\n${readDraftingSkill()}\n` : ''}
SCOPE DISCIPLINE — write the requirement at the altitude the query actually asks for; do not narrow it to a subject the user did not name:
- If the query NAMES a specific object, section, module, or screen, scope the requirement to THAT subject.
- If the query asks about a GENERIC, REUSABLE CAPABILITY that applies across many objects/views (e.g. a shared toolbar action, an export / settings / filter / column control, a list-view mechanism) WITHOUT naming a specific object, write the requirement about the CAPABILITY ITSELF as it works generally — describe the shared control and its rules across the surface. Do NOT anchor it to, or title it after, one concrete object you merely found in the code (e.g. don't turn "list view export and settings" into "export and settings for <SomeObject>"); that invents a scope the user did not request. Keep the title and rules about the capability.
- In the generic case, metadataRefs should be the generic config object(s) the capability operates on (e.g. the list-view / view-definition object) if the catalog has them, and you should leave specific business-object refs empty unless the query named one.
- Before writing scenarios, group the source evidence by reusable UI/component modules that implement the requested capability. Search related imports, child components, hooks, adapters, metadata gates, and permission gates. If a reusable component is used by many apps/objects/views, describe that shared component instead of anchoring coverage to one object. Do not hardcode a universal control list: include only controls and behaviours proven by source evidence or live selector evidence.

Produce the requirement understanding as strict JSON matching the schema:
- title: a concise requirement title for this feature.
- description: 1-3 sentences on what the feature does and why it matters.
- businessRules: the concrete, testable rules the code enforces.
- srsModules: organize every business rule into distinct functional modules for the Agent Console's Notion-style Markdown Requirements response. Each module needs a concise title and ordered requirements. Each requirement needs a short title, one complete "The system shall..." statement, and optional detail lines for conditions, defaults, enumerated values, or validation rules. Do not include numbering or Markdown syntax in these fields; the UI deterministically adds the Markdown headings, 1., 1.1, 1.2 numbering, and detail bullets. Do not omit a business rule from this structure.
- dataPopulationNotes: what the backend populates/seeds/syncs in the background as preconditions for this feature (only if the research shows it).
- sharedComponents: reusable components/modules discovered by code search. For each one, include its real source files, where it is reused, the controls/behaviors the code proves, metadata/permission gates, and the exact test focus. This is the main way downstream agents avoid searching the whole repo again.
- metadataRefs: the EXACT metadata object api_names that are the source of truth for this feature. Each entry's "object" MUST be a verbatim api_name taken from the LIVE METADATA OBJECT CATALOG provided above — never a descriptive phrase, label, invented name, or DB-table/column name. List ONLY the 1-5 objects that are the PRIMARY source of truth for THIS specific feature — do NOT list every object that is loosely or indirectly related, and do NOT dump the catalog. Prefer fewer, highly-relevant refs. Put any table/column-level detail in businessRules or dataPopulationNotes instead. If no catalog was provided above, or none of its objects are the source of truth for this feature, leave metadataRefs empty rather than inventing entries.
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
    srsModules: [],
    dataPopulationNotes: '',
    sharedComponents: [],
    metadataRefs: [],
    sourceFiles: files.map((f) => ({ path: f.path, why: f.area })),
    candidateScenarios: [],
  };
  // Attach the REAL UI selectors for this feature, pulled straight from the codebase, so the
  // requirement RESPONSE itself carries them — downstream agents (cases, scripts, verify-locators)
  // map them directly instead of guessing. App-agnostic: extracted from whatever source repo is
  // bound; relevance = selector words that appear in the feature text. Never blocks the draft.
  try {
    if (opts.repoPath) {
      const map = extractSelectorMap(opts.repoPath);
      const steps = (understanding.candidateScenarios || []).flatMap((s: any) => (s.steps || []).map((x: any) => `${x.action} ${x.expected}`));
      const hay = `${understanding.title} ${(understanding.businessRules || []).join(' ')} ${steps.join(' ')} ${cleanQuery}`.toLowerCase();
      const hayWords = new Set(hay.split(/\W+/).filter((w) => w.length > 3));
      const rel = new Set<string>();
      for (const s of [...map.ariaLabels, ...map.labels, ...map.placeholders]) {
        const words = s.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
        if (words.length && words.some((w) => hayWords.has(w))) rel.add(s);
      }
      (understanding as any).relevantSelectors = [...rel].slice(0, 30);
    }
  } catch { /* selectors are an enhancement, never block the draft */ }
  try {
    const map = repoSelectorMap || (opts.repoPath ? extractSelectorMap(opts.repoPath) : null);
    if (map) (understanding as any).uiSelectors = buildRequirementUiSelectors(map, understanding, cleanQuery);
  } catch { /* structured selector grounding is an enhancement, never block the draft */ }
  opts.onProgress?.('Source-grounded requirement understanding is ready...');
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
  opts: { workspaceId?: string; userId?: string; repoPath?: string; projectId?: string; appId?: string; applicationContextPrompt?: string; onProgress?: (label: string) => void } = {},
): Promise<{ inventory: FeatureInventory; files: Array<{ path: string; area: string; surface: string }>; keywords: string[] }> {
  const cleanQuery = String(query || '').trim() || 'Discover all testable features, subfeatures, and end-to-end flows in this application.';
  const keywords = deriveInventoryKeywords(cleanQuery);
  const repoPath = opts.repoPath;
  const structuralFiles = discoverStructuralSourceFiles(cleanQuery, keywords, repoPath, 120);
  const structuralMap = buildStructuralMapForPrompt(structuralFiles, repoPath, 80, 12000);

  // BFS import-graph discovery — same pattern as analyzeFeatureFromSource.
  const { files, excerpts } = await dynamicBfsDiscovery(keywords, repoPath, { structuralSeeds: structuralFiles });

  let researchNotes = '';
  try {
    opts.onProgress?.('Mapping feature areas from source structure...');
    researchNotes = await deepParallelResearch({
      question: `${cleanQuery}

Discover feature-level, subfeature-level, and end-to-end QA coverage across the selected application. Split the app by user-visible capabilities and backend-enforced rules. Do not stop at top-level pages.`,
      io: {
        search: async (terms) => {
          const merged = Array.from(new Set([...keywords, ...(terms || [])]));
          const hits = relevantSourcePaths(gitGrep(merged, undefined, 80, repoPath).map((h) => h.path), merged);
          const structuralPaths = selectStructuralFilesForTerms(structuralFiles, merged, 20);
          const graph = await expandByReferences(
            [...new Set([...structuralPaths, ...hits])].slice(0, 14),
            { read: async (p, b) => readRepoFile(p, b, repoPath) },
            { terms: merged, maxDepth: 8, maxFiles: 200, maxBytesPerFile: 2000, freeDepth: 1 },
          );
          return Array.from(new Set([...structuralPaths, ...hits, ...graph.map((n) => n.path)]));
        },
        read: async (p, b) => readRepoFile(p, b, repoPath),
      },
      orchestratorAgent: 'featureDiscoveryAgent',
      workspaceId: opts.workspaceId,
      userId: opts.userId,
      onProgress: opts.onProgress,
      // Inventory/E2E discovery is inherently broad ("don't stop at top-level"), so scale with
      // the request's complexity but keep a higher floor than a single-feature draft.
      maxFacets: Math.max(8, facetCeiling(cleanQuery)),
      bytesPerFile: 2000,
    });
  } catch {
    researchNotes = '';
  }

  const groundingBlock = researchNotes
    ? `APP STRUCTURAL MAP (deterministic repo scan; use this as the coverage checklist, and use excerpts/research as behavior proof):\n${structuralMap || '(none)'}\n\nPARALLEL SOURCE RESEARCH NOTES (primary grounding):\n${researchNotes}\n\nSupporting raw source excerpts:\n${excerpts || '(none)'}`
    : `APP STRUCTURAL MAP (deterministic repo scan; use this as the coverage checklist, and use excerpts as behavior proof):\n${structuralMap || '(none)'}\n\nRaw source excerpts from broad feature discovery searches:\n${excerpts || '(no matching source found; return empty feature arrays rather than inventing)'}`;


  const featureAgent = await getOrchestrator('featureDiscoveryAgent', opts);
  opts.onProgress?.('Mapping features and subfeatures from code...');
  const applicationContextBlock = opts.applicationContextPrompt
    ? `\n\nSELECTED APPLICATION CONTEXT - authoritative. Use this to avoid guessing app identity, repo roots, object api_names, field api_names, sample data, and knowledge-pack rules. If a detail is not present here or in source evidence, leave it unknown instead of inventing it:\n${opts.applicationContextPrompt}`
    : '';
  const featureRes = await featureAgent.generateObject<FeatureInventory>({
    prompt: `You are FeatureDiscoveryAgent. Build a granular QA feature inventory from the target application's REAL source.

User request:
${cleanQuery}

Search keywords:
${keywords.join(', ')}

${groundingBlock}${applicationContextBlock}

Return strict JSON matching the schema.

Rules:
- Do NOT return only top-level pages/modules. Decompose into feature -> subfeatures.
- Use the APP STRUCTURAL MAP as a checklist. Each route/page/navigation/feature-like file should either be represented as a feature/subfeature or excluded only when the evidence shows it is not user-visible behavior.
- A subfeature is testable as its own case: a user action, validation, permission rule, data state, table behavior, or branch.
- Capture backend-enforced business rules and frontend-visible actions under the matching subfeature.
- Prefer one subfeature per user-visible capability or code-enforced branch: create/edit/delete, filters/search, import/export, validation failures, permissions, empty/error states, async/background behavior, etc.
- Use sourceFiles with real repo-relative paths from the evidence only.
- Keep unrelated framework plumbing out unless it changes user-visible or API behavior.
- Leave e2eFlows empty in this response; E2EFlowAgent fills them next.
- Fill coverageAudit.structuralFilesReviewed with the structural-map files you actually used for coverage.
- Fill coverageAudit.omittedStructuralFiles for important-looking structural-map files you intentionally excluded, with the evidence-based reason. Do not omit a route/page/feature-like file silently.`,
    schema: featureInventorySchema,
    userMessage: cleanQuery,
    hasHistory: true,
    // No hardcoded output cap — defer to the selected model's max output (maxOutputFor), so a
    // large inventory is never truncated. API spend is visible in the cost tracker.
  });
  if ((featureRes as any).shortCircuit) throw new Error(String((featureRes as any).shortCircuit));

  const inventory: FeatureInventory = (featureRes as any).object || {
    appName: 'Application',
    summary: '',
    features: [],
    e2eFlows: [],
  };

  const e2eAgent = await getOrchestrator('e2eFlowAgent', opts);
  opts.onProgress?.('Mapping E2E flows from mapped features...');
  const e2eRes = await e2eAgent.generateObject<z.infer<typeof e2eFlowSchema>>({
    prompt: `You are E2EFlowAgent. Identify end-to-end user journeys across the application from source-grounded evidence and the feature inventory.

User request:
${cleanQuery}

FEATURE INVENTORY FROM FEATUREDISCOVERYAGENT:
${summarizeFeatureInventoryForPrompt(inventory)}

SOURCE GROUNDING:
${groundingBlock}${applicationContextBlock}

Return strict JSON matching the schema.

Rules:
- An E2E flow must cross multiple features, screens, APIs, roles, or persisted states.
- Use the APP STRUCTURAL MAP and feature inventory together. Look for links such as login -> landing -> feature use, create -> list/detail -> edit/delete, settings/config -> runtime behavior, import -> records -> export, permission setup -> restricted action, and background processing -> visible result.
- Do not duplicate single subfeature cases; those are handled by FeatureDiscoveryAgent.
- Each userJourney step must be concrete and ordered enough for a test case.
- coveredFeatures must reference feature/subfeature names from the inventory where possible.
- Include business rules and sourceFiles that justify the flow.
- If the evidence does not establish any cross-feature journey, return an empty e2eFlows array.
- Fill coverageAudit.structuralFilesReviewed with the structural-map files used to infer cross-feature journeys.
- Fill coverageAudit.omittedStructuralFiles for important-looking structural-map files that did not connect to a supported E2E journey, with a short reason.`,
    schema: e2eFlowSchema,
    userMessage: cleanQuery,
    hasHistory: true,
    // No hardcoded output cap — defer to the selected model's max output (maxOutputFor).
  });
  if ((e2eRes as any).shortCircuit) throw new Error(String((e2eRes as any).shortCircuit));

  inventory.e2eFlows = (e2eRes as any).object?.e2eFlows || [];
  if ((e2eRes as any).object?.coverageAudit) {
    inventory.coverageAudit = {
      ...(inventory.coverageAudit || { structuralFilesReviewed: [], omittedStructuralFiles: [], riskNotes: [] }),
      e2e: (e2eRes as any).object.coverageAudit,
    } as any;
  }
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

Return strict JSON matching the schema. In coverage.gaps list the behaviors the existing cases miss; in proposedCases add only NEW cases (with concrete, executable steps and expected results) that close those gaps. If the existing cases already cover the feature, return an empty proposedCases array.

WRITING STYLE (must follow for the rationale AND every step action and expected result):
- Write in plain, simple, everyday English that a non-technical person can read at a glance. Short sentences, common words.
- Do NOT use heavy or technical words, internal jargon, or invented terms. Say what a real user sees and does on the screen.
- BANNED in steps and expected results: internal field/column names (e.g. "created_at", "appId", "app id and object pair"), implementation/database terms (e.g. "AND filters", "descending", "Table mode", "bootstrap", "deduplication", "session", "context", "persisted", "detected"), and developer phrasing. Describe the visible outcome instead — e.g. say "the list is sorted with the newest item first" not "sorts by created_at descending"; "a default view is created automatically" not "a bootstrap view is created"; "opening it again does not create a duplicate view" not "a second bootstrap view is not created for the same appId and object pair".
- Each step action is one thing the user clicks/types/opens; each expected result is what the user then sees on screen. Keep both concrete and plain.
- Each case's "rationale" must be ONE short plain sentence saying what the case checks and why it matters. Do NOT restate the steps in it and do NOT include a "Test Steps:" or "Expected:" list — the steps belong only in the steps field, so repeating them in the rationale just duplicates.`,
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
  apiAnalysis?: ApiAnalysis;
}

export type RequirementDraftResult = DiscoverResult & { draft: true };

/* ---------- main entry ---------- */

async function reconcileRequirementCoverage(
  understanding: FeatureUnderstanding,
  existingCases: Array<{ id: string; title: string; tags?: string[]; type?: string; priority?: string; stepCount?: number }>,
  opts: { workspaceId?: string; userId?: string; role?: string; onProgress?: (label: string) => void },
  requirementsOnly: boolean,
): Promise<Reconciliation> {
  const reconciler = await getOrchestrator('caseWriter', opts);
  opts.onProgress?.(`Checking ${existingCases.length} existing test case(s) for coverage...`);
  const reconcileRes = await reconciler.generateObject<Reconciliation>({
    prompt: `You are a senior QA engineer deciding what tests a requirement needs. Reconcile the requirement understanding against the EXISTING test cases before proposing anything.

REQUIREMENT UNDERSTANDING:
${JSON.stringify(understanding, null, 2)}

EXISTING test cases already in the QA repository:
${JSON.stringify(existingCases)}

Do the following and return strict JSON matching the schema:
1) In coverage.coveredBy, list the EXISTING case ids (use ids that appear verbatim above) that already test this requirement, each with a short reason. Set coverage.sufficient = true ONLY if the existing cases genuinely cover the requirement's business rules.
2) In coverage.gaps, list the specific behaviors the existing cases do NOT cover.
3) ${requirementsOnly
  ? `The caller asked for requirements only. Leave proposedCases empty even if gaps exist.`
  : `If coverage is NOT sufficient, in proposedCases propose the MINIMUM set of new test cases (with concrete, executable steps and expected results) to close the gaps. Prefer the requirement's candidateScenarios where they fit. Do NOT duplicate existing coverage. If coverage IS sufficient, leave proposedCases empty.`}`,
    schema: reconcileSchema,
    userMessage: 'reconcile requirement coverage against existing cases',
  });

  if ((reconcileRes as any).shortCircuit) {
    throw new Error(String((reconcileRes as any).shortCircuit));
  }
  opts.onProgress?.('Coverage reconciliation is ready...');
  return (reconcileRes as any).object || {
    coverage: { sufficient: false, coveredBy: [], gaps: [], reasoning: '' },
    proposedCases: [],
  };
}

async function existingCasesForRequirement(ownerId: string) {
  const allCases = await Cases.list();
  const scopedCases = ownerId
    ? allCases.filter((c: any) => (c.ownerId || '') === ownerId)
    : allCases;
  return scopedCases.slice(0, 100).map((c: any) => ({
    id: c.id,
    title: c.title,
    tags: c.tags || [],
    type: c.type,
    priority: c.priority,
    stepCount: (c.steps || []).length,
  }));
}

function buildRequirementRecord(
  requirementId: string,
  cleanQuery: string,
  understanding: FeatureUnderstanding,
  files: Array<{ path: string; area: string; surface: string }>,
  coverageStatus: string,
  ownerId: string,
  scope: { projectId?: string; appId?: string } = {},
) {
  return {
    id: requirementId,
    title: understanding.title || cleanQuery,
    description: understanding.description || '',
    featureQuery: cleanQuery,
    businessRules: understanding.businessRules || [],
    srsModules: understanding.srsModules || [],
    dataPopulationNotes: understanding.dataPopulationNotes || '',
    metadataRefs: understanding.metadataRefs || [],
    uiSelectors: (understanding as any).uiSelectors || {
      ariaLabels: [],
      labels: [],
      roleNames: [],
      testIds: [],
      cssIds: [],
      cssClasses: [],
      placeholders: [],
      fieldIds: [],
      fileCount: 0,
    },
    sourceFiles: (understanding.sourceFiles && understanding.sourceFiles.length
      ? understanding.sourceFiles
      : files.map((f) => ({ path: f.path, why: f.area }))),
    coverageStatus,
    status: 'Draft',
    approvalState: 'proposed',
    proposedBy: 'Feature Analyst',
    projectId: scope.projectId || '',
    appId: scope.appId || '',
    ownerId,
  };
}

function mergeInventoryIntoUnderstanding(base: FeatureUnderstanding, inventory: FeatureInventory): FeatureUnderstanding {
  const businessRules = new Set((base.businessRules || []).map((rule) => String(rule)).filter(Boolean));
  const candidateScenarios = [...(base.candidateScenarios || [])];
  const sourceFiles = new Map<string, { path: string; why: string }>();
  for (const file of base.sourceFiles || []) {
    if (file?.path) sourceFiles.set(file.path, { path: file.path, why: file.why || '' });
  }

  for (const feature of inventory.features || []) {
    const featureName = String(feature.name || 'Feature').trim();
    if (feature.description) businessRules.add(`${featureName}: ${feature.description}`);
    for (const file of feature.sourceFiles || []) {
      if (file?.path) sourceFiles.set(file.path, { path: file.path, why: file.why || featureName });
    }
    for (const sub of feature.subfeatures || []) {
      const subName = String(sub.name || 'Subfeature').trim();
      for (const rule of sub.businessRules || []) businessRules.add(`${featureName} / ${subName}: ${rule}`);
      for (const action of sub.userActions || []) businessRules.add(`${featureName} / ${subName} action: ${action}`);
      candidateScenarios.push({
        title: `${featureName} - ${subName}`,
        priority: sub.priority || 'Medium',
        rationale: sub.description || (sub.testIdeas || []).join('; '),
        steps: (sub.testIdeas && sub.testIdeas.length
          ? sub.testIdeas.map((idea) => ({ action: idea, expected: `The ${subName} behavior is observable and matches the code-defined rule.` }))
          : [{ action: `Exercise ${subName} in ${featureName}.`, expected: `The ${subName} behavior matches the source-defined requirement.` }]),
      });
    }
  }

  for (const flow of inventory.e2eFlows || []) {
    const flowName = String(flow.name || 'End-to-end flow').trim();
    if (flow.description) businessRules.add(`E2E ${flowName}: ${flow.description}`);
    for (const rule of flow.businessRules || []) businessRules.add(`E2E ${flowName}: ${rule}`);
    for (const file of flow.sourceFiles || []) {
      if (file?.path) sourceFiles.set(file.path, { path: file.path, why: file.why || flowName });
    }
    candidateScenarios.push({
      title: `E2E - ${flowName}`,
      priority: flow.priority || 'High',
      rationale: flow.description || `Covers ${flow.coveredFeatures?.join(', ') || 'mapped features'}.`,
      steps: (flow.userJourney && flow.userJourney.length
        ? flow.userJourney.map((step) => ({ action: step, expected: 'The journey advances to the next code-supported state.' }))
        : [{ action: `Complete ${flowName}.`, expected: 'The end-to-end journey reaches the expected final state.' }]),
    });
  }

  const summary = inventory.summary ? `\n\nMapped feature inventory: ${inventory.summary}` : '';
  return {
    ...base,
    description: `${base.description || ''}${summary}`.trim(),
    businessRules: Array.from(businessRules),
    sourceFiles: Array.from(sourceFiles.values()),
    candidateScenarios,
  };
}

export async function draftRequirement(
  query: string,
  opts: { workspaceId?: string; userId?: string; role?: string; repoPath?: string; projectId?: string; appId?: string; applicationContextPrompt?: string; conversationContextPrompt?: string; requirementsOnly?: boolean; onProgress?: (label: string) => void } = {},
): Promise<RequirementDraftResult> {
  const ownerId = opts.userId || '';
  const cleanQuery = String(query || '').trim();
  if (!cleanQuery) throw new Error('A feature or section to test is required.');

  opts.onProgress?.('Starting requirement draft...');
  const { understanding, files } = await analyzeFeatureFromSource(cleanQuery, opts);
  opts.onProgress?.('Building code-grounded requirement review card...');
  const coverage = {
    sufficient: false,
    coveredBy: [],
    gaps: [],
    reasoning: 'Not evaluated for draft creation. Requirement drafts are grounded only in the selected codebase.',
  };
  const coverageStatus = 'unknown';
  const requirement = buildRequirementRecord(genId('REQ'), cleanQuery, understanding, files, coverageStatus, ownerId, { projectId: opts.projectId, appId: opts.appId });

  return {
    draft: true,
    requirement,
    understanding,
    coverage,
    existingLinks: [],
    generatedCases: [],
    searchedFiles: files,
    repoPath: opts.repoPath || resolveTargetRepo(),
  };
}

export async function confirmRequirementDraft(
  draft: Partial<RequirementDraftResult>,
  opts: { workspaceId?: string; userId?: string; role?: string; projectId?: string; appId?: string } = {},
): Promise<DiscoverResult> {
  const ownerId = opts.userId || '';
  const incoming = draft?.requirement || {};
  const requirementId = String((incoming as any).id || '').trim() || genId('REQ');
  const requirement = await Requirements.upsert({
    id: requirementId,
    title: String((incoming as any).title || 'Requirement'),
    description: String((incoming as any).description || ''),
    featureQuery: String((incoming as any).featureQuery || ''),
    businessRules: Array.isArray((incoming as any).businessRules) ? (incoming as any).businessRules : [],
    srsModules: Array.isArray((incoming as any).srsModules) ? (incoming as any).srsModules : [],
    dataPopulationNotes: String((incoming as any).dataPopulationNotes || ''),
    metadataRefs: Array.isArray((incoming as any).metadataRefs) ? (incoming as any).metadataRefs : [],
    uiSelectors: (incoming as any).uiSelectors && typeof (incoming as any).uiSelectors === 'object' ? (incoming as any).uiSelectors : {},
    sourceFiles: Array.isArray((incoming as any).sourceFiles) ? (incoming as any).sourceFiles : [],
    coverageStatus: String((incoming as any).coverageStatus || 'unknown'),
    status: String((incoming as any).status || 'Draft'),
    approvalState: String((incoming as any).approvalState || 'proposed'),
    proposedBy: String((incoming as any).proposedBy || 'Feature Analyst'),
    projectId: opts.projectId || (incoming as any).projectId || '',
    appId: opts.appId || (incoming as any).appId || '',
    ownerId,
  });

  const existingLinks: Array<{ caseId: string; title: string; reason: string }> = [];
  const allCaseIds = new Set((await Cases.list()).map((c: any) => c.id));
  for (const cb of draft?.existingLinks || []) {
    const caseId = String((cb as any).caseId || '').trim();
    if (!caseId || !allCaseIds.has(caseId)) continue;
    await RequirementLinks.upsert({ requirementId, caseId, linkType: 'existing', note: (cb as any).reason || '' });
    existingLinks.push({ caseId, title: (cb as any).title || '', reason: (cb as any).reason || '' });
  }

  if (!isPgEnabled()) persistDataInBackground('requirement draft confirm');
  addActivity(`Feature Analyst created requirement "${requirement.title}" from reviewed draft.`);

  return {
    requirement,
    understanding: draft?.understanding as FeatureUnderstanding,
    coverage: draft?.coverage || { sufficient: false, coveredBy: [], gaps: [], reasoning: '' },
    existingLinks,
    generatedCases: [],
    searchedFiles: draft?.searchedFiles || [],
    repoPath: draft?.repoPath || resolveTargetRepo(),
  };
}

export async function discoverRequirement(
  query: string,
  opts: { workspaceId?: string; userId?: string; role?: string; repoPath?: string; projectId?: string; appId?: string; applicationContextPrompt?: string; requirementsOnly?: boolean } = {},
): Promise<DiscoverResult> {
  const workspaceId = opts.workspaceId || 'default';
  const ownerId = opts.userId || '';
  const requirementsOnly = opts.requirementsOnly === true;
  const cleanQuery = String(query || '').trim();
  if (!cleanQuery) throw new Error('A feature or section to test is required.');

  // 1) Feature analyst + API & Metadata analyst — run in parallel for speed.
  // Pass websiteId (appId from scope) + ownerId so the analyst resolves credentials
  // from the per-workspace Website record, not from hardcoded env vars.
  const apiAnalystOpts = { ...opts, websiteId: opts.appId || undefined, ownerId };
  const [featureResult, apiAnalysis] = await Promise.all([
    analyzeFeatureFromSource(cleanQuery, opts),
    analyzeApiAndMetadataFromSource(cleanQuery, apiAnalystOpts).catch(() => undefined),
  ]);
  const { understanding, files } = featureResult;

  // 2) Reconcile against existing cases — only the discovering user's own cases when
  // they're a tester, so isolation holds (admins reconcile against everything).
  const existingCases = await existingCasesForRequirement(ownerId);
  const reconciliation = await reconcileRequirementCoverage(understanding, existingCases, opts, requirementsOnly);

  // 3) Persist the requirement.
  const requirementId = genId('REQ');
  const existingIds = new Set(existingCases.map((c) => c.id));
  const validCovered = (reconciliation.coverage.coveredBy || []).filter((cb) => existingIds.has(cb.id));

  // Create the gap cases (pending review) and remember them for linking.
  const generatedCases: Array<{ id: string; title: string }> = [];
  const proposedCases = requirementsOnly ? [] : (reconciliation.proposedCases || []);
  for (const pc of proposedCases) {
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
      projectId: opts.projectId || '',
      appId: opts.appId || '',
      ownerId,
    });
    generatedCases.push({ id: caseId, title: pc.title });
  }

  const coverageStatus = deriveCoverageStatus(
    reconciliation.coverage.sufficient,
    validCovered.length,
    generatedCases.length,
  );

  const requirement = await Requirements.upsert(buildRequirementRecord(requirementId, cleanQuery, understanding, files, coverageStatus, ownerId, { projectId: opts.projectId, appId: opts.appId }));

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
    repoPath: opts.repoPath || resolveTargetRepo(),
    apiAnalysis,
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
