export type PlanStartConflict = 'missing-dates' | 'invalid-range' | 'future-start' | 'past-end' | null;

export function localDateKey(now = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function planStartConflict(
  plan: { startDate?: string | null; endDate?: string | null },
  today = localDateKey(),
): PlanStartConflict {
  const startDate = String(plan.startDate || '').slice(0, 10);
  const endDate = String(plan.endDate || '').slice(0, 10);
  if (!startDate || !endDate) return 'missing-dates';
  if (endDate < startDate) return 'invalid-range';
  if (startDate > today) return 'future-start';
  if (endDate < today) return 'past-end';
  return null;
}
