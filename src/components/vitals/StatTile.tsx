import { ArrowDown, ArrowRight, ArrowUp } from 'lucide-react';
import { cn } from '@/src/lib/utils';
import { formatValue, type Unit } from '@/src/lib/vitals/format';
import { STATUS, type StatusLevel } from '@/src/lib/vitals/theme';
import { Sparkline } from './charts';
import { StatusDot } from './ui';

const STATUS_LABEL: Record<StatusLevel, string> = {
  good: 'healthy',
  warning: 'warning',
  serious: 'degraded',
  critical: 'critical',
};

type Props = {
  label: string;
  value: number | null;
  unit: Unit;
  previous?: number | null;
  tone?: StatusLevel;
  spark?: [number, number | null][];
  /** Lower is better for latency and error rate; higher is better for throughput. */
  improvement?: 'lower' | 'higher' | 'neutral';
  hint?: string;
  onClick?: () => void;
};

const delta = (value: number | null, previous: number | null | undefined, improvement: Props['improvement']) => {
  if (value === null || previous === null || previous === undefined || previous === 0) return null;
  const change = ((value - previous) / Math.abs(previous)) * 100;
  if (!Number.isFinite(change) || Math.abs(change) < 0.5) return { text: 'no change', better: null, direction: 'flat' as const };
  // The arrow shows which way the number moved; the word says whether that is good.
  const better = improvement === 'neutral' || !improvement ? null : improvement === 'lower' ? change < 0 : change > 0;
  return {
    text: `${change > 0 ? '+' : ''}${change.toFixed(0)}% vs previous window`,
    better,
    direction: change > 0 ? ('up' as const) : ('down' as const),
  };
};

/** A stat tile carries a dot plus a written status — never colour alone. */
export default function StatTile({ label, value, unit, previous, tone = 'good', spark, improvement = 'neutral', hint, onClick }: Props) {
  const change = delta(value, previous, improvement);
  const Arrow = change?.direction === 'up' ? ArrowUp : change?.direction === 'down' ? ArrowDown : ArrowRight;
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex h-full w-full min-w-0 flex-col gap-1 rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-4 text-left shadow-sm transition-colors',
        'hover:border-[var(--accent)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]',
      )}
    >
      <span className="flex items-center gap-1.5 text-xs font-medium text-[var(--text-muted)]">
        {value === null ? null : <StatusDot color={STATUS[tone]} />}
        {label}
        <span className="sr-only">{value === null ? 'no data' : STATUS_LABEL[tone]}</span>
      </span>
      <span className="text-2xl font-bold tracking-tight text-[var(--text-primary)]">{formatValue(value, unit)}</span>
      {change ? (
        <span
          className="flex items-center gap-1 text-[11.5px]"
          style={{ color: change.better === null ? undefined : change.better ? STATUS.good : STATUS.critical }}
        >
          <Arrow className="h-3 w-3 shrink-0" />
          {change.better === null ? 'changed' : change.better ? 'better' : 'worse'} · {change.text}
        </span>
      ) : (
        <span className="text-[11.5px] text-[var(--text-muted)]">{value === null ? 'No data' : (hint ?? STATUS_LABEL[tone])}</span>
      )}
      {spark && spark.length > 0 ? (
        <div className="mt-1 h-[34px]">
          <Sparkline points={spark} tone={tone === 'good' ? undefined : tone} />
        </div>
      ) : null}
    </button>
  );
}
