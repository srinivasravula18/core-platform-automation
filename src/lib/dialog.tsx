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
import { AlertTriangle, Info, CheckCircle2 } from 'lucide-react';
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

// ---- Toasts: brief, non-blocking confirmations (e.g. "Copied to clipboard") ----
type ToastTone = 'success' | 'info' | 'error';
interface Toast { id: number; message: string; tone: ToastTone; }
interface ToastState {
  toasts: Toast[];
  add: (t: Toast) => void;
  remove: (id: number) => void;
}
const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  add: (t) => set((s) => ({ toasts: [...s.toasts, t] })),
  remove: (id) => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })),
}));

/** Show a brief auto-dismissing toast (does not block). Default tone 'success'. */
export function showToast(message: string, opts: { tone?: ToastTone; durationMs?: number } = {}): void {
  const id = ++counter;
  useToastStore.getState().add({ id, message, tone: opts.tone || 'success' });
  if (typeof window !== 'undefined') {
    window.setTimeout(() => useToastStore.getState().remove(id), opts.durationMs ?? 2200);
  }
}

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

function DialogModal({ dialog, resolveTop }: { dialog: DialogRequest; resolveTop: (v: boolean) => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') resolveTop(dialog.kind === 'alert');
      else if (e.key === 'Enter') resolveTop(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dialog, resolveTop]);

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

function ToastViewport() {
  const toasts = useToastStore((s) => s.toasts);
  if (!toasts.length) return null;
  return (
    <div className="pointer-events-none fixed bottom-5 left-1/2 z-[110] flex -translate-x-1/2 flex-col items-center gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={cn(
            'pointer-events-auto flex items-center gap-2 rounded-full border px-4 py-2 text-sm font-medium shadow-lg animate-in fade-in slide-in-from-bottom-2 duration-200',
            'border-[var(--border)] bg-[var(--bg-card)] text-[var(--text-primary)]',
          )}
        >
          {t.tone === 'error'
            ? <AlertTriangle className="h-4 w-4 text-red-400" />
            : <CheckCircle2 className={cn('h-4 w-4', t.tone === 'info' ? 'text-[var(--accent)]' : 'text-emerald-400')} />}
          {t.message}
        </div>
      ))}
    </div>
  );
}

/** Mount ONCE near the app root. Renders the active dialog AND any toasts. */
export function DialogHost() {
  const dialog = useDialogStore((s) => s.queue[0]);
  const resolveTop = useDialogStore((s) => s.resolveTop);
  return (
    <>
      {dialog && <DialogModal dialog={dialog} resolveTop={resolveTop} />}
      <ToastViewport />
    </>
  );
}
