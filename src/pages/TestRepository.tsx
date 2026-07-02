import { useEffect, useMemo, useState } from 'react';
import { ChevronRight, FileText, Folder, FolderPlus, Layers, PlayCircle, Search, Trash2, ClipboardList, TestTube2, Code2, Copy, Download, Check, CheckSquare, X, Bug, ScrollText } from 'lucide-react';
import { cn } from '@/src/lib/utils';
import { Modal } from '@/src/components/Modal';
import { showAlert, showConfirm } from '@/src/lib/dialog';

// Artifact groups backed by a real DELETE/bulk-delete endpoint (evidence is derived, not deletable).
const DELETABLE_KEYS = new Set(['plans', 'suites', 'cases', 'runs', 'reports', 'scripts', 'requirements', 'defects']);

// Synthetic folder for artifacts with no folderId (legacy items created before the folder gate),
// so they remain viewable instead of being hidden by the first-folder auto-select.
const UNCATEGORIZED_ID = '__uncategorized__';

type FolderNode = any & { children: FolderNode[] };

const artifactConfig = [
  { key: 'plans', label: 'Plans', icon: FileText },
  { key: 'suites', label: 'Suites', icon: Layers },
  { key: 'cases', label: 'Cases', icon: TestTube2 },
  { key: 'requirements', label: 'Requirements', icon: ScrollText },
  { key: 'runs', label: 'Runs', icon: PlayCircle },
  { key: 'reports', label: 'Reports', icon: ClipboardList },
  { key: 'defects', label: 'Defects', icon: Bug },
  { key: 'scripts', label: 'Scripts', icon: FileText },
  { key: 'evidence', label: 'Evidence', icon: ClipboardList },
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

function FolderTreeItem({
  node,
  selectedId,
  selectedFolderIds,
  onSelect,
  onToggleFolder,
  onDelete,
  depth = 0,
}: {
  key?: string;
  node: FolderNode;
  selectedId: string;
  selectedFolderIds: Set<string>;
  onSelect: (id: string) => void;
  onToggleFolder: (id: string) => void;
  onDelete: (id: string, name: string) => void;
  depth?: number;
}) {
  const [open, setOpen] = useState(true);
  const hasChildren = node.children.length > 0;
  return (
    <div>
      <div
        className={cn(
          'group flex items-center rounded-md transition-colors',
          selectedId === node.id ? 'bg-[var(--accent)]/10' : 'hover:bg-[var(--bg-secondary)]'
        )}
      >
        <button
          onClick={() => onSelect(node.id)}
          className={cn(
            'flex min-w-0 flex-1 items-center gap-2 px-2 py-2 text-left text-sm transition-colors',
            selectedId === node.id ? 'text-[var(--accent)]' : 'text-[var(--text-muted)] group-hover:text-[var(--text-primary)]'
          )}
          style={{ paddingLeft: `${8 + depth * 14}px` }}
        >
          <input
            type="checkbox"
            checked={selectedFolderIds.has(node.id)}
            onClick={(e) => e.stopPropagation()}
            onChange={() => onToggleFolder(node.id)}
            className="shrink-0"
            title={`Select ${node.name}`}
          />
          {hasChildren ? (
            <ChevronRight onClick={(e) => { e.stopPropagation(); setOpen(!open); }} className={cn('h-4 w-4 shrink-0 transition-transform', open && 'rotate-90')} />
          ) : (
            <span className="h-4 w-4 shrink-0" />
          )}
          <Folder className="h-4 w-4 shrink-0" />
          <span className="min-w-0 truncate">{node.name}</span>
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); onDelete(node.id, node.name); }}
          title="Delete folder"
          aria-label={`Delete folder ${node.name}`}
          className="mr-1 shrink-0 rounded p-1 text-[var(--text-muted)] opacity-0 transition-colors hover:bg-red-500/10 hover:text-red-500 focus:opacity-100 group-hover:opacity-100"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
      {open && hasChildren && (
        <div>
          {node.children.map((child) => (
            <FolderTreeItem key={child.id} node={child} selectedId={selectedId} selectedFolderIds={selectedFolderIds} onSelect={onSelect} onToggleFolder={onToggleFolder} onDelete={onDelete} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

export default function TestRepository() {
  const [folders, setFolders] = useState<any[]>([]);
  const [artifacts, setArtifacts] = useState<Record<string, any[]>>({ plans: [], suites: [], cases: [], runs: [], reports: [], scripts: [], evidence: [] });
  const [viewerScript, setViewerScript] = useState<any | null>(null);
  const [copied, setCopied] = useState(false);
  const [selectedFolderId, setSelectedFolderId] = useState('');
  const [newRootFolderName, setNewRootFolderName] = useState('');
  const [newSubfolderName, setNewSubfolderName] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [selectMode, setSelectMode] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [selectedFolderIds, setSelectedFolderIds] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);

  const fetchData = () => {
    Promise.all([
      fetch('/api/folders').then((r) => r.json()),
      fetch('/api/plans').then((r) => r.json()),
      fetch('/api/suites').then((r) => r.json()),
      fetch('/api/cases').then((r) => r.json()),
      fetch('/api/runs').then((r) => r.json()),
      fetch('/api/reports').then((r) => r.json()),
      fetch('/api/scripts').then((r) => r.json()),
      fetch('/api/agent-runs').then((r) => r.json()),
      fetch('/api/requirements').then((r) => r.json()),
      fetch('/api/defects').then((r) => r.json()),
    ])
      .then(([folderData, plans, suites, cases, runs, reports, scripts, agentRuns, requirements, defects]) => {
        const evidence = (Array.isArray(agentRuns) ? agentRuns : []).flatMap((run: any) =>
          (run.evidence_screenshots || []).map((shot: any, index: number) => ({
            id: `${run.id}-evidence-${index + 1}`,
            name: shot.title || shot.screenshotUrl || `Evidence ${index + 1}`,
            title: shot.title || shot.screenshotUrl || `Evidence ${index + 1}`,
            folderId: run.folderId || '',
            status: shot.status ? `HTTP ${shot.status}` : 'Captured',
          }))
        );
        setFolders(Array.isArray(folderData) ? folderData : []);
        setArtifacts({
          plans, suites, cases, runs, reports,
          scripts: Array.isArray(scripts) ? scripts : [],
          requirements: Array.isArray(requirements) ? requirements : [],
          defects: Array.isArray(defects) ? defects : [],
          evidence,
        });
      })
      .catch(console.error);
  };

  useEffect(() => {
    fetchData();
  }, []);

  useEffect(() => {
    if (!selectedFolderId && folders.length > 0) {
      setSelectedFolderId(folders[0].id);
    }
  }, [folders, selectedFolderId]);

  const selectedFolder = folders.find((folder) => folder.id === selectedFolderId) || null;
  // Prepend an "Uncategorized" node so artifacts with no folderId (legacy items) stay reachable.
  const tree = useMemo(
    () => buildTree([{ id: UNCATEGORIZED_ID, name: 'Uncategorized', parentId: null }, ...folders]),
    [folders],
  );
  const allFolderIds = useMemo(() => folders.map((folder) => folder.id), [folders]);
  const allFoldersSelected = allFolderIds.length > 0 && allFolderIds.every((id) => selectedFolderIds.has(id));
  const visibleItems = (key: string) => {
    const query = searchTerm.toLowerCase();
    return (artifacts[key] || []).filter((item) => {
      const inFolder = selectedFolderId === UNCATEGORIZED_ID
        ? !item.folderId
        : selectedFolderId
          ? item.folderId === selectedFolderId
          : !item.folderId;
      const matchesSearch = !query || `${item.id || ''} ${item.name || ''} ${item.title || ''} ${item.description || ''}`.toLowerCase().includes(query);
      return inFolder && matchesSearch;
    });
  };

  const createRootFolder = async () => {
    const name = newRootFolderName.trim();
    if (!name) return;
    const res = await fetch('/api/folders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    const data = await res.json();
    if (data.folder?.id) {
      setSelectedFolderId(data.folder.id);
      setNewRootFolderName('');
      fetchData();
    }
  };

  const createSubfolder = async () => {
    const name = newSubfolderName.trim();
    if (!name) return;
    const res = await fetch('/api/folders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, parentId: selectedFolderId }),
    });
    const data = await res.json();
    if (data.folder?.id) {
      setSelectedFolderId(data.folder.id);
      setNewSubfolderName('');
      fetchData();
    }
  };

  const deleteFolderById = async (id: string, name?: string) => {
    if (!id || id === UNCATEGORIZED_ID) return; // "Uncategorized" is a synthetic view, not deletable
    if (!await showConfirm(`Delete folder${name ? ` "${name}"` : ''}? This cannot be undone.`, { tone: 'danger' })) return;
    const res = await fetch(`/api/folders/${id}`, { method: 'DELETE' });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      void showAlert(data.error || 'Folder cannot be deleted (it may still contain items or subfolders).');
      return;
    }
    if (selectedFolderId === id) setSelectedFolderId('');
    fetchData();
  };

  const deleteFolder = () => deleteFolderById(selectedFolderId, selectedFolder?.name);

  const toggleFolderSelection = (id: string) => {
    setSelectedFolderIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAllFolders = () => {
    setSelectedFolderIds(allFoldersSelected ? new Set() : new Set(allFolderIds));
  };

  const deleteSelectedFolders = async () => {
    const ids = Array.from(selectedFolderIds);
    if (!ids.length) return;
    if (!await showConfirm(`Delete ${ids.length} selected folder${ids.length === 1 ? '' : 's'} and everything inside? This cannot be undone.`, { tone: 'danger' })) return;
    setDeleting(true);
    try {
      const res = await fetch('/api/folders/bulk-delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      });
      if (!res.ok) throw new Error('Failed to delete folders');
      setSelectedFolderIds(new Set());
      if (ids.includes(selectedFolderId)) setSelectedFolderId('');
      fetchData();
    } catch (error) {
      console.error(error);
      void showAlert('Failed to delete selected folders.');
    } finally {
      setDeleting(false);
    }
  };

  const toggleSelectMode = () => {
    setSelectMode((prev) => {
      if (prev) setSelectedKeys(new Set());
      return !prev;
    });
  };

  const composeKey = (entity: string, id: string) => `${entity}::${id}`;

  const toggleItem = (entity: string, id: string) => {
    const k = composeKey(entity, id);
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  };

  const isItemSelected = (entity: string, id: string) => selectedKeys.has(composeKey(entity, id));

  const deleteArtifact = async (entity: string, id: string) => {
    if (!DELETABLE_KEYS.has(entity)) return;
    if (!await showConfirm(`Delete this ${entity.replace(/s$/, '')}? This cannot be undone.`, { tone: 'danger' })) return;
    setDeleting(true);
    try {
      await fetch(`/api/${entity}/${id}`, { method: 'DELETE' });
      fetchData();
    } catch (error) {
      console.error(error);
      void showAlert('Failed to delete item.');
    } finally {
      setDeleting(false);
    }
  };

  const deleteSelectedArtifacts = async () => {
    const keys: string[] = Array.from(selectedKeys);
    if (!keys.length) return;
    if (!await showConfirm(`Delete ${keys.length} selected item${keys.length === 1 ? '' : 's'}? This cannot be undone.`, { tone: 'danger' })) return;
    // group ids by entity for bulk-delete calls
    const byEntity = new Map<string, string[]>();
    for (const k of keys) {
      const [entity, id] = k.split('::');
      if (!DELETABLE_KEYS.has(entity)) continue;
      byEntity.set(entity, [...(byEntity.get(entity) || []), id]);
    }
    setDeleting(true);
    try {
      await Promise.all(
        Array.from(byEntity.entries()).map(([entity, ids]) =>
          fetch(`/api/${entity}/bulk-delete`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids }),
          }),
        ),
      );
      setSelectedKeys(new Set());
      setSelectMode(false);
      fetchData();
    } catch (error) {
      console.error(error);
      void showAlert('Failed to delete selected items.');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="app-page-shell app-page-shell-fluid flex h-full min-h-0 flex-col gap-5 overflow-hidden">
      <div className="flex flex-shrink-0 items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Test Repository</h1>
          <p className="mt-1 text-sm text-[var(--text-muted)]">Organize plans, suites, cases, runs, reports, scripts, and evidence by app or feature folders.</p>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-5 overflow-hidden lg:grid-cols-[clamp(18rem,22vw,21.25rem)_minmax(0,1fr)]">
        <aside className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--bg-card)]">
          <div className="space-y-4 border-b border-[var(--border)] p-4">
            <div>
              <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">Create New Folder</div>
              <div className="flex gap-2">
                <input
                  value={newRootFolderName}
                  onChange={(e) => setNewRootFolderName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && createRootFolder()}
                  placeholder="Folder name"
                  className="min-w-0 flex-1 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
                />
                <button onClick={createRootFolder} disabled={!newRootFolderName.trim()} className="inline-flex items-center gap-2 rounded-md bg-[var(--accent)] px-3 py-2 text-sm font-medium text-white disabled:opacity-50" title="Create root folder">
                  <FolderPlus className="h-4 w-4" />
                  New
                </button>
              </div>
            </div>
            <div>
              <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">Create Subfolder</div>
              <div className="mb-2 truncate text-xs text-[var(--text-muted)]">
                Parent: <span className="text-[var(--text-primary)]">{selectedFolder ? selectedFolder.path : 'Root folder'}</span>
              </div>
              <div className="flex gap-2">
              <input
                value={newSubfolderName}
                onChange={(e) => setNewSubfolderName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && createSubfolder()}
                placeholder="Subfolder name"
                className="min-w-0 flex-1 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
              />
              <button onClick={createSubfolder} disabled={!newSubfolderName.trim()} className="inline-flex items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-sm font-medium text-[var(--text-primary)] hover:border-[var(--accent)] disabled:opacity-50" title="Create subfolder">
                <FolderPlus className="h-4 w-4" />
                Add
              </button>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2 border-b border-[var(--border)] p-3">
            <button
              onClick={toggleAllFolders}
              disabled={allFolderIds.length === 0}
              className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2.5 py-1.5 text-xs font-medium text-[var(--text-primary)] hover:border-[var(--accent)] disabled:opacity-50"
            >
              <CheckSquare className="h-3.5 w-3.5" />
              {allFoldersSelected ? 'Clear all' : 'Select all'}
            </button>
            {selectedFolderIds.size > 0 && (
              <button
                onClick={deleteSelectedFolders}
                disabled={deleting}
                className="inline-flex items-center gap-1.5 rounded-md bg-red-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
              >
                <Trash2 className="h-3.5 w-3.5" />
                Delete ({selectedFolderIds.size})
              </button>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-3">
            {tree.map((node) => (
              <FolderTreeItem key={node.id} node={node} selectedId={selectedFolderId} selectedFolderIds={selectedFolderIds} onSelect={setSelectedFolderId} onToggleFolder={toggleFolderSelection} onDelete={deleteFolderById} />
            ))}
            {tree.length === 0 && (
              <div className="rounded-md border border-dashed border-[var(--border)] px-3 py-6 text-center text-sm text-[var(--text-muted)]">
                Create a folder to start organizing test assets.
              </div>
            )}
          </div>
        </aside>

        <section className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--bg-card)]">
          <div className="flex flex-shrink-0 flex-wrap items-center justify-between gap-3 border-b border-[var(--border)] p-4">
            <div className="min-w-0">
              <div className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">Current Folder</div>
              <h2 className="truncate text-lg font-semibold">{selectedFolder ? selectedFolder.path : 'No folder selected'}</h2>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-muted)]" />
                <input
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  placeholder="Search in folder..."
                  className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] py-2 pl-9 pr-3 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent)] sm:w-72"
                />
              </div>
              <button onClick={toggleSelectMode} className={cn("inline-flex items-center gap-1.5 rounded-md border px-3 py-2 text-sm font-medium transition-colors", selectMode ? "border-[var(--accent)] text-[var(--accent)] bg-[var(--accent)]/10" : "border-[var(--border)] bg-[var(--bg-secondary)] text-[var(--text-primary)] hover:border-[var(--accent)]")}>
                {selectMode ? <X className="h-4 w-4" /> : <CheckSquare className="h-4 w-4" />} {selectMode ? 'Cancel' : 'Select'}
              </button>
              {selectMode && selectedKeys.size > 0 && (
                <button onClick={deleteSelectedArtifacts} disabled={deleting} className="inline-flex items-center gap-1.5 rounded-md bg-red-600 px-3 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50">
                  <Trash2 className="h-4 w-4" /> Delete selected ({selectedKeys.size})
                </button>
              )}
              {selectedFolder && (
                <button onClick={deleteFolder} className="rounded-md border border-red-500/20 bg-red-500/10 p-2 text-red-400 hover:bg-red-500/20" title="Delete empty folder">
                  <Trash2 className="h-4 w-4" />
                </button>
              )}
            </div>
          </div>

          <div className="grid min-h-0 flex-1 auto-rows-max gap-4 overflow-y-auto overflow-x-hidden p-4">
            {artifactConfig.map((config) => {
              const items = visibleItems(config.key);
              const Icon = config.icon;
              const canDelete = DELETABLE_KEYS.has(config.key);
              const groupVisibleIds = items.slice(0, 8).map((item) => item.id);
              const groupAllSelected = canDelete && groupVisibleIds.length > 0 && groupVisibleIds.every((id) => isItemSelected(config.key, id));
              const toggleGroupAll = () => {
                setSelectedKeys((prev) => {
                  const next = new Set(prev);
                  if (groupAllSelected) groupVisibleIds.forEach((id) => next.delete(composeKey(config.key, id)));
                  else groupVisibleIds.forEach((id) => next.add(composeKey(config.key, id)));
                  return next;
                });
              };
              return (
                <div key={config.key} className="rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)]">
                  <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
                    <div className="flex items-center gap-2 text-sm font-semibold">
                      {selectMode && canDelete && (
                        <input type="checkbox" checked={groupAllSelected} onChange={toggleGroupAll} title={`Select all ${config.label.toLowerCase()}`} />
                      )}
                      <Icon className="h-4 w-4 text-[var(--accent)]" />
                      {config.label}
                    </div>
                    <span className="rounded border border-[var(--border)] px-2 py-0.5 text-xs text-[var(--text-muted)]">{items.length}</span>
                  </div>
                  <div className="divide-y divide-[var(--border)]">
                    {items.length ? items.slice(0, 8).map((item) => {
                      const hasCode = config.key === 'scripts' && typeof item.code === 'string' && item.code.length > 0;
                      const rowSelectable = selectMode && canDelete;
                      return (
                      <div
                        key={item.id}
                        onClick={rowSelectable ? () => toggleItem(config.key, item.id) : (hasCode ? () => { setViewerScript(item); setCopied(false); } : undefined)}
                        className={cn(
                          'flex min-w-0 items-center gap-3 px-4 py-3 text-sm',
                          (hasCode || rowSelectable) && 'cursor-pointer hover:bg-[var(--bg-card)]',
                        )}
                        title={rowSelectable ? 'Toggle selection' : (hasCode ? 'View script code' : undefined)}
                      >
                        {rowSelectable && (
                          <input
                            type="checkbox"
                            checked={isItemSelected(config.key, item.id)}
                            onChange={() => toggleItem(config.key, item.id)}
                            onClick={(e) => e.stopPropagation()}
                            className="shrink-0"
                          />
                        )}
                        <span className="w-[96px] shrink-0 truncate font-mono text-xs text-[var(--text-muted)] sm:w-[140px]" title={item.id}>{item.id}</span>
                        <span className="flex min-w-0 flex-1 items-center gap-1.5 truncate font-medium text-[var(--text-primary)]" title={item.name || item.title || 'Untitled'}>
                          {hasCode && <Code2 className="h-3.5 w-3.5 shrink-0 text-indigo-400" />}
                          <span className="truncate">{item.name || item.title || 'Untitled'}</span>
                        </span>
                        <span className="w-[88px] shrink-0 truncate text-right text-xs text-[var(--text-muted)] sm:w-[110px]" title={item.status || item.date || item.type || ''}>{item.status || item.date || item.type || ''}</span>
                        {canDelete && (
                          <button
                            onClick={(e) => { e.stopPropagation(); deleteArtifact(config.key, item.id); }}
                            disabled={deleting}
                            title="Delete"
                            className="shrink-0 rounded p-1 text-[var(--text-muted)] transition-colors hover:bg-red-500/10 hover:text-red-500 disabled:opacity-50"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </div>
                      );
                    }) : (
                      <div className="px-4 py-6 text-center text-sm text-[var(--text-muted)]">No {config.label.toLowerCase()} in this folder.</div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      </div>

      <Modal isOpen={!!viewerScript} onClose={() => setViewerScript(null)} title={viewerScript?.filename || viewerScript?.name || 'Script'}>
        {viewerScript && (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--text-muted)]">
              <span className="font-mono">{viewerScript.id} · {viewerScript.framework || 'playwright'} · {viewerScript.language || 'typescript'}</span>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => { navigator.clipboard?.writeText(viewerScript.code || ''); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
                  className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2.5 py-1.5 font-medium text-[var(--text-primary)] hover:border-[var(--accent)]"
                >
                  {copied ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />} {copied ? 'Copied' : 'Copy'}
                </button>
                <button
                  onClick={() => {
                    const blob = new Blob([viewerScript.code || ''], { type: 'text/plain' });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = viewerScript.filename || `${viewerScript.id}.spec.ts`;
                    a.click();
                    URL.revokeObjectURL(url);
                  }}
                  className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2.5 py-1.5 font-medium text-[var(--text-primary)] hover:border-[var(--accent)]"
                >
                  <Download className="h-3.5 w-3.5" /> Download
                </button>
              </div>
            </div>
            <pre className="max-h-[60dvh] overflow-auto rounded-md bg-slate-950 p-4 font-mono text-[12px] leading-5 text-slate-200">
              <code>{viewerScript.code}</code>
            </pre>
          </div>
        )}
      </Modal>
    </div>
  );
}





