/**
 * Default dashboard layouts, compiled in rather than written to the store.
 *
 * The connection already provides the data; a dashboard only says how to arrange it — which panels,
 * which metrics, which reducer, what grid position. That is this console's opinion, not the
 * monitored product's, so it belongs in the build and not in somebody else's database. Vitals writes
 * nothing to a customer's store until a person saves an edit.
 *
 * A stored dashboard with the same uid always wins: the first edit of a default writes a real row
 * (copy-on-write), and from then on that row is what renders.
 *
 * The metric names below are the observability schema's own convention — the same names overview.ts
 * reads. Panels whose metrics the store never recorded simply draw empty, which is honest about the
 * window in view rather than about what happened to exist at seed time.
 */

import type { DashboardModel } from './api';

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

/** The compiled-in default for a uid, or null when the uid is not one of ours. */
export const builtinDashboard = (uid: string): BuiltinDashboard | null =>
  BUILTIN_DASHBOARDS.find((entry) => entry.uid === uid) ?? null;

export type ResolvedDashboard = BuiltinDashboard & { stored: boolean };

/**
 * The dashboard to render for a uid: the stored row when one exists, else the compiled-in default.
 *
 * A 404 is the expected answer for a default nobody has edited, so it resolves rather than throws —
 * only a real failure (unreachable store, bad request) propagates.
 */
export const resolveDashboard = async (
  uid: string,
  fetchStored: (uid: string) => Promise<{ dashboard: { uid: string; title: string; tags: string[]; model: DashboardModel } }>,
): Promise<ResolvedDashboard | null> => {
  try {
    const { dashboard } = await fetchStored(uid);
    return { uid: dashboard.uid, title: dashboard.title, tags: dashboard.tags ?? [], model: dashboard.model, stored: true };
  } catch (error) {
    const missing = (error as { status?: number }).status === 404;
    const fallback = builtinDashboard(uid);
    if (missing && fallback) return { ...fallback, stored: false };
    if (missing) return null;
    throw error;
  }
};
