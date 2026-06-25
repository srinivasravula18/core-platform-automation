import React, { useEffect, useState } from 'react';
import { X, ChevronLeft, ChevronRight, Check, FolderGit2, Globe, FileCode2, Loader2, GitBranch, HardDrive, KeyRound } from 'lucide-react';
import { cn } from '@/src/lib/utils';
import { useProjects, type Project, type ProjectApp, type ProjectInput } from '@/src/store/project';

type WizardKind = 'project' | 'app';

interface ProjectWizardProps {
  kind: WizardKind;
  /** For an app wizard, the project it belongs to. */
  projectId?: string;
  /** Pass an existing record to edit; omit to create. */
  editProject?: Project;
  editApp?: ProjectApp;
  onClose: () => void;
  onDone?: () => void;
}

const ENVIRONMENTS = ['production', 'staging', 'qa', 'development', 'local'];

function field(label: string, hint: string | undefined, input: React.ReactNode) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-[var(--text-primary)]">{label}</span>
      {hint && <span className="block text-[11px] text-[var(--text-muted)] mt-0.5 mb-1.5">{hint}</span>}
      <div className={hint ? '' : 'mt-1.5'}>{input}</div>
    </label>
  );
}

const inputCls =
  'w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm outline-none focus:border-[var(--accent)] text-[var(--text-primary)] placeholder-[var(--text-muted)] transition-colors';

