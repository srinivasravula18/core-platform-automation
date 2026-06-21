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
 *   CORE_PLATFORM_BASE_URL                     App Service base URL (required)
 *   CORE_PLATFORM_TOKEN                        bearer token to act as, OR
 *   CORE_PLATFORM_USERNAME + _PASSWORD         credentials to log in for a token
 */
import type { AgentTool, ToolContext } from './types';

function baseUrl(): string {
  return String(process.env.CORE_PLATFORM_BASE_URL || '').replace(/\/+$/, '');
}

// Cache a logged-in token so we don't re-auth on every call. Cleared on a 401 so the next call
// re-logs-in. A static CORE_PLATFORM_TOKEN (if set) is always preferred and never cached/cleared.
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
  const staticToken = String(process.env.CORE_PLATFORM_TOKEN || '').trim();
  if (staticToken) return staticToken;
  if (cachedToken && !forceRefresh) return cachedToken;
  const username = String(process.env.CORE_PLATFORM_USERNAME || '').trim();
  const password = String(process.env.CORE_PLATFORM_PASSWORD || '').trim();
  if (!username || !password) {
    throw new Error('Core Platform data tools are not configured. Set CORE_PLATFORM_BASE_URL and CORE_PLATFORM_TOKEN (or CORE_PLATFORM_USERNAME + CORE_PLATFORM_PASSWORD).');
  }
  cachedToken = await loginForToken(url, username, password);
  return cachedToken;
}

/** One App Service request with the user's bearer token. Retries once on 401 (token expired). */
async function cpRequest(method: string, path: string, body?: unknown): Promise<unknown> {
  const url = baseUrl();
  if (!url) throw new Error('Core Platform data tools are not configured: CORE_PLATFORM_BASE_URL is not set.');
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
  if (res.status === 401 && !process.env.CORE_PLATFORM_TOKEN) {
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

/** Whether the Core Platform data tools are configured (base URL + a token/credential). */
export function corePlatformDataConfigured(): boolean {
  if (!baseUrl()) return false;
  if (String(process.env.CORE_PLATFORM_TOKEN || '').trim()) return true;
  return !!(String(process.env.CORE_PLATFORM_USERNAME || '').trim() && String(process.env.CORE_PLATFORM_PASSWORD || '').trim());
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
