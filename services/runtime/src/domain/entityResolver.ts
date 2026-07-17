/**
 * Deterministic entity resolver (Phase 2) — binds reference expressions to concrete
 * scoped entities BEFORE routing. Pure module: candidates come in via ResolverInput;
 * ranking is lexicographic (never a learned score); ties return "ambiguous" instead
 * of guessing. Repository discovery is intentionally NOT a tier here (capabilities
 * may enable it later, plan §13.2 step 4 last tier).
 */

import type {
  CandidateTrace,
  EntityRef,
  EntityType,
  ReferenceBinding,
  ReferenceExpressionKind,
  ResolutionProvenance,
  SessionContext,
} from './types';

/* ---------- lexicon ---------- */

/** Head-noun → expected entity types (versioned domain lexicon, plan §13.2 step 2). */
const NOUN_TYPES: Array<{ re: RegExp; types: EntityType[] }> = [
  { re: /\b(test\s*cases?|cases?)\b/i, types: ['test_case'] },
  { re: /\b(scripts?|playwright\s*scripts?)\b/i, types: ['script'] },
  { re: /\b(tests?)\b/i, types: ['test_case', 'script'] },
  { re: /\b(runs?|executions?)\b/i, types: ['run'] },
  { re: /\b(defects?|bugs?|issues?)\b/i, types: ['defect'] },
  { re: /\b(reviews?)\b/i, types: ['review'] },
  { re: /\b(reports?)\b/i, types: ['report'] },
  { re: /\b(requirements?)\b/i, types: ['requirement'] },
  { re: /\b(suites?)\b/i, types: ['test_suite'] },
  { re: /\b(plans?)\b/i, types: ['test_plan'] },
  { re: /\b(failures?|failed)\b/i, types: ['test_case', 'script'] },
];

const EXPLICIT_ID_RE = /\b(?:AGENT|TC|SCRIPT|DEF|RUN|REQ|PLAN|SUITE|CASE|REP|WEB)-[A-Za-z0-9][A-Za-z0-9-]*\b/g;
const PLURAL_PRONOUN_RE = /\b(them|they|those|these)\b/i;
const SINGULAR_PRONOUN_RE = /\b(it|that one|this one)\b/i;
const RECENCY_RE = /\b(last|latest|previous|prior|recent|earlier)\s+(run|execution|review|report|case|script|defect|test)/i;
const ELLIPSIS_RE = /\b(run (it |them |these |those )?again|re-?run|try again|fix (them|it|those|these)|do it again|retry)\b/i;
const ORDINAL_RE = /\b(first|second|third|fourth|fifth|1st|2nd|3rd|4th|5th)\s+(one|case|script|test|run|defect)\b/i;

const ID_PREFIX_TYPES: Array<{ prefix: RegExp; type: EntityType }> = [
  { prefix: /^(AGENT|RUN)/i, type: 'run' },
  { prefix: /^(TC|CASE)/i, type: 'test_case' },
  { prefix: /^SCRIPT/i, type: 'script' },
  { prefix: /^DEF/i, type: 'defect' },
  { prefix: /^REQ/i, type: 'requirement' },
  { prefix: /^PLAN/i, type: 'test_plan' },
  { prefix: /^SUITE/i, type: 'test_suite' },
  { prefix: /^REP/i, type: 'report' },
];

export function entityTypeForId(id: string): EntityType | null {
  for (const m of ID_PREFIX_TYPES) if (m.prefix.test(id)) return m.type;
  return null;
}

/* ---------- expression extraction ---------- */

export interface ReferenceExpression {
  expression: string;
  kind: ReferenceExpressionKind;
  expectedTypes: EntityType[];
  plural: boolean;
  wantsFailed: boolean;
  ordinal?: number;
}

const ORDINAL_VALUES: Record<string, number> = { first: 1, '1st': 1, second: 2, '2nd': 2, third: 3, '3rd': 3, fourth: 4, '4th': 4, fifth: 5, '5th': 5 };

function nounTypes(text: string): EntityType[] {
  for (const n of NOUN_TYPES) if (n.re.test(text)) return n.types;
  return [];
}