export function ProjectWizard({ kind, projectId, editProject, editApp, onClose, onDone }: ProjectWizardProps) {
  const { createProject, updateProject, createApp, updateApp } = useProjects();
  const isEdit = Boolean(editProject || editApp);

  // ---- Project form state ----
  const [pName, setPName] = useState(editProject?.name ?? '');
  const [pDesc, setPDesc] = useState(editProject?.description ?? '');
  const [pRepoKind, setPRepoKind] = useState<'local' | 'remote'>(editProject?.repoKind ?? 'local');
  const [pRepoPath, setPRepoPath] = useState(editProject?.repoPath ?? '');
  const [pRepoUrl, setPRepoUrl] = useState(editProject?.repoUrl ?? '');
  const [pBranch, setPBranch] = useState(editProject?.defaultBranch ?? 'main');
  // Private-repo access token. Never pre-filled from the server (the token is never sent back);
  // `hasToken` only tells us one is on file so we can offer "leave blank to keep" / "remove".
  const [pRepoToken, setPRepoToken] = useState('');
  const [pRemoveToken, setPRemoveToken] = useState(false);
  const hadToken = Boolean(editProject?.hasToken);

  // ---- App form state ----
  const [aName, setAName] = useState(editApp?.name ?? '');
  const [aDesc, setADesc] = useState(editApp?.description ?? '');
  const [aBaseUrl, setABaseUrl] = useState(editApp?.baseUrl ?? '');
  const [aEnv, setAEnv] = useState(editApp?.environment ?? 'staging');
  const [aSpecPath, setASpecPath] = useState(editApp?.specPath ?? '/api/openapi.json');
  const [aSubpath, setASubpath] = useState(editApp?.repoSubpath ?? '');

  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Local-folder repos are only usable when the backend runs locally (has disk
  // access). In production the backend is remote, so only a remote git repo
  // makes sense. Default to allowing local until the config loads.
  const [allowLocal, setAllowLocal] = useState(true);
  useEffect(() => {
    fetch('/api/app-config')
      .then((r) => r.json())
      .then((c) => {
        const ok = c?.allowLocalRepo !== false;
        setAllowLocal(ok);
        if (!ok) setPRepoKind('remote'); // production: force remote
      })
      .catch(() => {});
  }, []);

  const steps =
    kind === 'project'
      ? ['Details', 'Repository', 'Review']
      : ['Details', 'Target', 'Code', 'Review'];

  const canNext = (() => {
    if (kind === 'project') {
      if (step === 0) return pName.trim().length > 0;
      if (step === 1) return pRepoKind === 'local' ? pRepoPath.trim().length > 0 : pRepoUrl.trim().length > 0;
      return true;
    }
    if (step === 0) return aName.trim().length > 0;
    return true;
  })();

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      if (kind === 'project') {
        const payload: ProjectInput = {
          name: pName.trim(),
          description: pDesc.trim(),
          repoKind: pRepoKind,
          repoPath: pRepoKind === 'local' ? pRepoPath.trim() : '',
          repoUrl: pRepoKind === 'remote' ? pRepoUrl.trim() : '',
          defaultBranch: pBranch.trim() || 'main',
        };
        if (pRepoKind === 'remote') {
          if (pRepoToken.trim()) payload.repoToken = pRepoToken.trim();
          if (pRemoveToken) payload.removeToken = true;
        }
        if (editProject) await updateProject(editProject.id, payload);
        else await createProject(payload);
      } else {
        const payload: Partial<ProjectApp> = {
          name: aName.trim(),
          description: aDesc.trim(),
          baseUrl: aBaseUrl.trim(),
          environment: aEnv,
          specPath: aSpecPath.trim() || '/api/openapi.json',
          repoSubpath: aSubpath.trim(),
        };
        if (editApp) await updateApp(editApp.id, payload);
        else if (projectId) await createApp(projectId, payload);
      }
      onDone?.();
      onClose();
    } catch (e: any) {
      setError(e?.message || 'Something went wrong.');
      setBusy(false);
    }
  };

  const next = () => {
    if (step < steps.length - 1) setStep((s) => s + 1);
    else void submit();
  };
  const back = () => setStep((s) => Math.max(0, s - 1));

  const title = isEdit
    ? `Edit ${kind === 'project' ? 'project' : 'app'}`
    : kind === 'project'
      ? 'New project'
      : 'New app';

  const Icon = kind === 'project' ? FolderGit2 : FileCode2;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/50" onMouseDown={onClose}>
      <div
        className="w-full max-w-[95vw] sm:max-w-lg rounded-2xl border border-[var(--border)] bg-[var(--bg-card)] shadow-2xl overflow-hidden flex flex-col max-h-[90dvh]"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--border)]">
          <div className="flex items-center gap-2.5">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--accent)]/10 text-[var(--accent)]">
              <Icon className="w-4.5 h-4.5" />
            </span>
            <div>
              <div className="text-sm font-semibold text-[var(--text-primary)]">{title}</div>
              <div className="text-[11px] text-[var(--text-muted)]">
                Step {step + 1} of {steps.length} · {steps[step]}
              </div>
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-md hover:bg-[var(--bg-secondary)] text-[var(--text-muted)]">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Step indicator */}
        <div className="flex items-center gap-1.5 px-5 py-3 border-b border-[var(--border)]">
          {steps.map((s, i) => (
            <React.Fragment key={s}>
              <div
                className={cn(
                  'flex items-center gap-1.5 text-[11px] font-medium',
                  i === step ? 'text-[var(--accent)]' : i < step ? 'text-[var(--text-primary)]' : 'text-[var(--text-muted)]',
                )}
              >
                <span
                  className={cn(
                    'flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold border',
                    i < step
                      ? 'bg-[var(--accent)] border-[var(--accent)] text-white'
                      : i === step
                        ? 'border-[var(--accent)] text-[var(--accent)]'
                        : 'border-[var(--border)] text-[var(--text-muted)]',
                  )}
                >
                  {i < step ? <Check className="w-3 h-3" /> : i + 1}
                </span>
                <span className="hidden sm:inline">{s}</span>
              </div>
              {i < steps.length - 1 && <div className="flex-1 h-px bg-[var(--border)]" />}
            </React.Fragment>
          ))}
        </div>

        {/* Body */}
        <div className="px-5 py-5 space-y-4 flex-1 min-h-0 overflow-y-auto">
          {kind === 'project' && step === 0 && (
            <>
              {field('Project name', 'One project maps to one git repository.', (
                <input className={inputCls} value={pName} onChange={(e) => setPName(e.target.value)} placeholder="e.g. Core Platform" autoFocus />
              ))}
              {field('Description', 'Optional.', (
                <textarea className={cn(inputCls, 'resize-none h-20')} value={pDesc} onChange={(e) => setPDesc(e.target.value)} placeholder="What this codebase is…" />
              ))}
            </>
          )}

          {kind === 'project' && step === 1 && (
            <>
              {allowLocal
                ? field('Repository source', 'Where this project’s one codebase lives.', (
                    <div className="grid grid-cols-2 gap-2">
                      {([
                        { v: 'local', label: 'Local folder', icon: HardDrive, hint: 'Already on this machine' },
                        { v: 'remote', label: 'Remote URL', icon: GitBranch, hint: 'Connect a GitHub repo' },
                      ] as const).map((opt) => (
                        <button
                          key={opt.v}
                          onClick={() => setPRepoKind(opt.v)}
                          className={cn(
                            'flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition-colors',
                            pRepoKind === opt.v
                              ? 'border-[var(--accent)] bg-[var(--accent)]/5'
                              : 'border-[var(--border)] hover:bg-[var(--bg-secondary)]',
                          )}
                        >
                          <opt.icon className={cn('w-4 h-4', pRepoKind === opt.v ? 'text-[var(--accent)]' : 'text-[var(--text-muted)]')} />
                          <span className="text-xs font-medium text-[var(--text-primary)]">{opt.label}</span>
                          <span className="text-[10px] text-[var(--text-muted)]">{opt.hint}</span>
                        </button>
                      ))}
                    </div>
                  ))
                : (
                    <div className="flex items-start gap-2 rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] p-3">
                      <GitBranch className="w-4 h-4 mt-0.5 text-[var(--accent)]" />
                      <div>
                        <div className="text-xs font-medium text-[var(--text-primary)]">Remote git repository</div>
                        <div className="text-[10px] text-[var(--text-muted)]">
                          This is a production deployment — connect the project’s GitHub repo. Local folders aren’t available here.
                        </div>
                      </div>
                    </div>
                  )}
              {pRepoKind === 'local'
                ? field('Local repo path', 'Absolute path to the repo folder on this machine.', (
                    <input className={inputCls} value={pRepoPath} onChange={(e) => setPRepoPath(e.target.value)} placeholder="D:\\core-platform" />
                  ))
                : field('Repository URL', 'HTTPS clone URL.', (
                    <input className={inputCls} value={pRepoUrl} onChange={(e) => setPRepoUrl(e.target.value)} placeholder="https://github.com/org/repo.git" />
                  ))}
              {pRepoKind === 'remote' &&
                field(
                  'Access token',
                  hadToken
                    ? 'A token is saved. Leave blank to keep it, or paste a new one to replace it.'
                    : 'Required for private repos. Use a fine-grained, read-only token scoped to this repo.',
                  (
                    <>
                      <div className="relative">
                        <KeyRound className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-muted)]" />
                        <input
                          className={cn(inputCls, 'pl-9')}
                          type="password"
                          autoComplete="off"
                          value={pRepoToken}
                          onChange={(e) => { setPRepoToken(e.target.value); if (e.target.value) setPRemoveToken(false); }}
                          placeholder={hadToken ? '•••••••••••• (saved)' : 'github_pat_… or ghp_…'}
                          disabled={pRemoveToken}
                        />
                      </div>
                      <p className="text-[11px] text-[var(--text-muted)] mt-1.5 leading-relaxed">
                        Stored encrypted on the server and never shown again. We verify access when you save.
                        Public repos can be left blank.
                      </p>
                      {hadToken && (
                        <label className="flex items-center gap-2 mt-2 text-[11px] text-[var(--text-muted)] cursor-pointer">
                          <input
                            type="checkbox"
                            checked={pRemoveToken}
                            onChange={(e) => { setPRemoveToken(e.target.checked); if (e.target.checked) setPRepoToken(''); }}
                          />
                          Remove the saved token (treat as a public repo)
                        </label>
                      )}
                    </>
                  ),
                )}
              {field('Default branch', undefined, (
                <input className={inputCls} value={pBranch} onChange={(e) => setPBranch(e.target.value)} placeholder="main" />
              ))}
            </>
          )}

          {kind === 'project' && step === 2 && (
            <ReviewRows
              rows={[
                ['Name', pName],
                ['Description', pDesc || '—'],
                ['Source', pRepoKind === 'local' ? 'Local folder' : 'Remote URL'],
                [pRepoKind === 'local' ? 'Path' : 'URL', pRepoKind === 'local' ? pRepoPath : pRepoUrl],
                ['Branch', pBranch || 'main'],
                ...(pRepoKind === 'remote'
                  ? [[
                      'Access token',
                      pRemoveToken
                        ? 'Will be removed (public repo)'
                        : pRepoToken.trim()
                          ? 'New token — will be saved & verified'
                          : hadToken
                            ? 'Keep saved token'
                            : 'None (public repo)',
                    ] as [string, string]]
                  : []),
              ]}
            />
          )}

          {kind === 'app' && step === 0 && (
            <>
              {field('App name', 'A testable surface inside the project’s codebase.', (
                <input className={inputCls} value={aName} onChange={(e) => setAName(e.target.value)} placeholder="e.g. Admin Console" autoFocus />
              ))}
              {field('Description', 'Optional.', (
                <textarea className={cn(inputCls, 'resize-none h-20')} value={aDesc} onChange={(e) => setADesc(e.target.value)} placeholder="What this surface does…" />
              ))}
            </>
          )}

          {kind === 'app' && step === 1 && (
            <>
              {field('Base URL', 'The deployed surface the agent tests against.', (
                <div className="relative">
                  <Globe className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-muted)]" />
                  <input className={cn(inputCls, 'pl-9')} value={aBaseUrl} onChange={(e) => setABaseUrl(e.target.value)} placeholder="https://app.example.com" />
                </div>
              ))}
              {field('Environment', undefined, (
                <select className={inputCls} value={aEnv} onChange={(e) => setAEnv(e.target.value)}>
                  {ENVIRONMENTS.map((env) => (
                    <option key={env} value={env}>{env}</option>
                  ))}
                </select>
              ))}
              {field('OpenAPI spec path', 'Where the app publishes its OpenAPI/Swagger spec. The agent grounds tests from it.', (
                <input className={inputCls} value={aSpecPath} onChange={(e) => setASpecPath(e.target.value)} placeholder="/api/openapi.json" />
              ))}
            </>
          )}

          {kind === 'app' && step === 2 && (
            <>
              {field('Repo sub-path', 'Where this app lives in the project repo (blank = whole repo).', (
                <input className={inputCls} value={aSubpath} onChange={(e) => setASubpath(e.target.value)} placeholder="apps/admin" />
              ))}
              <p className="text-[11px] text-[var(--text-muted)] leading-relaxed">
                The agent grounds generated tests in this slice of the codebase and binds an
                App Knowledge spec (structure, DB, APIs, services) to it — editable later in Settings.
              </p>
            </>
          )}

          {kind === 'app' && step === 3 && (
            <ReviewRows
              rows={[
                ['Name', aName],
                ['Description', aDesc || '—'],
                ['Base URL', aBaseUrl || '—'],
                ['Environment', aEnv],
                ['Repo sub-path', aSubpath || '(whole repo)'],
              ]}
            />
          )}

          {error && <div className="rounded-md bg-red-500/10 border border-red-500/30 px-3 py-2 text-xs text-red-400">{error}</div>}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-4 border-t border-[var(--border)]">
          <button
            onClick={step === 0 ? onClose : back}
            disabled={busy}
            className="flex items-center gap-1 text-sm font-medium text-[var(--text-muted)] hover:text-[var(--text-primary)] disabled:opacity-50"
          >
            <ChevronLeft className="w-4 h-4" />
            {step === 0 ? 'Cancel' : 'Back'}
          </button>
          <button
            onClick={next}
            disabled={!canNext || busy}
            className="flex items-center gap-1.5 rounded-md bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50 transition-opacity"
          >
            {busy ? (
              <><Loader2 className="w-4 h-4 animate-spin" /> Saving…</>
            ) : step === steps.length - 1 ? (
              <><Check className="w-4 h-4" /> {isEdit ? 'Save changes' : `Create ${kind}`}</>
            ) : (
              <>Next <ChevronRight className="w-4 h-4" /></>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

function ReviewRows({ rows }: { rows: Array<[string, string]> }) {
  return (
    <div className="rounded-lg border border-[var(--border)] divide-y divide-[var(--border)] overflow-hidden">
      {rows.map(([k, v]) => (
        <div key={k} className="flex items-start gap-3 px-3 py-2.5">
          <span className="w-28 shrink-0 text-[11px] font-medium uppercase tracking-wide text-[var(--text-muted)]">{k}</span>
          <span className="text-sm text-[var(--text-primary)] break-all">{v}</span>
        </div>
      ))}
    </div>
  );
}
