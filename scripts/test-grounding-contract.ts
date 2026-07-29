/**
 * Unit tests for the Phase 3 Grounding Contract (server/agent-core/grounding/coverageContract).
 * Covers per-source coverage reports and the proceed / re-ground / block gate over required sources.
 *   npx tsx scripts/test-grounding-contract.ts
 * Pure — no browser/network/DB.
 */
import { buildCoverageReport, evaluateGroundingContract, type CoverageReport } from '../server/agent-core/grounding/coverageContract';

let passed = 0, failed = 0;
const ok = (c: boolean, n: string) => { if (c) { passed++; console.log(`  ✓ ${n}`); } else { failed++; console.error(`  ✗ ${n}`); } };
const eq = (a: unknown, b: unknown, n: string) => ok(JSON.stringify(a) === JSON.stringify(b), `${n} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

async function main() {
  console.log('CoverageReport — per-source term matching');
  {
    const r = buildCoverageReport('DOM', ['account', 'invoice'], ['Account name field', 'Save button']);
    eq(r.covered, ['account'], 'covered term matched in the vocabulary');
    eq(r.missing, ['invoice'], 'missing term reported');
    eq(r.confidence, 0.5, 'confidence is covered/requested');

    const none = buildCoverageReport('METADATA', [], ['anything']);
    eq(none.confidence, 1, 'nothing requested → full confidence (nothing to miss)');
  }

  console.log('Gate — permissive by default');
  {
    const reports: CoverageReport[] = [buildCoverageReport('DOM', ['account'], ['Save'])]; // account uncovered
    const res = evaluateGroundingContract(reports, {}); // no required sources
    eq(res.decision, 'proceed', 'no required sources → proceed even with uncovered terms (permissive)');
  }

  console.log('Gate — required source drives reground → block');
  {
    const uncovered = [buildCoverageReport('DOM', ['account', 'invoice'], ['Save button'])]; // neither covered
    const first = evaluateGroundingContract(uncovered, { requiredSources: ['DOM'], regroundAttempts: 0, maxRegroundAttempts: 1 });
    eq(first.decision, 'reground', 'a required source missing terms triggers a bounded reground');
    eq(first.uncoveredTerms, ['account', 'invoice'], 'uncovered terms are surfaced');

    const exhausted = evaluateGroundingContract(uncovered, { requiredSources: ['DOM'], regroundAttempts: 1, maxRegroundAttempts: 1 });
    eq(exhausted.decision, 'block', 'after exhausting reground attempts it BLOCKS (named gate, never guesses)');
    ok(exhausted.reasons[0].includes('account'), 'block reason names the uncovered terms');
  }

  console.log('Gate — complementary sources cover the union');
  {
    // DOM covers "account", SWAGGER covers "invoice" — together they cover the goal.
    const reports = [
      buildCoverageReport('DOM', ['account', 'invoice'], ['Account field']),
      buildCoverageReport('SWAGGER', ['account', 'invoice'], ['POST /invoices']),
    ];
    const res = evaluateGroundingContract(reports, { requiredSources: ['DOM', 'SWAGGER'] });
    eq(res.decision, 'proceed', 'a term covered by ANY required source counts as covered (sources are complementary)');
    eq(res.uncoveredTerms, [], 'nothing uncovered when the union covers all terms');
  }

  console.log('Gate — minCoverage threshold');
  {
    // 2 of 3 covered = 0.66; minCoverage 0.6 → proceed; 0.9 → reground.
    const reports = [buildCoverageReport('DOM', ['a', 'b', 'c'], ['a x', 'b y'])];
    eq(evaluateGroundingContract(reports, { requiredSources: ['DOM'], minCoverage: 0.6 }).decision, 'proceed', 'coverage above minCoverage proceeds');
    eq(evaluateGroundingContract(reports, { requiredSources: ['DOM'], minCoverage: 0.9, maxRegroundAttempts: 1 }).decision, 'reground', 'coverage below minCoverage regrounds');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
