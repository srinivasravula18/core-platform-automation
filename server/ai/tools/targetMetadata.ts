/**
 * Application META tools — available to EVERY agent model (OpenAI, Claude API,
 * Codex subscription, or any future provider). These are native AgentTool entries in
 * the tool-calling loop, NOT MCP-only.
 *
 * Actual API routes (verified from source):
 *   GET /api/apps/__all_apps__/objects                           → { items: [...] }
 *   GET /api/apps/:appId/objects/:object/describe               → { object:{}, fields:[] }
 *   GET /api/apps/__all_apps__/objects/:object/records?page_size=N  → { items:[], page, page_size }
 *   POST /api/auth/login                                         → { access_token }
 *
 * Connection resolution (multi-tenant):
 *   1. ctx.appId → Websites table (per-workspace baseUrl + credentials)
 *   2. TARGET_* env vars          (single-tenant / local dev)
 *   3. last resort                (when nothing else is configured)
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import type { AgentTool, ToolContext } from './types';
import { resolveCredentials, getWebsite } from '../../features/credentials/credentialsService';
import { resolveAppApiContract, fillApiPath, type AppApiContract } from './apiContract';
import { fetchOpenApiSpec, parseOpenApi } from '../../features/api-intelligence/discovery';
import { allowsTargetMutation } from '../agent-runtime/policy';
import { resolveServiceBase } from './targetData';
import { withEvidence } from './evidenceEnvelope';

/* ─── Connection helpers ─────────────────────────────────────────────────── */

interface AppConn { baseUrl: string; username: string; password: string }

/** Per-call token cache keyed by baseUrl so multiple workspaces don't share a token. */
const tokenCache = new Map<string, string>();
const operationCache = new WeakMap<ToolContext, Promise<any[]>>();

function objectToolArgs(args: Record<string, unknown>, appError = 'app_id is required') {
  const appId = String(args.app_id || '').trim();
  const apiName = String(args.object_api_name || '').trim();
  if (!appId) return { error: appError } as const;
  if (!apiName) return { error: 'object_api_name is required' } as const;
  return { appId, apiName } as const;
}

async function resolveConnection(ctx?: ToolContext): Promise<AppConn> {
  const target = ctx?.targetApps?.find((item) => item?.id);
  if (target?.id) {
    const cred = resolveCredentials({ websiteId: String(target.id), baseUrl: target.baseUrl, role: 'admin', ownerId: ctx?.userId ? String(ctx.userId) : undefined });
    if (cred?.baseUrl && cred?.username && cred?.password) {
      return { baseUrl: await resolveServiceBase({ baseUrl: cred.baseUrl }), username: cred.username, password: cred.password };
    }
  }
  // 1. ctx.appId → Websites table (per-workspace)
  if (ctx?.appId) {
    const cred = resolveCredentials({
      websiteId: String(ctx.appId),
      role: 'admin',
      ownerId: ctx.userId ? String(ctx.userId) : undefined,
    });
    if (cred?.baseUrl && cred?.username && cred?.password) {
      return { baseUrl: await resolveServiceBase({ baseUrl: cred.baseUrl }), username: cred.username, password: cred.password };
    }
    const site = getWebsite(String(ctx.appId));
    if (site?.baseUrl) {
      return {
        baseUrl: await resolveServiceBase({ baseUrl: site.baseUrl }),
        username: process.env.TARGET_USERNAME || '',
        password: process.env.TARGET_PASSWORD || '',
      };
    }
  }
  // 2. env vars
  return {
    baseUrl: await resolveServiceBase({ baseUrl: process.env.TARGET_BASE_URL || '' }),
    username: process.env.TARGET_USERNAME || '',
    password: process.env.TARGET_PASSWORD || '',
  };
}

export function loginPathCandidates(configured = process.env.TARGET_AUTH_PATH || ''): string[] {
  return [...new Set([configured.trim(), '/auth/login', '/api/auth/login'].filter(Boolean).map((path) => path.startsWith('/') ? path : `/${path}`))];
}

