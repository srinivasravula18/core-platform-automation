/**
 * Routes for the AI runtime / prompt / cost / guardrail configuration.
 *
 * The UI in Settings calls these endpoints. The agent routes call into
 * the same modules directly.
 */

import type { Express } from 'express';
import { db, persistDataInBackground, persistSettingsInBackground } from '../../shared/storage';
import { buildProvider, listConfiguredProviders, resolveProviderForAgent, resolveModelForAgent, CODEX } from '../../ai/orchestrator';
import { DEFAULT_MODELS, listAvailableModels, type ProviderAuthMode, type ProviderName } from '../../ai/providers/types';
import { CodexRuntime } from '../../ai/codex/runtime';
import { getAppServerClient } from '../../ai/codex/appServerClient';
import { startDeviceLogin, readLogin, cancelDeviceLogin, logoutRuntime, describeLogin } from '../../ai/codex/login';
import { requireAdmin } from '../auth/routes';
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
const PROVIDERS = [CODEX] as ProviderName[];

function ensureProviderSettings() {
  const stored = db.settings.providerSettings?.[CODEX] || {};
  db.settings.providerSettings = {
    [CODEX]: {
      apiKey: stored.apiKey || '',
      // Kept verbatim: the runtime serves more models than the static registry lists.
      model: typeof stored.model === 'string' ? stored.model : '',
      // No key means the machine's ChatGPT/Codex login, which is a fully valid configuration.
      authMode: stored.apiKey || process.env.OPENAI_API_KEY ? (stored.authMode || 'api_key') : 'account',
      enabled: stored.enabled === undefined ? true : !!stored.enabled,
      effort: stored.effort || 'medium',
    },
  };
  db.settings.defaultProvider = CODEX;
  db.settings.agentProviderMap = {};
}

function hasEnvApiKey(): boolean {
  return !!process.env.OPENAI_API_KEY;
}

function redactKey(key: string): string {
  if (!key) return '';
  if (key.length <= 8) return '****';
  return `${key.slice(0, 4)}****${key.slice(-4)}`;
}

export function maskAccountIdentifier(value: string | null): string {
  if (!value) return '';
  const at = value.indexOf('@');
  if (at < 0) return value.length < 3 ? '*'.repeat(value.length) : `${value[0]}***${value.at(-1)}`;
  const name = value.slice(0, at);
  return `${name.slice(0, Math.min(2, name.length))}${'*'.repeat(Math.max(3, name.length - 2))}${value.slice(at)}`;
}

/** Config-level callability. Whether Codex is actually AUTHENTICATED is the health check's job. */
function providerIsCallable(provider: ProviderName = CODEX): boolean {
  const stored = db.settings?.providerSettings?.[provider];
  return !!stored && stored.enabled !== false;
}

