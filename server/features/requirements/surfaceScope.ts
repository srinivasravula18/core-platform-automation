/**
 * Surface scope resolver — the single place that answers, for a selected surface:
 *   (a) WHICH code should we ground requirements in?  (repo + sub-roots)
 *   (b) WHICH live app do we connect to for the metadata catalog?  (baseUrl + strategy)
 *
 * "Surface" is whatever the user picked — an App configured under a project, OR a
 * Website (a bare live URL). The scope reference on a request (`scope.appId`) may point
 * at either store, so we look the id up in BOTH and unify the result.
 *
 * Nothing here is hardcoded per-application. When a surface is explicitly configured
 * (repo sub-path / own repo), we use that. Otherwise we DISCOVER the matching code root
 * from the surface's OWN live URL — its path segments are fingerprints that appear in the
 * repo (build config `base`, package names, route prefixes), so grepping the repo for them
 * points back at the owning app folder. Works for any tenant repo, mono- or poly-repo.
 *
 * Why this exists: previously a Website selection resolved to neither a code sub-scope nor a
 * metadata connection (only `getApp()` was consulted), so grounding read the whole monorepo
 * and drifted to whichever surface's list-view code was most prominent (the shared/record one),
 * producing Keystone-flavored requirements for an Admin URL.
 */

import { getApp, getProjectRepoPath, resolveRepoPath, type AppRecord } from '../projects/projectService';
import { getWebsite } from '../credentials/credentialsService';
import { gitGrep, listRepoSourceFiles } from '../git-agent/gitAgentService';

export interface ResolvedSurfaceScope {
  /** The id we resolved (scope.appId), or '' when none was selected. */
  ref: string;
  /** What the id turned out to be. */
  kind: 'app' | 'website' | 'none';
  /** Human-facing surface name (app/website name), best-effort. */
  name: string;
  /** Live app base URL for credentials + metadata catalog (may be ''). */
  baseUrl: string;
  specPath?: string;
  catalogStrategy?: string;
  /** Repo to ground in — the app's own repo when configured, else the project repo. */
  repoPath: string;
  /** Sub-roots within repoPath to bias source discovery to. [] = whole repo. */
  scopePaths: string[];
  /** How confident we are in scopePaths. */
  confidence: 'high' | 'medium' | 'low' | 'none';
  /** How scopePaths was decided. */
  source: 'configured' | 'fingerprint' | 'unscoped';
  /** A short, prompt-ready explanation of what was resolved and how. */
  evidence: string;
}

/** URL path/host tokens that are too generic to identify a surface — never fingerprint on these. */
const GENERIC_URL_TOKENS = new Set([
  'ui', 'app', 'apps', 'web', 'www', 'api', 'portal', 'home', 'index', 'public', 'static',
  'dist', 'build', 'assets', 'client', 'server', 'main', 'root', 'v1', 'v2',
]);

