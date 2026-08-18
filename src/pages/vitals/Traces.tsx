import { useMemo, useState } from 'react';
import { cn } from '@/src/lib/utils';
import { vitals } from '@/src/lib/vitals/api';
import { usePolled, useVitalsView } from '@/src/lib/vitals/hooks';
import { formatDateTime, formatMs, formatRelative } from '@/src/lib/vitals/format';
import { colorForSeries, STATUS, useChartMode } from '@/src/lib/vitals/theme';
import VitalsShell from '@/src/components/vitals/VitalsShell';
import { Banner, Card, Chip, EmptyNote, StatusDot, TableFrame, Thead, buttonClass, rowClass, tdMainClass, tdClass, tdNumClass, thClass, thNumClass } from '@/src/components/vitals/ui';

const OP_SLOT: Record<string, number> = { http: 0, db: 2, cache: 3, flow: 4, custom: 6 };

function TraceDetailView({ id, onBack }: { id: string; onBack: () => void }) {
  const detail = usePolled(() => vitals.trace(id), [id], 0, false);
  const mode = useChartMode();

  const layout = useMemo(() => {
    if (!detail.data) return null;
    const start = new Date(detail.data.trace.started_at).getTime();
    const total = Math.max(detail.data.trace.duration_ms, 1);
    return {
      spans: detail.data.spans.map((span) => {
        const offset = Math.max(0, new Date(span.started_at).getTime() - start);
        return {
          ...span,
          leftPct: Math.min((offset / total) * 100, 100),
          widthPct: Math.max(Math.min((span.duration_ms / total) * 100, 100 - (offset / total) * 100), 0.4),
        };
      }),
    };
  }, [detail.data]);

  if (detail.error) return <Banner tone="critical">{detail.error}</Banner>;
  if (!detail.data || !layout) return <EmptyNote>Loading trace…</EmptyNote>;

  const { trace, issue } = detail.data;
  const dbShare = trace.db_time_ms ? (trace.db_time_ms / trace.duration_ms) * 100 : 0;

  return (
    <>
      <div className="mb-4 flex items-center gap-3">
        <button type="button" className={buttonClass('secondary')} onClick={onBack}>
          ← Traces
        </button>
        <div className="min-w-0">
          <h2 className="truncate text-lg font-semibold text-[var(--text-primary)]">{trace.root_name}</h2>
          <p className="truncate font-mono text-xs text-[var(--text-muted)]">
            {trace.trace_id} · sampled because: {trace.sampled_reason}
          </p>
        </div>
      </div>

      {issue && (
        <Banner tone="critical">
          <strong>This trace errored.</strong> Linked issue: {issue.title}
        </Banner>
      )}

      <div className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {[
          { label: 'Duration', value: formatMs(trace.duration_ms) },
          { label: 'Database time', value: formatMs(trace.db_time_ms) },
          { label: 'App time', value: formatMs(trace.duration_ms - (trace.db_time_ms ?? 0)) },
          { label: 'Spans', value: String(trace.span_count) },
          { label: 'Status', value: `${trace.status} ${trace.status_code ?? ''}` },
          { label: 'Started', value: formatDateTime(trace.started_at) },
        ].map((cell) => (
          <div key={cell.label} className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-4 shadow-sm">
            <span className="text-xs font-medium text-[var(--text-muted)]">{cell.label}</span>
            <div className="mt-1 truncate text-lg font-semibold text-[var(--text-primary)]">{cell.value}</div>
          </div>
        ))}
      </div>

      <Card title="Span waterfall" meta={<Chip>{dbShare.toFixed(0)}% of the time was database</Chip>} bodyClassName="max-h-[calc(100vh-24rem)] overflow-auto">
        {layout.spans.length === 0 ? (
          <EmptyNote>No spans recorded for this trace.</EmptyNote>
        ) : (
          layout.spans.map((span) => (
            <div key={span.span_id} className="grid grid-cols-1 items-center gap-2.5 px-2 py-1 text-xs lg:grid-cols-[16rem_minmax(0,1fr)_4.5rem]">
              <span className="flex items-center gap-1.5 truncate font-mono" title={span.name}>
                <StatusDot color={colorForSeries(span.op, OP_SLOT[span.op] ?? 6, mode)} />
                {span.name}
              </span>
              <span className="relative h-3.5 rounded-[3px] bg-[var(--bg-secondary)]">
                <span
                  className="absolute top-0 h-3.5 min-w-[2px] rounded-[3px]"
                  style={{
                    left: `${span.leftPct}%`,
                    width: `${span.widthPct}%`,
                    background: span.status === 'error' ? STATUS.critical : colorForSeries(span.op, OP_SLOT[span.op] ?? 6, mode),
                  }}
                />
              </span>
              <span className="text-right font-mono tabular-nums">{formatMs(span.duration_ms)}</span>
            </div>
          ))
        )}
      </Card>
    </>
  );
}

