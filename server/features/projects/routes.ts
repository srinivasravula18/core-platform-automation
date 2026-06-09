import type { Express } from 'express';
import {
  listProjectsWithApps,
  getProject,
  createProject,
  updateProject,
  deleteProject,
  listApps,
  createApp,
  updateApp,
  deleteApp,
} from './projectService';

export function registerProjectRoutes(app: Express) {
  // ---- Projects ----
  app.get('/api/projects', (_req, res) => {
    res.json({ projects: listProjectsWithApps() });
  });

  app.get('/api/projects/:id', (req, res) => {
    const project = getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found.' });
    res.json({ ...project, apps: listApps(project.id) });
  });

  app.post('/api/projects', (req, res) => {
    try {
      const project = createProject(req.body || {});
      res.status(201).json(project);
    } catch (e: any) {
      res.status(400).json({ error: e?.message || 'Failed to create project.' });
    }
  });

  app.put('/api/projects/:id', (req, res) => {
    try {
      const project = updateProject(req.params.id, req.body || {});
      res.json(project);
    } catch (e: any) {
      const code = /not found/i.test(e?.message || '') ? 404 : 400;
      res.status(code).json({ error: e?.message || 'Failed to update project.' });
    }
  });

  app.delete('/api/projects/:id', (req, res) => {
    const ok = deleteProject(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Project not found.' });
    res.json({ ok: true });
  });

  // ---- Apps (nested under a project) ----
  app.get('/api/projects/:id/apps', (req, res) => {
    if (!getProject(req.params.id)) return res.status(404).json({ error: 'Project not found.' });
    res.json({ apps: listApps(req.params.id) });
  });

  app.post('/api/projects/:id/apps', (req, res) => {
    try {
      const created = createApp(req.params.id, req.body || {});
      res.status(201).json(created);
    } catch (e: any) {
      const code = /not found/i.test(e?.message || '') ? 404 : 400;
      res.status(code).json({ error: e?.message || 'Failed to create app.' });
    }
  });

  app.put('/api/apps/:id', (req, res) => {
    try {
      const updated = updateApp(req.params.id, req.body || {});
      res.json(updated);
    } catch (e: any) {
      const code = /not found/i.test(e?.message || '') ? 404 : 400;
      res.status(code).json({ error: e?.message || 'Failed to update app.' });
    }
  });

  app.delete('/api/apps/:id', (req, res) => {
    const ok = deleteApp(req.params.id);
    if (!ok) return res.status(404).json({ error: 'App not found.' });
    res.json({ ok: true });
  });
}
