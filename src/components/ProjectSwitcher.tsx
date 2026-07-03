import React, { useEffect, useRef, useState } from 'react';
import {
  FolderGit2, ChevronDown, ChevronRight, Plus, Pencil, Trash2, Check, Globe,
  Layers, Boxes, Loader2, AlertCircle, HardDrive, GitBranch, Square, CheckSquare, X,
} from 'lucide-react';
import { cn } from '@/src/lib/utils';
import { useProjects, type Project, type ProjectApp } from '@/src/store/project';
import { ProjectWizard } from '@/src/components/ProjectWizard';

type WizardSpec =
  | { kind: 'project'; editProject?: Project }
  | { kind: 'app'; projectId: string; editApp?: ProjectApp };

export function ProjectSwitcher() {
  const {
    projects, selectedProjectId, selectedAppId, loading, loaded, error,
    fetchProjects, selectProject, selectApp, deleteProject, deleteApp,
  } = useProjects();

  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(selectedProjectId);
  const [wizard, setWizard] = useState<WizardSpec | null>(null);
  const [confirm, setConfirm] = useState<{ type: 'project' | 'app'; id: string; name: string } | null>(null);
  const [bulkConfirm, setBulkConfirm] = useState<{ type: 'project' | 'app'; ids: string[]; count: number } | null>(null);
  const [selectedProjects, setSelectedProjects] = useState<Set<string>>(new Set());
  const [selectedApps, setSelectedApps] = useState<Set<string>>(new Set());
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!loaded) void fetchProjects();
  }, [loaded, fetchProjects]);

  useEffect(() => {
    setExpanded(selectedProjectId);
  }, [selectedProjectId]);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setConfirm(null);
      }
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  const selProject = projects.find((p) => p.id === selectedProjectId) ?? null;
  const selApp = selProject?.apps.find((a) => a.id === selectedAppId) ?? null;

  const doDelete = async () => {
    if (!confirm) return;
    if (confirm.type === 'project') await deleteProject(confirm.id);
    else await deleteApp(confirm.id);
    setConfirm(null);
  };

  const doBulkDelete = async () => {
    if (!bulkConfirm) return;
    for (const id of bulkConfirm.ids) {
      if (bulkConfirm.type === 'project') await deleteProject(id);
      else await deleteApp(id);
    }
    setBulkConfirm(null);
    if (bulkConfirm.type === 'project') setSelectedProjects(new Set());
    else setSelectedApps(new Set());
  };

  const toggleProjectSelection = (projectId: string) => {
    const newSet = new Set(selectedProjects);
    if (newSet.has(projectId)) newSet.delete(projectId);
    else newSet.add(projectId);
    setSelectedProjects(newSet);
  };

  const toggleAppSelection = (appId: string) => {
    const newSet = new Set(selectedApps);
    if (newSet.has(appId)) newSet.delete(appId);
    else newSet.add(appId);
    setSelectedApps(newSet);
  };

  const selectAllProjects = () => {
    if (selectedProjects.size === projects.length) {
      setSelectedProjects(new Set());
    } else {
      setSelectedProjects(new Set(projects.map((p) => p.id)));
    }
  };

  const selectAllAppsInProject = (projectId: string) => {
    const project = projects.find((p) => p.id === projectId);
    if (!project) return;
    const appIds = project.apps.map((a) => a.id);
    const newSet = new Set(selectedApps);
    const allSelected = appIds.every((id) => newSet.has(id));
    if (allSelected) {
      appIds.forEach((id) => newSet.delete(id));
    } else {
      appIds.forEach((id) => newSet.add(id));
    }
    setSelectedApps(newSet);
  };

  return (
    <div ref={ref} className="relative">
      {/* Trigger */}
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2.5 py-1.5 text-xs font-medium text-[var(--text-primary)] hover:bg-[var(--bg-card)] transition-colors max-w-[15rem]"
        title="Switch project / app"
      >
        <FolderGit2 className="w-4 h-4 text-[var(--accent)] shrink-0" />
        <span className="flex flex-col items-start leading-tight min-w-0">
          <span className="truncate max-w-[10rem]">{selProject ? selProject.name : 'Select project'}</span>
          <span className="text-[9px] uppercase tracking-wide text-[var(--text-muted)] truncate max-w-[10rem]">
            {selProject ? (selApp ? selApp.name : 'All apps') : 'no project'}
          </span>
        </span>
        <ChevronDown className={cn('w-3.5 h-3.5 text-[var(--text-muted)] shrink-0 transition-transform', open && 'rotate-180')} />
      </button>

      {/* Dropdown */}
      {open && (
        <div className="absolute left-0 top-full mt-2 w-[min(20rem,calc(100vw-2rem))] rounded-xl border border-[var(--border)] bg-[var(--bg-card)] shadow-2xl z-50 overflow-hidden">
          <div className="px-3 py-2.5 border-b border-[var(--border)]">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">Projects</span>
              <div className="flex items-center gap-1.5">
                {projects.length > 0 && (
                  <button
                    onClick={selectAllProjects}
                    className="flex items-center gap-1 rounded-md border border-[var(--border)] px-2 py-1 text-[11px] font-semibold text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-secondary)] transition-colors"
                    title={selectedProjects.size === projects.length ? 'Deselect all projects' : 'Select all projects'}
                  >
                    {selectedProjects.size === projects.length ? (
                      <CheckSquare className="w-3.5 h-3.5 text-[var(--accent)]" />
                    ) : (
                      <Square className="w-3.5 h-3.5" />
                    )}
                    Select all
                  </button>
                )}
                <button
                  onClick={() => setWizard({ kind: 'project' })}
                  className="flex items-center gap-1 rounded-md bg-[var(--accent)]/10 px-2 py-1 text-[11px] font-semibold text-[var(--accent)] hover:bg-[var(--accent)]/20 transition-colors"
                >
                  <Plus className="w-3.5 h-3.5" /> New project
                </button>
              </div>
            </div>
            {/* Bulk actions bar */}
            {selectedProjects.size > 0 && (
              <div className="flex items-center justify-between gap-2 text-[10px] bg-[var(--bg-secondary)] rounded px-2 py-1.5">
                <span className="text-[var(--text-muted)]">{selectedProjects.size} project(s) selected</span>
                <div className="flex items-center gap-3">
                  <button
                    onClick={() => setSelectedProjects(new Set())}
                    className="flex items-center gap-1 text-[var(--text-muted)] hover:text-[var(--text-primary)] font-medium"
                  >
                    <X className="w-3 h-3" /> Clear
                  </button>
                  <button
                    onClick={() => setBulkConfirm({ type: 'project', ids: Array.from(selectedProjects), count: selectedProjects.size })}
                    className="flex items-center gap-1 text-red-400 hover:text-red-300 font-medium"
                  >
                    <Trash2 className="w-3 h-3" /> Delete
                  </button>
                </div>
              </div>
            )}
            {selectedApps.size > 0 && (
              <div className="mt-1 flex items-center justify-between gap-2 text-[10px] bg-[var(--bg-secondary)] rounded px-2 py-1.5">
                <span className="text-[var(--text-muted)]">{selectedApps.size} app(s) selected</span>
                <div className="flex items-center gap-3">
                  <button
                    onClick={() => setSelectedApps(new Set())}
                    className="flex items-center gap-1 text-[var(--text-muted)] hover:text-[var(--text-primary)] font-medium"
                  >
                    <X className="w-3 h-3" /> Clear
                  </button>
                  <button
                    onClick={() => setBulkConfirm({ type: 'app', ids: Array.from(selectedApps), count: selectedApps.size })}
                    className="flex items-center gap-1 text-red-400 hover:text-red-300 font-medium"
                  >
                    <Trash2 className="w-3 h-3" /> Delete
                  </button>
                </div>
              </div>
            )}
          </div>

          <div className="max-h-[min(24rem,60dvh)] overflow-y-auto py-1">
            {loading && (
              <div className="flex items-center gap-2 px-3 py-6 text-xs text-[var(--text-muted)] justify-center">
                <Loader2 className="w-4 h-4 animate-spin" /> Loading…
              </div>
            )}

            {!loading && error && (
              <div className="flex items-center gap-2 px-3 py-4 text-xs text-red-400">
                <AlertCircle className="w-4 h-4 shrink-0" /> {error}
              </div>
            )}

            {!loading && !error && projects.length === 0 && (
              <div className="px-3 py-8 text-center">
                <Boxes className="w-8 h-8 mx-auto mb-2 text-[var(--text-muted)] opacity-50" />
                <p className="text-xs text-[var(--text-muted)]">No projects yet.</p>
                <button
                  onClick={() => setWizard({ kind: 'project' })}
                  className="mt-3 inline-flex items-center gap-1 rounded-md bg-[var(--accent)] px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90"
                >
                  <Plus className="w-3.5 h-3.5" /> Create your first project
                </button>
              </div>
            )}

            {!loading && !error && projects.map((project) => {
              const isExpanded = expanded === project.id;
              const isSelectedProject = selectedProjectId === project.id;
              return (
                <div key={project.id} className="px-1">
                  {/* Project row */}
                  <div
                    className={cn(
                      'group flex items-center gap-1.5 rounded-md px-1.5 py-1.5',
                      isSelectedProject ? 'bg-[var(--accent)]/8' : 'hover:bg-[var(--bg-secondary)]',
                    )}
                  >
                    <button
                      onClick={(e) => { e.stopPropagation(); toggleProjectSelection(project.id); }}
                      className="p-0.5 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                      title="Select project"
                    >
                      {selectedProjects.has(project.id) ? (
                        <CheckSquare className="w-3.5 h-3.5 text-[var(--accent)]" />
                      ) : (
                        <Square className="w-3.5 h-3.5" />
                      )}
                    </button>
                    <button
                      onClick={() => setExpanded(isExpanded ? null : project.id)}
                      className="p-0.5 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                    >
                      <ChevronRight className={cn('w-3.5 h-3.5 transition-transform', isExpanded && 'rotate-90')} />
                    </button>
                    <button
                      onClick={() => { selectProject(project.id); setExpanded(project.id); }}
                      className="flex flex-1 items-center gap-2 min-w-0 text-left"
                    >
                      <SyncDot status={project.syncStatus} />
                      <span className="flex-1 min-w-0">
                        <span className="block text-sm font-medium text-[var(--text-primary)] truncate">{project.name}</span>
                        <span className="block text-[10px] text-[var(--text-muted)] truncate flex items-center gap-1">
                          {project.repoKind === 'remote' ? <GitBranch className="w-2.5 h-2.5" /> : <HardDrive className="w-2.5 h-2.5" />}
                          {project.repoKind === 'remote' ? (project.repoUrl || 'remote') : (project.repoPath || 'local')}
                        </span>
                      </span>
                      {isSelectedProject && <Check className="w-3.5 h-3.5 text-[var(--accent)] shrink-0" />}
                    </button>
                    <RowActions
                      onEdit={() => setWizard({ kind: 'project', editProject: project })}
                      onDelete={() => setConfirm({ type: 'project', id: project.id, name: project.name })}
                    />
                  </div>

                  {/* Apps */}
                  {isExpanded && (
                    <div className="ml-5 pl-2 border-l border-[var(--border)] my-0.5 space-y-0.5">
                      {/* Select all apps in this project */}
                      <button
                        onClick={(e) => { e.stopPropagation(); selectAllAppsInProject(project.id); }}
                        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[10px] text-[var(--text-muted)] hover:bg-[var(--bg-secondary)]"
                        title="Select all apps in this project"
                      >
                        {project.apps.every((a) => selectedApps.has(a.id)) ? (
                          <CheckSquare className="w-3.5 h-3.5 text-[var(--accent)]" />
                        ) : (
                          <Square className="w-3.5 h-3.5" />
                        )}
                        <span className="font-medium">Select all ({project.apps.length})</span>
                      </button>

                      {/* Project-level (all apps) */}
                      <button
                        onClick={() => { selectProject(project.id); selectApp(null); setOpen(false); }}
                        className={cn(
                          'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left',
                          isSelectedProject && !selectedAppId ? 'bg-[var(--accent)]/10' : 'hover:bg-[var(--bg-secondary)]',
                        )}
                      >
                        <Layers className="w-3.5 h-3.5 text-[var(--text-muted)]" />
                        <span className="flex-1 text-xs font-medium text-[var(--text-primary)]">All apps</span>
                        <span className="text-[9px] uppercase tracking-wide text-[var(--text-muted)]">project-level</span>
                        {isSelectedProject && !selectedAppId && <Check className="w-3 h-3 text-[var(--accent)]" />}
                      </button>

                      {project.apps.map((app) => {
                        const isSelApp = selectedProjectId === project.id && selectedAppId === app.id;
                        return (
                          <div
                            key={app.id}
                            className={cn(
                              'group flex items-center gap-2 rounded-md px-2 py-1.5',
                              isSelApp ? 'bg-[var(--accent)]/10' : 'hover:bg-[var(--bg-secondary)]',
                            )}
                          >
                            <button
                              onClick={(e) => { e.stopPropagation(); toggleAppSelection(app.id); }}
                              className="p-0 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                              title="Select app"
                            >
                              {selectedApps.has(app.id) ? (
                                <CheckSquare className="w-3.5 h-3.5 text-[var(--accent)]" />
                              ) : (
                                <Square className="w-3.5 h-3.5" />
                              )}
                            </button>
                            <button
                              onClick={() => { selectProject(project.id); selectApp(app.id); setOpen(false); }}
                              className="flex flex-1 items-center gap-2 min-w-0 text-left"
                            >
                              <Globe className="w-3.5 h-3.5 text-[var(--text-muted)] shrink-0" />
                              <span className="flex-1 min-w-0">
                                <span className="block text-xs font-medium text-[var(--text-primary)] truncate">{app.name}</span>
                                {app.baseUrl && <span className="block text-[10px] text-[var(--text-muted)] truncate">{app.baseUrl}</span>}
                              </span>
                              {isSelApp && <Check className="w-3 h-3 text-[var(--accent)] shrink-0" />}
                            </button>
                            <RowActions
                              onEdit={() => setWizard({ kind: 'app', projectId: project.id, editApp: app })}
                              onDelete={() => setConfirm({ type: 'app', id: app.id, name: app.name })}
                            />
                          </div>
                        );
                      })}

                      <button
                        onClick={() => setWizard({ kind: 'app', projectId: project.id })}
                        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs font-medium text-[var(--text-muted)] hover:text-[var(--accent)] hover:bg-[var(--bg-secondary)]"
                      >
                        <Plus className="w-3.5 h-3.5" /> New app
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Wizard */}
      {wizard && (
        <ProjectWizard
          kind={wizard.kind}
          projectId={wizard.kind === 'app' ? wizard.projectId : undefined}
          editProject={wizard.kind === 'project' ? wizard.editProject : undefined}
          editApp={wizard.kind === 'app' ? wizard.editApp : undefined}
          onClose={() => setWizard(null)}
        />
      )}

      {/* Delete confirm */}
      {confirm && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/50" onMouseDown={() => setConfirm(null)}>
          <div
            className="w-full max-w-sm rounded-2xl border border-[var(--border)] bg-[var(--bg-card)] shadow-2xl p-5"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2.5 mb-2">
              <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-red-500/10 text-red-400">
                <Trash2 className="w-4.5 h-4.5" />
              </span>
              <h3 className="text-sm font-semibold text-[var(--text-primary)]">Delete {confirm.type}</h3>
            </div>
            <p className="text-xs text-[var(--text-muted)] leading-relaxed">
              Delete <span className="font-medium text-[var(--text-primary)]">{confirm.name}</span>?
              {confirm.type === "project" && " All of its apps will be removed too. "}
              This cannot be undone.
            </p>
            <div className="flex justify-end gap-2 mt-4">
              <button onClick={() => setConfirm(null)} className="rounded-md px-3 py-1.5 text-xs font-medium text-[var(--text-muted)] hover:text-[var(--text-primary)]">
                Cancel
              </button>
              <button onClick={() => void doDelete()} className="rounded-md bg-red-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-600">
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Bulk delete confirm */}
      {bulkConfirm && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/50" onMouseDown={() => setBulkConfirm(null)}>
          <div
            className="w-full max-w-sm rounded-2xl border border-[var(--border)] bg-[var(--bg-card)] shadow-2xl p-5"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2.5 mb-2">
              <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-red-500/10 text-red-400">
                <Trash2 className="w-4.5 h-4.5" />
              </span>
              <h3 className="text-sm font-semibold text-[var(--text-primary)]">
                Delete {bulkConfirm.count} {bulkConfirm.type}
                {bulkConfirm.count > 1 ? "s" : ""}
              </h3>
            </div>
            <p className="text-xs text-[var(--text-muted)] leading-relaxed">
              Permanently delete{" "}
              <span className="font-medium text-red-400">
                {bulkConfirm.count} {bulkConfirm.type}
                {bulkConfirm.count > 1 ? "s" : ""}
              </span>
              ? {bulkConfirm.type === "project" && "All their apps will be removed too. "}
              This cannot be undone.
            </p>
            <div className="flex justify-end gap-2 mt-4">
              <button onClick={() => setBulkConfirm(null)} className="rounded-md px-3 py-1.5 text-xs font-medium text-[var(--text-muted)] hover:text-[var(--text-primary)]">
                Cancel
              </button>
              <button onClick={() => void doBulkDelete()} className="rounded-md bg-red-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-600">
                Delete all
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function RowActions({ onEdit, onDelete }: { onEdit: () => void; onDelete: () => void }) {
  return (
    <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
      <button onClick={onEdit} className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-card)]" title="Edit">
        <Pencil className="w-3.5 h-3.5" />
      </button>
      <button onClick={onDelete} className="p-1 rounded text-[var(--text-muted)] hover:text-red-400 hover:bg-[var(--bg-card)]" title="Delete">
        <Trash2 className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

function SyncDot({ status }: { status: Project['syncStatus'] }) {
  const color =
    status === 'ready' ? 'bg-green-500'
    : status === 'error' ? 'bg-red-500'
    : status === 'syncing' || status === 'connecting' ? 'bg-amber-500'
    : 'bg-[var(--text-muted)]';
  return <span className={cn('w-2 h-2 rounded-full shrink-0', color)} title={status} />;
}
