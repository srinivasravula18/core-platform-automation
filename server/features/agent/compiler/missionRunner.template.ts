/**
 * MissionRunner template (Phase 4) — the runtime helper SOURCE that the compiler emits into the run's test
 * project (as `mission-runner.ts`) and every compiled spec imports. It is the ONE place allowed to navigate,
 * log in, retry, and verify. Compiled specs never call page.goto / new URL / login — they only build verified
 * locators through `runner.locator(spec)` and assert.
 *
 * Exported as a string so it can be written to disk verbatim; it is Playwright/TS and is executed by
 * `npx playwright test`, not by this project's tsc. Keep it dependency-free beyond @playwright/test.
 */
export const MISSION_RUNNER_SOURCE = String.raw`import { expect, type Page, type Locator } from '@playwright/test';

export interface MissionSpec {
  platform: string;
  platformType: 'ADMIN' | 'RUNTIME' | string;
  runtimeSurface: string | null;
  application: { id: string; name: string } | null;
  module: { id: string; name: string } | null;
  tab: { id: string; name: string } | null;
  targetUrl: string;
  executionScope: string;
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
  constructor(private page: Page, private mission: MissionSpec) {}

  /** The ONLY navigation entry-point for a mission. */
  async startMission(): Promise<void> {
    await this.page.goto(this.mission.targetUrl).catch(() => {});
    await this.page.waitForLoadState('domcontentloaded').catch(() => {});
    await this.verify();
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
    const enforceAppId = this.mission.platformType === 'RUNTIME' && !!this.mission.application;
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
    await this.startMission();
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
  async click(spec: LocatorSpec): Promise<void> { const l = this.locator(spec); await this.reveal(l); await l.click(); }
  async fill(spec: LocatorSpec, value: string): Promise<void> { const l = this.locator(spec); await this.reveal(l); await l.fill(String(value ?? '')); }
  async select(spec: LocatorSpec, value: string): Promise<void> { const l = this.locator(spec); await this.reveal(l); await l.selectOption(String(value ?? '')); }
  async check(spec: LocatorSpec): Promise<void> { const l = this.locator(spec); await this.reveal(l); await l.check(); }
  async uncheck(spec: LocatorSpec): Promise<void> { const l = this.locator(spec); await this.reveal(l); await l.uncheck(); }
  async hover(spec: LocatorSpec): Promise<void> { await this.reveal(this.locator(spec)); }
  async press(spec: LocatorSpec, key: string): Promise<void> { const l = this.locator(spec); await this.reveal(l); await l.press(String(key || 'Enter')); }
  async clear(spec: LocatorSpec): Promise<void> { const l = this.locator(spec); await this.reveal(l); await l.fill(''); }

  // ---- Reveal-then-assert helpers ----
  async expectVisible(spec: LocatorSpec): Promise<void> { const l = this.locator(spec); await this.reveal(l); await expect(l).toBeVisible(); }
  async expectHidden(spec: LocatorSpec): Promise<void> { await expect(this.locator(spec)).toBeHidden(); }
  async expectEnabled(spec: LocatorSpec): Promise<void> { const l = this.locator(spec); await this.reveal(l); await expect(l).toBeEnabled(); }
  async expectDisabled(spec: LocatorSpec): Promise<void> { const l = this.locator(spec); await this.reveal(l); await expect(l).toBeDisabled(); }
  async expectText(spec: LocatorSpec, value: string): Promise<void> { const l = this.locator(spec); await this.reveal(l); await expect(l).toContainText(String(value ?? '')); }
  async expectNotText(spec: LocatorSpec, value: string): Promise<void> { await expect(this.locator(spec)).not.toContainText(String(value ?? '')); }
  async expectValue(spec: LocatorSpec, value: string): Promise<void> { const l = this.locator(spec); await this.reveal(l); await expect(l).toHaveValue(String(value ?? '')); }
  async expectCountGt(spec: LocatorSpec, n: number): Promise<void> { expect(await this.locator(spec).count()).toBeGreaterThan(Number(n) || 0); }

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
