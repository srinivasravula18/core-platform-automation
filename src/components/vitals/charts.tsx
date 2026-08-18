/**
 * Vitals charts, on the app's own recharts stack.
 *
 * Rules carried over from the console this ports: one y-axis, recessive grid, no animation on live
 * data, a legend whenever there is more than one series (it carries the value, so colour is never
 * the only channel), and a table fallback behind every chart.
 */

import { cloneElement, isValidElement, useMemo, useState, type ReactNode } from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  Line,
  LineChart,
  ReferenceArea,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Modal } from '@/src/components/Modal';
import { cn } from '@/src/lib/utils';
import { formatClock, formatValue, type Unit } from '@/src/lib/vitals/format';
import { CHROME, colorForSeries, STATUS, useChartMode, type Mode, type StatusLevel } from '@/src/lib/vitals/theme';
import type { Annotation, MetricSeries } from '@/src/lib/vitals/api';
import { Card, EmptyNote, TableFrame, Thead, panelHeightClass, panelSpanClass, tdClass, tdNumClass, thClass, thNumClass, rowClass } from './ui';

const lastValue = (series: MetricSeries): number | null => {
  for (let index = series.points.length - 1; index >= 0; index -= 1) {
    const value = series.points[index]?.[1];
    if (value !== null && value !== undefined) return value;
  }
  return null;
};

