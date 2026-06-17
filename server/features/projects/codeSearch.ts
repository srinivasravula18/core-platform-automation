import { getApp, getProject } from './projectService';
import { projectRepo } from './projectRepo';
import { classifyChangedFile, GIT_AGENT_TARGET_REPO, gitGrep, readRepoFile } from '../git-agent/gitAgentService';

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
      repoLabel: projectId ? `unknown project ${projectId}` : GIT_AGENT_TARGET_REPO,
      roots: projectId ? ['__none__'] : [],
      projectId: '',
      appId: null,
    };
  }

  const repoLabel = project.repoKind === 'remote'
    ? (project.repoUrl || project.name)
    : (project.repoPath || project.name);

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
    const pathspecs = scope.roots.length ? scope.roots : ['.'];
    const matches = gitGrep(cleanPatterns, pathspecs, maxFiles).map((match) => ({
      path: match.path,
      area: match.area,
      surface: match.surface,
    }));
    return { repo: scope.repoLabel, roots: scope.roots, matches };
  }

  const seen = new Set<string>();
  const merged: CodeSearchMatch[] = [];
  const perTerm = Math.max(25, Math.min(100, maxFiles * 2));
  for (const term of cleanPatterns) {
    const rows = await projectRepo.search(scope.projectId, term, perTerm);
    for (const row of rows) {
      if (!withinRoots(row.path, scope.roots)) continue;
      if (seen.has(row.path)) continue;
      seen.add(row.path);
      const classified = classifyChangedFile(row.path);
      const r = row as { path: string; line?: number; preview?: string };
      merged.push({
        path: row.path,
        area: classified.area,
        surface: classified.surface,
        line: r.line,
        preview: r.preview,
      });
      if (merged.length >= maxFiles) {
        return { repo: scope.repoLabel, roots: scope.roots, matches: merged };
      }
    }
  }

  return { repo: scope.repoLabel, roots: scope.roots, matches: merged };
}

export async function readCodeFileInScope(
  relPath: string,
  input: CodeSearchScopeInput = {},
  maxBytes = 6000,
): Promise<string> {
  const scope = resolveCodeSearchScope(input);
  if (scope.mode === 'project' && scope.projectId) {
    const content = await projectRepo.readFile(scope.projectId, relPath);
    return content.length > maxBytes ? `${content.slice(0, maxBytes)}\n... [file truncated]` : content;
  }
  return readRepoFile(relPath, maxBytes);
}
