/**
 * Chart parameters for Vitals. Slot order is the colour-vision-safety mechanism: never cycle past
 * slot 8 — fold the rest into "Other" or facet instead. Status colours are reserved and are never
 * handed to a data series.
 */

import { useTheme } from '@/src/store/theme';

export const CATEGORICAL_LIGHT = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'] as const;

export const CATEGORICAL_DARK = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'] as const;

export const STATUS = {
  good: '#0ca30c',
  warning: '#fab219',
  serious: '#ec835a',
  critical: '#d03b3b',
} as const;

export type StatusLevel = keyof typeof STATUS;

export const CHROME = {
  dark: { grid: '#2c394d', axis: '#47566f', textPrimary: '#f1f5f9', textSecondary: '#a8b3c4', textMuted: '#8b97aa', tooltipBg: '#121b2b' },
  light: { grid: '#e2e8f0', axis: '#cbd5e1', textPrimary: '#0f172a', textSecondary: '#475569', textMuted: '#64748b', tooltipBg: '#ffffff' },
} as const;

export type Mode = 'light' | 'dark';

/** Reads the app's own theme store, so Vitals flips with the rest of the product. */
export const useChartMode = (): Mode => useTheme((state) => state.theme);

export const palette = (mode: Mode) => (mode === 'light' ? CATEGORICAL_LIGHT : CATEGORICAL_DARK);

/** Series identity follows the entity, never its position after filtering. */
export const colorForSeries = (name: string, index: number, mode: Mode): string => {
  const colors = palette(mode);
  const wellKnown: Record<string, number> = {
    '2xx': 2,
    '3xx': 0,
    '4xx': 3,
    '5xx': 7,
    p50: 0,
    p95: 1,
    p99: 7,
    busy: 0,
    idle: 2,
    waiting: 7,
    rss: 0,
    'heap used': 2,
  };
  const slot = wellKnown[name] ?? index;
  return colors[slot % colors.length];
};

export const statusForValue = (
  value: number | null,
  thresholds: { warning: number; critical: number },
  direction: 'higher-is-worse' | 'lower-is-worse' = 'higher-is-worse',
): StatusLevel => {
  if (value === null || !Number.isFinite(value)) return 'good';
  if (direction === 'higher-is-worse') {
    if (value >= thresholds.critical) return 'critical';
    if (value >= thresholds.warning) return 'warning';
    return 'good';
  }
  if (value <= thresholds.critical) return 'critical';
  if (value <= thresholds.warning) return 'warning';
  return 'good';
};
