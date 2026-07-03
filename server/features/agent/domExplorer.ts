import { launchChromiumWithRetry } from '../../shared/browser';

export interface DomElement {
  tag: string;
  text: string | null;
  role: string | null;
  ariaLabel: string | null;
  testId: string | null;
  dataField: string | null;
  name: string | null;
  id: string | null;
  href: string | null;
  type: string | null;
  placeholder: string | null;
  disabled: boolean;
  readonly: boolean;
  required: boolean;
  ariaExpanded: string | null;
  ariaHasPopup: string | null;
  visible: boolean;
  labelText: string | null;
}

export interface ExploreResult {
  url: string;
  count: number;
  elements: DomElement[];
  opened?: { label: string; opened: boolean }[];
  warnings: string[];
}

async function settle(page: any, budgetMs = 6000) {
  await page.waitForLoadState('networkidle', { timeout: budgetMs }).catch(() => {});
  let prev = -1, stable = 0;
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline && stable < 2) {
    const n = await page.locator('button, a, input, select, textarea, [role]').count().catch(() => 0);
    if (n === prev) stable++; else { stable = 0; prev = n; }
    await page.waitForTimeout(250);
  }
}

async function clickLabel(page: any, label: string): Promise<boolean> {
  const esc = label.replace(/"/g, '\\"');
  const tries = [
    () => page.getByRole('button', { name: label }),
    () => page.getByRole('link', { name: label }),
    () => page.getByRole('menuitem', { name: label }),
    () => page.getByRole('tab', { name: label }),
    () => page.locator(`[aria-label="${esc}"]`),
    () => page.getByText(label, { exact: false }),
  ];
  for (const make of tries) {
    try { await make().first().click({ timeout: 3500 }); await settle(page); return true; } catch { /* try next */ }
  }
  return false;
}

async function openPath(page: any, open?: string[]): Promise<{ label: string; opened: boolean }[]> {
  const trail: { label: string; opened: boolean }[] = [];
  for (const label of open ?? []) trail.push({ label, opened: await clickLabel(page, label) });
  return trail;
}

async function genericLogin(page: any, url: string, username: string, password: string) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.locator('input[type="email"], input[name="email" i], input[name="username" i], input[id*="user" i], input[id*="email" i]').first().fill(username, { timeout: 8000 });
  await page.locator('input[type="password"]').first().fill(password, { timeout: 8000 });
  await page.getByRole('button', { name: /log ?in|sign ?in|submit|continue/i }).first().click({ timeout: 8000 }).catch(async () => {
    await page.locator('input[type="password"]').first().press('Enter');
  });
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
}

const EXPLORE_SELECTOR = [
  'button', 'a[href]', 'input', 'select', 'textarea',
  "[role='button']", "[role='link']", "[role='menuitem']", "[role='menuitemcheckbox']", "[role='menuitemradio']",
  "[role='tab']", "[role='checkbox']", "[role='radio']", "[role='combobox']", "[role='switch']", "[role='option']",
  "[role='columnheader']", "[role='gridcell']", "th[role='columnheader']", "th",
  '[aria-label]', '[data-testid]', '[data-field]', '[name]', '[placeholder]', '[aria-haspopup]',
].join(', ');

function collectElements(page: any): Promise<DomElement[]> {
  return page.evaluate((selector: string) => {
    const seen = new Set<Element>();
    return Array.from(document.querySelectorAll(selector))
      .filter((el) => !seen.has(el) && seen.add(el))
      .map((el) => {
        const e = el as HTMLElement & { readOnly?: boolean; disabled?: boolean; required?: boolean; labels?: NodeListOf<HTMLElement> };
        return {
          tag: e.tagName.toLowerCase(),
          text: (e.innerText || '').trim().slice(0, 80) || null,
          role: e.getAttribute('role'),
          ariaLabel: e.getAttribute('aria-label'),
          testId: e.getAttribute('data-testid'),
          dataField: e.getAttribute('data-field'),
          name: e.getAttribute('name'),
          id: e.id || null,
          href: e.getAttribute('href'),
          type: e.getAttribute('type'),
          placeholder: e.getAttribute('placeholder'),
          disabled: Boolean(e.disabled),
          readonly: Boolean(e.readOnly),
          required: Boolean(e.required),
          ariaExpanded: e.getAttribute('aria-expanded'),
          ariaHasPopup: e.getAttribute('aria-haspopup'),
          visible: e.offsetParent !== null,
          labelText: e.labels && e.labels[0] ? (e.labels[0].innerText || '').trim().slice(0, 80) : null,
        } as any;
      });
  }, EXPLORE_SELECTOR);
}

