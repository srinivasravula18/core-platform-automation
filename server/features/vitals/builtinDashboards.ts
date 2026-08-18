/**
 * Starter dashboards, seeded into the store rather than compiled into the UI.
 *
 * They use the same Grafana-shaped JSON model an operator authors by hand — a 24-column grid,
 * gridPos per panel, targets per panel, a default range and refresh — so a seeded dashboard is
 * editable, deletable, and indistinguishable from one somebody built.
 *
 * The metric names below are the observability schema's own convention (the same names
 * overview.ts reads), not any one product's business data. Seeding still checks what the connected
 * store actually records and drops panels whose metrics were never written, so a product that
 * instruments a subset gets a dashboard about itself instead of a wall of empty charts.
 */

import { vitalsQuery } from './db';

type PanelTarget = {
  refId: string;
  metric: string;
  matchers?: { label: string; op?: 'eq' | 'neq' | 're'; value: string }[];
  groupBy?: string[];
  reducer?: string;
  legend?: string;
};

type Panel = {
  id: number;
  type: 'timeseries' | 'stat' | 'bar' | 'table' | 'area';
  title: string;
  unit: 'ms' | 'bytes' | 'percent' | 'rps' | 'count' | 'short';
  gridPos: { x: number; y: number; w: number; h: number };
  targets: PanelTarget[];
  stacked?: boolean;
  description?: string;
};

type DashboardModel = {
  schemaVersion: number;
  time: { from: string; to: string };
  refresh: string;
  templating: { variables: { name: string; label: string; metric: string; labelKey: string }[] };
  panels: Panel[];
};

export type BuiltinDashboard = { uid: string; title: string; tags: string[]; model: DashboardModel };

const OVERVIEW_DASHBOARD: BuiltinDashboard = {
  uid: 'platform-overview',
  title: 'Platform Overview',
  tags: ['builtin', 'red', 'use'],
  model: {
    schemaVersion: 1,
    time: { from: 'now-1h', to: 'now' },
    refresh: '10s',
    templating: { variables: [{ name: 'route', label: 'Route', metric: 'http.request.duration', labelKey: 'route' }] },
    panels: [
      {
        id: 1,
        type: 'area',
        title: 'Request rate by status class',
        unit: 'rps',
        gridPos: { x: 0, y: 0, w: 12, h: 8 },
        stacked: true,
        description: 'Throughput split by 2xx/3xx/4xx/5xx. A rising 5xx band is the first thing to look at.',
        targets: [{ refId: 'A', metric: 'http.request.count', groupBy: ['status'], reducer: 'rate' }],
      },
      {
        id: 2,
        type: 'timeseries',
        title: 'Latency percentiles',
        unit: 'ms',
        gridPos: { x: 12, y: 0, w: 12, h: 8 },
        description: 'p50 is the typical user; p95 and p99 are the ones who complain.',
        targets: [
          { refId: 'A', metric: 'http.request.duration', reducer: 'p50', legend: 'p50' },
          { refId: 'B', metric: 'http.request.duration', reducer: 'p95', legend: 'p95' },
          { refId: 'C', metric: 'http.request.duration', reducer: 'p99', legend: 'p99' },
        ],
      },
      {
        id: 3,
        type: 'timeseries',
        title: 'CPU',
        unit: 'percent',
        gridPos: { x: 0, y: 8, w: 6, h: 7 },
        description: 'Host CPU flat while latency climbs means the bottleneck is elsewhere.',
        targets: [
          { refId: 'A', metric: 'host.cpu.percent', reducer: 'avg', legend: 'host cpu %' },
          { refId: 'B', metric: 'proc.cpu.percent', reducer: 'avg', legend: 'process cpu %' },
        ],
      },
      {
        id: 8,
        type: 'timeseries',
        title: 'Event-loop lag',
        unit: 'ms',
        gridPos: { x: 6, y: 8, w: 6, h: 7 },
        description: 'Lag rising while CPU is flat means blocking work, not saturation.',
        targets: [{ refId: 'A', metric: 'proc.event_loop_lag', reducer: 'max', legend: 'loop lag' }],
      },
      {
        id: 4,
        type: 'timeseries',
        title: 'Memory',
        unit: 'bytes',
        gridPos: { x: 12, y: 8, w: 6, h: 7 },
        description: 'A heap that never returns to its floor across a soak run is a leak.',
        targets: [
          { refId: 'A', metric: 'proc.rss', reducer: 'last', legend: 'rss' },
          { refId: 'B', metric: 'proc.heap_used', reducer: 'last', legend: 'heap used' },
        ],
      },
      {
        id: 5,
        type: 'timeseries',
        title: 'Database pool',
        unit: 'count',
        gridPos: { x: 18, y: 8, w: 6, h: 7 },
        description: 'Waiting above zero means requests are queueing for a connection.',
        targets: [
          { refId: 'A', metric: 'db.pool.busy', reducer: 'last', legend: 'busy' },
          { refId: 'B', metric: 'db.pool.idle', reducer: 'last', legend: 'idle' },
          { refId: 'C', metric: 'db.pool.waiting', reducer: 'max', legend: 'waiting' },
        ],
      },
      {
        id: 6,
        type: 'bar',
        title: 'Slowest routes (p95)',
        unit: 'ms',
        gridPos: { x: 0, y: 15, w: 12, h: 8 },
        targets: [{ refId: 'A', metric: 'http.request.duration', groupBy: ['route'], reducer: 'p95' }],
      },
      {
        id: 7,
        type: 'timeseries',
        title: 'Errors and in-flight requests',
        unit: 'count',
        gridPos: { x: 12, y: 15, w: 12, h: 8 },
        targets: [
          { refId: 'A', metric: 'http.error.count', reducer: 'sum', legend: '5xx' },
          { refId: 'B', metric: 'http.in_flight', reducer: 'max', legend: 'in flight' },
          { refId: 'C', metric: 'issue.event.count', reducer: 'sum', legend: 'captured errors' },
        ],
      },
    ],
  },
};

