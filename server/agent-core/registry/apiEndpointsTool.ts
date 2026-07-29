/**
 * list_api_endpoints — the RC-3 orphan wire.
 *
 * The deterministic OpenAPI/Swagger parser (`api-intelligence/discovery.parseOpenApi`) was built and
 * tested but never reachable from the agent loop, so the agent guessed endpoints instead of reading the
 * real spec. This exposes it as a first-class `AgentTool`: given an inline spec (or a spec URL to fetch),
 * it returns the real, contract-grounded endpoint list an agent can build API steps from.
 *
 * App-agnostic: no endpoints/paths are hardcoded — everything comes from the provided spec. Safe by
 * construction: this only READS/PARSES a spec, it never calls a live endpoint (that would be a separate,
 * mutation-capable tool). Best-effort fetch: a failed/absent spec returns a typed error, never a guess.
 */
import { parseOpenApi } from '../../features/api-intelligence/discovery';
import type { AgentTool, ToolContext } from '../../ai/tools/types';

interface ListApiEndpointsArgs {
  /** Inline OpenAPI/Swagger document (object or JSON string). */
  spec?: unknown;
  /** URL to GET the spec from when no inline spec is supplied. */
  specUrl?: string;
  /** Server base URL override (else taken from the spec's servers/host). */
  baseUrl?: string;
  /** Case-insensitive substring filter over "METHOD path summary". */
  filter?: string;
  /** Cap the number of endpoints returned (default 60). */
  limit?: number;
}

async function loadSpec(args: ListApiEndpointsArgs): Promise<{ spec: any; warning?: string }> {
  if (args.spec != null) {
    if (typeof args.spec === 'string') {
      try { return { spec: JSON.parse(args.spec) }; }
      catch { return { spec: null, warning: 'Inline spec string was not valid JSON.' }; }
    }
    return { spec: args.spec };
  }
  if (args.specUrl) {
    try {
      const res = await fetch(args.specUrl, { headers: { accept: 'application/json' } });
      if (!res.ok) return { spec: null, warning: `Spec fetch returned HTTP ${res.status}.` };
      return { spec: await res.json() };
    } catch (err) {
      return { spec: null, warning: `Spec fetch failed: ${(err as Error)?.message || 'unknown error'}.` };
    }
  }
  return { spec: null, warning: 'Provide either `spec` (inline OpenAPI/Swagger) or `specUrl`.' };
}

export const apiEndpointsTool: AgentTool = {
  spec: {
    name: 'list_api_endpoints',
    description:
      'Parse an OpenAPI/Swagger spec and list its real endpoints (method, path, summary, required params, auth). ' +
      'Use this to ground API test steps in the ACTUAL contract instead of guessing endpoints. ' +
      'Supply `spec` (inline) or `specUrl` (to fetch). Read-only — it never calls a live endpoint.',
    parameters: {
      type: 'object',
      properties: {
        spec: { type: 'object', description: 'Inline OpenAPI/Swagger document.' },
        specUrl: { type: 'string', description: 'URL to fetch the spec from when no inline spec is given.' },
        baseUrl: { type: 'string', description: 'Server base URL override.' },
        filter: { type: 'string', description: 'Case-insensitive substring filter over "METHOD path summary".' },
        limit: { type: 'number', description: 'Max endpoints to return (default 60).' },
      },
    },
  },
  async execute(rawArgs: Record<string, unknown>, _ctx: ToolContext) {
    const args = (rawArgs || {}) as ListApiEndpointsArgs;
    const { spec, warning } = await loadSpec(args);
    if (!spec) return { error: warning || 'No spec available to parse.', endpoints: [] };

    const result = parseOpenApi(spec, String(args.baseUrl || ''));
    const filter = String(args.filter || '').toLowerCase().trim();
    const limit = Number.isFinite(args.limit) && (args.limit as number) > 0 ? Number(args.limit) : 60;

    let endpoints = result.endpoints.map((e) => ({
      id: e.id,
      method: e.method,
      path: e.path,
      summary: e.summary || e.operationId || '',
      auth: e.contract.auth.required,
      requiredParams: [...e.contract.request.params, ...e.contract.request.headers]
        .filter((p) => p.required)
        .map((p) => `${p.name}(${p.in})`),
      hasBody: e.contract.request.bodySchema != null,
    }));
    if (filter) endpoints = endpoints.filter((e) => `${e.method} ${e.path} ${e.summary}`.toLowerCase().includes(filter));

    return {
      source: result.source,
      total: result.endpoints.length,
      returned: Math.min(endpoints.length, limit),
      endpoints: endpoints.slice(0, limit),
      warnings: result.warnings,
    };
  },
};
