/**
 * In-app dialog host — a styled replacement for the native window.alert() /
 * window.confirm(). Use the imperative helpers anywhere (components AND plain .ts
 * helpers): they push onto a small queue rendered by <DialogHost /> (mounted once
 * at the app root).
 *
 *   await showAlert('Saved.');                         // notice + OK
 *   if (await showConfirm('Delete this?', { tone: 'danger' })) { ... }   // confirm/cancel
 */
import { useEffect } from 'react';
import { create } from 'zustand';
import { AlertTriangle, Info } from 'lucide-react';
import { cn } from '@/src/lib/utils';

type DialogKind = 'alert' | 'confirm';

interface DialogRequest {
  id: number;
  kind: DialogKind;
  title?: string;
  message: string;
  confirmText: string;
  cancelText: string;
  tone: 'default' | 'danger';
  resolve: (value: boolean) => void;
}

interface DialogState {
  queue: DialogRequest[];
  push: (req: DialogRequest) => void;
  resolveTop: (value: boolean) => void;
}

let counter = 0;

const useDialogStore = create<DialogState>((set, get) => ({
  queue: [],
  push: (req) => set((s) => ({ queue: [...s.queue, req] })),
  resolveTop: (value) => {
    const top = get().queue[0];
    if (!top) return;
    top.resolve(value);
    set((s) => ({ queue: s.queue.slice(1) }));
  },
}));

export interface AlertOptions { title?: string; confirmText?: string; }
export interface ConfirmOptions { title?: string; confirmText?: string; cancelText?: string; tone?: 'default' | 'danger'; }

/** Styled replacement for window.alert(). Resolves when the user dismisses it. */
export function showAlert(message: string, opts: AlertOptions = {}): Promise<void> {
  return new Promise((resolve) => {
    useDialogStore.getState().push({
      id: ++counter,
      kind: 'alert',
      message,
      title: opts.title,
      confirmText: opts.confirmText || 'OK',
      cancelText: '',
      tone: 'default',
      resolve: () => resolve(),
    });
  });
}

/** Styled replacement for window.confirm(). Resolves true on confirm, false otherwise. */
export function showConfirm(message: string, opts: ConfirmOptions = {}): Promise<boolean> {
  return new Promise((resolve) => {
    useDialogStore.getState().push({
      id: ++counter,
      kind: 'confirm',
      message,
      title: opts.title,
      confirmText: opts.confirmText || 'Confirm',
      cancelText: opts.cancelText || 'Cancel',
      tone: opts.tone || 'default',
      resolve,
    });
  });
}

/** Mount ONCE near the app root. Renders the active dialog from the queue. */
export function DialogHost() {
  const dialog = useDialogStore((s) => s.queue[0]);
  const resolveTop = useDialogStore((s) => s.resolveTop);

  useEffect(() => {
    if (!dialog) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') resolveTop(dialog.kind === 'alert');
      else if (e.key === 'Enter') resolveTop(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dialog, resolveTop]);

  if (!dialog) return null;
  const danger = dialog.tone === 'danger';
  // Dismissing (overlay click / Esc): confirm -> cancel(false), alert -> acknowledged(true).
  const dismiss = () => resolveTop(dialog.kind === 'alert');

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-sm"
      onMouseDown={(e) => { if (e.target === e.currentTarget) dismiss(); }}
    >
      <div className="w-full max-w-md overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--bg-card)] shadow-xl animate-in fade-in zoom-in-95 duration-200">
        <div className="flex items-start gap-3 px-5 py-4">
          <div className={cn('mt-0.5 shrink-0 rounded-full p-1.5', danger ? 'bg-red-500/10 text-red-400' : 'bg-[var(--accent)]/10 text-[var(--accent)]')}>
            {danger ? <AlertTriangle className="h-5 w-5" /> : <Info className="h-5 w-5" />}
          </div>
          <div className="min-w-0 flex-1">
            {dialog.title && <h2 className="text-base font-semibold text-[var(--text-primary)]">{dialog.title}</h2>}
            <p className={cn('whitespace-pre-wrap break-words text-sm text-[var(--text-muted)]', dialog.title && 'mt-1')}>{dialog.message}</p>
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t border-[var(--border)] px-5 py-3">
          {dialog.kind === 'confirm' && (
            <button
              onClick={() => resolveTop(false)}
              className="rounded-lg px-3 py-1.5 text-sm font-medium text-[var(--text-muted)] hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)]"
            >
              {dialog.cancelText}
            </button>
          )}
          <button
            autoFocus
            onClick={() => resolveTop(true)}
            className={cn(
              'rounded-lg px-3 py-1.5 text-sm font-semibold text-white',
              danger ? 'bg-red-600 hover:bg-red-500' : 'bg-[var(--accent)] hover:opacity-90',
            )}
          >
            {dialog.confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}
