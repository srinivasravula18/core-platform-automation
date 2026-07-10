/**
 * Deterministic API test planner (Phase A). Generates a standard scenario set from the contract —
 * no LLM. AI-enhanced planning (risk/dependency/rule-aware, flows) arrives in later phases where it
 * adds measurable value. One responsibility: contract → scenarios.
 */
import type { ApiEndpoint, ApiRequest, ApiScenario, HttpMethod, ScenarioKind } from './types';

const MUTATING: HttpMethod[] = ['POST', 'PUT', 'PATCH', 'DELETE'];
export function isMutating(method: HttpMethod): boolean {
  return MUTATING.includes(method);
}

let counter = 0;
function scenarioId(endpointId: string, kind: ScenarioKind): string {
  counter += 1;
  return `${endpointId.replace(/[^A-Za-z0-9]+/g, '_')}__${kind}__${counter}`;
}

/** Fill path template params (e.g. /users/{id}) with an example or a benign placeholder. */
function fillPath(endpoint: ApiEndpoint): string {
  return endpoint.path.replace(/\{([^}]+)\}/g, (_m, name) => {
    const p = endpoint.contract.request.params.find((x) => x.name === name && x.in === 'path');
    return encodeURIComponent(String(p?.example ?? '1'));
  });
}

function baseQuery(endpoint: ApiEndpoint): Record<string, unknown> {
  const q: Record<string, unknown> = {};
  for (const p of endpoint.contract.request.params) {
    if (p.in === 'query' && p.required) q[p.name] = p.example ?? 'test';
  }
  return q;
}

function baseRequest(endpoint: ApiEndpoint): ApiRequest {
  return {
    method: endpoint.method,
    path: fillPath(endpoint),
    query: baseQuery(endpoint),
    headers: {},
    body: endpoint.contract.request.bodySchema ? {} : undefined,
  };
}

/**
 * Produce scenarios for one endpoint:
 *  - positive: valid request → expect 2xx
 *  - contract: same request, assert the success response shape
 *  - authz:    if auth required → send with no auth → expect 401/403
 *  - negative: if there are required params/body → omit them → expect 4xx
 * Deterministic and side-effect free.
 */
export function planScenariosForEndpoint(endpoint: ApiEndpoint): ApiScenario[] {
  const out: ApiScenario[] = [];
  const mutating = isMutating(endpoint.method);
  const successCodes = Object.keys(endpoint.contract.responses)
    .map((c) => Number(c))
    .filter((c) => c >= 200 && c < 300);
  const okCodes = successCodes.length ? successCodes : [200, 201, 204];

  out.push({
    id: scenarioId(endpoint.id, 'positive'),
    endpointId: endpoint.id,
    kind: 'positive',
    title: `${endpoint.method} ${endpoint.path} — valid request returns success`,
    request: baseRequest(endpoint),
    expected: { statusOneOf: okCodes, note: 'Happy path' },
    mutating,
  });

  // NOTE: full response-schema conformance requires OpenAPI $ref dereferencing and lands in a later
  // phase. Phase A relies on status validation + regression (data-shape drift vs baseline), which is
  // reliable without deref. So no 'contract' scenario is emitted here.

  if (endpoint.contract.auth.required) {
    out.push({
      id: scenarioId(endpoint.id, 'authz'),
      endpointId: endpoint.id,
      kind: 'authz',
      title: `${endpoint.method} ${endpoint.path} — unauthenticated request is rejected`,
      request: { ...baseRequest(endpoint), headers: { 'x-suppress-auth': '1' } },
      expected: { statusOneOf: [401, 403], note: 'Authorization enforced' },
      mutating,
    });
  }

  const hasRequired = endpoint.contract.request.params.some((p) => p.required && p.in !== 'path') || !!endpoint.contract.request.bodySchema;
  if (hasRequired) {
    out.push({
      id: scenarioId(endpoint.id, 'negative'),
      endpointId: endpoint.id,
      kind: 'negative',
      title: `${endpoint.method} ${endpoint.path} — missing required input is rejected`,
      request: { method: endpoint.method, path: fillPath(endpoint), query: {}, headers: {}, body: undefined },
      expected: { statusOneOf: [400, 404, 409, 422], note: 'Input validation' },
      mutating,
    });
  }

  return out;
}

export function planScenarios(endpoints: ApiEndpoint[]): ApiScenario[] {
  return endpoints.flatMap(planScenariosForEndpoint);
}
