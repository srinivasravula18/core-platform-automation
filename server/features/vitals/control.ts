/**
 * The control plane: the monitored product's own observability console.
 *
 * Reads never come through here — pages query the `obs` schema directly. This exists for the things
 * that are an action rather than a fact. Starting a load or security run means spawning a process on
 * the machine that owns the profile scripts and the target allowlist, so Vitals asks that console
 * instead of pretending to own a runner. That keeps Test Flow AI free of any one product's scripts,
 * targets, or risk policy: the product decides what may run, and Vitals decides who may ask.
 *
 * The contract a console must satisfy, relative to the configured base URL:
 *   POST /api/login                  {username, password}          -> {token}
 *   GET  /api/tests/profiles                                       -> {profiles, targets, ...}
 *   POST /api/tests/runs             {profileId, params, targetBaseUrl} -> {id, ...}
 *   POST /api/tests/runs/:id/abort                                 -> {ok}
 * All but the first take `Authorization: Bearer <token>`.
 */

import { resolveControl, VitalsCredentialMissingError, type VitalsControlConfig } from './connection';

export class VitalsControlNotConfiguredError extends Error {
  constructor(
    message = 'No control plane is connected. Vitals can read history without one, but starting a run needs the monitored product’s console — add it under Vitals → Connect.',
  ) {
    super(message);
  }
}

export class VitalsControlError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const REQUEST_TIMEOUT_MS = 20_000;

/** Cached per base URL + operator, so a re-configured console never reuses the old session. */
let session: { key: string; token: string; obtainedAt: number } | null = null;

const sessionKey = (control: VitalsControlConfig) => `${control.baseUrl}|${control.username}`;

const requireControl = async (): Promise<VitalsControlConfig> => {
  const control = await resolveControl();
  if (!control) throw new VitalsControlNotConfiguredError();
  return control;
};

const fetchJson = async (url: string, init: RequestInit): Promise<{ status: number; body: any }> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    let body: any = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { message: text.slice(0, 500) };
    }
    return { status: response.status, body };
  } catch (error) {
    const reason = (error as Error).name === 'AbortError' ? `no response within ${REQUEST_TIMEOUT_MS / 1000}s` : (error as Error).message;
    throw new VitalsControlError(502, `Could not reach the control plane: ${reason}`);
  } finally {
    clearTimeout(timer);
  }
};

