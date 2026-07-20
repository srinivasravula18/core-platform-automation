/**
 * Regression tests — codegen login-race hardening (server/features/automation/scriptHardening.ts).
 *
 * Proves that raw `playwright codegen` output gets a post-login settle wait inserted so replay
 * doesn't race its own login redirect (the Executions incident: click Sign in → immediate
 * page.goto → app bounces to Sign in → `New` never appears → 60s timeout). Covers:
 *   - a Sign in button click followed by page.goto gets a detach-wait on the same locator,
 *   - a password press('Enter') submit gets a networkidle settle wait,
 *   - the transform is idempotent (re-hardening does not stack waits),
 *   - non-login clicks and trailing submits (no following action) are left untouched.
 *
 * Convention: standalone tsx script, no jest/vitest. Run with:
 *   npx tsx scripts/test-script-hardening.ts   (or: npm run test:script-hardening)
 * Exits 0 if all pass, 1 on failure.
 */
import { hardenRecordedScript } from '../server/features/automation/scriptHardening';

let passed = 0, failed = 0;
const ok = (c: boolean, n: string) => { if (c) { passed++; console.log(`  ✓ ${n}`); } else { failed++; console.error(`  ✗ ${n}`); } };
const countWaits = (s: string) => (s.match(/\.waitFor\(|waitForLoadState\(/g) || []).length;

console.log('Section 1 — Sign in click before page.goto gets a detach-wait');
{
  const raw = [
    "import { test, expect } from '@playwright/test';",
    "",
    "test('test', async ({ page }) => {",
    "  await page.goto('https://app.example.com/admin-ui/');",
    "  await page.getByRole('textbox', { name: 'Email or Username' }).fill('adminacc');",
    "  await page.getByRole('textbox', { name: 'Password' }).fill('secret');",
    "  await page.getByRole('button', { name: 'Sign in' }).click();",
    "  await page.goto('https://app.example.com/admin-ui/?nav=apps');",
    "  await page.getByRole('button', { name: 'New' }).click();",
    "});",
  ].join('\n');
  const out = hardenRecordedScript(raw);
  ok(/getByRole\('button', \{ name: 'Sign in' \}\)\.waitFor\(\{ state: 'detached' \}\)\.catch/.test(out), 'inserts a detach-wait on the Sign in locator');
  const idx = out.split('\n').findIndex((l) => l.includes(".waitFor({ state: 'detached' })"));
  const clickIdx = out.split('\n').findIndex((l) => l.includes("{ name: 'Sign in' }).click()"));
  ok(idx === clickIdx + 1, 'the wait is inserted immediately after the click');
  ok(out.includes("await page.goto('https://app.example.com/admin-ui/?nav=apps');"), 'the following goto is preserved');
}

console.log('Section 2 — password press(Enter) submit gets a settle wait');
{
  const raw = [
    "test('test', async ({ page }) => {",
    "  await page.getByRole('textbox', { name: 'Password' }).fill('secret');",
    "  await page.getByRole('textbox', { name: 'Password' }).press('Enter');",
    "  await page.getByRole('button', { name: 'New' }).click();",
    "});",
  ].join('\n');
  const out = hardenRecordedScript(raw);
  ok(/waitForLoadState\('networkidle'\)\.catch/.test(out), 'inserts a networkidle settle wait after Enter submit');
}

console.log('Section 3 — idempotent: re-hardening does not stack waits');
{
  const raw = [
    "test('test', async ({ page }) => {",
    "  await page.getByRole('button', { name: 'Sign in' }).click();",
    "  await page.goto('https://app.example.com/home');",
    "});",
  ].join('\n');
  const once = hardenRecordedScript(raw);
  const twice = hardenRecordedScript(once);
  ok(countWaits(once) === 1, 'first pass inserts exactly one wait');
  ok(once === twice, 're-hardening a hardened script is a no-op');
}

console.log('Section 4 — non-login and trailing submits are left untouched');
{
  const nonLogin = [
    "test('test', async ({ page }) => {",
    "  await page.getByRole('button', { name: 'New' }).click();",
    "  await page.goto('https://app.example.com/home');",
    "});",
  ].join('\n');
  ok(countWaits(hardenRecordedScript(nonLogin)) === 0, 'a non-login button click gets no wait');

  const trailing = [
    "test('test', async ({ page }) => {",
    "  await page.getByRole('textbox', { name: 'Password' }).fill('secret');",
    "  await page.getByRole('button', { name: 'Sign in' }).click();",
    "});",
  ].join('\n');
  ok(countWaits(hardenRecordedScript(trailing)) === 0, 'a login submit with no following action gets no wait');

  ok(hardenRecordedScript('') === '', 'empty script is returned unchanged');
}

console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} — ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
