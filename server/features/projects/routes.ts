import type { Express } from 'express';
import {
  listProjectsWithApps,
  getProject,
  createProject,
  updateProject,
  deleteProject,
  listApps,
  getApp,
  createApp,
  updateApp,
  deleteApp,
  type Project,
} from './projectService';
import { setRepoToken, getRepoToken, hasRepoToken, clearRepoToken } from './repoSecrets';
import { validateRemoteAccess, type RemoteCheck } from './repoSync';
import { projectRepo } from './projectRepo';
import { GitHubError } from './githubApi';
import { reqScope } from '../../shared/scope';

/** Every logged-in user sees only their own projects (no cross-user visibility). */
function visibleToScope<T extends { ownerId?: string }>(items: T[], req: any): T[] {
  const scope = reqScope(req);
  if (scope.userId) {
    return items.filter((p) => (p.ownerId || '') === scope.userId);
  }
  return items;
}

/** True if the request's user owns the project (or no user scope is set). */
function ownsProject(req: any, projectId: string): boolean {
  const project = getProject(projectId);
  if (!project) return false;
  const scope = reqScope(req);
  return !scope.userId || (project.ownerId || '') === scope.userId;
}

/** True if the request's user owns the project the app belongs to. Apps are scoped via their project. */
function ownsApp(req: any, appId: string): boolean {
  const appRec = getApp(appId);
  if (!appRec) return false;
  return ownsProject(req, appRec.projectId);
}

/** Attach the non-secret `hasToken` flag so the UI can show "token saved" without ever seeing it. */
function withTokenFlag<T extends { id: string }>(project: T): T & { hasToken: boolean } {
  return { ...project, hasToken: hasRepoToken(project.id) };
}

/** Reflect a completed access check onto the record (syncStatus / lastError / lastSyncedSha). */
function applyRemoteStatus(project: Project, check: RemoteCheck) {
  if (check.ok) {
    updateProject(project.id, {
      syncStatus: 'ready',
      lastSyncedSha: check.sha || '',
      lastError: '',
      repoAuthRef: hasRepoToken(project.id) ? 'stored' : '',
    });
  } else {
    updateProject(project.id, { syncStatus: 'error', lastError: check.error || 'Could not connect to the repository.' });
  }
}

