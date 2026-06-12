import { ReactNode } from 'react';
import { X } from 'lucide-react';

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  size?: 'md' | 'xl';
}

export function Modal({ isOpen, onClose, title, children, size = 'xl' }: ModalProps) {
  if (!isOpen) return null;

  const widthClass = size === 'xl' ? 'sm:max-w-5xl' : 'sm:max-w-md';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-sm">
      <div className={`bg-[var(--bg-card)] border border-[var(--border)] rounded-xl shadow-xl w-full max-w-[95vw] ${widthClass} max-h-[90dvh] flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-200`}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border)] flex-shrink-0">
          <h2 className="text-lg font-semibold text-[var(--text-primary)]">{title}</h2>
          <button onClick={onClose} className="p-1 rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-secondary)] transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-4 flex-1 min-h-0 overflow-auto">
          {children}
        </div>
      </div>
    </div>
  );
}
