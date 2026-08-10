import { type CSSProperties, type ReactNode, useEffect, useState } from 'react';
import { useVirtualizedRows } from './useVirtualizedRows';
import { useKeyboardRowNav } from './useKeyboardRowNav';

export type DataRowProps = {
  ref: (el: HTMLTableRowElement | null) => void;
  tabIndex: number;
  onKeyDown: ReturnType<typeof useKeyboardRowNav>['onRowKeyDown'] extends (index: number) => infer H ? H : never;
  onFocus: () => void;
  'aria-rowindex': number;
};

type DataTableProps = {
  rowCount: number;
  rowHeight?: number;
  height?: number | string;
  renderHeaderRow: () => ReactNode;
  renderRow: (index: number, rowProps: DataRowProps) => ReactNode;
  onActivateRow?: (index: number) => void;
  ariaLabel: string;
  className?: string;
  tableClassName?: string;
  theadClassName?: string;
  containerStyle?: CSSProperties;
  emptyState?: ReactNode;
  footer?: ReactNode;
};

const PAGE_SIZE = 2000;

/**
 * Windowed, keyboard-navigable table shell. Consumers keep their existing per-row JSX (inline
 * dropdowns, action buttons, etc.) and only move it behind `renderRow(index)` — DataTable adds
 * virtualization + roving-tabindex nav + ARIA grid semantics without dictating row markup.
 */
export function DataTable({
  rowCount, rowHeight = 44, height = 560, renderHeaderRow, renderRow, onActivateRow,
  ariaLabel, className = '', tableClassName = 'w-full border-collapse',
  theadClassName = 'sticky top-0 z-10 border-b border-[var(--border)] bg-[var(--bg-secondary)]',
  containerStyle, emptyState, footer,
}: DataTableProps) {
  const [page, setPage] = useState(0);
  const pageCount = Math.max(1, Math.ceil(rowCount / PAGE_SIZE));
  const pageStart = page * PAGE_SIZE;
  const pageRowCount = Math.max(0, Math.min(PAGE_SIZE, rowCount - pageStart));
  const { containerRef, onScroll, startIndex, endIndex, topSpacerHeight, bottomSpacerHeight } = useVirtualizedRows({ rowCount: pageRowCount, rowHeight });
  const { focusedIndex, setFocusedIndex, registerRow, onRowKeyDown } = useKeyboardRowNav({ rowCount: pageRowCount, onActivate: onActivateRow == null ? undefined : (index) => onActivateRow(index + pageStart) });

  useEffect(() => {
    if (page >= pageCount) setPage(pageCount - 1);
  }, [page, pageCount]);

  useEffect(() => {
    containerRef.current?.scrollTo({ top: 0 });
  }, [page, containerRef]);

  const visibleRows: ReactNode[] = [];
  for (let index = startIndex; index < endIndex; index += 1) {
    const rowIndex = index + pageStart;
    visibleRows.push(renderRow(rowIndex, {
      ref: (el) => registerRow(index, el),
      tabIndex: focusedIndex === index ? 0 : -1,
      onKeyDown: onRowKeyDown(index),
      onFocus: () => setFocusedIndex(index),
      'aria-rowindex': rowIndex + 2,
    }));
  }

  if (!rowCount && emptyState) return <>{emptyState}</>;

  return (
    <div
      ref={containerRef}
      onScroll={onScroll}
      style={{ height, overflow: 'auto', ...containerStyle }}
      className={className}
    >
      <table role="grid" aria-label={ariaLabel} aria-rowcount={rowCount + 1} className={tableClassName}>
        <thead className={theadClassName}>{renderHeaderRow()}</thead>
        <tbody>
          {topSpacerHeight > 0 && <tr aria-hidden="true" style={{ height: topSpacerHeight }}><td colSpan={100} /></tr>}
          {visibleRows}
          {bottomSpacerHeight > 0 && <tr aria-hidden="true" style={{ height: bottomSpacerHeight }}><td colSpan={100} /></tr>}
        </tbody>
      </table>
      {pageCount > 1 && (
        <div className="flex items-center justify-end gap-3 border-t border-[var(--border)] px-3 py-2 text-xs text-[var(--text-muted)]">
          <button type="button" onClick={() => setPage((current) => current - 1)} disabled={page === 0} className="rounded border border-[var(--border)] px-2 py-1 hover:text-[var(--text-primary)] disabled:opacity-50">Previous</button>
          <span aria-live="polite">Page {page + 1} of {pageCount} ({rowCount.toLocaleString()} rows)</span>
          <button type="button" onClick={() => setPage((current) => current + 1)} disabled={page === pageCount - 1} className="rounded border border-[var(--border)] px-2 py-1 hover:text-[var(--text-primary)] disabled:opacity-50">Next</button>
        </div>
      )}
      {footer}
    </div>
  );
}