const LOAD_LAB_DASHBOARD: BuiltinDashboard = {
  uid: 'load-lab-live',
  title: 'Load Lab (live)',
  tags: ['builtin', 'load'],
  model: {
    schemaVersion: 1,
    time: { from: 'now-15m', to: 'now' },
    refresh: '5s',
    templating: { variables: [] },
    panels: [
      {
        id: 1,
        type: 'timeseries',
        title: 'Latency percentiles',
        unit: 'ms',
        gridPos: { x: 0, y: 0, w: 12, h: 7 },
        targets: [
          { refId: 'A', metric: 'http.request.duration', reducer: 'p95', legend: 'p95' },
          { refId: 'B', metric: 'http.request.duration', reducer: 'p99', legend: 'p99' },
        ],
      },
      {
        id: 2,
        type: 'area',
        title: 'Throughput by status',
        unit: 'rps',
        gridPos: { x: 12, y: 0, w: 12, h: 7 },
        stacked: true,
        targets: [{ refId: 'A', metric: 'http.request.count', groupBy: ['status'], reducer: 'rate' }],
      },
      {
        id: 3,
        type: 'timeseries',
        title: 'CPU under load',
        unit: 'percent',
        gridPos: { x: 0, y: 7, w: 12, h: 7 },
        targets: [
          { refId: 'A', metric: 'host.cpu.percent', reducer: 'avg', legend: 'host cpu %' },
          { refId: 'B', metric: 'proc.cpu.percent', reducer: 'avg', legend: 'process cpu %' },
        ],
      },
      {
        id: 4,
        type: 'timeseries',
        title: 'Pool pressure',
        unit: 'count',
        gridPos: { x: 12, y: 7, w: 12, h: 7 },
        targets: [
          { refId: 'A', metric: 'db.pool.busy', reducer: 'last', legend: 'busy' },
          { refId: 'B', metric: 'db.pool.waiting', reducer: 'max', legend: 'waiting' },
        ],
      },
      {
        id: 5,
        type: 'timeseries',
        title: 'Memory under load',
        unit: 'bytes',
        gridPos: { x: 0, y: 14, w: 12, h: 7 },
        targets: [
          { refId: 'A', metric: 'host.mem.used', reducer: 'last', legend: 'host memory used' },
          { refId: 'B', metric: 'proc.rss', reducer: 'last', legend: 'process RSS' },
        ],
      },
      {
        id: 6,
        type: 'timeseries',
        title: 'Disk usage',
        unit: 'bytes',
        gridPos: { x: 12, y: 14, w: 12, h: 7 },
        targets: [
          { refId: 'A', metric: 'host.disk.used', reducer: 'last', legend: 'disk used' },
          { refId: 'B', metric: 'host.disk.total', reducer: 'last', legend: 'disk total' },
        ],
      },
      {
        id: 7,
        type: 'timeseries',
        title: 'Event-loop lag',
        unit: 'ms',
        gridPos: { x: 0, y: 21, w: 24, h: 7 },
        targets: [{ refId: 'A', metric: 'proc.event_loop_lag', reducer: 'max', legend: 'event-loop lag' }],
      },
    ],
  },
};

