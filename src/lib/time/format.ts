/** Shared low-level format helpers used by the <time> element and range filters. */

/** ISO string for a `<time datetime>` attribute (machine-readable, accessible). */
export function datetimeAttr(iso?: string | null): string | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** Named ranges for time filtering (Phase 2 <TimeRangeFilter>). Returns [startMs, endMs] or null. */
export type TimeRangeKey = 'today' | 'yesterday' | 'last7' | 'last30' | 'all';

export function rangeBounds(key: TimeRangeKey, now = Date.now()): [number, number] | null {
  const startOfDay = (t: number) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const day = 86_400_000;
  const today0 = startOfDay(now);
  switch (key) {
    case 'today':     return [today0, now];
    case 'yesterday': return [today0 - day, today0];
    case 'last7':     return [today0 - 6 * day, now];
    case 'last30':    return [today0 - 29 * day, now];
    case 'all':       return null;
  }
}

/** True when `iso` falls inside the named range (or the range is "all"). */
export function inRange(iso: string | null | undefined, key: TimeRangeKey, now = Date.now()): boolean {
  const bounds = rangeBounds(key, now);
  if (!bounds) return true;
  if (!iso) return false;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return false;
  return t >= bounds[0] && t <= bounds[1];
}
