/**
 * Local repo access for `repoKind: 'local'` projects — reads files and git
 * history straight off `repoPath` on disk, no network. Mirrors the operations
 * and return shapes of githubApi.ts so the projectRepo facade can dispatch to
 * either provider transparently.
 *
 * Errors carry a `.status` so the HTTP layer maps them like GitHub errors.
 */

import path from 'path';
import fs from 'fs';
import { spawnSync } from 'child_process';
import { DEFAULT_PROJECT_ID, getProject, resolveDefaultProjectRepoPath } from './projectService';
import type { TreeEntry, CommitSummary, DiffFile } from './githubApi';

function repoError(message: string, status = 400): Error {
  const e = new Error(message);
  (e as any).status = status;
  return e;
}

function repoPathOf(projectId: string): string {
  const project = getProject(projectId);
  if (!project) throw repoError('Project not found.', 404);
  if (project.repoKind !== 'local' || !project.repoPath) {
    throw repoError('This project has no local repository on disk.', 400);
  }
  const configuredPath = String(project.repoPath || '').trim();
  if (fs.existsSync(configuredPath)) {
    return configuredPath;
  }
  const fallbackPath = project.id === DEFAULT_PROJECT_ID ? resolveDefaultProjectRepoPath(configuredPath) : configuredPath;
  if (fallbackPath && fallbackPath !== configuredPath && fs.existsSync(fallbackPath)) {
    return fallbackPath;
  }
  throw repoError(`Local repo path does not exist: ${configuredPath}`, 404);
}