function normPath(p: string): string {
  return String(p || '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
}

/** True when a repo-relative file path sits under any of the given sub-roots ([] = match all). */
export function isUnderScope(filePath: string, scopePaths: string[]): boolean {
  if (!scopePaths || scopePaths.length === 0) return true;
  const p = normPath(filePath).toLowerCase();
  return scopePaths.some((s) => {
    const root = normPath(s).toLowerCase();
    return root === '' || p === root || p.startsWith(`${root}/`);
  });
}

/** Meaningful, de-generic-ed tokens drawn from a URL's path segments (host ignored — shared across surfaces). */
function urlSurfaceTokens(baseUrl: string): { raw: string[]; tokens: string[] } {
  let pathname = '';
  try {
    pathname = new URL(baseUrl).pathname || '';
  } catch {
    // Not an absolute URL; treat whatever we got as a path.
    pathname = String(baseUrl || '');
  }
  const raw = pathname.split('/').map((s) => s.trim().toLowerCase()).filter((s) => s.length >= 2);
  const tokens = new Set<string>();
  for (const seg of raw) {
    for (const part of seg.split(/[-_]+/).filter(Boolean)) {
      if (part.length >= 3 && !GENERIC_URL_TOKENS.has(part)) tokens.add(part);
    }
    if (seg.length >= 3 && !GENERIC_URL_TOKENS.has(seg)) tokens.add(seg);
  }
  return { raw: Array.from(new Set(raw)), tokens: Array.from(tokens) };
}

/** The "surface key" a file belongs to: apps/<x> or packages/<x> etc., else its top folder. */
function surfaceKeyFor(filePath: string): string {
  const parts = normPath(filePath).split('/').filter(Boolean);
  if (parts.length >= 2 && /^(apps|packages|services|modules|projects)$/i.test(parts[0])) {
    return `${parts[0]}/${parts[1]}`;
  }
  return parts[0] || '';
}

/**
 * Discover which repo sub-folder(s) implement the given live URL, purely from the URL's own
 * fingerprints correlated against the repo. Returns the best-matching sub-root(s) + confidence.
 * Best-effort: any failure yields an empty (whole-repo) result rather than throwing.
 */
export function fingerprintScopePaths(
  repoPath: string,
  baseUrl: string,
): { scopePaths: string[]; confidence: ResolvedSurfaceScope['confidence']; note: string } {
  const { raw, tokens } = urlSurfaceTokens(baseUrl);
  if (!repoPath || (raw.length === 0 && tokens.length === 0)) {
    return { scopePaths: [], confidence: 'none', note: 'URL had no distinctive path segment to fingerprint.' };
  }

  // Enumerate real candidate surface folders in the repo.
  const candidates = new Set<string>();
  try {
    for (const f of listRepoSourceFiles(repoPath, 10000)) {
      const key = surfaceKeyFor(f.path);
      if (key && key.includes('/')) candidates.add(key); // prefer apps/<x>, packages/<x>
    }
  } catch {
    return { scopePaths: [], confidence: 'none', note: 'Could not list repo files to fingerprint the surface.' };
  }
  if (candidates.size === 0) return { scopePaths: [], confidence: 'none', note: 'No apps/* or packages/* folders to match against.' };

  const score = new Map<string, number>();
  const bump = (key: string, by: number) => score.set(key, (score.get(key) || 0) + by);

  // Signal 1 — folder-name token match (leaf name vs URL tokens).
  for (const key of candidates) {
    const leaf = key.split('/').pop() || '';
    for (const t of tokens) {
      if (leaf === t) bump(key, 6);
      else if (leaf.length >= 3 && t.length >= 3 && (leaf.includes(t) || t.includes(leaf))) bump(key, 4);
    }
  }

  // Signal 2 — grep the repo for the raw URL segment(s); the base path literally appears in the
  // owning app's build config / package.json / route prefix. Strongest, most tenant-agnostic signal.
  try {
    const patterns = raw.filter((s) => s.length >= 3 && !GENERIC_URL_TOKENS.has(s));
    if (patterns.length) {
      const hits = gitGrep(patterns, undefined, 200, repoPath);
      const perKey = new Map<string, number>();
      for (const h of hits) {
        const key = surfaceKeyFor(h.path);
        if (candidates.has(key)) perKey.set(key, (perKey.get(key) || 0) + 1);
      }
      for (const [key, n] of perKey) bump(key, Math.min(n * 2, 12));
    }
  } catch {
    // grep is a bonus signal; folder-name match alone can still resolve.
  }

  const ranked = Array.from(score.entries()).sort((a, b) => b[1] - a[1]);
  if (ranked.length === 0 || ranked[0][1] < 6) {
    return { scopePaths: [], confidence: 'low', note: `No repo folder matched the URL fingerprints (${[...tokens].join(', ') || 'none'}).` };
  }
  const [bestKey, bestScore] = ranked[0];
  const confidence: ResolvedSurfaceScope['confidence'] = bestScore >= 10 ? 'high' : 'medium';
  return {
    scopePaths: [bestKey],
    confidence,
    note: `Matched live URL to repo folder "${bestKey}" (score ${bestScore}) from its own path fingerprints.`,
  };
}

/** Configured sub-roots on an app record: explicit searchRoots win, else the single repoSubpath. */
function configuredScopePaths(app: AppRecord): string[] {
  const roots = app.searchRoots && typeof app.searchRoots === 'object' ? Object.values(app.searchRoots) : [];
  const cleaned = roots.map((r) => normPath(String(r || ''))).filter(Boolean);
  if (cleaned.length) return Array.from(new Set(cleaned));
  const sub = normPath(String(app.repoSubpath || ''));
  return sub ? [sub] : [];
}

/**
 * Resolve the selected surface into a grounding scope + metadata connection.
 *
 * Cascade (highest-confidence wins), all dynamic, no hardcoded surface map:
 *   1. App with its OWN repo configured (poly-repo)         → that repo (+ configured sub-roots).
 *   2. App/Website with a repo sub-path / searchRoots        → project repo @ those sub-roots.
 *   3. Only a live URL                                       → fingerprint the URL against the project repo.
 *   4. Nothing resolves                                      → whole repo, flagged low/none confidence.
 */
export function resolveSurfaceScope(input: {
  projectId?: string;
  ref?: string;
  ownerId?: string;
}): ResolvedSurfaceScope {
  const ref = String(input.ref || '').trim();
  const projectRepo = input.projectId ? getProjectRepoPath(input.projectId) : '';

  const app = ref ? getApp(ref) : undefined;
  const website = !app && ref ? getWebsite(ref) : null;

  const kind: ResolvedSurfaceScope['kind'] = app ? 'app' : website ? 'website' : 'none';
  const name = app?.name || website?.name || '';
  const baseUrl = app?.baseUrl || website?.baseUrl || '';
  const specPath = app?.specPath;
  const catalogStrategy = app?.catalogStrategy;

  // 1) App with its own repo (poly-repo / aggregated GitHub repos).
  if (app && String(app.repoPath || '').trim()) {
    const ownRepo = resolveRepoPath(String(app.repoPath), app.slug);
    const scopePaths = configuredScopePaths(app); // sub-roots are relative to the app's own repo
    return {
      ref, kind, name, baseUrl, specPath, catalogStrategy,
      repoPath: ownRepo,
      scopePaths,
      confidence: 'high',
      source: 'configured',
      evidence: `Surface "${name || ref}" is configured with its own repository${scopePaths.length ? ` (sub-roots: ${scopePaths.join(', ')})` : ''}; grounded there.`,
    };
  }

  // 2) Configured sub-path within the project's (mono)repo.
  if (app) {
    const scopePaths = configuredScopePaths(app);
    if (scopePaths.length) {
      return {
        ref, kind, name, baseUrl, specPath, catalogStrategy,
        repoPath: projectRepo,
        scopePaths,
        confidence: 'high',
        source: 'configured',
        evidence: `Surface "${name || ref}" is configured to repo sub-root(s): ${scopePaths.join(', ')}; grounded there.`,
      };
    }
  }

  // 3) Only a live URL — fingerprint it against the project repo.
  if (baseUrl && projectRepo) {
    const fp = fingerprintScopePaths(projectRepo, baseUrl);
    if (fp.scopePaths.length) {
      return {
        ref, kind, name, baseUrl, specPath, catalogStrategy,
        repoPath: projectRepo,
        scopePaths: fp.scopePaths,
        confidence: fp.confidence,
        source: 'fingerprint',
        evidence: `Resolved surface from the chosen URL (${baseUrl}). ${fp.note}`,
      };
    }
    // 4a) URL present but no confident match — do NOT silently pretend; flag it.
    return {
      ref, kind, name, baseUrl, specPath, catalogStrategy,
      repoPath: projectRepo,
      scopePaths: [],
      confidence: fp.confidence === 'none' ? 'none' : 'low',
      source: 'unscoped',
      evidence: `Could not localize the surface from the chosen URL (${baseUrl}). ${fp.note} Grounding across the whole repository — treat surface identity as UNVERIFIED.`,
    };
  }

  // 4b) Nothing to scope on.
  return {
    ref, kind, name, baseUrl, specPath, catalogStrategy,
    repoPath: projectRepo,
    scopePaths: [],
    confidence: 'none',
    source: 'unscoped',
    evidence: ref
      ? `No repo scope could be resolved for surface "${name || ref}"; grounding across the whole repository.`
      : 'No surface (app/URL) was selected; grounding across the whole repository.',
  };
}
