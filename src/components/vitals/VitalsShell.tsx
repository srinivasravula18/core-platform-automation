/**
 * Shared frame for every Vitals page: the page header, the time-range/refresh/live controls that all
 * nine pages read from, and the gate that explains itself when no observability endpoint is
 * connected yet instead of showing nine empty screens.
 */

import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Database, Pause, Play } from 'lucide-react';
import AgentPanel from './AgentPanel';
import { cn } from '@/src/lib/utils';
import { useVitalsView, type TimeRange } from '@/src/lib/vitals/hooks';
import { vitals, type FleetResponse, type VitalsStatus } from '@/src/lib/vitals/api';
import { STATUS } from '@/src/lib/vitals/theme';
import { Banner, Card, PageHeader, StatusDot, buttonClass, inputClass } from './ui';

export const RANGE_PRESETS: { label: string; from: string; to: string }[] = [
  { label: '5m', from: 'now-5m', to: 'now' },
  { label: '15m', from: 'now-15m', to: 'now' },
  { label: '1h', from: 'now-1h', to: 'now' },
  { label: '6h', from: 'now-6h', to: 'now' },
  { label: '24h', from: 'now-24h', to: 'now' },
  { label: '7d', from: 'now-7d', to: 'now' },
  { label: '30d', from: 'now-30d', to: 'now' },
];

const REFRESH_OPTIONS: { label: string; ms: number }[] = [
  { label: 'Off', ms: 0 },
  { label: '5s', ms: 5_000 },
  { label: '10s', ms: 10_000 },
  { label: '30s', ms: 30_000 },
  { label: '1m', ms: 60_000 },
];

/** Time range, refresh interval and a live/paused toggle — the operator's control trio. */
export function TimeControls({ range, onRangeChange }: { range: TimeRange; onRangeChange: (range: TimeRange) => void }) {
  const { refreshMs, live, setRefreshMs, setLive } = useVitalsView();
  return (
    <>
      <div className="inline-flex overflow-hidden rounded-md border border-[var(--border)]" role="group" aria-label="Time range">
        {RANGE_PRESETS.map((preset) => {
          const active = range.from === preset.from && range.to === preset.to;
          return (
            <button
              key={preset.label}
              type="button"
              aria-pressed={active}
              onClick={() => onRangeChange({ from: preset.from, to: preset.to })}
              className={cn(
                'px-2.5 py-1.5 text-xs font-medium transition-colors',
                active ? 'bg-[var(--accent)] text-white' : 'text-[var(--text-muted)] hover:bg-[var(--bg-secondary)]',
              )}
            >
              {preset.label}
            </button>
          );
        })}
      </div>
      <select
        aria-label="Refresh interval"
        value={String(refreshMs)}
        onChange={(event) => setRefreshMs(Number(event.target.value))}
        className={cn(inputClass, 'w-auto py-1.5')}
      >
        {REFRESH_OPTIONS.map((option) => (
          <option key={option.label} value={option.ms}>
            {option.ms === 0 ? 'No refresh' : `Every ${option.label}`}
          </option>
        ))}
      </select>
      <button type="button" aria-pressed={live} onClick={() => setLive(!live)} className={buttonClass('secondary', 'py-1.5')} title={live ? 'Pause auto-refresh' : 'Resume auto-refresh'}>
        {live ? <Play className="h-3.5 w-3.5" style={{ color: STATUS.good }} /> : <Pause className="h-3.5 w-3.5 text-[var(--text-muted)]" />}
        {live ? 'Live' : 'Paused'}
      </button>
    </>
  );
}

function ScopeControl() {
  const { scope, setScope } = useVitalsView();
  const [fleet, setFleet] = useState<FleetResponse | null>(null);

  useEffect(() => { vitals.fleet().then(setFleet).catch(() => setFleet(null)); }, []);

  const options = [
    ...(fleet?.servers.map((server) => ({ value: `server:${server.name}`, label: `Server · ${server.name}` })) ?? []),
    ...(fleet?.environments.map((sandbox) => ({ value: `sandbox:${sandbox.name}`, label: `Sandbox · ${sandbox.name}` })) ?? []),
  ];
  const value = scope.kind === 'all' ? 'all:' : `${scope.kind}:${scope.value}`;

  return (
    <select aria-label="Metric scope" title="Filter every Vitals metric panel" value={value}
      onChange={(event) => {
        const [kind, ...parts] = event.target.value.split(':');
        setScope({ kind: kind as 'all' | 'server' | 'sandbox', value: parts.join(':') });
      }} className={cn(inputClass, 'w-auto max-w-56 py-1.5')}>
      <option value="all:">Whole fleet</option>
      {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>
  );
}

export function NotConnected({ message }: { message?: string }) {
  return (
    <Card className="max-w-2xl">
      <div className="flex flex-col items-start gap-3 py-4">
        <Database className="h-8 w-8 text-[var(--accent)]" />
        <h2 className="text-lg font-semibold text-[var(--text-primary)]">Vitals cannot read the observability store</h2>
        <p className="text-sm text-[var(--text-muted)]">{message}</p>
        <p className="text-xs text-[var(--text-muted)]">
          Point Vitals at the database holding the <code className="font-mono">obs</code> schema. No restart and no environment variable
          needed — it takes effect as soon as it is saved.
        </p>
        <Link to="/vitals/connect" className="text-sm font-medium text-[var(--accent)] hover:underline">
          Open Connect →
        </Link>
      </div>
    </Card>
  );
}

export default function VitalsShell({
  title,
  subtitle,
  actions,
  showTimeControls = true,
  requiresConnection = true,
  showAgent = true,
  children,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  showTimeControls?: boolean;
  requiresConnection?: boolean;
  /** Off for pages with no window to reason about, such as Connect and Docs. */
  showAgent?: boolean;
  children: ReactNode;
}) {
  const { range, setRange, scope } = useVitalsView();
  const [store, setStore] = useState<VitalsStatus | null>(null);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    vitals
      .status()
      .then(setStore)
      .catch(() => setStore(null))
      .finally(() => setChecked(true));
  }, []);

  const blocked = requiresConnection && checked && !(store?.configured && store?.reachable && store?.schemaPresent);

  return (
    <div className="app-page-shell flex h-full flex-col">
      <PageHeader
        title={title}
        subtitle={subtitle}
        actions={
          <>
            {showTimeControls && !blocked && <ScopeControl />}
            {showTimeControls && !blocked && <TimeControls range={range} onRangeChange={setRange} />}
            {showAgent && !blocked && <AgentPanel range={range} scope={scope} />}
            {actions}
          </>
        }
      />

      <div className="min-h-0 flex-1 overflow-auto pb-6">
        {!checked && requiresConnection ? (
          <div className="flex items-center gap-2 py-10 text-sm text-[var(--text-muted)]">
            <StatusDot color={STATUS.warning} /> Reading the observability store…
          </div>
        ) : blocked ? (
          <NotConnected message={store?.message} />
        ) : (
          children
        )}
      </div>
    </div>
  );
}
