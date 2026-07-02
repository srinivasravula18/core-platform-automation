/**
 * Projects & Apps — the testing-context hierarchy.
 *
 * One Project == one git repo (one codebase). A Project holds N Apps, each of which is a
 * testable surface carved out of that codebase (its own base URL, repo sub-path / search
 * roots, environment). The Agent Console and every QA entity scope to a selected
 * Project (required) and optionally an App (null == project-level / cross-app).
 *
 * Storage-backed (in-memory db arrays persisted to JSON), mirroring knowledgeService.
 */

import { randomUUID } from 'crypto';
import { existsSync } from 'fs';
import path from 'path';
import { db, persistDataInBackground, savePersistedData } from '../../shared/storage';
import { isPostgresEnabled, query } from '../../db/pool';

export type RepoKind = 'local' | 'remote';
export type SyncStatus = 'idle' | 'connecting' | 'syncing' | 'ready' | 'error';

export interface Project {
  id: string;
  name: string;
  slug: string;
  description?: string;
  /** How the project's one repo is sourced. */
  repoKind: RepoKind;
  /** Local: absolute folder on disk. Remote: cloned workdir (set after connect). */
  repoPath?: string;
  /** Remote only: the clone URL. */
  repoUrl?: string;
  /** Remote only: pointer to the secret store entry — never the token itself. */
  repoAuthRef?: string;
  defaultBranch?: string;
  lastSyncedSha?: string;
  syncStatus: SyncStatus;
  lastError?: string;
  /** App user who owns this project (per-user isolation). '' = legacy/admin-owned. */
  ownerId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AppRecord {
  id: string;
  projectId: string;
  name: string;
  slug: string;
  description?: string;
  /** The deployed surface the agent tests against. */
  baseUrl?: string;
  environment?: string;
  /**
   * How this app's metadata catalog is grounded. Tenants' apps are metadata-driven
   * platforms, so the default is 'swagger' (derive the catalog from the app's OpenAPI
   * spec). 'api' = the app's objects endpoint; 'source' = from the repo; 'none' = no
   * catalog (graceful). Default when unset: 'swagger'.
   */
  catalogStrategy?: 'swagger' | 'api' | 'source' | 'none';
  /** Path to the app's OpenAPI spec (probed if unset). Default: '/api/openapi.json'. */
  specPath?: string;
  /** Where this app lives in the project's monorepo. '' = whole repo. */
  repoSubpath?: string;
  /** Optional named code roots (surface -> sub-path) for grounding/search. */
  searchRoots?: Record<string, string>;
  /** Bound knowledge pack id (app structure / DB / APIs / services spec). */
  knowledgePackId?: string;
  createdAt: string;
  updatedAt: string;
}

function projects(): Project[] {
  return Array.isArray(db.projects) ? db.projects : (db.projects = []);
}

function apps(): AppRecord[] {
  return Array.isArray(db.apps) ? db.apps : (db.apps = []);
}

function slugify(name: string): string {
  return String(name || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'item';
}

function preferredDefaultRepoPath(): string {
  // Env-driven only. Do NOT guess a machine-specific absolute path — that silently points
  // the agent at a repo that doesn't exist on this host. Unset → empty, so the project's
  // own configured repoPath is required (or the global GIT_AGENT_TARGET_REPO fallback).
  return String(process.env.GIT_AGENT_TARGET_REPO || process.env.TARGET_REPO || '').trim();
}

function isLegacyWindowsDefaultRepoPath(value: string): boolean {
  return String(value || '').trim().toLowerCase() === 'd:\\core-platform';
}

export function resolveDefaultProjectRepoPath(currentPath = ''): string {
  const current = String(currentPath || '').trim();
  const preferred = preferredDefaultRepoPath();
  if (!current) return preferred;
  if (existsSync(current)) return current;
  if (isLegacyWindowsDefaultRepoPath(current) && preferred && preferred !== current) return preferred;
  return current;
}

/**
 * Resolve a project's on-disk repo folder for THIS host. A repoPath is stored as the absolute path
 * from wherever the project was created (usually a dev machine, e.g. "D:\core-platform"). On a
 * deployed server that exact path won't exist — so when a "server repository root" is configured in
 * Settings, we look for the same repo folder under that root by its folder name (and the project
 * slug). This lets the deployed instance find the correct folders without re-entering every path.
 * Falls back to the raw path when nothing resolves, so callers still get a clear "not found" signal.
 */
export function resolveRepoPath(rawPath: string, slug = ''): string {
  const raw = String(rawPath || '').trim();
  if (raw && existsSync(raw)) return raw;
  const root = String((db as any).settings?.serverRepoRoot || '').trim();
  if (!root) return raw;
  // basename must handle a Windows path evaluated on a POSIX host (\ is not a separator there),
  // so split on BOTH separators rather than relying on path.basename alone.
  const folder = raw.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '';
  const candidates = [
    folder ? path.join(root, folder) : '',
    slug ? path.join(root, slug) : '',
    root, // the configured root may itself be the repo
  ].filter(Boolean) as string[];
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  return candidates[0] || raw;
}

/** Convenience: the resolved on-disk repo path for a project id (empty string if unknown). */
export function getProjectRepoPath(id: string): string {
  const project = getProject(id);
  return project ? resolveRepoPath(project.repoPath || '', project.slug) : '';
}

/** Make a slug unique within a set of existing slugs. */
function uniqueSlug(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  let i = 2;
  while (taken.has(`${base}-${i}`)) i += 1;
  return `${base}-${i}`;
}

// ---- Projects ----

export function listProjects(): Project[] {
  return projects().slice().sort((a, b) => (a.name || '').localeCompare(b.name || ''));
}

export function getProject(id: string): Project | undefined {
  return projects().find((p) => p.id === id);
}

export function createProject(input: Partial<Project> & { name: string }): Project {
  const name = String(input.name || '').trim();
  if (!name) throw new Error('Project name is required.');
  const kind: RepoKind = input.repoKind === 'remote' ? 'remote' : 'local';
  if (kind === 'local' && !String(input.repoPath || '').trim()) {
    throw new Error('A local repo path is required for a local project.');
  }
  if (kind === 'remote' && !String(input.repoUrl || '').trim()) {
    throw new Error('A repository URL is required for a remote project.');
  }
  const taken = new Set(projects().map((p) => p.slug));
  const now = new Date().toISOString();
  const project: Project = {
    id: `PRJ-${randomUUID().slice(0, 8)}`,
    name,
    slug: uniqueSlug(slugify(input.slug || name), taken),
    description: input.description?.trim() || '',
    repoKind: kind,
    repoPath: input.repoPath?.trim() || '',
    repoUrl: input.repoUrl?.trim() || '',
    repoAuthRef: input.repoAuthRef || '',
    defaultBranch: input.defaultBranch?.trim() || 'main',
    syncStatus: kind === 'local' ? 'ready' : 'idle',
    ownerId: input.ownerId || '',
    createdAt: now,
    updatedAt: now,
  };
  projects().push(project);
  persistDataInBackground('create project');
  return project;
}

export function updateProject(id: string, input: Partial<Project>): Project {
  const project = getProject(id);
  if (!project) throw new Error('Project not found.');
  if (input.name !== undefined) {
    const name = String(input.name).trim();
    if (!name) throw new Error('Project name cannot be empty.');
    project.name = name;
  }
  if (input.description !== undefined) project.description = String(input.description).trim();
  if (input.repoKind !== undefined) project.repoKind = input.repoKind === 'remote' ? 'remote' : 'local';
  if (input.repoPath !== undefined) project.repoPath = String(input.repoPath).trim();
  if (input.repoUrl !== undefined) project.repoUrl = String(input.repoUrl).trim();
  if (input.defaultBranch !== undefined) project.defaultBranch = String(input.defaultBranch).trim() || 'main';
  if (input.syncStatus !== undefined) project.syncStatus = input.syncStatus;
  if (input.lastError !== undefined) project.lastError = input.lastError;
  if (input.lastSyncedSha !== undefined) project.lastSyncedSha = input.lastSyncedSha;
  project.updatedAt = new Date().toISOString();
  persistDataInBackground('update project');
  return project;
}

/** Delete a project and all of its apps (cascade). */
export function deleteProject(id: string): boolean {
  const list = projects();
  const idx = list.findIndex((p) => p.id === id);
  if (idx === -1) return false;
  list.splice(idx, 1);
  const remaining = apps().filter((a) => a.projectId !== id);
  db.apps = remaining;
  persistDataInBackground('delete project');
  return true;
}

// ---- Apps ----

export function listApps(projectId?: string): AppRecord[] {
  const all = apps().slice().sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  return projectId ? all.filter((a) => a.projectId === projectId) : all;
}

export function getApp(id: string): AppRecord | undefined {
  return apps().find((a) => a.id === id);
}

export function createApp(projectId: string, input: Partial<AppRecord> & { name: string }): AppRecord {
  if (!getProject(projectId)) throw new Error('Project not found.');
  const name = String(input.name || '').trim();
  if (!name) throw new Error('App name is required.');
  const taken = new Set(listApps(projectId).map((a) => a.slug));
  const now = new Date().toISOString();
  const app: AppRecord = {
    id: `APP-${randomUUID().slice(0, 8)}`,
    projectId,
    name,
    slug: uniqueSlug(slugify(input.slug || name), taken),
    description: input.description?.trim() || '',
    baseUrl: input.baseUrl?.trim() || '',
    environment: input.environment?.trim() || 'staging',
    // Tenants' apps are metadata-driven platforms → default to swagger grounding.
    catalogStrategy: input.catalogStrategy || 'swagger',
    specPath: input.specPath?.trim() || '/api/openapi.json',
    repoSubpath: input.repoSubpath?.trim() || '',
    searchRoots: input.searchRoots && typeof input.searchRoots === 'object' ? input.searchRoots : {},
    knowledgePackId: input.knowledgePackId || '',
    createdAt: now,
    updatedAt: now,
  };
  apps().push(app);
  persistDataInBackground('create app');
  return app;
}

export function updateApp(id: string, input: Partial<AppRecord>): AppRecord {
  const app = getApp(id);
  if (!app) throw new Error('App not found.');
  if (input.name !== undefined) {
    const name = String(input.name).trim();
    if (!name) throw new Error('App name cannot be empty.');
    app.name = name;
  }
  if (input.description !== undefined) app.description = String(input.description).trim();
  if (input.baseUrl !== undefined) app.baseUrl = String(input.baseUrl).trim();
  if (input.environment !== undefined) app.environment = String(input.environment).trim() || 'staging';
  if (input.catalogStrategy !== undefined) app.catalogStrategy = input.catalogStrategy;
  if (input.specPath !== undefined) app.specPath = String(input.specPath).trim() || '/api/openapi.json';
  if (input.repoSubpath !== undefined) app.repoSubpath = String(input.repoSubpath).trim();
  if (input.searchRoots !== undefined && typeof input.searchRoots === 'object') app.searchRoots = input.searchRoots;
  if (input.knowledgePackId !== undefined) app.knowledgePackId = input.knowledgePackId;
  app.updatedAt = new Date().toISOString();
  persistDataInBackground('update app');
  return app;
}

export function deleteApp(id: string): boolean {
  const list = apps();
  const idx = list.findIndex((a) => a.id === id);
  if (idx === -1) return false;
  list.splice(idx, 1);
  persistDataInBackground('delete app');
  return true;
}

/** Projects with their apps nested — the shape the Topbar switcher consumes. */
export function listProjectsWithApps(): Array<Project & { apps: AppRecord[] }> {
  return listProjects().map((p) => ({ ...p, apps: listApps(p.id) }));
}

// ---- Default project seed + one-time backfill ----

/** Stable id so the backfill can target it deterministically across restarts. */
export const DEFAULT_PROJECT_ID = 'PRJ-CORE-PLATFORM';

/** Tables/arrays whose existing rows get adopted into the default project. */
const SCOPED_COLLECTIONS = ['plans', 'suites', 'cases', 'runs', 'defects', 'reports', 'scripts', 'folders', 'requirements', 'agentRuns'];
const SCOPED_PG_TABLES = ['plans', 'suites', 'cases', 'runs', 'defects', 'reports', 'scripts', 'folders', 'requirements', 'agent_runs'];

/**
 * Ensure a default "Core Platform" project exists and adopt all pre-existing,
 * unscoped data into it — so nothing is left "visible everywhere", everything the
 * team already has lives under one project. Runs once (guarded by a settings flag).
 */
export async function seedDefaultProjectAndBackfill(): Promise<void> {
  // User-configured only. The top-bar project/app switcher must not create or
  // auto-adopt projects on startup; end users configure these records explicitly.
  return;

  const defaultRepoPath = resolveDefaultProjectRepoPath();
  // 1) Seed the default project if there are none yet.
  if (projects().length === 0) {
    const now = new Date().toISOString();
    projects().unshift({
      id: DEFAULT_PROJECT_ID,
      name: 'Core Platform',
      slug: 'core-platform',
      description: 'Default project — your existing test data lives here.',
      repoKind: 'local',
      repoPath: defaultRepoPath,
      repoUrl: '',
      defaultBranch: 'main',
      syncStatus: 'ready',
      createdAt: now,
      updatedAt: now,
    });
    persistDataInBackground('seed default project');
  }

  const defaultProject = projects().find((p) => p.id === DEFAULT_PROJECT_ID);
  if (defaultProject && defaultProject.repoKind === 'local') {
    const repairedPath = resolveDefaultProjectRepoPath(defaultProject.repoPath || '');
    if (repairedPath !== (defaultProject.repoPath || '')) {
      defaultProject.repoPath = repairedPath;
      defaultProject.updatedAt = new Date().toISOString();
      persistDataInBackground('repair default project repo path');
    }
  }

  // 2) Adopt any unscoped rows into the default project. Run every boot (not guarded
  //    by a flag): any row without a project is "unowned" and — per the directive that
  //    existing data lives under Core Platform — belongs to the default project. It's
  //    idempotent: after the first sweep, zero rows match, so it's a cheap no-op.
  const targetId = projects().some((p) => p.id === DEFAULT_PROJECT_ID)
    ? DEFAULT_PROJECT_ID
    : projects()[0]?.id;
  if (!targetId) return;

  let adopted = 0;

  // In-memory arrays (also the source of truth for JSON persistence).
  for (const name of SCOPED_COLLECTIONS) {
    const arr = (db as any)[name];
    if (!Array.isArray(arr)) continue;
    for (const row of arr) {
      if (row && !row.projectId) { row.projectId = targetId; adopted += 1; }
    }
  }

  // Postgres rows (columns exist after the scope migration has run).
  if (isPostgresEnabled()) {
    for (const table of SCOPED_PG_TABLES) {
      try {
        const res = await query(`UPDATE ${table} SET project_id = $1 WHERE project_id IS NULL OR project_id = ''`, [targetId]);
        adopted += (res as any).length || 0;
      } catch (err: any) {
        console.error(`[projects] adopt ${table} failed:`, err?.message || err);
      }
    }
  }

  if (adopted > 0) {
    await savePersistedData().catch(() => undefined);
    console.log(`[projects] adopted ${adopted} unscoped row(s) into ${targetId}`);
  }
}
