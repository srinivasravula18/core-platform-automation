/**
 * The metric query engine, over the store's pre-aggregated buckets.
 *
 * Every reducer is one SQL expression over bucket columns, and every value that could come from a
 * request is a bound parameter — the only interpolated identifiers are the resolution table and
 * label keys, and both are validated first.
 */

import { z } from 'zod';
import { vitalsQuery } from './db';
import { RESOLUTION_MS, RESOLUTION_TABLE, resolveRange, type Resolution } from './timerange';

export const matcherSchema = z.object({
  label: z.string().min(1).max(64),
  op: z.enum(['eq', 'neq', 're']).default('eq'),
  value: z.string().max(400),
});

export const targetSchema = z.object({
  refId: z.string().min(1).max(16).default('A'),
  metric: z.string().min(1).max(120),
  matchers: z.array(matcherSchema).max(10).default([]),
  groupBy: z.array(z.string().min(1).max(64)).max(4).default([]),
  reducer: z.enum(['avg', 'sum', 'rate', 'last', 'min', 'max', 'p50', 'p95', 'p99', 'count']).default('avg'),
  legend: z.string().max(120).optional(),
});

export const querySchema = z.object({
  from: z.string().max(64).optional(),
  to: z.string().max(64).optional(),
  maxPoints: z.number().int().min(20).max(2000).optional(),
  resolution: z.enum(['10s', '1m', '1h']).optional(),
  targets: z.array(targetSchema).min(1).max(12),
});

export type MetricTarget = z.infer<typeof targetSchema>;
export type MetricQuery = z.infer<typeof querySchema>;

export type MetricSeries = {
  refId: string;
  name: string;
  metric: string;
  labels: Record<string, string>;
  points: [number, number | null][];
};

const reducerExpression = (reducer: MetricTarget['reducer'], stepSeconds: number): string => {
  switch (reducer) {
    case 'sum':
      return 'sum(sum_value)';
    case 'count':
      return 'sum(sample_count)';
    case 'rate':
      return `sum(sum_value) / ${stepSeconds}::double precision`;
    case 'min':
      return 'min(min_value)';
    case 'max':
      return 'max(max_value)';
    case 'last':
      return '(array_agg(last_value order by bucket_at desc))[1]';
    case 'p50':
      return 'max(p50)';
    case 'p95':
      return 'max(p95)';
    case 'p99':
      return 'max(p99)';
    case 'avg':
    default:
      return 'case when sum(sample_count) > 0 then sum(sum_value) / sum(sample_count) end';
  }
};

const seriesKey = (labels: Record<string, string>, groupBy: string[]) => groupBy.map((key) => labels[key] ?? '').join(' · ');

type Row = { bucket_at: Date; value: string | number | null; group_labels: Record<string, string> | null };

/**
 * Finest rollup that actually holds rows for this metric in the window. pickResolution chooses purely on
 * point budget, so a short alert window selects the 10s table even when the metric is only rolled up at 1m —
 * the query then returns zero series and the rule reports nodata forever instead of firing.
 */
export const resolutionWithData = async (
  metric: string,
  fromMs: number,
  toMs: number,
): Promise<Resolution | undefined> => {
  for (const resolution of ['10s', '1m', '1h'] as const) {
    const rows = await vitalsQuery<{ one: number }>(
      `select 1 as one from obs.${RESOLUTION_TABLE[resolution]}
        where metric = $1 and bucket_at >= $2 and bucket_at <= $3 limit 1`,
      [metric, new Date(fromMs), new Date(toMs)],
    );
    if (rows.length) return resolution;
  }
  return undefined;
};

