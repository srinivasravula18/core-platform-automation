import { useEffect, useMemo, useState } from 'react';
import { ChevronRight, FileText, Folder, FolderPlus, Layers, PlayCircle, Search, Trash2, ClipboardList, TestTube2 } from 'lucide-react';
import { cn } from '@/src/lib/utils';

type FolderNode = any & { children: FolderNode[] };

const artifactConfig = [
  { key: 'plans', label: 'Plans', icon: FileText },
  { key: 'suites', label: 'Suites', icon: Layers },
  { key: 'cases', label: 'Cases', icon: TestTube2 },
  { key: 'runs', label: 'Runs', icon: PlayCircle },
  { key: 'reports', label: 'Reports', icon: ClipboardList },
] as const;

function buildTree(folders: any[]) {
  const byId = new Map<string, FolderNode>();
  folders.forEach((folder) => byId.set(folder.id, { ...folder, children: [] }));
  const roots: FolderNode[] = [];
  byId.forEach((folder) => {
    const parent = byId.get(folder.parentId);
    if (parent) parent.children.push(folder);
    else roots.push(folder);
  });
  const sortNodes = (nodes: FolderNode[]) => {
    nodes.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    nodes.forEach((node) => sortNodes(node.children));
  };
  sortNodes(roots);
  return roots;
}

