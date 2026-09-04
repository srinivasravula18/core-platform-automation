export const COVERAGE_BADGE: Record<string, { label: string; cls: string }> = {
  covered: { label: 'Covered', cls: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400' },
  partial: { label: 'Partial', cls: 'border-amber-500/30 bg-amber-500/10 text-amber-400' },
  'gaps-proposed': { label: 'Gaps Proposed', cls: 'border-sky-500/30 bg-sky-500/10 text-sky-400' },
  none: { label: 'No Coverage', cls: 'border-rose-500/30 bg-rose-500/10 text-rose-400' },
  unknown: { label: 'Unknown', cls: 'border-slate-500/30 bg-slate-500/10 text-slate-400' },
};
