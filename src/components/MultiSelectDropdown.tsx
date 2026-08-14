import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown } from 'lucide-react';

export function MultiSelectDropdown({
  label,
  options,
  value,
  onChange,
  className = '',
  emptyContent,
  menuPortal = false,
  title,
}: {
  label: string;
  options: Array<{ id: string; name: string }>;
  value: string[];
  onChange: (ids: string[]) => void;
  className?: string;
  emptyContent?: ReactNode;
  /** Render the panel in a body portal so it escapes a scrolling/overflow ancestor (e.g. a table). */
  menuPortal?: boolean;
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [rect, setRect] = useState<{ top: number; left: number; width: number } | null>(null);

  // Never count deleted linked records, but do not auto-save while options are still loading.
  const available = new Set(options.map((option) => option.id));
  const selected = value.filter((id) => available.has(id));

  const place = useCallback(() => {
    const button = ref.current?.getBoundingClientRect();
    if (!button) return;
    setRect({ top: button.bottom + 4, left: button.left, width: Math.max(button.width, 224) });
  }, []);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      const target = event.target as Node;
      if (ref.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);

  // A portalled panel is positioned in viewport coordinates, so it must follow scroll/resize.
  useLayoutEffect(() => {
    if (!open || !menuPortal) return undefined;
    place();
    const onMove = () => place();
    window.addEventListener('scroll', onMove, true);
    window.addEventListener('resize', onMove);
    return () => {
      window.removeEventListener('scroll', onMove, true);
      window.removeEventListener('resize', onMove);
    };
  }, [open, menuPortal, place]);

  const toggle = (id: string) => onChange(selected.includes(id) ? selected.filter((item) => item !== id) : [...selected, id]);
  const selectedName = selected.length === 1 ? options.find((option) => option.id === selected[0])?.name : '';
  const summary = selectedName || (selected.length ? `${selected.length} selected` : label);

  const items = options.length ? options.map((option) => (
    <label key={option.id} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-[var(--bg-secondary)]">
      <input
        type="checkbox"
        checked={selected.includes(option.id)}
        onChange={() => toggle(option.id)}
      />
      <span className="min-w-0 truncate" title={option.name}>{option.name}</span>
    </label>
  )) : emptyContent || <span className="block px-2 py-1.5 text-xs text-[var(--text-muted)]">No Options</span>;

  const panelClass = 'max-h-52 overflow-auto rounded-md border border-[var(--border)] bg-[var(--bg-card)] p-1 shadow-xl';

  return (
    <div ref={ref} className={`relative ${className}`} onClick={(event) => event.stopPropagation()}>
      <button
        type="button"
        title={title || summary}
        onClick={() => setOpen((current) => !current)}
        className="flex w-full items-center justify-between gap-2 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2.5 py-1.5 text-xs text-[var(--text-primary)] outline-none hover:border-[var(--accent)]"
      >
        <span className="truncate">{summary}</span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-70" />
      </button>
      {open && (menuPortal
        ? createPortal(
            <div
              ref={menuRef}
              onClick={(event) => event.stopPropagation()}
              style={{ position: 'fixed', top: rect?.top ?? 0, left: rect?.left ?? 0, width: rect?.width ?? 224, zIndex: 60 }}
              className={panelClass}
            >
              {items}
            </div>,
            document.body,
          )
        : <div ref={menuRef} className={`absolute left-0 right-0 z-40 mt-1 min-w-56 ${panelClass}`}>{items}</div>
      )}
    </div>
  );
}
