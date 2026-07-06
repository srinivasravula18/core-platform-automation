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
  /** the element's title ATTRIBUTE (tooltip text) — assertable only via toHaveAttribute */
  title?: string | null;
  visible: boolean;
  labelText: string | null;
  /** accessibility-tree enrichment (a11y-first capture) */
  accName?: string | null; // computed accessible name from the aria snapshot
  interactive?: boolean; // true for elements a user can act on (button/link/input/menuitem/…)
}

export interface ExploreResult {
  url: string;
  count: number;
  elements: DomElement[];
  /** aria snapshot (mode:"ai") — compact semantic YAML outline of the whole page */
  outline?: string | null;
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

// ---- API-token login (ported from agentic-test-platform) ----
// Bypasses the login FORM entirely when the platform exposes a token endpoint: POST /auth/login
// on the API origin, then inject the session token into the UI page's sessionStorage. This avoids
// the login form's rate limiter ("Too many requests") and any location/extra-step gates in the UI.
// Fully app-agnostic at the call layer: origins are PROBED (explicit apiBase → same origin →
// TARGET_BASE_URL env) and a 404 simply falls through to the classic form login.

type CachedToken = { access: string; refresh?: string; family?: string; ts: number };
const tokenCache = new Map<string, CachedToken>();
const TOKEN_TTL_MS = 8 * 60 * 1000;
// While the auth limiter has us blocked (429 + retry-after), do NOT re-POST — every attempt
// during the window extends the lockout.
const authBlockedUntil = new Map<string, number>();

async function fetchAuthToken(origin: string, username: string, password: string): Promise<CachedToken | null> {
  const key = `${origin}:${username}`;
  const cached = tokenCache.get(key);
  if (cached && Date.now() - cached.ts <= TOKEN_TTL_MS) return cached;
  if ((authBlockedUntil.get(key) ?? 0) > Date.now()) return null; // limiter window still open
  try {
    const res = await fetch(`${origin}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
      signal: AbortSignal.timeout(10000),
    });
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after')) || 60;
      authBlockedUntil.set(key, Date.now() + retryAfter * 1000);
      return null;
    }
    if (!res.ok) return null; // no token endpoint here → caller falls back to form login
    const s = (await res.json()) as { access_token?: string; refresh_token?: string; refresh_family_id?: string };
    if (!s.access_token) return null;
    const tok: CachedToken = { access: s.access_token, refresh: s.refresh_token, family: s.refresh_family_id, ts: Date.now() };
    tokenCache.set(key, tok);
    return tok;
  } catch { return null; }
}

/** Inject an auth token into the page's sessionStorage (platform session keys) and land on the shell. */
async function injectToken(page: any, uiBaseUrl: string, tok: CachedToken, username: string): Promise<void> {
  await page.goto(new URL('/', uiBaseUrl).toString(), { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.evaluate((t: { access: string; refresh?: string; family?: string; user: string }) => {
    const set = (k: string, v?: string) => { if (v) sessionStorage.setItem(k, v); };
    sessionStorage.setItem('shockwave.auth_namespace_v1', '1');
    set('shockwave.auth_token', t.access); set('core_platform.auth_token', t.access);
    set('shockwave.current_username', t.user); set('core_platform.current_username', t.user);
    set('shockwave.refresh_token', t.refresh); set('core_platform.refresh_token', t.refresh);
    set('shockwave.refresh_family_id', t.family); set('core_platform.refresh_family_id', t.family);
  }, { access: tok.access, refresh: tok.refresh, family: tok.family, user: username });
}

/** Candidate API origins for the token endpoint, best-first. */
function tokenOriginCandidates(uiUrl: string, apiBase?: string): string[] {
  const out: string[] = [];
  const push = (u?: string) => {
    if (!u) return;
    try { const o = new URL(u).origin; if (!out.includes(o)) out.push(o); } catch { /* skip */ }
  };
  push(apiBase);
  push(uiUrl);
  push(process.env.TARGET_BASE_URL);
  return out;
}

async function apiTokenLogin(page: any, uiUrl: string, username: string, password: string, apiBase?: string): Promise<boolean> {
  for (const origin of tokenOriginCandidates(uiUrl, apiBase)) {
    const tok = await fetchAuthToken(origin, username, password);
    if (!tok) continue;
    try {
      await injectToken(page, uiUrl, tok, username);
      // VERIFY the app accepted the session — a cached token may have been revoked server-side.
      const wall = await page.locator('input[type="password"]').first().isVisible({ timeout: 1500 }).catch(() => false);
      if (!wall) return true;
      tokenCache.delete(`${origin}:${username}`); // dead cached token — drop it and retry fresh
      const fresh = await fetchAuthToken(origin, username, password);
      if (fresh) {
        await injectToken(page, uiUrl, fresh, username);
        const stillWall = await page.locator('input[type="password"]').first().isVisible({ timeout: 1500 }).catch(() => false);
        if (!stillWall) return true;
      }
    } catch { /* try next origin */ }
  }
  return false;
}

async function genericLogin(page: any, url: string, username: string, password: string, apiBase?: string) {
  // Prefer API-token login: it skips the login form (and its rate limiter / extra gates).
  if (await apiTokenLogin(page, url, username, password, apiBase)) return;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.locator('input[type="email"], input[name="email" i], input[name="username" i], input[id*="user" i], input[id*="email" i]').first().fill(username, { timeout: 8000 });
  await page.locator('input[type="password"]').first().fill(password, { timeout: 8000 });
  await page.getByRole('button', { name: /log ?in|sign ?in|submit|continue/i }).first().click({ timeout: 8000 }).catch(async () => {
    await page.locator('input[type="password"]').first().press('Enter');
  });
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
}

/** If the current page is a login wall, sign in and wait until the real app renders, then return
 *  to the ORIGINAL target route. Returns true if a login was performed. */
async function ensureAppLoaded(page: any, login: { username: string; password: string; loginUrl?: string } | undefined, targetUrl: string, apiBase?: string): Promise<boolean> {
  const onLogin = await page.locator('input[type="password"]').first().isVisible({ timeout: 1200 }).catch(() => false);
  if (!login || !onLogin) return false;
  await genericLogin(page, login.loginUrl || targetUrl, login.username, login.password, apiBase).catch(() => {});
  await page.waitForFunction(() => !document.querySelector('input[type="password"]'), { timeout: 15000 }).catch(() => {});
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
  return true;
}

// ---- semantic page capture (a11y-tree-first, DOM-enriched, heuristic sweep as safety net) ----
// Architecture follows the industry pattern (playwright-mcp / Stagehand / browser-use), ported
// from agentic-test-platform's explore.ts:
//   1. ariaSnapshot(mode:"ai") — the browser's own accessibility tree; semantic, 80-90% smaller
//      than raw DOM, includes ONLY meaningful elements, each tagged with a live [ref=eN].
//   2. Each ref is resolved back to its DOM node to pull durable attributes (testid/id/aria/name)
//      — refs die with the page, but generated specs need selectors that survive reloads.
//   3. A heuristic DOM sweep (shadow-DOM aware; cursor/onclick/tabindex/contenteditable) catches
//      interactive elements the a11y tree hides, and is the full fallback if ariaSnapshot fails.

const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'switch', 'slider', 'spinbutton',
  'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'listbox', 'columnheader', 'gridcell', 'row',
]);

/** Attribute puller shared by ref-resolution and the sweep. Runs INSIDE the page (serialized). */
const pullAttrs = (el: any) => {
  const e = el;
  const win = e.ownerDocument.defaultView || window;
  const cs = win.getComputedStyle(e);
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
    // Tooltip text lives in the title ATTRIBUTE — it never appears as page text, so tests
    // must assert it via toHaveAttribute('title', ...). Capture the REAL value here.
    title: e.getAttribute('title'),
    visible: cs.visibility !== 'hidden' && cs.display !== 'none' && e.getClientRects().length > 0,
    labelText: e.labels && e.labels[0] ? (e.labels[0].innerText || '').trim().slice(0, 80) : null,
  };
};

/** Resolve every [ref=eN] in an aria snapshot to its DOM node and pull durable attributes. */
async function resolveSnapshotRefs(page: any, outline: string): Promise<DomElement[]> {
  const refs: { ref: string; role: string; name: string | null }[] = [];
  // snapshot lines look like:  - button "Refresh list view" [ref=e12]
  // Container/prose nodes (generic/paragraph/…) stay in the OUTLINE only — resolving them clutters
  // the element table with concatenated inner text and they're never script targets.
  const KEEP = new Set([...INTERACTIVE_ROLES, 'heading', 'img', 'alert', 'status', 'dialog']);
  for (const m of outline.matchAll(/-\s+([a-z]+)(?:\s+"((?:[^"\\]|\\.)*)")?[^\n]*\[ref=(e\d+)\]/g)) {
    if (!KEEP.has(m[1]!)) continue;
    // An image with no accessible name is a decorative icon — never a test target, pure noise.
    if (m[1] === 'img' && !m[2]) continue;
    refs.push({ role: m[1]!, name: m[2] || null, ref: m[3]! });
  }
  const out: DomElement[] = [];
  const CHUNK = 25; // bounded parallel CDP round-trips
  for (let i = 0; i < refs.length && i < 600; i += CHUNK) {
    const settled = await Promise.all(refs.slice(i, i + CHUNK).map(async (r) => {
      try {
        const a = await page.locator(`aria-ref=${r.ref}`).evaluate(pullAttrs, undefined, { timeout: 3000 });
        return {
          ...a,
          role: a.role ?? r.role,
          accName: r.name ?? a.ariaLabel ?? a.text,
          interactive: INTERACTIVE_ROLES.has(r.role),
        } as DomElement;
      } catch { return null; } // ref went stale (page mutated) — the sweep still covers it
    }));
    out.push(...settled.filter((x): x is DomElement => Boolean(x)));
  }
  return out;
}

/** Heuristic full-DOM sweep (shadow-DOM aware). Catches interactives the a11y tree misses. */
function sweepDom(page: any): Promise<DomElement[]> {
  return page.evaluate(`(() => {
    const pull = ${pullAttrs.toString()};
    const INTERACTIVE_TAGS = new Set(["button", "a", "input", "select", "textarea", "summary", "option"]);
    const INTERACTIVE_ROLES = new Set(${JSON.stringify([...INTERACTIVE_ROLES])});
    const SKIP = new Set(["meta", "link", "script", "style", "title", "base", "noscript", "template", "html", "head", "body", "svg", "path"]);
    const out = [];
    const visit = (root) => {
      for (const e of root.querySelectorAll("*")) {
        if (e.shadowRoot) visit(e.shadowRoot); // pierce open shadow DOM
        const tag = e.tagName.toLowerCase();
        if (SKIP.has(tag)) continue;
        const role = e.getAttribute("role");
        const ti = e.getAttribute("tabindex");
        const parentPointer = e.parentElement && getComputedStyle(e.parentElement).cursor === "pointer";
        const interactive =
          INTERACTIVE_TAGS.has(tag) || (role && INTERACTIVE_ROLES.has(role)) ||
          e.hasAttribute("onclick") || e.hasAttribute("aria-haspopup") || e.isContentEditable ||
          (ti !== null && Number(ti) >= 0) ||
          (getComputedStyle(e).cursor === "pointer" && !parentPointer && !e.closest("a, button")); // pointer style not inherited from a clickable ancestor
        const identity = e.getAttribute("data-testid") || e.getAttribute("data-field") || e.getAttribute("aria-label") || e.getAttribute("placeholder") || (tag === "th" && e.textContent);
        if (!interactive && !identity) continue;
        // skip presentation-only children of an already-clickable ancestor (icon/label spans inside a button)
        const clickAncestor = e.closest("button, a, [role='button'], [role='link'], [role='menuitem']");
        if (clickAncestor && clickAncestor !== e && !identity) continue;
        out.push({ ...pull(e), interactive: Boolean(interactive) });
        if (out.length >= 600) return;
      }
    };
    visit(document);
    return out;
  })()`);
}

/** a11y-tree capture merged with the heuristic sweep; sweep-only when ariaSnapshot is unavailable. */
async function captureSemanticSnapshot(page: any): Promise<{ outline: string | null; elements: DomElement[] }> {
  let outline: string | null = null;
  let elements: DomElement[] = [];
  try {
    outline = await page.locator('body').ariaSnapshot({ mode: 'ai' });
    if (outline) elements = await resolveSnapshotRefs(page, outline);
  } catch { outline = null; }
  const swept: DomElement[] = await sweepDom(page).catch(() => []);
  const sig = (e: DomElement) => [e.tag, e.id, e.testId, e.ariaLabel, e.name, e.dataField, e.placeholder, e.text?.slice(0, 40)].join('|');
  const have = new Set(elements.map(sig));
  for (const s of swept) {
    const k = sig(s);
    if (!have.has(k)) { have.add(k); elements.push({ ...s, accName: s.ariaLabel ?? s.labelText ?? s.text }); }
  }
  return { outline, elements };
}

export async function exploreAppElements(opts: {
  targetUrl: string;
  credentials?: { username: string; password: string };
  loginUrl?: string;
  open?: string[];
  interactions?: { action: 'click' | 'hover' | 'type' | 'scroll' | 'wait'; selector?: string; value?: string; ms?: number }[];
  maxElements?: number;
  /** API/service origin for token login when it differs from the UI origin. */
  apiBase?: string;
}): Promise<ExploreResult> {
  const warnings: string[] = [];
  const browser = await launchChromiumWithRetry({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1365, height: 768 } });
  page.setDefaultTimeout(8000);
  const login = opts.credentials
    ? { username: opts.credentials.username, password: opts.credentials.password, loginUrl: opts.loginUrl }
    : undefined;

  try {
    if (login) {
      await genericLogin(page, login.loginUrl || opts.targetUrl, login.username, login.password, opts.apiBase).catch(() => {});
    }
    await page.goto(opts.targetUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    // Login wall on the requested route → sign in with the stored creds, return to the route.
    await ensureAppLoaded(page, login, opts.targetUrl, opts.apiBase);
    await settle(page);

    let opened = await openPath(page, opts.open);
    // A login wall can also appear mid-flow (session expiry / protected route) — sign in and redo the path once.
    if (await ensureAppLoaded(page, login, opts.targetUrl, opts.apiBase)) {
      await settle(page);
      opened = await openPath(page, opts.open);
    }

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

    const { outline, elements: captured } = await captureSemanticSnapshot(page);
    let elements = captured;
    const max = opts.maxElements ?? 200;
    if (elements.length > max) {
      warnings.push(`explored ${elements.length} elements, capped to ${max} for prompt size`);
      // Keep the elements that matter for test authoring first — interactive and visible ones —
      // instead of the first N in document order (which crowded out below-the-fold controls).
      const score = (e: DomElement) => (e.interactive ? 0 : 2) + (e.visible ? 0 : 1);
      elements = [...elements].sort((a, b) => score(a) - score(b)).slice(0, max);
    }

    return {
      url: page.url(),
      count: elements.length,
      elements,
      outline,
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

// ---- explore + verify + record (the sister-project "explore_page" pipeline, reusable) ----
// One call produces the page's FULL grounded element table: every element extracted
// (a11y-first), its best stable selector resolved, then EVERY selector verified against
// the live DOM and status-tagged. This is what generated scripts must be written from —
// a selector that is not "verified" here will fail at execution time.

export interface VerifiedElement {
  id: string;
  tag: string;
  role: string | null;
  /** best human name: accName → aria-label → text */
  name: string | null;
  text: string | null;
  aria_label: string | null;
  placeholder: string | null;
  input_name: string | null;
  data_field: string | null;
  element_id: string | null;
  type: string | null;
  href: string | null;
  /** REAL tooltip text from the title attribute (assert via toHaveAttribute('title', ...)) */
  tooltip: string | null;
  interactive: boolean;
  resolved_selector: string | null;
  selector_strategy: SelectorStrategy;
  fallback_selector: string | null;
  unique: boolean;
  visible: boolean;
  status: 'verified' | 'not_unique' | 'broken' | 'unresolvable';
  state: { disabled: boolean; readonly: boolean; required: boolean };
}

export interface VerifiedPage {
  url: string;
  outline: string | null;
  opened?: { label: string; opened: boolean }[];
  elements: VerifiedElement[];
  coverage: { total_extracted: number; verified: number; not_unique: number; unresolvable: number; broken: number; loggedIn: boolean };
  warnings: string[];
}

/** Most useful first: verified+unique interactive controls, then the long tail. (Ported ranking.) */
export function rankVerifiedElements<T extends { status?: string; interactive?: boolean; visible?: boolean }>(elements: T[]): T[] {
  const score = (e: { status?: string; interactive?: boolean; visible?: boolean }) =>
    (e.status === 'verified' ? 0 : e.status === 'not_unique' ? 2 : 4) + (e.interactive === false ? 3 : 0) + (e.visible ? 0 : 1);
  return [...elements].sort((a, b) => score(a) - score(b));
}

export async function exploreAndVerifyPage(opts: {
  targetUrl: string;
  credentials?: { username: string; password: string };
  loginUrl?: string;
  open?: string[];
  interactions?: { action: 'click' | 'hover' | 'type' | 'scroll' | 'wait'; selector?: string; value?: string; ms?: number }[];
  apiBase?: string;
  maxElements?: number;
}): Promise<VerifiedPage> {
  const extracted = await exploreAppElements({
    targetUrl: opts.targetUrl,
    credentials: opts.credentials,
    loginUrl: opts.loginUrl,
    open: opts.open,
    interactions: opts.interactions,
    apiBase: opts.apiBase,
    maxElements: opts.maxElements ?? 300,
  });

  const resolved = extracted.elements.map((el) => ({ el, sel: resolveBestSelector(el) }));
  const toVerify = [...new Set(resolved.filter((r) => r.sel.selector).map((r) => r.sel.selector as string))];
  const login = opts.credentials ? { ...opts.credentials, loginUrl: opts.loginUrl } : undefined;
  const ver = toVerify.length
    ? await verifyResolvedSelectors({ targetUrl: opts.targetUrl, selectors: toVerify, open: opts.open, login, apiBase: opts.apiBase })
    : { url: extracted.url, results: [] as { selector: string; count: number; unique: boolean; visible: boolean }[] };
  const verMap = new Map(ver.results.map((r) => [r.selector, r]));

  const elements: VerifiedElement[] = resolved.map(({ el, sel }) => {
    const v = sel.selector ? verMap.get(sel.selector) : undefined;
    const status: VerifiedElement['status'] = !sel.selector ? 'unresolvable' : v && v.count === 0 ? 'broken' : v && !v.unique ? 'not_unique' : 'verified';
    return {
      id: sel.key,
      tag: el.tag,
      role: el.role,
      name: el.accName ?? el.ariaLabel ?? el.text,
      text: el.text,
      aria_label: el.ariaLabel,
      placeholder: el.placeholder,
      input_name: el.name,
      data_field: el.dataField,
      element_id: el.id,
      type: el.type,
      href: el.href,
      tooltip: el.title ?? null,
      interactive: el.interactive !== false,
      resolved_selector: sel.selector,
      selector_strategy: sel.strategy,
      fallback_selector: sel.fallback,
      unique: v?.unique ?? false,
      visible: v?.visible ?? el.visible,
      status,
      state: { disabled: el.disabled, readonly: el.readonly, required: el.required },
    };
  });

  return {
    url: extracted.url,
    outline: extracted.outline ?? null,
    opened: extracted.opened,
    elements,
    coverage: {
      total_extracted: elements.length,
      verified: elements.filter((e) => e.status === 'verified').length,
      not_unique: elements.filter((e) => e.status === 'not_unique').length,
      unresolvable: elements.filter((e) => e.status === 'unresolvable').length,
      broken: elements.filter((e) => e.status === 'broken').length,
      loggedIn: Boolean(opts.credentials),
    },
    warnings: extracted.warnings,
  };
}

export async function verifyResolvedSelectors(opts: {
  targetUrl: string;
  selectors: string[];
  open?: string[];
  login?: { username: string; password: string; loginUrl?: string };
  loginUrl?: string;
  apiBase?: string;
}): Promise<{ url: string; results: { selector: string; count: number; unique: boolean; visible: boolean }[] }> {
  const browser = await launchChromiumWithRetry({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1365, height: 768 } });
  page.setDefaultTimeout(4000);
  const results: { selector: string; count: number; unique: boolean; visible: boolean }[] = [];
  try {
    if (opts.login) {
      await genericLogin(page, opts.login.loginUrl || opts.targetUrl, opts.login.username, opts.login.password, opts.apiBase);
    }
    await page.goto(opts.targetUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await ensureAppLoaded(page, opts.login, opts.targetUrl, opts.apiBase);
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