/** Deterministic expression scan; explicit IDs always win over anaphora on the same span. */
export function extractReferenceExpressions(utterance: string): ReferenceExpression[] {
  const text = String(utterance || '');
  const out: ReferenceExpression[] = [];
  const wantsFailed = /\b(fail(ed|ing|ures?)?|broke|broken|error(s|ed)?)\b/i.test(text);

  for (const match of text.matchAll(EXPLICIT_ID_RE)) {
    const id = match[0];
    const type = entityTypeForId(id);
    out.push({ expression: id, kind: 'explicit_id', expectedTypes: type ? [type] : [], plural: false, wantsFailed: false });
  }

  const ordinal = text.match(ORDINAL_RE);
  if (ordinal) {
    out.push({
      expression: ordinal[0], kind: 'ordinal',
      expectedTypes: nounTypes(ordinal[2]) .length ? nounTypes(ordinal[2]) : nounTypes(text),
      plural: false, wantsFailed, ordinal: ORDINAL_VALUES[ordinal[1].toLowerCase()] || 1,
    });
  }

  const recency = text.match(RECENCY_RE);
  if (recency) {
    out.push({ expression: recency[0], kind: 'recency', expectedTypes: nounTypes(recency[2]), plural: false, wantsFailed });
  }

  const ellipsis = text.match(ELLIPSIS_RE);
  if (ellipsis) {
    out.push({ expression: ellipsis[0], kind: 'ellipsis', expectedTypes: nounTypes(text).length ? nounTypes(text) : ['run', 'test_case', 'script', 'defect'], plural: true, wantsFailed: wantsFailed || /fix/i.test(ellipsis[0]) });
  }

  const pluralPronoun = text.match(PLURAL_PRONOUN_RE);
  if (pluralPronoun && !ellipsis) {
    out.push({ expression: pluralPronoun[0], kind: 'pronoun', expectedTypes: nounTypes(text), plural: true, wantsFailed });
  }

  const singularPronoun = text.match(SINGULAR_PRONOUN_RE);
  if (singularPronoun && !ellipsis && !out.some((e) => e.kind === 'pronoun')) {
    out.push({ expression: singularPronoun[0], kind: 'pronoun', expectedTypes: nounTypes(text), plural: false, wantsFailed });
  }

  // Bare definite collections: "the cases", "the scripts", "the tests", "my defects".
  const collection = text.match(/\b(?:the|my|our|all)\s+(?:failed\s+|failing\s+)?(test\s*cases?|cases?|scripts?|tests?|defects?|requirements?|reports?)\b/i);
  if (collection && !out.some((e) => e.kind === 'pronoun' && e.plural)) {
    out.push({ expression: collection[0], kind: 'collection', expectedTypes: nounTypes(collection[1]), plural: true, wantsFailed });
  }

  return out;
}

/* ---------- candidates ---------- */

/** A conversation-recency index row (subset of the stored shape the resolver needs). */
export interface RecencyRef {
  entityType: string;
  entityId: string;
  relation: string;
  sourceRunId: string;
  lastSeenAt: string;
  label?: string;
  appId?: string;
  projectId?: string;
}

/** Compact scoped workspace record (from workspaceEntityReader). */
export interface WorkspaceRecord {
  type: EntityType;
  id: string;
  label: string;
  updatedAt: string;
  appId?: string;
  projectId?: string;
}

export interface ResolverInput {
  utterance: string;
  session: SessionContext;
  conversationRefs: RecencyRef[];
  workspaceRecords: WorkspaceRecord[];
  explicitSelections?: EntityRef[];
}

interface Candidate {
  ref: EntityRef;
  tier: ResolutionProvenance['tier'];
  tierRank: number;
  runRelated: boolean;
  failed: boolean;
  recency: string;
  collectionKey?: string;
  sourceRunId?: string;
}

/** Deterministic type preference for same-run tie-breaks: cases are the user-facing artifact. */
const TYPE_PREFERENCE: Record<string, number> = { test_case: 0, script: 1, run: 2, defect: 3 };
function typeRank(t: string): number { return TYPE_PREFERENCE[t] ?? 9; }

const TIER_RANK: Record<ResolutionProvenance['tier'], number> = {
  selected_entity: 0, artifact_set: 1, latest_run: 2, conversation_recency: 3, workspace: 4, repository: 5,
};

function toRef(type: EntityType, id: string, label?: string): EntityRef {
  return { type, id, ...(label ? { label } : {}) };
}

