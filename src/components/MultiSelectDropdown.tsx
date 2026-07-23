import { useEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';

export function MultiSelectDropdown({
  label,
  options,
  value,
  onChange,
  className = '',
}: {
  label: string;
  options: Array<{ id: string; name: string }>;
  value: string[];
  onChange: (ids: string[]) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState(value);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => setSelected(value), [value]);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);

  const toggle = (id: string) => setSelected((current) => {
    const next = current.includes(id) ? current.filter((item) => item !== id) : [...current, id];
    onChange(next);
    return next;
  });
  const selectedName = selected.length === 1 ? options.find((option) => option.id === selected[0])?.name : '';
  const summary = selectedName || (selected.length ? `${selected.length} selected` : label);

  return (
    <div ref={ref} className={`relative ${className}`} onClick={(event) => event.stopPropagation()}>
      <button type="button" onClick={() => setOpen((current) => !current)} className="flex w-full items-center justify-between gap-2 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2.5 py-1.5 text-xs text-[var(--text-primary)] outline-none hover:border-[var(--accent)]">
        <span className="truncate" title={summary}>{summary}</span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-70" />
      </button>
      {open && (
        <div className="absolute left-0 right-0 z-40 mt-1 max-h-52 min-w-56 overflow-auto rounded-md border border-[var(--border)] bg-[var(--bg-card)] p-1 shadow-xl">
          {options.length ? options.map((option) => (
            <label key={option.id} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-[var(--bg-secondary)]">
              <input
                type="checkbox"
                checked={selected.includes(option.id)}
                onChange={() => toggle(option.id)}
              />
              <span className="min-w-0 truncate" title={option.name}>{option.name}</span>
            </label>
          )) : <span className="block px-2 py-1.5 text-xs text-[var(--text-muted)]">No options</span>}
        </div>
      )}
    </div>
  );
}
