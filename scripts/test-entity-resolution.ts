/**
 * Phase 2 — deterministic entity-resolution matrix: pronouns, collections, ordinals,
 * recency, ellipsis, explicit IDs, ambiguity, and the "never bind repository files" rule.
 *
 * Pure-domain tests: no store, no model. Convention: standalone tsx script.
 */

const { createInitialSession, applySessionEvent } = await import('../services/runtime/src/domain/session');
const { extractReferenceExpressions, resolveReferences } = await import('../services/runtime/src/domain/entityResolver');

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ok   ${name}`);
  else { failures += 1; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

// Shared fixture: a session where a run generated 2 cases + 1 script and one case failed.
function sessionAfterRun() {
  let s = createInitialSession({ conversationId: 'c1', ownerId: 'u1', projectId: 'p1' });
  s = applySessionEvent(s, 'RunCompleted', {
    runRef: { type: 'run', id: 'AGENT-245' }, status: 'completed',
    caseRefs: [{ type: 'test_case', id: 'TC-1', label: 'Create record' }, { type: 'test_case', id: 'TC-2', label: 'Delete record' }],
    scriptRefs: [{ type: 'script', id: 'SC-1', label: 'Create record' }],
    failedCaseRefs: [{ type: 'test_case', id: 'TC-2', label: 'Delete record' }],
  });
  return s;
}

const T0 = '2026-07-17T10:00:00.000Z';
const T1 = '2026-07-17T11:00:00.000Z';
const T2 = '2026-07-17T12:00:00.000Z';

const runRefs = (runId: string) => [
  { entityType: 'run', entityId: runId, relation: 'latest', sourceRunId: runId, lastSeenAt: T1 },
  { entityType: 'test_case', entityId: 'TC-1', relation: 'generated', sourceRunId: runId, lastSeenAt: T1, label: 'Create record' },
  { entityType: 'test_case', entityId: 'TC-2', relation: 'generated', sourceRunId: runId, lastSeenAt: T1, label: 'Delete record' },
  { entityType: 'script', entityId: 'SC-1', relation: 'generated', sourceRunId: runId, lastSeenAt: T1, label: 'Create record' },
  { entityType: 'test_case', entityId: 'TC-2', relation: 'failed', sourceRunId: runId, lastSeenAt: T2, label: 'Delete record' },
];

// Repository-looking workspace records must NEVER win over run artifacts.
const packageJsonTrap = [
  { type: 'script', id: 'package.json', label: 'package.json', updatedAt: '2026-07-17T13:00:00.000Z' },
];

// ── 1. Expression extraction ────────────────────────────────────────────────────────────
{
  console.log('1. expression extraction');
  const exprs = extractReferenceExpressions('Why did they fail?');
  check('plural pronoun detected', exprs.some((e) => e.kind === 'pronoun' && e.plural));
  check('failure focus detected', exprs.some((e) => e.wantsFailed));

  const explicit = extractReferenceExpressions('show me AGENT-245 and TC-2');
  check('explicit ids extracted', explicit.filter((e) => e.kind === 'explicit_id').length === 2);
  check('id types inferred', explicit[0].expectedTypes[0] === 'run' && explicit[1].expectedTypes[0] === 'test_case');

  const rerun = extractReferenceExpressions('run them again');
  check('ellipsis detected', rerun.some((e) => e.kind === 'ellipsis'));

  const scripts = extractReferenceExpressions('open the scripts');
  check('collection with script type', scripts.some((e) => e.kind === 'collection' && e.expectedTypes.includes('script')));

  const recency = extractReferenceExpressions('what happened in the last run?');
  check('recency detected with run type', recency.some((e) => e.kind === 'recency' && e.expectedTypes.includes('run')));

  const ordinal = extractReferenceExpressions('show the second case');
  check('ordinal detected', ordinal.some((e) => e.kind === 'ordinal' && e.ordinal === 2));
}

// ── 2. "they" after a failed run binds the failed collection ────────────────────────────
{
  console.log('2. failure pronoun binding');
  const bindings = resolveReferences({
    utterance: 'Why did they fail?',
    session: sessionAfterRun(),
    conversationRefs: runRefs('AGENT-245') as any,
    workspaceRecords: [],
  });
  const pronoun = bindings.find((b) => b.expressionKind === 'pronoun');
  check('pronoun resolves', pronoun?.status === 'resolved', JSON.stringify(pronoun));
  check('binds ONLY the failed case', pronoun?.resolved.length === 1 && pronoun?.resolved[0].id === 'TC-2',
    JSON.stringify(pronoun?.resolved));
}

// ── 3. "the scripts" binds run artifacts, never package.json ────────────────────────────
{
  console.log('3. scripts collection vs repository trap');
  const bindings = resolveReferences({
    utterance: 'show me the scripts',
    session: sessionAfterRun(),
    conversationRefs: runRefs('AGENT-245') as any,
    workspaceRecords: packageJsonTrap as any,
  });
  const coll = bindings.find((b) => b.expressionKind === 'collection');
  check('collection resolves', coll?.status === 'resolved');
  check('binds the generated script', coll?.resolved.some((r) => r.id === 'SC-1') === true);
  check('never binds package.json', coll?.resolved.every((r) => r.id !== 'package.json') === true, JSON.stringify(coll?.resolved));
}

// ── 4. "run again" targets the prior run ────────────────────────────────────────────────
{
  console.log('4. re-run ellipsis');
  const bindings = resolveReferences({
    utterance: 'run it again',
    session: sessionAfterRun(),
    conversationRefs: runRefs('AGENT-245') as any,
    workspaceRecords: [],
  });
  const ellipsis = bindings.find((b) => b.expressionKind === 'ellipsis');
  check('ellipsis resolves', ellipsis?.status === 'resolved');
  check('targets prior run graph', !!ellipsis && (ellipsis.resolved.some((r) => r.id === 'AGENT-245') || ellipsis.resolved.every((r) => ['TC-1', 'TC-2', 'SC-1'].includes(r.id))),
    JSON.stringify(ellipsis?.resolved));
}

// ── 5. Selected entity outranks everything ──────────────────────────────────────────────
{
  console.log('5. selected-entity priority');
  let s = sessionAfterRun();
  s = applySessionEvent(s, 'EntitySelected', { entity: { type: 'test_case', id: 'TC-1', label: 'Create record' } });
  const bindings = resolveReferences({
    utterance: 'explain it',
    session: s,
    conversationRefs: runRefs('AGENT-245') as any,
    workspaceRecords: [],
  });
  const pronoun = bindings.find((b) => b.expressionKind === 'pronoun');
  check('singular pronoun uses selection', pronoun?.status === 'resolved' && pronoun.resolved[0]?.id === 'TC-1', JSON.stringify(pronoun?.resolved));
  check('provenance is selected tier', pronoun?.provenance[0]?.tier === 'selected_entity');
}

// ── 6. Explicit IDs bind directly ───────────────────────────────────────────────────────
{
  console.log('6. explicit id binding');
  const bindings = resolveReferences({
    utterance: 'compare AGENT-245 with TC-2',
    session: sessionAfterRun(),
    conversationRefs: runRefs('AGENT-245') as any,
    workspaceRecords: [],
  });
  const ids = bindings.filter((b) => b.expressionKind === 'explicit_id');
  check('both ids bind', ids.length === 2 && ids.every((b) => b.status === 'resolved'));
  check('run id binds run type', ids[0].resolved[0].type === 'run');
}

// ── 7. Two equal-priority collections → ambiguous (never guess) ─────────────────────────
{
  console.log('7. ambiguity');
  const twoCollections = [
    { entityType: 'script', entityId: 'SC-9', relation: 'failed', sourceRunId: 'AGENT-300', lastSeenAt: T2, label: 'checkout flow' },
    { entityType: 'defect', entityId: 'DEF-7', relation: 'failed', sourceRunId: 'AGENT-301', lastSeenAt: T2, label: 'security review defect' },
  ];
  const bindings = resolveReferences({
    utterance: 'fix them',
    session: createInitialSession({ conversationId: 'c-ambig' }),
    conversationRefs: twoCollections as any,
    workspaceRecords: [],
  });
  const target = bindings.find((b) => b.expressionKind === 'ellipsis');
  check('equal-priority collections are ambiguous', target?.status === 'ambiguous', JSON.stringify(target));
  check('candidates are traced for clarification', (target?.candidatesConsidered.length || 0) >= 2);
}

// ── 8. Recency: newer reference wins deterministically ──────────────────────────────────
{
  console.log('8. recency ordering');
  const refs = [
    { entityType: 'run', entityId: 'AGENT-OLD', relation: 'latest', sourceRunId: 'AGENT-OLD', lastSeenAt: T0 },
    { entityType: 'run', entityId: 'AGENT-NEW', relation: 'latest', sourceRunId: 'AGENT-NEW', lastSeenAt: T2 },
  ];
  const bindings = resolveReferences({
    utterance: 'summarize the last run',
    session: createInitialSession({ conversationId: 'c-rec' }),
    conversationRefs: refs as any,
    workspaceRecords: [],
  });
  const recency = bindings.find((b) => b.expressionKind === 'recency');
  check('newest run wins', recency?.status === 'resolved' && recency.resolved[0]?.id === 'AGENT-NEW', JSON.stringify(recency?.resolved));
}

// ── 9. No referent at all → unresolved, not invented ────────────────────────────────────
{
  console.log('9. empty context');
  const bindings = resolveReferences({
    utterance: 'why did they fail?',
    session: createInitialSession({ conversationId: 'c-empty' }),
    conversationRefs: [],
    workspaceRecords: [],
  });
  const pronoun = bindings.find((b) => b.expressionKind === 'pronoun');
  check('nothing to bind → unresolved', pronoun?.status === 'unresolved', JSON.stringify(pronoun));
  check('nothing fabricated', (pronoun?.resolved.length || 0) === 0);
}

console.log(failures === 0 ? '\nAll entity-resolution checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
