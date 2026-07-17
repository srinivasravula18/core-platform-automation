/**
 * Phase 4 — evidence aggregation tests: run-diagnostics provider correlation, authority
 * precedence (observed over inferred), redaction, gaps, contradictions, and scoped lookup
 * (no global scan; cross-owner rejection).
 *
 * Convention: standalone tsx script. JSON mode; no model calls.
 */

// Hermetic: dotenv (override:true) can restore DATABASE_URL mid-import — DISABLE_POSTGRES wins.
process.env.DISABLE_POSTGRES = 'true';
delete process.env.DATABASE_URL;
delete process.env.PGHOST;
delete process.env.PGUSER;
delete process.env.PGDATABASE;

const { AgentRuns } = await import('../core/persistence');
const { Defects } = await import('../server/db/repository');
const { aggregateEvidence } = await import('../services/runtime/src/application/evidenceAggregator');
const { runEvidenceProvider } = await import('../services/runtime/src/adapters/runEvidenceProvider');
const { artifactStore } = await import('../services/runtime/src/adapters/artifactStore');
const { getRunEvidenceForConversation } = await import('../server/ai/tools/registry');

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ok   ${name}`);
  else { failures += 1; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

const conversationId = 'conv-evidence-1';
await AgentRuns.upsert({
  id: 'AGENT-EV-1', status: 'completed', conversationId, ownerId: 'u1', projectId: 'p1',
  generated_cases: [{ id: 'TC-E1', title: 'Create account' }, { id: 'TC-E2', title: 'Delete account' }],
  playwright_scripts: [{ id: 'SC-E1', title: 'Create account' }],
  evidence_screenshots: [{ url: '/evidence/shot-1.png', label: 'final state' }],
  execution_result: {
    ok: false, total: 2, passed: 1, failed: 1, skipped: 0,
    tests: [
      { title: 'Create account', status: 'passed', durationMs: 1200 },
      { title: 'Delete account', status: 'failed', durationMs: 900, error: 'locator timeout at row 3; password=SuperSecret123 leaked in log', tracePath: '/evidence/trace-2.zip' },
    ],
  },
  completed_at: '2026-07-17T10:00:00.000Z',
});
await Defects.upsert({ id: 'DEF-EV-1', title: 'Delete account leaves orphan rows', severity: 'High', sourceRunId: 'AGENT-EV-1', ownerId: 'u1' });

// ── 1. Run diagnostics bundle ───────────────────────────────────────────────────────────
{
  console.log('1. run diagnostics aggregation');
  const bundle = await aggregateEvidence({
    capability: 'run_diagnostics',
    subjectRefs: [{ type: 'run', id: 'AGENT-EV-1' }],
    scope: { workspaceId: 'default', ownerId: 'u1', projectId: 'p1' },
    conversationId,
  });
  check('aggregate present', bundle.items.some((i) => i.kind === 'execution_aggregate'));
  check('verdicts present', bundle.items.filter((i) => i.kind === 'test_verdict').length === 2);
  check('error detail present', bundle.items.some((i) => i.kind === 'error_detail'));
  check('screenshot ref present (no bytes)', bundle.items.some((i) => i.kind === 'screenshot' && i.payloadRef && !('body' in i)));
  check('linked defect present', bundle.items.some((i) => i.kind === 'defect' && i.summary.includes('DEF-EV-1')));
  check('no required gaps', bundle.gaps.length === 0, JSON.stringify(bundle.gaps));

  const errorItem = bundle.items.find((i) => i.kind === 'error_detail');
  check('error correlated to the failed case', errorItem?.entityRefs.some((r) => r.type === 'test_case' && r.label === 'Delete account') === true);
  check('observed facts extracted', bundle.observedFacts.length > 0);

  const firstAuthorities = bundle.items.map((i) => i.authority);
  const observedBlockEnds = firstAuthorities.lastIndexOf('observed');
  const recordedBlockStarts = firstAuthorities.indexOf('recorded');
  check('observed evidence ordered before recorded', recordedBlockStarts === -1 || observedBlockEnds < recordedBlockStarts || firstAuthorities.slice(0, recordedBlockStarts).every((a) => a === 'observed'));
  check('manifest lists providers + items', bundle.manifest.providers.includes('runEvidence') && bundle.manifest.itemIds.length === bundle.items.length);
}

// ── 2. Redaction ────────────────────────────────────────────────────────────────────────
{
  console.log('2. secret redaction in error details');
  const bundle = await aggregateEvidence({
    capability: 'run_diagnostics',
    subjectRefs: [{ type: 'run', id: 'AGENT-EV-1' }],
    scope: { workspaceId: 'default', ownerId: 'u1' },
    conversationId,
  });
  const error = bundle.items.find((i) => i.kind === 'error_detail');
  const text = JSON.stringify(error);
  check('error text carried', !!error && text.includes('locator timeout'));
  check('redaction marker recorded', (error?.redactions.length || 0) > 0);
}

// ── 3. Conversation fallback resolution (no explicit run ref) ───────────────────────────
{
  console.log('3. latest-run resolution via conversation');
  const bundle = await aggregateEvidence({
    capability: 'run_diagnostics',
    subjectRefs: [],
    scope: { workspaceId: 'default', ownerId: 'u1' },
    conversationId,
  });
  check('latest conversation run resolved', bundle.items.some((i) => i.source.ref?.includes('AGENT-EV-1')));
}

// ── 4. Gaps: missing run → explicit gap, not silence ────────────────────────────────────
{
  console.log('4. explicit gaps');
  const bundle = await aggregateEvidence({
    capability: 'run_diagnostics',
    subjectRefs: [],
    scope: { workspaceId: 'default', ownerId: 'u1' },
    conversationId: 'conv-with-no-runs',
  });
  check('required evidence gap reported', bundle.gaps.length >= 2, JSON.stringify(bundle.gaps.map((g) => g.requirement.kind)));
  check('no items fabricated', bundle.items.filter((i) => i.authority === 'observed').length === 0);
}

// ── 5. Scope: cross-owner run is not readable ───────────────────────────────────────────
{
  console.log('5. scoped lookup');
  const bundle = await aggregateEvidence({
    capability: 'run_diagnostics',
    subjectRefs: [{ type: 'run', id: 'AGENT-EV-1' }],
    scope: { workspaceId: 'default', ownerId: 'intruder' },
  });
  check('cross-owner subject yields nothing', !bundle.items.some((i) => i.kind === 'execution_aggregate'), JSON.stringify(bundle.items.map((i) => i.id)));
}

// ── 6. Contradiction retention ──────────────────────────────────────────────────────────
{
  console.log('6. contradictions retained');
  const conflicting = {
    supports: () => true,
    collect: async () => ([
      { id: 'x1', kind: 'test_verdict', authority: 'observed', source: { provider: 'p1' }, entityRefs: [{ type: 'test_case', id: 'TC-C' }], capturedAt: '', freshness: 'current', summary: 'TC-C: failed', facts: [], redactions: [] },
      { id: 'x2', kind: 'test_verdict', authority: 'observed', source: { provider: 'p2' }, entityRefs: [{ type: 'test_case', id: 'TC-C' }], capturedAt: '', freshness: 'current', summary: 'TC-C: passed', facts: [], redactions: [] },
    ]),
  } as any;
  const bundle = await aggregateEvidence({
    capability: 'run_diagnostics',
    subjectRefs: [],
    scope: { workspaceId: 'default', ownerId: 'u1' },
    requirements: [{ kind: 'test_verdict', required: true }],
    providers: [conflicting],
  });
  check('conflict detected and retained', bundle.contradictions.length === 1 && bundle.items.length === 2, JSON.stringify(bundle.contradictions));
}

// ── 7. Artifact store round trip ────────────────────────────────────────────────────────
{
  console.log('7. artifact store');
  const ref = await artifactStore.put({ log: 'step output', authorization: 'Bearer abc123' }, { kind: 'step_log' });
  const body: any = await artifactStore.get(ref);
  check('content-addressed ref returned', !!ref.contentHash);
  check('body round trips', body?.log === 'step output');
  check('secrets redacted at rest', body?.authorization === '[REDACTED]', JSON.stringify(body));
}

// ── 8. Legacy facade ────────────────────────────────────────────────────────────────────
{
  console.log('8. registry evidence facade');
  const bundle = await getRunEvidenceForConversation({ conversationId, scope: { userId: 'u1', projectId: 'p1' } });
  check('facade returns run bundle', bundle.items.some((i: any) => i.kind === 'execution_aggregate'));
  check('facade capability is run_diagnostics', bundle.capability === 'run_diagnostics');
}

console.log(failures === 0 ? '\nAll evidence-aggregation checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
