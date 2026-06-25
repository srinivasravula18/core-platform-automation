/**
 * Core Platform META tools — available to EVERY agent model (OpenAI, Claude API,
 * Codex subscription, or any future provider). These are native AgentTool entries in
 * the tool-calling loop, NOT MCP-only.
 *
 * Actual API routes (verified from core-platform source):
 *   GET /api/apps/__all_apps__/objects                           → { items: [...] }
 *   GET /api/apps/:appId/objects/:object/describe               → { object:{}, fields:[] }
 *   GET /api/apps/__all_apps__/objects/:object/records?page_size=N  → { items:[], page, page_size }
 *   POST /api/auth/login                                         → { access_token }
 *
 * Connection resolution (multi-tenant):
 *   1. ctx.appId → Websites table (per-workspace baseUrl + credentials)
 *   2. CORE_PLATFORM_* env vars   (single-tenant / local dev)
 *   3. http://localhost:5001       (last resort — local dev fallback)
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import type { AgentTool, ToolContext } from './types';
import { resolveCredentials, getWebsite } from '../../features/credentials/credentialsService';

/* ─── Connection helpers ─────────────────────────────────────────────────── */

interface AppConn { baseUrl: string; username: string; password: string }

/** Per-call token cache keyed by baseUrl so multiple workspaces don't share a token. */
const tokenCache = new Map<string, string>();

function resolveConnection(ctx?: ToolContext): AppConn {
  // 1. ctx.appId → Websites table (per-workspace)
  if (ctx?.appId) {
    const cred = resolveCredentials({
      websiteId: String(ctx.appId),
      role: 'admin',
      ownerId: ctx.userId ? String(ctx.userId) : undefined,
    });
    if (cred?.baseUrl && cred?.username && cred?.password) {
      return { baseUrl: cred.baseUrl.replace(/\/$/, ''), username: cred.username, password: cred.password };
    }
    const site = getWebsite(String(ctx.appId));
    if (site?.baseUrl) {
      return {
        baseUrl: site.baseUrl.replace(/\/$/, ''),
        username: process.env.TARGET_USERNAME || 'admin',
        password: process.env.TARGET_PASSWORD || 'admin',
      };
    }
  }
  // 2. env vars
  return {
    baseUrl: (process.env.TARGET_BASE_URL || 'http://localhost:5001').replace(/\/$/, ''),
    username: process.env.TARGET_USERNAME || 'admin',
    password: process.env.TARGET_PASSWORD || 'admin',
  };
}

