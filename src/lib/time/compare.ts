/** Time comparison utilities. Ordering NEVER relies on timestamps alone — events within the same
 *  second are disambiguated by a monotonic `seq` (deterministic ordering, plan foundation C). */

function ms(iso?: string | null): number {
  const t = iso ? new Date(iso).getTime() : NaN;
  return Number.isNaN(t) ? 0 : t;
}

/** Compare two events by (timestamp, seq). Ascending. Use for timelines / logs / event streams. */
export function byTimeThenSeq(
  a: { at?: string | null; seq?: number },
  b: { at?: string | null; seq?: number },
): number {
  const d = ms(a.at) - ms(b.at);
  if (d !== 0) return d;
  return (a.seq ?? 0) - (b.seq ?? 0);
}

/** True when a record has been edited since creation (beyond a small clock-skew threshold). */
export function isEdited(createdAt?: string | null, updatedAt?: string | null, thresholdMs = 2000): boolean {
  if (!createdAt || !updatedAt) return false;
  return ms(updatedAt) - ms(createdAt) > thresholdMs;
}