async function getToken(conn: AppConn, forceRefresh = false): Promise<string> {
  const staticToken = String(process.env.TARGET_TOKEN || '').trim();
  if (staticToken) return staticToken;

  const cacheKey = `${conn.baseUrl}\n${conn.username}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && !forceRefresh) return cached;

  for (const path of loginPathCandidates()) {
    const res = await fetch(`${conn.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: conn.username, password: conn.password }),
    });
    if (res.status === 404) continue;
    const json = (await res.json().catch(() => null)) as any;
    const token: string = json?.access_token || json?.token || json?.accessToken || '';
    if (!res.ok || !token) throw new Error(`Login failed (${res.status})`);
    tokenCache.set(cacheKey, token);
    return token;
  }
  throw new Error('No configured or standard login operation exists on the target API.');
}

async function cpFetch(method: string, path: string, body: unknown, ctx?: ToolContext): Promise<unknown> {
  const conn = await resolveConnection(ctx);
  const call = async (token: string) => {
    return fetch(`${conn.baseUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  };

  let token = await getToken(conn);
  let res = await call(token);
  if (res.status === 401 && !process.env.TARGET_TOKEN) {
    tokenCache.delete(`${conn.baseUrl}\n${conn.username}`);
    token = await getToken(conn, true);
    res = await call(token);
  }
  const text = await res.text();
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try { const d = JSON.parse(text); detail = d?.message ?? d?.detail ?? detail; } catch { /* keep default */ }
    throw new Error(`${method} ${path} failed (${res.status}): ${detail}`);
  }
  try { return text ? JSON.parse(text) : null; } catch { return text; }
}

export async function listTargetApiOperations(ctx?: ToolContext): Promise<any[]> {
  const load = async () => {
    const conn = await resolveConnection(ctx);
    const token = await getToken(conn);
    const spec = await fetchOpenApiSpec(conn.baseUrl, token);
    return spec ? parseOpenApi(spec, conn.baseUrl).endpoints : [];
  };
  if (!ctx) return load();
  const cached = operationCache.get(ctx);
  if (cached) return cached;
  const pending = load();
  operationCache.set(ctx, pending);
  try { return await pending; }
  catch (error) { operationCache.delete(ctx); throw error; }
}

function operationPath(operation: any, pathParams: Record<string, unknown>, query: Record<string, unknown>): string {
  const segments = String(operation.path).split('/').map((part) => {
    if (!(part.startsWith('{') && part.endsWith('}'))) return part;
    const value = pathParams[part.slice(1, -1)];
    if (value === undefined || value === null || value === '') throw new Error(`Missing required path parameter ${part}.`);
    return encodeURIComponent(String(value));
  });
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== null) params.set(key, String(value));
  const suffix = params.toString();
  return `${segments.join('/')}${suffix ? `?${suffix}` : ''}`;
}

export async function callTargetReadOperation(operationId: string, pathParams: Record<string, unknown>, query: Record<string, unknown>, ctx?: ToolContext): Promise<unknown> {
  const operation = (await listTargetApiOperations(ctx)).find((item: any) => item.id === operationId);
  if (!operation) throw new Error('The operation is not present in the target OpenAPI document.');
  if (String(operation.method).toUpperCase() !== 'GET') throw new Error('Only documented GET operations are available until a write is explicitly confirmed.');
  const path = operationPath(operation, pathParams, query);
  const raw = await cpRequest('GET', path, ctx);
  const payload = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : { data: raw };
  const returned = Array.isArray(raw) ? raw.length : undefined;
  const total = typeof (payload as any).total_count === 'number' ? (payload as any).total_count : undefined;
  return withEvidence(payload, {
    subject: String(operation.summary || operation.id || 'API result'),
    scope: { kind: 'target', label: ctx?.targetApps?.[0]?.name },
    method: 'GET', operation: path, complete: total == null ? false : returned == null || returned >= total, returned, total,
  });
}

export async function callTargetWriteOperation(operationId: string, pathParams: Record<string, unknown>, query: Record<string, unknown>, body: unknown, ctx?: ToolContext): Promise<unknown> {
  const operation = (await listTargetApiOperations(ctx)).find((item: any) => item.id === operationId);
  if (!operation) throw new Error('The operation is not present in the target OpenAPI document.');
  const method = String(operation.method).toUpperCase();
  if (!allowsTargetMutation(method, String(operation.path))) {
    throw new Error('This documented operation is not available to the agent.');
  }
  return cpFetch(method, operationPath(operation, pathParams, query), body, ctx);
}

const cpRequest = (method: string, path: string, ctx?: ToolContext) => cpFetch(method, path, undefined, ctx);
const cpRequestPost = (path: string, body: unknown, ctx?: ToolContext) => cpFetch('POST', path, body, ctx);

/** Resolve the app's API contract (endpoint templates) from its OWN OpenAPI — no path literals. */
async function metaContract(ctx?: ToolContext): Promise<AppApiContract> {
  const conn = await resolveConnection(ctx);
  if (!conn.baseUrl) return {};
  let token: string | undefined;
  try { token = await getToken(conn); } catch { /* spec is often public */ }
  return resolveAppApiContract(conn.baseUrl, token);
}
async function metaPath(role: keyof AppApiContract, vars: { appId?: string; object?: string }, ctx?: ToolContext): Promise<string> {
  const c = await metaContract(ctx);
  if (!c[role]) throw new Error(`The app's OpenAPI exposes no '${role}' endpoint.`);
  return fillApiPath(c[role]!, vars);
}
const asItems = (data: any): any[] => Array.isArray(data?.items) ? data.items : (Array.isArray(data) ? data : []);

export const listAppsTool: AgentTool = {
  spec: { name: 'list_apps', description: 'List applications available to the authenticated target user through REST. Always use this for the current app count or current app list; never inspect the UI for those answers.', parameters: { type: 'object', properties: {} } },
  async execute(_args, ctx) {
    try {
      const contract = await metaContract(ctx);
      if (!contract.listApps) return { error: "The target's OpenAPI exposes no list-applications endpoint." };
      const apps = asItems(await cpRequest('GET', contract.listApps, ctx));
      return withEvidence({ apps }, {
        subject: 'applications', scope: { kind: 'target', label: ctx?.targetApps?.[0]?.name },
        method: 'GET', operation: contract.listApps, complete: true, returned: apps.length, total: apps.length,
      });
    } catch (err: any) { return { error: err?.message ?? String(err) }; }
  },
};

export const listObjectsTool: AgentTool = {
  spec: { name: 'list_objects', description: 'List and count exact objects. Pass app_id from list_apps for one application; omit it for all applications. Use this for totals.', parameters: { type: 'object', properties: { app_id: { type: 'string' } } } },
  async execute(args, ctx) {
    const contract = await metaContract(ctx);
    if (!contract.listObjects) return { error: 'The target OpenAPI has no object-list operation.' };
    const appId = String(args.app_id || '').trim();
    const all = appId ? null : await listAllObjectsViaContract(ctx);
    const listed = appId ? asItems(await cpRequest('GET', fillApiPath(contract.listObjects, { appId }), ctx)) : all!.objects;
    const objects = appId ? listed : [...new Map(listed.map((item) => [String(item?.id || String(item?.app_id) + ':' + String(item?.api_name)), item])).values()];
    const apps = appId && contract.listApps ? asItems(await cpRequest('GET', contract.listApps, ctx)) : [];
    const app = apps.find((item) => String(item?.id) === appId);
    const complete = Boolean(appId) || all!.complete;
    return withEvidence({ objects, count: objects.length }, { subject: 'objects', scope: appId ? { kind: 'application', id: appId, label: String(app?.label || appId) } : { kind: 'all_applications', label: 'all applications' }, method: 'GET', operation: contract.listObjects, complete, returned: objects.length, ...(complete ? { total: objects.length } : {}) });
  },
};
/** Every object across the app's apps — replaces the CP-specific __all_apps__ cross-app scope with iteration. */
async function listAllObjectsViaContract(ctx?: ToolContext): Promise<{ objects: any[]; complete: boolean }> {
  const c = await metaContract(ctx);
  if (!c.listApps || !c.listObjects) return { objects: [], complete: false };
  const apps = asItems(await cpRequest('GET', c.listApps, ctx));
  const out: any[] = [];
  let complete = true;
  for (const app of apps) {
    if (!app?.id) continue;
    try {
      const objs = asItems(await cpRequest('GET', fillApiPath(c.listObjects, { appId: String(app.id) }), ctx));
      for (const o of objs) out.push({ ...o, app_id: o.app_id || app.id, app_prefix: o.app_prefix || app.app_prefix });
    } catch { complete = false; }
  }
  return { objects: out, complete };
}

/* ─── Stop words for keyword extraction ──────────────────────────────────── */

const STOP = new Set(['the', 'and', 'for', 'to', 'of', 'a', 'an', 'in', 'is', 'are', 'how', 'what', 'test', 'feature', 'page', 'with', 'from', 'this', 'that']);

function keywords(query: string): string[] {
  return [...new Set(
    query.toLowerCase().match(/[a-z][a-z0-9_-]{1,}/g)?.filter((w) => !STOP.has(w)) ?? []
  )].slice(0, 6);
}

/* ─── Tool: search_relevant_objects ──────────────────────────────────────── */

export const searchRelevantObjectsTool: AgentTool = {
  spec: {
    name: 'search_relevant_objects',
    description: 'Find metadata objects (tables/models) relevant to a natural language query. Returns object api_name, label, table_name, app_prefix, and app_id. Always call this first to discover which objects are relevant to a feature before calling get_object_fields.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural language description of the feature or domain (e.g. "vendor approval workflow").' },
      },
      required: ['query'],
    },
  },
  async execute(args, ctx) {
    try {
      const kws = keywords(String(args.query || ''));
      if (!kws.length) return { error: 'query must contain at least one non-stop keyword' };

      // All objects across the app's apps — from the app's OpenAPI contract, not a hardcoded scope.
      const { objects: allObjects } = await listAllObjectsViaContract(ctx);

      if (!allObjects.length) return { note: 'no objects found — check connection', objects: [] };

      const scored = allObjects
        .map((o: any) => {
          const label = (o.label || '').toLowerCase();
          const apiName = (o.api_name || '').toLowerCase();
          const tableN = (o.table_name || '').toLowerCase();
          const matches = kws.filter((kw) => label.includes(kw) || apiName.includes(kw) || tableN.includes(kw)).length;
          return { ...o, _score: matches };
        })
        .filter((o) => o._score > 0)
        .sort((a, b) => b._score - a._score)
        .slice(0, 8)
        .map(({ _score: _, ...o }) => ({
          api_name: o.api_name,
          label: o.label,
          table_name: o.table_name,
          app_prefix: o.app_prefix,
          app_id: o.app_id,
        }));

      return withEvidence({ objects: scored, count: scored.length }, {
        subject: 'objects', scope: { kind: 'filtered', label: String(args.query || '') },
        method: 'GET', operation: 'OpenAPI:listApps+listObjects', complete: true, returned: scored.length, total: scored.length,
      });
    } catch (err: any) {
      return { error: err?.message ?? String(err) };
    }
  },
};

