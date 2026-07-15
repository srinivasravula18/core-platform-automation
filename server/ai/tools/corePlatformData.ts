/**
 * Platform DATA tools — direct, in-process (no MCP). These give the agent the SAME
 * capabilities as @core-platform/mcp-server, but as native function-calling tools: each is a
 * thin proxy to the App Service HTTP API, which remains the single enforcement
 * point for permissions, record/field access, validations, and audit. We hold no authority of
 * our own — we can only do what the configured token's user can do.
 *
 * Why direct instead of MCP: MCP is just a transport. The capability is an HTTP call. Doing it
 * in-process means no extra server/child-process to run in production — the backend simply
 * fetch()es the App Service, exactly like it already does for everything else.
 *
 * Config (same convention as the MCP server):
 *   TARGET_BASE_URL                     App Service base URL (required)
 *   TARGET_TOKEN                        bearer token to act as, OR
 *   TARGET_USERNAME + _PASSWORD         credentials to log in for a token
 */
import { createHash } from 'crypto';
import type { AgentTool, ToolContext } from './types';
import type { ObjectSchema } from '../../features/agent/testdata/types';

function baseUrl(): string {
  return String(process.env.TARGET_BASE_URL || '').replace(/\/+$/, '');
}

function trimBaseUrl(value: string): string {
  return String(value || '').replace(/\/+$/, '');
}

/**
 * AUTO-DISCOVER the App Service (API) origin for a target — no env vars, no per-target
 * hardcoding, scales to any number of connected apps/repos. The configured base URL is
 * often a browser SURFACE (e.g. https://host/shockwave/ or http://localhost:5002/) while
 * the platform API lives at the origin or another configured base. We probe the small
 * set of candidates ONCE per target (a well-known platform endpoint answering anything
 * but 404 proves the API is there — 401 is a perfect signal) and cache the winner.
 */
const serviceBaseCache = new Map<string, { url: string; at: number }>();
const SERVICE_BASE_TTL_MS = 10 * 60 * 1000;

async function probeServiceBase(candidate: string): Promise<boolean> {
  // The App Service answers /api/apps with JSON (401 for anonymous callers). A browser SPA
  // server answers ANY path with 200 + index.html (history fallback), so a response only
  // counts as "the API is here" when the BODY is actually JSON — never HTML.
  const isJsonResponse = async (res: any): Promise<boolean> => {
    if (String(res.headers.get('content-type') || '').includes('json')) return true;
    try { JSON.parse(await res.text()); return true; } catch { return false; }
  };
  try {
    const res = await fetch(`${candidate}/api/apps`, { signal: AbortSignal.timeout(5000), headers: { accept: 'application/json' } });
    if (res.status !== 404 && await isJsonResponse(res)) return true;
  } catch { /* try the spec next */ }
  try {
    const res = await fetch(`${candidate}/api/openapi.json`, { signal: AbortSignal.timeout(5000), headers: { accept: 'application/json' } });
    return res.ok && await isJsonResponse(res);
  } catch { return false; }
}

async function resolveServiceBase(conn?: CatalogConn): Promise<string> {
  const raw = trimBaseUrl(conn?.baseUrl || baseUrl() || '');
  if (!raw) return '';
  const cached = serviceBaseCache.get(raw);
  if (cached && Date.now() - cached.at <= SERVICE_BASE_TTL_MS) return cached.url;
  const candidates: string[] = [];
  const push = (u: string) => { const t = trimBaseUrl(u); if (t && !candidates.includes(t)) candidates.push(t); };
  push(serviceBaseUrl(conn)); // configured resolution first (specPath/env aware)
  push(raw);
  try { push(new URL(raw).origin); } catch { /* not a URL */ }
  const envBase = trimBaseUrl(baseUrl());
  if (envBase) push(envBase);
  for (const candidate of candidates) {
    if (await probeServiceBase(candidate)) {
      serviceBaseCache.set(raw, { url: candidate, at: Date.now() });
      return candidate;
    }
  }
  // Nothing answered — keep the configured resolution (old behavior) but don't cache the miss,
  // so a target that comes online is picked up on the next call.
  return candidates[0] || raw;
}

function serviceBaseUrl(conn?: CatalogConn): string {
  const raw = trimBaseUrl(conn?.baseUrl || baseUrl() || '');
  if (!raw) return '';
  const specPath = String(conn?.specPath || process.env.TARGET_SPEC_PATH || '');
  // App base URLs often point at a browser surface such as /admin-ui/ while the
  // platform API and OpenAPI spec are mounted at the origin (/api/...). A
  // root-relative spec path is an explicit signal to resolve API calls there.
  if (specPath.startsWith('/')) {
    try {
      const rawUrl = new URL(raw);
      const fallback = trimBaseUrl(baseUrl());
      if (fallback) {
        try {
          const fallbackUrl = new URL(fallback);
          const rawLocal = ['localhost', '127.0.0.1', '::1'].includes(rawUrl.hostname.toLowerCase());
          const fallbackLocal = ['localhost', '127.0.0.1', '::1'].includes(fallbackUrl.hostname.toLowerCase());
          if (rawLocal && fallbackLocal) return fallback;
        } catch { /* keep origin fallback */ }
      }
      return rawUrl.origin;
    } catch { /* keep raw */ }
  }
  return raw;
}

