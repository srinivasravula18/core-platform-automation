const rawBaseUrl = import.meta.env.BASE_URL || '/';

const normalizedBasePath = rawBaseUrl.endsWith('/') && rawBaseUrl !== '/'
  ? rawBaseUrl.slice(0, -1)
  : rawBaseUrl;

export const appBasePath = normalizedBasePath === '/' ? '' : normalizedBasePath;

export function withBasePath(path: string): string {
  if (!path.startsWith('/')) return path;
  return `${appBasePath}${path}`;
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
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => nativeFetch(rewriteRequestUrl(input), init);
  window.__testflowFetchPatched = true;
}
