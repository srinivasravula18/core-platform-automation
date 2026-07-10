/**
 * API discovery (Phase A) — DETERMINISTIC. Prefer OpenAPI/Swagger, else Postman, else defer to source
 * scan (Phase B reuses corePlatformMeta/apiAnalyst). App-agnostic: no hardcoded endpoints.
 */
import { createHash } from 'crypto';
import type { ApiContract, ApiEndpoint, ApiParam, DiscoveryResult, HttpMethod } from './types';

const METHODS: HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

export function contractHash(contract: ApiContract): string {
  return createHash('sha1').update(JSON.stringify(contract)).digest('hex');
}

function endpointId(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`.replace(/\s+/g, ' ').trim();
}

/** Shallow $ref resolver: returns the referenced component name (for shape labelling), not a full deref. */
function refName(ref: string): string {
  return String(ref || '').split('/').pop() || 'object';
}

// ---------------------------------------------------------------- OpenAPI / Swagger
export function parseOpenApi(spec: any, baseUrl = ''): DiscoveryResult {
  const warnings: string[] = [];
  const endpoints: ApiEndpoint[] = [];
  if (!spec || typeof spec !== 'object' || !spec.paths) {
    return { source: 'openapi', endpoints: [], warnings: ['No `paths` object in the OpenAPI/Swagger document.'] };
  }
  const isV2 = typeof spec.swagger === 'string' && spec.swagger.startsWith('2');
  const globalSecurity = Array.isArray(spec.security) && spec.security.length > 0;
  const serverBase =
    baseUrl ||
    (Array.isArray(spec.servers) && spec.servers[0]?.url) ||
    (isV2 && spec.host ? `${(spec.schemes && spec.schemes[0]) || 'https'}://${spec.host}${spec.basePath || ''}` : '') ||
    '';

  for (const [path, pathItem] of Object.entries<any>(spec.paths)) {
    if (!pathItem || typeof pathItem !== 'object') continue;
    const pathParams: any[] = Array.isArray(pathItem.parameters) ? pathItem.parameters : [];
    for (const method of METHODS) {
      const op = pathItem[method.toLowerCase()];
      if (!op || typeof op !== 'object') continue;

      const params: ApiParam[] = [];
      const headers: ApiParam[] = [];
      for (const p of [...pathParams, ...(Array.isArray(op.parameters) ? op.parameters : [])]) {
        if (!p || !p.name) continue;
        const param: ApiParam = {
          name: p.name,
          in: p.in === 'header' ? 'header' : p.in === 'path' ? 'path' : 'query',
          required: Boolean(p.required) || p.in === 'path',
          type: p.schema?.type || p.type,
          example: p.example ?? p.schema?.example,
        };
        (param.in === 'header' ? headers : params).push(param);
      }

      // request body: OpenAPI 3 (requestBody.content) vs Swagger 2 (a body parameter)
      let bodySchema: unknown;
      if (op.requestBody?.content) {
        const json = op.requestBody.content['application/json'] || Object.values<any>(op.requestBody.content)[0];
        bodySchema = json?.schema?.$ref ? { $ref: refName(json.schema.$ref) } : json?.schema;
      } else if (isV2) {
        const bodyParam = (Array.isArray(op.parameters) ? op.parameters : []).find((p: any) => p?.in === 'body');
        if (bodyParam) bodySchema = bodyParam.schema?.$ref ? { $ref: refName(bodyParam.schema.$ref) } : bodyParam.schema;
      }

      const responses: ApiContract['responses'] = {};
      for (const [code, resp] of Object.entries<any>(op.responses || {})) {
        const schema = isV2
          ? resp?.schema
          : resp?.content?.['application/json']?.schema || Object.values<any>(resp?.content || {})[0]?.schema;
        responses[code] = { schema: schema?.$ref ? { $ref: refName(schema.$ref) } : schema, description: resp?.description };
      }

      // Operation-level `security` overrides the global one (an empty array means "no auth for this op").
      const authRequired = Array.isArray(op.security) ? op.security.length > 0 : globalSecurity;
      const contract: ApiContract = {
        request: { params, headers, bodySchema },
        responses,
        auth: { required: Boolean(authRequired), scheme: authRequired ? 'inherited' : undefined },
      };
      endpoints.push({
        id: endpointId(method, path),
        method,
        path,
        operationId: op.operationId,
        summary: op.summary || op.description || '',
        tags: Array.isArray(op.tags) ? op.tags : [],
        baseUrl: serverBase,
        contract,
        contractHash: contractHash(contract),
        source: 'openapi',
      });
    }
  }
  if (!endpoints.length) warnings.push('OpenAPI document had paths but no operations were extracted.');
  return { source: 'openapi', endpoints, warnings };
}

