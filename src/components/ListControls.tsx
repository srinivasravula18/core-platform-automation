import { Filter, Search } from 'lucide-react';
import { SortableHeaders, type SortState } from '@/src/components/DataTable/sortable';
import { cn } from '@/src/lib/utils';

export function ListSearchInput({ value, onChange, placeholder, className }: { value: string; onChange: (value: string) => void; placeholder: string; className?: string }) {
  return (
    <div className="relative flex-1 max-w-sm">
      <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-muted)]" />
      <input type="text" value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} aria-label={placeholder} className={cn('w-full rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] py-1.5 pl-9 pr-4 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent)]', className)} />
    </div>
  );
}

export function FilterToggleButton({ open, count, onToggle }: { open: boolean; count: number; onToggle: () => void }) {
  return (
    <button onClick={onToggle} aria-expanded={open} className="flex items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-1.5 text-sm text-[var(--text-primary)] transition-colors hover:bg-[var(--border)]">
      <Filter className="h-4 w-4" /> Filters
      {count > 0 && <span className="rounded-full bg-[var(--accent)] px-1.5 text-[11px] font-semibold text-white">{count}</span>}
    </button>
  );
}

export function SelectableTableHead({ allSelected, onToggleAll, columns, sort, onSort, actionsClassName }: {
  allSelected: boolean;
  onToggleAll: () => void;
  columns: Array<{ label: string; column: string; className?: string }>;
  sort: SortState;
  onSort: (column: string) => void;
  actionsClassName: string;
}) {
  return (
    <thead className="sticky top-0 z-10 border-b border-[var(--border)] bg-[var(--bg-secondary)]">
      <tr className="text-[var(--text-muted)]">
        <th className="w-10 px-4 py-3 font-medium"><input type="checkbox" aria-label="Select all rows" checked={allSelected} onChange={onToggleAll} /></th>
        <SortableHeaders columns={columns} sort={sort} onSort={onSort} />
        <th className={actionsClassName}>Actions</th>
      </tr>
    </thead>
  );
}
