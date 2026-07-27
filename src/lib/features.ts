/**
 * Canonical catalog of gate-able tool features (top-level pages/capabilities).
 *
 * A single source of truth used in two places:
 *   - the admin "Access Groups" screen renders one checkbox per feature (FEATURE_OPTIONS), and
 *   - the nav + route guard hide/redirect features a user's groups don't grant (grantAllows).
 *
 * Keys are stable identifiers stored in a group's grants; `hrefs` maps a key to the route prefixes
 * it covers so the sidebar and router can resolve a path back to its feature key. Keep in sync with
 * the nav groups and <Routes> in src/App.tsx. `settings` is intentionally omitted — it stays gated by
 * the admin role, not by feature grants.
 */

export interface FeatureDef {
  key: string;
  label: string;
  /** Route prefixes this feature owns. The first entry is its canonical landing path. */
  hrefs: string[];
}

export const FEATURES: FeatureDef[] = [
  { key: 'agent-console', label: 'Agent Console', hrefs: ['/', '/agent', '/chat', '/studio'] },
  { key: 'dashboard', label: 'Dashboard', hrefs: ['/dashboard'] },
  { key: 'repository', label: 'File System', hrefs: ['/repository'] },
  { key: 'plans', label: 'Test Plans', hrefs: ['/plans'] },
  { key: 'suites', label: 'Test Suites', hrefs: ['/suites'] },
  { key: 'cases', label: 'Test Cases', hrefs: ['/cases'] },
  { key: 'runs', label: 'Test Runs', hrefs: ['/runs'] },
  { key: 'requirements', label: 'Requirements', hrefs: ['/requirements'] },
  { key: 'traceability', label: 'Traceability', hrefs: ['/traceability'] },
  { key: 'reports', label: 'Reports', hrefs: ['/reports'] },
  { key: 'defects', label: 'Defects', hrefs: ['/defects'] },
  { key: 'automation', label: 'Automation', hrefs: ['/automation'] },
  { key: 'record-play', label: 'Record & Play', hrefs: ['/record-play'] },
  { key: 'git-agent', label: 'Git Agent', hrefs: ['/git-agent'] },
  { key: 'documentation', label: 'Documentation', hrefs: ['/documentation'] },
];

/** {id,name} options for the admin checkbox UI (matches MultiSelectDropdown's option shape). */
export const FEATURE_OPTIONS = FEATURES.map((f) => ({ id: f.key, name: f.label }));

/** Resolve a pathname to its feature key (longest hrefs first so '/automation/x' beats '/'). */
export function featureKeyForPath(pathname: string): string | null {
  const p = pathname || '/';
  let best: { key: string; len: number } | null = null;
  for (const f of FEATURES) {
    for (const href of f.hrefs) {
      const hit = href === '/' ? (p === '/' || p.startsWith('/chat/') || p.startsWith('/agent')) : (p === href || p.startsWith(`${href}/`));
      if (hit && (!best || href.length > best.len)) best = { key: f.key, len: href.length };
    }
  }
  return best?.key ?? null;
}

// Client-side mirror of the server grant model (from GET /api/auth/me).
export type ClientGrantList = string[] | '*';
export type ClientGrants =
  | 'UNRESTRICTED'
  | { features: ClientGrantList; projects: ClientGrantList; websites: ClientGrantList; providers: ClientGrantList };

/** True when grants permit `id` in `category`. UNRESTRICTED / '*' / a missing/invalid grants object all pass (back-compat). */
export function grantAllows(grants: ClientGrants | null | undefined, category: 'features' | 'projects' | 'websites' | 'providers', id: string): boolean {
  if (!grants || grants === 'UNRESTRICTED') return true;
  const list = (grants as any)[category];
  if (list === '*' || list === undefined) return true;
  return Array.isArray(list) && list.includes(id);
}
