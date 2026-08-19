const rawBaseUrl = (import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL || '/';

const normalizedBasePath = rawBaseUrl.endsWith('/') && rawBaseUrl !== '/'
  ? rawBaseUrl.slice(0, -1)
  : rawBaseUrl;

const storageScope = normalizedBasePath === '/'
  ? 'root'
  : normalizedBasePath.replace(/^\/+|\/+$/g, '').replace(/[^a-zA-Z0-9_-]+/g, '_');

function scopedStorageKey(key: string): string {
  return `${key}::${storageScope}`;
}

/** The runtime model the user picked in the Agent Console topbar; read by the topbar usage pill too. */
export const RUNTIME_MODEL_KEY = 'tfa_runtime_model';
/** Fired when that pick changes, so same-tab listeners refresh (storage events are cross-tab only). */
export const RUNTIME_MODEL_EVENT = 'tfa:runtime-model-changed';

export function readScopedStorage(key: string): string | null {
  try {
    const scopedValue = localStorage.getItem(scopedStorageKey(key));
    if (scopedValue !== null) return scopedValue;

    const legacyValue = localStorage.getItem(key);
    if (legacyValue === null) return null;

    localStorage.setItem(scopedStorageKey(key), legacyValue);
    localStorage.removeItem(key);
    return legacyValue;
  } catch {
    return null;
  }
}

export function writeScopedStorage(key: string, value: string | null): void {
  try {
    const scopedKey = scopedStorageKey(key);
    if (value === null) localStorage.removeItem(scopedKey);
    else localStorage.setItem(scopedKey, value);
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}
