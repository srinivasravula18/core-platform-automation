/**
 * Minimal GitHub REST client used to talk to a repo over the API — no clone.
 *
 * Every call takes the access token explicitly (or null for public repos /
 * anonymous, lower rate limit). The token is sent as a Bearer header and never
 * logged. Callers above this layer (see remoteRepo.ts) resolve the token per
 * project; this module is stateless and host-agnostic about which repo.
 */

const API = 'https://api.github.com';

export interface RepoRef {
  owner: string;
  repo: string;
}

export interface TreeEntry {
  path: string;
  type: 'blob' | 'tree' | 'commit';
  size?: number;
  sha: string;
}

export interface CommitSummary {
  sha: string;
  message: string;
  author: string;
  date: string;
}

export interface DiffFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  /** Unified diff hunk, when GitHub includes one (omitted for very large/binary files). */
  patch?: string;
}

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly kind: 'auth' | 'notfound' | 'ratelimit' | 'http' | 'parse' = 'http',
  ) {
    super(message);
    this.name = 'GitHubError';
  }
}

/** Parse an owner/repo out of an https or ssh GitHub URL. Throws if it isn't GitHub. */
export function parseGitHubRepo(repoUrl: string): RepoRef {
  const url = String(repoUrl || '').trim();
  if (!url) throw new GitHubError('Repository URL is empty.', 400, 'parse');
  // git@github.com:owner/repo(.git) | https://github.com/owner/repo(.git)(/...)
  const ssh = url.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i);
  const https = url.match(/^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/#?]+?)(?:\.git)?(?:[/#?].*)?$/i);
  const m = ssh || https;
  if (!m) throw new GitHubError(`Not a GitHub repository URL: ${url}`, 400, 'parse');
  return { owner: m[1], repo: m[2] };
}

