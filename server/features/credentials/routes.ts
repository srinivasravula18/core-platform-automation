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
import { reqScope, reqGrants } from '../../shared/scope';
import { isAllowed, UNRESTRICTED } from '../auth/groupStore';
import { recordAudit } from '../../shared/recordAudit';
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

/** Only an admin may mark a URL as shared-with-team; testers' URLs stay private. */
function reqIsAdmin(req: any): boolean {
  return reqScope(req).role === 'admin';
}

// MANAGE access (edit/delete/logins): a user may manage a website they OWN or that an Access Group
// grants. Shared is deliberately NOT here — an admin-shared URL is usable by testers (it shows in
// their list) but only the owning admin may manage it. UNRESTRICTED keeps own-only isolation.
function canAccessWebsite(req: any, websiteId: string): boolean {
  const scope = reqScope(req);
  if (!scope.userId) return true;
  const w = getWebsite(websiteId);
  if (!w) return false;
  if ((w.ownerId || '') === scope.userId) return true;
  const grants = reqGrants(req);
  return grants !== UNRESTRICTED && isAllowed(grants, 'websites', websiteId);
}
function canAccessUser(req: any, userId: string): boolean {
  const u = getUser(userId);
  return !!u && canAccessWebsite(req, u.websiteId);
}

export function registerCredentialsRoutes(app: Express) {
  app.get('/api/credentials/websites', (req, res) => {
    const scope = reqScope(req);
    let websites = listWebsites();
    if (scope.userId) {
      const owned = (w: any) => (w.ownerId || '') === scope.userId;
      const grants = reqGrants(req);
      // Admin/UNRESTRICTED: own-only. Testers also see admin-shared URLs and anything a group grants.
      websites = grants === UNRESTRICTED
        ? websites.filter(owned)
        : websites.filter((w) => owned(w) || w.shared === true || isAllowed(grants, 'websites', w.id));
    }
    res.json({ websites });
  });

  app.post('/api/credentials/websites', (req, res) => {
    const { name, baseUrl, environment, description, tags, shared } = req.body || {};
    if (!name || !baseUrl) return res.status(400).json({ error: 'name and baseUrl are required' });
    const w = createWebsite({
      name,
      baseUrl,
      environment: environment || 'staging',
      description: description || '',
      tags: Array.isArray(tags) ? tags : [],
      ownerId: reqScope(req).userId || '',
      // Only an admin may share; a tester's URL is always private regardless of what the client sends.
      shared: reqIsAdmin(req) && shared === true,
    });
    persistDataInBackground('create website');
    recordAudit('create', 'credential', w.id, `Added website credential "${w.name}"`);
    res.json({ ok: true, website: w });
  });

  app.put('/api/credentials/websites/:id', (req, res) => {
    if (!canAccessWebsite(req, req.params.id)) return res.status(404).json({ error: 'Website not found' });
    const patch = { ...(req.body || {}) };
    // Only an admin may change sharing; a tester's URL stays private no matter what is sent.
    if ('shared' in patch) {
      if (reqIsAdmin(req)) patch.shared = patch.shared === true;
      else delete patch.shared;
    }
    const w = updateWebsite(req.params.id, patch);
    if (!w) return res.status(404).json({ error: 'Website not found' });
    persistDataInBackground('update website');
    recordAudit('update', 'credential', w.id, `Updated website credential "${w.name}"`);
    res.json({ ok: true, website: w });
  });

  app.delete('/api/credentials/websites/:id', (req, res) => {
    if (!canAccessWebsite(req, req.params.id)) return res.status(404).json({ error: 'Website not found' });
    const ok = deleteWebsite(req.params.id);
    persistDataInBackground('delete website');
    recordAudit('delete', 'credential', req.params.id, 'Deleted a website credential');
    res.json({ ok });
  });

  app.get('/api/credentials/websites/:id/users', (req, res) => {
    if (!canAccessWebsite(req, req.params.id)) return res.status(404).json({ error: 'Website not found' });
    res.json({ users: listUsersForWebsite(req.params.id).map(userResponse) });
  });

  app.post('/api/credentials/websites/:id/users', (req, res) => {
    if (!canAccessWebsite(req, req.params.id)) return res.status(404).json({ error: 'Website not found' });
    const { label, username, password, role, customRole, notes, pageName, pageUrl } = req.body || {};
    if (!label || !username || !password || !role) {
      return res.status(400).json({ error: 'label, username, password, role are required' });
    }
    const u = createUser({ websiteId: req.params.id, label, username, password, role, customRole, notes, pageName, pageUrl });
    persistDataInBackground('create website user');
    recordAudit('create', 'credential-login', u.id, `Added login "${u.username}"`);
    res.json({ ok: true, user: userResponse(u) });
  });

  app.put('/api/credentials/users/:id', (req, res) => {
    if (!canAccessUser(req, req.params.id)) return res.status(404).json({ error: 'User not found' });
    const u = updateUser(req.params.id, req.body || {});
    if (!u) return res.status(404).json({ error: 'User not found' });
    persistDataInBackground('update user');
    recordAudit('update', 'credential-login', u.id, `Updated login "${u.username}"`);
    res.json({ ok: true, user: userResponse(u) });
  });

  app.delete('/api/credentials/users/:id', (req, res) => {
    if (!canAccessUser(req, req.params.id)) return res.status(404).json({ error: 'User not found' });
    const ok = deleteUser(req.params.id);
    persistDataInBackground('delete user');
    recordAudit('delete', 'credential-login', req.params.id, 'Deleted a login');
    res.json({ ok });
  });

  app.post('/api/credentials/resolve', (req, res) => {
    const opts = req.body || {};
    const scope = reqScope(req);
    const resolved = resolveCredentials({
      userId: opts.userId,
      role: opts.role,
      websiteId: opts.websiteId,
      websiteName: opts.websiteName,
      baseUrl: opts.baseUrl,
      targetUrl: opts.targetUrl,
      inline: opts.inline,
      // Strict isolation: a run only ever resolves against the acting user's own websites.
      ownerId: scope.userId || undefined,
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
    if (!canAccessUser(req, userId)) return res.status(404).json({ error: 'User not found' });
    try {
      const password = revealPassword(userId);
      res.json({ ok: true, password });
    } catch (err: any) {
      res.status(404).json({ error: err?.message || 'User not found' });
    }
  });
}
