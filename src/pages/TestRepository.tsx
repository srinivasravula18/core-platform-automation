import { useEffect, useMemo, useState } from 'react';
import { FileText, Layers, PlayCircle, Search, Trash2, ClipboardList, TestTube2, Code2, Copy, Download, Check, CheckSquare, X, Bug, ScrollText, Tag as TagIcon, History } from 'lucide-react';
import { cn } from '@/src/lib/utils';
import { Modal } from '@/src/components/Modal';
import { VersionHistoryPanel } from '@/src/components/VersionHistoryPanel';
import { showAlert, showConfirm } from '@/src/lib/dialog';
import { fetchTagCatalog, type TagCatalogEntry } from '@/src/lib/entityLinking';
import { useDataVersion } from '@/src/store/data';
import { useProjects } from '@/src/store/project';

// Artifact groups backed by a real DELETE/bulk-delete endpoint (evidence is derived, not deletable).
const DELETABLE_KEYS = new Set(['plans', 'suites', 'cases', 'runs', 'reports', 'scripts', 'requirements', 'defects']);

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

// Compare tags ignoring case + the @/# marker so a stored `@sanity` matches a catalog `@sanity`.
const tagKey = (t: any) => String(t || '').trim().toLowerCase().replace(/^[@#]+/, '');

export default function TestRepository() {
  const [artifacts, setArtifacts] = useState<Record<string, any[]>>({ plans: [], suites: [], cases: [], runs: [], reports: [], scripts: [], evidence: [] });
  const [catalog, setCatalog] = useState<TagCatalogEntry[]>([]);
  const [activeTags, setActiveTags] = useState<string[]>([]);
  const [tagFilter, setTagFilter] = useState('');
  const [viewerScript, setViewerScript] = useState<any | null>(null);
  const [scriptHistory, setScriptHistory] = useState(false);
  const [copied, setCopied] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectMode, setSelectMode] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);
  const dataVersion = useDataVersion((s) => s.version);
  const { selectedProjectId, selectedAppId } = useProjects();

  const fetchData = () => {
    Promise.all([
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
      .then(([plans, suites, cases, runs, reports, scripts, agentRuns, requirements, defects]) => {
        const evidence = (Array.isArray(agentRuns) ? agentRuns : []).flatMap((run: any) =>
          (run.evidence_screenshots || []).map((shot: any, index: number) => ({
            id: `${run.id}-evidence-${index + 1}`,
            name: shot.title || shot.screenshotUrl || `Evidence ${index + 1}`,
            title: shot.title || shot.screenshotUrl || `Evidence ${index + 1}`,
            status: shot.status ? `HTTP ${shot.status}` : 'Captured',
          }))
        );
        setArtifacts({
          plans, suites, cases, runs, reports,
          scripts: Array.isArray(scripts) ? scripts : [],
          requirements: Array.isArray(requirements) ? requirements : [],
          defects: Array.isArray(defects) ? defects : [],
          evidence,
        });
      })
      .catch(console.error);
    fetchTagCatalog().then(setCatalog).catch(() => setCatalog([]));
  };

  // Refetch on mount, on any global data-version bump, and when the selected project/app changes.
  useEffect(() => {
    fetchData();
  }, [dataVersion, selectedProjectId, selectedAppId]);

  // Refetch when the tab becomes visible again (mirrors Dashboard).
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') fetchData();
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, []);

  const activeKeys = useMemo(() => activeTags.map(tagKey), [activeTags]);
  const shownCatalog = useMemo(() => {
    const q = tagFilter.trim().toLowerCase();
    return catalog.filter((t) => !q || t.name.toLowerCase().includes(q));
  }, [catalog, tagFilter]);

  const visibleItems = (key: string) => {
    const query = searchTerm.toLowerCase();
    return (artifacts[key] || []).filter((item) => {
      const itemTags = (Array.isArray(item.tags) ? item.tags : []).map(tagKey);
      const matchesTags = !activeKeys.length || activeKeys.every((t) => itemTags.includes(t));
      const matchesSearch = !query || `${item.id || ''} ${item.name || ''} ${item.title || ''} ${item.description || ''}`.toLowerCase().includes(query);
      return matchesTags && matchesSearch;
    });
  };

  const toggleTag = (name: string) =>
    setActiveTags((cur) => (cur.includes(name) ? cur.filter((t) => t !== name) : [...cur, name]));

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
          <p className="mt-1 text-sm text-[var(--text-muted)]">Browse plans, suites, cases, runs, reports, scripts, and evidence by tag.</p>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-5 overflow-hidden lg:grid-cols-[clamp(16rem,20vw,20rem)_minmax(0,1fr)]">
        {/* Tag rail — the organizing axis (folders removed). Selecting tags narrows every group (match all). */}
        <aside className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--bg-card)]">
          <div className="flex items-center justify-between gap-2 border-b border-[var(--border)] p-3">
            <div className="flex items-center gap-2 text-sm font-semibold"><TagIcon className="h-4 w-4 text-[var(--accent)]" /> Tags</div>
            {activeTags.length > 0 && (
              <button onClick={() => setActiveTags([])} className="text-xs font-medium text-[var(--text-muted)] hover:text-[var(--text-primary)]">Clear ({activeTags.length})</button>
            )}
          </div>
          <div className="border-b border-[var(--border)] p-3">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--text-muted)]" />
              <input
                value={tagFilter}
                onChange={(e) => setTagFilter(e.target.value)}
                placeholder="Filter tags…"
                className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] py-1.5 pl-8 pr-2.5 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
              />
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-2">
            {shownCatalog.length === 0 ? (
              <div className="rounded-md border border-dashed border-[var(--border)] px-3 py-6 text-center text-sm text-[var(--text-muted)]">
                No tags yet. Tag cases, suites, plans, or runs to organize them.
              </div>
            ) : shownCatalog.map((t) => {
              const on = activeTags.includes(t.name);
              return (
                <button
                  key={t.name}
                  onClick={() => toggleTag(t.name)}
                  className={cn(
                    'flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-2 text-left text-sm transition-colors',
                    on ? 'bg-[var(--accent)]/10 text-[var(--accent)]' : 'text-[var(--text-muted)] hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)]',
                  )}
                >
                  <span className="min-w-0 truncate">{t.name}</span>
                  <span className="shrink-0 rounded-full bg-[var(--bg-secondary)] px-2 py-0.5 text-xs text-[var(--text-muted)]">{t.count}</span>
                </button>
              );
            })}
          </div>
        </aside>

        <section className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--bg-card)]">
          <div className="flex flex-shrink-0 flex-wrap items-center justify-between gap-3 border-b border-[var(--border)] p-4">
            <div className="min-w-0">
              <div className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">Filtered by</div>
              <h2 className="truncate text-lg font-semibold">{activeTags.length ? activeTags.join(' + ') : 'All items'}</h2>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-muted)]" />
                <input
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  placeholder="Search items..."
                  className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] py-2 pl-9 pr-3 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent)] sm:w-72"
                />
              </div>
              <button onClick={toggleSelectMode} className={cn('inline-flex items-center gap-1.5 rounded-md border px-3 py-2 text-sm font-medium transition-colors', selectMode ? 'border-[var(--accent)] text-[var(--accent)] bg-[var(--accent)]/10' : 'border-[var(--border)] bg-[var(--bg-secondary)] text-[var(--text-primary)] hover:border-[var(--accent)]')}>
                {selectMode ? <X className="h-4 w-4" /> : <CheckSquare className="h-4 w-4" />} {selectMode ? 'Cancel' : 'Select'}
              </button>
              {selectMode && selectedKeys.size > 0 && (
                <button onClick={deleteSelectedArtifacts} disabled={deleting} className="inline-flex items-center gap-1.5 rounded-md bg-red-600 px-3 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50">
                  <Trash2 className="h-4 w-4" /> Delete selected ({selectedKeys.size})
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
                        {Array.isArray(item.tags) && item.tags.length > 0 && (
                          <span className="hidden shrink-0 gap-1 sm:flex">
                            {item.tags.slice(0, 3).map((tag: string) => (
                              <span key={tag} className="rounded-full bg-[var(--bg-card)] px-1.5 py-0.5 text-[10px] text-[var(--text-muted)]">{tag}</span>
                            ))}
                          </span>
                        )}
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
                      <div className="px-4 py-6 text-center text-sm text-[var(--text-muted)]">No {config.label.toLowerCase()} match.</div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      </div>

      <Modal isOpen={!!viewerScript} onClose={() => { setViewerScript(null); setScriptHistory(false); }} title={viewerScript?.filename || viewerScript?.name || 'Script'} size="xl">
        {viewerScript && (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--text-muted)]">
              <span className="font-mono">{viewerScript.id} · {viewerScript.framework || 'playwright'} · {viewerScript.language || 'typescript'}</span>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setScriptHistory((v) => !v)}
                  className={cn('inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 font-medium', scriptHistory ? 'border-[var(--accent)] text-[var(--accent)] bg-[var(--accent)]/10' : 'border-[var(--border)] bg-[var(--bg-secondary)] text-[var(--text-primary)] hover:border-[var(--accent)]')}
                >
                  <History className="h-3.5 w-3.5" /> {scriptHistory ? 'Code' : 'History'}
                </button>
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
            {scriptHistory ? (
              <VersionHistoryPanel entity="scripts" id={viewerScript.id} onRestored={fetchData} />
            ) : (
              <pre className="max-h-[60dvh] overflow-auto rounded-md bg-slate-950 p-4 font-mono text-[12px] leading-5 text-slate-200">
                <code>{viewerScript.code}</code>
              </pre>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}
