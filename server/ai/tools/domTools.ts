/**
 * DOM exploration and test execution tools — ported from agentic-test-platform.
 * Provides: explore_page, verify_selectors, get_blackboard, generate_script, run_headless,
 * list_apps, discover_apps, list_surfaces
 */

import type { AgentTool, ToolContext } from './types';
import { exploreAppElements, resolveBestSelector, verifyResolvedSelectors } from '../../features/agent/domExplorer';
import { writeBlackboard, readBlackboard, latestBlackboard, listBlackboard } from '../../features/agent/blackboard';
import { normalizeTargetUrl } from '../../shared/url';
import { db } from '../../shared/storage';


/** Cache DOM exploration results for the same (url, open) within the same session. */
const exploreCache = new Map<string, { ts: number; value: any }>();
const EXPLORE_TTL = 5 * 60 * 1000;

function assertCredentials(targetUrl: string, ctx: ToolContext): { username: string; password: string; loginUrl?: string } | undefined {
  const creds = ctx.siteCredentials as any || db.settings?.siteCredentials?.[0];
  if (!creds?.username || !creds?.password) return undefined;
  return {
    username: creds.username,
    password: creds.password,
    loginUrl: creds.loginUrl || targetUrl,
  };
}

function surfaceBaseUrl(surface?: string): string | null {
  if (!surface) return process.env.TARGET_URL || null;
  const sites = Array.isArray(db.settings?.siteCredentials) ? db.settings.siteCredentials : [];
  const site = sites.find((s: any) => s.name?.toLowerCase() === surface.toLowerCase());
  return site?.baseUrl || process.env.TARGET_URL || null;
}

export const explorePageTool: AgentTool = {
  spec: {
    name: 'explore_page',
    description: 'Grab EVERY interactive element from the LIVE app, resolve the best stable selector for each, verify them in the real browser DOM, and save to the blackboard. Scope with `surface` (configured site name) and `appId`. For SPA features behind navigation, pass `open` with in-app labels discovered from the UI. Do this BEFORE writing any UI script.',
    parameters: {
      type: 'object',
      properties: {
        surface: { type: 'string', description: 'Configured surface/site name' },
        appId: { type: 'string', description: 'App ID for the target app' },
        route: { type: 'string', description: 'Explicit route path (overrides appId-based route building)' },
        open: { type: 'array', items: { type: 'string' }, description: 'In-app nav labels to click in order (discoverable from the UI)' },
        interactions: {
          type: 'array', items: {
            type: 'object',
            properties: {
              action: { type: 'string', enum: ['click', 'hover', 'type', 'scroll', 'wait'] },
              selector: { type: 'string' },
              value: { type: 'string' },
              ms: { type: 'number' },
            },
            required: ['action'],
          },
          description: 'Post-navigation interactions to open modals/dropdowns',
        },
      },
    },
  },
  async execute(args, ctx: ToolContext) {
    const baseUrl = args.surface ? surfaceBaseUrl(String(args.surface)) : (process.env.TARGET_URL || '');
    if (!baseUrl) return { error: 'No target URL. Configure a site in Settings > Connections first.' };

    let route = typeof args.route === 'string' ? args.route : '/';
    if (typeof args.appId === 'string' && args.appId) {
      const nav = typeof args.nav === 'string' && args.nav ? String(args.nav) : '';
      route = `/?appId=${encodeURIComponent(args.appId)}${nav ? `&nav=${encodeURIComponent(nav)}` : ''}`;
    }

    const targetUrl = new URL(route, baseUrl).toString();
    const open = Array.isArray(args.open) ? args.open.filter((x: any): x is string => typeof x === 'string') : undefined;
    const interactions = Array.isArray(args.interactions) ? args.interactions as any : undefined;
    const cacheKey = `${targetUrl}::${open?.join('>') || ''}`;
    const cached = exploreCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < EXPLORE_TTL) return cached.value;

    const creds = assertCredentials(targetUrl, ctx);

    const extracted = await exploreAppElements({
      targetUrl,
      credentials: creds ? { username: creds.username, password: creds.password } : undefined,
      loginUrl: creds?.loginUrl,
      open,
      interactions,
    });

    if (extracted.warnings.length && extracted.count === 0) return { error: extracted.warnings[0], url: extracted.url, warnings: extracted.warnings };

    const resolved = extracted.elements.map((el) => ({ el, sel: resolveBestSelector(el) }));
    const toVerify = [...new Set(resolved.filter((r) => r.sel.selector).map((r) => r.sel.selector as string))];
    const ver = toVerify.length ? await verifyResolvedSelectors({
      targetUrl,
      selectors: toVerify,
      open,
      login: creds,
      loginUrl: creds?.loginUrl,
    }) : { url: extracted.url, results: [] };
    const verMap = new Map(ver.results.map((r) => [r.selector, r]));

    const elements = resolved.map(({ el, sel }) => {
      const v = sel.selector ? verMap.get(sel.selector) : undefined;
      const status = !sel.selector ? 'unresolvable' : v && v.count === 0 ? 'broken' : v && !v.unique ? 'not_unique' : 'verified';
      return {
        id: sel.key, tag: el.tag, role: el.role, text: el.text,
        aria_label: el.ariaLabel, placeholder: el.placeholder, name: el.name,
        type: el.type, data_field: el.dataField, element_id: el.id, test_id: el.testId,
        href: el.href,
        resolved_selector: sel.selector, selector_strategy: sel.strategy,
        fallback_selector: sel.fallback,
        unique: v?.unique ?? false, visible: v?.visible ?? el.visible,
        status,
        state: { disabled: el.disabled, readonly: el.readonly, required: el.required },
        reason: sel.reason,
      };
    });

    const coverage = {
      total_extracted: elements.length,
      verified: elements.filter((e) => e.status === 'verified').length,
      not_unique: elements.filter((e) => e.status === 'not_unique').length,
      unresolvable: elements.filter((e) => e.status === 'unresolvable').length,
      broken: elements.filter((e) => e.status === 'broken').length,
      loggedIn: Boolean(creds),
    };

    const blackboardId = `${targetUrl}${open?.length ? `#${open.join('>')}` : ''}`;
    writeBlackboard({ id: blackboardId, baseUrl: targetUrl, route, opened: open, elements, coverage });

    const result = {
      url: extracted.url,
      coverage,
      elements: elements.slice(0, 60),
      blackboard_id: blackboardId,
      warnings: extracted.warnings,
    };

    exploreCache.set(cacheKey, { ts: Date.now(), value: result });
    return result;
  },
};

