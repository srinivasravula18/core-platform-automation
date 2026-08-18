import { useEffect, useMemo, useState } from 'react';
import { cn } from '@/src/lib/utils';
import { vitals, type DashboardModel, type Panel } from '@/src/lib/vitals/api';
import { usePolled, useVitalsView } from '@/src/lib/vitals/hooks';
import type { Unit } from '@/src/lib/vitals/format';
import DashboardView from '@/src/components/vitals/DashboardView';
import VitalsShell from '@/src/components/vitals/VitalsShell';
import { ChartLegend, PanelFrame, SeriesTable, TimeSeriesChart } from '@/src/components/vitals/charts';
import { Banner, Card, Chip, Field, buttonClass, gridClass, inputClass } from '@/src/components/vitals/ui';

const REDUCERS = ['avg', 'sum', 'rate', 'last', 'min', 'max', 'p50', 'p95', 'p99', 'count'] as const;
const UNITS: Unit[] = ['short', 'ms', 'bytes', 'percent', 'rps', 'count'];

/** The catalog is learned from the endpoint, so the unit is inferred from the metric's own name. */
const unitForMetric = (metric: string): Unit => {
  if (metric.endsWith('.duration') || metric.includes('lag')) return 'ms';
  if (metric.includes('rss') || metric.includes('heap') || metric.includes('bytes') || metric.includes('mem')) return 'bytes';
  if (metric.includes('percent')) return 'percent';
  if (metric.endsWith('.count')) return 'rps';
  return 'short';
};

