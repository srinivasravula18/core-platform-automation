/**
 * Unified repo access — the single seam agents import to read a project's code,
 * regardless of where it lives. Dispatches by `repoKind`:
 *   - 'local'  → localRepo (files + git off disk, no network)
 *   - 'remote' → remoteRepo (GitHub API via stored token, no clone)
 *
 * "If it's local, read local; if it's in production, read from git." Both
 * providers expose the same operations and return the same shapes, so callers
 * never branch on the kind themselves.
 */

import { getProject } from './projectService';
import { localRepo } from './localRepo';
import { remoteRepo } from './remoteRepo';

function providerFor(projectId: string) {
  const project = getProject(projectId);
  if (!project) {
    const e = new Error('Project not found.');
    (e as any).status = 404;
    throw e;
  }
  return project.repoKind === 'remote' ? remoteRepo : localRepo;
}

function repoError(message: string, status = 400): Error {
  const e = new Error(message);
  (e as any).status = status;
  return e;
}

function isMarkdownPath(pathValue: string): boolean {
  return /\.(md|mdx|markdown)$/i.test(String(pathValue || '').replace(/\\/g, '/'));
}

export const projectRepo = {
  /** Repo metadata (default branch; visibility/path depending on kind). */
  meta: (projectId: string) => providerFor(projectId).meta(projectId),

  /** Branches with head SHAs. */
  branches: (projectId: string) => providerFor(projectId).branches(projectId),

  /** Full file tree at a ref (defaults to the project's default branch / HEAD). */
  tree: (projectId: string, refName?: string, recursive = true) =>
    providerFor(projectId).tree(projectId, refName, recursive),

  /** Decoded text content of a file (working tree for local; ref content for remote). */
  readFile: (projectId: string, filePath: string, refName?: string) => {
    if (isMarkdownPath(filePath)) throw repoError('Markdown files are excluded from codebase reads.');
    return providerFor(projectId).readFile(projectId, filePath, refName);
  },

  /** Recent commits on a ref (optionally filtered by path / since). */
  commits: (projectId: string, opts: { refName?: string; since?: string; path?: string; perPage?: number } = {}) =>
    providerFor(projectId).commits(projectId, opts),

  /** Files + patches for one commit. */
  commitDiff: (projectId: string, sha: string) => providerFor(projectId).commitDiff(projectId, sha),

  /** Files + patches between two refs (base...head). */
  compare: (projectId: string, base: string, head: string) => providerFor(projectId).compare(projectId, base, head),

  /** Search the repo's code. */
  search: async (projectId: string, queryText: string, perPage?: number) => {
    const rows = await providerFor(projectId).search(projectId, queryText, perPage);
    return rows.filter((row: { path: string }) => !isMarkdownPath(row.path));
  },
};

export type ProjectRepo = typeof projectRepo;