export const getBlackboardTool: AgentTool = {
  spec: {
    name: 'get_blackboard',
    description: 'Read the saved verified selectors for a page (from explore_page). Pass the same `route`/`open` you explored with. Use these EXACT selectors when writing the Playwright script — never invent selectors.',
    parameters: {
      type: 'object',
      properties: {
        route: { type: 'string', description: 'The route path explored' },
        open: { type: 'array', items: { type: 'string' }, description: 'The in-app nav labels used during exploration' },
        surface: { type: 'string', description: 'Surface name used during exploration' },
        id: { type: 'string', description: 'Exact blackboard_id returned by explore_page or the run pipeline' },
        filter: { type: 'string', description: 'Case-insensitive text filter over label/text/name/selector fields' },
        role: { type: 'string', description: 'Optional accessible role/tag filter' },
        limit: { type: 'number', description: 'Maximum returned elements; default 80' },
        offset: { type: 'number', description: 'Offset for paging through large blackboards; default 0' },
        full: { type: 'boolean', description: 'Return full element records instead of compact selector rows' },
      },
    },
  },
  async execute(args, ctx: ToolContext) {
    const baseUrl = args.surface ? surfaceBaseUrl(String(args.surface)) : (process.env.TARGET_URL || '');
    const route = typeof args.route === 'string' ? args.route : '/';
    const open = Array.isArray(args.open) ? args.open.filter((x: any): x is string => typeof x === 'string') : undefined;
    const blackboardId = `${baseUrl}${route}${open?.length ? `#${open.join('>')}` : ''}`;
    let entry = typeof args.id === 'string' && args.id.trim() ? readBlackboard(args.id.trim()) : readBlackboard(blackboardId);
    if (!entry) entry = latestBlackboard();
    if (!entry) return { found: false, available: listBlackboard().map((b) => ({ id: b.id, route: b.route, createdAt: b.createdAt })), note: 'No blackboard for this route yet — run explore_page first.' };
    const filter = String(args.filter || '').trim().toLowerCase();
    const role = String(args.role || '').trim().toLowerCase();
    const limit = Math.max(1, Math.min(500, Number(args.limit) || 80));
    const offset = Math.max(0, Number(args.offset) || 0);
    const labelOf = (e: any) => String(e.name || e.aria_label || e.ariaLabel || e.text || e.placeholder || e.element_id || e.id || '').replace(/\s+/g, ' ').trim();
    const selectorOf = (e: any) => String(e.resolved_selector || e.fallback_selector || e.selector || '');
    let elements = Array.isArray(entry.elements) ? entry.elements : [];
    if (role) elements = elements.filter((e: any) => String(e.role || e.tag || '').toLowerCase() === role);
    if (filter) elements = elements.filter((e: any) => `${labelOf(e)} ${selectorOf(e)} ${e.role || ''} ${e.tag || ''}`.toLowerCase().includes(filter));
    const slice = elements.slice(offset, offset + limit);
    const compact = slice.map((e: any, index: number) => ({
      index: offset + index,
      role: e.role || e.tag || 'element',
      label: labelOf(e),
      selector: selectorOf(e),
      status: e.status,
      visible: e.state?.visible,
      enabled: e.state?.enabled,
      disabled: e.state?.disabled,
      required: e.state?.required,
    }));
    return {
      found: true,
      id: entry.id,
      route: entry.route,
      baseUrl: entry.baseUrl,
      opened: entry.opened || [],
      coverage: entry.coverage,
      total: elements.length,
      offset,
      limit,
      elements: args.full ? slice : compact,
      available: listBlackboard().slice(0, 10).map((b) => ({ id: b.id, route: b.route, createdAt: b.createdAt })),
    };
  },
};

