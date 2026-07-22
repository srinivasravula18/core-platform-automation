import path from 'path';
import fs from 'fs/promises';
import { DEFAULT_MODELS, listAvailableModels, type ProviderName } from '../ai/providers/types';
import { isPostgresEnabled, query } from '../db/pool';

const PROVIDERS: ProviderName[] = ['gemini', 'openai', 'anthropic'];
const DEFAULT_PROVIDER_SETTINGS: Record<ProviderName, { apiKey: string; model: string; authMode?: 'api_key' | 'account'; enabled?: boolean; effort?: 'low' | 'medium' | 'high' }> = {
  gemini: { apiKey: '', model: '', authMode: 'api_key', enabled: true, effort: 'medium' },
  openai: { apiKey: '', model: '', authMode: 'api_key', enabled: false, effort: 'medium' },
  anthropic: { apiKey: '', model: '', authMode: 'api_key', enabled: false, effort: 'medium' },
};

function isProviderName(value: unknown): value is ProviderName {
  return PROVIDERS.includes(value as ProviderName);
}

function normalizeProviderSettings(settings: any) {
  const existing = settings?.providerSettings || {};
  const providerSettings = {} as Record<ProviderName, { apiKey: string; model: string; authMode?: 'api_key' | 'account'; enabled?: boolean; effort?: 'low' | 'medium' | 'high' }>;
  for (const provider of PROVIDERS) {
    const stored = existing[provider] || {};
    providerSettings[provider] = {
      ...DEFAULT_PROVIDER_SETTINGS[provider],
      apiKey: typeof stored.apiKey === 'string' ? stored.apiKey : '',
      model: typeof stored.model === 'string' ? stored.model : '',
      authMode: stored.authMode === 'account' ? 'account' : 'api_key',
      enabled: typeof stored.enabled === 'boolean' ? stored.enabled : DEFAULT_PROVIDER_SETTINGS[provider].enabled,
      effort: ['low', 'medium', 'high'].includes(stored.effort) ? stored.effort : 'medium',
    };
  }

  const defaultProvider = isProviderName(settings?.defaultProvider) ? settings.defaultProvider : 'gemini';
  const agentProviderMap = Object.fromEntries(
    Object.entries(settings?.agentProviderMap || {}).filter(([, provider]) => isProviderName(provider)),
  ) as Record<string, ProviderName>;
  const validModels = new Set(PROVIDERS.flatMap((provider) => listAvailableModels(provider, { includeLocalOnly: true })));
  const agentModelMap = Object.fromEntries(
    Object.entries(settings?.agentModelMap || {}).filter(([, model]) => typeof model === 'string' && validModels.has(model)),
  ) as Record<string, string>;

  return { providerSettings, defaultProvider, agentProviderMap, agentModelMap };
}