const login = async (control: VitalsControlConfig): Promise<string> => {
  const { status, body } = await fetchJson(`${control.baseUrl}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: control.username, password: control.password }),
  });
  if (status === 401) throw new VitalsControlError(401, 'The control plane rejected the configured operator credentials.');
  if (status >= 400 || !body?.token) {
    throw new VitalsControlError(status >= 400 ? status : 502, body?.error || body?.message || 'The control plane did not return a session token.');
  }
  session = { key: sessionKey(control), token: String(body.token), obtainedAt: Date.now() };
  return session.token;
};

/**
 * One authenticated call. A 401 means the cached token expired — re-login once and retry, so a
 * long-lived Test Flow process does not need to know the console's session lifetime.
 */
const call = async (path: string, init: RequestInit = {}): Promise<any> => {
  const control = await requireControl();
  const key = sessionKey(control);
  let token = session?.key === key ? session.token : await login(control);

  const send = () =>
    fetchJson(`${control.baseUrl}${path}`, {
      ...init,
      headers: {
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers ?? {}),
        Authorization: `Bearer ${token}`,
      },
    });

  let { status, body } = await send();
  if (status === 401) {
    session = null;
    token = await login(control);
    ({ status, body } = await send());
  }
  if (status >= 400) throw new VitalsControlError(status, body?.message || body?.error || `The control plane returned ${status}.`);
  return body;
};

export type ControlProfiles = {
  profiles: {
    id: string;
    label: string;
    category?: string;
    summary?: string;
    proves?: string;
    runner?: string;
    danger?: string;
    estimate?: string;
    thresholds?: Record<string, number>;
    params?: { key: string; label: string; help?: string; control: Record<string, unknown>; default: unknown }[];
  }[];
  activeRunId?: string | null;
  activeRunIds?: string[];
  maxConcurrentRuns?: number;
  defaultTargetBaseUrl?: string;
  allowedTargetBaseUrls?: string[];
  pentestTargetBaseUrls?: string[];
  targets?: { url: string; label: string; source: string; pentestAllowed: boolean }[];
  userPoolAvailable?: boolean;
};

export const isControlConfigured = async (): Promise<boolean> => Boolean(await resolveControl().catch(() => null));

export const listControlProfiles = async (): Promise<ControlProfiles> => call('/api/tests/profiles');

export type StartRunInput = {
  profileId: string;
  params: Record<string, string | number | boolean>;
  targetBaseUrl?: string;
};

export const startControlRun = async (input: StartRunInput): Promise<{ id: string }> =>
  call('/api/tests/runs', { method: 'POST', body: JSON.stringify(input) });

export const abortControlRun = async (runId: string): Promise<{ ok: boolean }> =>
  call(`/api/tests/runs/${encodeURIComponent(runId)}/abort`, { method: 'POST' });

export type ControlStatus = {
  configured: boolean;
  reachable: boolean;
  message: string;
  baseUrl: string | null;
  profileCount: number | null;
};

/** What the Connect page shows, and the gate the Load Lab uses to decide whether it may offer Start. */
export const controlStatus = async (): Promise<ControlStatus> => {
  let control: VitalsControlConfig | null;
  try {
    control = await resolveControl();
  } catch (error) {
    // A reference whose credential was deleted or emptied is configured but unusable — say which,
    // rather than reporting it as absent.
    const configured = error instanceof VitalsCredentialMissingError;
    return { configured, reachable: false, message: (error as Error).message, baseUrl: null, profileCount: null };
  }
  if (!control) {
    return { configured: false, reachable: false, message: new VitalsControlNotConfiguredError().message, baseUrl: null, profileCount: null };
  }
  try {
    const profiles = await listControlProfiles();
    return {
      configured: true,
      reachable: true,
      message: 'Connected.',
      baseUrl: control.baseUrl,
      profileCount: profiles.profiles?.length ?? 0,
    };
  } catch (error) {
    return { configured: true, reachable: false, message: (error as Error).message, baseUrl: control.baseUrl, profileCount: null };
  }
};

/** Forgets the cached token — used after the connection changes so the next call re-authenticates. */
export const resetControlSession = (): void => {
  session = null;
};

/**
 * Probe a candidate control plane without saving it, for the Connect page's test button.
 * Deliberately does not touch the cached session for the configured one.
 */
export const probeControl = async (candidate: VitalsControlConfig): Promise<ControlStatus> => {
  const base = candidate.baseUrl.replace(/\/+$/, '');
  try {
    const auth = await fetchJson(`${base}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: candidate.username, password: candidate.password }),
    });
    if (auth.status === 401) {
      return { configured: true, reachable: false, message: 'Reached the console, but those credentials were rejected.', baseUrl: base, profileCount: null };
    }
    if (auth.status >= 400 || !auth.body?.token) {
      return {
        configured: true,
        reachable: false,
        message: auth.body?.error || auth.body?.message || `The console returned ${auth.status} to a login.`,
        baseUrl: base,
        profileCount: null,
      };
    }
    const profiles = await fetchJson(`${base}/api/tests/profiles`, { headers: { Authorization: `Bearer ${auth.body.token}` } });
    if (profiles.status >= 400) {
      return {
        configured: true,
        reachable: false,
        message: `Signed in, but the console returned ${profiles.status} for its test profiles.`,
        baseUrl: base,
        profileCount: null,
      };
    }
    return { configured: true, reachable: true, message: 'Connected.', baseUrl: base, profileCount: profiles.body?.profiles?.length ?? 0 };
  } catch (error) {
    return { configured: true, reachable: false, message: (error as Error).message, baseUrl: base, profileCount: null };
  }
};
