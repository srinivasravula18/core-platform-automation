/**
 * Routes for the AI provider / prompt / cost / guardrail configuration.
 *
 * The UI in Settings calls these endpoints. The agent routes call into
 * the same modules directly.
 */

import type { Express } from 'express';
import { db, persistDataInBackground, persistSettingsInBackground } from '../../shared/storage';
import { buildProvider, listConfiguredProviders, resolveProviderForAgent, resolveModelForAgent } from '../../ai/orchestrator';
import { DEFAULT_MODELS, listAvailableModels, type ProviderAuthMode, type ProviderName } from '../../ai/providers/types';
import {
  listPrompts,
  getActivePrompt,
  getDefaultPrompt,
  getEffectivePrompt,
  savePromptVersion,
  activatePromptVersion,
  resetPromptToDefault,
  AGENT_PROMPTS,
} from '../../ai/promptStore';
import { type AgentName, CANONICAL_AGENTS } from '../../ai/systemPrompts';
import { setDailyLimit, getDailyLimit, listUsage, getDailyCost, getSpendSummary, getCostCaps, setCostCaps } from '../../ai/costTracker';
import { recentGuardrailLogs } from '../../ai/guardrails';
import { reqScope } from '../../shared/scope';

// Cost + usage are tracked per app-user (each profile sees only their own spend/logs).
// The acting user's id is the usage "workspace"; fall back to 'default' when unauthenticated.
function usageWorkspace(req: any): string {
  return reqScope(req).userId || 'default';
}

// Only the consolidated 7 roles are shown/managed in the UI. Legacy agent keys
// still resolve (aliased) but are no longer surfaced for editing.
const AGENT_NAMES: AgentName[] = CANONICAL_AGENTS;
const PROVIDERS = ['gemini', 'openai', 'anthropic'] as ProviderName[];

function ensureProviderSettings() {
  const existing = db.settings.providerSettings || {};
  db.settings.providerSettings = {};
  for (const name of PROVIDERS) {
    const model = existing[name]?.model || '';
    db.settings.providerSettings[name] = {
      apiKey: existing[name]?.apiKey || '',
      model: listAvailableModels(name, { includeLocalOnly: true }).includes(model) ? model : '',
      authMode: existing[name]?.authMode || 'api_key',
      enabled: existing[name]?.enabled === undefined ? name === db.settings.defaultProvider : !!existing[name]?.enabled,
    };
  }
  if (!PROVIDERS.includes(db.settings.defaultProvider)) db.settings.defaultProvider = 'gemini';
  db.settings.agentProviderMap = Object.fromEntries(
    Object.entries(db.settings.agentProviderMap || {}).filter(([, provider]) => PROVIDERS.includes(provider as ProviderName)),
  );
}

function hasEnvApiKey(provider: ProviderName): boolean {
  if (provider === 'gemini') return !!(process.env.GEMINI_API_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY);
  if (provider === 'openai') return !!process.env.OPENAI_API_KEY;
  if (provider === 'anthropic') return !!process.env.ANTHROPIC_API_KEY;
  return false;
}

function supportsAccountCli(provider: ProviderName): boolean {
  return provider === 'openai' || provider === 'anthropic';
}

function isLocalCliProviderAllowed(): boolean {
  const env = String(process.env.NODE_ENV || '').toLowerCase();
  const explicit = String(process.env.ALLOW_LOCAL_CLI_PROVIDERS || '').toLowerCase();
  const deploymentMode = String(process.env.DEPLOYMENT_MODE || '').toLowerCase();
  const lifecycle = String(process.env.npm_lifecycle_event || '').toLowerCase();
  if (explicit === 'true') return true;
  if (explicit === 'false') return false;
  return (
    !env ||
    env === 'development' ||
    env === 'dev' ||
    deploymentMode === 'local' ||
    lifecycle.startsWith('dev')
  );
}

function redactKey(key: string): string {
  if (!key) return '';
  if (key.length <= 8) return '****';
  return `${key.slice(0, 4)}****${key.slice(-4)}`;
}

