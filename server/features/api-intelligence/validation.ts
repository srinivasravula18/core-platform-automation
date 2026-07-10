/**
 * Deterministic validation + regression (Phase A). Structural expected-vs-actual (status, response
 * shape, types, unexpected nulls) and diffing against a stored baseline. No LLM — semantic/business-rule
 * validation (AI) arrives in Phase C. Pure functions, independently testable.
 */
import type { ApiBaseline, ApiEndpoint, ApiExecution, ApiFinding, ApiScenario } from './types';

/** Structural signature of a JSON value: primitive → its type; array → ['array', elemShape]; object → keyed shape. */
export function shapeOf(value: unknown): unknown {
  if (value === null) return 'null';
  if (Array.isArray(value)) return ['array', value.length ? shapeOf(value[0]) : 'empty'];
  const t = typeof value;
  if (t !== 'object') return t; // string|number|boolean|undefined
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = shapeOf(v);
  return out;
}

/** Compare two structural shapes → human-readable difference list (missing/extra/type-changed). */
export function diffShape(expected: unknown, actual: unknown, path = '$'): string[] {
  const diffs: string[] = [];
  const isObj = (x: unknown) => x && typeof x === 'object' && !Array.isArray(x);
  if (isObj(expected) && isObj(actual)) {
    const e = expected as Record<string, unknown>;
    const a = actual as Record<string, unknown>;
    for (const k of Object.keys(e)) {
      if (!(k in a)) diffs.push(`missing field ${path}.${k}`);
      else diffs.push(...diffShape(e[k], a[k], `${path}.${k}`));
    }
    for (const k of Object.keys(a)) if (!(k in e)) diffs.push(`unexpected field ${path}.${k}`);
  } else if (Array.isArray(expected) && Array.isArray(actual)) {
    if (expected[0] !== 'empty' && actual[1] !== 'empty') diffs.push(...diffShape(expected[1], actual[1], `${path}[]`));
  } else if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    diffs.push(`type changed at ${path}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
  return diffs;
}

/** Find keys whose value is unexpectedly null in the response body (top two levels). */
function unexpectedNulls(body: unknown, path = '$'): string[] {
  const out: string[] = [];
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
      if (v === null) out.push(`${path}.${k} is null`);
    }
  }
  return out;
}

/** Validate one execution against its scenario expectation. Returns structured findings (may be empty). */
export function validateExecution(scenario: ApiScenario, execution: ApiExecution): ApiFinding[] {
  const findings: ApiFinding[] = [];
  const mk = (kind: string, severity: ApiFinding['severity'], message: string): ApiFinding => ({
    scenarioId: scenario.id, endpointId: scenario.endpointId, kind, severity, message,
  });

  if (execution.status === 'skipped') {
    findings.push(mk('skipped', 'info', execution.reason || 'Scenario skipped.'));
    return findings;
  }
  if (execution.status === 'error' || !execution.response) {
    findings.push(mk('transport', 'error', execution.reason || 'Request failed before a response was received.'));
    return findings;
  }

  const { status } = execution.response;
  if (!scenario.expected.statusOneOf.includes(status)) {
    findings.push(mk('status', 'error', `Expected status in [${scenario.expected.statusOneOf.join(', ')}], got ${status}.`));
  }
  if (scenario.expected.responseShape && status >= 200 && status < 300) {
    const diffs = diffShape(shapeOf(scenario.expected.responseShape), shapeOf(execution.response.body));
    for (const d of diffs) findings.push(mk('contract', 'warn', d));
  }
  for (const n of unexpectedNulls(execution.response.body)) findings.push(mk('null', 'warn', n));
  return findings;
}

// ------------------------------------------------------------------ regression baselines
export function baselineKey(endpoint: ApiEndpoint): string {
  return `${endpoint.method} ${endpoint.path}`;
}

/** Build a baseline from a passing positive execution — stores the SHAPE, never the raw body. */
export function makeBaseline(endpoint: ApiEndpoint, execution: ApiExecution, environment: string): ApiBaseline {
  return {
    key: baselineKey(endpoint),
    environment,
    contractHash: endpoint.contractHash,
    responseShape: execution.response ? shapeOf(execution.response.body) : null,
    capturedAt: new Date().toISOString(),
  };
}

/** Diff a fresh execution against a stored baseline. Returns 'regression' findings (contract/shape drift). */
export function regressionDiff(
  baseline: ApiBaseline,
  endpoint: ApiEndpoint,
  scenario: ApiScenario,
  execution: ApiExecution,
): ApiFinding[] {
  const findings: ApiFinding[] = [];
  const mk = (severity: ApiFinding['severity'], message: string): ApiFinding => ({
    scenarioId: scenario.id, endpointId: endpoint.id, kind: 'regression', severity, message,
  });
  if (baseline.contractHash && baseline.contractHash !== endpoint.contractHash) {
    findings.push(mk('warn', 'Contract changed since the last baseline (contract hash differs).'));
  }
  if (execution.response && baseline.responseShape) {
    for (const d of diffShape(baseline.responseShape, shapeOf(execution.response.body))) {
      findings.push(mk('warn', `Response drift vs baseline: ${d}`));
    }
  }
  return findings;
}
