/**
 * Device-code sign-in for the Codex runtime.
 *
 * A deployed test environment has no browser and usually no shell, so `codex login` is not an
 * option there. The app server exposes a device-code flow instead: we ask it to start a login, it
 * returns a verification URL and a short code, the admin completes it in a browser on their OWN
 * machine, and the server receives the tokens. Codex then persists a refresh token under
 * `$CODEX_HOME`, so this is a one-time action per environment rather than a per-session step.
 *
 * Nothing here touches the API-key path; this exists so an admin can connect a ChatGPT account
 * without ever handling one.
 */

import { getAppServerClient } from './appServerClient';

export type LoginState = 'pending' | 'success' | 'error' | 'cancelled';

export interface PendingLogin {
  loginId: string;
  verificationUrl: string;
  userCode: string;
  state: LoginState;
  error?: string;
  startedAt: number;
  /** Released when the login settles — stops the shared runtime idling out mid-flow. */
  release: () => void;
}

/** Device codes are short-lived; abandoned attempts are reaped rather than kept forever. */
const LOGIN_TTL_MS = Math.max(60_000, Number(process.env.CODEX_LOGIN_TTL_MS) || 15 * 60_000);

const logins = new Map<string, PendingLogin>();
let listening = false;

/** Watch for completion once; the notification carries no thread, so it needs a global listener. */
function ensureListening() {
  if (listening) return;
  listening = true;
  getAppServerClient().subscribeAll((method, params) => {
    if (method !== 'account/login/completed') return;
    const loginId = params?.loginId ? String(params.loginId) : '';
    // A null loginId means "whatever login was in flight" — settle the only pending one.
    const pending = loginId ? logins.get(loginId) : [...logins.values()].find((l) => l.state === 'pending');
    if (!pending) return;
    pending.state = params?.success ? 'success' : 'error';
    if (!params?.success) pending.error = String(params?.error || 'Sign-in did not complete.');
    pending.release();
  });
}

function reap() {
  const now = Date.now();
  for (const [id, login] of logins) {
    if (login.state === 'pending' && now - login.startedAt > LOGIN_TTL_MS) {
      login.state = 'error';
      login.error = 'The sign-in code expired before it was used.';
      login.release();
    }
    // Keep settled logins briefly so the UI can read the outcome, then drop them.
    if (login.state !== 'pending' && now - login.startedAt > LOGIN_TTL_MS * 2) logins.delete(id);
  }
}

/** Begin a device-code sign-in and return the URL + code the admin must use. */
export async function startDeviceLogin(): Promise<PendingLogin> {
  reap();
  ensureListening();
  const client = getAppServerClient();
  const res = await client.call<any>('account/login/start', { type: 'chatgptDeviceCode' });
  const loginId = String(res?.loginId || '');
  if (!loginId || !res?.userCode) throw new Error('Codex did not start a device sign-in.');
  const login: PendingLogin = {
    loginId,
    verificationUrl: String(res.verificationUrl || 'https://auth.openai.com/codex/device'),
    userCode: String(res.userCode),
    state: 'pending',
    startedAt: Date.now(),
    release: client.hold(`login:${loginId}`),
  };
  logins.set(loginId, login);
  return login;
}

export function readLogin(loginId: string): PendingLogin | null {
  reap();
  return logins.get(loginId) || null;
}

export async function cancelDeviceLogin(loginId: string): Promise<boolean> {
  const login = logins.get(loginId);
  if (!login) return false;
  await getAppServerClient().call('account/login/cancel', { loginId }).catch(() => undefined);
  login.state = 'cancelled';
  login.release();
  return true;
}

/** Sign out of the runtime entirely — the next turn then reports "not authenticated". */
export async function logoutRuntime(): Promise<void> {
  await getAppServerClient().call('account/logout', null);
}

/** Public view of a login — never exposes internals. */
export function describeLogin(login: PendingLogin) {
  return {
    loginId: login.loginId,
    verificationUrl: login.verificationUrl,
    userCode: login.userCode,
    state: login.state,
    error: login.error,
  };
}
