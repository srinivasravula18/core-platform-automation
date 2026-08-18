import { useMemo, useState } from 'react';
import { Modal } from '@/src/components/Modal';
import { cn } from '@/src/lib/utils';
import { vitals, type RunRow } from '@/src/lib/vitals/api';
import { usePolled, useVitalsView } from '@/src/lib/vitals/hooks';
import { formatDateTime, formatDuration, formatMs, formatNumber } from '@/src/lib/vitals/format';
import { STATUS } from '@/src/lib/vitals/theme';
import DashboardView from '@/src/components/vitals/DashboardView';
import VitalsShell from '@/src/components/vitals/VitalsShell';
import {
  Banner,
  Card,
  Chip,
  EmptyNote,
  StatusDot,
  TableFrame,
  Thead,
  buttonClass,
  rowClass,
  tdClass,
  tdMainClass,
  tdNumClass,
  thClass,
  thNumClass,
} from '@/src/components/vitals/ui';

const STATUS_TONE: Record<string, string | undefined> = {
  passed: STATUS.good,
  failed: STATUS.critical,
  aborted: STATUS.serious,
  running: STATUS.warning,
};

function RunSummaryTable({ run }: { run: RunRow }) {
  const summary = run.summary;
  if (!summary) return <EmptyNote>No summary captured for this run.</EmptyNote>;

  if (summary.security) {
    const security = summary.security;
    return (
      <>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {(['high', 'medium', 'low', 'informational'] as const).map((risk) => (
            <div key={risk}>
              <div className="text-xs capitalize text-[var(--text-muted)]">{risk}</div>
              <div className="text-lg font-semibold tabular-nums text-[var(--text-primary)]">{security.counts[risk]}</div>
            </div>
          ))}
        </div>
        <TableFrame className="mt-3 max-h-[32rem]">
          <Thead>
            <tr>
              <th className={thClass}>Risk</th>
              <th className={thClass}>Finding</th>
              <th className={thClass}>URL</th>
              <th className={thNumClass}>Instances</th>
              <th className={thClass}>CWE</th>
            </tr>
          </Thead>
          <tbody>
            {security.findings.map((finding, index) => (
              <tr key={`${finding.name}-${finding.url}-${index}`} className={rowClass}>
                <td className={tdClass}>
                  <Chip>{finding.risk}</Chip>
                </td>
                <td className={tdMainClass}>
                  <strong className="block truncate text-[var(--text-primary)]">{finding.name}</strong>
                  {finding.solution && <div className="truncate text-xs text-[var(--text-muted)]">{finding.solution}</div>}
                </td>
                <td className={cn(tdClass, 'break-all font-mono text-xs')}>{finding.url}</td>
                <td className={tdNumClass}>{finding.instances}</td>
                <td className={cn(tdClass, 'font-mono text-xs')}>{finding.cweId ?? '—'}</td>
              </tr>
            ))}
            {security.findings.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-8 text-center text-sm text-[var(--text-muted)]">
                  No findings reported.
                </td>
              </tr>
            )}
          </tbody>
        </TableFrame>
        {security.truncated && <p className="mt-2 text-xs text-[var(--text-muted)]">Showing the first 100 findings; the run log has the rest.</p>}
      </>
    );
  }

  const cells = [
    { label: 'Requests', value: formatNumber(summary.requests, 0) },
    { label: 'Throughput', value: summary.throughputRps === null ? '—' : `${summary.throughputRps.toFixed(1)}/s` },
    { label: 'Peak VUs', value: formatNumber(summary.maxVus, 0) },
    { label: 'p50', value: formatMs(summary.p50Ms) },
    { label: 'p95', value: formatMs(summary.p95Ms) },
    { label: 'p99', value: formatMs(summary.p99Ms) },
    { label: 'Max', value: formatMs(summary.maxMs) },
    { label: 'Error rate', value: summary.errorRatePct === null ? '—' : `${summary.errorRatePct.toFixed(2)}%` },
  ];

  return (
    <>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-8">
        {cells.map((cell) => (
          <div key={cell.label}>
            <div className="text-xs text-[var(--text-muted)]">{cell.label}</div>
            <div className="text-lg font-semibold tabular-nums text-[var(--text-primary)]">{cell.value}</div>
          </div>
        ))}
      </div>
      {run.verdict && (
        <TableFrame className="mt-3">
          <Thead>
            <tr>
              <th className={thClass}>Threshold</th>
              <th className={thClass}>Expected</th>
              <th className={thClass}>Actual</th>
              <th className={thClass}>Result</th>
            </tr>
          </Thead>
          <tbody>
            {run.verdict.checks.map((check) => (
              <tr key={check.label} className={rowClass}>
                <td className={tdMainClass}>{check.label}</td>
                <td className={cn(tdClass, 'font-mono text-xs')}>{check.expected}</td>
                <td className={cn(tdClass, 'font-mono text-xs')}>{check.actual}</td>
                <td className={cn(tdClass, 'font-semibold')} style={{ color: check.passed ? STATUS.good : STATUS.critical }}>
                  {check.passed ? 'pass' : 'fail'}
                </td>
              </tr>
            ))}
          </tbody>
        </TableFrame>
      )}
    </>
  );
}

