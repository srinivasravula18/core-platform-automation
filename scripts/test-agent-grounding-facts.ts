/**
 * P5 golden test — shared grounding facts (server/agent-core/grounding/groundingFacts).
 * Proves grounding is published ONCE as a shared blackboard fact (evidence.catalog + grounding.coverage +
 * an ApplicationInspector RESULT), and that the critic CONSUMES that shared catalog by runId alone (no
 * re-derivation): a case grounded only via the shared fact is accepted, an ungrounded one is refuted. Pure.
 *   npx tsx scripts/test-agent-grounding-facts.ts
 */
import { InMemoryBlackboard, setBlackboard, getBlackboard } from '../server/agent-core/bus/blackboard';
import { InMemoryMessageBus, setMessageBus, getMessageBus } from '../server/agent-core/bus/messageBus';
import { publishGroundingFacts, readSharedCatalog } from '../server/agent-core/grounding/groundingFacts';
import { critiqueCases } from '../server/agent-core/critic/caseCritic';

let passed = 0, failed = 0;
const ok = (c: boolean, n: string) => { if (c) { passed++; console.log(`  ✓ ${n}`); } else { failed++; console.error(`  ✗ ${n}`); } };

async function main() {
  console.log('Flag OFF — no facts published');
  {
    delete process.env.AGENT_NATIVE_V1;
    setMessageBus(new InMemoryMessageBus());
    setBlackboard(new InMemoryBlackboard());
    const r = await publishGroundingFacts({ runId: 'g0', catalogLabels: ['New Button'], gate: { decision: 'continue' } });
    ok(r === null, 'returns null when the flag is off');
    ok((await getBlackboard().all('g0')).length === 0, 'no facts written');
  }

  console.log('Flag ON — grounding is published once and shared');
  {
    process.env.AGENT_NATIVE_V1 = '1';
    setMessageBus(new InMemoryMessageBus());
    setBlackboard(new InMemoryBlackboard());
    const RUN = 'g1';
    const labels = await publishGroundingFacts({
      runId: RUN,
      catalogLabels: ['New Button', 'Accounts Grid', 'Account Name Field', 'New Button', ''], // dupes + blank
      liveCount: 42,
      gate: { decision: 'continue', reasons: ['covers goal terms'] },
    });
    ok(!!labels && labels.length === 3, 'catalog labels are de-duplicated and blanks dropped');

    const catalogFact = await getBlackboard().latest<{ labels: string[]; count: number }>(RUN, 'evidence.catalog');
    ok(!!catalogFact && catalogFact.value.count === 3, 'evidence.catalog fact records the verified vocabulary');
    ok(catalogFact!.provenance.by === 'ApplicationInspector', 'the fact is provenance-stamped to the inspector');
    const coverage = await getBlackboard().latest<{ gate: string; live: number }>(RUN, 'grounding.coverage');
    ok(!!coverage && coverage.value.gate === 'continue' && coverage.value.live === 42, 'grounding.coverage records the gate + live count');
    ok((await getMessageBus().history(RUN)).some((m) => m.type === 'RESULT' && m.from === 'ApplicationInspector'), 'the inspector RESULTs its grounding contribution');

    ok((await readSharedCatalog(RUN)).includes('Accounts Grid'), 'readSharedCatalog returns the shared vocabulary for any agent');
  }

  console.log('Critic consumes the shared catalog by runId alone (no re-derivation)');
  {
    setMessageBus(new InMemoryMessageBus());
    setBlackboard(new InMemoryBlackboard());
    const RUN = 'g2';
    await publishGroundingFacts({ runId: RUN, catalogLabels: ['New Button', 'Account Name Field', 'Save Button'], gate: { decision: 'continue' } });

    // NOTE: catalogLabels intentionally NOT passed — the critic must read the shared evidence.catalog fact.
    const grounded = await critiqueCases({ runId: RUN, goal: 'accounts', cases: [
      { title: 'Create account', preconditions: 'Signed in', steps: [{ action: 'Click the New Button' }, { action: 'Fill the Account Name Field' }] },
      { title: 'Hallucinated', preconditions: 'Signed in', steps: [{ action: 'Click the Frobnicate Widget' }] },
    ] });
    const byTitle = (t: string) => grounded.verdicts.find((v) => v.title === t)!;
    ok(byTitle('Create account').accepted, 'a case grounded via the SHARED catalog is accepted');
    ok(!byTitle('Hallucinated').accepted && byTitle('Hallucinated').issues.some((i) => /ungrounded/i.test(i)), 'an ungrounded case is refuted using the shared catalog');
  }

  setMessageBus(null);
  setBlackboard(null);
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
