/**
 * Recorder step coalescing + grouping tests (see server/features/automation/stepGrouping.ts).
 * Proves 200-300 flat interactions collapse into a handful of named, collapsible groups without
 * losing meaningful steps.
 *   npx tsx scripts/test-step-grouping.ts   (npm run test:step-grouping)
 */
import { parseAtomicSteps, coalesceAtomicSteps, groupAtomicSteps, scriptToGroupedSteps } from '../server/features/automation/stepGrouping';

let passed = 0, failed = 0;
const ok = (c: boolean, n: string) => { if (c) { passed++; console.log(`  ✓ ${n}`); } else { failed++; console.error(`  ✗ ${n}`); } };

function main() {
  console.log('parse: one atomic step per recognized codegen statement');
  const script = [
    `await page.goto('https://app.example.com/login');`,
    `await page.getByLabel('Email').fill('a');`,
    `await page.getByLabel('Email').fill('ab');`,
    `await page.getByLabel('Email').fill('admin@x.com');`,
    `await page.getByLabel('Password').fill('secret');`,
    `await page.getByRole('button', { name: 'Sign in' }).click();`,
    `await page.waitForURL('https://app.example.com/admin/apps');`,
    `await page.getByRole('button', { name: 'New App' }).click();`,
    `await page.getByLabel('Label').fill('Core');`,
    `await expect(page.getByText('App created')).toBeVisible();`,
  ].join('\n');
  const atoms = parseAtomicSteps(script);
  ok(atoms.length === 10, `parsed all 10 statements (got ${atoms.length})`);
  ok(atoms[0].kind === 'nav' && atoms[6].kind === 'nav', 'goto and waitForURL both parse as nav');
  ok(atoms[9].kind === 'verify', 'expect(...) parses as verify');

  console.log('coalesce: consecutive fills on the same field collapse to the last value');
  const co = coalesceAtomicSteps(atoms);
  ok(co.length === 8, `3 Email fills collapsed to 1 (10 -> ${co.length})`);
  ok(co.some((s) => s.action.includes('admin@x.com')) && !co.some((s) => s.action === `Fill "Email" with "a"`), 'final Email value kept, intermediates dropped');

  console.log('coalesce: an identical back-to-back navigation is dropped');
  const dupNav = coalesceAtomicSteps(parseAtomicSteps(`await page.goto('https://a/x');\nawait page.goto('https://a/x');`));
  ok(dupNav.length === 1, `duplicate nav dropped (got ${dupNav.length})`);

  console.log('group: each navigation opens a new titled group');
  const grouped = groupAtomicSteps(co);
  const titles = Array.from(new Set(grouped.map((s) => s.group)));
  ok(titles.includes('Login') && titles.includes('Apps'), `groups titled from URL path (${titles.join(', ')})`);
  ok(new Set(grouped.map((s) => s.groupIndex)).size === 2, 'exactly two logical groups');
  ok(grouped.every((s) => Number.isInteger(s.groupIndex)), 'every step carries a groupIndex');

  console.log('group: steps before the first navigation land in "Initial steps"');
  const noNav = scriptToGroupedSteps(`await page.getByRole('button', { name: 'X' }).click();`);
  ok(noNav.length === 1 && noNav[0].group === 'Initial steps' && noNav[0].groupIndex === 0, 'pre-nav step grouped as Initial steps');

  console.log('end-to-end: a 300-interaction recording collapses to a readable number of groups');
  const big: string[] = [];
  for (let p = 0; p < 6; p++) {
    big.push(`await page.goto('https://app.example.com/page${p}');`);
    for (let i = 0; i < 50; i++) big.push(`await page.getByLabel('Field${i}').fill('v${i}');`);
  }
  const bigGrouped = scriptToGroupedSteps(big.join('\n'));
  const bigGroups = new Set(bigGrouped.map((s) => s.groupIndex)).size;
  ok(bigGroups === 6, `306 interactions -> ${bigGroups} groups`);
  ok(bigGrouped.length === 306, `no meaningful steps lost (${bigGrouped.length} steps)`);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
