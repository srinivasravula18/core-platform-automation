import { ArrowUpDown } from 'lucide-react';
import { type TimeSortKey, TIME_SORT_LABELS } from '@/src/lib/time';

/** Reusable timestamp sort control for entity tables (Phase 2, improvement #4). Pair with
 *  `sortByTime(rows, value)` from lib/time to order the displayed list. */
export function TimeSortSelect({
  value,
  onChange,
  className = '',
}: {
  value: TimeSortKey;
  onChange: (v: TimeSortKey) => void;
  className?: string;
}) {
  const order: TimeSortKey[] = ['recentlyUpdated', 'oldestUpdated', 'newestCreated', 'oldestCreated'];
  return (
    <div className={`relative inline-flex items-center ${className}`}>
      <ArrowUpDown className="pointer-events-none absolute left-2.5 h-4 w-4 text-[var(--text-muted)]" />
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as TimeSortKey)}
        title="Sort by time"
        className="appearance-none rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] py-2 pl-8 pr-6 text-sm text-[var(--text-primary)] outline-none transition-colors hover:border-[var(--accent)] focus:border-[var(--accent)]"
      >
        {order.map((k) => (
          <option key={k} value={k}>{TIME_SORT_LABELS[k]}</option>
        ))}
      </select>
    </div>
  );
}
