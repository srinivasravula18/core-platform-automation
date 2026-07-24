/** Reusable timestamp sort presets for entity tables (Phase 2 consumes these). A record is expected
 *  to expose createdAt/updatedAt (top-level or under `metadata`). */

export type TimeSortKey = 'recentlyUpdated' | 'oldestUpdated' | 'newestCreated' | 'oldestCreated';

export const TIME_SORT_LABELS: Record<TimeSortKey, string> = {
  recentlyUpdated: 'Recently updated',
  oldestUpdated: 'Least recently updated',
  newestCreated: 'Newest first',
  oldestCreated: 'Oldest first',
};

function ms(iso?: string | null): number {
  const t = iso ? new Date(iso).getTime() : NaN;
  return Number.isNaN(t) ? 0 : t;
}
function createdAt(r: any): string | null { return r?.createdAt ?? r?.metadata?.createdAt ?? null; }
function updatedAt(r: any): string | null { return r?.updatedAt ?? r?.metadata?.updatedAt ?? createdAt(r); }

/** Return a NEW sorted array by the given preset (does not mutate input). */
export function sortByTime<T>(rows: T[], key: TimeSortKey): T[] {
  const arr = [...rows];
  arr.sort((a, b) => {
    switch (key) {
      case 'recentlyUpdated': return ms(updatedAt(b)) - ms(updatedAt(a));
      case 'oldestUpdated':   return ms(updatedAt(a)) - ms(updatedAt(b));
      case 'newestCreated':   return ms(createdAt(b)) - ms(createdAt(a));
      case 'oldestCreated':   return ms(createdAt(a)) - ms(createdAt(b));
    }
  });
  return arr;
}
