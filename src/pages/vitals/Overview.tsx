import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';
import { Modal } from '@/src/components/Modal';
import { cn } from '@/src/lib/utils';
import { vitals } from '@/src/lib/vitals/api';
import { usePolled, useVitalsView } from '@/src/lib/vitals/hooks';
import { formatRelative, formatValue } from '@/src/lib/vitals/format';
import { statusForValue } from '@/src/lib/vitals/theme';
import DashboardView from '@/src/components/vitals/DashboardView';
import StatTile from '@/src/components/vitals/StatTile';
import VitalsShell from '@/src/components/vitals/VitalsShell';
import { Banner, Card, EmptyNote, buttonClass } from '@/src/components/vitals/ui';

type DetailKey = 'alerts' | 'rps' | 'errors' | 'p95' | 'cpu' | 'lag' | 'issues' | 'slo' | 'capacity' | 'incidents' | 'changes';

const DETAIL_TITLE: Record<DetailKey, string> = {
  alerts: 'Firing alerts',
  rps: 'Request throughput',
  errors: 'Error rate',
  p95: 'Latency',
  cpu: 'Host CPU',
  lag: 'Event-loop lag',
  issues: 'Issues',
  slo: 'SLO and error budget',
  capacity: 'Capacity headroom',
  incidents: 'Active incidents',
  changes: 'Change correlation',
};

const DETAIL_NOTE: Record<DetailKey, string> = {
  alerts: 'Inspect alert instances and unresolved issues to identify the active failure domain.',
  rps: 'Compare throughput with error rate and latency before treating a traffic change as healthy or harmful.',
  errors: 'Open Issues to inspect fingerprints, affected routes, breadcrumbs and linked traces.',
  p95: 'Use the slowest-route panel and Traces to separate application time from database time.',
  cpu: 'High lag with flat CPU usually means blocking work; high CPU suggests saturation.',
  lag: 'Check CPU, database pool waiting and slow traces to tell blocking code from downstream contention.',
  issues: 'Open Issues for fingerprint groups, affected users, event timelines, breadcrumbs, stack frames and tags.',
  slo: "Burn rate compares this window's error rate with the configured SLO error budget.",
  capacity: 'Headroom compares current throughput with the latest passed load run that recorded throughput.',
  incidents: 'Alert instances and critical unresolved issues are shown separately so duplicates never hide a signal.',
  changes: 'Read annotations alongside current-versus-previous metrics to spot change-correlated regressions.',
};

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] p-3">
      <span className="block text-xs text-[var(--text-muted)]">{label}</span>
      <strong className="mt-1 block text-lg text-[var(--text-primary)]">{value}</strong>
    </div>
  );
}

