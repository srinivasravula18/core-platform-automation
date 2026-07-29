/**
 * Unit tests for the Phase 4 semantic memory + decision gate (server/agent-core/memory).
 * Proves the anti-inversion invariant (write-key === read-key so recall matches) and that a selector
 * proven broken in prior runs provably CHANGES a later run's branch (the point of memory).
 *   npx tsx scripts/test-agent-memory.ts
 * Pure — in-memory store, no DB.
 */
import { InMemoryMemoryStore, scopeKeyOf } from '../server/agent-core/memory/store';
import {
  recordSelectorOutcome, selectorHealth, isSelectorKnownBroken,
  recordProvenApproach, preferredApproach, recallRelevant,
} from '../server/agent-core/memory/gate';

let passed = 0, failed = 0;
const ok = (c: boolean, n: string) => { if (c) { passed++; console.log(`  ✓ ${n}`); } else { failed++; console.error(`  ✗ ${n}`); } };
const eq = (a: unknown, b: unknown, n: string) => ok(JSON.stringify(a) === JSON.stringify(b), `${n} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

const scope = { projectId: 'P1', appId: 'A1', ownerId: 'U1' };

async function main() {
  console.log('Store — write-key === read-key (anti-inversion)');
  {
    const store = new InMemoryMemoryStore();
    await store.write({ scope, kind: 'episodic', subject: 'button.save', outcome: 'pass' });
    const recalled = await store.recall({ scope, kind: 'episodic', subject: 'button.save' });
    eq(recalled.length, 1, 'a written record is recalled by the SAME (scope, kind, subject) key');
    eq(scopeKeyOf(scope), 'P1::A1::U1', 'scope key is deterministic');

    // A DIFFERENT scope must not see it (isolation).
    const other = await store.recall({ scope: { projectId: 'P2' }, kind: 'episodic', subject: 'button.save' });
    eq(other.length, 0, 'records are scoped — another project cannot recall them');
  }

  console.log('Gate — a selector broken in prior runs CHANGES the next run (the point of memory)');
  {
    const store = new InMemoryMemoryStore();
    const flaky = 'css=.dynamic-id-123';
    // Run N-2, N-1: it failed/flaked. Run N-1: also failed.
    await recordSelectorOutcome(scope, flaky, 'fail', { store, runId: 'run-1' });
    await recordSelectorOutcome(scope, flaky, 'flaky', { store, runId: 'run-2' });

    const health = await selectorHealth(scope, flaky, { store });
    eq(health.failures, 1, 'failures counted');
    eq(health.flakes, 1, 'flakes counted');
    ok(health.failureRate >= 0.99, 'failure rate reflects the bad history');
    ok(health.knownBroken, 'the selector is judged known-broken');

    const avoid = await isSelectorKnownBroken(scope, flaky, { store });
    ok(avoid === true, 'BRANCH INPUT: run N is told to AVOID the selector that broke run N-1/N-2');

    // A healthy selector is NOT flagged.
    const good = 'getByRole:button[name=Save]';
    await recordSelectorOutcome(scope, good, 'pass', { store });
    await recordSelectorOutcome(scope, good, 'pass', { store });
    ok((await isSelectorKnownBroken(scope, good, { store })) === false, 'a consistently-passing selector is not avoided');
  }

  console.log('Gate — thresholds guard against over-eager verdicts');
  {
    const store = new InMemoryMemoryStore();
    const sel = 'x';
    await recordSelectorOutcome(scope, sel, 'fail', { store }); // only ONE sample
    ok((await isSelectorKnownBroken(scope, sel, { store, minSamples: 2 })) === false,
      'a single failure below minSamples does NOT condemn a selector');
    await recordSelectorOutcome(scope, sel, 'fail', { store }); // now 2 samples, both fail
    ok((await isSelectorKnownBroken(scope, sel, { store, minSamples: 2 })) === true,
      'once minSamples is met and failure rate is high, it is condemned');
  }

  console.log('Gate — procedural preferred approach + relevance recall');
  {
    const store = new InMemoryMemoryStore();
    await recordProvenApproach(scope, 'create account', { steps: ['open form', 'fill required', 'save'] }, { store });
    const pref = await preferredApproach(scope, 'create account', { store });
    ok(pref !== null && (pref!.value as any).steps.length === 3, 'a proven approach is retrievable for the feature');

    await store.write({ scope, kind: 'semantic', subject: 'auth', value: { note: 'login uses SSO redirect' } });
    const rel = await recallRelevant(scope, 'sso login', { kind: 'semantic', store });
    ok(rel.length >= 1, 'relevance recall returns the matching semantic fact (bounded, not a firehose)');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
