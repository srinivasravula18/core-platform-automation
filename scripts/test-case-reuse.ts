/**
 * Existing-case reuse search (server/features/agent/caseReuse.ts). Proves the CAREFUL ranker
 * (rankReuseCandidates) surfaces genuine coverage, ignores coincidental overlap, weights rare terms
 * (IDF), honors phrase anchors + scope alignment, normalizes for length, and stems paraphrases — the
 * failure modes a naive keyword counter has. Also keeps the legacy scoreCaseReuse/linkedExistingCases
 * back-compat checks.
 *   npx tsx scripts/test-case-reuse.ts
 */
import { rankReuseCandidates, scoreCaseReuse, linkedExistingCases, type ReuseCandidate } from '../server/features/agent/caseReuse';

let passed = 0, failed = 0;
const ok = (c: boolean, n: string) => { if (c) { passed++; console.log(`  ✓ ${n}`); } else { failed++; console.error(`  ✗ ${n}`); } };
const eq = (a: unknown, b: unknown, n: string) => ok(JSON.stringify(a) === JSON.stringify(b), `${n} (got ${JSON.stringify(a)})`);

const POOL: ReuseCandidate[] = [
  { id: 'c1', title: 'Sorting a column reorders records ascending', description: 'Click a sortable column header to sort the list ascending', tags: ['@ui', '@sort'], module: 'objects' },
  { id: 'c2', title: 'Pagination loads the next page of records', description: 'Navigating to page 2 loads a distinct set of rows', tags: ['@ui'], module: 'objects' },
  { id: 'c3', title: 'Login with valid credentials succeeds', description: 'A user signs in with a correct email and password', tags: ['@auth'], module: 'auth' },
  { id: 'c4', title: 'Export the list to CSV', description: 'Export options menu offers CSV, PDF and XLSX', tags: ['@export'], module: 'objects' },
  { id: 'c5', title: 'Coupon code applies a discount at checkout', description: 'Entering a valid coupon reduces the order total', tags: ['@billing'], module: 'checkout' },
];

console.log('1. Genuine coverage surfaces, unrelated cases do not');
{
  const r = rankReuseCandidates({ text: 'Test sorting the records list by clicking a column header', module: 'objects' }, POOL);
  const ids = r.map((m) => m.case.id);
  ok(ids[0] === 'c1', 'top match is the sorting case');
  ok(!ids.includes('c3'), 'unrelated login case is NOT matched');
  ok(!ids.includes('c5'), 'unrelated coupon case is NOT matched');
  ok((r[0]?.relevance ?? 0) > 0.34, 'top match clears the relevance threshold');
  ok(r[0]?.reasons.some((x) => /sort/.test(x)) ?? false, 'reason names the shared term');
}

console.log('2. Rare shared term outweighs common ones (IDF)');
{
  const r = rankReuseCandidates({ text: 'Verify pagination of the records list', module: 'objects' }, POOL);
  ok(r[0]?.case.id === 'c2', 'rare-term query pins the pagination case first');
}

console.log('3. Phrase anchor boosts a same-feature case');
{
  const r = rankReuseCandidates({ text: 'export options for the list', module: 'objects' }, POOL);
  ok(r.some((m) => m.case.id === 'c4' && !!m.anchor), 'export case matched with a phrase anchor');
}

console.log('4. Scope alignment corroborates a weak lexical match');
{
  const same = rankReuseCandidates({ text: 'records list view behavior', module: 'objects' }, POOL);
  const wrong = rankReuseCandidates({ text: 'records list view behavior', module: 'billing' }, POOL);
  ok(wrong.length <= same.length, 'wrong-module scope yields no MORE matches than the aligned one');
}

console.log('5. Coincidental single-word overlap does NOT match');
{
  const r = rankReuseCandidates({ text: 'wishlist of favorite items', module: 'shopping' }, POOL);
  ok(r.length === 0, 'one coincidental common word ("list") is not enough to suggest reuse');
}

console.log('6. Length normalization — a verbose case does not dominate');
{
  const verbose: ReuseCandidate = { id: 'big', title: 'Everything', description: ('sort filter paginate export login logout create delete update record column header row list view page next previous ').repeat(3), module: 'objects' };
  const r = rankReuseCandidates({ text: 'sort the column ascending', module: 'objects' }, [...POOL, verbose]);
  ok(r[0]?.case.id === 'c1', 'the focused sorting case still beats a keyword-stuffed verbose case');
}

console.log('7. Paraphrase/stemming — sorted/sorting/sorts align');
{
  const r = rankReuseCandidates({ text: 'records get sorted when a header is clicked', module: 'objects' }, POOL);
  ok(r[0]?.case.id === 'c1', 'stemming aligns "sorted" (query) with "sort/sorting" (case)');
}

console.log('8. Deterministic + empty-input safety');
{
  eq(rankReuseCandidates({ text: '' }, POOL), [], 'empty query → no matches');
  eq(rankReuseCandidates({ text: 'sort' }, []), [], 'empty pool → no matches');
  const a = rankReuseCandidates({ text: 'sort column', module: 'objects' }, POOL).map((m) => m.case.id);
  const b = rankReuseCandidates({ text: 'sort column', module: 'objects' }, POOL).map((m) => m.case.id);
  eq(a, b, 'same inputs → same ranking (deterministic)');
}

console.log('9. Legacy back-compat (scoreCaseReuse / linkedExistingCases)');
{
  const related = scoreCaseReuse('write test cases for list view', 'Objects list shows the All Objects list view', ['list', 'view', 'object']);
  ok(related.matched && related.anchor === 'list view', 'legacy scorer still matches a true List View case');
  const unrelated = scoreCaseReuse('write test cases for list view', 'Unrelated coupon checkout total', ['list', 'view']);
  ok(!unrelated.matched, 'legacy scorer rejects an unrelated case');
  const linked = linkedExistingCases([], [{ reused: true, existingCaseId: 'TC-1' }, { reused: false, id: 'TC-2' }, { reused: true, existingCaseId: 'TC-1' }]);
  ok(linked.length === 1 && linked[0].existingCaseId === 'TC-1', 'reused links deduped and preserved');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
