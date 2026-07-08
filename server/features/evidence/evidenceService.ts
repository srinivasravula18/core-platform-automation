import path from 'path';
import fs from 'fs/promises';
import { normalizeTargetUrl } from '../../shared/url';
import { launchChromiumWithRetry } from '../../shared/browser';

async function fillLocator(locator: any, value: string) {
  try {
    if (!(await locator.count())) return false;
    const field = locator.first();
    await field.waitFor({ state: 'visible', timeout: 5000 });
    await field.fill(value, { timeout: 5000 });
    await field.dispatchEvent('input').catch(() => undefined);
    await field.dispatchEvent('change').catch(() => undefined);

    try {
      const actualValue = await field.inputValue({ timeout: 1000 });
      return actualValue === value;
    } catch {
      return true;
    }
  } catch {
    return false;
  }
}

async function fillFirstAvailable(page: any, selectors: string[], value: string) {
  if (!value) return false;

  for (const selector of selectors) {
    if (await fillLocator(page.locator(selector), value)) {
      return true;
    }
  }

  return false;
}

async function fillByAccessibleLabel(page: any, labels: RegExp[], value: string) {
  for (const label of labels) {
    if (await fillLocator(page.getByLabel(label), value)) {
      return true;
    }
  }

  return false;
}

async function fillVisibleInputFallback(page: any, value: string, fieldType: 'username' | 'password') {
  const selector = fieldType === 'password'
    ? 'input[type="password"]'
    : 'input:not([type="hidden"]):not([type="password"]):not([disabled])';
  const inputs = page.locator(selector);
  const count = await inputs.count();

  for (let index = 0; index < count; index += 1) {
    if (await fillLocator(inputs.nth(index), value)) {
      return true;
    }
  }

  return false;
}

async function fillByDomFallback(page: any, value: string, fieldType: 'username' | 'password') {
  if (!value) return false;

  return page.evaluate(({ value, fieldType }) => {
    const inputs = Array.from(document.querySelectorAll('input')) as HTMLInputElement[];
    const candidates = inputs.filter((input) => {
      const type = (input.getAttribute('type') || 'text').toLowerCase();
      if (input.disabled || input.readOnly || type === 'hidden') return false;
      return fieldType === 'password' ? type === 'password' : type !== 'password';
    });
    const field = candidates[0];
    if (!field) return false;

    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    setter?.call(field, value);
    field.focus();
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
    field.blur();
    return field.value === value;
  }, { value, fieldType }).catch(() => false);
}

