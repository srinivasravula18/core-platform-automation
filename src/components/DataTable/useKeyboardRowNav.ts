import { useCallback, useRef, useState, type KeyboardEvent } from 'react';

type UseKeyboardRowNavOptions = {
  rowCount: number;
  onActivate?: (index: number) => void;
};

/** Roving-tabindex keyboard navigation for a virtual row list: Arrow/Home/End moves focus, Enter activates. */
export function useKeyboardRowNav({ rowCount, onActivate }: UseKeyboardRowNavOptions) {
  const [focusedIndex, setFocusedIndex] = useState(0);
  const rowRefs = useRef(new Map<number, HTMLTableRowElement>());

  const registerRow = useCallback((index: number, el: HTMLTableRowElement | null) => {
    if (el) rowRefs.current.set(index, el);
    else rowRefs.current.delete(index);
  }, []);

  const focusRow = useCallback((index: number) => {
    if (!rowCount) return;
    const clamped = Math.max(0, Math.min(rowCount - 1, index));
    setFocusedIndex(clamped);
    rowRefs.current.get(clamped)?.focus();
  }, [rowCount]);

  const onRowKeyDown = useCallback((index: number) => (event: KeyboardEvent<HTMLTableRowElement>) => {
    switch (event.key) {
      case 'ArrowDown': event.preventDefault(); focusRow(index + 1); break;
      case 'ArrowUp': event.preventDefault(); focusRow(index - 1); break;
      case 'Home': event.preventDefault(); focusRow(0); break;
      case 'End': event.preventDefault(); focusRow(rowCount - 1); break;
      case 'Enter': event.preventDefault(); onActivate?.(index); break;
      default: break;
    }
  }, [focusRow, onActivate, rowCount]);

  return { focusedIndex, setFocusedIndex, registerRow, onRowKeyDown, focusRow };
}
