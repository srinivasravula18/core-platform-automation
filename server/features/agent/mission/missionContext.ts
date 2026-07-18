/**
 * MissionContext — the single, TYPED, IMMUTABLE source of truth for "where does this mission execute".
 *
 * Domain model (authoritative):
 *   - ADMIN platform: the Admin Platform itself. It creates tenant apps; it is NOT a tenant app.
 *     Selecting Admin means "target Admin" — application is ALWAYS null and the URL NEVER carries an appId.
 *   - RUNTIME platform: executes a tenant application. Shockwave and Keystone are the SAME platform TYPE
 *     but DIFFERENT deployments/URLs, captured by `runtimeSurface`. A runtime mission REQUIRES an
 *     application (and normally a module/tab); without an application it is not executable.
 *
 * The builder makes invalid states impossible: an admin mission can never carry an application or appId.
 * Every downstream stage consumes this object; NO stage may independently re-resolve platform/application.
 * (Phase 2: this is now the ONLY place platform/application/module/targetUrl are determined.)
 */

export type PlatformType = 'ADMIN' | 'RUNTIME';
export type RuntimeSurface = 'shockwave' | 'keystone';

export interface AppRef { id: string; name: string }
export interface ModuleRef { id: string; name: string }

export interface MissionContext {
  /** Concrete platform label as selected in the UI (e.g. 'Admin' | 'Shockwave' | 'Keystone'). Human/display
   *  facing and stable for grouping; distinct from the coarse `platformType` (ADMIN|RUNTIME). */
  readonly platform: string;
  readonly platformType: PlatformType;
  /** Which runtime deployment (shockwave|keystone) — RUNTIME only; null for ADMIN. */
  readonly runtimeSurface: RuntimeSurface | null;
  /** Tenant application — RUNTIME only; ALWAYS null for ADMIN. */
  readonly application: AppRef | null;
  /** Tab / module / nav section (id is the nav key, e.g. 'objects'|'accounts'); null when unselected. */
  readonly module: ModuleRef | null;
  /** Tab within a module (RUNTIME object tabs); null for ADMIN or when unselected. Distinct from `module`. */
  readonly tab: ModuleRef | null;
  /** Fully-resolved navigation URL. ADMIN never contains appId; RUNTIME always does (when app set). */
  readonly targetUrl: string;
  /** Stable machine scope, e.g. 'ADMIN', 'ADMIN/objects', 'RUNTIME/keystone/CRM',
   *  'RUNTIME/keystone/CRM/accounts', or 'RUNTIME/keystone/UNRESOLVED_APPLICATION'. Appends '/<tab>' when set. */
  readonly executionScope: string;
}

export interface MissionInput {
  platformType: PlatformType;
  /** Surface base URL WITHOUT appId (e.g. https://host/admin-ui/ or https://host/keystone/). */
  baseUrl: string;
  runtimeSurface?: RuntimeSurface | null;
  application?: AppRef | null;
  module?: ModuleRef | null;
  /** Optional explicit platform label (else derived from platformType/runtimeSurface). */
  platform?: string;
  /** Optional tab within the module (RUNTIME object tabs). */
  tab?: ModuleRef | null;
}

const UNRESOLVED = 'UNRESOLVED_APPLICATION';

function withParams(baseUrl: string, params: Record<string, string | undefined>): string {
  const base = String(baseUrl || '').trim();
  if (!base) return base;
  let url: URL;
  try { url = new URL(base); } catch { return base; }
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') url.searchParams.delete(k);
    else url.searchParams.set(k, v);
  }
  return url.toString();
}

