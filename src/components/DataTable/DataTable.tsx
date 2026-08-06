import { type CSSProperties, type ReactNode } from 'react';
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
  const { containerRef, onScroll, startIndex, endIndex, topSpacerHeight, bottomSpacerHeight } = useVirtualizedRows({ rowCount, rowHeight });
  const { focusedIndex, setFocusedIndex, registerRow, onRowKeyDown } = useKeyboardRowNav({ rowCount, onActivate: onActivateRow });

  const visibleRows: ReactNode[] = [];
  for (let index = startIndex; index < endIndex; index += 1) {
    visibleRows.push(renderRow(index, {
      ref: (el) => registerRow(index, el),
      tabIndex: focusedIndex === index ? 0 : -1,
      onKeyDown: onRowKeyDown(index),
      onFocus: () => setFocusedIndex(index),
      'aria-rowindex': index + 2,
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
      {footer}
    </div>
  );
}