export async function performLoginIfCredentialsProvided(page: any, credentials: any) {
  if (!credentials?.username || !credentials?.password) {
    return { attempted: false, success: false, reason: 'No credentials provided.' };
  }

  await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => undefined);

  const usernameFilled =
    await fillByAccessibleLabel(page, [/email\s*or\s*username/i, /username/i, /email/i, /login/i, /user/i], credentials.username) ||
    await fillFirstAvailable(page, [
      'input[name="email"]',
      'input[name="username"]',
      'input[name="user"]',
      'input[name="identifier"]',
      'input[id*="email" i]',
      'input[id*="user" i]',
      'input[placeholder*="email" i]',
      'input[placeholder*="user" i]',
      'input[aria-label*="email" i]',
      'input[aria-label*="user" i]',
      'input[type="email"]',
      'input[type="text"]',
    ], credentials.username) ||
    await fillVisibleInputFallback(page, credentials.username, 'username') ||
    await fillByDomFallback(page, credentials.username, 'username');

  const passwordFilled =
    await fillByAccessibleLabel(page, [/password/i, /pass/i], credentials.password) ||
    await fillFirstAvailable(page, [
      'input[name="password"]',
      'input[name="pass"]',
      'input[id*="password" i]',
      'input[placeholder*="password" i]',
      'input[aria-label*="password" i]',
      'input[type="password"]',
    ], credentials.password) ||
    await fillVisibleInputFallback(page, credentials.password, 'password') ||
    await fillByDomFallback(page, credentials.password, 'password');

  if (!usernameFilled || !passwordFilled) {
    return {
      attempted: true,
      success: false,
      usernameFilled,
      passwordFilled,
      reason: 'Could not populate username or password fields.',
    };
  }

  const beforeUrl = page.url();
  let sawRateLimitStatus = false;
  const onResponse = (response: any) => {
    try { if (response.status() === 429) sawRateLimitStatus = true; } catch { /* ignore */ }
  };
  page.on?.('response', onResponse);
  const isRateLimited = (bodyText: string) => sawRateLimitStatus || /too many requests|too many login attempts|rate[-\s]?limit/i.test(bodyText);
  const submitSelectors = [
    'button[type="submit"]',
    'input[type="submit"]',
    'button:has-text("Sign in")',
    'button:has-text("Login")',
    'button:has-text("Log in")',
    'button:has-text("Submit")',
  ];

  for (const selector of submitSelectors) {
    try {
      const locator = page.locator(selector).first();
      if (await locator.count()) {
        await locator.click({ timeout: 5000 });
        await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => undefined);
        await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => undefined);
        await page.waitForTimeout(1000);
        const bodyText = await page.locator('body').innerText({ timeout: 3000 }).catch(() => '');
        const rateLimited = isRateLimited(bodyText);
        const success = !rateLimited && (page.url() !== beforeUrl || !/sign\s*in|login|404\s+not\s+found/i.test(bodyText));
        page.off?.('response', onResponse);
        return {
          attempted: true,
          success,
          rateLimited,
          usernameFilled,
          passwordFilled,
          reason: success
            ? 'Credentials populated and submitted.'
            : rateLimited
              ? 'Authentication was rate-limited by the target app; scripts were not allowed to keep retrying login.'
            : 'Credentials were populated and submitted, but the target app stayed on login or returned an error.',
          beforeUrl,
          afterUrl: page.url(),
        };
      }
    } catch {
      // Try the next submit selector.
    }
  }

  try {
    await page.keyboard.press('Enter');
    await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => undefined);
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => undefined);
    await page.waitForTimeout(1000);
    const bodyText = await page.locator('body').innerText({ timeout: 3000 }).catch(() => '');
    const rateLimited = isRateLimited(bodyText);
    const success = !rateLimited && (page.url() !== beforeUrl || !/sign\s*in|login|404\s+not\s+found/i.test(bodyText));
    page.off?.('response', onResponse);
    return {
      attempted: true,
      success,
      rateLimited,
      usernameFilled,
      passwordFilled,
      reason: success
        ? 'Credentials populated and submitted with Enter key.'
        : rateLimited
          ? 'Authentication was rate-limited by the target app; scripts were not allowed to keep retrying login.'
        : 'Credentials were populated and submitted with Enter key, but the target app stayed on login or returned an error.',
      beforeUrl,
      afterUrl: page.url(),
    };
  } catch {
    page.off?.('response', onResponse);
    return { attempted: true, success: false, usernameFilled, passwordFilled, reason: 'Credentials filled, but submit failed.' };
  }
}

/**
 * Log in once (using the same robust strategy the inspector uses) and save the
 * authenticated browser session (cookies + localStorage) to a Playwright
 * storageState file. Generated test scripts then start ALREADY logged in, so they
 * never have to re-implement a brittle login against a custom SPA login form.
 */
export interface CapturedSessionStorage {
  origin: string;
  items: Record<string, string>;
}

