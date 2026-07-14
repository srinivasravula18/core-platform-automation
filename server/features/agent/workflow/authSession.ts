/**
 * Run-scoped authenticated-session cache (LangGraph workflow). ONE real login per run: the first
 * caller performs the proven createAuthStorageState login and captures cookies/localStorage +
 * sessionStorage; every later browser consumer in the same run (rediscovery attempts, execution)
 * reuses the captured state instead of logging in again — cutting per-run login volume ~4x and
 * keeping the target app's login rate-limit window out of reach. Transient by design (same
 * philosophy as artifactStash): a restarted process simply logs in once more.
 */
import path from 'path';
import { mkdir } from 'fs/promises';
import { createAuthStorageState } from '../../evidence/evidenceService';

export interface RunAuthState {
  storageStatePath?: string;
  sessionStorageState?: { origin: string; items: Record<string, string> };
}

/** Mirrors the legacy authSessionCache TTL — beyond this, tokens may have expired; log in fresh. */
const AUTH_TTL_MS = 15 * 60 * 1000;

const cache = new Map<string, { at: number; state: RunAuthState; loginCount: number }>();

/** Returns the run's cached authenticated state, logging in (at most once per TTL window) when absent. */
export async function ensureRunAuthState(
  runId: string,
  targetUrl: string,
  credential: { username?: string; password?: string } | undefined,
): Promise<RunAuthState> {
  if (!credential?.username || !credential?.password || !targetUrl) return {};
  const hit = cache.get(runId);
  if (hit && Date.now() - hit.at < AUTH_TTL_MS) return hit.state;

  const authPath = path.join(process.cwd(), '.testflow-pw', `${runId}-run-auth.json`);
  await mkdir(path.dirname(authPath), { recursive: true }).catch(() => undefined);
  let auth: any = await createAuthStorageState(targetUrl, { username: credential.username, password: credential.password }, authPath).catch(() => null);
  // sessionStorage capture can race the SPA's post-login token write — empty capture = logged-out context.
  if (auth?.ok && !auth.sessionStorage) {
    auth = await createAuthStorageState(targetUrl, { username: credential.username, password: credential.password }, authPath).catch(() => auth);
  }
  const state: RunAuthState = (auth?.ok || auth?.sessionStorage)
    ? { storageStatePath: authPath, sessionStorageState: auth?.sessionStorage }
    : {};
  cache.set(runId, { at: Date.now(), state, loginCount: (hit?.loginCount ?? 0) + 1 });
  return state;
}

/** Drop the cached state so the next consumer logs in fresh (e.g. after an auth-classified failure). */
export function clearRunAuthState(runId: string): void {
  cache.delete(runId);
}
