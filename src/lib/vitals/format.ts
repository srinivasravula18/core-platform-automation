export type Unit = 'ms' | 'bytes' | 'percent' | 'rps' | 'count' | 'short';

export const formatMs = (value: number | null | undefined): string => {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  if (value < 1) return `${value.toFixed(2)} ms`;
  if (value < 1000) return `${Math.round(value)} ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(2)} s`;
  return `${(value / 60_000).toFixed(1)} min`;
};

export const formatBytes = (value: number | null | undefined): string => {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  if (value < 1024) return `${Math.round(value)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let scaled = value / 1024;
  let index = 0;
  while (scaled >= 1024 && index < units.length - 1) {
    scaled /= 1024;
    index += 1;
  }
  return `${scaled < 10 ? scaled.toFixed(2) : scaled < 100 ? scaled.toFixed(1) : Math.round(scaled)} ${units[index]}`;
};

export const formatNumber = (value: number | null | undefined, digits = 1): string => {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(digits)}M`;
  if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(digits)}k`;
  if (Math.abs(value) >= 100) return String(Math.round(value));
  return value.toFixed(Math.abs(value) < 10 ? digits : 0);
};

export const formatValue = (value: number | null | undefined, unit: Unit): string => {
  switch (unit) {
    case 'ms':
      return formatMs(value);
    case 'bytes':
      return formatBytes(value);
    case 'percent':
      return value === null || value === undefined || !Number.isFinite(value) ? '—' : `${value.toFixed(value < 10 ? 1 : 0)}%`;
    case 'rps':
      return value === null || value === undefined || !Number.isFinite(value) ? '—' : `${formatNumber(value, 2)}/s`;
    case 'count':
    case 'short':
    default:
      return formatNumber(value, 0);
  }
};

export const formatClock = (ms: number): string =>
  new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

export const formatDateTime = (value: string | number | null | undefined): string => {
  if (value === null || value === undefined) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
};

export const formatRelative = (value: string | number | null | undefined): string => {
  if (value === null || value === undefined) return '—';
  const then = new Date(value).getTime();
  if (Number.isNaN(then)) return '—';
  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 0) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
};

export const formatDuration = (fromIso: string | null, toIso: string | null): string => {
  if (!fromIso) return '—';
  const from = new Date(fromIso).getTime();
  const to = toIso ? new Date(toIso).getTime() : Date.now();
  const seconds = Math.max(0, Math.round((to - from) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
};