export async function createAuthStorageState(
  targetUrl: string,
  credentials: any,
  outPath: string,
): Promise<{ ok: boolean; reason?: string; sessionStorage?: CapturedSessionStorage }> {
  const normalizedUrl = normalizeTargetUrl(targetUrl);
  if (!normalizedUrl) return { ok: false, reason: 'No target URL.' };
  if (!credentials?.username || !credentials?.password) return { ok: false, reason: 'No credentials.' };
  const browser = await launchChromiumWithRetry();
  try {
    const retryDelayMs = Math.max(1000, Number(process.env.AUTH_RATE_LIMIT_RETRY_MS) || 15000);
    let lastReason = '';

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const context = await browser.newContext({ viewport: { width: 1365, height: 768 } });
      try {
        const page = await context.newPage();
        await page.goto(normalizedUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        const loginResult = await performLoginIfCredentialsProvided(page, credentials);
        lastReason = loginResult?.reason || '';

        if ((loginResult as any)?.rateLimited) {
          if (attempt === 1) {
            await page.waitForTimeout(retryDelayMs);
            continue;
          }
          return { ok: false, reason: `${lastReason || 'Authentication was rate-limited by the target app.'} Retried once after ${Math.round(retryDelayMs / 1000)}s.` };
        }

        await page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => undefined);
        // Many SPAs (e.g. Core Platform) keep their auth token in sessionStorage, which Playwright's
        // storageState does NOT persist. Wait for the client to actually establish a token before we
        // snapshot, so the captured sessionStorage carries real auth instead of a half-logged-in state.
        await page.waitForFunction(() => {
          for (let i = 0; i < window.sessionStorage.length; i += 1) {
            const k = window.sessionStorage.key(i) || '';
            if (/token|auth|session|jwt/i.test(k)) return true;
          }
          return false;
        }, { timeout: 8000 }).catch(() => undefined);
        await page.waitForTimeout(800);
        await context.storageState({ path: outPath });

        let captured: CapturedSessionStorage | undefined;
        try {
          const items = await page.evaluate(() => {
            const out: Record<string, string> = {};
            for (let i = 0; i < window.sessionStorage.length; i += 1) {
              const k = window.sessionStorage.key(i);
              if (k) out[k] = window.sessionStorage.getItem(k) ?? '';
            }
            return out;
          });
          if (items && Object.keys(items).length) captured = { origin: new URL(normalizedUrl).origin, items };
        } catch { /* sessionStorage capture is best-effort */ }
        return { ok: loginResult?.success !== false, reason: loginResult?.reason, sessionStorage: captured };
      } finally {
        await context.close().catch(() => undefined);
      }
    }

    return { ok: false, reason: lastReason || 'Authentication setup failed.' };
  } catch (err: any) {
    return { ok: false, reason: err?.message || String(err) };
  } finally {
    await browser.close();
  }
}
export async function capturePlaywrightEvidence(targetUrl: string, runId: string, testCases: any[] = [], credentials: any = {}) {
  const normalizedUrl = normalizeTargetUrl(targetUrl);
  if (!normalizedUrl) return [];

  const evidenceDir = path.resolve(process.cwd(), 'evidence');
  await fs.mkdir(evidenceDir, { recursive: true });

  const selectedCases = testCases
    .map((testCase, index) => ({ testCase, index }))
    .filter(({ testCase }) => testCase?.captureEvidence !== false);
  const casesToCapture = selectedCases.length ? selectedCases : [{ testCase: { title: 'Target base URL evidence' }, index: 0 }];
  const browser = await launchChromiumWithRetry();

  try {
    // Log in ONCE into a single context and reuse it for every screenshot — pages in the
    // same context share the session (cookies + localStorage), so we never re-login per
    // case. (The old per-page login made this phase ~Ncases× slower than necessary.)
    const context = await browser.newContext({ viewport: { width: 1365, height: 768 } });
    let loginResult: any = { attempted: false };
    try {
      const authPage = await context.newPage();
      await authPage.goto(normalizedUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      loginResult = await performLoginIfCredentialsProvided(authPage, credentials);
      await authPage.close();
    } catch (e: any) {
      loginResult = { attempted: true, success: false, reason: e?.message || String(e) };
    }

    const evidence = [];
    for (let index = 0; index < casesToCapture.length; index += 1) {
      const { testCase, index: testCaseIndex } = casesToCapture[index];
      const page = await context.newPage(); // already authenticated via the shared context
      const filename = `${runId}-case-${index + 1}.png`;
      const screenshotPath = path.join(evidenceDir, filename);
      const response = await page.goto(normalizedUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => undefined);
      await page.screenshot({ path: screenshotPath, fullPage: true });
      await page.close();

      evidence.push({
        title: testCase?.title || `Test case ${index + 1}`,
        testCaseIndex,
        url: normalizedUrl,
        screenshotUrl: `/evidence/${filename}`,
        status: response?.status() || null,
        login: loginResult,
        capturedAt: new Date().toISOString(),
      });
    }

    return evidence;
  } finally {
    await browser.close();
  }
}
