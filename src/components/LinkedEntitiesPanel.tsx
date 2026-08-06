import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Link } from 'react-router-dom';

type LinkedItem = { id: string; label: string; to: string };
type LinkedGroup = { label: string; items: LinkedItem[] };

/** Collapsible reverse-lookup panel: "appears in N suites / M plans, ran in K runs", click-through. */
export function LinkedEntitiesPanel({ title = 'Linked entities', groups, defaultOpen = false }: { title?: string; groups: LinkedGroup[]; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const nonEmptyGroups = groups.filter((group) => group.items.length);
  const total = nonEmptyGroups.reduce((sum, group) => sum + group.items.length, 0);
  if (!total) return null;

  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)]">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm font-medium text-[var(--text-primary)]"
      >
        <span>{title} ({total})</span>
        {open ? <ChevronDown className="h-4 w-4" aria-hidden="true" /> : <ChevronRight className="h-4 w-4" aria-hidden="true" />}
      </button>
      {open && (
        <div className="space-y-3 border-t border-[var(--border)] px-3 py-2 text-xs">
          {nonEmptyGroups.map((group) => (
            <div key={group.label}>
              <div className="mb-1 font-medium text-[var(--text-muted)]">{group.label} ({group.items.length})</div>
              <ul className="space-y-0.5">
                {group.items.map((item) => (
                  <li key={item.id}>
                    <Link to={item.to} className="text-[var(--text-primary)] hover:text-[var(--accent)] hover:underline">{item.label}</Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
