import { useEffect, useRef, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { normalizeTag, normalizeTags } from '@/src/lib/tags';

export function TagEditor({ options, value, onChange }: { options: string[]; value: string[]; onChange: (tags: string[]) => void }) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onClickAway = (event: MouseEvent) => {
      if (!boxRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('click', onClickAway, true);
    return () => document.removeEventListener('click', onClickAway, true);
  }, [open]);

  const add = (tag: string) => {
    const clean = normalizeTag(tag);
    if (!clean || value.includes(clean)) { setQuery(''); return; }
    onChange(normalizeTags([...value, clean]));
    setQuery('');
  };
  const remove = (tag: string) => onChange(value.filter((item) => item !== tag));

  const normalizedQuery = normalizeTag(query);
  const available = options.filter((tag) => !value.includes(tag));
  const suggestions = normalizedQuery ? available.filter((tag) => normalizeTag(tag).includes(normalizedQuery)) : available;
  const canCreate = Boolean(normalizedQuery)
    && !options.some((tag) => normalizeTag(tag) === normalizedQuery)
    && !value.some((tag) => normalizeTag(tag) === normalizedQuery);

  return (
    <div ref={boxRef} className="relative">
      <div
        className="flex min-h-10 flex-wrap items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1.5 focus-within:border-[var(--accent)]"
        onClick={() => setOpen(true)}
      >
        {value.map((tag) => (
          <span key={tag} className="inline-flex items-center gap-1 rounded bg-[var(--accent)]/15 px-1.5 py-0.5 text-xs font-medium text-[var(--accent)]">
            {tag}
            <button type="button" onClick={(event) => { event.stopPropagation(); remove(tag); }} title={`Remove ${tag}`} className="opacity-70 hover:opacity-100">
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
        <input
          value={query}
          onChange={(event) => { setQuery(event.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              if (suggestions.length) add(suggestions[0]); else add(query);
            }
            if (event.key === 'Backspace' && !query && value.length) remove(value[value.length - 1]);
          }}
          placeholder={value.length ? 'Add tag…' : 'Select or create tags…'}
          className="min-w-[8rem] flex-1 bg-transparent px-0.5 py-0.5 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none"
        />
      </div>
      {open && (suggestions.length > 0 || canCreate) ? (
        <div className="absolute left-0 right-0 z-30 mt-1 max-h-52 overflow-auto rounded-md border border-[var(--border)] bg-[var(--bg-card)] p-1 shadow-xl">
          {canCreate ? (
            <button type="button" onClick={() => add(query)} className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-[var(--accent)] hover:bg-[var(--bg-secondary)]">
              <Plus className="h-3.5 w-3.5" /> Create “{query.trim()}”
            </button>
          ) : null}
          {suggestions.map((tag) => (
            <button key={tag} type="button" onClick={() => add(tag)} className="block w-full truncate rounded px-2 py-1.5 text-left text-xs text-[var(--text-primary)] hover:bg-[var(--bg-secondary)]" title={tag}>
              {tag}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
