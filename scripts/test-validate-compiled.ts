/**
 * Validation Gate tests (Phase 4). Proves the gate rejects every forbidden construct and accepts clean specs.
 *   npx tsx scripts/test-validate-compiled.ts   (npm run test:validate-compiled)
 */
import { validateCompiledOutput } from '../server/features/agent/compiler/validateCompiledOutput';

let passed = 0, failed = 0;
const ok = (c: boolean, n: string) => { if (c) { passed++; console.log(`  ✓ ${n}`); } else { failed++; console.error(`  ✗ ${n}`); } };

const CLEAN = `import { test, expect } from '@playwright/test';
import { MissionRunner } from './mission-runner';
const MISSION = {"targetUrl":"https://h/keystone/?appId=app9&nav=accounts","application":{"id":"app9","name":"CRM"}} as const;
test('t', async ({ page }) => {
  const runner = new MissionRunner(page, MISSION as any);
  await runner.startMission();
  await expect(runner.locator({"selector":"#new"})).toBeVisible();
});`;

function main() {
  console.log('clean compiled spec passes');
  const clean = validateCompiledOutput(CLEAN);
  ok(clean.ok, `clean spec ok (violations: ${JSON.stringify(clean.violations.map((v) => v.rule))})`);

  console.log('runtime appId inside the MISSION targetUrl is allowed (the entry point)');
  ok(!clean.violations.some((v) => v.rule === 'HARDCODED_APPID'), 'appId inside targetUrl string not flagged');

  console.log('forbidden constructs are rejected');
  const bad = (rule: string, code: string) => ok(validateCompiledOutput(code).violations.some((v) => v.rule === rule), `${rule} rejected`);
  bad('RAW_GOTO', `await page.goto('https://x');`);
  bad('RAW_URL', `const u = new URL(page.url());`);
  bad('SEARCH_PARAMS', `u.searchParams.set('nav','objects');`);
  bad('INLINE_LOGIN', `await loginIfNeeded(page);`);
  bad('POSITIONAL_GUESS', `await page.getByRole('button',{name:'Apps'}).first().click();`);
  bad('POSITIONAL_GUESS', `await page.locator('.row').nth(2).click();`);
  bad('HARDCODED_APPID', `const appId = 'app21vhj4w';`);

  console.log('line numbers reported');
  const multi = validateCompiledOutput(`line1\nawait page.goto('x');\nline3`);
  ok(multi.violations[0]?.line === 2, 'violation reports correct line');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}
main();