export const db: any = {
  folders: [] as any[],
  plans: [] as any[],
  suites: [] as any[],
  cases: [] as any[],
  runs: [] as any[],
  defects: [] as any[],
  scripts: [] as any[],
  agentRuns: [] as any[],
  // LangGraph.js workflow runtime (Phase 1): append-only run-event audit log. Non-durable here —
  // durability is a Postgres-only guarantee (server/features/agent/workflow/events.ts).
  agentRunEvents: [] as any[],
  recentActivity: [] as any[],
  settings: {
    geminiModel: 'gemini-2.5-flash',
    siteCredentials: [] as any[],
    providerSettings: DEFAULT_PROVIDER_SETTINGS,
    defaultProvider: 'gemini' as ProviderName,
    agentProviderMap: {} as Record<string, ProviderName>,
    agentModelMap: {} as Record<string, string>,
    dailyCostLimit: 50,
    costCaps: { day: 50, week: 0, month: 0, year: 0 } as { day: number; week: number; month: number; year: number },
    autonomyLevel: 'review' as 'autonomous' | 'review' | 'manual',
  },
  reports: [] as any[],
  prompts: [] as any[],
  usageLog: [] as any[],
  websites: [] as any[],
  websiteUsers: [] as any[],
  inbox: [] as any[],
  auditLog: [] as any[],
  users: [] as any[],
  sessions: [] as any[],
  requirements: [] as any[],
  requirementLinks: [] as any[],
  appKnowledge: [] as any[],
  projects: [] as any[],
  apps: [] as any[],
  // projectId -> AES-GCM-encrypted repo access token (private-repo auth). Ciphertext only.
  repoSecrets: {} as Record<string, string>,
  blackboard: [] as any[],
  // API Intelligence (Phase A): API test runs + regression baselines. Run envelopes live here in the
  // JSON store (like agentRuns); normalized intelligence tables arrive in later phases (PostgreSQL).
  apiRuns: [] as any[],
  apiBaselines: [] as any[],
  // Object Repository (Evidence-Graph Phase 1): persistent, append-only, VERSIONED enterprise UI knowledge
  // (Platform→Application→Module→Object→Control). Evidence is never overwritten — see graph/objectRepository.
  objectRepository: [] as any[],
  // Record & Play — Local Desktop Agent (gated by REMOTE_AGENT_V1). JSON-mode equivalents of the
  // agents/recordings/automation_* Postgres tables. Empty + inert when the feature flag is off.
  agents: [] as any[],
  recordings: [] as any[],
  automationJobs: [] as any[],
  automationSchedules: [] as any[],
  automationArtifacts: [] as any[],
  automationEvents: [] as any[],
  // Conversational Runtime Phase 1 (single-process only): versioned session snapshots,
  // append-only session events, and the entity recency index. PG is required for multi-instance.
  conversationSessions: [] as any[],
  conversationSessionEvents: [] as any[],
  conversationEntityRefs: [] as any[],
};

const settingsFilePath = path.resolve(process.cwd(), '.testflow-settings.json');
const dataFilePath = path.resolve(process.cwd(), '.testflow-data.json');

function getPersistableDbSnapshot() {
  return {
    folders: db.folders,
    plans: db.plans,
    suites: db.suites,
    cases: db.cases,
    runs: db.runs,
    defects: db.defects,
    scripts: db.scripts,
    agentRuns: db.agentRuns,
    recentActivity: db.recentActivity,
    reports: db.reports,
    prompts: db.prompts,
    usageLog: db.usageLog,
    websites: db.websites,
    websiteUsers: db.websiteUsers,
    inbox: db.inbox,
    auditLog: db.auditLog,
    users: db.users,
    sessions: db.sessions,
    requirements: db.requirements,
    requirementLinks: db.requirementLinks,
    appKnowledge: db.appKnowledge,
    projects: db.projects,
    apps: db.apps,
    repoSecrets: db.repoSecrets,
    blackboard: db.blackboard,
    apiRuns: db.apiRuns,
    apiBaselines: db.apiBaselines,
    objectRepository: db.objectRepository,
    agents: db.agents,
    recordings: db.recordings,
    automationJobs: db.automationJobs,
    automationSchedules: db.automationSchedules,
    automationArtifacts: db.automationArtifacts,
    automationEvents: db.automationEvents,
    conversationSessions: db.conversationSessions,
    conversationSessionEvents: db.conversationSessionEvents,
    conversationEntityRefs: db.conversationEntityRefs,
  };
}

