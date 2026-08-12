import { ReactNode } from 'react';
import { X } from 'lucide-react';

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** ReactNode so a header can carry inline actions (e.g. rename) beside the title. */
  title: ReactNode;
  children: ReactNode;
  size?: 'md' | 'xl' | 'report';
  /**
   * Optional action bar pinned to the bottom of the modal. When provided it is
   * rendered in a fixed footer that stays visible while the body scrolls.
   */
  footer?: ReactNode;
}

export function Modal({ isOpen, onClose, title, children, size = 'xl', footer }: ModalProps) {
  if (!isOpen) return null;

  const widthClass = size === 'report' ? 'sm:max-w-[1280px]' : size === 'xl' ? 'sm:max-w-5xl' : 'sm:max-w-md';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-sm">
      <div className={`bg-[var(--bg-card)] border border-[var(--border)] rounded-xl shadow-xl w-full max-w-[95vw] ${widthClass} max-h-[90dvh] flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-200`}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border)] flex-shrink-0">
          <h2 className="min-w-0 flex-1 text-lg font-semibold text-[var(--text-primary)]">{title}</h2>
          <button onClick={onClose} aria-label="Close dialog" className="ml-3 shrink-0 p-1 rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-secondary)] transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-4 flex-1 min-h-0 overflow-auto">
          {children}
        </div>
        {footer && (
          <div className="flex-shrink-0 border-t border-[var(--border)] bg-[var(--bg-card)] px-4 py-3">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