export const BUILTIN_DASHBOARDS: BuiltinDashboard[] = [OVERVIEW_DASHBOARD, LOAD_LAB_DASHBOARD];

/** Metric names the connected store has actually recorded, at any resolution. */
const recordedMetrics = async (): Promise<Set<string>> => {
  const rows = await vitalsQuery<{ metric: string }>(
    `select distinct metric from obs.metric_sample_1h
     union
     select distinct metric from obs.metric_sample_1m`,
  );
  return new Set(rows.map((row) => row.metric));
};

/**
 * Drop targets for metrics this store never records, then panels left with none. Panels keep their
 * gridPos: a gap is honest about what is missing, and re-seeding after the product starts emitting
 * the metric restores the panel in place.
 */
export const fitToStore = (dashboard: BuiltinDashboard, available: Set<string>): BuiltinDashboard | null => {
  const panels = dashboard.model.panels
    .map((panel) => ({ ...panel, targets: panel.targets.filter((target) => available.has(target.metric)) }))
    .filter((panel) => panel.targets.length > 0);
  if (panels.length === 0) return null;
  const variables = dashboard.model.templating.variables.filter((variable) => available.has(variable.metric));
  return { ...dashboard, model: { ...dashboard.model, templating: { variables }, panels } };
};

export type SeedOutcome = { uid: string; seeded: boolean; panels: number; reason?: string };

/**
 * Idempotent. An operator's edits win: the upsert only touches a row that is still a pristine
 * built-in (version 1, never saved by a person), so a customised copy is never clobbered.
 */
export const seedBuiltinDashboards = async (): Promise<SeedOutcome[]> => {
  const available = await recordedMetrics();
  const outcomes: SeedOutcome[] = [];

  for (const dashboard of BUILTIN_DASHBOARDS) {
    const fitted = available.size === 0 ? dashboard : fitToStore(dashboard, available);
    if (!fitted) {
      outcomes.push({ uid: dashboard.uid, seeded: false, panels: 0, reason: 'the store records none of its metrics' });
      continue;
    }
    await vitalsQuery(
      `insert into obs.dashboard (uid, title, tags, model, version, is_builtin)
       values ($1, $2, $3::text[], $4::jsonb, 1, true)
       on conflict (uid) do update set
         title = excluded.title,
         tags = excluded.tags,
         model = excluded.model,
         updated_at = now()
       where obs.dashboard.is_builtin = true
         and obs.dashboard.version = 1
         and obs.dashboard.updated_by is null`,
      [fitted.uid, fitted.title, fitted.tags, JSON.stringify(fitted.model)],
    );
    outcomes.push({ uid: fitted.uid, seeded: true, panels: fitted.model.panels.length });
  }
  return outcomes;
};
