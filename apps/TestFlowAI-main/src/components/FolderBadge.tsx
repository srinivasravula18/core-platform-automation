import { FolderTree } from 'lucide-react';

export function getFolderLabel(folders: any[], folderId?: string) {
  if (!folderId) return 'Uncategorized';
  const folder = folders.find((item) => item.id === folderId);
  return folder?.path || folder?.name || 'Uncategorized';
}

export function FolderBadge({ folders, folderId }: { folders: any[]; folderId?: string }) {
  const label = getFolderLabel(folders, folderId);
  return (
    <span
      title={label}
      className="inline-flex max-w-[220px] items-center gap-1.5 truncate rounded border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1 text-xs font-medium text-[var(--text-muted)]"
    >
      <FolderTree className="h-3.5 w-3.5 shrink-0 text-[var(--accent)]" />
      <span className="min-w-0 truncate">{label}</span>
    </span>
  );
}