export function registerSettingsRoutes(app: Express) {
  /* ---------- provider list ---------- */

  app.get('/api/ai/providers', async (_req, res) => {
    ensureProviderSettings();
    const stored = db.settings.providerSettings[CODEX];
    const authMode = (stored?.authMode || 'account') as ProviderAuthMode;
    const hasApiKey = !!stored?.apiKey || hasEnvApiKey();
    // Models the local Codex runtime actually serves; the static registry is the fallback.
    const runtime = new CodexRuntime({ apiKey: hasApiKey && authMode === 'api_key' ? 'set' : undefined });
    const [live, health, account] = await Promise.all([
      runtime.listModels().catch(() => []),
      runtime.health().catch(() => ({ ok: false, authMethod: null, error: 'The Codex runtime is unreachable.' })),
      runtime.accountInfo().catch(() => null),
    ]);
    const modelOptions = live.length
      ? live
      : listAvailableModels(CODEX).map((id) => ({ id, supportedReasoningEfforts: ['low', 'medium', 'high'] }));
    const models = modelOptions.map((m) => m.id);
    const defaultModel = models[0] || DEFAULT_MODELS[CODEX].default;
    const selectedModel = models.includes(stored?.model || '') ? stored!.model : defaultModel;
    const selectedEfforts = modelOptions.find((m) => m.id === selectedModel)?.supportedReasoningEfforts || [];
    const selectedEffort = selectedEfforts.includes(stored?.effort || '')
      ? stored!.effort
      : (selectedEfforts[0] || stored?.effort || 'medium');
    res.json({
      providers: [{
        name: CODEX,
        defaultModel,
        alternatives: models.filter((m) => m !== defaultModel),
        models: modelOptions,
        efforts: selectedEfforts.length ? selectedEfforts : ['low', 'medium', 'high'],
        enabled: stored?.enabled !== false,
        configured: true,
        apiKeyConfigured: hasApiKey,
        callable: providerIsCallable(),
        model: selectedModel,
        authMode,
        effort: selectedEffort,
        runtime: 'codex',
        apiKeyMasked: stored?.apiKey ? redactKey(stored.apiKey) : '',
        // LIVE auth, not stored config: whether Codex can actually run right now, and how it
        // is signed in. Settings must not claim "Active" when the ChatGPT session has lapsed.
        authenticated: health.ok,
        authMethod: health.authMethod || null,
        authError: health.ok ? '' : (health as any).error || '',
        account: account?.authMethod === 'chatgpt' ? {
          emailMasked: maskAccountIdentifier(account.email),
          planType: account.planType,
          sessionLimit: account.sessionLimit,
          weeklyLimit: account.weeklyLimit,
        } : null,
      }],
      configured: listConfiguredProviders(),
      defaultProvider: CODEX,
      agentProviderMap: {},
      agentModelMap: db.settings?.agentModelMap || {},
    });
  });

  /* ---------- ChatGPT device sign-in (deployment: no browser, no shell, no API key) ---------- */

  app.post('/api/ai/runtime/login', requireAdmin, async (_req, res) => {
    try {
      res.json(describeLogin(await startDeviceLogin()));
    } catch (err: any) {
      res.status(502).json({ error: err?.message || 'Could not start the Codex sign-in.' });
    }
  });

  app.post('/api/ai/runtime/login/token', requireAdmin, async (req, res) => {
    const accessToken = String(req.body?.accessToken || '').trim();
    const chatgptAccountId = String(req.body?.chatgptAccountId || '').trim();
    if (!accessToken || !chatgptAccountId) return res.status(400).json({ error: 'Access token and ChatGPT account ID are required.' });
    try {
      await getAppServerClient().loginWithAccessToken(accessToken, chatgptAccountId);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(401).json({ error: err?.message || 'Could not sign in with that access token.' });
    }
  });

  // Polled by Settings while the admin completes the code in their own browser.
  app.get('/api/ai/runtime/login/:loginId', requireAdmin, (req, res) => {
    const login = readLogin(String(req.params.loginId));
    if (!login) return res.status(404).json({ error: 'That sign-in is no longer active.' });
    res.json(describeLogin(login));
  });

  app.post('/api/ai/runtime/login/:loginId/cancel', requireAdmin, async (req, res) => {
    res.json({ ok: await cancelDeviceLogin(String(req.params.loginId)) });
  });

  app.post('/api/ai/runtime/logout', requireAdmin, async (_req, res) => {
    try {
      await logoutRuntime();
      res.json({ ok: true });
    } catch (err: any) {
      res.status(502).json({ error: err?.message || 'Could not sign out of Codex.' });
    }
  });

  app.post('/api/ai/providers/:name/test', async (req, res) => {
    const name = req.params.name as ProviderName;
    if (!PROVIDERS.includes(name)) return res.status(404).json({ ok: false, provider: name, error: `Unknown runtime: ${name}`, checkedAt: new Date().toISOString() });
    try {
      res.json(await buildProvider(name).health());
    } catch (err: any) {
      res.status(400).json({ ok: false, provider: name, error: err?.message || String(err), checkedAt: new Date().toISOString() });
    }
  });

  app.put('/api/ai/providers/:name', (req, res) => {
    const name = req.params.name as ProviderName;
    if (!PROVIDERS.includes(name)) return res.status(404).json({ error: `Unknown runtime: ${name}` });
    const { apiKey, model, authMode, enabled, effort } = req.body || {};
    ensureProviderSettings();
    const slot = db.settings.providerSettings[name];
    if (apiKey !== undefined) slot.apiKey = apiKey;
    if (model !== undefined) slot.model = model;
    if (effort !== undefined) {
      if (typeof effort !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/i.test(effort)) return res.status(400).json({ error: 'effort must be a valid Codex reasoning effort' });
      slot.effort = effort;
    }
    if (authMode !== undefined) {
      if (!['api_key', 'account'].includes(authMode)) return res.status(400).json({ error: 'authMode must be api_key or account' });
      if (authMode === 'api_key' && !slot.apiKey && !hasEnvApiKey()) {
        return res.status(400).json({ error: 'Add an OpenAI API key before switching to API-key mode.' });
      }
      slot.authMode = authMode;
    }
    if (enabled !== undefined) slot.enabled = !!enabled;
    persistSettingsInBackground(`runtime settings: ${name}`);
    res.json({ ok: true, name, model: slot.model || DEFAULT_MODELS[name].default, authMode: slot.authMode, enabled: slot.enabled !== false });
  });

  app.delete('/api/ai/providers/:name/key', (req, res) => {
    const name = req.params.name as ProviderName;
    if (db.settings.providerSettings?.[name]) {
      db.settings.providerSettings[name].apiKey = '';
      persistSettingsInBackground(`clear provider key: ${name}`);
    }
    res.json({ ok: true });
  });

  // Kept for API compatibility: the runtime is fixed, so only the model selection still applies.
  app.put('/api/ai/default-provider', (req, res) => {
    const { model } = req.body || {};
    ensureProviderSettings();
    if (model) db.settings.providerSettings[CODEX].model = model;
    persistSettingsInBackground('default model');
    res.json({ ok: true, defaultProvider: CODEX });
  });

  app.put('/api/ai/agent-provider', (req, res) => {
    const { agent, model } = req.body || {};
    if (!agent) return res.status(400).json({ error: 'agent is required' });
    if (model) {
      if (!db.settings.agentModelMap) db.settings.agentModelMap = {};
      db.settings.agentModelMap[agent] = model;
    }
    persistSettingsInBackground(`agent model: ${agent}`);
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
    res.json({ workspaceId, used, limit, currency: 'USD', autonomyLevel: db.settings?.autonomyLevel || 'review', guardrailLogs: recentGuardrailLogs(workspaceId) });
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

  // All-time-through-now spend analysis for the signed-in user: per-window token+cost totals,
  // per-model breakdown, and caps. Never expose deployment-wide usage in an individual's Settings.
  app.get('/api/ai/usage/summary', async (req, res) => {
    try {
      const userId = usageWorkspace(req);
      res.json(await getSpendSummary(userId));
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
