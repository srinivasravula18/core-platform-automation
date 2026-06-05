/**
 * Routes for the AI provider / prompt / cost / guardrail configuration.
 *
 * The UI in Settings calls these endpoints. The agent routes call into
 * the same modules directly.
 */

import type { Express } from 'express';
import { db, persistDataInBackground } from '../../shared/storage';
import { buildProvider, listConfiguredProviders, resolveProviderForAgent, resolveModelForAgent } from '../../ai/orchestrator';
import { DEFAULT_MODELS, type ProviderName } from '../../ai/providers/types';
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
import type { AgentName } from '../../ai/systemPrompts';
import { setDailyLimit, getDailyLimit, listUsage, getDailyCost } from '../../ai/costTracker';
import { recentGuardrailLogs } from '../../ai/guardrails';

const AGENT_NAMES: AgentName[] = Object.keys(AGENT_PROMPTS) as AgentName[];

function redactKey(key: string): string {
  if (!key) return '';
  if (key.length <= 8) return '****';
  return `${key.slice(0, 4)}****${key.slice(-4)}`;
}

export function registerSettingsRoutes(app: Express) {
  /* ---------- provider list ---------- */

  app.get('/api/ai/providers', (_req, res) => {
    const out = (['gemini', 'openai', 'anthropic'] as ProviderName[]).map((p) => {
      const stored = db.settings?.providerSettings?.[p];
      return {
        name: p,
        defaultModel: DEFAULT_MODELS[p].default,
        alternatives: DEFAULT_MODELS[p].alternatives,
        configured: !!(stored?.apiKey) || !!(p === 'gemini' && process.env.GEMINI_API_KEY),
        model: stored?.model || DEFAULT_MODELS[p].default,
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
    const { apiKey, model } = req.body || {};
    if (!db.settings.providerSettings) db.settings.providerSettings = { gemini: { apiKey: '', model: '' }, openai: { apiKey: '', model: '' }, anthropic: { apiKey: '', model: '' } };
    const slot = db.settings.providerSettings[name] || { apiKey: '', model: '' };
    if (apiKey !== undefined) slot.apiKey = apiKey;
    if (model !== undefined) slot.model = model;
    db.settings.providerSettings[name] = slot;
    persistDataInBackground(`provider settings: ${name}`);
    res.json({ ok: true, name, model: slot.model || DEFAULT_MODELS[name].default });
  });

  app.delete('/api/ai/providers/:name/key', (req, res) => {
    const name = req.params.name as ProviderName;
    if (db.settings.providerSettings?.[name]) {
      db.settings.providerSettings[name].apiKey = '';
      persistDataInBackground(`clear provider key: ${name}`);
    }
    res.json({ ok: true });
  });

  app.put('/api/ai/default-provider', (req, res) => {
    const { provider, model } = req.body || {};
    if (provider && ['gemini', 'openai', 'anthropic'].includes(provider)) {
      db.settings.defaultProvider = provider;
    }
    if (model) {
      if (!db.settings.providerSettings) db.settings.providerSettings = { gemini: { apiKey: '', model: '' }, openai: { apiKey: '', model: '' }, anthropic: { apiKey: '', model: '' } };
      db.settings.providerSettings[provider || db.settings.defaultProvider].model = model;
    }
    persistDataInBackground('default provider');
    res.json({ ok: true, defaultProvider: db.settings.defaultProvider });
  });

  app.put('/api/ai/agent-provider', (req, res) => {
    const { agent, provider, model } = req.body || {};
    if (!agent) return res.status(400).json({ error: 'agent is required' });
    if (provider) {
      if (!db.settings.agentProviderMap) db.settings.agentProviderMap = {};
      db.settings.agentProviderMap[agent] = provider;
    }
    if (model) {
      if (!db.settings.agentModelMap) db.settings.agentModelMap = {};
      db.settings.agentModelMap[agent] = model;
    }
    persistDataInBackground(`agent provider: ${agent}`);
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
    const workspaceId = (req.query.workspaceId as string) || 'default';
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
    persistDataInBackground('autonomy level');
    res.json({ ok: true, level });
  });

  app.put('/api/ai/cost/limit', (req, res) => {
    const { limit } = req.body || {};
    if (typeof limit !== 'number' || limit < 0) return res.status(400).json({ error: 'limit must be a non-negative number' });
    setDailyLimit(limit);
    persistDataInBackground('daily cost limit');
    res.json({ ok: true, limit });
  });

  app.get('/api/ai/usage', (req, res) => {
    const workspaceId = (req.query.workspaceId as string) || 'default';
    const limit = Math.min(500, Number(req.query.limit) || 100);
    res.json({ usage: listUsage(workspaceId, limit) });
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
