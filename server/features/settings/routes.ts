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

/**
 * Full reset: everything EXCEPT user information, project information, and settings.
 * Grouped only for readable reporting — all four groups are truncated in one transaction.
 */
const PG_WIPE_GROUPS: Record<string, readonly string[]> = {
  qaArtifacts: [
    'cases', 'case_revisions', 'plans', 'suites', 'runs', 'run_case_results',
    'requirements', 'requirement_case_links', 'reports', 'folders', 'defects',
    'scripts', 'script_revisions', 'tags', 'release_case_pins', 'object_repository',
    'deletion_batches', 'inbox', 'api_runs', 'api_baselines', 'artifact_blobs',
    'controller_plans', 'artifact_id_counters',
  ],
  agentRuns: [
    'agent_runs', 'agent_run_artifacts', 'agent_run_events',
    'agent_blackboard', 'agent_messages', 'agent_memory',
    'agent_tasks', 'agent_human_labels', 'agent_artifact_lineage',
    'codex_threads', 'context_manifests', 'run_memories',
    'checkpoints', 'checkpoint_blobs', 'checkpoint_writes',
  ],
  conversations: [
    'chat_conversations', 'chat_messages', 'chat_summary_segments',
    'conversation_artifacts', 'conversation_entity_refs',
    'conversation_sessions', 'conversation_session_events',
  ],
  automation: [
    'agents', 'recordings',
    'automation_artifacts', 'automation_data_mappings', 'automation_data_profiles',
    'automation_dataset_rows', 'automation_datasets', 'automation_events',
    'automation_execution_batches', 'automation_job_pauses', 'automation_jobs',
    'automation_recording_steps', 'automation_run_data',
    'automation_schedule_executions', 'automation_schedule_items', 'automation_schedules',
    'automation_step_overrides',
  ],
  activity: ['activity', 'audit_log', 'usage_log', 'rbac_audit'],
};

// Never truncated: users/website_users/sessions/rbac_*, websites (credentials), settings, prompts,
// git_repositories, and json_store — identity, project/app configuration, and settings.

/** json_store holds projects/apps/users/settings; only the run + activity blobs are dropped. */
const JSON_STORE_WIPE_KEYS = ['blackboard', 'recentActivity'] as const;

/**
 * Hard-reset every group in one transaction. Rows are counted BEFORE truncating, because TRUNCATE
 * reports nothing — and a count of what actually went is the only useful confirmation.
 * A missing table is skipped rather than failing the whole reset (installs differ by version).
 */
async function clearPostgresArtifacts(): Promise<Record<string, number>> {
  const removed: Record<string, number> = {};
  const present: string[] = [];
  for (const [group, tables] of Object.entries(PG_WIPE_GROUPS)) {
    let count = 0;
    for (const table of tables) {
      try {
        const rows = await query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`);
        count += Number(rows[0]?.n ?? 0);
        present.push(table);
      } catch {
        /* table absent on this install — nothing to clear */
      }
    }
    removed[group] = count;
  }
  if (present.length) {
    // One statement: CASCADE resolves FK order, and a failure leaves the workspace untouched.
    await query(`TRUNCATE TABLE ${present.join(', ')} RESTART IDENTITY CASCADE`);
  }
  const jsonRows = await query(
    `DELETE FROM json_store WHERE key = ANY($1) RETURNING key`,
    [[...JSON_STORE_WIPE_KEYS]],
  );
  removed.storedBlobs = jsonRows.length;
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
    const userId = String((req as any).authUser?.userId || '');
    const removed = isPostgresEnabled() ? await clearPostgresArtifacts() : {};
    // Postgres already truncated every conversation; this clears the in-memory/JSON store too, and is
    // the whole chat wipe when Postgres is off. All users, not just the caller — this is a full reset.
    const conversations = Array.isArray((db as any).chatConversations) ? (db as any).chatConversations : [];
    const chatHistory = isPostgresEnabled() ? 0 : conversations.length;
    (db as any).chatConversations = [];
    const memoryRemoved = Object.fromEntries(
      ARTIFACT_KEYS.map((key) => {
        const count = Array.isArray(db[key]) ? db[key].length : 0;
        db[key] = [];
        return [key, count];
      }),
    );
    addActivity('Reset workspace data');
    await savePersistedData();
    res.json({
      ok: true,
      removed: { ...memoryRemoved, ...removed, chatHistory },
      preserved: ['users', 'sessions', 'access groups', 'projects', 'apps', 'settings', 'system prompts', 'credentials', 'connected repositories'],
    });
  });
}