// Cache a logged-in token so we don't re-auth on every call. Cleared on a 401 so the next call
// re-logs-in. A static TARGET_TOKEN (if set) is always preferred and never cached/cleared.
let cachedToken: string | null = null;

async function loginForToken(url: string, username: string, password: string): Promise<string> {
  const res = await fetch(`${url}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const json = (await res.json().catch(() => null)) as { access_token?: string } | null;
  if (!res.ok || !json?.access_token) throw new Error(`Login failed (${res.status}).`);
  return json.access_token;
}

async function resolveToken(url: string, forceRefresh = false): Promise<string> {
  const staticToken = String(process.env.TARGET_TOKEN || '').trim();
  if (staticToken) return staticToken;
  if (cachedToken && !forceRefresh) return cachedToken;
  const username = String(process.env.TARGET_USERNAME || '').trim();
  const password = String(process.env.TARGET_PASSWORD || '').trim();
  if (!username || !password) {
    throw new Error('Data tools are not configured. Set TARGET_BASE_URL and TARGET_TOKEN (or TARGET_USERNAME + TARGET_PASSWORD).');
  }
  cachedToken = await loginForToken(url, username, password);
  return cachedToken;
}

/** One App Service request with the user's bearer token. Retries once on 401 (token expired). */
async function cpRequest(method: string, path: string, body?: unknown): Promise<unknown> {
  const url = baseUrl();
  if (!url) throw new Error('Data tools are not configured: TARGET_BASE_URL is not set.');
  const call = async (token: string) => {
    const res = await fetch(`${url}${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data: unknown = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    return { res, data };
  };
  let token = await resolveToken(url);
  let { res, data } = await call(token);
  if (res.status === 401 && !process.env.TARGET_TOKEN) {
    cachedToken = null;
    token = await resolveToken(url, true);
    ({ res, data } = await call(token));
  }
  if (!res.ok) {
    const detail = (data && typeof data === 'object' && ('detail' in data || 'message' in data))
      ? String((data as any).detail ?? (data as any).message)
      : `HTTP ${res.status}`;
    throw new Error(`App Service ${method} ${path} failed (${res.status}): ${detail}`);
  }
  return data;
}

const enc = encodeURIComponent;
const items = (data: unknown) =>
  data && typeof data === 'object' && Array.isArray((data as any).items) ? (data as any).items : data;
const asFilters = (value: unknown) =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : { logic: 'AND', filters: [] };

const str = { type: 'string' };
const num = { type: 'integer' };

export const listAppsTool: AgentTool = {
  spec: { name: 'list_apps', description: 'List the applications the configured user can access. Use to discover real app ids before describing schema or querying records.', parameters: { type: 'object', properties: {} } },
  async execute() { return { apps: items(await cpRequest('GET', '/api/apps')) }; },
};

export const describeAppSchemaTool: AgentTool = {
  spec: {
    name: 'describe_app_schema',
    description: 'List the objects in an app (access-scoped). Pass object_api_names to also fetch those objects\' FIELDS (api_names, types, validations) so you can write tests/queries against the REAL data model.',
    parameters: { type: 'object', properties: { app_id: { ...str, description: 'The application id (from list_apps).' }, object_api_names: { type: 'array', items: str, description: 'Objects to include field details for.' } }, required: ['app_id'] },
  },
  async execute(args) {
    const appId = String(args.app_id || '');
    const objects = items(await cpRequest('GET', `/api/apps/${enc(appId)}/objects`));
    const result: Record<string, unknown> = { objects };
    const names = Array.isArray(args.object_api_names) ? (args.object_api_names as string[]) : [];
    if (names.length) {
      const described: Record<string, unknown> = {};
      for (const name of names) {
        try { described[name] = await cpRequest('GET', `/api/apps/${enc(appId)}/objects/${enc(String(name))}/describe`); }
        catch (e: any) { described[name] = { error: e?.message || String(e) }; }
      }
      result.described = described;
    }
    return result;
  },
};

export const queryRecordsTool: AgentTool = {
  spec: {
    name: 'query_records',
    description: 'Query REAL records of an object with optional filters and paging (row/field access enforced server-side). Filter shape: { logic: "AND"|"OR", filters: [{ field, op, value }] }. Use to ground tests in actual data.',
    parameters: { type: 'object', properties: { app_id: str, object_api_name: str, filters: { type: 'object', description: 'Filter tree; omit for all accessible records.' }, page: num, page_size: num }, required: ['app_id', 'object_api_name'] },
  },
  async execute(args) {
    return cpRequest('POST', `/api/apps/${enc(String(args.app_id))}/objects/${enc(String(args.object_api_name))}/list-views/query`, {
      filters: asFilters(args.filters),
      pagination: { page: Number(args.page ?? 1), page_size: Math.min(1000, Number(args.page_size ?? 50)) },
    });
  },
};

export const countRecordsTool: AgentTool = {
  spec: {
    name: 'count_records',
    description: 'Return the exact, access-correct COUNT of records matching optional filters. Use for "how many" questions.',
    parameters: { type: 'object', properties: { app_id: str, object_api_name: str, filters: { type: 'object' } }, required: ['app_id', 'object_api_name'] },
  },
  async execute(args) {
    const data = (await cpRequest('POST', `/api/apps/${enc(String(args.app_id))}/objects/${enc(String(args.object_api_name))}/list-views/query`, {
      pagination: { page_size: 1 }, summary: { operations: ['count'] }, filters: asFilters(args.filters),
    })) as any;
    return { count: data?.summary?.count ?? data?.total_count ?? null };
  },
};

export const aggregateRecordsTool: AgentTool = {
  spec: {
    name: 'aggregate_records',
    description: 'Group records by a field and count/sum/avg per group in one query (access-enforced).',
    parameters: { type: 'object', properties: { app_id: str, object_api_name: str, group_by: str, operation: { type: 'string', enum: ['count', 'sum', 'avg'] }, value_field: { ...str, description: 'Numeric field for sum/avg.' }, filters: { type: 'object' } }, required: ['app_id', 'object_api_name', 'group_by'] },
  },
  async execute(args) {
    const chart: Record<string, unknown> = { group_by: String(args.group_by), operation: typeof args.operation === 'string' ? args.operation : 'count', sort_by: 'value', sort_direction: 'desc', max_buckets: 50 };
    if (typeof args.value_field === 'string' && args.value_field) chart.value_field = args.value_field;
    const data = (await cpRequest('POST', `/api/apps/${enc(String(args.app_id))}/objects/${enc(String(args.object_api_name))}/list-views/query`, {
      view_mode: 'chart', chart, pagination: { page_size: 1 }, filters: asFilters(args.filters),
    })) as any;
    const buckets = Array.isArray(data?.chart?.buckets) ? data.chart.buckets : [];
    return {
      group_by: chart.group_by, operation: chart.operation,
      groups: buckets.map((b: any) => ({ group: b.group_key === null || b.group_key === undefined || b.group_key === '' ? '(blank)' : b.group_key, value: b.value ?? null })),
    };
  },
};

export const createRecordTool: AgentTool = {
  spec: {
    name: 'create_record',
    description: 'Create a REAL record in an object (subject to the user\'s create permission + validations). Use to seed test data. WRITE operation — only when the task asks to create data.',
    parameters: { type: 'object', properties: { app_id: str, object_api_name: str, values: { type: 'object', description: 'field api_name -> value map for the new record.' } }, required: ['app_id', 'object_api_name', 'values'] },
  },
  async execute(args) {
    return cpRequest('POST', `/api/apps/${enc(String(args.app_id))}/objects/${enc(String(args.object_api_name))}/records`, args.values);
  },
};

/** Per-app connection + credentials for grounding. Resolved from the active app (multi-tenant). */
export interface CatalogConn {
  baseUrl?: string;
  specPath?: string;
  catalogStrategy?: string;
  /** This app's read-only credentials (for the business-objects API half). */
  token?: string;
  username?: string;
  password?: string;
}

export interface CorePlatformMetadataMap {
  app_id: string;
  fetched_at: string;
  schema_version: string;
  objects: Array<{
    api_name: string;
    label: string;
    object_id: string;
    fields: Array<{
      api_name: string;
      label: string;
      type: string;
      required: boolean;
      readonly: boolean;
      permission_sensitive: boolean;
      appears_in_layouts: string[];
      appears_in_list_views: string[];
      appears_in_forms: string[];
    }>;
    list_views: Array<Record<string, unknown>>;
    layouts: unknown[];
    forms: unknown[];
  }>;
  total_fields: number;
  permission_sensitive_count: number;
}

const metadataMapCache = new Map<string, { at: number; value: CorePlatformMetadataMap }>();
const METADATA_MAP_CACHE_MS = 60 * 60 * 1000;

/**
 * Fetch the live catalog of metadata objects for an app, as ground-truth vocabulary for
 * requirement drafting (so `metadataRefs` are exact, real api_names instead of guesses).
 *
 * Strategy is resolved PER-APP (multi-tenant). Tenants run metadata-driven platforms, so the
 * default is 'swagger' — derive the catalog from the app's OpenAPI spec (pure API, no DB, no
 * data leakage). 'api' = the objects endpoint (business objects only). 'source' falls through
 * to swagger. 'none' = empty. NEVER throws — returns [] on any failure so a draft is never
 * blocked by grounding being unavailable.
 */
export async function fetchCorePlatformObjectCatalog(
  conn?: CatalogConn,
): Promise<Array<{ app: string; api_name: string; label: string }>> {
  const __src = String(conn?.catalogStrategy || process.env.CATALOG_SOURCE || 'swagger').toLowerCase();
  if (__src === 'none') return [];
  if (__src === 'api') return fetchObjectCatalogViaApi(conn);
  // 'swagger' (default) and 'source' both derive from the OpenAPI spec.
  return fetchObjectCatalogViaSwagger(conn);
}

// Resource segments that are not real metadata objects (verbs/system paths). Kept small
// and generic so the derivation stays app-agnostic.
const SWAGGER_STOP_SEGMENTS = new Set([
  'api', 'admin', 'auth', 'me', 'health', 'content', 'meta', 'json', 'download', 'upload', 'runs', 'logs', 'v1', 'v2',
]);

/** Singularize + snake_case a URL collection segment: "access-records" → "access_record". */
function swaggerResourceToApiName(seg: string): string {
  const words = seg.split('-').filter(Boolean);
  if (!words.length) return '';
  let last = words[words.length - 1];
  if (/ies$/.test(last)) last = last.slice(0, -3) + 'y';
  else if (/(ses|xes|zes|ches|shes)$/.test(last)) last = last.slice(0, -2);
  else if (/s$/.test(last) && !/ss$/.test(last)) last = last.slice(0, -1);
  return [...words.slice(0, -1), last].join('_');
}

// Common locations apps publish their OpenAPI/Swagger spec. Probed in order; the per-app
// configured path (if any) is tried first.
const SWAGGER_SPEC_PATHS = [
  '/openapi.json', '/swagger.json', '/v3/api-docs', '/api-docs', '/swagger/v1/swagger.json', '/api/openapi.json',
];

/** Best-effort: find and fetch a target's OpenAPI spec by probing common paths. */
async function fetchSwaggerSpec(url: string, preferredPath?: string): Promise<any | null> {
  const tried = new Set<string>();
  const candidates = [preferredPath, ...SWAGGER_SPEC_PATHS].filter(Boolean) as string[];
  for (const raw of candidates) {
    const p = raw.startsWith('/') ? raw : `/${raw}`;
    if (tried.has(p)) continue;
    tried.add(p);
    try {
      const res = await fetch(`${url}${p}`);
      if (res.ok) {
        const json = (await res.json()) as any;
        if (json && (json.openapi || json.swagger || json.paths)) return json;
      }
    } catch { /* try next */ }
  }
  return null;
}

/**
 * Swagger/OpenAPI path: derive the catalog from the target's spec — pure API, no DB.
 * Business objects come from the access-enforced objects API; the platform meta-objects
 * (field, tab, permission, access_record, ...) that the business endpoint hides are
 * recovered from the spec's admin/CRUD collection paths (a segment immediately followed
 * by an id placeholder, e.g. /admin/access-records/{id} → access_record). App-agnostic:
 * any app's spec reveals its manageable resources the same way.
 *
 * Per-app: pass the active app's baseUrl (+ optional specPath). The spec location is
 * auto-probed across common paths, so a newly-created app needs only its base URL.
 */
async function fetchObjectCatalogViaSwagger(
  conn?: CatalogConn,
): Promise<Array<{ app: string; api_name: string; label: string }>> {
  try {
    const url = await resolveServiceBase(conn);
    if (!url) return [];
    const business = await fetchObjectCatalogViaApi(conn);
    const spec = await fetchSwaggerSpec(url, conn?.specPath || process.env.TARGET_SPEC_PATH || undefined);
    const paths: string[] = spec && spec.paths ? Object.keys(spec.paths) : [];
    const metaNames = new Set<string>();
    for (const p of paths) {
      const segs = p.split('/').filter(Boolean);
      for (let i = 0; i < segs.length - 1; i++) {
        const cur = segs[i];
        const next = segs[i + 1];
        if (next.startsWith('{') && !cur.startsWith('{')) {
          const name = swaggerResourceToApiName(cur);
          if (name && name.length > 1 && !SWAGGER_STOP_SEGMENTS.has(name)) metaNames.add(name);
        }
      }
    }
    const businessNames = new Set(business.map((b) => b.api_name));
    const out = [...business];
    for (const n of metaNames) {
      if (!businessNames.has(n)) out.push({ app: 'core', api_name: n, label: n });
    }
    return out;
  } catch {
    return [];
  }
}

/** Resolve a bearer token for an app from its own connection (static token, else login). */
async function resolveConnToken(conn: CatalogConn, url: string): Promise<string | null> {
  const token = String(conn.token || process.env.TARGET_TOKEN || '').trim();
  if (token) return token;
  const username = String(conn.username || process.env.TARGET_USERNAME || '').trim();
  const password = String(conn.password || process.env.TARGET_PASSWORD || '').trim();
  if (!username || !password) return null;
  try {
    return await loginForToken(url, username, password);
  } catch {
    return null;
  }
}

/**
 * API path: list objects per app through the access-enforced App Service — using THIS app's
 * own baseUrl + credentials (multi-tenant), falling back to the global env only for a single
 * self-hosted target. Access-enforced, no DB, no cross-tenant leakage.
 */
async function fetchObjectCatalogViaApi(conn?: CatalogConn): Promise<Array<{ app: string; api_name: string; label: string }>> {
  try {
    const url = await resolveServiceBase(conn);
    if (!url) return [];
    const token = await resolveConnToken(conn || {}, url);
    if (!token) return [];
    const authGet = async (path: string) => {
      const res = await fetch(`${url}${path}`, { headers: { authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    };
    const apps = items(await authGet('/api/apps')) as any[];
    const out: Array<{ app: string; api_name: string; label: string }> = [];
    for (const app of Array.isArray(apps) ? apps : []) {
      const appId = app?.id;
      if (!appId) continue;
      try {
        const objs = items(await authGet(`/api/apps/${enc(String(appId))}/objects`)) as any[];
        for (const o of Array.isArray(objs) ? objs : []) {
          if (o?.api_name) out.push({ app: String(app.api_name || app.id), api_name: String(o.api_name), label: String(o.label || o.api_name) });
        }
      } catch { /* skip this app, keep the rest */ }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * List the platform's apps (id, label, api_name, prefix, parent) via the access-enforced App
 * Service, using THIS run's baseUrl + credentials. Best-effort: returns [] on any failure so the
 * caller can fall back to surface-wide targeting. The `id` (e.g. app0000006) is the routing key.
 */
export async function fetchCorePlatformApps(
  conn: CatalogConn,
): Promise<Array<{ id: string; label: string; api_name: string; app_prefix: string; parent_app_id: string | null }>> {
  try {
    const url = await resolveServiceBase(conn);
    if (!url) return [];
    const token = await resolveConnToken(conn, url);
    if (!token) return [];
    const res = await fetch(`${url}/api/apps`, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) return [];
    const apps = items(await res.json()) as any[];
    return (Array.isArray(apps) ? apps : [])
      .map((a) => ({
        id: String(a?.id || ''),
        label: String(a?.label || a?.api_name || a?.id || ''),
        api_name: String(a?.api_name || ''),
        app_prefix: String(a?.app_prefix || ''),
        parent_app_id: a?.parent_app_id ? String(a.parent_app_id) : null,
      }))
      .filter((a) => a.id);
  } catch {
    return [];
  }
}

/**
 * The OBJECT-BOUND tabs of an app — what an end-user actually navigates (each tab is one object's
 * list view). Used to pick the app's primary object (first tab) and the set of list views worth
 * testing. Best-effort: [] on failure.
 */
export async function fetchCorePlatformAppTabs(
  conn: CatalogConn,
  appId: string,
): Promise<Array<{ id: string; label: string; object_api_name: string }>> {
  try {
    const url = await resolveServiceBase(conn);
    const app = String(appId || '').trim();
    if (!url || !app) return [];
    const token = await resolveConnToken(conn, url);
    if (!token) return [];
    const res = await fetch(`${url}/api/apps/${enc(app)}/tabs`, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) return [];
    const tabs = items(await res.json()) as any[];
    return (Array.isArray(tabs) ? tabs : [])
      .map((t) => ({
        id: String(t?.id || ''),
        label: String(t?.label || ''),
        object_api_name: String(t?.object_api_name || t?.object?.api_name || ''),
      }))
      .filter((t) => t.object_api_name);
  } catch {
    return [];
  }
}

function fieldApiName(field: any): string {
  return String(field?.api_name || field?.apiName || field?.name || '').trim();
}

function fieldLabel(field: any): string {
  return String(field?.label || field?.display_name || fieldApiName(field)).trim();
}

function fieldType(field: any): string {
  return String(field?.type || field?.data_type || field?.field_type || 'text').trim();
}

function listViewApiName(view: any): string {
  return String(view?.api_name || view?.apiName || view?.name || view?.id || '').trim();
}

function listViewColumns(view: any): string[] {
  const columns = Array.isArray(view?.columns) ? view.columns : Array.isArray(view?.fields) ? view.fields : [];
  return columns
    .map((col: any) => String(col?.api_name || col?.field || col?.name || col || '').trim())
    .filter(Boolean);
}

function layoutApiName(layout: any): string {
  return String(layout?.api_name || layout?.apiName || layout?.name || layout?.id || 'default_layout').trim();
}

function layoutFieldNames(layout: any): string[] {
  const fields = Array.isArray(layout?.fields) ? layout.fields
    : Array.isArray(layout?.sections) ? layout.sections.flatMap((s: any) => s?.fields || [])
    : [];
  return fields.map(fieldApiName).filter(Boolean);
}

function formApiName(form: any): string {
  return String(form?.api_name || form?.apiName || form?.name || form?.id || 'default_form').trim();
}

function formFieldNames(form: any): string[] {
  const fields = Array.isArray(form?.fields) ? form.fields
    : Array.isArray(form?.sections) ? form.sections.flatMap((s: any) => s?.fields || [])
    : [];
  return fields.map(fieldApiName).filter(Boolean);
}

export async function fetchCorePlatformMetadataMap(conn: CatalogConn, appId: string): Promise<CorePlatformMetadataMap | null> {
  try {
    const url = await resolveServiceBase(conn);
    const app = String(appId || '').trim();
    if (!url || !app) return null;
    const cacheKey = `${url}::${app}::${conn.username || ''}::${conn.token ? 'token' : ''}`;
    const cached = metadataMapCache.get(cacheKey);
    if (cached && Date.now() - cached.at < METADATA_MAP_CACHE_MS) return cached.value;

    const token = await resolveConnToken(conn || {}, url);
    if (!token) return null;
    const authGet = async (path: string) => {
      const res = await fetch(`${url}${path}`, { headers: { authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    };
    const tryGet = async (path: string) => {
      try { return await authGet(path); } catch { return null; }
    };

    const rawObjects = items(await authGet(`/api/apps/${enc(app)}/objects`)) as any[];
    const objects: CorePlatformMetadataMap['objects'] = [];

    for (const obj of Array.isArray(rawObjects) ? rawObjects : []) {
      const apiName = String(obj?.api_name || obj?.apiName || obj?.name || '').trim();
      if (!apiName) continue;
      const objectId = String(obj?.id || obj?.object_id || obj?.objectId || '').trim();
      const [describe, listViewsRaw, fieldsRaw, layoutsRaw, formRaw] = await Promise.all([
        tryGet(`/api/apps/${enc(app)}/objects/${enc(apiName)}/describe`),
        tryGet(`/api/apps/${enc(app)}/objects/${enc(apiName)}/list-views`),
        objectId ? tryGet(`/admin/objects/${enc(objectId)}/fields`) : Promise.resolve(null),
        objectId ? tryGet(`/admin/objects/${enc(objectId)}/layouts`) : Promise.resolve(null),
        objectId ? tryGet(`/admin/objects/${enc(objectId)}/form`) : Promise.resolve(null),
      ]);

      const rawFields = [
        ...(Array.isArray((describe as any)?.fields) ? (describe as any).fields : []),
        ...(Array.isArray(items(fieldsRaw)) ? items(fieldsRaw) as any[] : []),
      ];
      const fieldMap = new Map<string, any>();
      for (const field of rawFields) {
        const name = fieldApiName(field);
        if (name) fieldMap.set(name, { ...(fieldMap.get(name) || {}), ...field });
      }

      const listViews = (Array.isArray(items(listViewsRaw)) ? items(listViewsRaw) as any[] : [])
        .map((view) => ({
          api_name: listViewApiName(view),
          label: String(view?.label || view?.name || listViewApiName(view)).trim(),
          sharing: view?.sharing || view?.visibility || null,
          columns: listViewColumns(view),
          user_specific: Boolean(view?.user_specific || view?.userSpecific || view?.owner_user_id || view?.is_private),
        }));
      const layouts = Array.isArray(items(layoutsRaw)) ? items(layoutsRaw) as any[] : [];
      const forms = (Array.isArray(items(formRaw)) ? items(formRaw) as any[] : formRaw ? [formRaw] : []) as any[];
      const layoutMembership = new Map<string, string[]>();
      const formMembership = new Map<string, string[]>();
      const listViewMembership = new Map<string, string[]>();

      for (const layout of layouts) {
        const layoutName = layoutApiName(layout);
        for (const name of layoutFieldNames(layout)) layoutMembership.set(name, [...(layoutMembership.get(name) || []), layoutName]);
      }
      for (const form of forms) {
        const formName = formApiName(form);
        for (const name of formFieldNames(form)) formMembership.set(name, [...(formMembership.get(name) || []), formName]);
      }
      for (const view of listViews) {
        const viewName = String(view.api_name || view.label || '').trim();
        for (const name of listViewColumns(view)) listViewMembership.set(name, [...(listViewMembership.get(name) || []), viewName]);
      }

      const fields = [...fieldMap.values()].map((field) => {
        const name = fieldApiName(field);
        const readonly = Boolean(field?.readonly || field?.read_only || field?.is_readonly || field?.calculated || field?.system);
        const required = Boolean(field?.required || field?.is_required);
        const appearsInLayouts = layoutMembership.get(name) || [];
        const permissionSensitive = readonly || required || appearsInLayouts.length > 0 || Boolean(field?.sharing || field?.access || field?.permissions);
        return {
          api_name: name,
          label: fieldLabel(field),
          type: fieldType(field),
          required,
          readonly,
          permission_sensitive: permissionSensitive,
          appears_in_layouts: appearsInLayouts,
          appears_in_list_views: listViewMembership.get(name) || [],
          appears_in_forms: formMembership.get(name) || [],
        };
      });

      objects.push({
        api_name: apiName,
        label: String(obj?.label || (describe as any)?.object?.label || apiName).trim(),
        object_id: objectId,
        fields,
        list_views: listViews,
        layouts,
        forms,
      });
    }

    const totalFields = objects.reduce((sum, obj) => sum + obj.fields.length, 0);
    const value: CorePlatformMetadataMap = {
      app_id: app,
      fetched_at: new Date().toISOString(),
      schema_version: createHash('sha1').update(JSON.stringify(objects)).digest('hex'),
      objects,
      total_fields: totalFields,
      permission_sensitive_count: objects.reduce((sum, obj) => sum + obj.fields.filter((f) => f.permission_sensitive).length, 0),
    };
    metadataMapCache.set(cacheKey, { at: Date.now(), value });
    return value;
  } catch {
    return null;
  }
}

/**
 * Build a REAL TEST DATA pack for the objects a prompt is about, so generated cases/scripts use
 * actual field api_names + valid values (incl. picklist options) and reference a real record —
 * instead of guessing selectors and typing placeholder text. Pure API, per-app, access-enforced.
 *
 * `hintText` is the prompt + understanding; objects whose api_name/label appear in it are picked.
 * NEVER throws — returns '' if nothing is configured/found so generation is never blocked.
 */
export async function fetchTestDataPack(conn: CatalogConn, hintText: string, objectHints: string[] = []): Promise<string> {
  try {
    const url = await resolveServiceBase(conn);
    if (!url) return '';
    const token = await resolveConnToken(conn || {}, url);
    if (!token) return '';
    const authGet = async (path: string) => {
      const res = await fetch(`${url}${path}`, { headers: { authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    };
    const authPost = async (path: string, body: unknown) => {
      const res = await fetch(`${url}${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    };
    const text = String(hintText || '').toLowerCase();
    const explicit = new Set(objectHints.map((s) => String(s || '').toLowerCase().trim()).filter(Boolean));
    const apps = items(await authGet('/api/apps')) as any[];
    // Pick the objects this prompt is about. Priority:
    //   1. explicit object hints (e.g. the understanding's metadataRefs) — authoritative,
    //   2. api_name/label that appears in the hint text (prompt + understanding + inspection),
    //   3. fallback to the app's first business object(s) — so runs on a generic screen (e.g. the
    //      Recycle Bin for delete/restore) still get a real record + schema to act on.
    const picked: Array<{ appId: string; appName: string; objName: string }> = [];
    const allObjs: Array<{ appId: string; appName: string; objName: string }> = [];
    for (const app of Array.isArray(apps) ? apps : []) {
      if (!app?.id) continue;
      let objs: any[] = [];
      try { objs = items(await authGet(`/api/apps/${enc(String(app.id))}/objects`)) as any[]; } catch { continue; }
      for (const o of Array.isArray(objs) ? objs : []) {
        const name = String(o?.api_name || '').toLowerCase();
        const label = String(o?.label || '').toLowerCase();
        if (!name) continue;
        const ref = { appId: String(app.id), appName: String(app.api_name || app.id), objName: String(o.api_name) };
        allObjs.push(ref);
        if (explicit.has(name) || text.includes(name) || (label.length > 2 && text.includes(label))) {
          picked.push(ref);
        }
      }
    }
    const seen = new Set<string>();
    // Use matched objects when found, else fall back to the first business object so there is
    // always a real record + schema available (never silently empty when an app is reachable).
    const source = picked.length ? picked : allObjs.slice(0, 1);
    const top = source.filter((p) => !seen.has(p.objName) && seen.add(p.objName)).slice(0, 2);
    if (!top.length) return '';
    const blocks: string[] = [];
    for (const p of top) {
      // Real fields (api_name, type, required, picklist options).
      let fields: any[] = [];
      try {
        const d = await authGet(`/api/apps/${enc(p.appId)}/objects/${enc(p.objName)}/describe`);
        fields = (Array.isArray((d as any)?.fields) ? (d as any).fields : items(d)) as any[];
      } catch { /* no schema */ }
      const fieldLines = (Array.isArray(fields) ? fields : []).slice(0, 25).map((f: any) => {
        const req = (f?.required || f?.is_required) ? ' REQUIRED' : '';
        const opts = f?.picklist_values || f?.options || f?.picklist;
        const pick = Array.isArray(opts) && opts.length
          ? ` options=[${opts.map((x: any) => x?.value ?? x?.label ?? x).filter(Boolean).slice(0, 8).join(' | ')}]`
          : '';
        return `  - ${f?.api_name} (${f?.data_type || f?.type || 'text'})${req}${pick}`;
      }).filter((l) => !l.includes('undefined'));
      // One real record to reference / edit.
      let sample = '';
      try {
        const q = await authPost(`/api/apps/${enc(p.appId)}/objects/${enc(p.objName)}/list-views/query`, { pagination: { page: 1, page_size: 1 } });
        const rec = (items(q) as any[])?.[0];
        if (rec) sample = `  example existing record: ${JSON.stringify(rec).slice(0, 400)}`;
      } catch { /* no records */ }
      if (fieldLines.length || sample) {
        blocks.push(`Object "${p.objName}" [app: ${p.appName}]\n${fieldLines.join('\n')}${sample ? `\n${sample}` : ''}`);
      }
    }
    return blocks.join('\n\n');
  } catch {
    return '';
  }
}

// A field is a uniqueness constraint (vary its value to avoid dup-key errors) when its name/label is name/code/email/number-like.
const UNIQUE_FIELD_RE = /(^|_)(name|code|email|number|no|id|title|key|slug)$|unique/i;

/**
 * STRUCTURED sibling of fetchTestDataPack — same per-object /describe + one sample record, but returned as the
 * Test Data Engine's ObjectSchema[] (types/picklists/required/sample) so the compiler can generate values the API
 * ACCEPTS. Scoped to ONE app (appId already resolved); hinted object(s) first, else the app's first business object.
 * NEVER throws — returns [] on any failure so its absence just falls back to DOM-semantic generation.
 */
export async function fetchObjectSchema(conn: CatalogConn, appId: string, objectHints: string[] = []): Promise<ObjectSchema[]> {
  try {
    const url = await resolveServiceBase(conn);
    const app = String(appId || '').trim();
    if (!url || !app) return [];
    const token = await resolveConnToken(conn || {}, url);
    if (!token) return [];
    const authGet = async (path: string) => {
      const res = await fetch(`${url}${path}`, { headers: { authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    };
    const authPost = async (path: string, body: unknown) => {
      const res = await fetch(`${url}${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    };
    const objs = items(await authGet(`/api/apps/${enc(app)}/objects`)) as any[];
    const names = (Array.isArray(objs) ? objs : []).map((o) => String(o?.api_name || '')).filter(Boolean);
    // Resolve the RIGHT object the user is creating — not just an exact string equality (which misses the
    // common singular/plural + label-vs-api_name mismatch, e.g. hint "accounts" vs api_name "account", and
    // silently described the app's FIRST object instead). Rank by match strength, fall back to first only
    // when nothing matches at all.
    const norm = (s: string) => String(s || '').toLowerCase().trim().replace(/[\s_-]+/g, '');
    const singular = (s: string) => s.replace(/ies$/, 'y').replace(/([^s])s$/, '$1');
    const hintset = objectHints.map(norm).filter(Boolean);
    const scoreName = (n: string): number => {
      const nn = norm(n);
      let best = 0;
      for (const h of hintset) {
        if (nn === h) best = Math.max(best, 3);                       // exact
        else if (singular(nn) === singular(h)) best = Math.max(best, 2); // singular/plural
        else if (nn.includes(h) || h.includes(nn)) best = Math.max(best, 1); // substring either way
      }
      return best;
    };
    const ranked = names.map((n) => ({ n, s: scoreName(n) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).map((x) => x.n);
    const picked = (ranked.length ? ranked : names.slice(0, 1)).slice(0, 2);
    const out: ObjectSchema[] = [];
    for (const objName of picked) {
      let fields: any[] = [];
      try {
        const d = await authGet(`/api/apps/${enc(app)}/objects/${enc(objName)}/describe`);
        fields = (Array.isArray((d as any)?.fields) ? (d as any).fields : items(d)) as any[];
      } catch { /* no schema for this object */ }
      let sample: Record<string, unknown> | null = null;
      try {
        const q = await authPost(`/api/apps/${enc(app)}/objects/${enc(objName)}/list-views/query`, { pagination: { page: 1, page_size: 1 } });
        sample = ((items(q) as any[])?.[0] ?? null) as Record<string, unknown> | null;
      } catch { /* no records */ }
      const schemaFields = (Array.isArray(fields) ? fields : []).map((f: any) => {
        const apiName = String(f?.api_name || '');
        const opts = f?.picklist_values || f?.options || f?.picklist;
        const picklistValues = Array.isArray(opts) && opts.length
          ? opts.map((x: any) => x?.value ?? x?.label ?? x).filter(Boolean).map(String)
          : null;
        const uniqueHay = `${apiName} ${String(f?.label || '')}`;
        return {
          apiName,
          label: f?.label ?? null,
          dataType: String(f?.data_type || f?.type || 'text'),
          required: Boolean(f?.required || f?.is_required),
          picklistValues,
          unique: UNIQUE_FIELD_RE.test(uniqueHay) ? true : undefined,
        };
      }).filter((f) => f.apiName);
      out.push({ objectApiName: objName, fields: schemaFields, sample });
    }
    return out;
  } catch {
    return [];
  }
}

/** Whether the data tools are configured (base URL + a token/credential). */
export function corePlatformDataConfigured(): boolean {
  if (!baseUrl()) return false;
  if (String(process.env.TARGET_TOKEN || '').trim()) return true;
  return !!(String(process.env.TARGET_USERNAME || '').trim() && String(process.env.TARGET_PASSWORD || '').trim());
}

/** Read-only data tools (safe to always offer). create_record is a write — added separately. */
export const corePlatformReadTools: AgentTool[] = [listAppsTool, describeAppSchemaTool, queryRecordsTool, countRecordsTool, aggregateRecordsTool];
export const corePlatformWriteTools: AgentTool[] = [createRecordTool];

/** All data tools, only when configured (else the agent shouldn't see broken tools). */
export function corePlatformDataTools(includeWrite = true): AgentTool[] {
  if (!corePlatformDataConfigured()) return [];
  return includeWrite ? [...corePlatformReadTools, ...corePlatformWriteTools] : [...corePlatformReadTools];
}

// `ToolContext` is part of the AgentTool execute signature even where unused here.
export type { ToolContext };
