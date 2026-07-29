import { useEffect, useMemo, useState } from 'react';
import { ChevronRight, Code2, Folder, Loader2, Search, Video } from 'lucide-react';

// A runnable = anything the data engine can bind to: a Test Case's script, or a captured recording.
export interface Runnable {
  kind: 'script' | 'recording';
  scriptId?: string; recordingId?: string; caseId?: string;
  name: string; folderId?: string | null; targetUrl?: string; updatedAt?: string;
}
export const runnableKey = (item: Runnable) => item.scriptId || item.recordingId || item.name;

type FolderNode = { id: string; name: string; parentId?: string | null; children: FolderNode[] };
const UNCATEGORIZED_ID = '__uncategorized__';
const RECORDINGS_ID = '__recordings__';

function buildFolderTree(folders: Array<{ id: string; name: string; parentId?: string | null }>): FolderNode[] {
  const byId = new Map(folders.map((folder) => [folder.id, { ...folder, children: [] } as FolderNode]));
  const roots: FolderNode[] = [];
  byId.forEach((folder) => {
    const parent = folder.parentId ? byId.get(folder.parentId) : undefined;
    (parent ? parent.children : roots).push(folder);
  });
  const sort = (nodes: FolderNode[]) => nodes.sort((a, b) => a.name.localeCompare(b.name)).forEach((node) => sort(node.children));
  sort(roots);
  return roots;
}

async function json(url: string) {
  const response = await fetch(url);
  return response.json();
}

function TreeNode({ node, items, selectedKey, counts, onSelect, depth }: {
  node: FolderNode; items: Map<string, Runnable[]>; selectedKey: string;
  counts: Map<string, number>; onSelect: (item: Runnable) => void; depth: number;
}) {
  const [open, setOpen] = useState(true);
  const own = items.get(node.id) || [];
  const total = counts.get(node.id) || 0;
  if (!total) return null;
  return <div>
    <div className="flex items-center rounded-md text-[var(--text-muted)] hover:bg-[var(--bg-secondary)]">
      <button type="button" onClick={() => setOpen((value) => !value)} aria-label={`${open ? 'Collapse' : 'Expand'} ${node.name}`} className="ml-1 rounded p-1">
        <ChevronRight className={`h-3.5 w-3.5 transition-transform ${open ? 'rotate-90' : ''}`} />
      </button>
      <div className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pr-2 text-xs font-medium uppercase tracking-wide" style={{ paddingLeft: `${depth * 12}px` }}>
        {node.id === RECORDINGS_ID ? <Video className="h-3.5 w-3.5 shrink-0" /> : <Folder className="h-3.5 w-3.5 shrink-0" />}
        <span className="min-w-0 flex-1 truncate">{node.name}</span>
        <span className="tabular-nums opacity-70">{total}</span>
      </div>
    </div>
    {open && <>
      {own.map((item) => <RunnableRow key={runnableKey(item)} item={item} depth={depth + 1} selected={selectedKey === runnableKey(item)} onSelect={onSelect} />)}
      {node.children.map((child) => <TreeNode key={child.id} node={child} items={items} selectedKey={selectedKey} counts={counts} onSelect={onSelect} depth={depth + 1} />)}
    </>}
  </div>;
}

function RunnableRow({ item, depth, selected, onSelect }: { item: Runnable; depth: number; selected: boolean; onSelect: (item: Runnable) => void }) {
  return <button type="button" onClick={() => onSelect(item)} style={{ paddingLeft: `${12 + depth * 12}px` }}
    className={`flex w-full items-center gap-2 py-1.5 pr-2 text-left text-sm ${selected ? 'bg-[var(--accent)]/10 text-[var(--accent)]' : 'text-[var(--text-primary)] hover:bg-[var(--bg-secondary)]'}`}>
    {item.kind === 'recording' ? <Video className="h-4 w-4 shrink-0 text-[var(--text-muted)]" /> : <Code2 className="h-4 w-4 shrink-0 text-[var(--accent)]" />}
    <span className="min-w-0 flex-1 truncate">{item.name}</span>
  </button>;
}

// Searchable, folder-grouped picker of runnables (primary "RUN WHAT" selector). Scales to large repos.
export function RunnablePicker({ selectedKey, onSelect }: { selectedKey: string; onSelect: (item: Runnable) => void }) {
  const [runnables, setRunnables] = useState<Runnable[]>([]);
  const [tree, setTree] = useState<FolderNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

  useEffect(() => {
    setLoading(true);
    Promise.all([json('/api/automation/runnables'), json('/api/folders')])
      .then(([runnableData, folderData]) => {
        setRunnables(Array.isArray(runnableData?.runnables) ? runnableData.runnables : []);
        const folders = (Array.isArray(folderData) ? folderData : []).map((folder: any) => ({ id: String(folder.id), name: folder.name, parentId: folder.parentId == null ? null : String(folder.parentId) }));
        const roots = buildFolderTree(folders);
        roots.unshift({ id: UNCATEGORIZED_ID, name: 'Uncategorized', children: [] });
        roots.push({ id: RECORDINGS_ID, name: 'Recordings', children: [] });
        setTree(roots);
      })
      .catch(() => undefined)
      .finally(() => setLoading(false));
  }, []);

  // Bucket scripts by folder; recordings collapse into one synthetic "Recordings" group.
  const items = useMemo(() => {
    const map = new Map<string, Runnable[]>();
    for (const item of runnables) {
      const bucket = item.kind === 'recording' ? RECORDINGS_ID : (item.folderId ? String(item.folderId) : UNCATEGORIZED_ID);
      (map.get(bucket) || map.set(bucket, []).get(bucket)!).push(item);
    }
    return map;
  }, [runnables]);

  // Roll child-folder totals up so empty branches can hide themselves.
  const counts = useMemo(() => {
    const total = new Map<string, number>();
    const walk = (node: FolderNode): number => {
      const own = (items.get(node.id) || []).length + node.children.reduce((sum, child) => sum + walk(child), 0);
      total.set(node.id, own);
      return own;
    };
    tree.forEach(walk);
    return total;
  }, [tree, items]);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return query ? runnables.filter((item) => item.name.toLowerCase().includes(query)) : [];
  }, [runnables, search]);

  return <div className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--bg-card)]">
    <div className="shrink-0 border-b border-[var(--border)] p-2">
      <div className="mb-2 px-1 text-sm font-semibold">Run what<span className="ml-1 text-[11px] font-normal text-[var(--text-muted)]">cases · scripts · recordings</span></div>
      <label className="relative block">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-muted)]" />
        <input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search runnables" aria-label="Search runnables"
          className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] py-1.5 pl-8 pr-3 text-sm outline-none focus:border-[var(--accent)]" />
      </label>
    </div>
    <div className="min-h-0 flex-1 overflow-y-auto p-1">
      {loading ? <div className="flex items-center gap-2 p-4 text-sm text-[var(--text-muted)]"><Loader2 className="h-4 w-4 animate-spin" />Loading…</div>
        : search ? (filtered.length ? filtered.map((item) => <RunnableRow key={runnableKey(item)} item={item} depth={0} selected={selectedKey === runnableKey(item)} onSelect={onSelect} />)
            : <div className="p-4 text-sm text-[var(--text-muted)]">No runnables match your search.</div>)
        : (runnables.length ? tree.map((node) => <TreeNode key={node.id} node={node} items={items} selectedKey={selectedKey} counts={counts} onSelect={onSelect} depth={0} />)
            : <div className="p-4 text-sm text-[var(--text-muted)]">No test cases, scripts, or recordings yet.</div>)}
    </div>
  </div>;
}