async function gh(
  token: string | null,
  path: string,
  opts: { accept?: string; method?: string; body?: unknown } = {},
): Promise<{ data: any; raw: string; res: Response }> {
  const headers: Record<string, string> = {
    Accept: opts.accept || 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'testflowai',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (opts.body) headers['Content-Type'] = 'application/json';

  const res = await fetch(`${API}${path}`, {
    method: opts.method || 'GET',
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const raw = await res.text();

  if (!res.ok) {
    const remaining = res.headers.get('x-ratelimit-remaining');
    if (res.status === 403 && remaining === '0') {
      throw new GitHubError('GitHub API rate limit exceeded. Add an access token or wait for the limit to reset.', 403, 'ratelimit');
    }
    if (res.status === 401 || res.status === 403) {
      throw new GitHubError('GitHub rejected the request — the token is missing, invalid, or lacks access to this repo.', res.status, 'auth');
    }
    if (res.status === 404) {
      throw new GitHubError('Not found on GitHub — wrong path/ref, or the token cannot see this repository.', 404, 'notfound');
    }
    let msg = `GitHub API error ${res.status}`;
    try {
      msg = JSON.parse(raw)?.message || msg;
    } catch {
      /* keep default */
    }
    throw new GitHubError(msg, res.status, 'http');
  }

  if (opts.accept && opts.accept.includes('raw')) return { data: null, raw, res };
  try {
    return { data: raw ? JSON.parse(raw) : null, raw, res };
  } catch {
    throw new GitHubError('Could not parse GitHub response as JSON.', res.status, 'parse');
  }
}

const enc = (s: string) => encodeURIComponent(s);

/** Repo metadata, including the default branch. */
export async function getRepo(token: string | null, { owner, repo }: RepoRef) {
  const { data } = await gh(token, `/repos/${enc(owner)}/${enc(repo)}`);
  return { defaultBranch: data.default_branch as string, private: !!data.private, fullName: data.full_name as string };
}

/** List branches (name + head SHA). */
export async function listBranches(token: string | null, { owner, repo }: RepoRef): Promise<Array<{ name: string; sha: string }>> {
  const { data } = await gh(token, `/repos/${enc(owner)}/${enc(repo)}/branches?per_page=100`);
  return (data as any[]).map((b) => ({ name: b.name, sha: b.commit?.sha || '' }));
}

/** Resolve a ref (branch/tag/sha) to its commit SHA. */
export async function resolveRef(token: string | null, ref: RepoRef, refName: string): Promise<string> {
  const { data } = await gh(token, `/repos/${enc(ref.owner)}/${enc(ref.repo)}/commits/${enc(refName)}`);
  return data.sha as string;
}

/** Full file tree at a ref. `recursive` walks the whole tree in one call. */
export async function listTree(
  token: string | null,
  ref: RepoRef,
  refName: string,
  recursive = true,
): Promise<{ sha: string; truncated: boolean; entries: TreeEntry[] }> {
  const commitSha = await resolveRef(token, ref, refName);
  const { data } = await gh(
    token,
    `/repos/${enc(ref.owner)}/${enc(ref.repo)}/git/trees/${commitSha}${recursive ? '?recursive=1' : ''}`,
  );
  const entries: TreeEntry[] = (data.tree as any[]).map((t) => ({ path: t.path, type: t.type, size: t.size, sha: t.sha }));
  return { sha: commitSha, truncated: !!data.truncated, entries };
}

/** Decoded text content of a file at a ref. Uses the blobs API so large files work too. */
export async function getFileContent(token: string | null, ref: RepoRef, path: string, refName: string): Promise<string> {
  const { data } = await gh(
    token,
    `/repos/${enc(ref.owner)}/${enc(ref.repo)}/contents/${path.split('/').map(enc).join('/')}?ref=${enc(refName)}`,
  );
  if (Array.isArray(data)) throw new GitHubError(`${path} is a directory, not a file.`, 400, 'parse');
  if (data.content && data.encoding === 'base64') {
    return Buffer.from(data.content, 'base64').toString('utf8');
  }
  // Large files: contents API omits content; fetch the blob by sha.
  if (data.sha) {
    const blob = await gh(token, `/repos/${enc(ref.owner)}/${enc(ref.repo)}/git/blobs/${data.sha}`);
    if (blob.data?.encoding === 'base64') return Buffer.from(blob.data.content, 'base64').toString('utf8');
  }
  throw new GitHubError(`Could not read file content for ${path}.`, 422, 'parse');
}

/** Recent commits on a ref. */
export async function listCommits(
  token: string | null,
  ref: RepoRef,
  opts: { refName?: string; since?: string; path?: string; perPage?: number } = {},
): Promise<CommitSummary[]> {
  const q = new URLSearchParams();
  if (opts.refName) q.set('sha', opts.refName);
  if (opts.since) q.set('since', opts.since);
  if (opts.path) q.set('path', opts.path);
  q.set('per_page', String(Math.min(opts.perPage || 30, 100)));
  const { data } = await gh(token, `/repos/${enc(ref.owner)}/${enc(ref.repo)}/commits?${q.toString()}`);
  return (data as any[]).map((c) => ({
    sha: c.sha,
    message: c.commit?.message || '',
    author: c.commit?.author?.name || c.author?.login || '',
    date: c.commit?.author?.date || '',
  }));
}

/** Files + patches for a single commit. */
export async function getCommitDiff(token: string | null, ref: RepoRef, sha: string): Promise<{ sha: string; files: DiffFile[] }> {
  const { data } = await gh(token, `/repos/${enc(ref.owner)}/${enc(ref.repo)}/commits/${enc(sha)}`);
  return { sha: data.sha, files: mapFiles(data.files) };
}

/** Files + patches between two refs (base...head). */
export async function compareRefs(token: string | null, ref: RepoRef, base: string, head: string): Promise<{ files: DiffFile[]; aheadBy: number; behindBy: number }> {
  const { data } = await gh(token, `/repos/${enc(ref.owner)}/${enc(ref.repo)}/compare/${enc(base)}...${enc(head)}`);
  return { files: mapFiles(data.files), aheadBy: data.ahead_by, behindBy: data.behind_by };
}

/** Code search within the repo (default branch only — a GitHub API limitation). */
export async function searchCode(token: string | null, ref: RepoRef, queryText: string, perPage = 30): Promise<Array<{ path: string; sha: string; url: string }>> {
  const q = `${queryText} repo:${ref.owner}/${ref.repo}`;
  const { data } = await gh(token, `/search/code?q=${enc(q)}&per_page=${Math.min(perPage, 100)}`);
  return (data.items as any[]).map((i) => ({ path: i.path, sha: i.sha, url: i.html_url }));
}

function mapFiles(files: any[] | undefined): DiffFile[] {
  return (files || []).map((f) => ({
    filename: f.filename,
    status: f.status,
    additions: f.additions,
    deletions: f.deletions,
    patch: f.patch,
  }));
}