function FolderTreeItem({ node, selectedId, onSelect, depth = 0 }: { key?: string; node: FolderNode; selectedId: string; onSelect: (id: string) => void; depth?: number }) {
  const [open, setOpen] = useState(true);
  const hasChildren = node.children.length > 0;
  return (
    <div>
      <button
        onClick={() => onSelect(node.id)}
        className={cn(
          'flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm transition-colors',
          selectedId === node.id ? 'bg-[var(--accent)]/10 text-[var(--accent)]' : 'text-[var(--text-muted)] hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)]'
        )}
        style={{ paddingLeft: `${8 + depth * 14}px` }}
      >
        {hasChildren ? (
          <ChevronRight onClick={(e) => { e.stopPropagation(); setOpen(!open); }} className={cn('h-4 w-4 shrink-0 transition-transform', open && 'rotate-90')} />
        ) : (
          <span className="h-4 w-4 shrink-0" />
        )}
        <Folder className="h-4 w-4 shrink-0" />
        <span className="min-w-0 truncate">{node.name}</span>
      </button>
      {open && hasChildren && (
        <div>
          {node.children.map((child) => (
            <FolderTreeItem key={child.id} node={child} selectedId={selectedId} onSelect={onSelect} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

export default function TestRepository() {
  const [folders, setFolders] = useState<any[]>([]);
  const [artifacts, setArtifacts] = useState<Record<string, any[]>>({ plans: [], suites: [], cases: [], runs: [], reports: [] });
  const [selectedFolderId, setSelectedFolderId] = useState('');
  const [newFolderPath, setNewFolderPath] = useState('');
  const [searchTerm, setSearchTerm] = useState('');

  const fetchData = () => {
    Promise.all([
      fetch('/api/folders').then((r) => r.json()),
      fetch('/api/plans').then((r) => r.json()),
      fetch('/api/suites').then((r) => r.json()),
      fetch('/api/cases').then((r) => r.json()),
      fetch('/api/runs').then((r) => r.json()),
      fetch('/api/reports').then((r) => r.json()),
    ])
      .then(([folderData, plans, suites, cases, runs, reports]) => {
        setFolders(Array.isArray(folderData) ? folderData : []);
        setArtifacts({ plans, suites, cases, runs, reports });
      })
      .catch(console.error);
  };

  useEffect(() => {
    fetchData();
  }, []);

  const selectedFolder = folders.find((folder) => folder.id === selectedFolderId) || null;
  const tree = useMemo(() => buildTree(folders), [folders]);
  const folderCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const config of artifactConfig) {
      for (const item of artifacts[config.key] || []) {
        const folderId = item.folderId || '';
        counts[folderId] = (counts[folderId] || 0) + 1;
      }
    }
    return counts;
  }, [artifacts]);

  const visibleItems = (key: string) => {
    const query = searchTerm.toLowerCase();
    return (artifacts[key] || []).filter((item) => {
      const inFolder = selectedFolderId ? item.folderId === selectedFolderId : !item.folderId;
      const matchesSearch = !query || `${item.id || ''} ${item.name || ''} ${item.title || ''} ${item.description || ''}`.toLowerCase().includes(query);
      return inFolder && matchesSearch;
    });
  };

  const createFolder = async () => {
    const path = newFolderPath.trim();
    if (!path) return;
    const res = await fetch('/api/folders/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    });
    const data = await res.json();
    if (data.folder?.id) {
      setSelectedFolderId(data.folder.id);
      setNewFolderPath('');
      fetchData();
    }
  };

  const deleteFolder = async () => {
    if (!selectedFolderId) return;
    const res = await fetch(`/api/folders/${selectedFolderId}`, { method: 'DELETE' });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      alert(data.error || 'Folder cannot be deleted.');
      return;
    }
    setSelectedFolderId('');
    fetchData();
  };

  return (
    <div className="mx-auto flex h-full max-w-7xl flex-col gap-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Test Repository</h1>
          <p className="mt-1 text-sm text-[var(--text-muted)]">Organize plans, suites, cases, runs, reports, scripts, and evidence by app or feature folders.</p>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-5 lg:grid-cols-[320px_1fr]">
        <aside className="flex min-h-0 flex-col rounded-xl border border-[var(--border)] bg-[var(--bg-card)]">
          <div className="border-b border-[var(--border)] p-4">
            <div className="flex gap-2">
              <input
                value={newFolderPath}
                onChange={(e) => setNewFolderPath(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && createFolder()}
                placeholder="App / Module / Feature"
                className="min-w-0 flex-1 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
              />
              <button onClick={createFolder} disabled={!newFolderPath.trim()} className="rounded-md bg-[var(--accent)] p-2 text-white disabled:opacity-50" title="Create folder path">
                <FolderPlus className="h-4 w-4" />
              </button>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-3">
            <button
              onClick={() => setSelectedFolderId('')}
              className={cn(
                'mb-2 flex w-full items-center justify-between rounded-md px-2 py-2 text-sm',
                !selectedFolderId ? 'bg-[var(--accent)]/10 text-[var(--accent)]' : 'text-[var(--text-muted)] hover:bg-[var(--bg-secondary)]'
              )}
            >
              <span>Uncategorized</span>
              <span className="text-xs">{folderCounts[''] || 0}</span>
            </button>
            {tree.map((node) => (
              <FolderTreeItem key={node.id} node={node} selectedId={selectedFolderId} onSelect={setSelectedFolderId} />
            ))}
          </div>
        </aside>

        <section className="min-h-0 rounded-xl border border-[var(--border)] bg-[var(--bg-card)]">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border)] p-4">
            <div className="min-w-0">
              <div className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">Current Folder</div>
              <h2 className="truncate text-lg font-semibold">{selectedFolder ? selectedFolder.path : 'Uncategorized'}</h2>
            </div>
            <div className="flex items-center gap-2">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-muted)]" />
                <input
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  placeholder="Search in folder..."
                  className="w-72 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] py-2 pl-9 pr-3 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
                />
              </div>
              {selectedFolder && (
                <button onClick={deleteFolder} className="rounded-md border border-red-500/20 bg-red-500/10 p-2 text-red-400 hover:bg-red-500/20" title="Delete empty folder">
                  <Trash2 className="h-4 w-4" />
                </button>
              )}
            </div>
          </div>

          <div className="grid max-h-[calc(100vh-250px)] gap-4 overflow-auto p-4">
            {artifactConfig.map((config) => {
              const items = visibleItems(config.key);
              const Icon = config.icon;
              return (
                <div key={config.key} className="rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)]">
                  <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
                    <div className="flex items-center gap-2 text-sm font-semibold">
                      <Icon className="h-4 w-4 text-[var(--accent)]" />
                      {config.label}
                    </div>
                    <span className="rounded border border-[var(--border)] px-2 py-0.5 text-xs text-[var(--text-muted)]">{items.length}</span>
                  </div>
                  <div className="divide-y divide-[var(--border)]">
                    {items.length ? items.slice(0, 8).map((item) => (
                      <div key={item.id} className="grid grid-cols-[110px_1fr_auto] gap-3 px-4 py-3 text-sm">
                        <span className="font-mono text-xs text-[var(--text-muted)]">{item.id}</span>
                        <span className="min-w-0 truncate font-medium text-[var(--text-primary)]">{item.name || item.title || 'Untitled'}</span>
                        <span className="text-xs text-[var(--text-muted)]">{item.status || item.date || item.type || ''}</span>
                      </div>
                    )) : (
                      <div className="px-4 py-6 text-center text-sm text-[var(--text-muted)]">No {config.label.toLowerCase()} in this folder.</div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      </div>
    </div>
  );
}
