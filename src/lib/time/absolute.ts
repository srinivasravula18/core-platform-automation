/** Absolute timestamps rendered in the VIEWER's locale + timezone (industry standard: store UTC,
 *  display local). Seconds + timezone are included in precise contexts (Agent Console, tooltips). */
export function absoluteTime(iso?: string | null, opts: { seconds?: boolean; timeZone?: boolean } = {}): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, {
    year: 'numeric', month: 'long', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
    ...(opts.seconds ? { second: '2-digit' } : {}),
    ...(opts.timeZone !== false ? { timeZoneName: 'short' } : {}),
  });
}

/** Date only, e.g. "July 24, 2026". */
export function absoluteDate(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}

/** Clock time, e.g. "10:41:22 PM". */
export function absoluteClock(iso?: string | null, seconds = true): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', ...(seconds ? { second: '2-digit' } : {}) });
}