export default function VitalsTraces() {
  const { range, refreshMs, live } = useVitalsView();
  const [selected, setSelected] = useState<string | null>(null);
  const [route, setRoute] = useState('');

  const transactions = usePolled(() => vitals.transactions(range.from, range.to), [range.from, range.to], refreshMs, live);
  const traces = usePolled(
    () => vitals.traces({ from: range.from, to: range.to, ...(route ? { route } : {}), limit: '50' }),
    [range.from, range.to, route],
    refreshMs,
    live,
  );
  const slowLoads = usePolled(() => vitals.slowLoads(range.from, range.to), [range.from, range.to], refreshMs, live);

  return (
    <VitalsShell
      title="Traces"
      subtitle="Sampled transactions and their span waterfall. Errors and slow requests are always kept."
      actions={
        route && !selected ? (
          <button type="button" className={buttonClass('secondary')} onClick={() => setRoute('')}>
            Clear route filter: {route}
          </button>
        ) : undefined
      }
    >
      {selected ? (
        <TraceDetailView id={selected} onBack={() => setSelected(null)} />
      ) : (
        <div className="grid gap-3">
          <Card title="Slow transactions" note="Ranked by p95. Select a route to filter the trace list.">
            <TableFrame className="max-h-96">
              <Thead>
                <tr>
                  <th className={thClass}>Route</th>
                  <th className={thNumClass}>p50</th>
                  <th className={thNumClass}>p95</th>
                  <th className={thNumClass}>p99</th>
                  <th className={thNumClass}>Samples</th>
                  <th className={thNumClass}>Errors</th>
                </tr>
              </Thead>
              <tbody>
                {(transactions.data?.transactions ?? []).map((row) => (
                  <tr key={row.route} className={cn(rowClass, 'cursor-pointer')} onClick={() => setRoute(row.route)}>
                    <td className={cn(tdMainClass, 'truncate font-mono text-xs')}>{row.route}</td>
                    <td className={tdNumClass}>{formatMs(row.p50)}</td>
                    <td className={tdNumClass}>{formatMs(row.p95)}</td>
                    <td className={tdNumClass}>{formatMs(row.p99)}</td>
                    <td className={tdNumClass}>{row.samples}</td>
                    <td className={tdNumClass} style={{ color: row.errors > 0 ? STATUS.critical : undefined }}>
                      {row.errors}
                    </td>
                  </tr>
                ))}
                {(transactions.data?.transactions ?? []).length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-3 py-8 text-center text-sm text-[var(--text-muted)]">
                      No sampled transactions in this window.
                    </td>
                  </tr>
                )}
              </tbody>
            </TableFrame>
          </Card>

          <Card title="Slowest traces">
            <TableFrame className="max-h-96">
              <Thead>
                <tr>
                  <th className={thClass}>Transaction</th>
                  <th className={thNumClass}>Duration</th>
                  <th className={thNumClass}>DB</th>
                  <th className={thClass}>When</th>
                </tr>
              </Thead>
              <tbody>
                {(traces.data?.traces ?? []).map((trace) => (
                  <tr key={trace.trace_id} className={cn(rowClass, 'cursor-pointer')} onClick={() => setSelected(trace.trace_id)}>
                    <td className={cn(tdMainClass, 'truncate')}>
                      <span className="inline-flex items-center gap-1.5">
                        <StatusDot color={trace.status === 'error' ? STATUS.critical : STATUS.good} />
                        {trace.root_name}
                      </span>
                    </td>
                    <td className={tdNumClass}>{formatMs(trace.duration_ms)}</td>
                    <td className={tdNumClass}>{formatMs(trace.db_time_ms)}</td>
                    <td className={tdClass}>{formatRelative(trace.started_at)}</td>
                  </tr>
                ))}
                {(traces.data?.traces ?? []).length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-3 py-8 text-center text-sm text-[var(--text-muted)]">
                      No traces captured in this window.
                    </td>
                  </tr>
                )}
              </tbody>
            </TableFrame>
          </Card>

          <Card
            title="Slow page loads (browser side)"
            note="From the monitored product's own load-rule telemetry, so a slow page and its server trace sit side by side."
          >
            {slowLoads.data?.available === false ? (
              <EmptyNote>The slow-load log is not available on this endpoint.</EmptyNote>
            ) : (
              <TableFrame className="max-h-80">
                <Thead>
                  <tr>
                    <th className={thClass}>Page</th>
                    <th className={thClass}>API</th>
                    <th className={thClass}>Area</th>
                    <th className={thNumClass}>Duration</th>
                    <th className={thClass}>When</th>
                  </tr>
                </Thead>
                <tbody>
                  {(slowLoads.data?.slowLoads ?? []).map((row) => (
                    <tr key={String(row.id)} className={rowClass}>
                      <td className={cn(tdMainClass, 'truncate font-mono text-xs')}>{String(row.page_url)}</td>
                      <td className={cn(tdClass, 'truncate font-mono text-xs')}>{String(row.api_url)}</td>
                      <td className={tdClass}>{String(row.load_area)}</td>
                      <td className={tdNumClass}>{formatMs(Number(row.duration_ms))}</td>
                      <td className={tdClass}>{formatRelative(String(row.created_at))}</td>
                    </tr>
                  ))}
                  {(slowLoads.data?.slowLoads ?? []).length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-3 py-8 text-center text-sm text-[var(--text-muted)]">
                        No page loads breached a load rule in this window.
                      </td>
                    </tr>
                  )}
                </tbody>
              </TableFrame>
            )}
          </Card>
        </div>
      )}
    </VitalsShell>
  );
}