/** Reference priority tiers, plan §13.3 — repository discovery deliberately absent. */
function generateCandidates(input: ResolverInput, expectedTypes: EntityType[], wantsFailed: boolean): Candidate[] {
  const { session, conversationRefs, workspaceRecords } = input;
  const typeOk = (t: string) => expectedTypes.length === 0 || expectedTypes.includes(t as EntityType);
  const out: Candidate[] = [];
  const latestRunId = session.latestRun?.id || session.currentExecution?.id || '';

  const selected = input.explicitSelections?.[0] || session.currentSelectedEntity;
  if (selected && typeOk(selected.type)) {
    out.push({ ref: selected, tier: 'selected_entity', tierRank: 0, runRelated: selected.id === latestRunId, failed: false, recency: '9999' });
  }

  if (session.latestTestCases && typeOk('test_case')) {
    for (const id of session.latestTestCases.ids) {
      out.push({ ref: toRef('test_case', id), tier: 'artifact_set', tierRank: 1, runRelated: true, failed: false, recency: session.updatedAt, collectionKey: `cases:${session.latestTestCases.sourceRunId || ''}`, sourceRunId: session.latestTestCases.sourceRunId });
    }
  }
  if (session.latestScripts && typeOk('script')) {
    for (const id of session.latestScripts.ids) {
      out.push({ ref: toRef('script', id), tier: 'artifact_set', tierRank: 1, runRelated: true, failed: false, recency: session.updatedAt, collectionKey: `scripts:${session.latestScripts.sourceRunId || ''}`, sourceRunId: session.latestScripts.sourceRunId });
    }
  }

  if (session.latestRun && typeOk('run')) {
    out.push({ ref: session.latestRun, tier: 'latest_run', tierRank: 2, runRelated: true, failed: false, recency: session.updatedAt });
  }
  if (session.currentExecution && typeOk('run') && session.currentExecution.id !== session.latestRun?.id) {
    out.push({ ref: session.currentExecution, tier: 'latest_run', tierRank: 2, runRelated: true, failed: false, recency: session.updatedAt });
  }

  for (const r of conversationRefs) {
    if (!typeOk(r.entityType)) continue;
    if (wantsFailed && r.relation !== 'failed') continue;
    out.push({
      ref: toRef(r.entityType as EntityType, r.entityId, r.label),
      tier: 'conversation_recency', tierRank: 3,
      runRelated: !!latestRunId && r.sourceRunId === latestRunId,
      failed: r.relation === 'failed',
      recency: r.lastSeenAt,
      collectionKey: `${r.relation}:${r.entityType}:${r.sourceRunId || ''}`,
      sourceRunId: r.sourceRunId || undefined,
    });
  }

  for (const w of workspaceRecords) {
    if (!typeOk(w.type)) continue;
    if (wantsFailed) continue; // failure knowledge only exists in run/conversation tiers
    out.push({ ref: toRef(w.type, w.id, w.label), tier: 'workspace', tierRank: 4, runRelated: false, failed: false, recency: w.updatedAt });
  }

  return out;
}

/* ---------- ranking ---------- */

/** Lexicographic order: failure focus first (when asked), then tier, run relationship, recency, stable ID. */
function rank(a: Candidate, b: Candidate, wantsFailed: boolean): number {
  // "Why did they fail?" must bind the failed collection, not every generated artifact.
  if (wantsFailed && a.failed !== b.failed) return a.failed ? -1 : 1;
  if (a.tierRank !== b.tierRank) return a.tierRank - b.tierRank;
  if (a.runRelated !== b.runRelated) return a.runRelated ? -1 : 1;
  const rec = String(b.recency).localeCompare(String(a.recency));
  if (rec !== 0) return rec;
  const type = typeRank(a.ref.type) - typeRank(b.ref.type);
  if (type !== 0) return type;
  return a.ref.id.localeCompare(b.ref.id);
}

/**
 * Meaningful-dimension tie: same tier, same failed/run flags, same recency, different entity.
 * Two collections from the SAME run are one coherent failure viewed twice (case vs script) —
 * type preference decides deterministically instead of asking the user.
 */
function tied(a: Candidate, b: Candidate): boolean {
  if (a.sourceRunId && a.sourceRunId === b.sourceRunId) return false;
  return a.tierRank === b.tierRank && a.failed === b.failed && a.runRelated === b.runRelated
    && String(a.recency) === String(b.recency) && a.ref.id !== b.ref.id
    && (a.collectionKey || '') !== (b.collectionKey || '');
}

/* ---------- resolution ---------- */

function dedupe(candidates: Candidate[], wantsFailed: boolean): Candidate[] {
  const seen = new Map<string, Candidate>();
  for (const c of candidates) {
    const key = `${c.ref.type}:${c.ref.id}`;
    const prior = seen.get(key);
    // Keep the rank-preferred copy so a failed-relation ref is not shadowed by a lower tier.
    if (!prior || rank(c, prior, wantsFailed) < 0) seen.set(key, c);
  }
  return [...seen.values()];
}

