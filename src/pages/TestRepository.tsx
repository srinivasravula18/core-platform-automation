import { useEffect, useMemo, useState } from 'react';
import { ChevronRight, FileText, Folder, FolderPlus, Layers, PlayCircle, Search, Trash2, ClipboardList, TestTube2, Code2, Copy, Download, Check } from 'lucide-react';
import { cn } from '@/src/lib/utils';
import { Modal } from '@/src/components/Modal';

type FolderNode = any & { children: FolderNode[] };

const artifactConfig = [
  { key: 'plans', label: 'Plans', icon: FileText },
  { key: 'suites', label: 'Suites', icon: Layers },
  { key: 'cases', label: 'Cases', icon: TestTube2 },
  { key: 'runs', label: 'Runs', icon: PlayCircle },
  { key: 'reports', label: 'Reports', icon: ClipboardList },
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
  const [artifacts, setArtifacts] = useState<Record<string, any[]>>({ plans: [], suites: [], cases: [], runs: [], reports: [], scripts: [], evidence: [] });
  const [viewerScript, setViewerScript] = useState<any | null>(null);
  const [copied, setCopied] = useState(false);
  const [selectedFolderId, setSelectedFolderId] = useState('');
  const [newRootFolderName, setNewRootFolderName] = useState('');
  const [newSubfolderName, setNewSubfolderName] = useState('');
  const [searchTerm, setSearchTerm] = useState('');

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
    ])
      .then(([folderData, plans, suites, cases, runs, reports, scripts, agentRuns]) => {
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
        setArtifacts({ plans, suites, cases, runs, reports, scripts: Array.isArray(scripts) ? scripts : [], evidence });
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
  const tree = useMemo(() => buildTree(folders), [folders]);
  const visibleItems = (key: string) => {
    const query = searchTerm.toLowerCase();
    return (artifacts[key] || []).filter((item) => {
      const inFolder = selectedFolderId ? item.folderId === selectedFolderId : !item.folderId;
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
    <div className="app-page-shell flex h-full min-h-0 flex-col gap-5 overflow-hidden">
      <div className="flex flex-shrink-0 items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Test Repository</h1>
          <p className="mt-1 text-sm text-[var(--text-muted)]">Organize plans, suites, cases, runs, reports, scripts, and evidence by app or feature folders.</p>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-5 overflow-hidden lg:grid-cols-[340px_minmax(0,1fr)]">
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
          <div className="min-h-0 flex-1 overflow-auto p-3">
            {tree.map((node) => (
              <FolderTreeItem key={node.id} node={node} selectedId={selectedFolderId} onSelect={setSelectedFolderId} />
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
                    {items.length ? items.slice(0, 8).map((item) => {
                      const hasCode = config.key === 'scripts' && typeof item.code === 'string' && item.code.length > 0;
                      return (
                      <div
                        key={item.id}
                        onClick={hasCode ? () => { setViewerScript(item); setCopied(false); } : undefined}
                        className={cn(
                          'grid min-w-0 grid-cols-[96px_minmax(0,1fr)_88px] gap-3 px-4 py-3 text-sm sm:grid-cols-[140px_minmax(0,1fr)_110px]',
                          hasCode && 'cursor-pointer hover:bg-[var(--bg-card)]',
                        )}
                        title={hasCode ? 'View script code' : undefined}
                      >
                        <span className="min-w-0 truncate font-mono text-xs text-[var(--text-muted)]" title={item.id}>{item.id}</span>
                        <span className="flex min-w-0 items-center gap-1.5 truncate font-medium text-[var(--text-primary)]" title={item.name || item.title || 'Untitled'}>
                          {hasCode && <Code2 className="h-3.5 w-3.5 shrink-0 text-indigo-400" />}
                          <span className="truncate">{item.name || item.title || 'Untitled'}</span>
                        </span>
                        <span className="min-w-0 truncate text-right text-xs text-[var(--text-muted)]" title={item.status || item.date || item.type || ''}>{item.status || item.date || item.type || ''}</span>
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
            <pre className="max-h-[60vh] overflow-auto rounded-md bg-slate-950 p-4 font-mono text-[12px] leading-5 text-slate-200">
              <code>{viewerScript.code}</code>
            </pre>
          </div>
        )}
      </Modal>
    </div>
  );
}





