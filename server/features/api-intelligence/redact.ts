/**
 * Redaction boundary (spec §12) — MANDATORY and central.
 *
 * Nothing with credentials/PII is persisted or displayed unredacted. Every write to executions,
 * evidence, or the run blob passes through here first. Pure, deterministic, dependency-free.
 */

const REDACTED = '***REDACTED***';

/** Header names whose VALUE is always masked. */
const SENSITIVE_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-auth-token',
  'x-access-token',
  'api-key',
]);

/** Object keys whose value is masked anywhere in a body/query (case-insensitive substring/regex). */
const SENSITIVE_KEY_RE = /pass(word)?|secret|token|api[-_]?key|authorization|cookie|credential|private[-_]?key|ssn|client[-_]?secret/i;

export interface RedactPolicy {
  /** Extra key names (case-insensitive) to treat as sensitive, e.g. PII fields like 'email'. */
  extraKeys?: string[];
}

export function redactHeaders(headers: Record<string, string> | undefined, policy?: RedactPolicy): Record<string, string> {
  const out: Record<string, string> = {};
  const extra = (policy?.extraKeys || []).map((k) => k.toLowerCase());
  for (const [k, v] of Object.entries(headers || {})) {
    const low = k.toLowerCase();
    out[k] = SENSITIVE_HEADERS.has(low) || extra.includes(low) ? REDACTED : String(v);
  }
  return out;
}

/** Deep-clone a value, masking any property whose KEY looks sensitive. Arrays/objects handled; cycles guarded. */
export function redactValue(value: unknown, policy?: RedactPolicy, seen = new WeakSet<object>()): unknown {
  if (value == null || typeof value !== 'object') return value;
  if (seen.has(value as object)) return '[Circular]';
  seen.add(value as object);
  const extra = (policy?.extraKeys || []).map((k) => k.toLowerCase());
  const isSensitiveKey = (k: string) => SENSITIVE_KEY_RE.test(k) || extra.includes(k.toLowerCase());

  if (Array.isArray(value)) return value.map((v) => redactValue(v, policy, seen));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = isSensitiveKey(k) ? REDACTED : redactValue(v, policy, seen);
  }
  return out;
}

/** Redact a whole request (headers + query + body) — never mutates the input. */
export function redactRequest<T extends { headers?: Record<string, string>; query?: Record<string, unknown>; body?: unknown }>(
  req: T,
  policy?: RedactPolicy,
): T {
  return {
    ...req,
    headers: req.headers ? redactHeaders(req.headers, policy) : req.headers,
    query: req.query ? (redactValue(req.query, policy) as Record<string, unknown>) : req.query,
    body: req.body !== undefined ? redactValue(req.body, policy) : req.body,
  };
}

/** Redact a captured response (headers + body). */
export function redactResponse<T extends { headers?: Record<string, string>; body?: unknown } | null>(
  res: T,
  policy?: RedactPolicy,
): T {
  if (!res) return res;
  return {
    ...res,
    headers: (res as any).headers ? redactHeaders((res as any).headers, policy) : (res as any).headers,
    body: (res as any).body !== undefined ? redactValue((res as any).body, policy) : (res as any).body,
  };
}

export { REDACTED };
