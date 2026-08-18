/** Time expressions and rollup selection, matching the observability store's own bucket tables. */

const UNIT_MS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

const RELATIVE = /^now(?:-(\d+)([smhdw]))?$/;

/** "now", "now-15m", an ISO timestamp, or epoch millis. */
export const parseTimeExpression = (value: string | undefined, fallback: number): number => {
  if (!value) return fallback;
  const trimmed = value.trim();
  const relative = RELATIVE.exec(trimmed);
  if (relative) {
    if (!relative[1]) return Date.now();
    return Date.now() - Number(relative[1]) * (UNIT_MS[relative[2] ?? 'm'] ?? 60_000);
  }
  const numeric = Number(trimmed);
  if (Number.isFinite(numeric) && trimmed !== '') return numeric;
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export type Resolution = '10s' | '1m' | '1h';

/** Whitelist — these names are interpolated into SQL, so they may never come from a request. */
export const RESOLUTION_TABLE: Record<Resolution, string> = {
  '10s': 'metric_sample_10s',
  '1m': 'metric_sample_1m',
  '1h': 'metric_sample_1h',
};

export const RESOLUTION_MS: Record<Resolution, number> = { '10s': 10_000, '1m': 60_000, '1h': 3_600_000 };

/** Finest resolution that keeps the response under maxPoints. */
export const pickResolution = (fromMs: number, toMs: number, maxPoints = 600): Resolution => {
  const span = Math.max(toMs - fromMs, 1);
  for (const resolution of ['10s', '1m', '1h'] as const) {
    if (span / RESOLUTION_MS[resolution] <= maxPoints) return resolution;
  }
  return '1h';
};

export const resolveRange = (from?: string, to?: string, maxPoints?: number) => {
  const toMs = parseTimeExpression(to, Date.now());
  const fromMs = parseTimeExpression(from, toMs - 3_600_000);
  const safeFrom = Math.min(fromMs, toMs - 1_000);
  const resolution = pickResolution(safeFrom, toMs, maxPoints);
  return { fromMs: safeFrom, toMs, resolution, stepMs: RESOLUTION_MS[resolution] };
};
