const rawBaseUrl = (import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL || '/';

const normalizedBasePath = rawBaseUrl.endsWith('/') && rawBaseUrl !== '/'
  ? rawBaseUrl.slice(0, -1)
  : rawBaseUrl;

export const appBasePath = normalizedBasePath === '/' ? '' : normalizedBasePath;

export function withBasePath(path: string): string {
  if (!path.startsWith('/')) return path;
  return `${appBasePath}${path}`;
}

/**
 * Headers attached to every same-origin API call: the selected project/app scope
 * AND the auth token. The token lets the backend resolve the logged-in user and
 * partition data per user (per-user isolation), so it must ride on every request,
 * not just /auth/me.
 */
function scopeHeaders(): Record<string, string> {
  try {
    const headers: Record<string, string> = {};
    const projectId = localStorage.getItem('tfa_project_id');
    const appId = localStorage.getItem('tfa_app_id');
    const token = localStorage.getItem('tfa_auth_token');
    if (projectId) headers['X-Project-Id'] = projectId;
    if (appId) headers['X-App-Id'] = appId;
    if (token) headers['Authorization'] = `Bearer ${token}`;
    return headers;
  } catch {
    return {};
  }
}

/** True for same-origin API calls that should carry the project/app scope. */
function isApiTarget(input: RequestInfo | URL): boolean {
  if (typeof input === 'string') return input.startsWith('/api');
  if (input instanceof URL) return input.origin === window.location.origin && input.pathname.startsWith('/api');
  if (input instanceof Request) {
    const url = new URL(input.url, window.location.origin);
    return url.origin === window.location.origin && url.pathname.startsWith('/api');
  }
  return false;
}

function rewriteRequestUrl(input: RequestInfo | URL): RequestInfo | URL {
  if (typeof window === 'undefined') return input;

  if (typeof input === 'string') {
    return input.startsWith('/api') || input.startsWith('/evidence') ? withBasePath(input) : input;
  }

  if (input instanceof URL) {
    if (input.origin === window.location.origin && (input.pathname.startsWith('/api') || input.pathname.startsWith('/evidence'))) {
      return new URL(withBasePath(`${input.pathname}${input.search}`), window.location.origin);
    }
    return input;
  }

  if (input instanceof Request) {
    const url = new URL(input.url, window.location.origin);
    if (url.origin === window.location.origin && (url.pathname.startsWith('/api') || url.pathname.startsWith('/evidence'))) {
      return new Request(new URL(withBasePath(`${url.pathname}${url.search}`), window.location.origin), input);
    }
  }

  return input;
}

declare global {
  interface Window {
    __testflowFetchPatched?: boolean;
  }
}

if (typeof window !== 'undefined' && !window.__testflowFetchPatched) {
  const nativeFetch = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    // Attach the selected project/app scope to every same-origin API call so the
    // backend (and the agent) operate in the right context — without each page
    // having to thread the selection through manually.
    let nextInit = init;
    if (isApiTarget(input)) {
      const scope = scopeHeaders();
      if (Object.keys(scope).length) {
        const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined));
        for (const [k, v] of Object.entries(scope)) headers.set(k, v);
        nextInit = { ...init, headers };
      }
    }
    return nativeFetch(rewriteRequestUrl(input), nextInit);
  };
  window.__testflowFetchPatched = true;
}
