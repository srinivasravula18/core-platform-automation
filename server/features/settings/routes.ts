import type { Express } from 'express';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { db, savePersistedData, savePersistedSettings, addActivity } from '../../shared/storage';
import { isPostgresEnabled, query } from '../../db/pool';

const ARTIFACT_KEYS = [
  'folders',
  'plans',
  'suites',
  'cases',
  'runs',
  'defects',
  'scripts',
  'agentRuns',
  'reports',
  'requirements',
  'requirementLinks',
  'blackboard',
] as const;

const PG_SOFT_DELETE_TABLES = [
  'plans',
  'suites',
  'cases',
  'runs',
  'defects',
  'scripts',
  'reports',
  'requirements',
  'folders',
] as const;

async function clearPostgresArtifacts(): Promise<Record<string, number>> {
  const removed: Record<string, number> = {};
  const linkRows = await query('DELETE FROM requirement_case_links RETURNING id');
  removed.requirementLinks = linkRows.length;
  const agentRows = await query('DELETE FROM agent_runs RETURNING id');
  removed.agentRuns = agentRows.length;
  for (const table of PG_SOFT_DELETE_TABLES) {
    const rows = await query(`UPDATE ${table} SET deleted_at = now() WHERE deleted_at IS NULL RETURNING id`);
    removed[table] = rows.length;
  }
  return removed;
}

// Count files under a folder (recursively), skipping heavy/irrelevant dirs. Bounded so a huge tree
// can't hang the request. Used to verify a configured server repo root actually points at real code.
function countRepoFiles(root: string): { files: number; truncated: boolean } {
  const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'out', 'coverage', 'tmp', '.turbo', '.cache']);
  const MAX = 300_000;
  let files = 0;
  let truncated = false;
  const stack = [root];
  while (stack.length) {
    if (files >= MAX) { truncated = true; break; }
    const dir = stack.pop() as string;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIP.has(entry.name)) stack.push(path.join(dir, entry.name));
      } else if (entry.isFile()) {
        files += 1;
      }
    }
  }
  return { files, truncated };
}

export function registerSettingsRoutes(app: Express) {
  app.get('/api/settings', (req, res) => {
    res.json(db.settings);
  });

  app.post('/api/settings', async (req, res) => {
    const siteCredentials = Array.isArray(req.body.siteCredentials)
      ? req.body.siteCredentials
          .map((item: any) => ({
            id: String(item?.id || randomUUID()),
            name: String(item?.name || '').trim(),
            url: String(item?.url || '').trim(),
            username: String(item?.username || '').trim(),
            password: String(item?.password || '').trim(),
            isPlaywrightTarget: Boolean(item?.isPlaywrightTarget),
          }))
          .filter((item: any) => item.url && item.username && item.password)
      : db.settings.siteCredentials;

    db.settings = { ...db.settings, ...req.body, siteCredentials };
    await savePersistedSettings();
    addActivity('Updated settings preferences');
    res.json({ success: true, settings: db.settings });
  });

  // Verify a server repository-root path exists on THIS server and report how many files it holds,
  // so the user can confirm from the UI that the deployed instance can actually read their code —
  // without touching env vars.
  app.post('/api/settings/verify-repo-root', (req, res) => {
    const target = String(req.body?.path || '').trim();
    if (!target) {
      return res.json({ ok: false, exists: false, reason: 'Enter a folder path first.' });
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(target);
    } catch {
      return res.json({ ok: false, exists: false, reason: `Not found on the server: ${target}` });
    }
    if (!stat.isDirectory()) {
      return res.json({ ok: false, exists: true, reason: 'That path exists but is not a folder.' });
    }
    const { files, truncated } = countRepoFiles(target);
    res.json({ ok: true, exists: true, path: target, fileCount: files, truncated });
  });

  app.delete('/api/settings/artifacts', async (req, res) => {
    if ((req as any).authUser?.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required.' });
    }
    const removed = isPostgresEnabled() ? await clearPostgresArtifacts() : {};
    const memoryRemoved = Object.fromEntries(
      ARTIFACT_KEYS.map((key) => {
        const count = Array.isArray(db[key]) ? db[key].length : 0;
        db[key] = [];
        return [key, count];
      }),
    );
    addActivity('Deleted QA artifacts');
    await savePersistedData();
    res.json({ ok: true, removed: { ...memoryRemoved, ...removed }, preserved: ['chat history', 'settings', 'users', 'sessions', 'websites', 'projects', 'apps'] });
  });
}
