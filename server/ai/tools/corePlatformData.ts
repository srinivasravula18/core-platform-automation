/**
 * Core Platform DATA tools — direct, in-process (no MCP). These give the agent the SAME
 * capabilities as @core-platform/mcp-server, but as native function-calling tools: each is a
 * thin proxy to the Core Platform App Service HTTP API, which remains the single enforcement
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
import type { AgentTool, ToolContext } from './types';

function baseUrl(): string {
  return String(process.env.TARGET_BASE_URL || '').replace(/\/+$/, '');
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
  if (!res.ok || !json?.access_token) throw new Error(`Core Platform login failed (${res.status}).`);
  return json.access_token;
}

async function resolveToken(url: string, forceRefresh = false): Promise<string> {
  const staticToken = String(process.env.TARGET_TOKEN || '').trim();
  if (staticToken) return staticToken;
  if (cachedToken && !forceRefresh) return cachedToken;
  const username = String(process.env.TARGET_USERNAME || '').trim();
  const password = String(process.env.TARGET_PASSWORD || '').trim();
  if (!username || !password) {
    throw new Error('Core Platform data tools are not configured. Set TARGET_BASE_URL and TARGET_TOKEN (or TARGET_USERNAME + TARGET_PASSWORD).');
  }
  cachedToken = await loginForToken(url, username, password);
  return cachedToken;
}

/** One App Service request with the user's bearer token. Retries once on 401 (token expired). */
async function cpRequest(method: string, path: string, body?: unknown): Promise<unknown> {
  const url = baseUrl();
  if (!url) throw new Error('Core Platform data tools are not configured: TARGET_BASE_URL is not set.');
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
  spec: { name: 'list_apps', description: 'List the Core Platform applications the configured user can access. Use to discover real app ids before describing schema or querying records.', parameters: { type: 'object', properties: {} } },
  async execute() { return { apps: items(await cpRequest('GET', '/api/apps')) }; },
};

export const describeAppSchemaTool: AgentTool = {
  spec: {
    name: 'describe_app_schema',
    description: 'List the objects in a Core Platform app (access-scoped). Pass object_api_names to also fetch those objects\' FIELDS (api_names, types, validations) so you can write tests/queries against the REAL data model.',
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
    description: 'Query REAL records of a Core Platform object with optional filters and paging (row/field access enforced server-side). Filter shape: { logic: "AND"|"OR", filters: [{ field, op, value }] }. Use to ground tests in actual data.',
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
    description: 'Return the exact, access-correct COUNT of Core Platform records matching optional filters. Use for "how many" questions.',
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
    description: 'Group Core Platform records by a field and count/sum/avg per group in one query (access-enforced).',
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
    description: 'Create a REAL record in a Core Platform object (subject to the user\'s create permission + validations). Use to seed test data. WRITE operation — only when the task asks to create data.',
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
    const url = (conn?.baseUrl || baseUrl() || '').replace(/\/+$/, '');
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
    const url = (conn?.baseUrl || baseUrl() || '').replace(/\/+$/, '');
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
 * Build a REAL TEST DATA pack for the objects a prompt is about, so generated cases/scripts use
 * actual field api_names + valid values (incl. picklist options) and reference a real record —
 * instead of guessing selectors and typing placeholder text. Pure API, per-app, access-enforced.
 *
 * `hintText` is the prompt + understanding; objects whose api_name/label appear in it are picked.
 * NEVER throws — returns '' if nothing is configured/found so generation is never blocked.
 */
export async function fetchTestDataPack(conn: CatalogConn, hintText: string, objectHints: string[] = []): Promise<string> {
  try {
    const url = (conn?.baseUrl || baseUrl() || '').replace(/\/+$/, '');
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

/** Whether the Core Platform data tools are configured (base URL + a token/credential). */
export function corePlatformDataConfigured(): boolean {
  if (!baseUrl()) return false;
  if (String(process.env.TARGET_TOKEN || '').trim()) return true;
  return !!(String(process.env.TARGET_USERNAME || '').trim() && String(process.env.TARGET_PASSWORD || '').trim());
}

/** Read-only data tools (safe to always offer). create_record is a write — added separately. */
export const corePlatformReadTools: AgentTool[] = [listAppsTool, describeAppSchemaTool, queryRecordsTool, countRecordsTool, aggregateRecordsTool];
export const corePlatformWriteTools: AgentTool[] = [createRecordTool];

/** All Core Platform data tools, only when configured (else the agent shouldn't see broken tools). */
export function corePlatformDataTools(includeWrite = true): AgentTool[] {
  if (!corePlatformDataConfigured()) return [];
  return includeWrite ? [...corePlatformReadTools, ...corePlatformWriteTools] : [...corePlatformReadTools];
}

// `ToolContext` is part of the AgentTool execute signature even where unused here.
export type { ToolContext };
