/**
 * Phase A tests — Evidence Registry + Provenance.
 *
 * Convention: this repo has no jest/vitest; tests are standalone tsx scripts (see eval:*). Run with:
 *   npx tsx scripts/test-evidence-registry.ts       (or: npm run test:evidence)
 * Exits 0 if all pass, 1 on first failure. No DB/network/browser required.
 *
 * Covers: provenance mapping + the static-never-verified-live invariant; registry record/query/
 * upsert/summary; the "metadata not payload" guarantee; and a backward-compatibility regression
 * proving recordEvidence never disturbs the existing run.* fields it references.
 */

import {
  PROVENANCE,
  isLiveSource,
  normalizeConfidence,
  mapSelectorEvidenceType,
  provenanceLabel,
} from '../server/features/agent/evidence/provenance';
import {
  EvidenceRegistry,
  recordEvidence,
  getRunRegistry,
  estimateTokens,
} from '../server/features/agent/evidence/registry';
import { extractSelectorMap } from '../server/features/agent/selectorMap';
import path from 'path';

let passed = 0;
let failed = 0;
function ok(cond: boolean, name: string) {
  if (cond) { passed += 1; console.log(`  ✓ ${name}`); }
  else { failed += 1; console.error(`  ✗ ${name}`); }
}
function eq(a: unknown, b: unknown, name: string) {
  ok(JSON.stringify(a) === JSON.stringify(b), `${name} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
}

// ---------------------------------------------------------------------------
console.log('Provenance');
// The core invariant: a static-source scan can NEVER be labelled live-verified.
eq(normalizeConfidence(PROVENANCE.STATIC_SOURCE, 'verified-live'), 'verified-static', 'static + verified-live downgrades to verified-static');
eq(normalizeConfidence(PROVENANCE.LIVE_DOM, 'verified-live'), 'verified-live', 'live + verified-live stays verified-live');
eq(normalizeConfidence(PROVENANCE.STATIC_SOURCE, 'unverified'), 'unverified', 'static + unverified unchanged');

ok(isLiveSource(PROVENANCE.LIVE_DOM), 'LIVE_DOM is a live source');
ok(isLiveSource(PROVENANCE.MCP), 'MCP is a live source');
ok(isLiveSource(PROVENANCE.API), 'API is a live source');
ok(!isLiveSource(PROVENANCE.STATIC_SOURCE), 'STATIC_SOURCE is NOT a live source');

eq(mapSelectorEvidenceType('live-dom-verified'), { source: PROVENANCE.LIVE_DOM, confidence: 'verified-live' }, 'map live-dom-verified');
eq(mapSelectorEvidenceType('inspection'), { source: PROVENANCE.LIVE_DOM, confidence: 'verified-live' }, 'map inspection');
eq(mapSelectorEvidenceType('live-dom-pool'), { source: PROVENANCE.LIVE_DOM, confidence: 'inferred' }, 'map live-dom-pool');
eq(mapSelectorEvidenceType('none'), { source: PROVENANCE.STATIC_SOURCE, confidence: 'unverified' }, 'map none');
eq(mapSelectorEvidenceType(undefined), { source: PROVENANCE.STATIC_SOURCE, confidence: 'unverified' }, 'map undefined');
eq(mapSelectorEvidenceType('totally-unknown-tag'), { source: PROVENANCE.STATIC_SOURCE, confidence: 'unverified' }, 'map unknown tag → static/unverified (conservative)');
ok(provenanceLabel(PROVENANCE.STATIC_SOURCE, 'verified-live').includes('verified-static'), 'label reflects the downgrade');

// ---------------------------------------------------------------------------
console.log('estimateTokens');
eq(estimateTokens(null), 0, 'null → 0 tokens');
eq(estimateTokens(''), 0, 'empty string → 0 tokens');
ok(estimateTokens('a'.repeat(400)) === 100, '400 chars → ~100 tokens');
ok(estimateTokens({ a: 1, b: [1, 2, 3] }) > 0, 'object → positive estimate');
ok(estimateTokens('x'.repeat(1000)) > estimateTokens('x'.repeat(100)), 'monotonic in length');

// ---------------------------------------------------------------------------
console.log('EvidenceRegistry');
{
  const reg = new EvidenceRegistry();
  const rec = reg.record({
    id: 'dom', type: 'dom', status: 'present', source: PROVENANCE.LIVE_DOM,
    confidence: 'verified-live', producer: 'DOMExplorer',
    payload: { elements: [{ a: 1 }, { b: 2 }, { c: 3 }] }, dependencies: ['inspection'],
    validationState: 'passed', payloadRef: 'dom_exploration',
  });
  eq(rec.artifactCount, 3, 'artifactCount derived from payload.elements');
  ok(rec.tokenEstimate > 0, 'tokenEstimate derived');
  ok(!!rec.timestamp, 'timestamp populated');
  ok(!('payload' in (rec as any)), 'record does NOT store the payload (only a reference)');
  eq(rec.payloadRef, 'dom_exploration', 'payloadRef preserved');
  eq(reg.get('dom')?.status, 'present', 'get by id');
  eq(reg.getByType('dom').length, 1, 'getByType');

  // Upsert: same id twice keeps ONE record, latest wins.
  reg.record({ id: 'dom', type: 'dom', status: 'degraded', source: PROVENANCE.LIVE_DOM, confidence: 'inferred', producer: 'DOMExplorer' });
  eq(reg.all().length, 1, 'upsert by id keeps a single record');
  eq(reg.get('dom')?.status, 'degraded', 'upsert updates in place');

  // Invariant enforced at record() time too.
  const staticRec = reg.record({ id: 'selector_registry', type: 'selector', status: 'present', source: PROVENANCE.STATIC_SOURCE, confidence: 'verified-live', producer: 'SelectorRegistry' });
  eq(staticRec.confidence, 'verified-static', 'record() enforces static-never-verified-live');

  const sum = reg.summary();
  eq(sum.total, 2, 'summary.total');
  eq(sum.staticSources, 1, 'summary.staticSources counts the static selector registry');
  ok(sum.totalTokenEstimate >= 0, 'summary.totalTokenEstimate present');

  // Snapshot round-trips.
  const snap = reg.toJSON();
  eq(snap.version, '1', 'snapshot version');
  const rehydrated = new EvidenceRegistry(snap);
  eq(rehydrated.all().length, 2, 'rehydrated from snapshot');
}

// ---------------------------------------------------------------------------
console.log('recordEvidence — backward-compatibility regression');
{
  // A run already carrying its existing ad-hoc fields.
  const existingDom = { url: 'http://x', elements: [{ a: 1 }, { b: 2 }], coverage: { total_extracted: 2, verified: 2 } };
  const run: any = { id: 'run-1', dom_exploration: existingDom, some_other_field: 'keep me' };

  const rec = recordEvidence(run, {
    id: 'dom', type: 'dom', status: 'present', source: PROVENANCE.LIVE_DOM,
    confidence: 'verified-live', producer: 'DOMExplorer',
    payload: existingDom.elements, artifactCount: 2, payloadRef: 'dom_exploration',
  });
  ok(!!rec, 'recordEvidence returns a record');
  ok(run.dom_exploration === existingDom, 'existing run.dom_exploration is the SAME reference (untouched)');
  eq(run.some_other_field, 'keep me', 'unrelated run fields are preserved');
  ok(!!run.evidence_registry, 'run.evidence_registry snapshot is created');
  eq(run.evidence_registry.version, '1', 'snapshot version on run');

  const back = getRunRegistry(run);
  eq(back.get('dom')?.payloadRef, 'dom_exploration', 'consumer can read the record back via getRunRegistry');
  ok(!JSON.stringify(run.evidence_registry).includes('"a":1'), 'snapshot does NOT duplicate the payload contents');

  // Second producer records without clobbering the first.
  recordEvidence(run, { id: 'metadata', type: 'metadata', status: 'present', source: PROVENANCE.API, confidence: 'verified-live', producer: 'MetadataFetch', artifactCount: 5 });
  eq(getRunRegistry(run).all().length, 2, 'second record accumulates, does not clobber');

  // Never throws on a malformed run.
  eq(recordEvidence(null as any, { id: 'x', type: 'dom', status: 'missing', source: PROVENANCE.LIVE_DOM, confidence: 'unverified', producer: 'x' }), null, 'recordEvidence(null) returns null, no throw');
}

// ---------------------------------------------------------------------------
console.log('selectorMap provenance tag');
{
  // Scan this repo's scripts dir: no UI selectors, but provenance must be tagged STATIC_SOURCE.
  const map = extractSelectorMap(path.resolve(process.cwd(), 'scripts'), { maxFiles: 50 });
  eq(map.provenance, PROVENANCE.STATIC_SOURCE, 'extractSelectorMap tags provenance STATIC_SOURCE');
  ok(typeof map.fileCount === 'number', 'selectorMap still returns fileCount (shape preserved)');
}

// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