export function registerProjectRoutes(app: Express) {
  // ---- Projects ----
  app.get('/api/projects', (req, res) => {
    res.json({ projects: visibleToScope(listProjectsWithApps(), req).map(withTokenFlag) });
  });

  app.get('/api/projects/:id', (req, res) => {
    const project = getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found.' });
    // Don't let one user read another user's project by guessing its id.
    const scope = reqScope(req);
    if (scope.userId && (project.ownerId || '') !== scope.userId) {
      return res.status(404).json({ error: 'Project not found.' });
    }
    res.json(withTokenFlag({ ...project, apps: listApps(project.id) }));
  });

  app.post('/api/projects', async (req, res) => {
    try {
      // Keep the token out of the persisted Project record — it goes to the encrypted store.
      const { repoToken, removeToken: _ignore, ...rest } = req.body || {};
      const token = String(repoToken || '').trim();
      const repoUrl = String(rest.repoUrl || '').trim();

      // For a remote repo, prove access ONCE before creating, so an auth failure
      // surfaces inline in the wizard instead of leaving an orphan project.
      let check: RemoteCheck | null = null;
      if (rest.repoKind === 'remote' && repoUrl) {
        check = await validateRemoteAccess(repoUrl, token);
        if (!check.ok && check.authFailed) return res.status(400).json({ error: check.error });
      }

      const project = createProject({ ...rest, ownerId: reqScope(req).userId || '' });
      if (token) setRepoToken(project.id, token);
      if (check) applyRemoteStatus(project, check); // reuse the check — no second network call
      res.status(201).json(withTokenFlag(getProject(project.id)!));
    } catch (e: any) {
      res.status(400).json({ error: e?.message || 'Failed to create project.' });
    }
  });

  app.put('/api/projects/:id', async (req, res) => {
    try {
      const { repoToken, removeToken, ...rest } = req.body || {};
      const existing = getProject(req.params.id);
      if (!existing) return res.status(404).json({ error: 'Project not found.' });

      const tokenChanged = removeToken || String(repoToken || '').trim().length > 0;
      if (removeToken) clearRepoToken(existing.id);
      else if (String(repoToken || '').trim()) setRepoToken(existing.id, String(repoToken).trim());

      const project = updateProject(req.params.id, rest);

      // Re-validate only when something that affects access changed (token or URL).
      const urlChanged = rest.repoUrl !== undefined && String(rest.repoUrl).trim() !== (existing.repoUrl || '');
      if (project.repoKind === 'remote' && project.repoUrl && (tokenChanged || urlChanged)) {
        const check = await validateRemoteAccess(project.repoUrl, getRepoToken(project.id));
        applyRemoteStatus(project, check);
        if (!check.ok && check.authFailed) return res.status(400).json({ error: check.error });
      }
      res.json(withTokenFlag(getProject(project.id)!));
    } catch (e: any) {
      const code = /not found/i.test(e?.message || '') ? 404 : 400;
      res.status(code).json({ error: e?.message || 'Failed to update project.' });
    }
  });

  app.delete('/api/projects/:id', (req, res) => {
    const ok = deleteProject(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Project not found.' });
    clearRepoToken(req.params.id);
    res.json({ ok: true });
  });

  // ---- Repo access (local disk OR GitHub API, no clone) ----
  // Agents use server/features/projects/projectRepo.ts directly; these routes
  // expose the same capability over HTTP for the UI and for verification.
  // Both providers throw errors carrying a numeric `.status`.
  const repo = (handler: (req: any) => unknown) => async (req: any, res: any) => {
    try {
      res.json(await handler(req)); // await tolerates both sync (local) and async (remote) providers
    } catch (e: any) {
      const status = typeof e?.status === 'number' ? e.status : 500;
      res.status(status).json({ error: e?.message || 'Repo request failed.', kind: e?.kind });
    }
  };

  app.get('/api/projects/:id/repo', repo((req) => projectRepo.meta(req.params.id)));

  app.get('/api/projects/:id/repo/branches', repo((req) => projectRepo.branches(req.params.id)));

  app.get('/api/projects/:id/repo/tree', repo((req) =>
    projectRepo.tree(req.params.id, req.query.ref as string | undefined, req.query.recursive !== 'false'),
  ));

  app.get('/api/projects/:id/repo/file', repo((req) => {
    const path = String(req.query.path || '');
    if (!path) throw new GitHubError('A file path is required.', 400, 'parse');
    return projectRepo.readFile(req.params.id, path, req.query.ref as string | undefined);
  }));

  app.get('/api/projects/:id/repo/commits', repo((req) =>
    projectRepo.commits(req.params.id, {
      refName: req.query.ref as string | undefined,
      since: req.query.since as string | undefined,
      path: req.query.path as string | undefined,
      perPage: req.query.perPage ? Number(req.query.perPage) : undefined,
    }),
  ));

  app.get('/api/projects/:id/repo/commit/:sha', repo((req) => projectRepo.commitDiff(req.params.id, req.params.sha)));

  app.get('/api/projects/:id/repo/compare', repo((req) => {
    const base = String(req.query.base || '');
    const head = String(req.query.head || '');
    if (!base || !head) throw new GitHubError('Both base and head refs are required.', 400, 'parse');
    return projectRepo.compare(req.params.id, base, head);
  }));

  app.get('/api/projects/:id/repo/search', repo((req) => {
    const q = String(req.query.q || '');
    if (!q) throw new GitHubError('A search query (q) is required.', 400, 'parse');
    return projectRepo.search(req.params.id, q, req.query.perPage ? Number(req.query.perPage) : undefined);
  }));

  // ---- Apps (nested under a project) ----
  app.get('/api/projects/:id/apps', (req, res) => {
    // 404 (not 403) on a foreign/missing project so ids aren't enumerable across tenants.
    if (!ownsProject(req, req.params.id)) return res.status(404).json({ error: 'Project not found.' });
    res.json({ apps: listApps(req.params.id) });
  });

  app.post('/api/projects/:id/apps', (req, res) => {
    if (!ownsProject(req, req.params.id)) return res.status(404).json({ error: 'Project not found.' });
    try {
      const created = createApp(req.params.id, req.body || {});
      res.status(201).json(created);
    } catch (e: any) {
      const code = /not found/i.test(e?.message || '') ? 404 : 400;
      res.status(code).json({ error: e?.message || 'Failed to create app.' });
    }
  });

  app.put('/api/apps/:id', (req, res) => {
    if (!ownsApp(req, req.params.id)) return res.status(404).json({ error: 'App not found.' });
    try {
      const updated = updateApp(req.params.id, req.body || {});
      res.json(updated);
    } catch (e: any) {
      const code = /not found/i.test(e?.message || '') ? 404 : 400;
      res.status(code).json({ error: e?.message || 'Failed to update app.' });
    }
  });

  app.delete('/api/apps/:id', (req, res) => {
    if (!ownsApp(req, req.params.id)) return res.status(404).json({ error: 'App not found.' });
    const ok = deleteApp(req.params.id);
    if (!ok) return res.status(404).json({ error: 'App not found.' });
    res.json({ ok: true });
  });
}
