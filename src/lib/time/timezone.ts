/** Viewer timezone/locale helpers. Storage is always UTC/ISO; display converts here. */
export function viewerTimeZone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
}

/** UTC rendering for tooltips that must be timezone-unambiguous, e.g. "2026-07-24 22:58:44 UTC". */
export function utcTooltip(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
}
