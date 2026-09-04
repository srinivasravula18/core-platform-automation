import { useEffect, type Dispatch, type RefObject, type SetStateAction } from 'react';

export function useCloseOnOutsidePointer<T extends HTMLElement>(
  ref: RefObject<T | null>,
  open: boolean,
  setOpen: Dispatch<SetStateAction<boolean>>,
) {
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open, ref, setOpen]);
}