async function getToken(conn: AppConn, forceRefresh = false): Promise<string> {
  const staticToken = String(process.env.TARGET_TOKEN || '').trim();
  if (staticToken) return staticToken;

  const cached = tokenCache.get(conn.baseUrl);
  if (cached && !forceRefresh) return cached;

  const res = await fetch(`${conn.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: conn.username, password: conn.password }),
  });
  const json = (await res.json().catch(() => null)) as any;
  const token: string = json?.access_token || json?.token || json?.accessToken || '';
  if (!res.ok || !token) throw new Error(`Core Platform login failed (${res.status})`);
  tokenCache.set(conn.baseUrl, token);
  return token;
}

async function cpFetch(method: string, path: string, body: unknown, ctx?: ToolContext): Promise<unknown> {
  const conn = resolveConnection(ctx);
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
    tokenCache.delete(conn.baseUrl);
    token = await getToken(conn, true);
    res = await call(token);
  }
  const text = await res.text();
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try { const d = JSON.parse(text); detail = d?.message ?? d?.detail ?? detail; } catch { /* keep default */ }
    throw new Error(`Core Platform ${method} ${path} failed (${res.status}): ${detail}`);
  }
  try { return text ? JSON.parse(text) : null; } catch { return text; }
}

const cpRequest = (method: string, path: string, ctx?: ToolContext) => cpFetch(method, path, undefined, ctx);
const cpRequestPost = (path: string, body: unknown, ctx?: ToolContext) => cpFetch('POST', path, body, ctx);

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
    description: 'Find Core Platform metadata objects (tables/models) relevant to a natural language query. Returns object api_name, label, table_name, app_prefix, and app_id. Always call this first to discover which objects are relevant to a feature before calling get_object_fields.',
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

      // GET /api/apps/__all_apps__/objects → { items: [...] }
      const data = (await cpRequest('GET', '/api/apps/__all_apps__/objects', ctx)) as any;
      const allObjects: any[] = Array.isArray(data?.items) ? data.items : (Array.isArray(data) ? data : []);

      if (!allObjects.length) return { note: 'no objects found — check Core Platform connection', objects: [] };

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

      return { objects: scored, count: scored.length };
    } catch (err: any) {
      return { error: err?.message ?? String(err) };
    }
  },
};

/* ─── Tool: get_object_fields ────────────────────────────────────────────── */

export const getObjectFieldsTool: AgentTool = {
  spec: {
    name: 'get_object_fields',
    description: 'Get all fields (api_name, type, label, required, searchable, reference_object_id) for a Core Platform object. Requires the object api_name AND the app_id (UUID) from search_relevant_objects. Returns the full field list including relationships.',
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

      // GET /api/apps/:appId/objects/:object/describe → { object:{}, fields:[] }
      const data = (await cpRequest('GET', `/api/apps/${encodeURIComponent(appId)}/objects/${encodeURIComponent(apiName)}/describe`, ctx)) as any;
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

      return {
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
      };
    } catch (err: any) {
      return { error: err?.message ?? String(err) };
    }
  },
};

/* ─── Tool: query_sample_records ─────────────────────────────────────────── */

export const querySampleRecordsTool: AgentTool = {
  spec: {
    name: 'query_sample_records',
    description: 'Fetch a small sample of real records from a Core Platform object using the list-views query engine (access-enforced). Supports optional filters. Use object api_name (e.g. "vendor") from search_relevant_objects.',
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
      const appId = String(args.app_id || '').trim();
      const apiName = String(args.object_api_name || '').trim();
      if (!appId) return { error: 'app_id is required — get it from search_relevant_objects' };
      if (!apiName) return { error: 'object_api_name is required' };
      const pageSize = Math.min(Math.max(1, Number(args.page_size ?? 5)), 50);

      const body: Record<string, unknown> = {
        pagination: { page: 1, page_size: pageSize },
      };
      if (args.filters && typeof args.filters === 'object') body.filters = args.filters;

      const data = (await cpRequestPost(`/api/apps/${encodeURIComponent(appId)}/objects/${encodeURIComponent(apiName)}/list-views/query`, body, ctx)) as any;
      const records: any[] = Array.isArray(data?.items) ? data.items : [];
      return { object: apiName, records, count: records.length, total_count: data?.total_count ?? null };
    } catch (err: any) {
      return { error: err?.message ?? String(err) };
    }
  },
};

/* ─── Tool: count_records ────────────────────────────────────────────────── */

export const countRecordsTool: AgentTool = {
  spec: {
    name: 'count_records',
    description: 'Return the exact access-enforced count of records in a Core Platform object, with optional filters. Use for "how many X exist" questions before writing data population requirements.',
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
      const appId = String(args.app_id || '').trim();
      const apiName = String(args.object_api_name || '').trim();
      if (!appId) return { error: 'app_id is required' };
      if (!apiName) return { error: 'object_api_name is required' };

      const body: Record<string, unknown> = {
        pagination: { page_size: 1 },
        summary: { operations: ['count'] },
      };
      if (args.filters && typeof args.filters === 'object') body.filters = args.filters;

      const data = (await cpRequestPost(`/api/apps/${encodeURIComponent(appId)}/objects/${encodeURIComponent(apiName)}/list-views/query`, body, ctx)) as any;
      const count = data?.summary?.count ?? data?.total_count ?? null;
      return { object: apiName, count };
    } catch (err: any) {
      return { error: err?.message ?? String(err) };
    }
  },
};

/* ─── Tool: create_record ────────────────────────────────────────────────── */

export const createRecordTool: AgentTool = {
  spec: {
    name: 'create_record',
    description: 'Create a record in a Core Platform object. Subject to user create permissions, field rules, and validations enforced by App Service. Use for populating test data during requirement or test case analysis.',
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
      const appId = String(args.app_id || '').trim();
      const apiName = String(args.object_api_name || '').trim();
      if (!appId) return { error: 'app_id is required' };
      if (!apiName) return { error: 'object_api_name is required' };
      if (!args.values || typeof args.values !== 'object') return { error: 'values must be an object of field api_name → value' };

      const data = await cpRequestPost(
        `/api/apps/${encodeURIComponent(appId)}/objects/${encodeURIComponent(apiName)}/records`,
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
    description: 'Search the Core Platform source code for HTTP route definitions relevant to a query. Returns route paths with their source file paths. Use to discover what API endpoints exist for a feature.',
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
      try {
        const raw = execSync(`git -C "${repoPath}" grep -rl "app\\.get\|app\\.post\|app\\.put\|app\\.patch\|app\\.delete" -- "*.ts"`, { encoding: 'utf8', timeout: 10000 });
        allFiles = raw.split('\n').filter((f) => f.trim());
      } catch (err: any) {
        return { error: `git grep failed: ${err?.message ?? String(err)}` };
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
  searchRelevantObjectsTool,
  getObjectFieldsTool,
  querySampleRecordsTool,
  countRecordsTool,
  createRecordTool,
  getApiRoutesTool,
];
