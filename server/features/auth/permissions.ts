/**
 * Permission catalog + route→permission mapping + resolution. Describes THIS tool's own surface
 * (its pages and REST verbs) — never anything about an app under test. A permission is `resource:action`.
 *
 * Access tiers fall out of the grant model:
 *   - granting a FEATURE (page) = page access + read of that resource   → read-only
 *   - adding ACTIONS (create/update/delete/execute/…)                   → partial / full
 *   - CAPABILITIES gate project / URL creation                          → admin governance
 *   - explicit DENY always wins.
 */

import type { EffectiveGrants, Grants, GrantList } from './groupStore';

export type PermCategory = 'feature' | 'action' | 'capability';
export interface PermDef { id: string; resource: string; action: string; category: PermCategory; label: string; }

/** Resources with the verbs the UI/routes expose. `read` is implied by page (feature) access. */
const RESOURCE_VERBS: Record<string, string[]> = {
  cases: ['read', 'create', 'update', 'delete'],
  suites: ['read', 'create', 'update', 'delete'],
  plans: ['read', 'create', 'update', 'delete'],
  runs: ['read', 'create', 'update', 'delete', 'execute', 'export'],
  defects: ['read', 'create', 'update', 'delete'],
  requirements: ['read', 'create', 'update', 'delete'],
  reports: ['read', 'create', 'update', 'delete'],
  folders: ['read', 'create', 'update', 'delete'],
  scripts: ['read', 'create', 'update', 'delete'],
  knowledge: ['read', 'create', 'update', 'delete'],
  'record-play': ['read', 'start', 'stop', 'execute'],
  automation: ['read', 'create', 'update', 'delete', 'execute'],
  agent: ['read', 'start', 'execute', 'delete'],
  'git-agent': ['read', 'execute', 'apply'],
  projects: ['read', 'update', 'delete'],
  websites: ['read', 'update', 'delete'],
};

/** Governance switches — admin decides who may create new projects / apps / URLs. */
const CAPABILITIES: Array<{ id: string; label: string }> = [
  { id: 'project:create', label: 'Create projects' },
  { id: 'app:create', label: 'Create applications' },
  { id: 'website:create', label: 'Create deployment URLs' },
];

/** Page (feature) keys — mirror of src/lib/features.ts FEATURES, the admin page-access checkboxes. */
export const FEATURE_KEYS = [
  'agent-console', 'dashboard', 'repository', 'plans', 'suites', 'cases', 'runs',
  'requirements', 'traceability', 'reports', 'defects', 'automation', 'record-play',
  'git-agent', 'documentation',
] as const;

/** A feature (page) → the resource(s) whose `read` it implies. Only listed when names differ. */
const FEATURE_RESOURCES: Record<string, string[]> = {
  repository: ['folders', 'scripts'],
  'agent-console': ['agent'],
};
function featureForResource(resource: string): string {
  for (const [feat, reslist] of Object.entries(FEATURE_RESOURCES)) if (reslist.includes(resource)) return feat;
  return resource;
}

