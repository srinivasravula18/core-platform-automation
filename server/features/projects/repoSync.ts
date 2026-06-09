/**
 * Private-repo connectivity check.
 *
 * Validates the SAME way agents will actually reach the repo — the GitHub REST
 * API with `Authorization: Bearer <token>` — so a pass here means agent access
 * works. (We deliberately do NOT use `git ls-remote`: its basic-auth header is
 * finicky with fine-grained PATs and can fail even when the token is valid.)
 */

import { getRepo, resolveRef, parseGitHubRepo, GitHubError } from './githubApi';

export interface RemoteCheck {
  ok: boolean;
  /** Default-branch SHA, when reachable. */
  sha?: string;
  /** Human-readable reason on failure. */
  error?: string;
  /** True when the failure is auth-shaped (missing/invalid token or no access). */
  authFailed?: boolean;
}

/**
 * Confirm the repo is reachable with the given token (or anonymously when none).
 * Uses the repo-metadata endpoint as the connectivity probe, then resolves the
 * default branch SHA. Fast and network-light.
 */
export async function validateRemoteAccess(repoUrl: string, token?: string | null, refName?: string): Promise<RemoteCheck> {
  let ref;
  try {
    ref = parseGitHubRepo(repoUrl);
  } catch (e: any) {
    return { ok: false, error: e?.message || 'Not a valid GitHub repository URL.' };
  }

  try {
    const meta = await getRepo(token || null, ref);
    let sha = '';
    try {
      sha = await resolveRef(token || null, ref, refName || meta.defaultBranch);
    } catch {
      /* metadata reachable but ref unresolved — still counts as connected */
    }
    return { ok: true, sha };
  } catch (e: any) {
    if (e instanceof GitHubError) {
      const authFailed = e.kind === 'auth' || e.kind === 'notfound';
      const error =
        e.kind === 'notfound'
          ? 'Repo not found. Check the URL — and for a fine-grained token, make sure it was granted access to THIS repository (Contents: Read-only).'
          : e.kind === 'ratelimit'
            ? e.message
            : e.kind === 'auth'
              ? 'GitHub rejected the token — it is invalid/expired, or lacks read access to this repository.'
              : e.message;
      return { ok: false, authFailed, error };
    }
    return { ok: false, error: e?.message || 'Could not reach GitHub.' };
  }
}
