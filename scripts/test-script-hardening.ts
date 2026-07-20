/**
 * Regression tests — codegen login hardening (server/features/automation/scriptHardening.ts).
 *
 * The app under test holds auth as an in-memory Bearer token (no cookie/localStorage), so a full-page
 * page.goto() after login wipes the token and bounces to the login page. These tests prove the
 * transform:
 *   - converts the first post-login page.goto(...) into page.waitForURL(...) (no reload → token kept),
 *   - collapses a codegen double-submit (password Enter + Sign in click) to a single submit,
 *   - falls back to a "wait until the login form is hidden" guard when there's no post-login goto,
 *   - never emits the discouraged networkidle,
 *   - is idempotent, and leaves non-login flows untouched.
 *
 * Run: npx tsx scripts/test-script-hardening.ts   (or: npm run test:script-hardening)
 */
import { hardenRecordedScript } from '../server/features/automation/scriptHardening';

let passed = 0, failed = 0;
const ok = (c: boolean, n: string) => { if (c) { passed++; console.log(`  ✓ ${n}`); } else { failed++; console.error(`  ✗ ${n}`); } };
const count = (s: string, re: RegExp) => (s.match(re) || []).length;

console.log('Section 1 — first post-login page.goto becomes waitForURL (no reload)');
{
  const raw = [
    "test('test', async ({ page }) => {",
    "  await page.goto('https://app.example.com/admin-ui/');",
    "  await page.getByRole('textbox', { name: 'Email or Username' }).fill('adminacc');",
    "  await page.getByRole('textbox', { name: 'Password' }).fill('secret');",
    "  await page.getByRole('button', { name: 'Sign in' }).click();",
    "  await page.goto('https://app.example.com/admin-ui/?nav=apps&appId=app21vhj4w');",
    "  await page.getByRole('button', { name: 'New' }).click();",
    "});",
  ].join('\n');
  const out = hardenRecordedScript(raw);
  ok(/await page\.waitForURL\('https:\/\/app\.example\.com\/admin-ui\/\?nav=apps&appId=app21vhj4w'\);/.test(out), 'the post-login goto is converted to waitForURL with the same URL');
  ok(count(out, /page\.goto\(/g) === 1, 'the initial page.goto (loading the app) is kept; only the post-login one is converted');
  ok(!/networkidle/.test(out), 'never emits networkidle');
}

console.log('Section 2 — double-submit collapsed AND post-login goto converted');
{
  const raw = [
    "test('test', async ({ page }) => {",
    "  await page.goto('https://app.example.com/admin-ui/');",
    "  await page.getByRole('textbox', { name: 'Password' }).fill('secret');",
    "  await page.getByRole('textbox', { name: 'Password' }).press('Enter');",
    "  await page.getByRole('button', { name: 'Sign in' }).click();",
    "  await page.goto('https://app.example.com/admin-ui/?nav=apps&appId=app21vhj4w');",
    "  await page.getByRole('button', { name: 'New' }).click();",
    "});",
  ].join('\n');
  const out = hardenRecordedScript(raw);
  ok(!/press\('Enter'\)/.test(out), 'the redundant press(Enter) submit is removed');
  ok(count(out, /\{ name: 'Sign in' \}\)\.click\(\)/g) === 1, 'exactly one submit remains');
  ok(count(out, /waitForURL\(/g) === 1, 'the post-login goto is converted to a single waitForURL');
}

console.log('Section 3 — no post-login goto: guard on the login form disappearing');
{
  const raw = [
    "test('test', async ({ page }) => {",
    "  await page.getByRole('textbox', { name: 'Password' }).fill('secret');",
    "  await page.getByRole('button', { name: 'Sign in' }).click();",
    "  await page.getByRole('button', { name: 'New' }).click();",
    "});",
  ].join('\n');
  const out = hardenRecordedScript(raw);
  ok(/getByRole\('button', \{ name: 'Sign in' \}\)\.waitFor\(\{ state: 'hidden', timeout: 15000 \}\)\.catch/.test(out), 'inserts a hidden-wait guard when there is no post-login goto');
  ok(!/waitForURL\(/.test(out), 'no waitForURL when there is no goto to convert');
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
  ok(count(once, /waitForURL\(/g) === 1 && !/press\('Enter'\)/.test(once), 'first pass converts + collapses');
  ok(once === twice, 're-hardening a hardened script is a no-op');
}

console.log('Section 4b — ALL post-login same-origin gotos are converted; cross-origin left alone');
{
  const raw = [
    "test('test', async ({ page }) => {",
    "  await page.goto('https://app.example.com/admin-ui/');",
    "  await page.getByRole('textbox', { name: 'Password' }).fill('secret');",
    "  await page.getByRole('button', { name: 'Sign in' }).click();",
    "  await page.goto('https://app.example.com/admin-ui/?nav=apps');",
    "  await page.getByRole('button', { name: 'New' }).click();",
    "  await page.goto('https://app.example.com/admin-ui/?nav=objects');",
    "  await page.goto('https://docs.other.com/help');",
    "});",
  ].join('\n');
  const out = hardenRecordedScript(raw);
  ok(count(out, /waitForURL\('https:\/\/app\.example\.com/g) === 2, 'both post-login same-origin gotos become waitForURL');
  ok(count(out, /page\.goto\('https:\/\/app\.example\.com\/admin-ui\/'\)/g) === 1, 'the pre-login entry goto is kept');
  ok(/page\.goto\('https:\/\/docs\.other\.com\/help'\)/.test(out), 'the cross-origin goto is left as a real navigation');
  ok(count(out, /waitForURL\(/g) === 2, 'exactly the two in-app gotos are converted');
}

console.log('Section 5 — non-login flows and edge cases untouched');
{
  const nonLogin = [
    "test('test', async ({ page }) => {",
    "  await page.getByRole('button', { name: 'New' }).click();",
    "  await page.goto('https://app.example.com/home');",
    "});",
  ].join('\n');
  ok(hardenRecordedScript(nonLogin) === nonLogin, 'a non-login flow is unchanged (its goto is not touched)');
  ok(hardenRecordedScript('') === '', 'empty script returned unchanged');
}

console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} — ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
