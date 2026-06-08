import { chromium } from 'playwright';

const url = process.argv[2] || 'http://54.205.160.97:5002/';
const username = process.argv[3] || '';
const password = process.argv[4] || '';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1365, height: 768 } });

try {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  const usernameField = page.getByLabel(/email\s*or\s*username|username|email/i);
  const passwordField = page.getByLabel(/password/i);

  await usernameField.fill(username);
  await passwordField.fill(password);

  const before = {
    url: page.url(),
    usernameValue: await usernameField.inputValue(),
    passwordFilled: (await passwordField.inputValue()).length > 0,
    body: (await page.locator('body').innerText()).slice(0, 160),
  };

  await page.locator('button[type="submit"], button:has-text("Sign in")').first().click();
  await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => undefined);
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => undefined);
  await page.waitForTimeout(1500);

  const after = {
    url: page.url(),
    body: (await page.locator('body').innerText()).slice(0, 500),
  };

  console.log(JSON.stringify({ before, after }, null, 2));
} finally {
  await browser.close();
}