/** Build an immutable MissionContext, enforcing every domain invariant. */
export function buildMissionContext(input: MissionInput): MissionContext {
  const platformType: PlatformType = input.platformType === 'RUNTIME' ? 'RUNTIME' : 'ADMIN';
  const module: ModuleRef | null = input.module?.id
    ? { id: String(input.module.id).trim(), name: String(input.module.name || input.module.id).trim() }
    : null;
  const tab: ModuleRef | null = input.tab?.id
    ? { id: String(input.tab.id).trim(), name: String(input.tab.name || input.tab.id).trim() }
    : null;
  const withTab = (scope: string) => (tab ? `${scope}/${tab.id}` : scope);
  const explicitPlatform = input.platform && String(input.platform).trim();
  const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

  if (platformType === 'ADMIN') {
    // Admin has NO tenant application and NO appId — enforced regardless of what was passed in.
    const platform = explicitPlatform || 'Admin';
    const targetUrl = withParams(input.baseUrl, { appId: undefined, object: undefined, nav: module?.id });
    const executionScope = withTab(module ? `ADMIN/${module.id}` : 'ADMIN');
    return Object.freeze({ platform, platformType, runtimeSurface: null, application: null, module, tab, targetUrl, executionScope });
  }

  // RUNTIME
  const runtimeSurface: RuntimeSurface | null = input.runtimeSurface || null;
  const platform = explicitPlatform || cap(runtimeSurface || 'runtime');
  const application: AppRef | null = input.application?.id
    ? { id: String(input.application.id).trim(), name: String(input.application.name || input.application.id).trim() }
    : null;
  const targetUrl = application
    ? withParams(input.baseUrl, { appId: application.id, nav: module?.id })
    : withParams(input.baseUrl, { nav: module?.id });
  const appPart = application?.name || application?.id || UNRESOLVED;
  const surfacePart = runtimeSurface || 'runtime';
  const executionScope = withTab(module ? `RUNTIME/${surfacePart}/${appPart}/${module.id}` : `RUNTIME/${surfacePart}/${appPart}`);
  return Object.freeze({ platform, platformType, runtimeSurface, application, module, tab, targetUrl, executionScope });
}

/** A runtime mission with no application is NOT executable; an admin mission always is. */
export function isMissionExecutable(mc: MissionContext): boolean {
  return mc.platformType === 'ADMIN' || !!mc.application;
}

/** Immutable module change (navigation): a NEW frozen MissionContext with the new module. */
export function withModule(mc: MissionContext, module: ModuleRef | null): MissionContext {
  return buildMissionContext({
    platformType: mc.platformType,
    baseUrl: stripAppScopedParams(mc.targetUrl),
    runtimeSurface: mc.runtimeSurface,
    application: mc.application,
    module,
    platform: mc.platform,
    // A module change resets the tab selection (tabs are module-scoped).
  });
}

/** Strip appId/nav/object to recover the bare surface base. */
export function stripAppScopedParams(targetUrl: string): string {
  return withParams(targetUrl, { appId: undefined, nav: undefined, object: undefined });
}

/**
 * Surface-Consistency Invariant (Phase 1) — seal a provisional mission against the surface discovery landed
 * on, before the Evidence Graph / compiler consume it. Never reads prompt text; only the inspected URL.
 * Enriches a module-null mission from the inspected nav; throws on a genuine surface/app/module conflict.
 */
export function finalizeMissionFromInspectedSurface(mc: MissionContext, inspectedUrl: string): MissionContext {
  const raw = String(inspectedUrl || '').trim();
  if (!raw) return mc;
  let inspected: URL;
  try { inspected = new URL(raw); } catch { return mc; }
  let missionUrl: URL;
  try { missionUrl = new URL(mc.targetUrl); } catch { return mc; }

  const norm = (p: string) => String(p || '').replace(/\/+$/, '');
  const inspectedPath = norm(inspected.pathname);
  const missionPath = norm(missionUrl.pathname);

  // Surface identity = pathname (consistent with buildMissionVerificationSnippet's __onSurface).
  const onSurface = !missionPath
    || inspectedPath === missionPath
    || inspectedPath.startsWith(missionPath + '/')
    || missionPath.startsWith(inspectedPath + '/');
  if (!onSurface) {
    throw new Error(`DISCOVERY SURFACE MISMATCH [${mc.executionScope}] — mission surface "${missionPath}" but discovery landed on "${inspectedPath}".`);
  }

  // A RUNTIME tenant application is pinned; ADMIN's self-assigned system appId is free.
  const realApp = mc.platformType === 'RUNTIME' && !!mc.application && mc.application.id !== ALL_APPS;
  if (realApp) {
    const inspectedAppId = inspected.searchParams.get('appId') || '';
    if (inspectedAppId && inspectedAppId !== mc.application!.id) {
      throw new Error(`DISCOVERY SURFACE MISMATCH [${mc.executionScope}] — mission appId "${mc.application!.id}" but discovery landed on appId "${inspectedAppId}".`);
    }
  }

  const inspectedNav = inspected.searchParams.get('nav') || null;

  // Explicit/existing module is authoritative — a conflicting inspected nav is a hard error.
  if (mc.module) {
    if (inspectedNav && inspectedNav !== mc.module.id) {
      throw new Error(`DISCOVERY SURFACE MISMATCH [${mc.executionScope}] — mission module "${mc.module.id}" but discovery landed on nav "${inspectedNav}".`);
    }
    return mc;
  }

  // Module-null mission: adopt the surface discovery established; nothing to seal when neither has a module.
  if (inspectedNav) return withModule(mc, { id: inspectedNav, name: inspectedNav });
  return mc;
}