const axisTick = (unit: Unit) => (value: number) => {
  if (unit === 'bytes') return formatValue(value, 'bytes');
  if (unit === 'percent') return `${Math.round(value)}%`;
  if (unit === 'ms') return value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${Math.round(value)}`;
  if (Math.abs(value) >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(Math.round(value * 100) / 100);
};

/** Series arrive as independent point lists; recharts wants one row per timestamp. */
const mergeSeries = (series: MetricSeries[]) => {
  const byTime = new Map<number, Record<string, number | null | undefined>>();
  for (const entry of series) {
    for (const [at, value] of entry.points) {
      const row = byTime.get(at) ?? { t: at };
      row[entry.name] = value;
      byTime.set(at, row);
    }
  }
  return [...byTime.values()].sort((left, right) => Number(left.t) - Number(right.t));
};

export function ChartLegend({ series, unit }: { series: MetricSeries[]; unit: Unit }) {
  const mode = useChartMode();
  if (series.length < 2) return null;
  return (
    <div className="flex flex-wrap gap-x-3.5 gap-y-1 pt-1 text-[11.5px] text-[var(--text-muted)]">
      {series.slice(0, 8).map((entry, index) => (
        <span className="inline-flex items-center gap-1.5" key={`${entry.refId}-${entry.name}`}>
          <span aria-hidden="true" className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: colorForSeries(entry.name, index, mode) }} />
          <span>{entry.name}</span>
          <span className="font-mono text-[11px] tabular-nums text-[var(--text-primary)]">{formatValue(lastValue(entry), unit)}</span>
        </span>
      ))}
      {series.length > 8 ? <span>+{series.length - 8} more</span> : null}
    </div>
  );
}

function ChartTooltip({ active, payload, label, unit }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-card)] px-3 py-2 text-xs shadow-sm">
      <div className="mb-1 font-medium text-[var(--text-primary)]">{typeof label === 'number' ? formatClock(label) : label}</div>
      {payload.map((item: any) => (
        <div key={item.dataKey ?? item.name} className="flex items-center gap-2">
          <span aria-hidden="true" className="h-2 w-2 rounded-sm" style={{ background: item.color ?? item.fill }} />
          <span className="text-[var(--text-muted)]">{item.name}</span>
          <span className="ml-auto font-mono tabular-nums text-[var(--text-primary)]">{formatValue(item.value ?? null, unit)}</span>
        </div>
      ))}
    </div>
  );
}

const axisProps = (mode: Mode) => ({
  stroke: CHROME[mode].axis,
  tick: { fill: CHROME[mode].textMuted, fontSize: 10.5 },
  tickLine: false,
});

export function TimeSeriesChart({
  series,
  unit,
  stacked,
  annotations = [],
  toMs = Date.now(),
}: {
  series: MetricSeries[];
  unit: Unit;
  stacked?: boolean;
  annotations?: Annotation[];
  fromMs?: number;
  toMs?: number;
}) {
  const mode = useChartMode();
  const data = useMemo(() => mergeSeries(series), [series]);

  if (series.length === 0) return <EmptyNote>No data in this window</EmptyNote>;

  const Chart = stacked ? AreaChart : LineChart;
  return (
    <ResponsiveContainer width="100%" height="100%">
      <Chart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
        <CartesianGrid stroke={CHROME[mode].grid} vertical={false} />
        <XAxis
          dataKey="t"
          type="number"
          scale="time"
          domain={['dataMin', 'dataMax']}
          tickFormatter={(value: number) => formatClock(value)}
          minTickGap={40}
          {...axisProps(mode)}
        />
        <YAxis width={54} tickFormatter={axisTick(unit)} {...axisProps(mode)} />
        <Tooltip content={<ChartTooltip unit={unit} />} />
        {/* Deploys and load runs land as shaded bands, so a regression can be read against a change. */}
        {annotations.map((annotation) => (
          <ReferenceArea
            key={annotation.id}
            x1={annotation.startedAt}
            x2={annotation.endedAt ?? toMs}
            fill={CHROME[mode].axis}
            fillOpacity={0.16}
            strokeOpacity={0}
          />
        ))}
        {series.map((entry, index) =>
          stacked ? (
            <Area
              key={entry.name}
              type="linear"
              dataKey={entry.name}
              stackId="total"
              isAnimationActive={false}
              stroke={colorForSeries(entry.name, index, mode)}
              fill={colorForSeries(entry.name, index, mode)}
              fillOpacity={0.45}
              strokeWidth={2}
              dot={false}
              connectNulls={false}
            />
          ) : (
            <Line
              key={entry.name}
              type="linear"
              dataKey={entry.name}
              isAnimationActive={false}
              stroke={colorForSeries(entry.name, index, mode)}
              strokeWidth={2}
              dot={false}
              connectNulls={false}
            />
          ),
        )}
      </Chart>
    </ResponsiveContainer>
  );
}

export function RankedBarChart({ rows, unit }: { rows: { label: string; value: number | null }[]; unit: Unit }) {
  const mode = useChartMode();
  if (rows.length === 0) return <EmptyNote>Nothing recorded yet</EmptyNote>;
  const data = rows.map((row) => ({ ...row, value: row.value ?? 0 }));
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} layout="vertical" margin={{ top: 4, right: 56, bottom: 4, left: 8 }}>
        <CartesianGrid stroke={CHROME[mode].grid} horizontal={false} />
        <XAxis type="number" tickFormatter={axisTick(unit)} {...axisProps(mode)} />
        <YAxis type="category" dataKey="label" width={170} {...axisProps(mode)} tick={{ fill: CHROME[mode].textSecondary, fontSize: 11 }} />
        <Tooltip cursor={{ fill: CHROME[mode].grid, fillOpacity: 0.4 }} content={<ChartTooltip unit={unit} />} />
        <Bar dataKey="value" isAnimationActive={false} barSize={14} radius={[0, 4, 4, 0]}>
          {data.map((row) => (
            <Cell key={row.label} fill={colorForSeries('bar', 0, mode)} />
          ))}
          <LabelList
            dataKey="value"
            position="right"
            formatter={(value: number) => formatValue(value, unit)}
            style={{ fill: CHROME[mode].textSecondary, fontSize: 11 }}
          />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

export function Sparkline({ points, tone }: { points: [number, number | null][]; tone?: StatusLevel }) {
  const mode = useChartMode();
  const data = useMemo(() => points.map(([t, value]) => ({ t, value })), [points]);
  if (points.length === 0) return null;
  const color = tone ? STATUS[tone] : colorForSeries('spark', 0, mode);
  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={data} margin={{ top: 2, right: 0, bottom: 2, left: 0 }}>
        <Area type="linear" dataKey="value" isAnimationActive={false} stroke={color} strokeWidth={2} fill={color} fillOpacity={0.16} dot={false} connectNulls />
      </AreaChart>
    </ResponsiveContainer>
  );
}

export const populatedTimestamps = (series: MetricSeries[]) =>
  [...new Set(series.flatMap((entry) => entry.points.filter((point) => point[1] !== null).map((point) => point[0])))]
    .sort((left, right) => right - left)
    .slice(0, 40);

/** Every chart panel can flip to a table — the accessibility fallback. */
export function SeriesTable({ series, unit }: { series: MetricSeries[]; unit: Unit }) {
  const rows = populatedTimestamps(series);
  return (
    <TableFrame className="max-h-60">
      <Thead>
        <tr>
          <th className={thClass}>Time</th>
          {series.map((entry) => (
            <th key={entry.name} className={thNumClass}>
              {entry.name}
            </th>
          ))}
        </tr>
      </Thead>
      <tbody>
        {rows.map((at) => (
          <tr key={at} className={rowClass}>
            <td className={cn(tdClass, 'font-mono text-xs')}>{formatClock(at)}</td>
            {series.map((entry) => (
              <td className={tdNumClass} key={`${entry.name}-${at}`}>
                {formatValue(entry.points.find((point) => point[0] === at)?.[1] ?? null, unit)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </TableFrame>
  );
}

/** A dashboard panel: 24-column span, chart/table toggle, and click-to-expand into the app's Modal. */
export function PanelFrame({
  title,
  description,
  span,
  rows = 8,
  children,
  legend,
  table,
}: {
  title: string;
  description?: string;
  span: number;
  rows?: number;
  children: ReactNode;
  legend?: ReactNode;
  table?: ReactNode;
}) {
  const [showTable, setShowTable] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [detailView, setDetailView] = useState<'chart' | 'data'>('chart');

  const detailChart = isValidElement(children) ? cloneElement(children as React.ReactElement) : children;

  return (
    <>
      <Card
        title={title}
        note={description}
        className={cn('min-h-64 xl:min-h-0', panelSpanClass(span), panelHeightClass(rows))}
        bodyClassName="flex flex-col"
        onClick={() => {
          setDetailView('chart');
          setExpanded(true);
        }}
        actions={
          table ? (
            <button
              type="button"
              aria-pressed={showTable}
              onClick={() => setShowTable((current) => !current)}
              className="rounded px-1.5 py-0.5 text-[11px] text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)]"
            >
              {showTable ? 'Chart' : 'Table'}
            </button>
          ) : undefined
        }
      >
        <div className="min-h-0 flex-1">{showTable && table ? table : children}</div>
        {!showTable && legend ? <div className="shrink-0">{legend}</div> : null}
      </Card>

      <Modal isOpen={expanded} onClose={() => setExpanded(false)} title={title} size="report">
        {description && <p className="mb-3 text-sm text-[var(--text-muted)]">{description}</p>}
        {table && (
          <div className="mb-3 flex gap-1 border-b border-[var(--border)]" role="tablist" aria-label="Detail view">
            {(['chart', 'data'] as const).map((view) => (
              <button
                key={view}
                type="button"
                role="tab"
                aria-selected={detailView === view}
                onClick={() => setDetailView(view)}
                className={cn(
                  'border-b-2 px-3 py-2 text-xs font-semibold capitalize transition-colors',
                  detailView === view ? 'border-[var(--accent)] text-[var(--text-primary)]' : 'border-transparent text-[var(--text-muted)]',
                )}
              >
                {view}
              </button>
            ))}
          </div>
        )}
        {detailView === 'chart' || !table ? (
          <div className="flex flex-col">
            <div className="h-[60vh] min-h-0">{detailChart}</div>
            {legend}
          </div>
        ) : (
          <div className="max-h-[60vh] overflow-auto">{table}</div>
        )}
      </Modal>
    </>
  );
}
