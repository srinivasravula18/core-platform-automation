import { useState, useEffect } from 'react';
import { MoreHorizontal } from 'lucide-react';

export interface RowMoreItem {
  label: string;
  onClick: () => void;
  /** Render in the destructive (red) style, e.g. Delete. */
  danger?: boolean;
}

/**
 * A compact 3-dots "More actions" menu for a table/list row. Edit lives OUTSIDE this menu as its
 * own pencil button; this menu holds the remaining row actions (Delete, etc.). The fixed overlay
 * closes the menu on any outside click and stops the click from reaching the row's own onClick.
 */
export function RowMoreMenu({ items, title = 'More actions', dropUp = false }: { items: RowMoreItem[]; title?: string; dropUp?: boolean }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open]);

  if (!items.length) return null;

  return (
    <div className="relative inline-flex">
      <button
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
        title={title}
        aria-label={title}
        aria-haspopup="true"
        aria-expanded={open}
        className="p-1 rounded hover:bg-[var(--border)] text-[var(--text-muted)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
      >
        <MoreHorizontal className="w-4 h-4" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={(e) => { e.stopPropagation(); setOpen(false); }} />
          <div
            role="menu"
            onClick={(e) => e.stopPropagation()}
            className={`absolute right-0 z-50 min-w-28 overflow-hidden rounded-md border border-[var(--border)] bg-[var(--bg-card)] shadow-xl ${dropUp ? 'bottom-8' : 'top-8'}`}
          >
            {items.map((item) => (
              <button
                key={item.label}
                role="menuitem"
                onClick={() => { setOpen(false); item.onClick(); }}
                className={`block w-full px-3 py-2 text-left text-sm hover:bg-[var(--bg-secondary)] focus-visible:bg-[var(--bg-secondary)] focus-visible:outline-none ${item.danger ? 'text-red-400 hover:bg-red-500/10 focus-visible:bg-red-500/10' : 'text-[var(--text-primary)]'}`}
              >
                {item.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