export const verifySelectorsTool: AgentTool = {
  spec: {
    name: 'verify_selectors',
    description: 'Verify specific selectors/labels exist in the live app DOM. Pass candidate labels/selectors from your test plan. If no candidates are provided and explore_page was already run, it redirects you to use get_blackboard instead.',
    parameters: {
      type: 'object',
      properties: {
        baseUrl: { type: 'string', description: 'Target base URL' },
        route: { type: 'string', description: 'Route path to verify against' },
        candidates: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              kind: { type: 'string', enum: ['label', 'role', 'text', 'placeholder', 'testid', 'selector'] },
              value: { type: 'string' },
              role: { type: 'string' },
            },
            required: ['kind', 'value'],
          },
        },
        open: { type: 'array', items: { type: 'string' } },
      },
    },
  },
  async execute(args, ctx: ToolContext) {
    const candidates = Array.isArray(args.candidates) ? args.candidates : [];
    if (!candidates.length) {
      return { ok: true, skipped: true, note: 'No candidates provided. explore_page already verifies every selector against the live DOM and saves to the blackboard. Call get_blackboard instead.' };
    }

    const baseUrl = String(args.baseUrl || process.env.TARGET_URL || '');
    const route = String(args.route || '/');
    const targetUrl = new URL(route, baseUrl).toString();
    const open = Array.isArray(args.open) ? args.open.filter((x: any): x is string => typeof x === 'string') : undefined;
    const creds = assertCredentials(targetUrl, ctx);

    const selectors = candidates.map((c: any) => {
      const v = String(c.value || '');
      switch (c.kind) {
        case 'label': return `[aria-label="${v.replace(/"/g, '\\"')}"]`;
        case 'role': return `role=${c.role || 'button'}[name="${v.replace(/"/g, '\\"')}"]`;
        case 'placeholder': return `[placeholder="${v.replace(/"/g, '\\"')}"]`;
        case 'testid': return `[data-testid="${v.replace(/"/g, '\\"')}"]`;
        case 'selector': return v;
        default: return `text="${v.replace(/"/g, '\\"')}"`;
      }
    });

    const ver = await verifyResolvedSelectors({
      targetUrl,
      selectors,
      open,
      login: creds,
      loginUrl: creds?.loginUrl,
    });

    const results = candidates.map((c: any, i: number) => ({
      kind: c.kind,
      value: c.value,
      selector: selectors[i],
      ...ver.results[i] || { count: 0, unique: false, visible: false },
    }));

    return { url: ver.url, results };
  },
};

export const listSurfacesTool: AgentTool = {
  spec: {
    name: 'list_surfaces',
    description: 'List the configured platform surfaces by NAME only so the user can pick one to test. Surfaces sharing a platformKey share one metadata backend.',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  async execute(args, ctx: ToolContext) {
    const sites = Array.isArray(db.settings?.siteCredentials) ? db.settings.siteCredentials : [];
    const surfaces = sites.length
      ? sites.map((s: any) => ({ name: s.name, url: s.baseUrl, label: s.label || s.name }))
      : [{ name: 'configured', url: process.env.TARGET_URL || '', label: 'Configured' }];
    return { surfaces };
  },
};

export const discoverAppsTool: AgentTool = {
  spec: {
    name: 'discover_apps',
    description: 'Discover the apps on a platform surface by inspecting the live UI. Opens the target URL and collects every interactive element. Returns the app names found in links and buttons.',
    parameters: {
      type: 'object',
      properties: {
        surface: { type: 'string', description: 'Configured surface/site name' },
      },
    },
  },
  async execute(args, ctx: ToolContext) {
    const baseUrl = args.surface ? surfaceBaseUrl(String(args.surface)) : (process.env.TARGET_URL || '');
    if (!baseUrl) return { error: 'No target URL configured.' };
    const creds = assertCredentials(baseUrl, ctx);
    const result = await exploreAppElements({
      targetUrl: baseUrl,
      credentials: creds ? { username: creds.username, password: creds.password } : undefined,
      loginUrl: creds?.loginUrl,
    });
    const appLinks = result.elements.filter((e) => e.tag === 'a' || e.role === 'link' || e.role === 'button');
    const appNames = [...new Set(appLinks.map((e) => e.text || e.ariaLabel || '').filter(Boolean))];
    return { surface: args.surface || 'configured', baseUrl, apps: appNames, note: 'Open an app with explore_page using its discovered label.' };
  },
};
