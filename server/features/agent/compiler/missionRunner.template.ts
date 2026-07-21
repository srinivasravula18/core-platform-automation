/**
 * MissionRunner template (Phase 4) — the runtime helper SOURCE that the compiler emits into the run's test
 * project (as `mission-runner.ts`) and every compiled spec imports. It is the ONE place allowed to navigate,
 * log in, retry, and verify. Compiled specs never call page.goto / new URL / login — they only build verified
 * locators through `runner.locator(spec)` and assert.
 *
 * Exported as a string so it can be written to disk verbatim; it is Playwright/TS and is executed by
 * `npx playwright test`, not by this project's tsc. Keep it dependency-free beyond @playwright/test.
 */
export const MISSION_RUNNER_SOURCE = String.raw`import { test, expect, type Page, type Locator } from '@playwright/test';

export interface MissionSpec {
  platform: string;
  platformType: 'ADMIN' | 'RUNTIME' | string;
  runtimeSurface: string | null;
  application: { id: string; name: string } | null;
  module: { id: string; name: string } | null;
  tab: { id: string; name: string } | null;
  targetUrl: string;
  executionScope: string;
  /** Compiler-derived: the plan sets field values AND clicks a submit-intent control (commits data). */
  mutationIntent?: boolean;
}

/** Verified locator primitives — always sourced from the Selector Registry via the Grounding Engine. */
export interface LocatorSpec {
  selector: string | null;
  selectorType: string | null;
  role: string | null;
  label: string | null;
}

/**
 * Owns authentication (via injected storageState — login is a no-op when pre-authenticated), navigation,
 * mission verification, and retries. Assertions/coverage/business logic live in the spec, never here.
 */
export class MissionRunner {
  private stepIndex = 0;
  private shotCount = 0;
  private static readonly MAX_STEP_SHOTS = 60;

  constructor(private page: Page, private mission: MissionSpec) {}

  /** The ONLY navigation entry-point for a mission. */
  async startMission(): Promise<void> {
    await this.act('startMission', null, this.mission.targetUrl, async () => {
      await this.page.goto(this.mission.targetUrl).catch(() => {});
      await this.page.waitForLoadState('domcontentloaded').catch(() => {});
      await this.verify();
    });
  }

  private info(): any {
    try { return test.info(); } catch { return null; } // outside a test (unit harness) — evidence off
  }

  /** Bounded ordered step screenshot via testInfo.attach('step-N') — evidence only, never fails the test.
   * act() calls this before and after each interaction, so a case's shots form an ordered before/after chain. */
  private async captureStep(): Promise<void> {
    const info = this.info();
    if (!info || this.shotCount >= MissionRunner.MAX_STEP_SHOTS) return;
    try {
      this.stepIndex += 1;
      this.shotCount += 1;
      const body = await this.page.screenshot({ timeout: 4000 });
      await info.attach('step-' + this.stepIndex, { body, contentType: 'image/png' });
    } catch { /* evidence only */ }
  }

  /** Structured step-log entry (parsed server-side into TestResult.stepLogPath) — evidence only. */
  private async logStep(entry: Record<string, unknown>): Promise<void> {
    const info = this.info();
    if (!info) return;
    try { await info.attach('step-log', { body: Buffer.from(JSON.stringify(entry)), contentType: 'application/json' }); } catch { /* evidence only */ }
  }

  /** Wrap every interaction/assertion with ONE result screenshot + a step-log record. One frame per
   * step (the state after the action completes, or the failure state) — so a 4-step case yields 4
   * screenshots. The trace still holds finer per-action detail on demand. */
  private async act<T>(kind: string, spec: LocatorSpec | null, value: string | null, fn: () => Promise<T>): Promise<T> {
    const started = Date.now();
    const label = spec ? (spec.label ?? spec.selector ?? null) : null;
    try {
      const out = await fn();
      await this.captureStep(); // one frame per step: the state after this step completed
      await this.logStep({ n: this.stepIndex, kind, label, value, ok: true, ms: Date.now() - started });
      return out;
    } catch (e: any) {
      await this.captureStep(); // the failure-state frame — what the page looked like when it broke
      await this.logStep({ n: this.stepIndex, kind, label, value, ok: false, ms: Date.now() - started, error: String((e && e.message) || e).slice(0, 400) });
      throw e;
    }
  }

  private ctx(): { path: string; appId: string; nav: string } {
    try {
      const u = new URL(this.page.url());
      return { path: u.pathname.replace(/\/+$/, ''), appId: u.searchParams.get('appId') || '', nav: u.searchParams.get('nav') || '' };
    } catch {
      return { path: '', appId: '', nav: '' };
    }
  }

  /**
   * Verify the live context matches the mission before any assertion. Admin is verified by SURFACE PATH (its
   * self-assigned system appId is legitimate); runtime is verified by the specific tenant appId. Recovers once
   * by re-navigating, else aborts — never asserts on the wrong platform/application/module.
   */
  async verify(): Promise<void> {
    let surfacePath = '';
    try { surfacePath = new URL(this.mission.targetUrl).pathname.replace(/\/+$/, ''); } catch { surfacePath = ''; }
    const appIdRaw = this.mission.application ? String(this.mission.application.id || '') : '';
    const placeholderApp = !appIdRaw || /^__.+__$/.test(appIdRaw);
    // Scope hardening: a data-mutating RUNTIME mission may never execute against a placeholder app id
    // (e.g. __all_apps__) — the mutation would land in an arbitrary tenant app. Read-only sweeps stay allowed.
    if (this.mission.platformType === 'RUNTIME' && this.mission.mutationIntent === true && placeholderApp) {
      throw new Error('MISSION SCOPE VIOLATION [' + this.mission.executionScope + '] — a data-mutating mission cannot run against placeholder application "'
        + (appIdRaw || 'none') + '". Pin ONE concrete tenant app before executing mutations.');
    }
    // A placeholder app id is never a verifiable pinned app — matching it against the URL param would be fake verification.
    const enforceAppId = this.mission.platformType === 'RUNTIME' && !!this.mission.application && !placeholderApp;
    const wantAppId = enforceAppId && this.mission.application ? this.mission.application.id : '';
    const wantNav = this.mission.module ? this.mission.module.id : '';
    const onSurface = (c: { path: string }) => !surfacePath || c.path === surfacePath || c.path.startsWith(surfacePath + '/');
    const okc = (c: { path: string; appId: string; nav: string }) =>
      onSurface(c) && (enforceAppId ? c.appId === wantAppId : true) && (!wantNav || c.nav === wantNav);

    if (!okc(this.ctx())) {
      await this.page.goto(this.mission.targetUrl).catch(() => {});
      await this.page.waitForLoadState('domcontentloaded').catch(() => {});
      await this.page.waitForTimeout(1200);
    }
    const c = this.ctx();
    if (!okc(c)) {
      const reason = enforceAppId && c.appId !== wantAppId ? 'application' : (wantNav && c.nav !== wantNav ? 'module' : 'surface');
      throw new Error('MISSION CONTEXT MISMATCH [' + this.mission.executionScope + '] — executed on the wrong ' + reason
        + '. Expected path="' + surfacePath + '" appId="' + wantAppId + '" nav="' + wantNav + '"'
        + ' but landed path="' + c.path + '" appId="' + c.appId + '" nav="' + c.nav + '".');
    }
  }

  /** Re-navigate to the mission (module is encoded in the mission targetUrl). */
  async openModule(): Promise<void> {
    await this.act('openModule', null, this.mission.targetUrl, async () => {
      await this.page.goto(this.mission.targetUrl).catch(() => {});
      await this.page.waitForLoadState('domcontentloaded').catch(() => {});
      await this.verify();
    });
  }

  /**
   * Make a verified control interactable before acting on it. Many enterprise grids render controls that
   * only APPEAR on hover (column filter/sort/wrap triggers, row action menus, toolbar overflow). Such a
   * control is present + verified in the DOM but not actionable at rest. Hovering the target triggers CSS
   * :hover on the element AND its ancestors (e.g. the owning column header), revealing it — so this makes
   * the whole class of "verified but hover-gated" controls work without hardcoding any app specifics.
   */
  private async reveal(l: Locator): Promise<void> {
    try { await l.scrollIntoViewIfNeeded({ timeout: 2500 }); } catch { /* best effort */ }
    try { await l.hover({ timeout: 2500, force: true }); } catch { /* best effort */ }
  }

  // ---- Reveal-then-act interaction helpers (the compiler emits these instead of raw locator calls) ----
  // Every helper runs through act(): before/after step screenshot + step-log entry, then the interaction.
  async click(spec: LocatorSpec): Promise<void> { await this.act('click', spec, null, async () => { const l = this.locator(spec); await this.reveal(l); await l.click(); }); }
  async fill(spec: LocatorSpec, value: string): Promise<void> { await this.act('fill', spec, String(value ?? ''), async () => { const l = this.locator(spec); await this.reveal(l); await l.fill(String(value ?? '')); }); }
  async select(spec: LocatorSpec, value: string): Promise<void> { await this.act('select', spec, String(value ?? ''), async () => { const l = this.locator(spec); await this.reveal(l); await l.selectOption(String(value ?? '')); }); }
  async check(spec: LocatorSpec): Promise<void> { await this.act('check', spec, null, async () => { const l = this.locator(spec); await this.reveal(l); await l.check(); }); }
  async uncheck(spec: LocatorSpec): Promise<void> { await this.act('uncheck', spec, null, async () => { const l = this.locator(spec); await this.reveal(l); await l.uncheck(); }); }
  async hover(spec: LocatorSpec): Promise<void> { await this.act('hover', spec, null, async () => { await this.reveal(this.locator(spec)); }); }
  async press(spec: LocatorSpec, key: string): Promise<void> { await this.act('press', spec, String(key || 'Enter'), async () => { const l = this.locator(spec); await this.reveal(l); await l.press(String(key || 'Enter')); }); }
  async clear(spec: LocatorSpec): Promise<void> { await this.act('clear', spec, null, async () => {
    const l = this.locator(spec); await this.reveal(l);
    // A native <select>/combobox cannot be .fill('')ed ("Element is not an <input>"): clear it by selecting the
    // empty/placeholder option instead. Text inputs still clear via fill('').
    const role = String(spec.role || '').toLowerCase();
    const tag = await l.evaluate((el) => el.tagName.toLowerCase()).catch(() => '');
    if (tag === 'select' || role === 'combobox' || role === 'listbox') {
      await l.selectOption('').catch(async () => { await l.selectOption({ index: 0 }).catch(() => {}); });
    } else {
      await l.fill('');
    }
  }); }

  // ---- Reveal-then-assert helpers ----
  async expectVisible(spec: LocatorSpec): Promise<void> { await this.act('expectVisible', spec, null, async () => { const l = this.locator(spec); await this.reveal(l); await expect(l).toBeVisible(); }); }
  async expectHidden(spec: LocatorSpec): Promise<void> { await this.act('expectHidden', spec, null, async () => { await expect(this.locator(spec)).toBeHidden(); }); }
  async expectEnabled(spec: LocatorSpec): Promise<void> { await this.act('expectEnabled', spec, null, async () => { const l = this.locator(spec); await this.reveal(l); await expect(l).toBeEnabled(); }); }
  async expectDisabled(spec: LocatorSpec): Promise<void> { await this.act('expectDisabled', spec, null, async () => { const l = this.locator(spec); await this.reveal(l); await expect(l).toBeDisabled(); }); }
  async expectText(spec: LocatorSpec, value: string): Promise<void> { await this.act('expectText', spec, String(value ?? ''), async () => { const l = this.locator(spec); await this.reveal(l); await expect(l).toContainText(String(value ?? '')); }); }
  async expectNotText(spec: LocatorSpec, value: string): Promise<void> { await this.act('expectNotText', spec, String(value ?? ''), async () => { await expect(this.locator(spec)).not.toContainText(String(value ?? '')); }); }
  async expectValue(spec: LocatorSpec, value: string): Promise<void> { await this.act('expectValue', spec, String(value ?? ''), async () => { const l = this.locator(spec); await this.reveal(l); await expect(l).toHaveValue(String(value ?? '')); }); }
  async expectCountGt(spec: LocatorSpec, n: number): Promise<void> { await this.act('expectCountGt', spec, String(n), async () => { expect(await this.locator(spec).count()).toBeGreaterThan(Number(n) || 0); }); }

  // ---- Multi-level context asserts (Phase 4) — mission/page-scoped, owned by the runner ----
  // These are the ONLY sanctioned URL/status/search observations; specs pass expected TEXT, never selectors.

  /** URL contains the fragment (or matches /regex/). The one sanctioned URL assertion. */
  async expectUrl(fragment: string): Promise<void> {
    await this.act('expectUrl', null, fragment, async () => {
      const want = String(fragment || '');
      const m = /^\/(.+)\/([a-z]*)$/.exec(want);
      const re = m ? new RegExp(m[1], m[2]) : new RegExp(want.replace(/[.*+?^$\{\}()|[\]\\]/g, '\\$&'));
      await expect(this.page).toHaveURL(re, { timeout: 10000 });
    });
  }

  /** A toast/alert/status region (ARIA roles/live regions — app-agnostic) shows the expected text. */
  async expectStatusRegion(text: string): Promise<void> {
    await this.act('expectStatusRegion', null, text, async () => {
      const region = this.page.locator('[role="alert"], [role="status"], [aria-live="polite"], [aria-live="assertive"]')
        .filter({ hasText: String(text || '') });
      await expect(region.first()).toBeVisible({ timeout: 10000 });
    });
  }

  /** The page/list shows an EMPTY state: the given empty-state text when provided, else zero data rows. */
  async expectEmptyState(text?: string | null): Promise<void> {
    await this.act('expectEmptyState', null, text ?? null, async () => {
      if (text && String(text).trim()) {
        await expect(this.page.getByText(String(text), { exact: false }).first()).toBeVisible({ timeout: 10000 });
        return;
      }
      // No text given: rows beyond a header row must not exist (role=row covers grids and tables).
      const rows = this.page.getByRole('row');
      await expect.poll(async () => await rows.count(), { timeout: 10000 }).toBeLessThanOrEqual(1);
    });
  }

  /** An ERROR state is visible: an alert region or an invalid-marked control carrying the expected text. */
  async expectErrorState(text: string): Promise<void> {
    await this.act('expectErrorState', null, text, async () => {
      const want = String(text || '');
      const alert = this.page.locator('[role="alert"], [aria-invalid="true"], [aria-errormessage]');
      const scoped = want.trim() ? alert.filter({ hasText: want }) : alert;
      const fallback = want.trim() ? this.page.getByText(want, { exact: false }) : alert;
      const found = (await scoped.count()) > 0 ? scoped : fallback;
      await expect(found.first()).toBeVisible({ timeout: 10000 });
    });
  }

  /** A data row containing the text exists in the current list/grid (role=row — app-agnostic). */
  async expectRowInList(text: string): Promise<void> {
    await this.act('expectRowInList', null, text, async () => {
      const row = this.page.getByRole('row').filter({ hasText: String(text || '') });
      await expect(row.first()).toBeVisible({ timeout: 15000 });
    });
  }

  /** Global search (the page-level searchbox) finds the text — the cross-source consistency probe. */
  async searchGlobalFor(text: string): Promise<void> {
    await this.act('searchGlobalFor', null, text, async () => {
      const want = String(text || '');
      const box = this.page.getByRole('searchbox').first();
      if (await box.count() === 0) {
        throw new Error('GLOBAL SEARCH UNAVAILABLE [' + this.mission.executionScope + '] — no searchbox role found on the page, so "' + want + '" could not be cross-checked.');
      }
      await box.fill(want);
      await box.press('Enter');
      await this.page.waitForTimeout(800); // results render async; bounded settle
      await expect(this.page.getByText(want, { exact: false }).first()).toBeVisible({ timeout: 15000 });
    });
  }

  // ---- Real VERIFY_* expansions (Phase 4) — richer than bare visibility, still evidence-scoped ----

  /** A grounded table/grid is visible; with expected text, a matching data row must exist too. */
  async expectTable(spec: LocatorSpec, value?: string): Promise<void> {
    await this.act('expectTable', spec, value ?? null, async () => {
      const l = this.locator(spec);
      await this.reveal(l);
      await expect(l).toBeVisible();
      if (String(value || '').trim()) {
        await expect(this.page.getByRole('row').filter({ hasText: String(value) }).first()).toBeVisible({ timeout: 10000 });
      }
    });
  }

  /** After filtering, the grounded scope is visible and (when expected text is given) shows a matching row. */
  async expectFiltered(spec: LocatorSpec, value: string): Promise<void> {
    await this.act('expectFiltered', spec, value, async () => {
      const l = this.locator(spec);
      await this.reveal(l);
      await expect(l).toBeVisible();
      if (String(value || '').trim()) {
        await expect(this.page.getByRole('row').filter({ hasText: String(value) }).first()).toBeVisible({ timeout: 10000 });
      }
    });
  }

  /** Column values are actually ORDERED (value hints 'desc'); falls back to visibility when unreadable. */
  async expectSorted(spec: LocatorSpec, value: string): Promise<void> {
    await this.act('expectSorted', spec, value, async () => {
      const l = this.locator(spec);
      await this.reveal(l);
      await expect(l).toBeVisible();
      const texts = (await this.page.getByRole('row').allInnerTexts()).slice(1, 21)
        .map((t) => String(t || '').split('\n')[0].trim().toLowerCase()).filter(Boolean);
      if (texts.length >= 2) {
        const sorted = [...texts].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
        if (/\bdesc/i.test(String(value || ''))) sorted.reverse();
        expect(texts).toEqual(sorted);
      }
    });
  }

  /** A validation failure is visible for the grounded control (invalid marking or an alert nearby). */
  async expectValidation(spec: LocatorSpec, value: string): Promise<void> {
    await this.act('expectValidation', spec, value, async () => {
      const l = this.locator(spec);
      await this.reveal(l);
      const invalid = (await l.getAttribute('aria-invalid').catch(() => null)) === 'true';
      if (invalid) return;
      const alert = this.page.locator('[role="alert"], [aria-invalid="true"], [aria-errormessage]');
      const scoped = String(value || '').trim() ? alert.filter({ hasText: String(value) }) : alert;
      await expect(scoped.first()).toBeVisible({ timeout: 10000 });
    });
  }

  /** Build a Playwright Locator from VERIFIED primitives only — never invents a selector. */
  locator(spec: LocatorSpec): Locator {
    if (spec.selectorType === 'role' && spec.role) {
      return this.page.getByRole(spec.role as any, spec.label ? { name: spec.label, exact: true } : {});
    }
    if (spec.selectorType === 'testid' && spec.selector) {
      const m = /\[data-testid=["']([^"']+)["']\]/.exec(spec.selector);
      if (m) return this.page.getByTestId(m[1]);
    }
    if (spec.selector) return this.page.locator(spec.selector);
    throw new Error('MissionRunner.locator: no verified selector provided for ' + JSON.stringify(spec));
  }
}

export default MissionRunner;
`;
