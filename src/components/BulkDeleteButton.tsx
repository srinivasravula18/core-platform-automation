import { Trash2 } from 'lucide-react';
import { cn } from '@/src/lib/utils';

export function BulkDeleteButton({ count, busy, onDelete, className }: { count: number; busy: boolean; onDelete: () => void; className?: string }) {
  return (
    <button onClick={onDelete} disabled={busy} className={cn('flex items-center gap-1.5 rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-red-700 disabled:opacity-50', className)}>
      <Trash2 className="h-4 w-4" /> Delete Selected ({count})
    </button>
  );
}