/* ─── Tool: get_object_fields ────────────────────────────────────────────── */

export const getObjectFieldsTool: AgentTool = {
  spec: {
    name: 'get_object_fields',
    description: 'Get all fields (api_name, type, label, required, searchable, reference_object_id) for a metadata object. Requires the object api_name AND the app_id (UUID) from search_relevant_objects. Returns the full field list including relationships.',
    parameters: {
      type: 'object',
      properties: {
        object_api_name: { type: 'string', description: 'The api_name of the object (e.g. "account", "vendor", "leave_request").' },
        app_id: { type: 'string', description: 'The app UUID from search_relevant_objects results. Required to scope the describe call correctly.' },
      },
      required: ['object_api_name', 'app_id'],
    },
  },
  async execute(args, ctx) {
    try {
      const apiName = String(args.object_api_name || '').trim();
      const appId = String(args.app_id || '').trim();
      if (!apiName) return { error: 'object_api_name is required' };
      if (!appId) return { error: 'app_id is required — get it from search_relevant_objects first' };

      const data = (await cpRequest('GET', await metaPath('describeObject', { appId, object: apiName }, ctx), ctx)) as any;
      const fields: any[] = Array.isArray(data?.fields) ? data.fields : [];
      const objectMeta = data?.object ?? {};

      const fieldSummary = fields.map((f: any) => ({
        api_name: f.api_name,
        label: f.label,
        type: f.type,
        required: f.required ?? false,
        searchable: f.searchable ?? false,
        reference_object_id: f.reference_object_id ?? null,
        relationship_label: f.relationship_label ?? null,
        read_only: f.read_only ?? false,
      }));

      return withEvidence({
        object: apiName,
        table_name: objectMeta.table_name ?? null,
        app_prefix: objectMeta.app_prefix ?? null,
        fields: fieldSummary,
        field_count: fieldSummary.length,
        relationships: (data?.relationships ?? []).map((r: any) => ({
          object_api_name: r.object_api_name,
          object_label: r.object_label,
          field_api_name: r.field_api_name,
        })),
      }, {
        subject: 'fields', scope: { kind: 'application', id: appId, label: apiName },
        method: 'GET', operation: await metaPath('describeObject', { appId, object: apiName }, ctx),
        complete: true, returned: fieldSummary.length, total: fieldSummary.length,
      });
    } catch (err: any) {
      return { error: err?.message ?? String(err) };
    }
  },
};