function git(cwd: string, args: string[], timeout = 120000): string {
  const result = spawnSync('git', ['-c', `safe.directory=${cwd.replace(/\\/g, '/')}`, ...args], {
    cwd,
    encoding: 'utf8',
    timeout,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw repoError((result.error as Error).message, 500);
  if (result.status !== 0) {
    throw repoError((result.stderr || result.stdout || `git exited ${result.status}`).trim(), 422);
  }
  return result.stdout || '';
}

const US = '\x1f'; // unit separator for safe field splitting

function searchTokens(value: string): string[] {
  return Array.from(new Set(String(value || '').toLowerCase().match(/[a-z0-9]+/g) || []))
    .filter((token) => token.length >= 2);
}

function tokenOverlapScore(tokens: Set<string>, queryTokens: string[], weight: number): number {
  let score = 0;
  for (const token of queryTokens) {
    if (tokens.has(token)) score += weight;
  }
  return score;
}

function evidenceRank(pathValue: string, queryText: string, preview = ''): number {
  const pathText = String(pathValue || '').replace(/\\/g, '/').toLowerCase();
  const baseText = pathText.split('/').pop() || '';
  const previewText = String(preview || '').toLowerCase();
  const queryTokens = searchTokens(queryText);
  const pathTokens = new Set(searchTokens(pathText));
  const baseTokens = new Set(searchTokens(baseText));
  const previewTokens = new Set(searchTokens(previewText));
  const exactQuery = String(queryText || '').trim().toLowerCase();

  let score = 0;
  score += tokenOverlapScore(baseTokens, queryTokens, 6);
  score += tokenOverlapScore(pathTokens, queryTokens, 3);
  score += tokenOverlapScore(previewTokens, queryTokens, 2);
  if (exactQuery && baseText.includes(exactQuery)) score += 8;
  if (exactQuery && pathText.includes(exactQuery)) score += 5;
  if (exactQuery && previewText.includes(exactQuery)) score += 4;
  return score;
}

function isMarkdownPath(pathValue: string): boolean {
  return /\.(md|mdx|markdown)$/i.test(String(pathValue || ''));
}

/** Count +/- body lines in a unified-diff section (ignores the +++/--- headers). */
function countChanges(section: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of section.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions++;
    else if (line.startsWith('-') && !line.startsWith('---')) deletions++;
  }
  return { additions, deletions };
}

/** Split a `git show`/`git diff` unified diff into per-file entries shaped like GitHub's. */
function parseUnifiedDiff(diff: string): DiffFile[] {
  if (!diff.trim()) return [];
  const sections = diff.split(/^diff --git /m).slice(1);
  return sections.map((body) => {
    const section = 'diff --git ' + body;
    const plus = section.match(/^\+\+\+ b\/(.+)$/m);
    const minus = section.match(/^--- a\/(.+)$/m);
    const renameTo = section.match(/^rename to (.+)$/m);
    const filename = renameTo?.[1] || (plus && plus[1] !== '/dev/null' ? plus[1] : minus?.[1]) || 'unknown';
    let status = 'modified';
    if (/^new file mode/m.test(section)) status = 'added';
    else if (/^deleted file mode/m.test(section)) status = 'removed';
    else if (/^rename from /m.test(section)) status = 'renamed';
    const { additions, deletions } = countChanges(section);
    const hunkAt = section.indexOf('\n@@');
    const patch = hunkAt >= 0 ? section.slice(hunkAt + 1) : undefined; // undefined for binary/empty
    return { filename, status, additions, deletions, patch };
  });
}

export const localRepo = {
  meta(projectId: string) {
    const cwd = repoPathOf(projectId);
    const branch = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
    const headSha = git(cwd, ['rev-parse', 'HEAD']).trim();
    return { defaultBranch: branch, headSha, repoPath: cwd, kind: 'local' as const };
  },

  branches(projectId: string): Array<{ name: string; sha: string }> {
    const cwd = repoPathOf(projectId);
    const out = git(cwd, ['for-each-ref', `--format=%(refname:short)${US}%(objectname)`, 'refs/heads']);
    return out
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [name, sha] = l.split(US);
        return { name, sha };
      });
  },

  tree(projectId: string, refName?: string, recursive = true): { sha: string; truncated: boolean; entries: TreeEntry[] } {
    const cwd = repoPathOf(projectId);
    const ref = refName || 'HEAD';
    const sha = git(cwd, ['rev-parse', ref]).trim();
    const args = ['ls-tree', '--long', ...(recursive ? ['-r', '-t'] : []), ref];
    const out = git(cwd, args);
    const entries: TreeEntry[] = out
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [meta, p] = line.split('\t');
        const [, type, objSha, size] = meta.trim().split(/\s+/);
        return { path: p, type: type as TreeEntry['type'], sha: objSha, size: size === '-' ? undefined : Number(size) };
      });
    return { sha, truncated: false, entries };
  },

  readFile(projectId: string, filePath: string, refName?: string): string {
    const cwd = repoPathOf(projectId);
    if (refName) return git(cwd, ['show', `${refName}:${filePath}`]); // historical version
    const abs = path.join(cwd, filePath); // working-tree copy
    if (!abs.startsWith(cwd)) throw repoError('Path escapes the repository.', 400);
    if (!fs.existsSync(abs)) throw repoError(`File not found: ${filePath}`, 404);
    if (fs.statSync(abs).isDirectory()) throw repoError(`${filePath} is a directory, not a file.`, 400);
    return fs.readFileSync(abs, 'utf8');
  },

  commits(projectId: string, opts: { refName?: string; since?: string; path?: string; perPage?: number } = {}): CommitSummary[] {
    const cwd = repoPathOf(projectId);
    const args = ['log', `--pretty=format:%H${US}%s${US}%an${US}%aI`, `-n`, String(Math.min(opts.perPage || 30, 200))];
    if (opts.since) args.push(`--since=${opts.since}`);
    args.push(opts.refName || 'HEAD');
    if (opts.path) args.push('--', opts.path);
    const out = git(cwd, args);
    return out
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [sha, message, author, date] = l.split(US);
        return { sha, message, author, date };
      });
  },

  commitDiff(projectId: string, sha: string): { sha: string; files: DiffFile[] } {
    const cwd = repoPathOf(projectId);
    const diff = git(cwd, ['show', '--format=', '--no-color', sha]);
    return { sha, files: parseUnifiedDiff(diff) };
  },

  compare(projectId: string, base: string, head: string): { files: DiffFile[]; aheadBy: number; behindBy: number } {
    const cwd = repoPathOf(projectId);
    const diff = git(cwd, ['diff', '--no-color', `${base}...${head}`]);
    const counts = git(cwd, ['rev-list', '--left-right', '--count', `${base}...${head}`]).trim().split(/\s+/);
    return { files: parseUnifiedDiff(diff), behindBy: Number(counts[0] || 0), aheadBy: Number(counts[1] || 0) };
  },

  search(projectId: string, queryText: string, perPage = 30): Array<{ path: string; line?: number; preview?: string }> {
    const cwd = repoPathOf(projectId);
    // Search tracked text evidence broadly; git skips binary content and the ranking
    // below lets the repo's own matched paths/lines decide what is most relevant.
    const pathspecs = ['.', ':(exclude)*.md', ':(exclude)*.mdx', ':(exclude)*.markdown'];
    // git grep exits 1 when there are no matches — treat that as an empty result.
    const result = spawnSync('git', ['-c', `safe.directory=${cwd.replace(/\\/g, '/')}`, 'grep', '-n', '-I', '--no-color', '-i', '--max-count=3', '-F', '-e', queryText, '--', ...pathspecs], {
      cwd,
      encoding: 'utf8',
      timeout: 60000,
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024,
    });
    if (result.status === 1) return [];
    if (result.status !== 0) throw repoError((result.stderr || 'git grep failed').trim(), 422);
    const grouped = new Map<string, { path: string; line?: number; preview?: string; rankText: string }>();
    for (const l of (result.stdout || '')
      // Split on CRLF *or* LF: on Windows, grep lines from CRLF files keep a trailing
      // \r that breaks the `path:line:preview` regex below (so path becomes the whole
      // line and line numbers are lost). Normalize the line ending here.
      .split(/\r?\n/)
      .filter(Boolean)) {
      const m = l.match(/^(.+?):(\d+):(.*)$/);
      const row = m ? { path: m[1], line: Number(m[2]), preview: m[3].trim().slice(0, 200) } : { path: l };
      if (isMarkdownPath(row.path)) continue;
      const existing = grouped.get(row.path);
      if (existing) {
        existing.rankText = `${existing.rankText} ${row.preview || ''}`.trim();
      } else {
        grouped.set(row.path, { ...row, rankText: row.preview || '' });
      }
    }
    return Array.from(grouped.values())
      .sort((a, b) => evidenceRank(b.path, queryText, b.rankText) - evidenceRank(a.path, queryText, a.rankText))
      .slice(0, Math.min(perPage, 200))
      .map(({ rankText: _rankText, ...row }) => row);
  },
};

export type LocalRepo = typeof localRepo;