// ---------------------------------------------------------------- Postman v2.x collection
export function parsePostman(collection: any, baseUrl = ''): DiscoveryResult {
  const warnings: string[] = [];
  const endpoints: ApiEndpoint[] = [];
  if (!collection || !Array.isArray(collection.item)) {
    return { source: 'postman', endpoints: [], warnings: ['Not a recognizable Postman v2 collection (no `item` array).'] };
  }

  const walk = (items: any[]) => {
    for (const it of items) {
      if (Array.isArray(it?.item)) { walk(it.item); continue; } // folder
      const req = it?.request;
      if (!req) continue;
      const method = String(req.method || 'GET').toUpperCase() as HttpMethod;
      const url = req.url || {};
      const rawPath = typeof url === 'string' ? url : `/${(url.path || []).join('/')}`;
      const path = rawPath.replace(/^https?:\/\/[^/]+/i, '') || '/';
      const headers: ApiParam[] = (Array.isArray(req.header) ? req.header : []).map((h: any) => ({
        name: h.key, in: 'header' as const, required: false, example: h.value,
      }));
      const params: ApiParam[] = (Array.isArray(url.query) ? url.query : []).map((q: any) => ({
        name: q.key, in: 'query' as const, required: false, example: q.value,
      }));
      let bodySchema: unknown;
      if (req.body?.mode === 'raw' && req.body.raw) {
        try { bodySchema = JSON.parse(req.body.raw); } catch { bodySchema = { raw: String(req.body.raw).slice(0, 500) }; }
      }
      const authRequired = Boolean(req.auth) || headers.some((h) => h.name?.toLowerCase() === 'authorization');
      const contract: ApiContract = {
        request: { params, headers, bodySchema },
        responses: {},
        auth: { required: authRequired, scheme: req.auth?.type },
      };
      endpoints.push({
        id: endpointId(method, path),
        method,
        path,
        summary: it.name || '',
        tags: [],
        baseUrl: baseUrl || (typeof url === 'object' && Array.isArray(url.host) ? url.host.join('.') : ''),
        contract,
        contractHash: contractHash(contract),
        source: 'postman',
      });
    }
  };
  walk(collection.item);
  if (!endpoints.length) warnings.push('Postman collection had no requests.');
  return { source: 'postman', endpoints, warnings };
}

// ---------------------------------------------------------------- live OpenAPI fetch (probe standard paths)
const OPENAPI_PATHS = ['/openapi.json', '/swagger.json', '/v3/api-docs', '/api-docs', '/swagger/v1/swagger.json', '/api/openapi.json'];

export async function fetchOpenApiSpec(baseUrl: string, token?: string, timeoutMs = 8000): Promise<any | null> {
  const origin = (() => { try { return new URL(baseUrl).origin; } catch { return baseUrl.replace(/\/+$/, ''); } })();
  const headers: Record<string, string> = { accept: 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  for (const p of OPENAPI_PATHS) {
    try {
      const res = await fetch(`${origin}${p}`, { headers, signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) continue;
      const json = await res.json().catch(() => null);
      if (json && (json.paths || json.swagger || json.openapi)) return json;
    } catch { /* try next path */ }
  }
  return null;
}

/**
 * Discover endpoints for a target. Precedence: explicit spec/collection → live OpenAPI fetch → none
 * (Phase B fills the source-scan fallback). Never throws for normal inputs.
 */
export async function discoverApis(opts: {
  baseUrl?: string;
  token?: string;
  openapiSpec?: any;
  postman?: any;
  fetchLive?: boolean;
}): Promise<DiscoveryResult> {
  const baseUrl = opts.baseUrl || '';
  if (opts.openapiSpec) return parseOpenApi(opts.openapiSpec, baseUrl);
  if (opts.postman) return parsePostman(opts.postman, baseUrl);
  if (opts.fetchLive !== false && baseUrl) {
    const spec = await fetchOpenApiSpec(baseUrl, opts.token).catch(() => null);
    if (spec) return parseOpenApi(spec, baseUrl);
  }
  return { source: 'none', endpoints: [], warnings: ['No OpenAPI/Postman source found; source-scan discovery arrives in Phase B.'] };
}
