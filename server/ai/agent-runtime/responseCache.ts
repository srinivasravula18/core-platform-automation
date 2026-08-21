import { createHash } from 'crypto';
import { isPostgresEnabled, query, queryOne } from '../../db/pool';
import { db } from '../../shared/storage';
import type { SupervisorResult } from '../supervisor';

const CACHE_VERSION = 'supervisor-result-v1';
export const DEEP_SCOPE_CACHE_NAMESPACE = 'deep-scope-v1';
const DEFAULT_TTL_MS = 5 * 60 * 1000;
const inFlight = new Map<string, Promise<SupervisorResult>>();

export type AgentCacheStatus = 'hit' | 'miss' | 'joined' | 'bypass';

export interface AgentCacheMetadata {
  status: AgentCacheStatus;
  key?: string;
  ageMs?: number;
  savedTokens?: number;
  reason?: string;
}

export interface AgentCacheRequest {
  namespace?: string;
  userMessage: string;
  workspaceId?: string;
  userId?: string;
  role?: string;
  projectId?: string;
  appId?: string | null;
  targets?: Array<{ id?: string; name?: string; baseUrl?: string }>;
  model?: string;
  effort?: string;
  dependencyVersion?: string;
}

export function buildAgentScopeHash(input: Pick<AgentCacheRequest, 'workspaceId' | 'userId' | 'role' | 'projectId' | 'appId' | 'targets'>): string {
  return sha256(stable({
    workspaceId: input.workspaceId || 'default',
    userId: input.userId || '',
    role: String(input.role || '').toLowerCase(),
    projectId: input.projectId || '',
    appId: input.appId || '',
    targets: (input.targets || []).map((target) => String(target.baseUrl || '').replace(/\/+$/, '').toLowerCase()).filter(Boolean).sort(),
  }));
}

type StoredResult = Omit<SupervisorResult, 'cache'>;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

export function normalizeAgentIntent(value: string): string {
  return String(value || '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Conservative by design: only clearly read-only requests may reuse a completed answer. */
export function completedResultCachePolicy(userMessage: string): { reusable: boolean; reason: string } {
  const text = normalizeAgentIntent(userMessage);
  if (!text) return { reusable: false, reason: 'empty request' };
  if (/\b(create|add|register|update|edit|modify|change|rename|delete|remove|deactivate|activate|archive|submit|save|import|upload|assign|approve|reject|clone|duplicate|merge|transfer|author|publish)\b/i.test(text)) {
    return { reusable: false, reason: 'mutation-capable request' };
  }
  if (/\b(now|current|currently|latest|today|fresh|refresh|recheck|re-check|verify again|run again)\b/i.test(text)) {
    return { reusable: false, reason: 'fresh result requested' };
  }
  return { reusable: true, reason: 'read-only request' };
}

/** A reviewed test scope is planning data, never a target mutation. */
export function completedDeepScopeCachePolicy(userMessage: string, correction = ''): { reusable: boolean; reason: string } {
  if (String(correction || '').trim()) return { reusable: false, reason: 'scope correction requested' };
  const text = normalizeAgentIntent(userMessage);
  if (!text) return { reusable: false, reason: 'empty request' };
  if (/\b(now|current|currently|latest|today|fresh|refresh|recheck|re-check|verify again|run again)\b/i.test(text)) {
    return { reusable: false, reason: 'fresh scope requested' };
  }
  return { reusable: true, reason: 'reusable reviewed scope' };
}

export function buildAgentCacheIdentity(input: AgentCacheRequest) {
  const intent = normalizeAgentIntent(input.userMessage);
  const namespace = input.namespace || CACHE_VERSION;
  const dependency = {
    version: namespace,
    sourceVersion: input.dependencyVersion || '',
    model: input.model || '',
    effort: input.effort || '',
  };
  const scopeHash = buildAgentScopeHash(input);
  const intentHash = sha256(intent);
  const dependencyHash = sha256(stable(dependency));
  return {
    cacheKey: sha256(stable({ namespace, scopeHash, intentHash, dependencyHash })),
    namespace,
    scopeHash,
    intentHash,
    dependencyHash,
  };
}

export async function readCompletedAgentResult<T = StoredResult>(input: AgentCacheRequest): Promise<{ result: T; ageMs: number; key: string } | null> {
  const id = buildAgentCacheIdentity(input);
  if (isPostgresEnabled()) {
    const row: any = await queryOne(
      `UPDATE agent_cache_entries SET last_hit_at = now(), hit_count = hit_count + 1
       WHERE cache_key = $1 AND dependency_hash = $2 AND expires_at > now()
       RETURNING result, created_at`,
      [id.cacheKey, id.dependencyHash],
    );
    return row ? { result: row.result as T, ageMs: Math.max(0, Date.now() - Date.parse(row.created_at)), key: id.cacheKey } : null;
  }
  const row = (db.agentCacheEntries || []).find((entry: any) => entry.cacheKey === id.cacheKey && entry.dependencyHash === id.dependencyHash && Date.parse(entry.expiresAt) > Date.now());
  if (!row) return null;
  row.lastHitAt = new Date().toISOString();
  row.hitCount = Number(row.hitCount || 0) + 1;
  return { result: row.result as T, ageMs: Math.max(0, Date.now() - Date.parse(row.createdAt)), key: id.cacheKey };
}

export async function storeCompletedAgentResult<T = StoredResult>(input: AgentCacheRequest, result: T, ttlMs = DEFAULT_TTL_MS): Promise<string> {
  const id = buildAgentCacheIdentity(input);
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  if (isPostgresEnabled()) {
    await query(
      `INSERT INTO agent_cache_entries (cache_key, namespace, scope_hash, intent_hash, dependency_hash, result, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)
       ON CONFLICT (cache_key) DO UPDATE SET result = EXCLUDED.result, dependency_hash = EXCLUDED.dependency_hash,
         created_at = now(), expires_at = EXCLUDED.expires_at, last_hit_at = NULL, hit_count = 0`,
      [id.cacheKey, id.namespace, id.scopeHash, id.intentHash, id.dependencyHash, JSON.stringify(result), expiresAt],
    );
  } else {
    db.agentCacheEntries = (db.agentCacheEntries || []).filter((entry: any) => entry.cacheKey !== id.cacheKey);
    db.agentCacheEntries.push({ ...id, result, createdAt: new Date().toISOString(), expiresAt, hitCount: 0 });
  }
  return id.cacheKey;
}

export async function invalidateCompletedAgentResults(scopeHash: string): Promise<void> {
  if (!scopeHash) return;
  if (isPostgresEnabled()) {
    await query('UPDATE agent_cache_entries SET expires_at = now() WHERE scope_hash = $1 AND expires_at > now()', [scopeHash]);
    return;
  }
  const now = new Date().toISOString();
  for (const entry of db.agentCacheEntries || []) if (entry.scopeHash === scopeHash) entry.expiresAt = now;
}

export function getInFlightAgentResult(key: string): Promise<SupervisorResult> | undefined {
  return inFlight.get(key);
}

export function trackInFlightAgentResult(key: string, promise: Promise<SupervisorResult>): Promise<SupervisorResult> {
  inFlight.set(key, promise);
  void promise.finally(() => { if (inFlight.get(key) === promise) inFlight.delete(key); }).catch(() => undefined);
  return promise;
}

export function resultContainsMutation(result: SupervisorResult): boolean {
  return result.toolResults.some((tool) => tool.name === 'execute_platform_api_write' || tool.name === 'author_core_platform_flow');
}

export function clearAgentCacheForTests(): void {
  inFlight.clear();
  db.agentCacheEntries = [];
}
