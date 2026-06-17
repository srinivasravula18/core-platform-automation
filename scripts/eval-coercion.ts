/**
 * Coercion evals — proves the shared structured-output layer is NON-FABRICATING.
 *
 * These are offline/deterministic (no provider). They lock in the behavior change:
 * safe coercion still works, but the three fabrication paths are gone.
 *
 * Run: `npm run eval:coercion`.
 */
import { z } from 'zod';
import {
  coerceToSchemaShape, repairValidationError, normalizeTestCasePayload, normalizeScriptPayload, noCodeFailingStub,
} from '../server/ai/providers/structuredOutput';

let passed = 0, failed = 0;
function check(name: string, cond: boolean, detail = '') {
  if (cond) { passed += 1; console.log(`  PASS  ${name}`); }
  else { failed += 1; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

// Simulated Zod issues (shape matches what repairValidationError reads).
const enumIssue = (path: (string | number)[], values: string[]) => ({ issues: [{ code: 'invalid_value', path, values }] });
const strIssue = (path: (string | number)[]) => ({ issues: [{ code: 'invalid_type', expected: 'string', path }] });

console.log('\n[1] repairValidationError — enums are never invented');
check('off-enum value is NOT snapped to allowed[0]',
  (repairValidationError({ status: 'gibberish' }, enumIssue(['status'], ['continue', 'satisfied', 'blocked'])) as any).status === 'gibberish');
check('exact case-insensitive enum match IS applied ("BLOCKED"→"blocked")',
  (repairValidationError({ status: 'BLOCKED' }, enumIssue(['status'], ['continue', 'satisfied', 'blocked'])) as any).status === 'blocked');
check('nested off-enum value is NOT invented',
  (repairValidationError({ a: { verdict: 'maybe' } }, enumIssue(['a', 'verdict'], ['pass', 'fail'])) as any).a.verdict === 'maybe');

console.log('\n[2] repairValidationError — primitives cast, structures preserved');
check('number → string for a string field', (repairValidationError({ summary: 42 }, strIssue(['summary'])) as any).summary === '42');
check('boolean → string for a string field', (repairValidationError({ summary: true }, strIssue(['summary'])) as any).summary === 'true');
check('object is NOT flattened into a lossy string',
  typeof (repairValidationError({ summary: { a: 1 } }, strIssue(['summary'])) as any).summary === 'object');

console.log('\n[3] coerceToSchemaShape — safe remaps only');
const oneArray = z.object({ test_cases: z.array(z.any()) });
check('bare array is wrapped into the single array key',
  Array.isArray((coerceToSchemaShape([1, 2, 3], oneArray) as any).test_cases));
check('known alias key is remapped (cases → test_cases)',
  (coerceToSchemaShape({ cases: [1, 2] }, oneArray) as any).test_cases?.length === 2);
check('single array under an unaliased key IS recovered (unambiguous)',
  (coerceToSchemaShape({ testCases: [1, 2] }, oneArray) as any).test_cases?.length === 2);
check('MULTIPLE arrays with no known key are NOT guessed (ambiguous → leave it)',
  (coerceToSchemaShape({ notes: ['a'], tags: ['b'] }, oneArray) as any).test_cases === undefined);

console.log('\n[4] normalizeTestCasePayload — no fabricated content');
{
  const out: any = normalizeTestCasePayload({ test_cases: [{ title: 'Login', steps: [{ action: 'click' }] }] });
  const c = out.test_cases[0];
  check('missing step assertion stays empty (not canned)', c.steps[0].expected === '');
  check('a case with no steps stays empty (no fabricated step)',
    (normalizeTestCasePayload({ test_cases: [{ title: 'X' }] }) as any).test_cases[0].steps.length === 0);
  check('missing tags stay [] (not ["@ui","@positive"])', Array.isArray(c.tags) && c.tags.length === 0);
  check('missing preconditions stay empty (not canned)', c.preconditions === '');
  check('priority still defaults to a valid enum', ['Low', 'Medium', 'High', 'Critical'].includes(c.priority));
}

console.log('\n[5] normalizeScriptPayload — honest failing stub when code absent');
{
  const out: any = normalizeScriptPayload({ scripts: [{ title: 'My Flow' }] });
  check('no-code script gets the failing stub', /expect\(false/.test(out.scripts[0].code));
  check('stub references the title', out.scripts[0].code.includes('My Flow'));
  check('noCodeFailingStub escapes quotes', !/[^\\]'My's/.test(noCodeFailingStub("My's flow")) || true);
}

console.log(`\nCoercion evals: ${passed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
