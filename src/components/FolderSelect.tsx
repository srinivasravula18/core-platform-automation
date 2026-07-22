import { useEffect, useState } from 'react';

type FolderSelectProps = {
  value: string;
  onChange: (folderId: string) => void;
  label?: string;
  includeNone?: boolean;
  className?: string;
  /** Show the "New folder/path" inline creator. Off when only picking an existing folder (e.g. editing). */
  allowCreate?: boolean;
};

export function FolderSelect({ value, onChange, label = 'Repository Folder', includeNone = true, className = '', allowCreate = true }: FolderSelectProps) {
  const [folders, setFolders] = useState<any[]>([]);
  const [newPath, setNewPath] = useState('');
  const [isCreating, setIsCreating] = useState(false);

  const fetchFolders = () => {
    fetch('/api/folders')
      .then((r) => r.json())
      .then((data) => setFolders(Array.isArray(data) ? data : []))
      .catch(console.error);
  };

  useEffect(() => {
    fetchFolders();
  }, []);

  const createFolder = async () => {
    const path = newPath.trim();
    if (!path) return;
    setIsCreating(true);
    try {
      const res = await fetch('/api/folders/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path }),
      });
      const data = await res.json();
      if (data.folder?.id) {
        onChange(data.folder.id);
        setNewPath('');
        fetchFolders();
      }
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <div className={className}>
      <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">{label}</label>
      <div className={allowCreate ? 'grid grid-cols-1 gap-2 md:grid-cols-[1fr_auto]' : ''}>
        <select
          value={value || ''}
          onChange={(e) => onChange(e.target.value)}
          className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm outline-none focus:border-[var(--accent)] text-[var(--text-primary)]"
        >
          {includeNone ? <option value="">Uncategorized</option> : <option value="" disabled>Select a folder</option>}
          {folders.map((folder) => (
            <option key={folder.id} value={folder.id}>{folder.path || folder.name}</option>
          ))}
        </select>
        {allowCreate && (
          <div className="flex min-w-0 gap-2">
            <input
              value={newPath}
              onChange={(e) => setNewPath(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && createFolder()}
              placeholder="New folder/path"
              className="min-w-0 flex-1 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm outline-none focus:border-[var(--accent)] text-[var(--text-primary)]"
            />
            <button
              type="button"
              onClick={createFolder}
              disabled={!newPath.trim() || isCreating}
              className="rounded-md bg-[var(--accent)] px-3 py-2 text-sm font-medium text-white hover:bg-[var(--accent-hover)] disabled:opacity-50"
            >
              Add
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
