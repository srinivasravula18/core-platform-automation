import { getApp, getProject, resolveRepoPath } from './projectService';
import { projectRepo } from './projectRepo';
import { classifyChangedFile, resolveTargetRepo, gitGrep, readRepoFile } from '../git-agent/gitAgentService';
import { isTestPath, GIT_TEST_EXCLUDES } from '../../shared/testPaths';

export interface CodeSearchScopeInput {
  projectId?: string;
  appId?: string | null;
}

export interface CodeSearchMatch {
  path: string;
  area: string;
  surface: string;
  line?: number;
  preview?: string;
}

export interface CodeSearchScope {
  mode: 'project' | 'global';
  repoLabel: string;
  roots: string[];
  projectId?: string;
  appId?: string | null;
}

function normalizeRepoPath(value: string): string {
  return String(value || '')
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '');
}

function uniqPaths(values: Array<string | undefined | null>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const normalized = normalizeRepoPath(value || '');
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function withinRoots(filePath: string, roots: string[]): boolean {
  if (!roots.length) return true;
  const normalized = normalizeRepoPath(filePath);
  return roots.some((root) => normalized === root || normalized.startsWith(`${root}/`));
}

function searchTokens(value: string): string[] {
  return Array.from(new Set(String(value || '').toLowerCase().match(/[a-z0-9]+/g) || []))
    .filter((token) => token.length >= 2);
}

function rankMatch(match: { path: string; preview?: string }, patterns: string[]): number {
  const queryTokens = new Set(patterns.flatMap(searchTokens));
  const pathText = normalizeRepoPath(match.path).toLowerCase();
  const baseText = pathText.split('/').pop() || '';
  const previewText = String(match.preview || '').toLowerCase();
  const pathTokens = new Set(searchTokens(pathText));
  const baseTokens = new Set(searchTokens(baseText));
  const previewTokens = new Set(searchTokens(previewText));
  let score = 0;
  for (const token of queryTokens) {
    if (baseTokens.has(token)) score += 6;
    else if (pathTokens.has(token)) score += 3;
    if (previewTokens.has(token)) score += 2;
  }
  for (const pattern of patterns.map((p) => p.toLowerCase()).filter(Boolean)) {
    if (baseText.includes(pattern)) score += 8;
    else if (pathText.includes(pattern)) score += 5;
    if (previewText.includes(pattern)) score += 4;
  }
  return score;
}

function isMarkdownPath(pathValue: string): boolean {
  return /\.(md|mdx|markdown)$/i.test(normalizeRepoPath(pathValue));
}

function rootsForApp(projectId?: string, appId?: string | null): string[] {
  if (!projectId || !appId) return [];
  const app = getApp(appId);
  if (!app || app.projectId !== projectId) return [];
  return uniqPaths([app.repoSubpath, ...Object.values(app.searchRoots || {})]);
}

export function resolveCodeSearchScope(input: CodeSearchScopeInput = {}): CodeSearchScope {
  const projectId = String(input.projectId || '').trim();
  const appId = input.appId ? String(input.appId).trim() : null;
  const project = projectId ? getProject(projectId) : undefined;
  if (!project) {
    // Only fall back to the global repo when NO project was requested. If a projectId was
    // supplied but not found, do NOT silently search the whole default repo under the
    // caller's project scope — surface it as an empty/unknown scope instead.
    return {
      mode: 'global',
      repoLabel: projectId ? `unknown project ${projectId}` : resolveTargetRepo(),
      roots: projectId ? ['__none__'] : [],
      projectId: '',
      appId: null,
    };
  }

  // Resolve the local path to the folder that actually exists on THIS host (under the Settings
  // server repo root on a deployed server), so the label matches what's really searched — never the
  // stale dev-machine path (e.g. D:\core-platform) that doesn't exist in production.
  const repoLabel = project.repoKind === 'remote'
    ? (project.repoUrl || project.name)
    : (resolveRepoPath(project.repoPath || '', project.slug) || project.name);

  return {
    mode: 'project',
    repoLabel,
    roots: rootsForApp(projectId, appId),
    projectId,
    appId,
  };
}

export async function searchCodeInScope(
  patterns: string[],
  input: CodeSearchScopeInput = {},
  maxFiles = 60,
): Promise<{ repo: string; roots: string[]; matches: CodeSearchMatch[] }> {
  const scope = resolveCodeSearchScope(input);
  const cleanPatterns = Array.from(new Set(
    (patterns || [])
      .map((pattern) => String(pattern || '').trim())
      .filter((pattern) => pattern.length >= 2),
  ));

  if (!cleanPatterns.length) {
    return { repo: scope.repoLabel, roots: scope.roots, matches: [] };
  }

  if (scope.mode === 'global' || !scope.projectId) {
    const markdownExcludes = [':(exclude)*.md', ':(exclude)*.mdx', ':(exclude)*.markdown'];
    // Test artifacts are excluded from agent grounding (never read the repo's tests).
    const pathspecs = [...(scope.roots.length ? scope.roots : ['.']), ...markdownExcludes, ...GIT_TEST_EXCLUDES];
    const matches = gitGrep(cleanPatterns, pathspecs, Math.max(maxFiles, maxFiles * 3))
      .filter((match) => !isMarkdownPath(match.path) && !isTestPath(match.path))
      .map((match) => ({
        path: match.path,
        area: match.area,
        surface: match.surface,
      }))
      .sort((a, b) => rankMatch(b, cleanPatterns) - rankMatch(a, cleanPatterns))
      .slice(0, maxFiles);
    return { repo: scope.repoLabel, roots: scope.roots, matches };
  }

  const merged = new Map<string, CodeSearchMatch & { score: number }>();
  const perTerm = Math.max(25, Math.min(100, maxFiles * 2));
  for (const term of cleanPatterns) {
    const rows = await projectRepo.search(scope.projectId, term, perTerm);
    for (const row of rows) {
      if (!withinRoots(row.path, scope.roots)) continue;
      if (isMarkdownPath(row.path) || isTestPath(row.path)) continue;
      const r = row as { path: string; line?: number; preview?: string };
      const existing = merged.get(row.path);
      const score = rankMatch(r, cleanPatterns) + rankMatch(r, [term]);
      if (existing) {
        existing.score += score;
        if (!existing.preview && r.preview) existing.preview = r.preview;
        continue;
      }
      const classified = classifyChangedFile(row.path);
      merged.set(row.path, {
        path: row.path,
        area: classified.area,
        surface: classified.surface,
        line: r.line,
        preview: r.preview,
        score,
      });
    }
  }

  const matches = Array.from(merged.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, maxFiles)
    .map(({ score: _score, ...match }) => match);
  return { repo: scope.repoLabel, roots: scope.roots, matches };
}

export async function readCodeFileInScope(
  relPath: string,
  input: CodeSearchScopeInput = {},
  _maxBytes?: number,
): Promise<string> {
  if (isMarkdownPath(relPath)) {
    throw new Error('Markdown files are excluded from agent codebase reads.');
  }
  // Never read the repo's tests/specs/fixtures — the agent must ground on app behavior, not tests.
  if (isTestPath(relPath)) {
    throw new Error('Test files are excluded from agent codebase reads.');
  }
  // Read the ENTIRE file — no byte cap. Whatever a caller passes for bytes is ignored; agents
  // see the whole file, every line, the way a human (or Claude Code / Codex) reads source.
  const scope = resolveCodeSearchScope(input);
  if (scope.mode === 'project' && scope.projectId) {
    return projectRepo.readFile(scope.projectId, relPath);
  }
  return readRepoFile(relPath);
}