function Insight({ label, value, sub, onClick }: { label: string; value: string; sub: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex min-h-28 flex-col items-start rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-4 text-left shadow-sm transition-colors hover:border-[var(--accent)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
    >
      <span className="text-xs font-medium text-[var(--text-muted)]">{label}</span>
      <strong className="mt-2 line-clamp-2 text-xl leading-tight text-[var(--text-primary)]">{value}</strong>
      <span className="mt-auto pt-2 text-xs text-[var(--text-muted)]">{sub}</span>
    </button>
  );
}

export default function VitalsOverview() {
  const navigate = useNavigate();
  const { range, refreshMs, live } = useVitalsView();
  const [detail, setDetail] = useState<DetailKey | null>(null);

  const overview = usePolled(() => vitals.overview(range.from, range.to), [range.from, range.to], refreshMs, live);
  const annotations = usePolled(() => vitals.annotations(range.from, range.to), [range.from, range.to], refreshMs, live);
  const dashboard = usePolled(() => vitals.dashboard('platform-overview'), [], 0, false);

  const current = overview.data?.current;
  const previous = overview.data?.previous;
  const latestChange = annotations.data?.annotations[0] ?? null;
  const incidentSignals = (overview.data?.alertStates.alerting ?? 0) + (overview.data?.issues.critical ?? 0);

  return (
    <VitalsShell title="Overview" subtitle="Service health, throughput, latency and resources for the connected environment.">
      {overview.error && (
        <Banner tone="critical">
          <strong>Cannot read metrics.</strong> {overview.error}
        </Banner>
      )}
      {/* Two very different situations look alike as an empty chart: nothing collected at all, versus
          collected fine but no traffic. Host metrics tell them apart, so the banner names the real one. */}
      {overview.data && overview.data.current.requestCount === null && (
        <Banner tone="info">
          {overview.data.current.cpuPercent === null ? (
            <>
              <strong>No telemetry in this window.</strong> The endpoint has not written a bucket for this range — check that collection is
              enabled on the monitored service, then give it one flush interval.
            </>
          ) : (
            <>
              <strong>No requests reached the monitored service in this window.</strong> Host and runtime metrics are still arriving, so
              collection is healthy — there was simply no traffic. Widen the time range to see earlier activity.
            </>
          )}
        </Banner>
      )}

      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <StatTile
          label="Firing alerts"
          value={overview.data ? (overview.data.alertStates.alerting ?? 0) : null}
          unit="count"
          tone={overview.data?.health === 'critical' ? 'critical' : overview.data?.health === 'warning' ? 'warning' : 'good'}
          hint={overview.data ? `${overview.data.alertStates.pending ?? 0} pending · ${overview.data.alertStates.normal ?? 0} normal` : undefined}
          onClick={() => setDetail('alerts')}
        />
        <StatTile label="Requests / sec" value={current?.requestRate ?? null} previous={previous?.requestRate ?? null} unit="rps" improvement="higher" onClick={() => setDetail('rps')} />
        <StatTile
          label="Error rate"
          value={current?.errorRate ?? null}
          previous={previous?.errorRate ?? null}
          unit="percent"
          improvement="lower"
          tone={statusForValue(current?.errorRate ?? null, { warning: 1, critical: 5 })}
          onClick={() => setDetail('errors')}
        />
        <StatTile
          label="p95 latency"
          value={current?.latencyP95 ?? null}
          previous={previous?.latencyP95 ?? null}
          unit="ms"
          improvement="lower"
          tone={statusForValue(current?.latencyP95 ?? null, { warning: 1000, critical: 3000 })}
          onClick={() => setDetail('p95')}
        />
        <StatTile
          label="Host CPU"
          value={current?.cpuPercent ?? null}
          previous={previous?.cpuPercent ?? null}
          unit="percent"
          improvement="lower"
          tone={statusForValue(current?.cpuPercent ?? null, { warning: 70, critical: 90 })}
          onClick={() => setDetail('cpu')}
        />
        <StatTile
          label="Event-loop lag"
          value={current?.eventLoopLag ?? null}
          previous={previous?.eventLoopLag ?? null}
          unit="ms"
          improvement="lower"
          tone={statusForValue(current?.eventLoopLag ?? null, { warning: 50, critical: 200 })}
          onClick={() => setDetail('lag')}
        />
      </div>

      <div className="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Insight
          label="Service availability"
          value={formatValue(overview.data?.slo.availabilityPct ?? null, 'percent')}
          sub={
            overview.data?.slo.burnRate == null
              ? 'No request samples'
              : `${overview.data.slo.burnRate.toFixed(2)}x burn / ${overview.data.slo.targetPct}% target`
          }
          onClick={() => setDetail('slo')}
        />
        <Insight
          label="Capacity headroom"
          value={formatValue(overview.data?.capacity.headroomPct ?? null, 'percent')}
          sub={
            overview.data?.capacity.testedRps == null
              ? 'No passed capacity run'
              : `${formatValue(current?.requestRate ?? null, 'rps')} of ${formatValue(overview.data.capacity.testedRps, 'rps')} tested`
          }
          onClick={() => setDetail('capacity')}
        />
        <Insight
          label="Active incidents"
          value={overview.data ? String(incidentSignals) : '—'}
          sub={overview.data ? `${overview.data.alertStates.alerting ?? 0} alerts / ${overview.data.issues.critical} critical issues` : 'Loading'}
          onClick={() => setDetail('incidents')}
        />
        <Insight
          label="Latest change"
          value={latestChange?.title ?? 'No recent changes'}
          sub={latestChange ? `${latestChange.kind} / ${formatRelative(latestChange.startedAt)}` : 'No annotations in this window'}
          onClick={() => setDetail('changes')}
        />
      </div>

      <Modal isOpen={!!detail} onClose={() => setDetail(null)} title={detail ? DETAIL_TITLE[detail] : ''} size="md">
        {detail && (
          <>
            <p className="text-sm text-[var(--text-muted)]">
              Current range: {range.from} to {range.to}
            </p>
            <div className="my-4 grid gap-2 sm:grid-cols-2">
              {detail === 'alerts' && (
                <>
                  <Metric label="Alerting" value={overview.data?.alertStates.alerting ?? 0} />
                  <Metric label="Pending" value={overview.data?.alertStates.pending ?? 0} />
                  <Metric label="Normal" value={overview.data?.alertStates.normal ?? 0} />
                  <Metric label="Unresolved issues" value={overview.data?.issues.unresolved ?? 0} />
                </>
              )}
              {detail === 'rps' && (
                <>
                  <Metric label="Current" value={formatValue(current?.requestRate ?? null, 'rps')} />
                  <Metric label="Previous" value={formatValue(previous?.requestRate ?? null, 'rps')} />
                  <Metric label="Requests" value={formatValue(current?.requestCount ?? null, 'count')} />
                  <Metric label="Errors" value={formatValue(current?.errorCount ?? null, 'count')} />
                </>
              )}
              {detail === 'errors' && (
                <>
                  <Metric label="Current rate" value={formatValue(current?.errorRate ?? null, 'percent')} />
                  <Metric label="Previous rate" value={formatValue(previous?.errorRate ?? null, 'percent')} />
                  <Metric label="Error count" value={formatValue(current?.errorCount ?? null, 'count')} />
                  <Metric label="New issues" value={overview.data?.issues.newToday ?? 0} />
                </>
              )}
              {detail === 'p95' && (
                <>
                  <Metric label="p50" value={formatValue(current?.latencyP50 ?? null, 'ms')} />
                  <Metric label="p95" value={formatValue(current?.latencyP95 ?? null, 'ms')} />
                  <Metric label="Previous p95" value={formatValue(previous?.latencyP95 ?? null, 'ms')} />
                  <Metric label="Slowest route" value={overview.data?.slowRoutes[0]?.route ?? '—'} />
                </>
              )}
              {detail === 'cpu' && (
                <>
                  <Metric label="Current CPU" value={formatValue(current?.cpuPercent ?? null, 'percent')} />
                  <Metric label="Previous CPU" value={formatValue(previous?.cpuPercent ?? null, 'percent')} />
                  <Metric label="Memory RSS" value={formatValue(current?.memoryRss ?? null, 'bytes')} />
                  <Metric label="Event-loop lag" value={formatValue(current?.eventLoopLag ?? null, 'ms')} />
                </>
              )}
              {detail === 'lag' && (
                <>
                  <Metric label="Peak lag" value={formatValue(current?.eventLoopLag ?? null, 'ms')} />
                  <Metric label="Previous lag" value={formatValue(previous?.eventLoopLag ?? null, 'ms')} />
                  <Metric label="Host CPU" value={formatValue(current?.cpuPercent ?? null, 'percent')} />
                  <Metric label="Pool waiting" value={formatValue(current?.poolWaiting ?? null, 'count')} />
                </>
              )}
              {detail === 'issues' && (
                <>
                  <Metric label="Unresolved" value={overview.data?.issues.unresolved ?? 0} />
                  <Metric label="New in 24h" value={overview.data?.issues.newToday ?? 0} />
                  <Metric label="Alerting" value={overview.data?.alertStates.alerting ?? 0} />
                  <Metric label="Recent annotations" value={annotations.data?.annotations.length ?? 0} />
                </>
              )}
              {detail === 'slo' && (
                <>
                  <Metric label="Availability" value={formatValue(overview.data?.slo.availabilityPct ?? null, 'percent')} />
                  <Metric label="SLO target" value={formatValue(overview.data?.slo.targetPct ?? null, 'percent')} />
                  <Metric label="Error-budget burn" value={overview.data?.slo.burnRate == null ? '—' : `${overview.data.slo.burnRate.toFixed(2)}x`} />
                  <Metric label="Budget remaining" value={formatValue(overview.data?.slo.budgetRemainingPct ?? null, 'percent')} />
                </>
              )}
              {detail === 'capacity' && (
                <>
                  <Metric label="Current throughput" value={formatValue(current?.requestRate ?? null, 'rps')} />
                  <Metric label="Last tested throughput" value={formatValue(overview.data?.capacity.testedRps ?? null, 'rps')} />
                  <Metric label="Headroom" value={formatValue(overview.data?.capacity.headroomPct ?? null, 'percent')} />
                  <Metric label="Capacity source" value={overview.data?.capacity.sourceProfile ?? 'No passed run'} />
                </>
              )}
              {detail === 'incidents' && (
                <>
                  <Metric label="Alerting instances" value={overview.data?.alertStates.alerting ?? 0} />
                  <Metric label="Critical unresolved issues" value={overview.data?.issues.critical ?? 0} />
                  <Metric label="All unresolved issues" value={overview.data?.issues.unresolved ?? 0} />
                  <Metric
                    label="Oldest unresolved"
                    value={overview.data?.issues.oldestUnresolvedAt ? formatRelative(Date.parse(overview.data.issues.oldestUnresolvedAt)) : '—'}
                  />
                </>
              )}
              {detail === 'changes' && (
                <>
                  <Metric label="Latest annotation" value={latestChange?.title ?? 'None'} />
                  <Metric label="Change type" value={latestChange?.kind ?? '—'} />
                  <Metric label="Error rate now" value={formatValue(current?.errorRate ?? null, 'percent')} />
                  <Metric label="Previous error rate" value={formatValue(previous?.errorRate ?? null, 'percent')} />
                </>
              )}
            </div>
            <p className="text-xs text-[var(--text-muted)]">{DETAIL_NOTE[detail]}</p>
          </>
        )}
      </Modal>

      {dashboard.data ? (
        <DashboardView model={dashboard.data.dashboard.model} range={range} refreshMs={refreshMs} live={live} annotations={annotations.data?.annotations ?? []} />
      ) : (
        <EmptyNote>{dashboard.error ? dashboard.error : 'Loading dashboard…'}</EmptyNote>
      )}

      <Card
        className="mt-3"
        title="Issues"
        actions={
          <button type="button" onClick={() => navigate('/vitals/issues')} className={cn(buttonClass('secondary'), 'py-1.5 text-xs')}>
            Open Issues <ChevronRight className="h-3.5 w-3.5" />
          </button>
        }
        note="Errors are grouped by fingerprint: explicit fingerprint first, then application stack frames, then exception type, then message."
      >
        <div className="flex gap-8 px-1 py-2">
          <div>
            <div className="text-2xl font-bold text-[var(--text-primary)]">{overview.data?.issues.unresolved ?? '—'}</div>
            <div className="text-xs text-[var(--text-muted)]">Unresolved</div>
          </div>
          <div>
            <div className="text-2xl font-bold text-[var(--text-primary)]">{overview.data?.issues.newToday ?? '—'}</div>
            <div className="text-xs text-[var(--text-muted)]">New in 24h</div>
          </div>
        </div>
        {annotations.data && annotations.data.annotations.length > 0 && (
          <>
            <div className="mt-2 text-xs font-medium text-[var(--text-muted)]">Recent annotations</div>
            {annotations.data.annotations.slice(0, 4).map((annotation) => (
              <div key={annotation.id} className="flex items-center gap-3 border-b border-[var(--border)] py-1 text-xs">
                <span className="font-mono text-[var(--text-muted)]">{annotation.kind}</span>
                <span className="text-[var(--text-muted)]">{formatRelative(annotation.startedAt)}</span>
                <span className="truncate">{annotation.title}</span>
              </div>
            ))}
          </>
        )}
      </Card>
    </VitalsShell>
  );
}
