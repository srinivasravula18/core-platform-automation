/**
 * Deterministic API executor (Phase A). Native fetch only — no LLM. Enforces the write-safety gate:
 * mutating requests run ONLY when writeEnabled AND the environment is not production. Captures
 * status/headers/body/latency. Does NOT persist — the pipeline redacts before persistence.
 */
import type { ApiExecution, ApiScenario, ApiResponseCapture } from './types';
import { isMutating } from './planner';

export interface ExecuteOpts {
  baseUrl: string;
  token?: string; // held in memory only; never persisted (see redact + pipeline)
  environment: string;
  writeEnabled: boolean;
  timeoutMs?: number;
}

const PROD_RE = /prod|production|live/i;
export function isProduction(environment: string): boolean {
  return PROD_RE.test(String(environment || ''));
}

function buildUrl(baseUrl: string, path: string, query?: Record<string, unknown>): string {
  const origin = baseUrl.replace(/\/+$/, '');
  const rel = path.startsWith('/') ? path : `/${path}`;
  const url = new URL(`${origin}${rel}`);
  for (const [k, v] of Object.entries(query || {})) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  return url.toString();
}

function headersToObject(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((v, k) => { out[k] = v; });
  return out;
}

/** Execute one scenario. Returns an ApiExecution (unredacted, in-memory) for the pipeline to judge+redact. */
export async function executeScenario(scenario: ApiScenario, opts: ExecuteOpts): Promise<ApiExecution> {
  const started = Date.now();
  const base: ApiExecution = {
    scenarioId: scenario.id,
    endpointId: scenario.endpointId,
    request: scenario.request,
    response: null,
    latencyMs: 0,
    status: 'error',
  };

  // Write-safety gate.
  if (isMutating(scenario.request.method)) {
    if (!opts.writeEnabled) {
      return { ...base, status: 'skipped', latencyMs: 0, reason: 'Mutating request skipped: writes are disabled for this run.' };
    }
    if (isProduction(opts.environment)) {
      return { ...base, status: 'skipped', latencyMs: 0, reason: 'Mutating request blocked: target environment is production.' };
    }
  }

  const suppressAuth = scenario.request.headers?.['x-suppress-auth'] === '1';
  const headers: Record<string, string> = { accept: 'application/json', ...(scenario.request.headers || {}) };
  delete headers['x-suppress-auth'];
  if (opts.token && !suppressAuth && !headers.authorization && !headers.Authorization) {
    headers.authorization = `Bearer ${opts.token}`;
  }
  const hasBody = scenario.request.body !== undefined && scenario.request.method !== 'GET' && scenario.request.method !== 'HEAD';
  if (hasBody && !headers['content-type']) headers['content-type'] = 'application/json';

  try {
    const res = await fetch(buildUrl(opts.baseUrl, scenario.request.path, scenario.request.query), {
      method: scenario.request.method,
      headers,
      body: hasBody ? JSON.stringify(scenario.request.body ?? {}) : undefined,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15000),
    });
    const text = await res.text();
    let body: unknown = text;
    try { body = text ? JSON.parse(text) : null; } catch { /* keep raw text */ }
    const response: ApiResponseCapture = { status: res.status, headers: headersToObject(res.headers), body };
    const passed = scenario.expected.statusOneOf.includes(res.status);
    return {
      ...base,
      response,
      latencyMs: Date.now() - started,
      status: passed ? 'pass' : 'fail',
      reason: passed ? undefined : `Expected status in [${scenario.expected.statusOneOf.join(', ')}], got ${res.status}.`,
    };
  } catch (e: any) {
    return { ...base, latencyMs: Date.now() - started, status: 'error', reason: `Request error: ${e?.message || String(e)}` };
  }
}

export async function executeScenarios(scenarios: ApiScenario[], opts: ExecuteOpts): Promise<ApiExecution[]> {
  const out: ApiExecution[] = [];
  for (const s of scenarios) out.push(await executeScenario(s, opts)); // sequential: gentle on the target's rate limiter
  return out;
}
