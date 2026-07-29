/**
 * P4 golden test — the author ↔ critic negotiation (server/agent-core/critic/caseCritic).
 * Asserts the critic's high-precision refutations (duplicate, empty precondition, no steps, @blocked,
 * ungrounded-vs-catalog), that a clean grounded draft is accepted, and that a refuted draft emits real
 * CRITIQUE traffic + a blackboard fact. Also proves the ungrounded check never fires without a catalog
 * (no false refutations on a real run). Pure — in-memory bus/blackboard.
 *   npx tsx scripts/test-agent-critic.ts
 */
import { InMemoryBlackboard, setBlackboard, getBlackboard } from '../server/agent-core/bus/blackboard';
import { InMemoryMessageBus, setMessageBus, getMessageBus } from '../server/agent-core/bus/messageBus';
import { critiqueCases, catalogVocabulary } from '../server/agent-core/critic/caseCritic';

let passed = 0, failed = 0;
const ok = (c: boolean, n: string) => { if (c) { passed++; console.log(`  ✓ ${n}`); } else { failed++; console.error(`  ✗ ${n}`); } };

const CATALOG = ['New Button', 'Accounts Grid', 'Account Name Field', 'Save Button'];

async function main() {
  console.log('Critic — accepts a clean, grounded, distinct draft');
  {
    process.env.AGENT_NATIVE_V1 = '1';
    setMessageBus(new InMemoryMessageBus());
    setBlackboard(new InMemoryBlackboard());
    const cases = [
      { title: 'Create an account', preconditions: 'Signed in as Admin with the Sales app open', steps: [{ action: 'Click the New Button' }, { action: 'Fill the Account Name Field' }, { action: 'Click the Save Button' }] },
      { title: 'Open the accounts grid', preconditions: 'Signed in as Admin', steps: [{ action: 'Open the Accounts Grid' }] },
    ];
    const r = await critiqueCases({ runId: 'r-clean', goal: 'accounts', cases, catalogLabels: CATALOG });
    ok(!r.hasIssues, 'no issues on a clean grounded draft');
    ok(r.verdicts.every((v) => v.accepted), 'every case is accepted');
    ok(r.feedback === '', 'no revision feedback is produced');
    const crit = (await getMessageBus().history('r-clean')).filter((m) => m.type === 'CRITIQUE');
    ok(crit.length === 0, 'no CRITIQUE messages when nothing is refuted');
  }

  console.log('Critic — refutes duplicate / empty-precondition / no-steps / @blocked / ungrounded');
  {
    setMessageBus(new InMemoryMessageBus());
    setBlackboard(new InMemoryBlackboard());
    const cases = [
      { title: 'Create an account', preconditions: 'Signed in', steps: [{ action: 'Click the New Button' }] },
      { title: 'Create an account', preconditions: 'Signed in', steps: [{ action: 'Click the New Button' }] }, // duplicate
      { title: 'Missing precondition case', preconditions: '', steps: [{ action: 'Click the Save Button' }] },   // empty precond
      { title: 'No steps case', preconditions: 'Signed in', steps: [] },                                          // no steps
      { title: 'Blocked case', preconditions: 'Signed in', tags: ['@blocked'], steps: [{ action: 'do a thing' }] }, // blocked
      { title: 'Hallucinated flow', preconditions: 'Signed in', steps: [{ action: 'Click the Frobnicate Widget' }] }, // ungrounded
    ];
    const r = await critiqueCases({ runId: 'r-bad', goal: 'accounts', cases, catalogLabels: CATALOG });
    ok(r.hasIssues, 'the draft is refuted');
    const byTitle = (t: string) => r.verdicts.filter((v) => v.title === t);
    ok(byTitle('Create an account')[1].issues.some((i) => /duplicate/i.test(i)), 'the second identical case is flagged duplicate');
    ok(byTitle('Missing precondition case')[0].issues.some((i) => /precondition/i.test(i)), 'empty precondition is flagged');
    ok(byTitle('No steps case')[0].issues.some((i) => /no steps/i.test(i)), 'a step-less case is flagged');
    ok(byTitle('Blocked case')[0].issues.some((i) => /blocked/i.test(i)), '@blocked leakage is flagged');
    ok(byTitle('Hallucinated flow')[0].issues.some((i) => /ungrounded/i.test(i)), 'a case disconnected from the catalog is flagged ungrounded');
    ok(/Revise ONLY these/.test(r.feedback), 'actionable revision feedback is produced for the author');

    const history = await getMessageBus().history('r-bad');
    ok(history.some((m) => m.type === 'CRITIQUE' && m.from === 'CriticAgent' && m.to === 'TestGenerationAgent'), 'CRITIQUE messages flow from the critic to the author');
    ok(history.some((m) => m.type === 'RESULT' && m.from === 'CriticAgent'), 'the critic RESULTs its verdict');
    const fact = await getBlackboard().latest<{ refuted: number }>('r-bad', 'critique.cases');
    ok(!!fact && fact.value.refuted >= 5, 'the critique is recorded as a shared blackboard fact');
  }

  console.log('Critic — no catalog → never refutes on grounding (no false positives on a real run)');
  {
    setMessageBus(new InMemoryMessageBus());
    setBlackboard(new InMemoryBlackboard());
    const cases = [{ title: 'Some case', preconditions: 'Signed in', steps: [{ action: 'Click the Anything Button' }] }];
    const r = await critiqueCases({ runId: 'r-nocat', goal: 'x', cases, catalogLabels: [] });
    ok(!r.hasIssues, 'without a catalog, a well-formed case is not refuted for grounding');
    ok(catalogVocabulary([]).size === 0 && catalogVocabulary(['New Button']).has('new'), 'catalogVocabulary tokenizes labels');
  }

  console.log('Critic — refutes assertion-vs-behavior contradictions (the production failure class)');
  {
    setMessageBus(new InMemoryMessageBus());
    setBlackboard(new InMemoryBlackboard());
    const cases = [
      // A1 lowercase contradiction (input-tied): asserts raw "ABC" under a lowercase title.
      { title: 'API name is converted to lowercase', preconditions: 'Signed in as Admin',
        steps: [{ action: 'Fill the Account Name Field with "ABC"' }, { action: 'Click the Save Button', expected: 'The API name shows "ABC"' }] },
      // A2 trim contradiction (quoted assert violates trim).
      { title: 'Name is trimmed on save', preconditions: 'Signed in',
        steps: [{ action: 'Click the Save Button', expected: 'The Account Name Field shows " widget "' }] },
      // B unresolved template token in an assertion.
      { title: 'New account gets a unique name', preconditions: 'Signed in',
        steps: [{ action: 'Click the New Button' }, { action: 'Click the Save Button', expected: 'The grid shows "{{unique.username}}"' }] },
      // C preservation self-contradiction (case/whitespace variant).
      { title: 'Manual value is preserved as entered', preconditions: 'Signed in',
        steps: [{ action: 'Fill the Account Name Field with "Acme Corp"' }, { action: 'Click the Save Button', expected: 'The Account Name Field shows "acme corp"' }] },
    ];
    const r = await critiqueCases({ runId: 'r-contra', goal: 'x', cases, catalogLabels: CATALOG });
    const by = (t: string) => r.verdicts.find((v) => v.title === t)!;
    ok(by('API name is converted to lowercase').issues.some((i) => /not lowercased|contradicts|lowercase/i.test(i)), 'raw-uppercase assert under a lowercase title is refuted');
    ok(by('Name is trimmed on save').issues.some((i) => /trim/i.test(i)), 'an untrimmed asserted literal under a trim title is refuted');
    ok(by('New account gets a unique name').issues.some((i) => /template token|\{\{/i.test(i)), 'an unresolved {{token}} in an assertion is refuted');
    ok(by('Manual value is preserved as entered').issues.some((i) => /preserv|case\/whitespace/i.test(i)), 'a case/whitespace variant under a "preserved" title is refuted');
    ok(by('API name is converted to lowercase').codes.includes('assert-transform'), 'the transform contradiction carries a stable code');
    ok(by('New account gets a unique name').codes.includes('assert-template'), 'the template leak carries a stable code');
  }

  console.log('Critic — does NOT false-refute legitimate transform/preserve cases');
  {
    setMessageBus(new InMemoryMessageBus());
    setBlackboard(new InMemoryBlackboard());
    const cases = [
      // Correct lowercase assert.
      { title: 'API name is converted to lowercase', preconditions: 'Signed in',
        steps: [{ action: 'Fill the Account Name Field with "ABC"' }, { action: 'Click the Save Button', expected: 'The API name shows "abc"' }] },
      // Prose with capitalized proper nouns but NO quoted contradiction.
      { title: 'Name is trimmed on save', preconditions: 'Signed in',
        steps: [{ action: 'Click the Save Button', expected: 'The Account Name Field updates and the Save Button is enabled' }] },
      // Genuine preservation: assert === input verbatim.
      { title: 'Manual value is preserved as entered', preconditions: 'Signed in',
        steps: [{ action: 'Fill the Account Name Field with "Acme Corp"' }, { action: 'Click the Save Button', expected: 'The Account Name Field shows "Acme Corp"' }] },
    ];
    const r = await critiqueCases({ runId: 'r-clean2', goal: 'x', cases, catalogLabels: CATALOG });
    ok(!r.hasIssues, 'correctly-asserted transform/preserve cases are all accepted (no false refutation)');
  }

  setMessageBus(null);
  setBlackboard(null);
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
