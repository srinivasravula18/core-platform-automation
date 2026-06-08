/**
 * Routes for the multi-website, multi-user credential model.
 *
 * Replaces the flat `siteCredentials` array. Each website has many users;
 * each user has its own username, password (encrypted at rest), role, and notes.
 *
 * Passwords are NEVER returned in API responses. The `reveal` endpoint is the
 * single exception and is intended for the agent runtime, not the UI.
 */

import type { Express } from 'express';
import { persistDataInBackground } from '../../shared/storage';
import {
  listWebsites,
  getWebsite,
  listUsersForWebsite,
  getUser,
  createWebsite,
  updateWebsite,
  deleteWebsite,
  createUser,
  updateUser,
  deleteUser,
  resolveCredentials,
  revealPassword,
  maskPassword,
} from './credentialsService';

function userResponse(u: any) {
  return {
    id: u.id,
    websiteId: u.websiteId,
    label: u.label,
    username: u.username,
    role: u.role,
    customRole: u.customRole || '',
    notes: u.notes,
    pageName: u.pageName || '',
    pageUrl: u.pageUrl || '',
    createdAt: u.createdAt,
  };
}

export function registerCredentialsRoutes(app: Express) {
  app.get('/api/credentials/websites', (_req, res) => {
    res.json({ websites: listWebsites() });
  });

  app.post('/api/credentials/websites', (req, res) => {
    const { name, baseUrl, environment, description, tags } = req.body || {};
    if (!name || !baseUrl) return res.status(400).json({ error: 'name and baseUrl are required' });
    const w = createWebsite({
      name,
      baseUrl,
      environment: environment || 'staging',
      description: description || '',
      tags: Array.isArray(tags) ? tags : [],
    });
    persistDataInBackground('create website');
    res.json({ ok: true, website: w });
  });

  app.put('/api/credentials/websites/:id', (req, res) => {
    const w = updateWebsite(req.params.id, req.body || {});
    if (!w) return res.status(404).json({ error: 'Website not found' });
    persistDataInBackground('update website');
    res.json({ ok: true, website: w });
  });

  app.delete('/api/credentials/websites/:id', (req, res) => {
    const ok = deleteWebsite(req.params.id);
    persistDataInBackground('delete website');
    res.json({ ok });
  });

  app.get('/api/credentials/websites/:id/users', (req, res) => {
    res.json({ users: listUsersForWebsite(req.params.id).map(userResponse) });
  });

  app.post('/api/credentials/websites/:id/users', (req, res) => {
    const { label, username, password, role, customRole, notes, pageName, pageUrl } = req.body || {};
    if (!label || !username || !password || !role) {
      return res.status(400).json({ error: 'label, username, password, role are required' });
    }
    const u = createUser({ websiteId: req.params.id, label, username, password, role, customRole, notes, pageName, pageUrl });
    persistDataInBackground('create website user');
    res.json({ ok: true, user: userResponse(u) });
  });

  app.put('/api/credentials/users/:id', (req, res) => {
    const u = updateUser(req.params.id, req.body || {});
    if (!u) return res.status(404).json({ error: 'User not found' });
    persistDataInBackground('update user');
    res.json({ ok: true, user: userResponse(u) });
  });

  app.delete('/api/credentials/users/:id', (req, res) => {
    const ok = deleteUser(req.params.id);
    persistDataInBackground('delete user');
    res.json({ ok });
  });

  app.post('/api/credentials/resolve', (req, res) => {
    const opts = req.body || {};
    const resolved = resolveCredentials({
      userId: opts.userId,
      role: opts.role,
      websiteId: opts.websiteId,
      websiteName: opts.websiteName,
      baseUrl: opts.baseUrl,
      targetUrl: opts.targetUrl,
      inline: opts.inline,
    });
    if (!resolved) return res.status(404).json({ error: 'No matching credentials' });
    res.json({
      ok: true,
      credential: {
        ...resolved,
        password: resolved.password ? maskPassword(resolved.password) : '',
      },
    });
  });

  app.post('/api/credentials/reveal', (req, res) => {
    const { userId } = req.body || {};
    if (!userId) return res.status(400).json({ error: 'userId is required' });
    try {
      const password = revealPassword(userId);
      res.json({ ok: true, password });
    } catch (err: any) {
      res.status(404).json({ error: err?.message || 'User not found' });
    }
  });
}
