import { MANUAL_OUTCOMES, type ManualOutcome } from '@/core/shared/manualRun';
import { cn } from '@/src/lib/utils';

// Semantic outcome colors (this is run execution status, distinct from the tag-color removal in Part A).
const OUTCOME_STYLE: Record<string, { dot: string; text: string }> = {
  'Not Run': { dot: 'bg-[var(--text-muted)]', text: 'text-[var(--text-muted)]' },
  Passed: { dot: 'bg-emerald-500', text: 'text-emerald-500' },
  Failed: { dot: 'bg-red-500', text: 'text-red-500' },
  Blocked: { dot: 'bg-indigo-400', text: 'text-indigo-400' },
  Retest: { dot: 'bg-yellow-500', text: 'text-yellow-500' },
  'Not Applicable': { dot: 'bg-slate-400', text: 'text-slate-400' },
  Paused: { dot: 'bg-amber-500', text: 'text-amber-500' },
};

export function outcomeStyle(outcome: string) {
  return OUTCOME_STYLE[outcome] || OUTCOME_STYLE['Not Run'];
}

export function OutcomeDot({ outcome }: { outcome: string }) {
  return <span className={cn('inline-block h-2.5 w-2.5 shrink-0 rounded-full', outcomeStyle(outcome).dot)} />;
}

export function OutcomeSelect({
  value,
  onChange,
  disabled,
  compact,
}: {
  value: string;
  onChange: (outcome: ManualOutcome) => void;
  disabled?: boolean;
  compact?: boolean;
}) {
  const style = outcomeStyle(value);
  return (
    <span className={cn('relative inline-flex items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)]', compact ? 'px-2 py-1' : 'px-2.5 py-1.5')}>
      <OutcomeDot outcome={value} />
      <select
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value as ManualOutcome)}
        className={cn('cursor-pointer appearance-none bg-transparent pr-4 text-sm font-medium outline-none disabled:cursor-not-allowed disabled:opacity-60', style.text)}
        aria-label="Set outcome"
      >
        {MANUAL_OUTCOMES.map((o) => (
          <option key={o} value={o} className="bg-[var(--bg-card)] text-[var(--text-primary)]">{o}</option>
        ))}
      </select>
    </span>
  );
}
