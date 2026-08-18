/** The Overview snapshot: one number per tile for this window and the one before it. */

import { vitalsQuery, vitalsScalar } from './db';
import { RESOLUTION_TABLE, resolveRange } from './timerange';

export const calculateSlo = (requestCount: number | null, errorRate: number | null, targetPct: number) => {
  if (requestCount === null || errorRate === null) return { availabilityPct: null, burnRate: null, budgetRemainingPct: null };
  const budgetPct = Math.max(100 - targetPct, 0.001);
  const burnRate = errorRate / budgetPct;
  return { availabilityPct: Math.max(0, 100 - errorRate), burnRate, budgetRemainingPct: Math.max(0, 100 - burnRate * 100) };
};

export const calculateCapacity = (currentRps: number | null, testedRps: number | null) => ({
  testedRps,
  headroomPct:
    currentRps === null || testedRps === null || testedRps <= 0 ? null : Math.max(0, ((testedRps - currentRps) / testedRps) * 100),
});

export const calculateErrorRate = (requests: number | null, errors: number | null) =>
  requests === null ? null : requests > 0 ? ((errors ?? 0) / requests) * 100 : errors ? 100 : null;

const windowStats = async (table: string, fromMs: number, toMs: number) => {
  const from = new Date(fromMs);
  const to = new Date(toMs);
  const seconds = Math.max((toMs - fromMs) / 1000, 1);
  const between = (expression: string, metric: string) =>
    vitalsScalar(`select ${expression} as value from obs.${table} where metric = $1 and bucket_at between $2 and $3`, [metric, from, to]);

  const [requests, errors, latencyP95, latencyP50, cpu, memory, eventLoop, poolWaiting] = await Promise.all([
    between('sum(sum_value)::text', 'http.request.count'),
    between('sum(sum_value)::text', 'http.error.count'),
    between('max(p95)::text', 'http.request.duration'),
    between('(case when sum(sample_count) > 0 then sum(p50 * sample_count) / sum(sample_count) end)::text', 'http.request.duration'),
    between('(case when sum(sample_count) > 0 then sum(sum_value) / sum(sample_count) end)::text', 'host.cpu.percent'),
    between('(array_agg(last_value order by bucket_at desc))[1]::text', 'proc.rss'),
    between('max(max_value)::text', 'proc.event_loop_lag'),
    between('max(max_value)::text', 'db.pool.waiting'),
  ]);

  return {
    requestRate: requests === null ? null : requests / seconds,
    requestCount: requests,
    errorCount: errors,
    errorRate: calculateErrorRate(requests, errors),
    latencyP95,
    latencyP50,
    cpuPercent: cpu,
    memoryRss: memory,
    eventLoopLag: eventLoop,
    poolWaiting,
  };
};

export const getOverviewSnapshot = async (from?: string, to?: string) => {
  const range = resolveRange(from, to);
  const table = RESOLUTION_TABLE[range.resolution];
  const span = range.toMs - range.fromMs;

  const [current, previous, issues, slowRoutes, alertRows, capacityRun] = await Promise.all([
    windowStats(table, range.fromMs, range.toMs),
    windowStats(table, range.fromMs - span, range.fromMs),
    vitalsQuery<{ unresolved: string; new_today: string; critical: string; oldest_unresolved: Date | null }>(
      `select count(*) filter (where status = 'unresolved')::text as unresolved,
              count(*) filter (where first_seen > now() - interval '24 hours')::text as new_today,
              count(*) filter (where status = 'unresolved' and level in ('fatal', 'error'))::text as critical,
              min(first_seen) filter (where status = 'unresolved') as oldest_unresolved
         from obs.issue`,
    ),
    vitalsQuery<{ route: string; p95: string | null; count: string }>(
      `select coalesce(labels ->> 'route', '(unknown)') as route, max(p95)::text as p95, sum(sample_count)::text as count
         from obs.${table}
        where metric = 'http.request.duration' and bucket_at between $1 and $2
        group by 1
        order by max(p95) desc nulls last
        limit 10`,
      [new Date(range.fromMs), new Date(range.toMs)],
    ),
    vitalsQuery<{ state: string; count: string }>(`select state, count(*)::text as count from obs.alert_instance group by state`),
    vitalsQuery<{ profile_label: string; finished_at: Date | null; throughput_rps: string | null }>(
      `select profile_label, finished_at, summary ->> 'throughputRps' as throughput_rps
         from obs.test_run
        where status = 'passed' and summary ->> 'throughputRps' is not null
        order by finished_at desc nulls last
        limit 1`,
    ),
  ]);

  const alertStates = Object.fromEntries(alertRows.map((row) => [row.state, Number(row.count)])) as Record<string, number>;
  const sloTargetPct = Math.min(99.999, Math.max(90, Number(process.env.VITALS_SLO_TARGET_PCT ?? 99.9)));
  const testedRps = capacityRun[0]?.throughput_rps ? Number(capacityRun[0].throughput_rps) : null;

  return {
    range: { fromMs: range.fromMs, toMs: range.toMs, resolution: range.resolution },
    current,
    previous,
    issues: {
      unresolved: Number(issues[0]?.unresolved ?? 0),
      newToday: Number(issues[0]?.new_today ?? 0),
      critical: Number(issues[0]?.critical ?? 0),
      oldestUnresolvedAt: issues[0]?.oldest_unresolved?.toISOString() ?? null,
    },
    slo: { targetPct: sloTargetPct, ...calculateSlo(current.requestCount, current.errorRate, sloTargetPct) },
    capacity: {
      ...calculateCapacity(current.requestRate, testedRps),
      sourceProfile: capacityRun[0]?.profile_label ?? null,
      testedAt: capacityRun[0]?.finished_at?.toISOString() ?? null,
    },
    slowRoutes: slowRoutes.map((row) => ({ route: row.route, p95: row.p95 === null ? null : Number(row.p95), count: Number(row.count) })),
    alertStates,
    health:
      (alertStates.alerting ?? 0) > 0 ? 'critical' : (alertStates.pending ?? 0) > 0 || (current.errorRate ?? 0) > 1 ? 'warning' : 'good',
  };
};

export const getAnnotations = async (from?: string, to?: string) => {
  const range = resolveRange(from, to);
  const rows = await vitalsQuery<{
    id: string;
    kind: string;
    title: string;
    description: string | null;
    started_at: Date;
    ended_at: Date | null;
    ref_id: string | null;
  }>(
    `select id, kind, title, description, started_at, ended_at, ref_id
       from obs.annotation
      where started_at <= $2 and coalesce(ended_at, started_at) >= $1
      order by started_at desc
      limit 200`,
    [new Date(range.fromMs), new Date(range.toMs)],
  );
  return {
    annotations: rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      title: row.title,
      description: row.description,
      startedAt: new Date(row.started_at).getTime(),
      endedAt: row.ended_at ? new Date(row.ended_at).getTime() : null,
      refId: row.ref_id,
    })),
  };
};
