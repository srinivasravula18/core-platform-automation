/**
 * Repo selector-map cache — extracted from the routes.ts god-object (Phase 8, decomposition slice 1).
 *
 * A pure, self-contained helper cluster (no Express, no request state): it caches the STATIC_SOURCE
 * selector map extracted from a project's repo, scoped by repo path + appId so sibling apps sharing one
 * repo never cross-contaminate. Moved out verbatim (behavior-identical) to start shrinking routes.ts into
 * focused modules per the agent-native plan; routes.ts now imports `getRunSelectorMap` from here.
 */
import path from 'path';
import { existsSync } from 'fs';
import { extractSelectorMap, type SelectorMap } from '../selectorMap';
import { getApp, getProjectRepoPath } from '../../projects/projectService';

// Keyed by the SCOPED path AND appId so two apps that share one repo never get each other's selector map.
// When an app declares a repoSubpath, extraction is scoped to that subtree so its selectors don't include
// the sibling app's. Falls back to the whole repo when no subpath is set (shared-source apps).
const selectorMapCache = new Map<string, SelectorMap>();

export function getSelectorMap(repoPath: string, opts: { appId?: string; subpath?: string } = {}): SelectorMap | null {
  const base = (repoPath || '').trim();
  if (!base) return null;
  const scopedPath = opts.subpath ? path.join(base, opts.subpath) : base;
  const key = `${scopedPath}::${opts.appId || ''}`;
  if (selectorMapCache.has(key)) return selectorMapCache.get(key)!;
  try {
    const target = existsSync(scopedPath) ? scopedPath : base;
    const m = extractSelectorMap(target);
    selectorMapCache.set(key, m);
    return m;
  } catch { return null; }
}

/** Selector map scoped to the run's selected app (its repo subpath + appId) — never the sibling app's. */
export function getRunSelectorMap(run: any): SelectorMap | null {
  const repoPath = getProjectRepoPath(run?.projectId || '').trim();
  const app = run?.appId ? getApp(run.appId) : undefined;
  return getSelectorMap(repoPath, { appId: run?.appId || '', subpath: (app as any)?.repoSubpath || '' });
}
