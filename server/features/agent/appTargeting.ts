/**
 * App-within-a-surface targeting.
 *
 * A platform has surfaces, and each surface hosts many individual apps that form a parent-app
 * hierarchy. Each app owns its objects/tabs.
 *
 * The user names an app in their prompt; we resolve that name to the platform's real app `id`
 * (e.g. app0000006) from the live apps API, then build a deep-link URL that opens THAT app on the
 * chosen surface so inspection + evidence run inside it:
 *   <base>/?<search-params>
 *
 * All resolution is best-effort: if the apps API can't be reached, callers fall back to targeting
 * the bare surface.
 */

import type { CatalogConn } from '../../ai/tools/corePlatformData';
import { fetchCorePlatformApps, fetchCorePlatformAppTabs } from '../../ai/tools/corePlatformData';

export interface PlatformApp {
  id: string;
  label: string;
  api_name: string;
  app_prefix: string;
  parent_app_id: string | null;
}

export type SurfaceKind = string;

/** Sentinel the platform uses for "every app". */
export const ALL_APPS_ID = '__all_apps__';

/**
 * Detect the surface kind from URL query parameters. Defaults to admin.
 */
export function detectSurfaceKind(_appName: string, _baseUrl: string): SurfaceKind {
  return 'admin';
}

function normalize(value: string): string {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Does the prompt describe a data-MUTATING flow (create/update/delete/submit…) rather than a read-only
 * check? Used to harden mission scope: a mutation may never sweep "all apps" — it would write into an
 * arbitrary tenant app (observed live: a create scoped __all_apps__ landed in App1 and still PASSED).
 * Verb list is app-agnostic; false positives only mean we ask the user for a concrete app (safe direction).
 */
export function isMutationIntent(promptText: string): boolean {
  const t = String(promptText || '');
  return /\b(create|creating|add|adding|register|sign\s?up|update|updating|edit|editing|modify|change|rename|delete|deleting|remove|removing|deactivate|activate|archive|submit|save|saving|import|upload|assign|approve|reject|clone|duplicate|merge|transfer)\b/i.test(t);
}

/** Does the prompt explicitly ask for a cross-app / whole-surface sweep? */
export function wantsAllApps(promptText: string): boolean {
  return /\ball apps\b|\bevery app\b|\bacross apps\b|\bwhole (surface|platform)\b|\bentire (surface|platform)\b/i.test(
    String(promptText || ''),
  );
}

/**
 * Resolve the app the user named to a real platform app, matching by label / name/identifier / prefix.
 * Returns { app } on a confident match, { allApps: true } when the prompt asked for all apps, or
 * { candidates } (the full list) when nothing / something ambiguous matched so the caller can ask.
 */
export function resolveTargetApp(
  apps: PlatformApp[],
  promptText: string,
): { app?: PlatformApp; allApps?: boolean; candidates: PlatformApp[] } {
  const list = Array.isArray(apps) ? apps.filter((a) => a && a.id) : [];
  if (wantsAllApps(promptText)) return { allApps: true, candidates: list };
  if (!list.length) return { candidates: [] };

  const text = ` ${normalize(promptText)} `;
  // Rank by the most specific match: exact label phrase, then name/identifier, then prefix.
  const scored = list
    .map((app) => {
      const label = normalize(app.label);
      const api = normalize(app.api_name);
      const prefix = normalize(app.app_prefix);
      let score = 0;
      if (label && text.includes(` ${label} `)) score = 3;
      else if (api && text.includes(` ${api} `)) score = 2;
      else if (prefix && prefix.length >= 3 && text.includes(` ${prefix} `)) score = 1;
      return { app, score, labelLen: label.length };
    })
    .filter((s) => s.score > 0)
    // Prefer the strongest match; on a tie prefer the longer (more specific) label.
    .sort((a, b) => b.score - a.score || b.labelLen - a.labelLen);

  if (scored.length && (scored.length === 1 || scored[0].score > scored[1].score || scored[0].labelLen !== scored[1].labelLen)) {
    return { app: scored[0].app, candidates: list };
  }
  return { candidates: list };
}

/** Build the deep-link URL that opens `appId` on the given surface. */
export function buildAppScopedUrl(
  baseUrl: string,
  kind: SurfaceKind,
  appId: string,
  opts: { nav?: string; objectApiName?: string } = {},
): string {
  const base = String(baseUrl || '').trim();
  if (!base || !appId) return base;
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return base;
  }
  url.searchParams.set('appId', appId);
  if (opts.nav) url.searchParams.set('nav', opts.nav);
  if (opts.objectApiName) url.searchParams.set('object', opts.objectApiName);
  return url.toString();
}

/** A CatalogConn from a run's resolved surface + credentials (for the apps/tabs API calls). */
export function connForRun(baseUrl: string, credentials: any, specPath?: string): CatalogConn {
  return {
    baseUrl,
    specPath: specPath || '',
    token: credentials?.token || '',
    username: credentials?.username || '',
    password: credentials?.password || '',
  };
}

export { fetchCorePlatformApps, fetchCorePlatformAppTabs };