function traceOf(candidates: Candidate[], accepted: Set<string>): CandidateTrace[] {
  return candidates.slice(0, 25).map((c) => ({
    candidate: c.ref, tier: c.tier,
    accepted: accepted.has(`${c.ref.type}:${c.ref.id}`),
    reason: accepted.has(`${c.ref.type}:${c.ref.id}`) ? 'top-ranked' : 'outranked',
  }));
}

function bindExpression(input: ResolverInput, expr: ReferenceExpression): ReferenceBinding {
  const base: ReferenceBinding = {
    expression: expr.expression,
    expressionKind: expr.kind,
    expectedTypes: expr.expectedTypes,
    resolved: [],
    status: 'unresolved',
    provenance: [],
    candidatesConsidered: [],
  };

  // Explicit IDs bind directly if the entity is known anywhere in scope; unknown → unresolved.
  if (expr.kind === 'explicit_id') {
    const id = expr.expression;
    const known =
      input.conversationRefs.find((r) => r.entityId === id) ? toRef((input.conversationRefs.find((r) => r.entityId === id)!.entityType) as EntityType, id) :
      input.workspaceRecords.find((w) => w.id === id) ? toRef(input.workspaceRecords.find((w) => w.id === id)!.type, id) :
      input.session.latestRun?.id === id ? input.session.latestRun :
      input.session.currentExecution?.id === id ? input.session.currentExecution : null;
    if (known) {
      return { ...base, resolved: [known], status: 'resolved', provenance: [{ tier: 'conversation_recency', detail: 'explicit id' }] };
    }
    const type = entityTypeForId(id);
    return type
      ? { ...base, resolved: [toRef(type, id)], status: 'resolved', provenance: [{ tier: 'workspace', detail: 'explicit id (unverified)' }] }
      : base;
  }

  const candidates = dedupe(generateCandidates(input, expr.expectedTypes, expr.wantsFailed), expr.wantsFailed)
    .sort((a, b) => rank(a, b, expr.wantsFailed));
  if (!candidates.length) return base;

  if (expr.plural) {
    // Collections resolve as one coherent group (same collectionKey) — never a grab-bag.
    const groups = new Map<string, Candidate[]>();
    for (const c of candidates) {
      const key = c.collectionKey || `single:${c.ref.type}:${c.ref.id}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(c);
    }
    const ordered = [...groups.values()].sort((a, b) => rank(a[0], b[0], expr.wantsFailed));
    const top = ordered[0];
    const second = ordered[1];
    if (second && tied(top[0], second[0])) {
      const accepted = new Set<string>();
      return { ...base, status: 'ambiguous', candidatesConsidered: traceOf([...top, ...second], accepted) };
    }
    const accepted = new Set(top.map((c) => `${c.ref.type}:${c.ref.id}`));
    return {
      ...base,
      resolved: top.map((c) => c.ref),
      status: 'resolved',
      provenance: [{ tier: top[0].tier }],
      candidatesConsidered: traceOf(candidates, accepted),
    };
  }

  const top = candidates[0];
  const second = candidates[1];
  if (expr.kind === 'ordinal' && expr.ordinal) {
    const pick = candidates.filter((c) => c.tier === top.tier)[expr.ordinal - 1];
    if (!pick) return { ...base, status: 'unresolved', candidatesConsidered: traceOf(candidates, new Set()) };
    const accepted = new Set([`${pick.ref.type}:${pick.ref.id}`]);
    return { ...base, resolved: [pick.ref], status: 'resolved', provenance: [{ tier: pick.tier, detail: `ordinal ${expr.ordinal}` }], candidatesConsidered: traceOf(candidates, accepted) };
  }
  if (second && tied(top, second)) {
    return { ...base, status: 'ambiguous', candidatesConsidered: traceOf(candidates, new Set()) };
  }
  const accepted = new Set([`${top.ref.type}:${top.ref.id}`]);
  return { ...base, resolved: [top.ref], status: 'resolved', provenance: [{ tier: top.tier }], candidatesConsidered: traceOf(candidates, accepted) };
}

/** Resolve every reference expression in the utterance against session + indexes. */
export function resolveReferences(input: ResolverInput): ReferenceBinding[] {
  const expressions = extractReferenceExpressions(input.utterance);
  return expressions.map((expr) => bindExpression(input, expr));
}
