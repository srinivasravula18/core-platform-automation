import fs from "fs";

export type RunSummary = {
  requests: number | null;
  iterations: number | null;
  maxVus: number | null;
  errorRatePct: number | null;
  failedRequests: number | null;
  p50Ms: number | null;
  p90Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
  avgMs: number | null;
  maxMs: number | null;
  throughputRps: number | null;
  checksPassedPct: number | null;
  buckets: Record<string, number>;
  perOperation: { op: string; count: number; avgMs: number | null; p95Ms: number | null }[];
  security?: SecuritySummary;
};

export type SecuritySummary = {
  scanner: string;
  mode: "baseline" | "active";
  target: string;
  generatedAt: string;
  counts: { high: number; medium: number; low: number; informational: number };
  total: number;
  truncated: boolean;
  findings: { name: string; risk: string; confidence: string; url: string; instances: number; cweId: string | null; solution: string }[];
  teams?: unknown;
};

const EMPTY: RunSummary = {
  requests: null,
  iterations: null,
  maxVus: null,
  errorRatePct: null,
  failedRequests: null,
  p50Ms: null,
  p90Ms: null,
  p95Ms: null,
  p99Ms: null,
  avgMs: null,
  maxMs: null,
  throughputRps: null,
  checksPassedPct: null,
  buckets: {},
  perOperation: []
};

type MetricStats = Record<string, number>;
type K6Metric = MetricStats & { values?: MetricStats };

const numberOrNull = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

// k6 v2 writes the statistics directly on each metric; k6 v0.x nested them
// under `values`. Accept both so an older binary still parses.
const stats = (metric: K6Metric | undefined): MetricStats =>
  (metric?.values as MetricStats | undefined) ?? (metric as MetricStats | undefined) ?? {};

/** Parses `k6 run --summary-export` output into the shape the UI charts. */
export const summarizeK6 = (summaryPath: string | null): RunSummary => {
  if (!summaryPath || !fs.existsSync(summaryPath)) return { ...EMPTY };
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(fs.readFileSync(summaryPath, "utf8")) as Record<string, unknown>;
  } catch {
    return { ...EMPTY };
  }

  if (parsed.security) return { ...EMPTY, security: parsed.security as SecuritySummary };

  const metrics = (parsed.metrics ?? parsed) as Record<string, K6Metric>;
  const duration = stats(metrics.http_req_duration);
  const failed = stats(metrics.http_req_failed);
  const reqs = stats(metrics.http_reqs);
  const iterations = stats(metrics.iterations);
  const vus = stats(metrics.vus_max ?? metrics.vus);
  const checks = stats(metrics.checks);

  const buckets: Record<string, number> = {};
  for (const [name, metric] of Object.entries(metrics)) {
    if (name.startsWith("resp_")) buckets[name] = numberOrNull(stats(metric).count) ?? 0;
  }

  // A Rate metric reports its ratio as `value` in v2 and `rate` in v0.x.
  const failureRate = numberOrNull(failed.rate) ?? numberOrNull(failed.value);
  const checkRate = numberOrNull(checks.rate) ?? numberOrNull(checks.value);

  const perOperation: RunSummary["perOperation"] = [];
  const opDuration = stats(metrics.op_duration);
  if (Object.keys(opDuration).length > 0) {
    perOperation.push({
      op: "all operations",
      count: numberOrNull(opDuration.count) ?? 0,
      avgMs: numberOrNull(opDuration.avg),
      p95Ms: numberOrNull(opDuration["p(95)"])
    });
  }

  return {
    requests: numberOrNull(reqs.count),
    iterations: numberOrNull(iterations.count),
    maxVus: numberOrNull(vus.max) ?? numberOrNull(vus.value),
    errorRatePct: failureRate === null ? null : failureRate * 100,
    // On a Rate metric, `passes` is the count of requests that met the
    // condition — for http_req_failed that is the failed requests.
    failedRequests: numberOrNull(failed.passes),
    p50Ms: numberOrNull(duration.med),
    p90Ms: numberOrNull(duration["p(90)"]),
    p95Ms: numberOrNull(duration["p(95)"]),
    p99Ms: numberOrNull(duration["p(99)"]),
    avgMs: numberOrNull(duration.avg),
    maxMs: numberOrNull(duration.max),
    throughputRps: numberOrNull(reqs.rate),
    checksPassedPct: checkRate === null ? null : checkRate * 100,
    buckets,
    perOperation
  };
};