export default function VitalsMetrics() {
  const { range, refreshMs, live } = useVitalsView();
  const catalog = usePolled(() => vitals.metricNames(), [], 0, false);
  const dashboards = usePolled(() => vitals.dashboards(), [], 0, false);
  const [tab, setTab] = useState<'explore' | 'dashboards'>('explore');
  const [metric, setMetric] = useState('');
  const [reducer, setReducer] = useState('avg');
  const [groupBy, setGroupBy] = useState('');
  const [unit, setUnit] = useState<Unit>('short');
  const [stacked, setStacked] = useState(false);
  const [openDashboard, setOpenDashboard] = useState<string | null>(null);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  // Open on request latency when the endpoint reports it — the first metric an operator wants.
  useEffect(() => {
    if (metric || !catalog.data?.metrics.length) return;
    const available = catalog.data.metrics.map((entry) => entry.metric);
    const preferred = available.find((name) => name === 'http.request.duration') ?? available[0];
    setMetric(preferred);
    setUnit(unitForMetric(preferred));
    if (preferred === 'http.request.duration') setReducer('p95');
  }, [catalog.data, metric]);

  const labelKeys = useMemo(() => catalog.data?.metrics.find((entry) => entry.metric === metric)?.labelKeys ?? [], [catalog.data, metric]);

  const result = usePolled(
    () =>
      metric
        ? vitals.queryMetrics({
            from: range.from,
            to: range.to,
            targets: [
              {
                refId: 'A',
                metric,
                reducer,
                groupBy: groupBy ? [groupBy] : [],
                legend: groupBy ? undefined : `${metric} (${reducer})`,
              },
            ],
          })
        : Promise.resolve({ series: [], resolution: '1m' as const, fromMs: 0, toMs: 0, stepMs: 0 }),
    [metric, reducer, groupBy, range.from, range.to],
    refreshMs,
    live,
  );

  const detail = usePolled(() => (openDashboard ? vitals.dashboard(openDashboard) : Promise.resolve(null)), [openDashboard], 0, false);

  const addToDashboard = async () => {
    const existing = await vitals.dashboard(openDashboard ?? 'platform-overview');
    const model: DashboardModel = existing.dashboard.model;
    const maxY = model.panels.reduce((max, panel) => Math.max(max, panel.gridPos.y + panel.gridPos.h), 0);
    const panel: Panel = {
      id: Math.max(0, ...model.panels.map((entry) => entry.id)) + 1,
      type: stacked ? 'area' : 'timeseries',
      title: `${metric} (${reducer})${groupBy ? ` by ${groupBy}` : ''}`,
      unit,
      gridPos: { x: 0, y: maxY, w: 12, h: 7 },
      targets: [{ refId: 'A', metric, reducer, groupBy: groupBy ? [groupBy] : [] }],
      stacked,
    };
    await vitals.saveDashboard({
      uid: existing.dashboard.uid,
      title: existing.dashboard.title,
      tags: existing.dashboard.tags ?? [],
      model: { ...model, panels: [...model.panels, panel] },
    });
    setSaveMessage(`Added to “${existing.dashboard.title}”.`);
    dashboards.reload();
  };

  return (
    <VitalsShell
      title="Metrics"
      subtitle="Explore any series the endpoint collects. Dashboards are stored documents — panels, layout and range are data, not code."
      actions={
        <div className="inline-flex overflow-hidden rounded-md border border-[var(--border)]">
          {(['explore', 'dashboards'] as const).map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={tab === option}
              onClick={() => setTab(option)}
              className={cn(
                'px-3 py-1.5 text-xs font-medium capitalize transition-colors',
                tab === option ? 'bg-[var(--accent)] text-white' : 'text-[var(--text-muted)] hover:bg-[var(--bg-secondary)]',
              )}
            >
              {option}
            </button>
          ))}
        </div>
      }
    >
      {saveMessage && <Banner tone="info">{saveMessage}</Banner>}

      {tab === 'explore' ? (
        <>
          <Card className="mb-3">
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
              <Field label="Metric">
                <select
                  className={inputClass}
                  value={metric}
                  onChange={(event) => {
                    setMetric(event.target.value);
                    setUnit(unitForMetric(event.target.value));
                    setGroupBy('');
                  }}
                >
                  {(catalog.data?.metrics ?? []).map((entry) => (
                    <option key={entry.metric} value={entry.metric}>
                      {entry.metric} ({entry.seriesCount})
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Reducer">
                <select className={inputClass} value={reducer} onChange={(event) => setReducer(event.target.value)}>
                  {REDUCERS.map((entry) => (
                    <option key={entry}>{entry}</option>
                  ))}
                </select>
              </Field>
              <Field label="Group by">
                <select className={inputClass} value={groupBy} onChange={(event) => setGroupBy(event.target.value)}>
                  <option value="">(none)</option>
                  {labelKeys.map((key) => (
                    <option key={key}>{key}</option>
                  ))}
                </select>
              </Field>
              <Field label="Unit">
                <select className={inputClass} value={unit} onChange={(event) => setUnit(event.target.value as Unit)}>
                  {UNITS.map((entry) => (
                    <option key={entry}>{entry}</option>
                  ))}
                </select>
              </Field>
              <label className="flex items-center gap-2 self-end pb-2 text-sm text-[var(--text-primary)]">
                <input type="checkbox" checked={stacked} onChange={(event) => setStacked(event.target.checked)} />
                Stacked
              </label>
              <div className="flex items-end">
                <button type="button" className={buttonClass('primary', 'w-full')} disabled={!metric} onClick={() => void addToDashboard()}>
                  Add panel to dashboard
                </button>
              </div>
            </div>
          </Card>

          <div className={gridClass}>
            <PanelFrame
              title={`${metric || 'select a metric'} · ${reducer}`}
              description={result.data ? `resolution ${result.data.resolution} · ${result.data.series.length} series` : undefined}
              span={24}
              rows={13}
              legend={<ChartLegend series={result.data?.series ?? []} unit={unit} />}
              table={<SeriesTable series={result.data?.series ?? []} unit={unit} />}
            >
              <TimeSeriesChart series={result.data?.series ?? []} unit={unit} stacked={stacked} toMs={result.data?.toMs} />
            </PanelFrame>
          </div>
        </>
      ) : openDashboard && detail.data ? (
        <>
          <div className="mb-3 flex items-center gap-3">
            <button type="button" className={buttonClass('secondary')} onClick={() => setOpenDashboard(null)}>
              ← Dashboards
            </button>
            <h2 className="text-lg font-semibold text-[var(--text-primary)]">{detail.data.dashboard.title}</h2>
          </div>
          <DashboardView model={detail.data.dashboard.model} range={range} refreshMs={refreshMs} live={live} />
        </>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {(dashboards.data?.dashboards ?? []).map((dashboard) => (
            <Card key={dashboard.uid} title={dashboard.title} meta={dashboard.is_builtin ? <Chip>built-in</Chip> : undefined} className="min-h-0">
              <p className="font-mono text-xs text-[var(--text-muted)]">{dashboard.uid}</p>
              <p className="mt-1 text-xs text-[var(--text-muted)]">
                v{dashboard.version}
                {dashboard.updated_by ? ` · last edited by ${dashboard.updated_by}` : ''}
              </p>
              <button type="button" className={buttonClass('secondary', 'mt-3 w-full')} onClick={() => setOpenDashboard(dashboard.uid)}>
                Open
              </button>
            </Card>
          ))}
          {(dashboards.data?.dashboards ?? []).length === 0 && <p className="text-sm text-[var(--text-muted)]">No dashboards are stored on this endpoint.</p>}
        </div>
      )}
    </VitalsShell>
  );
}
