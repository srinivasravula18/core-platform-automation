/**
 * Understanding producer — assembles an AppUnderstanding by grounding on the connected repo (auth keys
 * grepped from its auth code, nav from its sidebar) + URL, never product knowledge. Memory-first (recall
 * a learned repo, else learn once + remember); published to the blackboard. No product literals.
 */
import { defineUnderstanding, deriveUnderstandingFromUrl, type AppUnderstanding, type Evidence } from './understanding';
import { getBlackboard, type Blackboard } from './bus/blackboard';
import { getMemoryStore, type MemoryScope, type MemoryStore } from './memory/store';
import { gitGrep, readRepoFile } from '../features/git-agent/gitAgentService';
import { loadAdminNavModules } from '../features/agent/appTargeting';
import { discoverApis } from '../features/api-intelligence/discovery';
import { resolveCredentials } from '../features/credentials/credentialsService';

export interface UnderstandConnectedApp {
  projectId?: string | null;
  appId?: string | null;
  ownerId?: string | null;
  repoPath?: string | null;
  appUrl?: string | null;
  appLabel?: string | null;
}

export interface ResolveUnderstandingInput {
  connectedApp: UnderstandConnectedApp;
  runId?: string;
  agent?: string;
  blackboard?: Blackboard;
  memory?: MemoryStore;
  /** Force a fresh learn even if memory has one (e.g. repo changed). */
  refresh?: boolean;
}

function scopeOf(app: UnderstandConnectedApp): MemoryScope {
  return { projectId: app.projectId ?? undefined, appId: app.appId ?? undefined, ownerId: app.ownerId ?? undefined };
}

/** Learn the app's OWN auth storage keys from its repo — grep its auth code, extract the exact storage
 *  keys it reads/writes. Returns the keys + file citations. Empty when no repo/keys are found. */
