/** Renders a stored dashboard document — panels, queries and 24-column layout are data, not code. */

import { useMemo } from 'react';
import { vitals, type Annotation, type DashboardModel, type MetricSeries, type Panel } from '@/src/lib/vitals/api';
import { usePolled, type TimeRange } from '@/src/lib/vitals/hooks';
import { formatValue, type Unit } from '@/src/lib/vitals/format';
import { ChartLegend, PanelFrame, RankedBarChart, SeriesTable, TimeSeriesChart } from './charts';
import { EmptyNote, TableFrame, Thead, gridClass, rowClass, tdClass, tdNumClass, thClass, thNumClass } from './ui';
import { cn } from '@/src/lib/utils';

function RankedTable({ rows, unit }: { rows: { label: string; value: number | null }[]; unit: Unit }) {
  return (
    <TableFrame className="max-h-full">
      <Thead>
        <tr>
          <th className={thClass}>Series</th>
          <th className={thNumClass}>Value</th>
        </tr>
      </Thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.label} className={rowClass}>
            <td className={cn(tdClass, 'truncate font-mono text-xs')}>{row.label}</td>
            <td className={tdNumClass}>{formatValue(row.value, unit)}</td>
          </tr>
        ))}
      </tbody>
    </TableFrame>
  );
}

const panelSeries = (result: { series: MetricSeries[] } | null, panel: Panel) =>
  result ? result.series.filter((series) => panel.targets.some((target) => target.refId === series.refId)) : [];

function PanelRenderer({
  panel,
  range,
  refreshMs,
  live,
  annotations,
}: {
  panel: Panel;
  range: TimeRange;
  refreshMs: number;
  live: boolean;
  annotations: Annotation[];
}) {
  const loadable = usePolled(
    () =>
      vitals.queryMetrics({
        from: range.from,
        to: range.to,
        targets: panel.targets.map((target) => ({
          refId: target.refId,
          metric: target.metric,
          matchers: target.matchers,
          groupBy: target.groupBy,
          reducer: target.reducer,
          legend: target.legend,
        })),
      }),
    [panel.id, range.from, range.to],
    refreshMs,
    live,
  );

  const series = useMemo(() => panelSeries(loadable.data, panel), [loadable.data, panel]);
  const rows = panel.gridPos.h;

  if (loadable.error) {
    return (
      <PanelFrame title={panel.title} span={panel.gridPos.w} rows={rows}>
        <EmptyNote>{loadable.error}</EmptyNote>
      </PanelFrame>
    );
  }

  if (panel.type === 'bar') {
    const ranked = series
      .map((entry) => {
        let latest: number | null = null;
        for (let index = entry.points.length - 1; index >= 0; index -= 1) {
          const value = entry.points[index]?.[1];
          if (value !== null && value !== undefined) {
            latest = value;
            break;
          }
        }
        return { label: entry.name, value: latest };
      })
      .filter((row) => row.value !== null)
      .sort((left, right) => (right.value ?? 0) - (left.value ?? 0))
      .slice(0, 10);
    return (
      <PanelFrame
        title={panel.title}
        description={panel.description}
        span={panel.gridPos.w}
        rows={rows}
        table={<RankedTable rows={ranked} unit={panel.unit} />}
      >
        <RankedBarChart rows={ranked} unit={panel.unit} />
      </PanelFrame>
    );
  }

  return (
    <PanelFrame
      title={panel.title}
      description={panel.description}
      span={panel.gridPos.w}
      rows={rows}
      legend={<ChartLegend series={series} unit={panel.unit} />}
      table={<SeriesTable series={series} unit={panel.unit} />}
    >
      <TimeSeriesChart
        series={series}
        unit={panel.unit}
        stacked={panel.type === 'area' || panel.stacked}
        annotations={annotations}
        fromMs={loadable.data?.fromMs}
        toMs={loadable.data?.toMs ?? Date.now()}
      />
    </PanelFrame>
  );
}

export default function DashboardView({
  model,
  range,
  refreshMs,
  live,
  annotations = [],
}: {
  model: DashboardModel;
  range: TimeRange;
  refreshMs: number;
  live: boolean;
  annotations?: Annotation[];
}) {
  return (
    <div className={cn(gridClass, 'content-start')}>
      {[...model.panels]
        .sort((left, right) => left.gridPos.y - right.gridPos.y || left.gridPos.x - right.gridPos.x)
        .map((panel) => (
          <PanelRenderer key={panel.id} panel={panel} range={range} refreshMs={refreshMs} live={live} annotations={annotations} />
        ))}
    </div>
  );
}
