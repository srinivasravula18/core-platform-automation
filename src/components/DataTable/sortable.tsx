import type { ReactNode } from 'react';

export type SortDirection = 'ascending' | 'descending';
export type SortState = { key: string; direction: SortDirection } | null;
type SortValue = string | number | boolean | null | undefined;

export function nextSort(current: SortState, key: string): SortState {
  return current?.key === key && current.direction === 'ascending'
    ? { key, direction: 'descending' }
    : { key, direction: 'ascending' };
}

export function sortRows<T>(rows: T[], sort: SortState, values: Record<string, (row: T) => SortValue>): T[] {
  const value = sort && values[sort.key];
  if (!sort || !value) return rows;
  const direction = sort.direction === 'ascending' ? 1 : -1;
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  return rows.map((row, index) => ({ row, index })).sort((a, b) => {
    const left = value(a.row), right = value(b.row);
    if (left == null || left === '') return right == null || right === '' ? a.index - b.index : direction;
    if (right == null || right === '') return -direction;
    const result = typeof left === 'number' && typeof right === 'number' ? left - right : collator.compare(String(left), String(right));
    return result ? result * direction : a.index - b.index;
  }).map(({ row }) => row);
}

export function SortableHeader({ label, column, sort, onSort, className = '', children }: { label: string; column: string; sort: SortState; onSort: (column: string) => void; className?: string; children?: ReactNode }) {
  const active = sort?.key === column;
  return <th className={className} scope="col" aria-sort={active ? sort.direction : 'none'}><button type="button" onClick={() => onSort(column)} className="flex w-full items-center justify-between gap-2 text-left hover:text-[var(--accent)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]">{children || label}<span aria-hidden="true" className={`ml-auto shrink-0 ${active ? '' : 'opacity-40'}`}>{active && sort.direction === 'descending' ? '↓' : '↑'}</span></button></th>;
}
