import { useEffect, useState } from 'react';

export function TagMultiSelect({ options, value, onChange }: { options: string[]; value: string[]; onChange: (tags: string[]) => void }) {
  const [selected, setSelected] = useState(value);
  useEffect(() => setSelected(value), [value]);

  const toggle = (tag: string) => setSelected((current) => {
    const next = current.includes(tag) ? current.filter((item) => item !== tag) : [...current, tag];
    onChange(next);
    return next;
  });

  return (
    <details className="group relative" onClick={(event) => event.stopPropagation()}>
      <summary
        className="w-full cursor-pointer list-none truncate rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1.5 text-xs font-medium text-[var(--text-primary)] outline-none hover:border-[var(--accent)] [&::-webkit-details-marker]:hidden"
        title={selected.length ? selected.join(', ') : 'No tags'}
      >
        {selected.length ? `${selected.length} tag${selected.length === 1 ? '' : 's'}` : 'No tags'}
      </summary>
      <div className="absolute right-0 z-30 mt-1 max-h-56 w-56 overflow-auto rounded-md border border-[var(--border)] bg-[var(--bg-card)] p-1 shadow-xl">
        {options.length ? options.map((tag) => (
          <label key={tag} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-[var(--bg-secondary)]">
            <input type="checkbox" checked={selected.includes(tag)} onChange={() => toggle(tag)} />
            <span className="min-w-0 truncate" title={tag}>{tag}</span>
          </label>
        )) : <span className="block px-2 py-1.5 text-xs text-[var(--text-muted)]">No tags available</span>}
      </div>
    </details>
  );
}