export function learnAuthStorageKeys(repoPath: string): { keys: string[]; cites: string[] } {
  const root = String(repoPath || '').trim();
  if (!root) return { keys: [], cites: [] };
  try {
    const hits = gitGrep(
      ['auth_token', 'access_token', 'refresh_token', 'refresh_family', 'current_username', 'auth_namespace'],
      undefined, 60, root,
    ) as Array<{ path: string }>;
    const keys = new Set<string>();
    const cites = new Set<string>();
    // A: any storage.setItem/getItem key. B: any string literal whose suffix names an auth concept
    // (token/refresh/username/namespace) — captures namespaced keys defined as constants, product-agnostic.
    const storageRe = /(?:session|local)Storage\.(?:set|get)Item\(\s*[`'"]([^`'"]+)[`'"]/g;
    const authLiteralRe = /[`'"]([a-z0-9_]+\.[a-z0-9_.]*(?:auth_token|access_token|refresh_token|refresh_family[a-z0-9_]*|current_username|auth_namespace[a-z0-9_]*)[a-z0-9_]*)[`'"]/gi;
    const authish = (k: string) => /auth|token|session|refresh|current_user|username|namespace/i.test(k);
    for (const hit of hits.slice(0, 60)) {
      const src = readRepoFile(hit.path, 40000, root) as string;
      if (!src) continue;
      let found = false;
      for (let m = storageRe.exec(src); m; m = storageRe.exec(src)) { if (authish(m[1])) { keys.add(m[1]); found = true; } }
      for (let m = authLiteralRe.exec(src); m; m = authLiteralRe.exec(src)) { keys.add(m[1]); found = true; }
      if (found) cites.add(hit.path);
    }
    // Drop config/TTL literals that merely CONTAIN an auth word — they are settings, not storage keys.
    const isConfig = (k: string) => /_ttl|_hours|_days|_seconds|_minutes|_expiry|_ms\b|\.ttl\b/i.test(k);
    return { keys: [...keys].filter((k) => !isConfig(k)), cites: [...cites] };
  } catch { return { keys: [], cites: [] }; }
}

/** Learn the app's API contract from its OWN published OpenAPI spec — app-agnostic, no endpoint literals.
 *  Tries the app-URL origin and any resolved-credential origin (UI and API can differ by port/host). */
async function learnApiContract(appUrl: string, ownerId?: string | null): Promise<{ baseUrl: string; metadataEndpoint: string | null; cites: string[] } | null> {
  const origins = new Set<string>();
  try { if (appUrl) origins.add(new URL(appUrl).origin); } catch { /* not a URL */ }
  try {
    const cred = resolveCredentials({ targetUrl: appUrl || undefined, ownerId: ownerId || undefined } as any);
    if (cred?.baseUrl) origins.add(new URL(cred.baseUrl).origin);
  } catch { /* no creds */ }
  for (const origin of origins) {
    try {
      const disc = await discoverApis({ baseUrl: origin, fetchLive: true });
      if (disc.endpoints?.length) {
        // The metadata/objects listing endpoint, matched by its own path words — no product path hardcoded.
        const meta = disc.endpoints.find((e: any) => String(e.method).toUpperCase() === 'GET' && /object|metadata|schema|model|entit/i.test(String(e.path)));
        return { baseUrl: origin, metadataEndpoint: meta ? String(meta.path) : null, cites: [`${origin} (OpenAPI, ${disc.endpoints.length} endpoints)`] };
      }
    } catch { /* try next origin */ }
  }
  return null;
}

/** Nav modules parsed from the connected repo's own admin sidebar (already app-agnostic). */
function learnNavModules(repoPath: string): { modules: Array<{ id: string; name: string }>; cites: string[] } {
  try {
    const mods = (loadAdminNavModules(repoPath) as Array<{ id: string; name: string }>).map((m) => ({ id: m.id, name: m.name }));
    return { modules: mods, cites: mods.length ? ['<repo>/admin sidebar'] : [] };
  } catch { return { modules: [], cites: [] }; }
}

/**
 * Resolve (or learn + remember) the connected app's understanding. Memory-first; else assemble from the
 * URL floor enriched with repo-grounded facts; publish to the blackboard; remember when meaningfully learned.
 */
export async function resolveAppUnderstanding(input: ResolveUnderstandingInput): Promise<AppUnderstanding> {
  const agent = input.agent || 'chatAssistant';
  const blackboard = input.blackboard ?? getBlackboard();
  const memory = input.memory ?? getMemoryStore();
  const scope = scopeOf(input.connectedApp);
  const runId = input.runId || 'understanding';

  if (!input.refresh) {
    const recalled = await memory.recall({ scope, kind: 'semantic', subject: 'app.understanding', limit: 1 }).catch(() => []);
    if (recalled[0]?.value) {
      const u = recalled[0].value as AppUnderstanding;
      await blackboard.put(runId, 'app.understanding', u, agent, { causationId: 'memory-recall' }).catch(() => {});
      return u;
    }
  }

  // HONEST floor from the URL, then enrich with repo-grounded evidence.
  const app = input.connectedApp;
  const u = deriveUnderstandingFromUrl(app.appUrl || '', app.appId, app.appLabel);
  const evidence: Record<string, Evidence> = { ...u.evidence };

  if (app.repoPath) {
    const auth = learnAuthStorageKeys(app.repoPath);
    if (auth.keys.length) {
      u.auth.storageKeys = auth.keys;
      u.auth.mode = 'token';
      evidence['auth.storageKeys'] = { source: 'repo', confidence: 0.8, cites: auth.cites };
    }
    const nav = learnNavModules(app.repoPath);
    if (nav.modules.length) {
      u.navModules = nav.modules;
      evidence['navModules'] = { source: 'repo', confidence: 0.7, cites: nav.cites };
    }
  }

  // Learn the API contract from the app's own OpenAPI (app-agnostic; base + metadata endpoint).
  const api = await learnApiContract(app.appUrl || '', app.ownerId).catch(() => null);
  if (api) {
    u.api.baseUrl = api.baseUrl;
    u.api.metadataEndpoint = api.metadataEndpoint;
    evidence['api'] = { source: 'api', confidence: api.metadataEndpoint ? 0.8 : 0.5, cites: api.cites };
  }

  u.evidence = evidence;
  const learned = u.auth.storageKeys.length > 0 || u.navModules.length > 0 || Boolean(u.api.baseUrl);
  u.confidence = Math.max(u.confidence, learned ? 0.6 : u.confidence);

  await blackboard.put(runId, 'app.understanding', u, agent, { causationId: 'discovery' }).catch(() => {});
  if (learned) {
    await memory.write({ scope, kind: 'semantic', subject: 'app.understanding', value: u, runId }).catch(() => {});
  }
  return defineUnderstanding(u); // normalize defensively
}