function RunLog({ runId }: { runId: string }) {
  const detail = usePolled(() => vitals.run(runId), [runId], 0, false);
  const logs = detail.data?.logs ?? [];
  if (logs.length === 0) return <EmptyNote>No log lines were recorded for this run.</EmptyNote>;
  return (
    <div className="h-80 overflow-auto rounded-md border border-[var(--border)] bg-slate-950 px-3 py-2.5 font-mono text-xs leading-relaxed text-slate-300">
      {logs.map((line) => (
        <div key={line.seq} className={cn(line.stream === 'stderr' && 'text-amber-400', line.stream === 'system' && 'text-sky-400')}>
          <span className="mr-2.5 select-none text-slate-600">{String(line.seq).padStart(4, '0')}</span>
          {line.line}
        </div>
      ))}
    </div>
  );
}

export default function VitalsLoadLab() {
  const { refreshMs, live } = useVitalsView();
  const history = usePolled(() => vitals.runs(50), [], refreshMs || 30_000, live);
  const dashboard = usePolled(() => vitals.dashboard('load-lab-live'), [], 0, false);
  const [openRunId, setOpenRunId] = useState<string | null>(null);
  const [detailTab, setDetailTab] = useState<'summary' | 'log'>('summary');

  const runs = history.data?.runs ?? [];
  const openIndex = runs.findIndex((run) => run.id === openRunId);
  const openRun = openIndex >= 0 ? runs[openIndex] : null;

  const stats = useMemo(() => {
    const passed = runs.filter((run) => run.status === 'passed').length;
    const failed = runs.filter((run) => run.status === 'failed').length;
    const best = runs
      .map((run) => run.summary?.throughputRps ?? null)
      .filter((value): value is number => value !== null)
      .sort((a, b) => b - a)[0];
    return { passed, failed, best: best ?? null };
  }, [runs]);

  return (
    <VitalsShell
      title="Load Lab"
      subtitle="Every load and security run the monitored product has recorded, with its summary, verdict and the resources it consumed."
    >
      <Banner tone="info">
        Runs are started by the monitored product's own console, which owns the profile scripts and the target allowlist. Vitals reports what
        each run left behind.
      </Banner>

      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          { label: 'Recorded runs', value: String(runs.length), color: undefined as string | undefined },
          { label: 'Passed', value: String(stats.passed), color: STATUS.good },
          { label: 'Failed', value: String(stats.failed), color: STATUS.critical },
          { label: 'Best throughput', value: stats.best === null ? '—' : `${stats.best.toFixed(1)}/s`, color: undefined },
        ].map((tile) => (
          <div key={tile.label} className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-4 shadow-sm">
            <span className="flex items-center gap-1.5 text-xs font-medium text-[var(--text-muted)]">
              {tile.color && <StatusDot color={tile.color} />}
              {tile.label}
            </span>
            <div className="mt-1 text-2xl font-bold text-[var(--text-primary)]">{tile.value}</div>
          </div>
        ))}
      </div>

      <Card title="Run history" note="Select a run to see its summary, verdict, log and the resource window it ran in.">
        <TableFrame fixed className="max-h-[calc(100vh-24rem)]">
          <Thead>
            <tr>
              <th className={thClass}>Profile</th>
              <th className={cn(thClass, 'w-28')}>Status</th>
              <th className={cn(thClass, 'w-44')}>Started</th>
              <th className={cn(thClass, 'w-24')}>Duration</th>
              <th className={cn(thNumClass, 'w-24')}>p95</th>
              <th className={cn(thNumClass, 'w-24')}>Errors</th>
              <th className={cn(thClass, 'w-28')}>By</th>
            </tr>
          </Thead>
          <tbody>
            {runs.map((run) => (
              <tr
                key={run.id}
                className={cn(rowClass, 'cursor-pointer')}
                onClick={() => {
                  setDetailTab('summary');
                  setOpenRunId(run.id);
                }}
              >
                <td className={cn(tdMainClass, 'truncate')}>{run.profile_label}</td>
                <td className={tdClass}>
                  <Chip>
                    {STATUS_TONE[run.status] && <StatusDot color={STATUS_TONE[run.status] as string} />}
                    {run.status}
                  </Chip>
                </td>
                <td className={tdClass}>{formatDateTime(run.started_at)}</td>
                <td className={tdClass}>{formatDuration(run.started_at, run.finished_at)}</td>
                <td className={tdNumClass}>{formatMs(run.summary?.p95Ms ?? null)}</td>
                <td className={tdNumClass}>{run.summary?.errorRatePct == null ? '—' : `${run.summary.errorRatePct.toFixed(1)}%`}</td>
                <td className={tdClass}>{run.triggered_by ?? '—'}</td>
              </tr>
            ))}
            {runs.length === 0 && (
              <tr>
                <td colSpan={7} className="px-3 py-10 text-center text-sm text-[var(--text-muted)]">
                  {history.loading ? 'Loading…' : 'No runs have been recorded yet.'}
                </td>
              </tr>
            )}
          </tbody>
        </TableFrame>
      </Card>

      <Modal
        isOpen={!!openRun}
        onClose={() => setOpenRunId(null)}
        title={
          openRun ? (
            <span className="flex flex-wrap items-center gap-2">
              {openRun.profile_label}
              <Chip>{openRun.status}</Chip>
              <span className="text-xs tabular-nums text-[var(--text-muted)]">
                {openIndex + 1} of {runs.length}
              </span>
            </span>
          ) : (
            ''
          )
        }
        size="report"
        footer={
          openRun ? (
            <div className="flex justify-between">
              <button
                type="button"
                className={buttonClass('secondary')}
                disabled={openIndex <= 0}
                onClick={() => setOpenRunId(runs[openIndex - 1]?.id ?? null)}
              >
                ← Previous run
              </button>
              <button
                type="button"
                className={buttonClass('secondary')}
                disabled={openIndex >= runs.length - 1}
                onClick={() => setOpenRunId(runs[openIndex + 1]?.id ?? null)}
              >
                Next run →
              </button>
            </div>
          ) : undefined
        }
      >
        {openRun && (
          <>
            <div className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--text-muted)]">
              <span>Started {formatDateTime(openRun.started_at)}</span>
              <span>Duration {formatDuration(openRun.started_at, openRun.finished_at)}</span>
              <span>By {openRun.triggered_by ?? '—'}</span>
              {openRun.target_base_url && <span className="font-mono">{openRun.target_base_url}</span>}
            </div>

            <div className="mb-3 flex gap-1 border-b border-[var(--border)]" role="tablist" aria-label="Run detail">
              {(['summary', 'log'] as const).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  role="tab"
                  aria-selected={detailTab === tab}
                  onClick={() => setDetailTab(tab)}
                  className={cn(
                    'border-b-2 px-3 py-2 text-xs font-semibold capitalize transition-colors',
                    detailTab === tab ? 'border-[var(--accent)] text-[var(--text-primary)]' : 'border-transparent text-[var(--text-muted)]',
                  )}
                >
                  {tab}
                </button>
              ))}
            </div>

            {detailTab === 'summary' ? (
              <>
                <RunSummaryTable run={openRun} />
                {dashboard.data && openRun.started_at && (
                  <div className="mt-4">
                    <h4 className="mb-2 text-sm font-semibold text-[var(--text-primary)]">Resources during this run</h4>
                    <DashboardView
                      model={dashboard.data.dashboard.model}
                      range={{ from: openRun.started_at, to: openRun.finished_at ?? 'now' }}
                      refreshMs={0}
                      live={false}
                    />
                  </div>
                )}
              </>
            ) : (
              <RunLog runId={openRun.id} />
            )}
          </>
        )}
      </Modal>
    </VitalsShell>
  );
}