/** Read + parse the legacy data file; null when absent/unreadable. */
async function readDataFile(): Promise<any | null> {
  try {
    const raw = (await fs.readFile(dataFilePath, 'utf-8')).replace(/^\uFEFF/, '');
    if (!raw.trim()) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function loadPersistedData() {
  // PG mode: the file is NOT a source of truth \u2014 repositories read PostgreSQL directly and
  // the json_store hydration (post-migration) covers the array-backed collections.
  if (isPostgresEnabled()) return;
  try {
    const raw = (await fs.readFile(dataFilePath, 'utf-8')).replace(/^\uFEFF/, '');
    if (!raw.trim()) return;
    const data = JSON.parse(raw);
    db.folders = Array.isArray(data.folders) ? data.folders : [];
    db.plans = Array.isArray(data.plans) ? data.plans : [];
    db.suites = Array.isArray(data.suites) ? data.suites : [];
    db.cases = Array.isArray(data.cases) ? data.cases : [];
    db.runs = Array.isArray(data.runs) ? data.runs : [];
    db.defects = Array.isArray(data.defects) ? data.defects : [];
    db.scripts = Array.isArray(data.scripts) ? data.scripts : [];
    db.agentRuns = Array.isArray(data.agentRuns) ? data.agentRuns : [];
    db.recentActivity = Array.isArray(data.recentActivity) ? data.recentActivity : [];
    db.reports = Array.isArray(data.reports) ? data.reports : [];
    db.prompts = Array.isArray(data.prompts) ? data.prompts : [];
    db.usageLog = Array.isArray(data.usageLog) ? data.usageLog : [];
    db.websites = Array.isArray(data.websites) ? data.websites : [];
    db.websiteUsers = Array.isArray(data.websiteUsers) ? data.websiteUsers : [];
    db.inbox = Array.isArray(data.inbox) ? data.inbox : [];
    db.auditLog = Array.isArray(data.auditLog) ? data.auditLog : [];
    db.users = Array.isArray(data.users) ? data.users : [];
    db.sessions = Array.isArray(data.sessions) ? data.sessions : [];
    db.requirements = Array.isArray(data.requirements) ? data.requirements : [];
    db.requirementLinks = Array.isArray(data.requirementLinks) ? data.requirementLinks : [];
    db.appKnowledge = Array.isArray(data.appKnowledge) ? data.appKnowledge : [];
    db.projects = Array.isArray(data.projects) ? data.projects : [];
    db.apps = Array.isArray(data.apps) ? data.apps : [];
    db.repoSecrets = data.repoSecrets && typeof data.repoSecrets === 'object' ? data.repoSecrets : {};
    db.blackboard = Array.isArray(data.blackboard) ? data.blackboard : [];
    db.apiRuns = Array.isArray(data.apiRuns) ? data.apiRuns : [];
    db.apiBaselines = Array.isArray(data.apiBaselines) ? data.apiBaselines : [];
    db.objectRepository = Array.isArray(data.objectRepository) ? data.objectRepository : [];
    db.agents = Array.isArray(data.agents) ? data.agents : [];
    db.recordings = Array.isArray(data.recordings) ? data.recordings : [];
    db.automationJobs = Array.isArray(data.automationJobs) ? data.automationJobs : [];
    db.automationSchedules = Array.isArray(data.automationSchedules) ? data.automationSchedules : [];
    db.automationArtifacts = Array.isArray(data.automationArtifacts) ? data.automationArtifacts : [];
    db.automationEvents = Array.isArray(data.automationEvents) ? data.automationEvents : [];
    db.conversationSessions = Array.isArray(data.conversationSessions) ? data.conversationSessions : [];
    db.conversationSessionEvents = Array.isArray(data.conversationSessionEvents) ? data.conversationSessionEvents : [];
    db.conversationEntityRefs = Array.isArray(data.conversationEntityRefs) ? data.conversationEntityRefs : [];
  } catch (error: any) {
    if (error instanceof SyntaxError) {
      console.warn(`Ignoring unreadable persisted data at ${dataFilePath}; starting with an empty in-memory store.`);
      return;
    }
    if (error?.code !== 'ENOENT') {
      console.error(`Failed to load persisted data from ${dataFilePath}:`, error);
    }
  }
}

/* ---------- PG persistence for JSON-only collections ---------- */

// Collections whose repositories do not write a dedicated PostgreSQL table. In PG mode they
// persist to the json_store KV table (one row per collection) so the DATABASE is the source
// of truth; the JSON file remains the store for explicit no-PG development/tests only.
const PG_JSON_COLLECTIONS = ['projects', 'apps', 'appKnowledge', 'repoSecrets', 'blackboard', 'recentActivity', 'users', 'sessions'] as const;

// Write-through is armed ONLY after successful hydration — a process that never loaded from
// PG (e.g. a test script) must not clobber the stored collections with its empty arrays.
let pgJsonHydrated = false;

/** True when PostgreSQL is authoritative and hydrated — the data file is then a dead letter. */
function pgIsAuthoritative(): boolean {
  return isPostgresEnabled() && pgJsonHydrated;
}

async function savePgJsonCollections(): Promise<void> {
  if (!isPostgresEnabled() || !pgJsonHydrated) return;
  for (const key of PG_JSON_COLLECTIONS) {
    const fallback = key === 'repoSecrets' ? {} : [];
    await query(
      `INSERT INTO json_store (key, value, updated_at) VALUES ($1, $2::jsonb, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [key, JSON.stringify((db as any)[key] ?? fallback)],
    );
  }
}

/**
 * Hydrate the JSON-only collections from PostgreSQL. Call AFTER the schema migration.
 * First PG boot: json_store is empty, so the file-loaded values seed it (one-time
 * migration — nothing is lost). After that, PG wins over the file.
 */
export async function hydrateJsonCollectionsFromPg(): Promise<void> {
  if (!isPostgresEnabled()) return;
  try {
    const rows = await query('SELECT key, value FROM json_store WHERE key = ANY($1)', [PG_JSON_COLLECTIONS as unknown as string[]]);
    const byKey = new Map(rows.map((r: any) => [r.key, r.value]));
    const missing = PG_JSON_COLLECTIONS.filter((key) => !byKey.has(key));
    if (missing.length) {
      // One-time migration: collections not yet in the database seed from the legacy JSON file.
      const file = await readDataFile();
      for (const key of missing) {
        const fromFile = (file as any)?.[key];
        if (fromFile !== undefined) (db as any)[key] = fromFile;
      }
    }
    for (const key of PG_JSON_COLLECTIONS) {
      if (byKey.has(key)) (db as any)[key] = byKey.get(key);
    }
    pgJsonHydrated = true;
    if (missing.length) {
      await savePgJsonCollections();
      console.log(`[pg] json_store seeded ${missing.length} collection(s) from the legacy JSON file (${missing.join(', ')})`);
    }
    console.log('[pg] json collections hydrated — PostgreSQL is authoritative');
  } catch (err: any) {
    // Hydration failed → write-through stays DISARMED so we can't overwrite good PG data.
    console.error('[pg] json_store hydration failed (falling back to file state):', err?.message || err);
  }
}

// Per-file write queue: serialize writes to the same target so concurrent
// persistDataInBackground() calls can't interleave, and write a temp sibling then
// atomically rename — a crash mid-write leaves the previous good file intact instead of a
// half-written, unparseable one (this JSON file is the entire source of truth in JSON mode).
const writeChains = new Map<string, Promise<void>>();

async function atomicWrite(target: string, content: string): Promise<void> {
  const tmp = path.join(
    path.dirname(target),
    `.${path.basename(target)}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`,
  );
  await fs.writeFile(tmp, content, 'utf-8');
  await fs.rename(tmp, target);
}

function serializedAtomicWrite(target: string, getContent: () => string): Promise<void> {
  const prev = writeChains.get(target) ?? Promise.resolve();
  // getContent() runs at write time (not enqueue time) so the freshest state is written.
  const next = prev.catch(() => {}).then(() => atomicWrite(target, getContent()));
  writeChains.set(target, next);
  void next.finally(() => { if (writeChains.get(target) === next) writeChains.delete(target); });
  return next;
}

export async function savePersistedData() {
  // Once PostgreSQL is authoritative, nothing is written to the JSON file anymore.
  // (Until hydration succeeds — or in explicit no-PG mode — the file write remains
  // the fallback so data can never land nowhere.)
  if (pgIsAuthoritative()) {
    await savePgJsonCollections().catch((err) => console.error('[pg] json_store write failed:', err?.message || err));
    return;
  }
  await serializedAtomicWrite(dataFilePath, () => JSON.stringify(getPersistableDbSnapshot(), null, 2));
}

export async function loadPersistedSettings() {
  if (isPostgresEnabled()) {
    try {
      let rows = await query('SELECT key, value FROM settings');
      if (rows.length === 0) {
        const raw = await fs.readFile(settingsFilePath, 'utf-8').catch(() => '');
        if (raw) {
          const fromFile = JSON.parse(raw);
          for (const [key, value] of Object.entries(fromFile)) {
            await query(
              `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2::jsonb, now())
               ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
              [key, JSON.stringify(value)],
            );
          }
          rows = await query('SELECT key, value FROM settings');
        }
      }
      const settings = Object.fromEntries(rows.map((row: any) => [row.key, row.value]));
      const normalizedAiSettings = normalizeProviderSettings(settings);
      db.settings = {
        ...db.settings,
        ...settings,
        siteCredentials: Array.isArray(settings.siteCredentials) ? settings.siteCredentials : [],
        ...normalizedAiSettings,
        dailyCostLimit: typeof settings.dailyCostLimit === 'number' ? settings.dailyCostLimit : db.settings.dailyCostLimit,
        costCaps: (settings.costCaps && typeof settings.costCaps === 'object') ? { ...db.settings.costCaps, ...settings.costCaps } : db.settings.costCaps,
        autonomyLevel: settings.autonomyLevel || db.settings.autonomyLevel,
      };
    } catch {
      // Settings table may be empty on first boot.
    }
    return;
  }
  try {
    const raw = await fs.readFile(settingsFilePath, 'utf-8');
    const settings = JSON.parse(raw);
    const normalizedAiSettings = normalizeProviderSettings(settings);
    db.settings = {
      ...db.settings,
      ...settings,
      siteCredentials: Array.isArray(settings.siteCredentials) ? settings.siteCredentials : [],
      ...normalizedAiSettings,
      dailyCostLimit: typeof settings.dailyCostLimit === 'number' ? settings.dailyCostLimit : db.settings.dailyCostLimit,
      costCaps: (settings.costCaps && typeof settings.costCaps === 'object') ? { ...db.settings.costCaps, ...settings.costCaps } : db.settings.costCaps,
      autonomyLevel: settings.autonomyLevel || db.settings.autonomyLevel,
    };
  } catch {
    // Missing settings file is valid on first run.
  }
}