/* ─── Tool: query_sample_records ─────────────────────────────────────────── */

export const querySampleRecordsTool: AgentTool = {
  spec: {
    name: 'query_sample_records',
    description: 'Fetch a small sample of real records from an object using the list-views query engine (access-enforced). Supports optional filters. Use object api_name (e.g. "vendor") from search_relevant_objects.',
    parameters: {
      type: 'object',
      properties: {
        app_id: { type: 'string', description: 'App UUID from search_relevant_objects.' },
        object_api_name: { type: 'string', description: 'The api_name of the object (e.g. "vendor", "leave_request").' },
        page_size: { type: 'number', description: 'Max records to return (1–50, default 5).' },
        filters: { type: 'object', description: 'Optional filter tree: { logic: "AND"|"OR", filters: [{ field, op, value }] }.' },
      },
      required: ['app_id', 'object_api_name'],
    },
  },
  async execute(args, ctx) {
    try {
      const parsed = objectToolArgs(args, 'app_id is required — get it from search_relevant_objects');
      if ('error' in parsed) return parsed;
      const { appId, apiName } = parsed;
      const pageSize = Math.min(Math.max(1, Number(args.page_size ?? 5)), 50);

      const body: Record<string, unknown> = {
        pagination: { page: 1, page_size: pageSize },
      };
      if (args.filters && typeof args.filters === 'object') body.filters = args.filters;

      const data = (await cpRequestPost(await metaPath('queryListView', { appId, object: apiName }, ctx), body, ctx)) as any;
      const records: any[] = Array.isArray(data?.items) ? data.items : [];
      const total = typeof data?.total_count === 'number' ? data.total_count : undefined;
      return withEvidence({ object: apiName, records, count: records.length, total_count: total ?? null }, {
        subject: 'records', scope: { kind: args.filters ? 'filtered' : 'application', id: appId, label: apiName },
        method: 'POST', operation: await metaPath('queryListView', { appId, object: apiName }, ctx),
        complete: total != null && records.length >= total, returned: records.length, total,
      });
    } catch (err: any) {
      return { error: err?.message ?? String(err) };
    }
  },
};

