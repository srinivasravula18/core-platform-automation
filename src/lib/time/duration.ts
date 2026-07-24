/** Human-readable durations for latency / stage timing in the Agent Console execution panel. */
export function humanizeDuration(ms?: number | null): string {
  if (ms == null || Number.isNaN(ms)) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  if (m < 60) return `${m}m ${String(rem).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, '0')}m`;
}

/** Duration between two ISO timestamps, in ms (null when either is missing/invalid). */
export function durationMs(startIso?: string | null, endIso?: string | null): number | null {
  if (!startIso || !endIso) return null;
  const a = new Date(startIso).getTime();
  const b = new Date(endIso).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return b - a;
}