/** Infer platform type from a surface name/url (Shockwave & Keystone are RUNTIME). */
export function platformTypeFromSurface(name: string, url: string): PlatformType {
  const hay = `${name || ''} ${url || ''}`.toLowerCase();
  if (/keystone|shockwave|runtime|\/app\b|\/r\//.test(hay)) return 'RUNTIME';
  return 'ADMIN';
}

/** Infer which runtime deployment a surface is (null if not clearly runtime). */
export function runtimeSurfaceFromSurface(name: string, url: string): RuntimeSurface | null {
  const hay = `${name || ''} ${url || ''}`.toLowerCase();
  if (/keystone/.test(hay)) return 'keystone';
  if (/shockwave/.test(hay)) return 'shockwave';
  return null;
}

/** Parse the current nav/module key out of a target URL. */
export function moduleFromUrl(targetUrl: string): string | null {
  try { return new URL(targetUrl).searchParams.get('nav') || null; } catch { return null; }
}

/** A bare "list view" names a UI pattern, not the module whose records should be tested. */
export function needsExplicitListViewModule(prompt: string, explicitModuleId = ''): boolean {
  if (String(explicitModuleId || '').trim()) return false;
  const text = String(prompt || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (!/\blist views?\b/.test(text) || /\b(?:all|every|each|current|this)\s+list views?\b/.test(text)) return false;
  const generic = new Set(['a', 'an', 'the', 'for', 'admin', 'platform', 'feature', 'default', 'new', 'test', 'testing', 'verify', 'validate',
    // Phrase words that can trail "list view in/of/..." without naming a module ("in end to end", "in e2e", "in depth", "in detail").
    'end', 'e2e', 'depth', 'detail', 'details', 'full', 'general']);
  const before = text.match(/\b([a-z0-9_-]+)\s+list views?\b/)?.[1] || '';
  if (before && !generic.has(before)) return false;
  // "list view in X": X is a module only when it is NOT a generic phrase word — "end to end"
  // previously read as module "end" and silently skipped the module question.
  const after = text.match(/\blist views?\s+(?:for|of|in|on|at)\s+(?:the\s+)?([a-z0-9_-]+)\b/)?.[1] || '';
  return !after || generic.has(after);
}

/** DOM evidence is reusable only inside the exact surface/application/module/tab mission. */
export function sameMissionEvidenceScope(previous: MissionContext | null | undefined, current: MissionContext): boolean {
  if (!previous) return false;
  const surface = (value: string) => {
    try { const url = new URL(value); return `${url.origin}${url.pathname.replace(/\/+$/, '')}`; } catch { return ''; }
  };
  return surface(previous.targetUrl) === surface(current.targetUrl)
    && previous.platformType === current.platformType
    && previous.runtimeSurface === current.runtimeSurface
    && (previous.application?.id || '') === (current.application?.id || '')
    && (previous.module?.id || '') === (current.module?.id || '')
    && (previous.tab?.id || '') === (current.tab?.id || '');
}

/**
 * Backward-compatible mapper: derive a MissionContext from the legacy flat `run` fields. Enforces the
 * domain rules even if legacy fields disagree (an admin run stamped with an appId gets it stripped).
 * Read-only; no run mutation.
 */
export function missionContextFromRun(run: any): MissionContext {
  const appUrl = String(run?.app_url || '').trim();
  const surfaceName = String(run?.application_context?.app?.name || run?.appName || '').trim();
  const platformType = platformTypeFromSurface(surfaceName, appUrl);
  const navKey = moduleFromUrl(appUrl);
  const module: ModuleRef | null = navKey ? { id: navKey, name: navKey } : null;
  const baseUrl = stripAppScopedParams(appUrl);
  const platform = surfaceName || undefined;
  if (platformType === 'ADMIN') {
    return buildMissionContext({ platformType, baseUrl, module, platform });
  }
  const appId = String(run?.target_core_app_id || '').trim();
  const application: AppRef | null = appId ? { id: appId, name: String(run?.target_app_label || appId).trim() } : null;
  return buildMissionContext({
    platformType,
    baseUrl,
    runtimeSurface: runtimeSurfaceFromSurface(surfaceName, appUrl),
    application,
    module,
    platform,
  });
}

const ALL_APPS = '__all_apps__';

/**
 * Phase 3 — build a self-contained JS snippet that VERIFIES the live execution context matches this
 * MissionContext before the first assertion, attempts ONE deterministic recovery (re-goto the mission
 * URL), and ABORTS (throws) if still wrong. Never lets a test assert on the wrong platform/app/module.
 * Returns '' when there is nothing enforceable (no mission / no app + no module), so legacy runs are
 * unaffected. The snippet is pure runtime code using the in-scope `page`; it injects no selectors.
 */
export function buildMissionVerificationSnippet(mc: MissionContext | null | undefined): string {
  if (!mc) return '';
  const realApp = mc.platformType === 'RUNTIME' && !!mc.application && mc.application.id !== ALL_APPS;
  // Surface identity = the PATHNAME of the mission URL (e.g. /admin-ui or /keystone). The Admin console
  // legitimately self-assigns its OWN system appId (e.g. app21vhj4w), so Admin is verified by SURFACE +
  // module — NOT by the absence of an appId. A real appId is only pinned for a RUNTIME tenant application.
  let surfacePath = '';
  try { surfacePath = new URL(mc.targetUrl).pathname.replace(/\/+$/, ''); } catch { surfacePath = ''; }
  const want = {
    platform: mc.platformType,
    surfacePath,                                      // must stay on this surface (admin-ui vs a runtime)
    enforceAppId: realApp,                            // runtime real app must match; admin's system appId is free
    appId: realApp ? mc.application!.id : '',
    nav: mc.module?.id || '',                         // module/section must match when selected
    scope: mc.executionScope,
  };
  // Emit verification only when there is a concrete target to pin: ADMIN's identity IS its surface (so a
  // valid surfacePath is enough), while RUNTIME needs a real app or a module (a bare, non-executable runtime
  // mission is left untouched — backward compatible with legacy runs).
  const meaningful = mc.platformType === 'ADMIN' ? !!want.surfacePath : (want.enforceAppId || !!want.nav);
  if (!meaningful) return '';
  return `
  // MISSION VERIFICATION (Phase 3): confirm surface/application/module before asserting — recover once, else abort.
  await (async () => {
    const __want = ${JSON.stringify(want)};
    const __ctx = () => { try { const u = new URL(page.url()); return { path: u.pathname.replace(/\\/+$/, ''), appId: u.searchParams.get('appId') || '', nav: u.searchParams.get('nav') || '' }; } catch { return { path: '', appId: '', nav: '' }; } };
    const __onSurface = (c) => !__want.surfacePath || c.path === __want.surfacePath || c.path.startsWith(__want.surfacePath + '/');
    const __ok = (c) => __onSurface(c) && (__want.enforceAppId ? c.appId === __want.appId : true) && (!__want.nav || c.nav === __want.nav);
    if (!__ok(__ctx())) {
      await page.goto(${JSON.stringify(mc.targetUrl)}).catch(() => {});
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      await page.waitForTimeout(1200);
    }
    const __c = __ctx();
    if (!__ok(__c)) {
      const __reason = __want.enforceAppId && __c.appId !== __want.appId ? 'application' : (__want.nav && __c.nav !== __want.nav ? 'module' : 'surface');
      throw new Error('MISSION CONTEXT MISMATCH [' + __want.scope + '] — expected ' + JSON.stringify(__want) + ' but landed on path="' + __c.path + '" appId="' + __c.appId + '" nav="' + __c.nav + '". Refusing to assert on the wrong ' + __reason + '.');
    }
  })();
`;
}

/**
 * Phase 4 — the authoritative navigation contract handed to the script generator. The generator MUST
 * navigate per this block only and NEVER infer application/tab/module/page from prompt text.
 */
export function renderMissionContextForPrompt(mc: MissionContext | null | undefined): string {
  if (!mc) return '';
  const appLine = mc.platformType === 'ADMIN'
    ? '- Application: NONE (the Admin Platform has no tenant application — never add an appId)'
    : `- Application: ${mc.application?.name || 'UNRESOLVED'}${mc.application?.id ? ` (appId ${mc.application.id})` : ''}`;
  return `
MISSION CONTEXT (AUTHORITATIVE — navigate ONLY per this; NEVER infer application/tab/module/page from the prompt text):
- Platform: ${mc.platformType}${mc.runtimeSurface ? `\n- Runtime deployment: ${mc.runtimeSurface}` : ''}
${appLine}
- Module: ${mc.module?.name || '(none)'}${mc.tab ? `\n- Tab: ${mc.tab.name}` : ''}
- Target URL (the ONLY URL to navigate to — use verbatim for the first goto and every re-navigation): ${mc.targetUrl}
Rules: the appId in the Target URL is FIXED by the mission — never change it, never derive an app/module from prompt text. Re-navigate by rewriting only the "nav" param on this exact URL. Use ONLY verified Selector Registry entries for locators; never concatenate a label with an API name or prefix (never produce values like "App1app1" or "Revenue Hubrev"); preserve each selector's role/selector/text EXACTLY as the registry gives it.
`;
}

/**
 * Phase 4 — deterministic guard: collapse a locator name/text that is an EXACT repeated token (the
 * label+apiname concatenation artifact, e.g. "App1app1" → "App1", "AccountsAccounts" → "Accounts").
 * Conservative: only exact case-insensitive doubles are collapsed, so it never alters a legitimate name.
 */
export function collapseDoubledLabels(code: string): { code: string; fixes: number } {
  let fixes = 0;
  const fixVal = (v: string): string => {
    const m = v.match(/^(.{2,}?)\1$/i); // exact case-insensitive double
    if (m && m[1]) { fixes += 1; return m[1]; }
    return v;
  };
  const out = String(code || '')
    .replace(/(name:\s*)(['"])((?:[^'"\\]|\\.){2,80})\2/g, (_all, pre, q, val) => `${pre}${q}${fixVal(val)}${q}`)
    .replace(/(getBy(?:Text|Label|Placeholder)\(\s*)(['"])((?:[^'"\\]|\\.){2,80})\2/g, (_all, pre, q, val) => `${pre}${q}${fixVal(val)}${q}`);
  return { code: out, fixes };
}

/** Human-readable one-liner for logs/UI. */
export function describeMission(mc: MissionContext): string {
  const tabPart = mc.tab ? ` → ${mc.tab.name}` : '';
  if (mc.platformType === 'ADMIN') return `Admin${mc.module ? ` → ${mc.module.name}` : ''}${tabPart}`;
  const app = mc.application?.name || UNRESOLVED;
  const surf = mc.runtimeSurface ? ` (${mc.runtimeSurface})` : '';
  return `Runtime${surf} → ${app}${mc.module ? ` → ${mc.module.name}` : ''}${tabPart}`;
}