export async function exploreAppElements(opts: {
  targetUrl: string;
  credentials?: { username: string; password: string };
  loginUrl?: string;
  open?: string[];
  interactions?: { action: 'click' | 'hover' | 'type' | 'scroll' | 'wait'; selector?: string; value?: string; ms?: number }[];
  maxElements?: number;
}): Promise<ExploreResult> {
  const warnings: string[] = [];
  const browser = await launchChromiumWithRetry({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1365, height: 768 } });
  page.setDefaultTimeout(8000);

  try {
    if (opts.credentials) {
      await genericLogin(page, opts.loginUrl || opts.targetUrl, opts.credentials.username, opts.credentials.password);
    }
    await page.goto(opts.targetUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await settle(page);

    const opened = await openPath(page, opts.open);

    for (const step of opts.interactions ?? []) {
      try {
        if (step.action === 'click' && step.selector) await page.click(step.selector);
        else if (step.action === 'hover' && step.selector) await page.hover(step.selector);
        else if (step.action === 'type' && step.selector) await page.fill(step.selector, step.value ?? '');
        else if (step.action === 'scroll') await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        else if (step.action === 'wait') await page.waitForTimeout(step.ms ?? 500);
        await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
      } catch { /* step failed — keep going */ }
    }
    await settle(page);

    let elements = await collectElements(page);
    const max = opts.maxElements ?? 200;
    if (elements.length > max) {
      warnings.push(`explored ${elements.length} elements, capped to ${max} for prompt size`);
      elements = elements.slice(0, max);
    }

    return {
      url: page.url(),
      count: elements.length,
      elements,
      opened,
      warnings,
    };
  } catch (e: any) {
    return {
      url: page.url(),
      count: 0,
      elements: [],
      warnings: [...warnings, `DOM exploration error: ${e?.message || String(e)}`],
    };
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

// ---- generic, app-agnostic selector resolution (ported from agentic-test-platform) ----

export type SelectorStrategy = 'data-testid' | 'id' | 'name' | 'data-field' | 'aria-label' | 'placeholder' | 'role+name' | 'text' | 'unresolvable';

export interface ResolvedSelector {
  key: string;
  strategy: SelectorStrategy;
  selector: string | null;
  fallback: string | null;
  reason?: string;
}

const q = (s: string) => s.replace(/"/g, '\\"');
const isDynamicId = (id: string) => /[a-f0-9]{8,}/i.test(id) || /:r[0-9a-z]+:/i.test(id) || /\d{5,}/.test(id) || id.length > 64;
const simpleId = (id: string) => /^[A-Za-z][\w-]*$/.test(id);

function slug(...parts: (string | null | undefined)[]): string {
  const base = parts.find((p) => p && p.trim()) ?? 'el';
  return base.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'el';
}

function candidatesFor(el: DomElement): { strategy: SelectorStrategy; selector: string }[] {
  const out: { strategy: SelectorStrategy; selector: string }[] = [];
  if (el.testId) out.push({ strategy: 'data-testid', selector: `[data-testid="${q(el.testId)}"]` });
  if (el.id && !isDynamicId(el.id)) out.push({ strategy: 'id', selector: simpleId(el.id) ? `#${el.id}` : `[id="${q(el.id)}"]` });
  if (el.name) out.push({ strategy: 'name', selector: `[name="${q(el.name)}"]` });
  if (el.dataField) out.push({ strategy: 'data-field', selector: `[data-field="${q(el.dataField)}"]` });
  if (el.ariaLabel) out.push({ strategy: 'aria-label', selector: `[aria-label="${q(el.ariaLabel)}"]` });
  if (el.placeholder) out.push({ strategy: 'placeholder', selector: `[placeholder="${q(el.placeholder)}"]` });
  const accName = el.ariaLabel || el.text || el.labelText;
  if (el.role && accName) out.push({ strategy: 'role+name', selector: `role=${el.role}[name="${q(accName)}"]` });
  if (!el.role && el.tag === 'th' && el.text) out.push({ strategy: 'role+name', selector: `role=columnheader[name="${q(el.text)}"]` });
  if (el.text && el.text.length <= 40) out.push({ strategy: 'text', selector: `text="${q(el.text)}"` });
  return out;
}

export function resolveBestSelector(el: DomElement): ResolvedSelector {
  const key = slug(el.text, el.ariaLabel, el.name, el.labelText, el.testId) + `_${el.role || el.tag}`;
  const cands = candidatesFor(el);
  if (cands.length === 0) {
    return { key, strategy: 'unresolvable', selector: null, fallback: null, reason: 'no stable attribute' };
  }
  return { key, strategy: cands[0].strategy, selector: cands[0].selector, fallback: cands[1]?.selector ?? null };
}

export async function verifyResolvedSelectors(opts: {
  targetUrl: string;
  selectors: string[];
  open?: string[];
  login?: { username: string; password: string; loginUrl?: string };
  loginUrl?: string;
}): Promise<{ url: string; results: { selector: string; count: number; unique: boolean; visible: boolean }[] }> {
  const browser = await launchChromiumWithRetry({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1365, height: 768 } });
  page.setDefaultTimeout(4000);
  const results: { selector: string; count: number; unique: boolean; visible: boolean }[] = [];
  try {
    if (opts.login) {
      await genericLogin(page, opts.login.loginUrl || opts.targetUrl, opts.login.username, opts.login.password);
    }
    await page.goto(opts.targetUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await settle(page);
    await openPath(page, opts.open);
    for (const selector of opts.selectors) {
      try {
        const loc = page.locator(selector);
        const count = await loc.count();
        const visible = count > 0 ? await loc.first().isVisible().catch(() => false) : false;
        results.push({ selector, count, unique: count === 1, visible });
      } catch {
        results.push({ selector, count: 0, unique: false, visible: false });
      }
    }
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
  return { url: page.url(), results };
}