/* ─── Tool: count_records ────────────────────────────────────────────────── */

export const countRecordsTool: AgentTool = {
  spec: {
    name: 'count_records',
    description: 'Return the exact access-enforced count of records in an object, with optional filters. Use for "how many X exist" questions before writing data population requirements.',
    parameters: {
      type: 'object',
      properties: {
        app_id: { type: 'string', description: 'App UUID from search_relevant_objects.' },
        object_api_name: { type: 'string', description: 'The api_name of the object.' },
        filters: { type: 'object', description: 'Optional filter tree: { logic: "AND"|"OR", filters: [{ field, op, value }] }.' },
      },
      required: ['app_id', 'object_api_name'],
    },
  },
  async execute(args, ctx) {
    try {
      const parsed = objectToolArgs(args);
      if ('error' in parsed) return parsed;
      const { appId, apiName } = parsed;

      const body: Record<string, unknown> = {
        pagination: { page_size: 1 },
        summary: { operations: ['count'] },
      };
      if (args.filters && typeof args.filters === 'object') body.filters = args.filters;

      const data = (await cpRequestPost(await metaPath('queryListView', { appId, object: apiName }, ctx), body, ctx)) as any;
      const count = data?.summary?.count ?? data?.total_count ?? null;
      return withEvidence({ object: apiName, count }, {
        subject: 'records', scope: { kind: args.filters ? 'filtered' : 'application', id: appId, label: apiName },
        method: 'POST', operation: await metaPath('queryListView', { appId, object: apiName }, ctx),
        complete: count != null, returned: count == null ? 0 : Number(count), total: count == null ? undefined : Number(count),
      });
    } catch (err: any) {
      return { error: err?.message ?? String(err) };
    }
  },
};

