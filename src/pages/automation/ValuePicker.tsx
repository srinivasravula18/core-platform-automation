import { useMemo, useState } from 'react';
import { ChevronRight, Plus, Search } from 'lucide-react';
import { VARIANT_CLS } from './FieldChips';

// The single "where does this field's value come from?" menu. One affordance per field: click ＋,
// pick a column from your imported sheet, or type a fixed value. Values come from your data — no
// generators — so the choice is deliberately small and unambiguous.

type Column = { id: string; name: string };

// Per-field value source picker. onColumn/onFixed apply the pick; the popover self-closes.
export function ValuePicker({ columns, hasDataset, fieldLabel, onColumn, onFixed }: {
  columns: Column[]; hasDataset: boolean; fieldLabel: string;
  onColumn: (column: Column) => void; onFixed: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [fixed, setFixed] = useState('');
  const close = () => { setOpen(false); setQuery(''); setFixed(''); };

  const q = query.trim().toLowerCase();
  const cols = useMemo(() => columns.filter((c) => !q || c.name.toLowerCase().includes(q)), [columns, q]);

  return <div className="relative shrink-0">
    <button type="button" onClick={() => setOpen((v) => !v)} aria-label={`Get value for ${fieldLabel}`}
      className="inline-flex items-center gap-1 rounded-full border border-dashed border-[var(--border)] px-2 py-1 text-[11px] text-[var(--text-muted)] hover:border-[var(--accent)] hover:text-[var(--accent)]">
      <Plus className="h-3 w-3" />Get value from…
    </button>
    {open && <>
      <div className="fixed inset-0 z-30" onClick={close} />
      <div className="absolute right-0 z-40 mt-1 max-h-80 w-72 overflow-hidden rounded-md border border-[var(--border)] bg-[var(--bg-card)] shadow-lg">
        {hasDataset && <label className="relative block border-b border-[var(--border)] p-1.5">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--text-muted)]" />
          <input autoFocus type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search your sheet columns…" aria-label="Search columns"
            className="w-full rounded border border-[var(--border)] bg-[var(--bg-secondary)] py-1.5 pl-8 pr-2 text-sm outline-none focus:border-[var(--accent)]" />
        </label>}
        <div className="max-h-56 overflow-y-auto">
          {hasDataset && <div>
            <div className="px-2 pt-2 text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)]">From your sheet · columns</div>
            <div className="flex flex-wrap gap-1 p-1.5">
              {cols.length ? cols.map((c) => <button key={c.id} type="button" onClick={() => { onColumn(c); close(); }}
                className={`rounded-full border px-2 py-0.5 text-[11px] font-medium hover:opacity-80 ${VARIANT_CLS.column}`}>{c.name}</button>)
                : <span className="px-1 py-0.5 text-[11px] text-[var(--text-muted)]">No matching columns.</span>}
            </div>
          </div>}
          <div className="flex items-center gap-1.5 border-t border-[var(--border)] px-2 py-2 text-[10px] uppercase tracking-wide text-[var(--text-muted)] opacity-60">
            <span className="inline-block h-2 w-2 rounded-full border border-amber-500/50 bg-amber-500/10" />Computed (age from a date, totals) <ChevronRight className="h-3 w-3" /><span className="normal-case">next update</span>
          </div>
        </div>
        <div className="flex items-center gap-1.5 border-t border-[var(--border)] p-1.5">
          <input value={fixed} onChange={(e) => setFixed(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && fixed) { onFixed(fixed); close(); } }}
            placeholder="…or type a fixed value" aria-label="Type a fixed value"
            className="min-w-0 flex-1 rounded border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1 text-xs outline-none focus:border-[var(--accent)]" />
          <button type="button" disabled={!fixed} onClick={() => { onFixed(fixed); close(); }}
            className="shrink-0 rounded border border-[var(--border)] px-2 py-1 text-xs hover:border-[var(--accent)] disabled:opacity-40">Add</button>
        </div>
      </div>
    </>}
  </div>;
}
