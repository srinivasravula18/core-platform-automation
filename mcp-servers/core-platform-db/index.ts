import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { Pool } from 'pg';
import { execSync } from 'child_process';
import * as fs from 'fs';

/* ─── Config from env (with localhost fallbacks for local dev) ────────────── */

const CP_BASE_URL = (process.env.CORE_PLATFORM_BASE_URL || 'http://localhost:5001').replace(/\/$/, '');
const CP_USERNAME = process.env.CORE_PLATFORM_USERNAME || 'admin';
const CP_PASSWORD = process.env.CORE_PLATFORM_PASSWORD || 'admin';
const CP_REPO_PATH = (process.env.CORE_PLATFORM_REPO_PATH || 'D:/core-platform').replace(/[/\\]$/, '');

/* ─── DB pool ─────────────────────────────────────────────────────────────── */

const pool = new Pool({
  host: process.env.CORE_PLATFORM_DB_HOST || 'localhost',
  port: Number(process.env.CORE_PLATFORM_DB_PORT) || 5432,
  database: process.env.CORE_PLATFORM_DB_NAME || 'core-platform',
  user: process.env.CORE_PLATFORM_DB_USER || 'postgres',
  password: process.env.CORE_PLATFORM_DB_PASSWORD || 'test',
  ssl: process.env.CORE_PLATFORM_DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

/* ─── Auth token cache ────────────────────────────────────────────────────── */

let cachedToken: string | null = null;

async function getAuthToken(): Promise<string> {
  if (cachedToken) return cachedToken;
  const res = await fetch(`${CP_BASE_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: CP_USERNAME, password: CP_PASSWORD }),
  });
  const data = (await res.json()) as any;
  cachedToken = data.token || data.accessToken || data.access_token || '';
  return cachedToken as string;
}

/* ─── Stop words for keyword extraction ──────────────────────────────────── */

const STOP_WORDS = new Set(['the', 'and', 'for', 'to', 'of', 'a', 'an', 'in', 'is', 'are', 'how', 'what']);

function extractKeywords(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 0 && !STOP_WORDS.has(w))
    .slice(0, 5);
}

/* ─── Tool handlers ───────────────────────────────────────────────────────── */

async function handleListObjects(args: { app_name?: string }): Promise<any> {
  const client = await pool.connect();
  try {
    const result = await client.query(
      `SELECT o.id, o.api_name, o.label, o.id_prefix, o.table_name, a.api_name AS app
       FROM meta.object o
       JOIN meta.app a ON a.id = o.app_id
       WHERE ($1::text IS NULL OR a.api_name = $1)
       ORDER BY a.api_name, o.api_name`,
      [args.app_name ?? null],
    );
    return result.rows;
  } finally {
    client.release();
  }
}

async function handleGetObjectFields(args: { object_api_name: string }): Promise<any> {
  const client = await pool.connect();
  try {
    const result = await client.query(
      `SELECT f.id, f.api_name, f.label, f.type, f.required, f.searchable,
              ro.api_name AS reference_object
       FROM meta.field f
       JOIN meta.object o ON o.id = f.object_id
       LEFT JOIN meta.object ro ON ro.id = f.reference_object_id
       WHERE o.api_name = $1
       ORDER BY f.api_name`,
      [args.object_api_name],
    );
    return result.rows;
  } finally {
    client.release();
  }
}

async function handleQuerySampleRecords(args: { app_id: string; object_api_name: string; page_size?: number; filters?: object }): Promise<any> {
  const token = await getAuthToken();
  const pageSize = Math.min(Math.max(1, args.page_size ?? 5), 50);
  const body: Record<string, unknown> = { pagination: { page: 1, page_size: pageSize } };
  if (args.filters && typeof args.filters === 'object') body.filters = args.filters;
  const res = await fetch(`${CP_BASE_URL}/api/apps/${encodeURIComponent(args.app_id)}/objects/${encodeURIComponent(args.object_api_name)}/list-views/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const data = await res.json() as any;
  if (!res.ok) throw new Error(`query_records failed (${res.status}): ${data?.message ?? data?.detail ?? 'unknown'}`);
  return { object: args.object_api_name, records: data?.items ?? [], count: (data?.items ?? []).length, total_count: data?.total_count ?? null };
}

async function handleCountRecords(args: { app_id: string; object_api_name: string; filters?: object }): Promise<any> {
  const token = await getAuthToken();
  const body: Record<string, unknown> = { pagination: { page_size: 1 }, summary: { operations: ['count'] } };
  if (args.filters && typeof args.filters === 'object') body.filters = args.filters;
  const res = await fetch(`${CP_BASE_URL}/api/apps/${encodeURIComponent(args.app_id)}/objects/${encodeURIComponent(args.object_api_name)}/list-views/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const data = await res.json() as any;
  if (!res.ok) throw new Error(`count_records failed (${res.status}): ${data?.message ?? data?.detail ?? 'unknown'}`);
  return { object: args.object_api_name, count: data?.summary?.count ?? data?.total_count ?? null };
}

async function handleCreateRecord(args: { app_id: string; object_api_name: string; values: object }): Promise<any> {
  const token = await getAuthToken();
  const res = await fetch(`${CP_BASE_URL}/api/apps/${encodeURIComponent(args.app_id)}/objects/${encodeURIComponent(args.object_api_name)}/records`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(args.values),
  });
  const data = await res.json() as any;
  if (!res.ok) throw new Error(`create_record failed (${res.status}): ${data?.message ?? data?.detail ?? 'unknown'}`);
  return { ok: true, record: data };
}

async function handleCallApi(args: { method: string; path: string; body?: object }): Promise<any> {
  const doRequest = async (token: string) => {
    return fetch(`${CP_BASE_URL}${args.path}`, {
      method: args.method.toUpperCase(),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: args.body ? JSON.stringify(args.body) : undefined,
    });
  };

  let token = await getAuthToken();
  let res = await doRequest(token);

  if (res.status === 401) {
    cachedToken = null;
    token = await getAuthToken();
    res = await doRequest(token);
  }

  let body: any;
  try {
    body = await res.json();
  } catch {
    body = await res.text();
  }

  return { status: res.status, body };
}

async function handleSearchRelevantObjects(args: { query: string }): Promise<any> {
  const keywords = extractKeywords(args.query);
  if (!keywords.length) return [];

  const client = await pool.connect();
  try {
    const seen = new Map<string, any>();

    for (const keyword of keywords) {
      const param = '%' + keyword.toLowerCase() + '%';
      const result = await client.query(
        `SELECT DISTINCT o.id, o.api_name, o.label, o.table_name, a.api_name AS app,
                (SELECT count(*) FROM meta.field f2 WHERE f2.object_id = o.id) AS field_count
         FROM meta.object o
         JOIN meta.app a ON a.id = o.app_id
         LEFT JOIN meta.field f ON f.object_id = o.id
         WHERE lower(o.label) LIKE $1 OR lower(o.api_name) LIKE $1 OR lower(f.label) LIKE $1
         LIMIT 8`,
        [param],
      );
      for (const row of result.rows) {
        if (!seen.has(row.id)) {
          seen.set(row.id, row);
        }
      }
    }

    return Array.from(seen.values()).slice(0, 8);
  } finally {
    client.release();
  }
}

async function handleGetApiRoutes(args: { query: string }): Promise<any> {
  const keywords = extractKeywords(args.query);

  let allFiles: string[] = [];
  try {
    // core-platform uses app.get/post/put/patch/delete (Fastify), not express router
    const raw = execSync(`git -C "${CP_REPO_PATH}" grep -rl "app\\.get\\|app\\.post\\|app\\.put\\|app\\.patch\\|app\\.delete" -- "*.ts"`, { encoding: 'utf8' });
    allFiles = raw.split('\n').filter((f) => f.trim().length > 0);
  } catch (err: any) {
    return { error: `git grep failed: ${err.message}` };
  }

  const filtered =
    keywords.length > 0
      ? allFiles.filter((f) => keywords.some((kw) => f.toLowerCase().includes(kw)))
      : allFiles;

  const filesToRead = filtered.slice(0, 5);

  const routeLinePattern = /app\.(get|post|put|patch|delete)\s*\(\s*["'`]/i;
  const results: Array<{ file: string; routes: string[] }> = [];
  let totalRoutes = 0;

  for (const filePath of filesToRead) {
    if (totalRoutes >= 25) break;
    try {
      const fullPath = CP_REPO_PATH + '/' + filePath;
      const content = fs.readFileSync(fullPath, 'utf8');
      const lines = content.split('\n');
      const routes: string[] = [];

      for (let i = 0; i < lines.length; i++) {
        if (totalRoutes >= 25) break;
        if (routeLinePattern.test(lines[i])) {
          const match = lines[i].match(/["'`](\/[^"'`\n]+)["'`]/);
          if (match) {
            routes.push(match[1]);
            totalRoutes++;
          }
        }
      }

      if (routes.length > 0) {
        results.push({ file: filePath, routes });
      }
    } catch {
      // skip unreadable files
    }
  }

  return results;
}

/* ─── Tool dispatch ───────────────────────────────────────────────────────── */

async function handleTool(name: string, args: any): Promise<any> {
  try {
    switch (name) {
      case 'list_objects':
        return await handleListObjects(args ?? {});
      case 'get_object_fields':
        return await handleGetObjectFields(args);
      case 'query_sample_records':
        return await handleQuerySampleRecords(args);
      case 'count_records':
        return await handleCountRecords(args);
      case 'create_record':
        return await handleCreateRecord(args);
      case 'call_api':
        return await handleCallApi(args);
      case 'search_relevant_objects':
        return await handleSearchRelevantObjects(args);
      case 'get_api_routes':
        return await handleGetApiRoutes(args);
      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (err: any) {
    return { error: err?.message ?? String(err) };
  }
}

/* ─── Tool definitions ────────────────────────────────────────────────────── */

const TOOLS = [
  {
    name: 'list_objects',
    description: 'List all metadata objects (tables/models) in the core-platform database, optionally filtered by app.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        app_name: {
          type: 'string',
          description: 'Optional app api_name to filter objects by.',
        },
      },
    },
  },
  {
    name: 'get_object_fields',
    description: 'Get all fields for a given metadata object by its api_name.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        object_api_name: {
          type: 'string',
          description: 'The api_name of the metadata object.',
        },
      },
      required: ['object_api_name'],
    },
  },
  {
    name: 'query_sample_records',
    description: 'Fetch sample records from a Core Platform object using the access-enforced list-views query engine. Supports optional filters.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        app_id: { type: 'string', description: 'App UUID from list_objects or describe_app_schema.' },
        object_api_name: { type: 'string', description: 'The api_name of the object (e.g. "vendor", "account").' },
        page_size: { type: 'number', description: 'Max records to return (1–50, default 5).' },
        filters: { type: 'object', description: 'Optional filter tree: { logic: "AND"|"OR", filters: [{ field, op, value }] }.' },
      },
      required: ['app_id', 'object_api_name'],
    },
  },
  {
    name: 'count_records',
    description: 'Return the exact access-enforced count of records in a Core Platform object, with optional filters.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        app_id: { type: 'string', description: 'App UUID.' },
        object_api_name: { type: 'string', description: 'The api_name of the object.' },
        filters: { type: 'object', description: 'Optional filter tree.' },
      },
      required: ['app_id', 'object_api_name'],
    },
  },
  {
    name: 'create_record',
    description: 'Create a record in a Core Platform object. Subject to user permissions and field validations enforced by App Service.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        app_id: { type: 'string', description: 'App UUID.' },
        object_api_name: { type: 'string', description: 'The api_name of the object to create a record in.' },
        values: { type: 'object', description: 'Field api_name → value map for the new record.' },
      },
      required: ['app_id', 'object_api_name', 'values'],
    },
  },
  {
    name: 'call_api',
    description: 'Make an authenticated HTTP request to the configured core-platform service API (set via CORE_PLATFORM_BASE_URL env var).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        method: {
          type: 'string',
          description: 'HTTP method: GET, POST, PUT, PATCH, DELETE.',
        },
        path: {
          type: 'string',
          description: 'API path starting with / (e.g. /api/apps/__all_apps__/objects or /api/apps/:appId/objects/:object/describe).',
        },
        body: {
          type: 'object',
          description: 'Optional request body for POST/PUT/PATCH requests.',
        },
      },
      required: ['method', 'path'],
    },
  },
  {
    name: 'search_relevant_objects',
    description: 'Search for metadata objects relevant to a natural language query, matching on label, api_name, or field labels.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'Natural language query to search for relevant objects.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_api_routes',
    description: 'Find and extract API route definitions from the core-platform source code relevant to a query.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'Natural language query to find relevant routes for.',
        },
      },
      required: ['query'],
    },
  },
];

/* ─── Server setup ────────────────────────────────────────────────────────── */

const server = new Server(
  { name: 'core-platform-db', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  const result = await handleTool(name, args);
  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
  };
});

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(String(err) + '\n');
  process.exit(1);
});
