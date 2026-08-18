/** Sampled transactions, their spans, and the browser-side slow-load log beside them. */

import { z } from 'zod';
import { vitalsQuery } from './db';
import { resolveRange } from './timerange';

export const traceListSchema = z.object({
  from: z.string().max(64).optional(),
  to: z.string().max(64).optional(),
  route: z.string().max(300).optional(),
  status: z.enum(['ok', 'error', 'all']).default('all'),
  minDurationMs: z.coerce.number().min(0).max(600_000).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const listTransactions = async (from?: string, to?: string) => {
  const range = resolveRange(from, to);
  const rows = await vitalsQuery<{
    route: string;
    samples: string;
    p50: string;
    p95: string;
    p99: string;
    max: string;
    errors: string;
  }>(
    `select coalesce(route, '(unknown)') as route,
            count(*)::text as samples,
            percentile_disc(0.5) within group (order by duration_ms)::text as p50,
            percentile_disc(0.95) within group (order by duration_ms)::text as p95,
            percentile_disc(0.99) within group (order by duration_ms)::text as p99,
            max(duration_ms)::text as max,
            count(*) filter (where status = 'error')::text as errors
       from obs.trace
      where started_at between $1 and $2
      group by 1
      order by percentile_disc(0.95) within group (order by duration_ms) desc nulls last
      limit 50`,
    [new Date(range.fromMs), new Date(range.toMs)],
  );
  return {
    transactions: rows.map((row) => ({
      route: row.route,
      samples: Number(row.samples),
      p50: Number(row.p50),
      p95: Number(row.p95),
      p99: Number(row.p99),
      max: Number(row.max),
      errors: Number(row.errors),
    })),
  };
};

export const listTraces = async (input: z.infer<typeof traceListSchema>) => {
  const range = resolveRange(input.from, input.to);
  const rows = await vitalsQuery(
    `select trace_id, root_name, route, method, status_code, status, started_at,
            duration_ms, user_id, sampled_reason, span_count, db_time_ms
       from obs.trace
      where started_at between $1 and $2
        and ($3 = '' or route = $3)
        and ($4 = 'all' or status = $4)
        and duration_ms >= $5
      order by duration_ms desc
      limit $6`,
    [new Date(range.fromMs), new Date(range.toMs), input.route ?? '', input.status, input.minDurationMs ?? 0, input.limit],
  );
  return { traces: rows };
};

export const getTrace = async (id: string) => {
  const trace = await vitalsQuery(`select * from obs.trace where trace_id = $1`, [id]);
  if (trace.length === 0) return null;
  const [spans, issue] = await Promise.all([
    vitalsQuery(
      `select span_id, parent_span_id, name, op, started_at, duration_ms, status, attributes
         from obs.span where trace_id = $1
         order by started_at, duration_ms desc`,
      [id],
    ),
    vitalsQuery<{ id: string; title: string }>(
      `select i.id, i.title from obs.issue_event e
         join obs.issue i on i.id = e.issue_id
        where e.trace_id = $1 limit 1`,
      [id],
    ),
  ]);
  return { trace: trace[0], spans, issue: issue[0] ?? null };
};

/** The monitored product's own breached-page-load log, when that schema exists. */
export const listSlowLoads = async (from?: string, to?: string) => {
  const range = resolveRange(from, to);
  try {
    const rows = await vitalsQuery(
      `select id, rule_name, page_url, api_url, load_area, duration_ms, user_id,
              app_id, object_api_name, http_status, created_at
         from logs.cpl_slow_load_log
        where created_at between $1 and $2
        order by duration_ms desc
        limit 50`,
      [new Date(range.fromMs), new Date(range.toMs)],
    );
    return { slowLoads: rows, available: true };
  } catch {
    return { slowLoads: [], available: false };
  }
};
