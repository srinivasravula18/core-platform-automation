/**
 * Project-aware remote-repo access. Agents call this to talk to a project's
 * GitHub repo over the API — reading files, trees, commits, diffs, branches,
 * and code search — WITHOUT a local clone.
 *
 * It resolves the repo URL + decrypted access token from the project, enforces
 * GitHub-only, and delegates to the stateless client in githubApi.ts. The token
 * is fetched at the point of use and never returned to callers.
 */

import { getProject } from './projectService';
import { getRepoToken } from './repoSecrets';
import * as gh from './githubApi';
import { parseGitHubRepo, GitHubError, type RepoRef } from './githubApi';

function resolve(projectId: string): { ref: RepoRef; token: string | null; defaultBranch: string } {
  const project = getProject(projectId);
  if (!project) throw new GitHubError('Project not found.', 404, 'notfound');
  if (project.repoKind !== 'remote' || !project.repoUrl) {
    throw new GitHubError('This project has no remote repository to access.', 400, 'parse');
  }
  const ref = parseGitHubRepo(project.repoUrl); // throws GitHubError for non-GitHub hosts
  return { ref, token: getRepoToken(projectId), defaultBranch: project.defaultBranch || 'main' };
}

export const remoteRepo = {
  /** Repo metadata (default branch, visibility). */
  meta(projectId: string) {
    const { ref, token } = resolve(projectId);
    return gh.getRepo(token, ref);
  },

  /** Branches with head SHAs. */
  branches(projectId: string) {
    const { ref, token } = resolve(projectId);
    return gh.listBranches(token, ref);
  },

  /** Full file tree at a ref (defaults to the project's default branch). */
  tree(projectId: string, refName?: string, recursive = true) {
    const { ref, token, defaultBranch } = resolve(projectId);
    return gh.listTree(token, ref, refName || defaultBranch, recursive);
  },

  /** Decoded text content of a file at a ref. */
  readFile(projectId: string, path: string, refName?: string) {
    const { ref, token, defaultBranch } = resolve(projectId);
    return gh.getFileContent(token, ref, path, refName || defaultBranch);
  },

  /** Recent commits on a ref (optionally filtered by path / since). */
  commits(projectId: string, opts: { refName?: string; since?: string; path?: string; perPage?: number } = {}) {
    const { ref, token, defaultBranch } = resolve(projectId);
    return gh.listCommits(token, ref, { ...opts, refName: opts.refName || defaultBranch });
  },

  /** Files + patches for one commit. */
  commitDiff(projectId: string, sha: string) {
    const { ref, token } = resolve(projectId);
    return gh.getCommitDiff(token, ref, sha);
  },

  /** Files + patches between two refs (base...head). */
  compare(projectId: string, base: string, head: string) {
    const { ref, token } = resolve(projectId);
    return gh.compareRefs(token, ref, base, head);
  },

  /** Code search within the repo (default branch only — GitHub limitation). */
  search(projectId: string, queryText: string, perPage?: number) {
    const { ref, token } = resolve(projectId);
    return gh.searchCode(token, ref, queryText, perPage);
  },
};

export type RemoteRepo = typeof remoteRepo;
