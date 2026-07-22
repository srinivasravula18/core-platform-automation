/**
 * Test Case Versioning — content-change detection (Layer 1). Proves a revision is minted only when
 * VERSIONED content changes (title/description/preconditions/steps), never on operational-only edits
 * (status/folder/tags/scope). See server/db/repository.ts + the versioning plan.
 *   npx tsx scripts/test-case-versioning.ts   (npm run test:case-versioning)
 */
import { versionedContentChanged } from '../server/db/repository';

let passed = 0, failed = 0;
const ok = (c: boolean, n: string) => { if (c) { passed++; console.log(`  ✓ ${n}`); } else { failed++; console.error(`  ✗ ${n}`); } };

function main() {
  const base = { title: 'Login', description: 'd', preconditions: 'p', steps: [{ action: 'a', expected: 'e' }] };

  console.log('brand-new case (no prior) always counts as a change → baseline revision');
  ok(versionedContentChanged(null, base) === true, 'null prev → changed');

  console.log('identical content → no revision');
  ok(versionedContentChanged(base, { ...base, steps: [{ action: 'a', expected: 'e' }] }) === false, 'same content (fresh step array) → unchanged');

  console.log('a change in any versioned field → revision');
  ok(versionedContentChanged(base, { ...base, title: 'Login v2' }) === true, 'title change → changed');
  ok(versionedContentChanged(base, { ...base, description: 'd2' }) === true, 'description change → changed');
  ok(versionedContentChanged(base, { ...base, preconditions: 'p2' }) === true, 'preconditions change → changed');
  ok(versionedContentChanged(base, { ...base, steps: [{ action: 'a', expected: 'e' }, { action: 'b', expected: 'f' }] }) === true, 'added step → changed');
  ok(versionedContentChanged(base, { ...base, steps: [{ action: 'a', expected: 'DIFFERENT' }] }) === true, 'edited step → changed');

  console.log('operational-only fields are NOT versioned content → no revision');
  ok(versionedContentChanged(base, { ...base, status: 'Approved', folderId: 'F2', tags: ['@x'], priority: 'High' } as any) === false, 'status/folder/tags/priority change alone → unchanged');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
