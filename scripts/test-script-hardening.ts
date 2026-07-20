/**
 * Regression tests — codegen login hardening (server/features/automation/scriptHardening.ts).
 *
 * The app under test is a URL-stable, httpOnly-cookie SPA, so the reliable "login done" signal is the
 * login form disappearing (NOT waitForURL, NOT the discouraged networkidle). Codegen also frequently
 * records the submit twice (password Enter + Sign in click). These tests prove:
 *   - a Sign in click before page.goto gets a "wait until the submit button is hidden" guard,
 *   - a redundant password press('Enter') adjacent to the Sign in click is dropped (single submit),
 *   - an Enter-only submit gets a guard anchored on the password field,
 *   - the guard uses waitFor({ state: 'hidden' }) and never emits networkidle,
 *   - the transform is idempotent, and non-login flows are left untouched.
 *
 * Run: npx tsx scripts/test-script-hardening.ts   (or: npm run test:script-hardening)
 */
import { hardenRecordedScript } from '../server/features/automation/scriptHardening';

let passed = 0, failed = 0;
const ok = (c: boolean, n: string) => { if (c) { passed++; console.log(`  ✓ ${n}`); } else { failed++; console.error(`  ✗ ${n}`); } };
const lines = (s: string) => s.split('\n');
const countClicks = (s: string, name: string) => (s.match(new RegExp(`\\{ name: '${name}' \\}\\)\\.click\\(\\)`, 'g')) || []).length;
const countGuards = (s: string) => (s.match(/\.waitFor\(\{ state: 'hidden'/g) || []).length;

console.log('Section 1 — Sign in click before page.goto gets a form-gone guard');
{
  const raw = [
    "test('test', async ({ page }) => {",
    "  await page.getByRole('textbox', { name: 'Email or Username' }).fill('adminacc');",
    "  await page.getByRole('textbox', { name: 'Password' }).fill('secret');",
    "  await page.getByRole('button', { name: 'Sign in' }).click();",
    "  await page.goto('https://app.example.com/admin-ui/?nav=apps');",
    "  await page.getByRole('button', { name: 'New' }).click();",
    "});",
  ].join('\n');
  const out = hardenRecordedScript(raw);
  ok(/getByRole\('button', \{ name: 'Sign in' \}\)\.waitFor\(\{ state: 'hidden', timeout: 15000 \}\)\.catch/.test(out), 'inserts a hidden-wait on the Sign in locator');
  const guardIdx = lines(out).findIndex((l) => l.includes(".waitFor({ state: 'hidden'"));
  const clickIdx = lines(out).findIndex((l) => l.includes("{ name: 'Sign in' }).click()"));
  ok(guardIdx === clickIdx + 1, 'the guard sits immediately after the click, before the goto');
  ok(!/networkidle/.test(out), 'never emits the discouraged networkidle');
}

console.log('Section 2 — redundant password Enter adjacent to the Sign in click is dropped');
{
  const raw = [
    "test('test', async ({ page }) => {",
    "  await page.getByRole('textbox', { name: 'Password' }).fill('secret');",
    "  await page.getByRole('textbox', { name: 'Password' }).press('Enter');",
    "  await page.getByRole('button', { name: 'Sign in' }).click();",
    "  await page.goto('https://app.example.com/home');",
    "  await page.getByRole('button', { name: 'New' }).click();",
    "});",
  ].join('\n');
  const out = hardenRecordedScript(raw);
  ok(!/press\('Enter'\)/.test(out), 'the redundant press(Enter) submit is removed');
  ok(countClicks(out, 'Sign in') === 1, 'exactly one submit (the explicit Sign in click) remains');
  ok(countGuards(out) === 1, 'exactly one form-gone guard is inserted');
  ok(/getByRole\('button', \{ name: 'Sign in' \}\)\.waitFor/.test(out), 'the guard anchors on the Sign in button');
}

console.log('Section 3 — Enter-only submit is guarded on the password field');
{
  const raw = [
    "test('test', async ({ page }) => {",
    "  await page.getByRole('textbox', { name: 'Password' }).fill('secret');",
    "  await page.getByRole('textbox', { name: 'Password' }).press('Enter');",
    "  await page.getByRole('button', { name: 'New' }).click();",
    "});",
  ].join('\n');
  const out = hardenRecordedScript(raw);
  ok(/getByRole\('textbox', \{ name: 'Password' \}\)\.waitFor\(\{ state: 'hidden'/.test(out), 'guard anchors on the password field when there is no submit button');
  ok(/press\('Enter'\)/.test(out), 'the Enter submit itself is kept (it is the only submit)');
  ok(!/networkidle/.test(out), 'still no networkidle');
}

console.log('Section 4 — idempotent');
{
  const raw = [
    "test('test', async ({ page }) => {",
    "  await page.getByRole('textbox', { name: 'Password' }).press('Enter');",
    "  await page.getByRole('button', { name: 'Sign in' }).click();",
    "  await page.goto('https://app.example.com/home');",
    "});",
  ].join('\n');
  const once = hardenRecordedScript(raw);
  const twice = hardenRecordedScript(once);
  ok(countGuards(once) === 1, 'first pass inserts exactly one guard');
  ok(once === twice, 're-hardening a hardened script is a no-op');
}

console.log('Section 5 — non-login flows and edge cases left untouched');
{
  const nonLogin = [
    "test('test', async ({ page }) => {",
    "  await page.getByRole('button', { name: 'New' }).click();",
    "  await page.goto('https://app.example.com/home');",
    "});",
  ].join('\n');
  ok(hardenRecordedScript(nonLogin) === nonLogin, 'a non-login button click flow is unchanged');
  ok(hardenRecordedScript('') === '', 'empty script is returned unchanged');

  const trailing = [
    "test('test', async ({ page }) => {",
    "  await page.getByRole('button', { name: 'Sign in' }).click();",
    "});",
  ].join('\n');
  ok(countGuards(hardenRecordedScript(trailing)) === 0, 'a login submit with no following action gets no guard');
}

console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} — ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