export async function savePersistedSettings() {
  if (isPostgresEnabled()) {
    const entries = Object.entries(db.settings || {});
    for (const [key, value] of entries) {
      await query(
        `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2::jsonb, now())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [key, JSON.stringify(value)],
      );
    }
    return;
  }
  await serializedAtomicWrite(settingsFilePath, () => JSON.stringify(db.settings, null, 2));
}

export function persistDataInBackground(reason: string) {
  void savePersistedData().catch((error) => {
    console.error(`Failed to persist ${reason}:`, error);
  });
}

// Persist db.settings (AI providers, model selection, autonomy, cost limit, etc.)
// to the settings file. Settings live in a different file than data, so handlers
// that mutate db.settings must use this — not persistDataInBackground.
export function persistSettingsInBackground(reason: string) {
  void savePersistedSettings().catch((error) => {
    console.error(`Failed to persist settings (${reason}):`, error);
  });
}

/**
 * Record a dashboard activity entry. Beyond the human message we keep a real timestamp plus a
 * structured shape (type + entityId + actor + meta) so the Recent Activity feed can render relative
 * time, a per-type icon, an outcome badge, and a clickable deep-link to the entity. `type`/`entityId`
 * are optional so legacy message-only callers keep working (they render as a plain, unlinked line).
 */
export function addActivity(
  message: string,
  opts?: { type?: string; entityId?: string; actor?: string; meta?: Record<string, any> },
) {
  db.recentActivity.unshift({
    message,
    time: 'Just now', // legacy field kept for any old consumer; UI now uses createdAt
    createdAt: new Date().toISOString(),
    type: opts?.type || 'general',
    entityId: opts?.entityId || '',
    actor: opts?.actor || '',
    meta: opts?.meta || {},
  });
  // Keep a short history (not just 6) so a future "view all" works; the dashboard slices what it needs.
  if (db.recentActivity.length > 50) db.recentActivity.length = 50;
  persistDataInBackground('activity log');
}