export const runMetricQuery = async (
  query: MetricQuery,
): Promise<{ series: MetricSeries[]; resolution: Resolution; fromMs: number; toMs: number; stepMs: number }> => {
  const range = resolveRange(query.from, query.to, query.maxPoints);
  const resolution = query.resolution ?? range.resolution;
  const table = RESOLUTION_TABLE[resolution];
  const stepMs = RESOLUTION_MS[resolution];
  const stepSeconds = stepMs / 1000;
  const series: MetricSeries[] = [];

  for (const target of query.targets) {
    const params: unknown[] = [target.metric, new Date(range.fromMs), new Date(range.toMs)];
    const bind = (value: unknown) => `$${params.push(value)}`;

    const groupExpression =
      target.groupBy.length === 0
        ? `'{}'::jsonb`
        : `jsonb_build_object(${target.groupBy.map((key) => `${bind(key)}::text, coalesce(labels ->> ${bind(key)}::text, '')`).join(', ')})`;

    const matcherPredicate =
      target.matchers.length === 0
        ? 'true'
        : target.matchers
            .map((matcher) => {
              const value = `labels ->> ${bind(matcher.label)}::text`;
              if (matcher.op === 'neq') return `coalesce(${value}, '') <> ${bind(matcher.value)}`;
              if (matcher.op === 're') return `coalesce(${value}, '') ~ ${bind(matcher.value)}`;
              return `${value} = ${bind(matcher.value)}`;
            })
            .join(' and ');

    const rows = await vitalsQuery<Row>(
      `select bucket_at,
              ${groupExpression} as group_labels,
              ${reducerExpression(target.reducer, stepSeconds)} as value
         from obs.${table}
        where metric = $1
          and bucket_at >= $2
          and bucket_at <= $3
          and ${matcherPredicate}
        group by 1, 2
        order by 1`,
      params,
    );

    // Fill the grid so gaps render as breaks rather than a straight line through missing time.
    const buckets = new Map<string, { labels: Record<string, string>; values: Map<number, number | null> }>();
    for (const row of rows) {
      const labels = row.group_labels ?? {};
      const key = seriesKey(labels, target.groupBy);
      let entry = buckets.get(key);
      if (!entry) {
        entry = { labels, values: new Map() };
        buckets.set(key, entry);
      }
      entry.values.set(new Date(row.bucket_at).getTime(), row.value === null ? null : Number(row.value));
    }

    const gridStart = Math.floor(range.fromMs / stepMs) * stepMs;
    const gridEnd = Math.floor(range.toMs / stepMs) * stepMs;
    for (const [key, entry] of buckets) {
      const points: [number, number | null][] = [];
      for (let at = gridStart; at <= gridEnd; at += stepMs) {
        points.push([at, entry.values.has(at) ? (entry.values.get(at) ?? null) : null]);
      }
      series.push({
        refId: target.refId,
        name: target.legend ?? (key || target.metric),
        metric: target.metric,
        labels: entry.labels,
        points,
      });
    }
  }

  series.sort((left, right) => left.name.localeCompare(right.name));
  return { series, resolution, fromMs: range.fromMs, toMs: range.toMs, stepMs };
};

export const listMetricNames = async () => {
  const rows = await vitalsQuery<{ metric: string; label_keys: string[]; series_count: string }>(
    `select metric,
            coalesce(array_agg(distinct key) filter (where key is not null), '{}') as label_keys,
            count(distinct labels_hash)::text as series_count
       from obs.metric_sample_1m
       left join lateral jsonb_object_keys(labels) as key on true
      where bucket_at > now() - interval '2 days'
      group by metric
      order by metric`,
  );
  return rows.map((row) => ({ metric: row.metric, labelKeys: row.label_keys ?? [], seriesCount: Number(row.series_count) }));
};

export const listLabelValues = async (metric: string, label: string) => {
  const rows = await vitalsQuery<{ value: string | null }>(
    `select distinct labels ->> $2::text as value
       from obs.metric_sample_1m
      where metric = $1
        and bucket_at > now() - interval '2 days'
        and labels ? $2::text
      order by 1
      limit 200`,
    [metric, label],
  );
  return rows.map((row) => row.value).filter((value): value is string => value !== null);
};
