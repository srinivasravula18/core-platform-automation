export type PlanStartConflict = 'missing-dates' | 'invalid-range' | 'future-start' | 'past-end' | null;

export function localDateKey(now = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function normalizeDateKey(value: unknown): string {
  if (!value) return '';
  return value instanceof Date ? localDateKey(value) : String(value).slice(0, 10);
}

export function planStartConflict(
  plan: { startDate?: string | null; endDate?: string | null },
  today = localDateKey(),
): PlanStartConflict {
  const startDate = normalizeDateKey(plan.startDate);
  const endDate = normalizeDateKey(plan.endDate);
  if (!startDate || !endDate) return 'missing-dates';
  if (endDate < startDate) return 'invalid-range';
  if (startDate > today) return 'future-start';
  if (endDate < today) return 'past-end';
  return null;
}
