import { useState } from 'react';
import { CalendarClock, ChevronDown } from 'lucide-react';
import { type TimeRangeKey, rangeBounds } from '@/src/lib/time';

/** A reusable "updated within" time filter used across every list page (Phase 2, improvement #5).
 *  Emits a preset key, or a custom [startMs, endMs] range. Filtering logic lives in lib/time. */
export interface TimeFilterValue {
  key: TimeRangeKey | 'custom';
  customFrom?: string; // yyyy-mm-dd
  customTo?: string;   // yyyy-mm-dd
}

const PRESETS: Array<{ key: TimeRangeKey; label: string }> = [
  { key: 'all', label: 'Any time' },
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: 'last7', label: 'Last 7 days' },
  { key: 'last30', label: 'Last 30 days' },
];

export function timeFilterLabel(v: TimeFilterValue): string {
  if (v.key === 'custom') return 'Custom range';
  return PRESETS.find((p) => p.key === v.key)?.label || 'Any time';
}

/** True when `iso` passes the given filter value. Reusable predicate for a page's row filter. */
export function passesTimeFilter(iso: string | null | undefined, v: TimeFilterValue, now = Date.now()): boolean {
  if (v.key === 'custom') {
    if (!iso) return false;
    const t = new Date(iso).getTime();
    if (Number.isNaN(t)) return false;
    const from = v.customFrom ? new Date(`${v.customFrom}T00:00:00`).getTime() : -Infinity;
    const to = v.customTo ? new Date(`${v.customTo}T23:59:59.999`).getTime() : Infinity;
    return t >= from && t <= to;
  }
  if (v.key === 'all') return true;
  const b = rangeBounds(v.key, now);
  if (!b) return true;
  if (!iso) return false;
  const t = new Date(iso).getTime();
  return !Number.isNaN(t) && t >= b[0] && t <= b[1];
}

export function TimeRangeFilter({
  value,
  onChange,
  label = 'Updated',
  className = '',
}: {
  value: TimeFilterValue;
  onChange: (v: TimeFilterValue) => void;
  label?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const active = value.key !== 'all';
  return (
    <div className={`relative ${className}`}>
      <button
        onClick={() => setOpen((o) => !o)}
        className={`flex items-center gap-1.5 rounded-md border px-3 py-2 text-sm transition-colors ${active ? 'border-[var(--accent)] text-[var(--accent)]' : 'border-[var(--border)] text-[var(--text-primary)] hover:border-[var(--accent)]'}`}
      >
        <CalendarClock className="h-4 w-4" /> {label}: {timeFilterLabel(value)}
        <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-50 mt-1 w-56 overflow-hidden rounded-md border border-[var(--border)] bg-[var(--bg-card)] p-1 shadow-lg">
            {PRESETS.map((p) => (
              <button
                key={p.key}
                onClick={() => { onChange({ key: p.key }); setOpen(false); }}
                className={`block w-full rounded px-3 py-2 text-left text-sm hover:bg-[var(--bg-secondary)] ${value.key === p.key ? 'text-[var(--accent)]' : 'text-[var(--text-primary)]'}`}
              >
                {p.label}
              </button>
            ))}
            <div className="border-t border-[var(--border)] p-2">
              <div className="mb-1 text-xs font-medium text-[var(--text-muted)]">Custom range</div>
              <div className="flex items-center gap-1.5">
                <input
                  type="date"
                  value={value.customFrom || ''}
                  onChange={(e) => onChange({ key: 'custom', customFrom: e.target.value, customTo: value.customTo })}
                  className="w-full rounded border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1 text-xs text-[var(--text-primary)]"
                />
                <span className="text-xs text-[var(--text-muted)]">to</span>
                <input
                  type="date"
                  value={value.customTo || ''}
                  onChange={(e) => onChange({ key: 'custom', customFrom: value.customFrom, customTo: e.target.value })}
                  className="w-full rounded border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1 text-xs text-[var(--text-primary)]"
                />
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
