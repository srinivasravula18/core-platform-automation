/** Relative timestamps: "just now", "5 min ago", "in 3h". Ported from Dashboard's helper so it
 *  stays the single implementation. Handles past AND future. */
export function relativeTime(iso?: string | null): string {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const deltaMs = Date.now() - then;
  const future = deltaMs < 0;
  const s = Math.floor(Math.abs(deltaMs) / 1000);
  const fmt = (n: number, unit: string) => (future ? `in ${n} ${unit}` : `${n} ${unit} ago`);
  if (s < 45) return future ? 'in a moment' : 'just now';
  const m = Math.floor(s / 60); if (m < 60) return fmt(m || 1, 'min');
  const h = Math.floor(m / 60); if (h < 24) return future ? `in ${h}h` : `${h}h ago`;
  const d = Math.floor(h / 24); if (d < 7) return future ? `in ${d}d` : `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}