function providerIsCallable(provider: ProviderName): boolean {
  const stored = db.settings?.providerSettings?.[provider];
  if (!stored || stored.enabled === false) return false;
  const authMode = (stored.authMode || 'api_key') as ProviderAuthMode;
  if (authMode === 'account') return isLocalCliProviderAllowed() && supportsAccountCli(provider);
  return !!stored.apiKey || hasEnvApiKey(provider);
}

function repairDefaultProviderIfNeeded(): void {
  if (providerIsCallable(db.settings.defaultProvider)) return;
  const fallback = PROVIDERS.find((provider) => providerIsCallable(provider));
  if (fallback) db.settings.defaultProvider = fallback;
}

export function registerSettingsRoutes(app: Express) {
  /* ---------- provider list ---------- */

  app.get('/api/ai/providers', (_req, res) => {
    ensureProviderSettings();
    if (!isLocalCliProviderAllowed()) {
      for (const provider of PROVIDERS) {
        const stored = db.settings.providerSettings[provider];
        if (stored?.authMode === 'account') stored.authMode = 'api_key';
      }
    }
    repairDefaultProviderIfNeeded();
    const out = PROVIDERS.map((p) => {
      const stored = db.settings?.providerSettings?.[p];
      const authMode = (stored?.authMode || 'api_key') as ProviderAuthMode;
      const hasApiKey = !!stored?.apiKey || hasEnvApiKey(p);
      const accountCallable = isLocalCliProviderAllowed() && supportsAccountCli(p);
      return {
        name: p,
        defaultModel: DEFAULT_MODELS[p].default,
        alternatives: listAvailableModels(p, { includeLocalOnly: isLocalCliProviderAllowed() }).filter((m) => m !== DEFAULT_MODELS[p].default),
        enabled: stored?.enabled !== false,
        configured: authMode === 'api_key' ? hasApiKey : accountCallable,
        callable: (stored?.enabled !== false) && (authMode === 'api_key' ? hasApiKey : accountCallable),
        model: stored?.model || DEFAULT_MODELS[p].default,
        authMode,
        effort: stored?.effort || 'medium',
        accountTool: authMode === 'account' && p === 'openai' ? 'codex' : authMode === 'account' && p === 'anthropic' ? 'claude' : '',
        runtime: authMode === 'api_key' ? 'sdk' : 'cli',
        accountCliAllowed: isLocalCliProviderAllowed(),
        apiKeyMasked: stored?.apiKey ? redactKey(stored.apiKey) : '',
      };
    });
    res.json({
      providers: out,
      configured: listConfiguredProviders(),
      defaultProvider: db.settings?.defaultProvider || 'gemini',
      agentProviderMap: db.settings?.agentProviderMap || {},
      agentModelMap: db.settings?.agentModelMap || {},
    });
  });

  app.post('/api/ai/providers/:name/test', async (req, res) => {
    const name = req.params.name as ProviderName;
    if (!PROVIDERS.includes(name)) return res.status(404).json({ ok: false, provider: name, error: `Unknown provider: ${name}`, checkedAt: new Date().toISOString() });
    try {
      const provider = buildProvider(name);
      const health = await provider.health();
      res.json(health);
    } catch (err: any) {
      res.status(400).json({ ok: false, provider: name, error: err?.message || String(err), checkedAt: new Date().toISOString() });
    }
  });

  app.put('/api/ai/providers/:name', (req, res) => {
    const name = req.params.name as ProviderName;
    if (!PROVIDERS.includes(name)) return res.status(404).json({ error: `Unknown provider: ${name}` });
    const { apiKey, model, authMode, enabled } = req.body || {};
    ensureProviderSettings();
    const slot = db.settings.providerSettings[name] || { apiKey: '', model: '', authMode: 'api_key' };
    if (apiKey !== undefined) slot.apiKey = apiKey;
    if (model !== undefined) slot.model = model;
    if (authMode !== undefined) {
      if (!['api_key', 'account'].includes(authMode)) return res.status(400).json({ error: 'authMode must be api_key or account' });
      if (authMode === 'account' && !isLocalCliProviderAllowed()) {
        return res.status(400).json({ error: 'Subscription/account auth is only available in local development.' });
      }
      slot.authMode = authMode;
    }
    if (enabled !== undefined) slot.enabled = !!enabled;
    db.settings.providerSettings[name] = slot;
    if (providerIsCallable(name) && !providerIsCallable(db.settings.defaultProvider)) {
      db.settings.defaultProvider = name;
    }
    persistSettingsInBackground(`provider settings: ${name}`);
    res.json({ ok: true, name, model: slot.model || DEFAULT_MODELS[name].default, authMode: slot.authMode || 'api_key', enabled: slot.enabled !== false });
  });

  app.delete('/api/ai/providers/:name/key', (req, res) => {
    const name = req.params.name as ProviderName;
    if (db.settings.providerSettings?.[name]) {
      db.settings.providerSettings[name].apiKey = '';
      persistSettingsInBackground(`clear provider key: ${name}`);
    }
    res.json({ ok: true });
  });

  app.put('/api/ai/default-provider', (req, res) => {
    const { provider, model } = req.body || {};
    if (provider && PROVIDERS.includes(provider)) {
      ensureProviderSettings();
      db.settings.providerSettings[provider].enabled = true;
      db.settings.defaultProvider = provider;
    }
    if (model) {
      ensureProviderSettings();
      const targetProvider = PROVIDERS.includes(provider) ? provider : db.settings.defaultProvider;
      db.settings.providerSettings[targetProvider].model = model;
    }
    persistSettingsInBackground('default provider');
    res.json({ ok: true, defaultProvider: db.settings.defaultProvider });
  });

  app.put('/api/ai/agent-provider', (req, res) => {
    const { agent, provider, model } = req.body || {};
    if (!agent) return res.status(400).json({ error: 'agent is required' });
    if (provider) {
      if (!PROVIDERS.includes(provider)) return res.status(400).json({ error: `Unknown provider: ${provider}` });
      if (!db.settings.agentProviderMap) db.settings.agentProviderMap = {};
      db.settings.agentProviderMap[agent] = provider;
    }
    if (model) {
      if (!db.settings.agentModelMap) db.settings.agentModelMap = {};
      db.settings.agentModelMap[agent] = model;
    }
    persistSettingsInBackground(`agent provider: ${agent}`);
    res.json({ ok: true, agent, provider: resolveProviderForAgent(agent), model: resolveModelForAgent(agent, resolveProviderForAgent(agent)) });
  });

  /* ---------- prompts ---------- */

  app.get('/api/ai/prompts', (_req, res) => {
    const out = AGENT_NAMES.map((agent) => {
      const effective = getEffectivePrompt(agent);
      const active = getActivePrompt(agent);
      const versions = listPrompts().filter((p) => p.agent === agent);
      return {
        agent,
        source: effective.source,
        version: active?.version,
        activeBody: effective.body,
        defaultBody: getDefaultPrompt(agent),
        versions: versions.map((v) => ({ id: v.id, version: v.version, isActive: v.isActive, createdAt: v.createdAt, createdBy: v.createdBy, notes: v.notes, body: v.body })),
      };
    });
    res.json({ agents: out });
  });

  app.get('/api/ai/prompts/:agent', (req, res) => {
    const agent = req.params.agent as AgentName;
    if (!AGENT_PROMPTS[agent]) return res.status(404).json({ error: `Unknown agent: ${agent}` });
    const effective = getEffectivePrompt(agent);
    const active = getActivePrompt(agent);
    const versions = listPrompts().filter((p) => p.agent === agent);
    res.json({
      agent,
      source: effective.source,
      version: active?.version,
      activeBody: effective.body,
      defaultBody: getDefaultPrompt(agent),
      versions: versions.map((v) => ({ id: v.id, version: v.version, isActive: v.isActive, createdAt: v.createdAt, createdBy: v.createdBy, notes: v.notes, body: v.body })),
    });
  });

  app.put('/api/ai/prompts/:agent', (req, res) => {
    const agent = req.params.agent as AgentName;
    if (!AGENT_PROMPTS[agent]) return res.status(404).json({ error: `Unknown agent: ${agent}` });
    const { body, notes, activate } = req.body || {};
    if (typeof body !== 'string') return res.status(400).json({ error: 'body is required' });
    const v = savePromptVersion({ agent, body, notes: notes || '', createdBy: req.body.createdBy || 'admin', activate: activate !== false });
    persistDataInBackground(`prompt: ${agent}`);
    res.json({ ok: true, version: v });
  });

  app.post('/api/ai/prompts/:agent/reset', (req, res) => {
    const agent = req.params.agent as AgentName;
    if (!AGENT_PROMPTS[agent]) return res.status(404).json({ error: `Unknown agent: ${agent}` });
    const changed = resetPromptToDefault(agent);
    persistDataInBackground(`reset prompt: ${agent}`);
    res.json({ ok: true, reset: changed });
  });

  app.post('/api/ai/prompts/:agent/activate', (req, res) => {
    const agent = req.params.agent as AgentName;
    if (!AGENT_PROMPTS[agent]) return res.status(404).json({ error: `Unknown agent: ${agent}` });
    const { versionId } = req.body || {};
    if (!versionId) return res.status(400).json({ error: 'versionId is required' });
    const v = activatePromptVersion(agent, versionId);
    if (!v) return res.status(404).json({ error: 'Version not found' });
    persistDataInBackground(`activate prompt: ${agent}`);
    res.json({ ok: true, version: v });
  });

  /* ---------- cost / guardrails ---------- */

  app.get('/api/ai/cost', (req, res) => {
    const workspaceId = usageWorkspace(req);
    const limit = getDailyLimit();
    const used = getDailyCost(workspaceId);
    res.json({ workspaceId, used, limit, currency: 'USD', autonomyLevel: db.settings?.autonomyLevel || 'review', guardrailLogs: recentGuardrailLogs() });
  });

  app.put('/api/settings/autonomy', (req, res) => {
    const { level } = req.body || {};
    if (!['autonomous', 'review', 'manual'].includes(level)) {
      return res.status(400).json({ error: 'level must be one of autonomous, review, manual' });
    }
    db.settings.autonomyLevel = level;
    persistSettingsInBackground('autonomy level');
    res.json({ ok: true, level });
  });

  app.put('/api/ai/cost/limit', (req, res) => {
    const { limit } = req.body || {};
    if (typeof limit !== 'number' || limit < 0) return res.status(400).json({ error: 'limit must be a non-negative number' });
    setDailyLimit(limit);
    persistSettingsInBackground('daily cost limit');
    res.json({ ok: true, limit });
  });

  app.get('/api/ai/usage', (req, res) => {
    const workspaceId = usageWorkspace(req);
    const limit = Math.min(500, Number(req.query.limit) || 100);
    res.json({ usage: listUsage(workspaceId, limit) });
  });

  // All-time-through-now spend analysis: per-window token+cost totals, per-model breakdown, caps.
  // ?scope=all (default) aggregates the whole deployment; ?scope=project uses the request's project.
  app.get('/api/ai/usage/summary', async (req, res) => {
    try {
      const scoped = String(req.query.scope || 'all') === 'project';
      const workspaceId = scoped ? usageWorkspace(req) : undefined;
      res.json(await getSpendSummary(workspaceId));
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Failed to compute usage summary.' });
    }
  });

  // Configure per-window spend caps (USD). Any subset of { day, week, month, year }.
  app.put('/api/ai/cost/caps', (req, res) => {
    const body = req.body || {};
    const caps: any = {};
    for (const k of ['day', 'week', 'month', 'year']) {
      if (body[k] !== undefined) {
        const n = Number(body[k]);
        if (!Number.isFinite(n) || n < 0) return res.status(400).json({ error: `${k} cap must be a non-negative number` });
        caps[k] = n;
      }
    }
    const next = setCostCaps(caps);
    persistSettingsInBackground('cost caps');
    res.json({ ok: true, caps: next });
  });

  app.get('/api/ai/cost/caps', (_req, res) => {
    res.json({ caps: getCostCaps() });
  });

  app.get('/api/ai/health', async (_req, res) => {
    const out: any[] = [];
    for (const name of listConfiguredProviders()) {
      try {
        const provider = buildProvider(name);
        out.push(await provider.health());
      } catch (err: any) {
        out.push({ ok: false, provider: name, error: err?.message || String(err), checkedAt: new Date().toISOString() });
      }
    }
    res.json({ providers: out, checkedAt: new Date().toISOString() });
  });
}
