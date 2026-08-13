import { useEffect, useState } from 'react';
import {
  FolderGit2, Plus, Pencil, Trash2, Check, Globe, Layers, Boxes, Loader2, AlertCircle,
  HardDrive, GitBranch, ChevronRight,
} from 'lucide-react';
import { cn } from '@/src/lib/utils';
import { useProjects, type Project, type ProjectApp } from '@/src/store/project';
import { ProjectWizard } from '@/src/components/ProjectWizard';
import { canCapability } from '@/src/components/AuthGate';

type WizardSpec =
  | { kind: 'project'; editProject?: Project }
  | { kind: 'app'; projectId: string; editApp?: ProjectApp };

/** Projects & apps live on their own page: the sidebar only links here, creation happens here. */
export default function Projects() {
  const {
    projects, selectedProjectId, selectedAppId, loading, loaded, error,
    fetchProjects, selectProject, selectApp, deleteProject, deleteApp,
  } = useProjects();

  const [expanded, setExpanded] = useState<string | null>(selectedProjectId);
  const [wizard, setWizard] = useState<WizardSpec | null>(null);
  const [confirm, setConfirm] = useState<{ type: 'project' | 'app'; id: string; name: string } | null>(null);

  useEffect(() => {
    if (!loaded) void fetchProjects();
  }, [loaded, fetchProjects]);

  const doDelete = async () => {
    if (!confirm) return;
    if (confirm.type === 'project') await deleteProject(confirm.id);
    else await deleteApp(confirm.id);
    setConfirm(null);
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold text-[var(--text-primary)]">
            <FolderGit2 className="w-5 h-5 text-[var(--accent)]" /> Projects
          </h1>
          <p className="mt-1 text-sm text-[var(--text-muted)]">
            Pick the project and app you are working on — everything else in the workspace follows this selection.
          </p>
        </div>
        {canCapability('project:create') && (
          <button
            onClick={() => setWizard({ kind: 'project' })}
            className="flex shrink-0 items-center gap-1.5 rounded-md bg-[var(--accent)] px-3 py-2 text-sm font-semibold text-white hover:opacity-90"
          >
            <Plus className="w-4 h-4" /> New project
          </button>
        )}
      </div>

      {loading && (
        <div className="flex items-center justify-center gap-2 py-16 text-sm text-[var(--text-muted)]">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading projects…
        </div>
      )}

      {!loading && error && (
        <div className="flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/5 px-4 py-3 text-sm text-red-400">
          <AlertCircle className="w-4 h-4 shrink-0" /> {error}
        </div>
      )}

      {!loading && !error && projects.length === 0 && (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] py-16 text-center">
          <Boxes className="mx-auto mb-3 h-10 w-10 text-[var(--text-muted)] opacity-50" />
          <p className="text-sm text-[var(--text-muted)]">No projects yet.</p>
          {canCapability('project:create') && (
            <button
              onClick={() => setWizard({ kind: 'project' })}
              className="mt-4 inline-flex items-center gap-1.5 rounded-md bg-[var(--accent)] px-3 py-2 text-sm font-semibold text-white hover:opacity-90"
            >
              <Plus className="w-4 h-4" /> Create your first project
            </button>
          )}
        </div>
      )}

      {!loading && !error && projects.map((project) => {
        const isExpanded = expanded === project.id;
        const isSelectedProject = selectedProjectId === project.id;
        return (
          <div
            key={project.id}
            className={cn(
              'rounded-xl border bg-[var(--bg-card)] overflow-hidden transition-colors',
              isSelectedProject ? 'border-[var(--accent)]' : 'border-[var(--border)]',
            )}
          >
            <div className="group flex items-center gap-3 px-4 py-3">
              <button
                onClick={() => setExpanded(isExpanded ? null : project.id)}
                className="shrink-0 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                title={isExpanded ? 'Hide apps' : 'Show apps'}
              >
                <ChevronRight className={cn('w-4 h-4 transition-transform', isExpanded && 'rotate-90')} />
              </button>
              <button
                onClick={() => { selectProject(project.id); setExpanded(project.id); }}
                className="flex min-w-0 flex-1 items-center gap-3 text-left"
              >
                <SyncDot status={project.syncStatus} />
                <span className="min-w-0">
                  <span className="block truncate text-sm font-semibold text-[var(--text-primary)]">{project.name}</span>
                  <span className="flex items-center gap-1 truncate text-xs text-[var(--text-muted)]">
                    {project.repoKind === 'remote' ? <GitBranch className="w-3 h-3" /> : <HardDrive className="w-3 h-3" />}
                    {project.repoKind === 'remote' ? (project.repoUrl || 'remote') : (project.repoPath || 'local')}
                  </span>
                </span>
                <span className="ml-auto shrink-0 text-xs text-[var(--text-muted)]">{project.apps.length} app{project.apps.length === 1 ? '' : 's'}</span>
              </button>
              {isSelectedProject && (
                <span className="flex shrink-0 items-center gap-1 rounded-full bg-[var(--accent)]/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--accent)]">
                  <Check className="w-3 h-3" /> Selected
                </span>
              )}
              <RowActions
                onEdit={() => setWizard({ kind: 'project', editProject: project })}
                onDelete={() => setConfirm({ type: 'project', id: project.id, name: project.name })}
              />
            </div>

            {isExpanded && (
              <div className="border-t border-[var(--border)] px-4 py-2">
                <button
                  onClick={() => { selectProject(project.id); selectApp(null); }}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm',
                    isSelectedProject && !selectedAppId ? 'bg-[var(--accent)]/10 text-[var(--accent)]' : 'text-[var(--text-muted)] hover:bg-[var(--bg-secondary)]',
                  )}
                >
                  <Layers className="w-4 h-4 shrink-0" />
                  <span className="flex-1 font-medium">All Apps</span>
                  <span className="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">project-level</span>
                  {isSelectedProject && !selectedAppId && <Check className="w-3.5 h-3.5" />}
                </button>

                {project.apps.map((app) => {
                  const isSelApp = selectedProjectId === project.id && selectedAppId === app.id;
                  return (
                    <div
                      key={app.id}
                      className={cn(
                        'group flex items-center gap-2 rounded-md px-2 py-2',
                        isSelApp ? 'bg-[var(--accent)]/10' : 'hover:bg-[var(--bg-secondary)]',
                      )}
                    >
                      <button
                        onClick={() => { selectProject(project.id); selectApp(app.id); }}
                        className="flex min-w-0 flex-1 items-center gap-2 text-left"
                      >
                        <Globe className={cn('w-4 h-4 shrink-0', isSelApp ? 'text-[var(--accent)]' : 'text-[var(--text-muted)]')} />
                        <span className="min-w-0">
                          <span className={cn('block truncate text-sm font-medium', isSelApp ? 'text-[var(--accent)]' : 'text-[var(--text-primary)]')}>{app.name}</span>
                          {app.baseUrl && <span className="block truncate text-xs text-[var(--text-muted)]">{app.baseUrl}</span>}
                        </span>
                        {isSelApp && <Check className="ml-auto w-3.5 h-3.5 shrink-0 text-[var(--accent)]" />}
                      </button>
                      <RowActions
                        onEdit={() => setWizard({ kind: 'app', projectId: project.id, editApp: app })}
                        onDelete={() => setConfirm({ type: 'app', id: app.id, name: app.name })}
                      />
                    </div>
                  );
                })}

                {canCapability('app:create') && (
                  <button
                    onClick={() => setWizard({ kind: 'app', projectId: project.id })}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm font-medium text-[var(--text-muted)] hover:bg-[var(--bg-secondary)] hover:text-[var(--accent)]"
                  >
                    <Plus className="w-4 h-4 shrink-0" /> New app
                  </button>
                )}
              </div>
            )}
          </div>
        );
      })}

      {wizard && (
        <ProjectWizard
          kind={wizard.kind}
          projectId={wizard.kind === 'app' ? wizard.projectId : undefined}
          editProject={wizard.kind === 'project' ? wizard.editProject : undefined}
          editApp={wizard.kind === 'app' ? wizard.editApp : undefined}
          onClose={() => setWizard(null)}
        />
      )}

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
              {confirm.type === 'project' && ' All of its apps will be removed too. '}
              This cannot be undone.
            </p>
            <div className="flex justify-end gap-2 mt-4">
              <button onClick={() => setConfirm(null)} className="rounded-md px-3 py-1.5 text-xs font-medium text-[var(--text-muted)] hover:text-[var(--text-primary)]">
                Cancel
              </button>
              <button onClick={() => void doDelete()} className="delete-action rounded-md border px-3 py-1.5 text-xs font-semibold">
                Delete
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
    <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
      <button onClick={onEdit} className="rounded p-1.5 text-[var(--text-muted)] hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)]" title="Edit">
        <Pencil className="w-4 h-4" />
      </button>
      <button onClick={onDelete} className="rounded p-1.5 text-[var(--text-muted)] hover:bg-[var(--bg-secondary)] hover:text-red-400" title="Delete">
        <Trash2 className="w-4 h-4" />
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
