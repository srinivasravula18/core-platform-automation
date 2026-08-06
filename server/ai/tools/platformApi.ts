import type { ApiEndpoint } from '../../features/api-intelligence/types';
import { resolveAppApiOperations } from './apiContract';
import { cpFetch, getToken, resolveConnection } from './corePlatformMeta';
import type { AgentTool, ToolContext } from './types';

const FORBIDDEN = /(?:^|[\/_.-])(auth|login|logout|token|credential|secret|password|session|delete|remove|reset|deactivate|disable|archive|purge|destroy|revoke|terminate|recycle|trash|erase|wipe|drop|agent)(?:$|[\/_.-])/i;

export function isCallableOperation(operation: ApiEndpoint): boolean {
  return ['GET', 'POST', 'PUT', 'PATCH'].includes(operation.method)
    && !FORBIDDEN.test(`${operation.operationId || ''} ${operation.path}`);
}

export function buildOperationPath(
  operation: ApiEndpoint,
  pathParams: Record<string, unknown> = {},
  query: Record<string, unknown> = {},
): string {
  let path = operation.path;
  for (const param of operation.contract.request.params.filter((item) => item.in === 'path')) {
    const value = pathParams[param.name];
    if (param.required && (value === undefined || value === null || value === '')) {
      throw new Error(`Missing required path parameter "${param.name}".`);
    }
    path = path.replace(`{${param.name}}`, encodeURIComponent(String(value ?? '')));
  }
  if (/\{[^}]+\}/.test(path)) throw new Error('Not all OpenAPI path parameters were resolved.');

  const allowedQuery = new Map(operation.contract.request.params.filter((item) => item.in === 'query').map((item) => [item.name, item]));
  for (const param of allowedQuery.values()) {
    if (param.required && !(param.name in query)) throw new Error(`Missing required query parameter "${param.name}".`);
  }
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(query)) {
    if (!allowedQuery.has(name)) throw new Error(`Query parameter "${name}" is not declared by the OpenAPI operation.`);
    for (const item of Array.isArray(value) ? value : [value]) search.append(name, String(item));
  }
  return search.size ? `${path}?${search}` : path;
}

export function validateOperationBody(operation: ApiEndpoint, body: unknown): void {
  if (operation.method === 'GET') {
    if (body !== undefined && body !== null) throw new Error('GET operations do not accept a request body.');
    return;
  }
  const schema = operation.contract.request.bodySchema as any;
  if (!schema) throw new Error('Write operation is not callable because its OpenAPI contract declares no request body schema.');
  if (body === undefined || body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('The OpenAPI operation requires an object request body.');
  }
  if (Array.isArray(schema.required)) {
    for (const name of schema.required) {
      if (!(name in (body as Record<string, unknown>))) throw new Error(`Missing required body field "${name}".`);
    }
  }
}

export async function operationsFor(ctx: ToolContext): Promise<ApiEndpoint[]> {
  const connection = resolveConnection(ctx);
  if (!connection.baseUrl) throw new Error('No selected target application connection is available.');
  const token = await getToken(connection);
  return resolveAppApiOperations(connection.baseUrl, token);
}

const operationKey = (operation: ApiEndpoint) => operation.operationId || operation.id;

export function isMutationOperation(operation: ApiEndpoint): boolean {
  if (operation.method === 'GET') return false;
  return !/\b(query|search|count|preview|validate|describe|inspect|lookup|list)\b/i.test(`${operation.operationId || ''} ${operation.summary || ''} ${operation.path}`);
}

export const searchApiOperationsTool: AgentTool = {
  spec: {
    name: 'search_api_operations',
    description: 'Search callable operations from the selected target application\'s live OpenAPI contract. Use when no curated tool covers the requested operation.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'number' },
      },
      required: ['query'],
    },
  },
  capability: { effect: 'read', permissions: ['agent:read'] },
  async execute(args, ctx) {
    const terms: string[] = String(args.query || '').toLowerCase().match(/[a-z0-9_-]{2,}/g) || [];
    const limit = Math.max(1, Math.min(20, Number(args.limit || 10)));
    const matches = (await operationsFor(ctx))
      .filter(isCallableOperation)
      .map((operation) => {
        const text = `${operation.operationId || ''} ${operation.method} ${operation.path} ${operation.summary || ''} ${operation.tags.join(' ')}`.toLowerCase();
        return { operation, score: terms.reduce((sum, term) => sum + (text.includes(term) ? 1 : 0), 0) };
      })
      .filter((item) => !terms.length || item.score > 0)
      .sort((a, b) => b.score - a.score || a.operation.id.localeCompare(b.operation.id))
      .slice(0, limit)
      .map(({ operation }) => ({
        operation_id: operationKey(operation),
        method: operation.method,
        path: operation.path,
        summary: operation.summary || '',
        parameters: operation.contract.request.params,
        body_schema: operation.contract.request.bodySchema || null,
      }));
    return { operations: matches, count: matches.length };
  },
};

export const callPlatformApiTool: AgentTool = {
  spec: {
    name: 'call_platform_api',
    description: 'Execute a previously discovered, non-destructive operation from the selected target application\'s live OpenAPI contract.',
    parameters: {
      type: 'object',
      properties: {
        operation_id: { type: 'string' },
        path_params: { type: 'object' },
        query: { type: 'object' },
        body: { type: 'object' },
      },
      required: ['operation_id'],
    },
  },
  capability: { effect: 'write', permissions: ['agent:execute'] },
  async execute(args, ctx) {
    const key = String(args.operation_id || '').trim();
    const operations = await operationsFor(ctx);
    const matches = operations.filter((operation) => operation.id === key || operation.operationId === key);
    if (matches.length !== 1) throw new Error(matches.length ? 'operation_id is ambiguous; use the exact method/path id.' : 'operation_id was not found in the current OpenAPI contract.');
    const operation = matches[0];
    if (!isCallableOperation(operation)) throw new Error('This OpenAPI operation is blocked by the agent safety policy.');
    validateOperationBody(operation, args.body);
    const path = buildOperationPath(
      operation,
      args.path_params && typeof args.path_params === 'object' ? args.path_params as Record<string, unknown> : {},
      args.query && typeof args.query === 'object' ? args.query as Record<string, unknown> : {},
    );
    const response = await cpFetch(operation.method, path, args.body, ctx);
    const serialized = JSON.stringify(response);
    return serialized.length <= 20_000
      ? { ok: true, operation_id: key, response }
      : { ok: true, operation_id: key, truncated: true, response_preview: serialized.slice(0, 20_000) };
  },
};

export const platformApiTools: AgentTool[] = [searchApiOperationsTool, callPlatformApiTool];