/* ─── Tool: create_record ────────────────────────────────────────────────── */

export const createRecordTool: AgentTool = {
  spec: {
    name: 'create_record',
    description: 'Create a record in an object. Subject to user create permissions, field rules, and validations enforced by App Service. Use for populating test data during requirement or test case analysis.',
    parameters: {
      type: 'object',
      properties: {
        app_id: { type: 'string', description: 'App UUID from search_relevant_objects.' },
        object_api_name: { type: 'string', description: 'The api_name of the object to create a record in.' },
        values: { type: 'object', description: 'Field api_name → value map for the new record.' },
      },
      required: ['app_id', 'object_api_name', 'values'],
    },
  },
  async execute(args, ctx) {
    try {
      const parsed = objectToolArgs(args);
      if ('error' in parsed) return parsed;
      const { appId, apiName } = parsed;
      if (!args.values || typeof args.values !== 'object') return { error: 'values must be an object of field api_name → value' };

      const data = await cpRequestPost(
        await metaPath('createRecord', { appId, object: apiName }, ctx),
        args.values,
        ctx,
      );
      return { ok: true, record: data };
    } catch (err: any) {
      return { error: err?.message ?? String(err) };
    }
  },
};

/* ─── Tool: get_api_routes ───────────────────────────────────────────────── */

export const getApiRoutesTool: AgentTool = {
  spec: {
    name: 'get_api_routes',
    description: 'Search the source code for HTTP route definitions relevant to a query. Returns route paths with their source file paths. Use to discover what API endpoints exist for a feature.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural language query — keywords are matched against source file paths to find relevant route files.' },
      },
      required: ['query'],
    },
  },
  async execute(args) {
    try {
      const repoPath = (process.env.TARGET_REPO_PATH || 'D:/core-platform').replace(/[/\\]$/, '');
      const kws = keywords(String(args.query || ''));
      const routePattern = /app\.(get|post|put|patch|delete)\s*\(\s*["'`]/i;

      let allFiles: string[] = [];
      {
        // Arg-array spawn (no shell) — avoids the injection/quoting hazards of a string command
        // and matches the safe git-invocation pattern used elsewhere (gitAgentService/localRepo).
        // git grep exits 1 when there are simply no matches; that is not an error.
        const res = spawnSync(
          'git',
          ['-C', repoPath, 'grep', '-rl', '-E', 'app\\.(get|post|put|patch|delete)', '--', '*.ts'],
          { encoding: 'utf8', timeout: 10000 },
        );
        if (res.error || (res.status !== 0 && res.status !== 1)) {
          return { error: `git grep failed: ${res.error?.message ?? res.stderr ?? `exit ${res.status}`}` };
        }
        allFiles = String(res.stdout || '').split('\n').filter((f) => f.trim());
      }

      const relevant = kws.length
        ? allFiles.filter((f) => kws.some((kw) => f.toLowerCase().includes(kw)))
        : allFiles;

      const results: Array<{ file: string; routes: string[] }> = [];
      let total = 0;

      for (const filePath of relevant.slice(0, 5)) {
        if (total >= 30) break;
        try {
          const content = fs.readFileSync(`${repoPath}/${filePath}`, 'utf8');
          const lines = content.split('\n');
          const routes: string[] = [];
          for (let i = 0; i < lines.length && total < 30; i++) {
            if (routePattern.test(lines[i])) {
              // Extract just the route path from the line
              const match = lines[i].match(/["'`](\/[^"'`]+)["'`]/);
              if (match) {
                routes.push(match[1]);
                total++;
              }
            }
          }
          if (routes.length) results.push({ file: filePath, routes });
        } catch { /* skip unreadable */ }
      }

      return { results, total_routes: total, searched_files: relevant.length };
    } catch (err: any) {
      return { error: err?.message ?? String(err) };
    }
  },
};

/* ─── Availability check + export ───────────────────────────────────────── */

export function corePlatformMetaConfigured(): boolean {
  return true;
}

export const corePlatformMetaTools: AgentTool[] = [
  listAppsTool,
  listObjectsTool,
  searchRelevantObjectsTool,
  getObjectFieldsTool,
  querySampleRecordsTool,
  countRecordsTool,
  createRecordTool,
  getApiRoutesTool,
];