const humanize = (s: string) => s.replace(/[-:]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

/** The full, flat catalog of gate-able permissions (for seeding + the admin UI). */
export const PERMISSION_CATALOG: PermDef[] = (() => {
  const out: PermDef[] = [];
  for (const key of FEATURE_KEYS) out.push({ id: `feature:${key}`, resource: key, action: 'view', category: 'feature', label: `${humanize(key)} (page)` });
  for (const [resource, verbs] of Object.entries(RESOURCE_VERBS)) {
    for (const action of verbs) out.push({ id: `${resource}:${action}`, resource, action, category: 'action', label: `${humanize(resource)}: ${action}` });
  }
  for (const cap of CAPABILITIES) { const [resource, action] = cap.id.split(':'); out.push({ id: cap.id, resource, action, category: 'capability', label: cap.label }); }
  return out;
})();

/* ---------- route → required permission ---------- */

interface RouteRule { method: string | '*'; re: RegExp; perm: string; }
const R = (method: string, re: RegExp, perm: string): RouteRule => ({ method, re, perm });

// First match wins — specific rules before the generic resource CRUD block.
const ROUTE_RULES: RouteRule[] = [
  // Record & Play (Playwright codegen + run)
  R('POST', /^\/api\/playwright\/codegen\/start$/, 'record-play:start'),
  R('POST', /^\/api\/playwright\/codegen\/[^/]+\/stop$/, 'record-play:stop'),
  R('GET', /^\/api\/playwright\/codegen\//, 'record-play:read'),
  R('*', /^\/api\/playwright\/run/, 'record-play:execute'),

  // Runs — specific sub-actions before generic runs CRUD
  R('POST', /^\/api\/runs\/[^/]+\/execute$/, 'runs:execute'),
  R('POST', /^\/api\/runs\/[^/]+\/start$/, 'runs:execute'),
  R('POST', /^\/api\/runs\/[^/]+\/stop$/, 'runs:execute'),
  R('POST', /^\/api\/runs\/[^/]+\/close$/, 'runs:update'),
  R('GET', /^\/api\/runs\/[^/]+\/evidence\/export$/, 'runs:export'),
  R('POST', /^\/api\/runs\/from-selection$/, 'runs:create'),
  // Manual step runner: recording per-case/per-step outcomes is executing the run; bug is a defect create.
  R('GET', /^\/api\/runs\/[^/]+\/results/, 'runs:read'),
  R('POST', /^\/api\/runs\/[^/]+\/results\/[^/]+\/bug$/, 'defects:create'),
  R('POST', /^\/api\/runs\/[^/]+\/results/, 'runs:execute'),
  R('DELETE', /^\/api\/runs\/[^/]+\/results/, 'runs:execute'),

  // Cases — AI/rework/rollback map to update; save-cases to create
  R('POST', /^\/api\/cases\/ai-action$/, 'cases:update'),
  R('POST', /^\/api\/cases\/[^/]+\/rollback/, 'cases:update'),

  // Scripts — rollback maps to update (GET revisions/diff falls through to generic scripts:read)
  R('POST', /^\/api\/scripts\/[^/]+\/rollback/, 'scripts:update'),

  // Agent runs
  R('POST', /^\/api\/agent\/start$/, 'agent:start'),
  R('POST', /^\/api\/agent\/save-cases$/, 'cases:create'),
  R('POST', /^\/api\/agent\/(continue|cancel|retry|rework-case|rework-cases-chat|expand-case-steps|coverage-decision|action)/, 'agent:execute'),
  R('DELETE', /^\/api\/agent-runs\//, 'agent:delete'),
  R('GET', /^\/api\/agent-runs/, 'agent:read'),

  // Git agent
  R('POST', /^\/api\/git-agent\/apply$/, 'git-agent:apply'),
  R('POST', /^\/api\/git-agent\/(analyze|scan|generate|sync)$/, 'git-agent:execute'),
  R('GET', /^\/api\/git-agent\//, 'git-agent:read'),

  // Projects + apps (create is a capability)
  R('POST', /^\/api\/projects$/, 'project:create'),
  R('POST', /^\/api\/projects\/[^/]+\/apps$/, 'app:create'),
  R('PUT', /^\/api\/projects\/[^/]+$/, 'projects:update'),
  R('DELETE', /^\/api\/projects\/[^/]+$/, 'projects:delete'),
  R('*', /^\/api\/apps\/[^/]+$/, 'projects:update'),
  R('GET', /^\/api\/projects/, 'projects:read'),

  // Credential deployment URLs (create is a capability)
  R('POST', /^\/api\/credentials\/websites$/, 'website:create'),
  R('PUT', /^\/api\/credentials\/websites\//, 'websites:update'),
  R('DELETE', /^\/api\/credentials\/websites\//, 'websites:delete'),
  R('GET', /^\/api\/credentials\//, 'websites:read'),

  // Automation family (coarse)
  R('GET', /^\/api\/automation\//, 'automation:read'),
  R('POST', /^\/api\/automation\/(runs|jobs\/[^/]+\/(cancel|retry))/, 'automation:execute'),
  R('DELETE', /^\/api\/automation\//, 'automation:delete'),
  R('*', /^\/api\/automation\//, 'automation:update'),

  // Generic resource CRUD (cases/suites/plans/runs/defects/scripts/reports/folders/requirements/knowledge)
  R('POST', /^\/api\/([a-z-]+)\/bulk-delete$/, ':bulkDelete'),
  R('GET', /^\/api\/([a-z-]+)(\/|$)/, ':read'),
  R('POST', /^\/api\/([a-z-]+)$/, ':create'),
  R('PUT', /^\/api\/([a-z-]+)\/[^/]+$/, ':update'),
  R('DELETE', /^\/api\/([a-z-]+)\/[^/]+$/, ':delete'),
];

const CRUD_RESOURCES = new Set(['cases', 'suites', 'plans', 'runs', 'defects', 'scripts', 'reports', 'folders', 'requirements', 'knowledge']);

/** The permission a request requires, or null when the path is not gated (fail-open + logged). */
export function requiredPermissionFor(method: string, path: string): string | null {
  for (const rule of ROUTE_RULES) {
    if (rule.method !== '*' && rule.method !== method) continue;
    const m = rule.re.exec(path);
    if (!m) continue;
    if (rule.perm.startsWith(':')) {
      const resource = m[1];
      if (!CRUD_RESOURCES.has(resource)) return null; // e.g. /api/auth, /api/settings — handled elsewhere
      const verb = rule.perm === ':bulkDelete' ? 'delete' : rule.perm.slice(1);
      return `${resource}:${verb}`;
    }
    return rule.perm;
  }
  return null;
}

/* ---------- grants → decision ---------- */

export interface PermSet { unrestricted: boolean; allow: Set<string>; deny: Set<string>; allActions: boolean; allFeatures: boolean; allCaps: boolean; features: Set<string> | '*'; }

const asList = (l: GrantList | undefined): string[] | '*' => (l === '*' ? '*' : Array.isArray(l) ? l : []);

/** Flatten effective grants into a fast decision structure. */
export function toPermSet(grants: EffectiveGrants): PermSet {
  if (grants === 'UNRESTRICTED') {
    return { unrestricted: true, allow: new Set(), deny: new Set(), allActions: true, allFeatures: true, allCaps: true, features: '*' };
  }
  const g = grants as Grants;
  const actions = asList(g.actions);
  const caps = asList(g.capabilities);
  const feats = asList(g.features);
  const allow = new Set<string>();
  if (actions !== '*') for (const a of actions) allow.add(a);
  if (caps !== '*') for (const c of caps) allow.add(c);
  const deny = new Set<string>(Array.isArray(g.denies) ? g.denies : []);
  return {
    unrestricted: false, allow, deny,
    allActions: actions === '*', allCaps: caps === '*', allFeatures: feats === '*',
    features: feats === '*' ? '*' : new Set(feats),
  };
}

function hasFeature(ps: PermSet, featureKey: string): boolean {
  return ps.allFeatures || ps.features === '*' || (ps.features as Set<string>).has(featureKey);
}

/** True when the permission set permits `permId` (a `resource:action` string). Deny always wins. */
export function permits(ps: PermSet, permId: string): boolean {
  if (ps.deny.has(permId)) return false;
  if (ps.unrestricted) return true;
  const [resource, action] = permId.split(':');
  const isCapability = CAPABILITIES.some((c) => c.id === permId);
  if (isCapability) return ps.allCaps || ps.allow.has(permId);
  // Page access (feature) implies read of its resource(s).
  if (action === 'read' || action === 'view') {
    if (ps.allActions || ps.allow.has(permId)) return true;
    return hasFeature(ps, featureForResource(resource));
  }
  return ps.allActions || ps.allow.has(permId);
}

/* ---------- role presets (access tiers) ---------- */

/** The permission-id list a preset tier grants over a set of resources (default: all). */
export function presetPermissions(tier: 'read-only' | 'editor' | 'full', resources?: string[]): string[] {
  const res = resources && resources.length ? resources : Object.keys(RESOURCE_VERBS);
  const out: string[] = [];
  for (const r of res) {
    const verbs = RESOURCE_VERBS[r] || [];
    for (const v of verbs) {
      if (tier === 'read-only' && v !== 'read') continue;
      if (tier === 'editor' && (v === 'delete')) continue; // editor writes but doesn't delete
      out.push(`${r}:${v}`);
    }
  }
  return out;
}

/** Catalog projection for the client (permissions + capability + feature listing). */
export function catalogForClient() {
  return {
    permissions: PERMISSION_CATALOG,
    features: FEATURE_KEYS,
    capabilities: CAPABILITIES,
    resources: Object.entries(RESOURCE_VERBS).map(([resource, verbs]) => ({ resource, verbs, feature: featureForResource(resource) })),
  };
}
