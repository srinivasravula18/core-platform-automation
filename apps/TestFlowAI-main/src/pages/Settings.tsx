import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useTheme } from '@/src/store/theme';
import {
  Moon, Sun, CheckCircle, AlertCircle, Plus, Trash2, RefreshCw, Bot, Key,
  Globe, Users, Sparkles, MessageSquare, ChevronDown, ChevronUp, Send, Shield,
  Eye, EyeOff, Zap, RotateCcw, Save, BookOpen, Pencil, Check, X, Activity, Loader2,
} from 'lucide-react';
import { GoogleSheetsIntegration } from '../components/GoogleSheetsIntegration';

type Provider = 'gemini' | 'openai' | 'anthropic';

type ProviderInfo = {
  name: Provider;
  defaultModel: string;
  alternatives: string[];
  configured: boolean;
  model: string;
  apiKeyMasked: string;
};

type AgentPrompt = {
  agent: string;
  source: 'override' | 'default';
  version?: number;
  activeBody: string;
  defaultBody: string;
  versions: { id: string; version: number; isActive: boolean; createdAt: string; createdBy: string; notes: string; body: string }[];
};

type Website = {
  id: string;
  name: string;
  baseUrl: string;
  environment: 'dev' | 'staging' | 'prod' | 'local' | 'preview';
  description: string;
  tags: string[];
  createdAt: string;
};

type WebsiteUser = {
  id: string;
  websiteId: string;
  label: string;
  username: string;
  role: string;
  customRole?: string;
  notes: string;
  pageName?: string;
  pageUrl?: string;
  createdAt: string;
};

type SaveStatus = { type: 'success' | 'error' | 'idle'; message: string };

const PROVIDER_LABELS: Record<Provider, string> = {
  gemini: 'Google Gemini',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
};

const AGENT_LABELS: Record<string, { label: string; description: string }> = {
  chatAssistant: { label: 'Chat Assistant', description: 'Routes greetings, QA tasks, and names artifacts/runs.' },
  caseWriter: { label: 'Case Writer', description: 'Writes, reworks, expands cases, and covers code changes.' },
  testPlanner: { label: 'Test Planner', description: 'Drafts a structured test plan from a user request.' },
  suiteDesigner: { label: 'Suite & Folder Organizer', description: 'Groups cases into suites and organizes the repository.' },
  playwrightCoder: { label: 'Playwright Coder', description: 'Generates Playwright TypeScript scripts.' },
  appInspector: { label: 'Application Inspector', description: 'Drives a headless browser to inspect a flow.' },
  defectTriage: { label: 'Defect & Report Analyst', description: 'Triages defects and writes report narratives.' },
};

export default function Settings() {
  const { theme, setTheme } = useTheme();
  const [tab, setTab] = useState<'appearance' | 'providers' | 'prompts' | 'credentials' | 'cost'>('providers');

  return (
    <div className="mx-auto max-w-7xl space-y-6 px-1 sm:px-0">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
        <p className="mt-1 text-sm text-[var(--text-muted)]">AI providers, prompts, credentials, and cost. Set autonomy from the Agent Console chat.</p>
      </div>

      <div className="flex gap-1 overflow-x-auto rounded-lg border border-[var(--border)] bg-[var(--bg-card)] p-1 text-sm">
        {([
          ['providers', 'AI Providers', Bot],
          ['prompts', 'System Prompts', MessageSquare],
          ['credentials', 'Credentials', Globe],
          ['cost', 'Cost & Logs', Activity],
          ['appearance', 'Appearance', Sun],
        ] as const).map(([key, label, Icon]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`inline-flex flex-1 items-center justify-center gap-2 whitespace-nowrap rounded-md px-3 py-2 font-medium transition-colors ${
              tab === key ? 'bg-[var(--accent)] text-white' : 'text-[var(--text-muted)] hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)]'
            }`}
          >
            <Icon className="h-4 w-4" />
            <span className="hidden sm:inline">{label}</span>
          </button>
        ))}
      </div>

      {tab === 'appearance' && (
        <AppearanceSection theme={theme} setTheme={setTheme} />
      )}
      {tab === 'providers' && <ProvidersSection />}
      {tab === 'prompts' && <PromptsSection />}
      {tab === 'credentials' && <CredentialsSection />}
      {tab === 'cost' && <CostSection />}
    </div>
  );
}

function AppearanceSection({ theme, setTheme }: { theme: string; setTheme: (t: 'light' | 'dark') => void }) {
  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-6 shadow-sm">
        <h2 className="text-lg font-medium">Appearance</h2>
        <p className="mt-1 text-sm text-[var(--text-muted)]">Customize how TestFlowAI looks on your device.</p>
        <div className="mt-6 flex flex-wrap gap-4">
          <button
            onClick={() => setTheme('light')}
            className={`flex flex-col items-center gap-3 rounded-xl border-2 p-4 transition-all ${theme === 'light' ? 'border-[var(--accent)] bg-[var(--accent)]/5' : 'border-[var(--border)] hover:border-[var(--text-muted)]'}`}
          >
            <div className="rounded-full border border-slate-200 bg-white p-3 text-slate-800 shadow-sm">
              <Sun className="h-6 w-6 text-amber-500" />
            </div>
            <span className="text-sm font-medium">Light</span>
          </button>
          <button
            onClick={() => setTheme('dark')}
            className={`flex flex-col items-center gap-3 rounded-xl border-2 p-4 transition-all ${theme === 'dark' ? 'border-[var(--accent)] bg-[var(--accent)]/5' : 'border-[var(--border)] hover:border-[var(--text-muted)]'}`}
          >
            <div className="rounded-full border border-slate-700 bg-slate-900 p-3 text-slate-100 shadow-sm">
              <Moon className="h-6 w-6 text-blue-400" />
            </div>
            <span className="text-sm font-medium">Dark</span>
          </button>
        </div>
      </div>
      <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] shadow-sm">
        <GoogleSheetsIntegration />
      </div>
    </div>
  );
}

function ProvidersSection() {
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [defaultProvider, setDefaultProvider] = useState<Provider>('gemini');
  const [agentMap, setAgentMap] = useState<Record<string, Provider>>({});
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<SaveStatus>({ type: 'idle', message: '' });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/ai/providers');
      const data = await res.json();
      setProviders(data.providers || []);
      setDefaultProvider(data.defaultProvider || 'gemini');
      setAgentMap(data.agentProviderMap || {});
    } catch (e) {
      setStatus({ type: 'error', message: 'Failed to load providers' });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const saveKey = async (provider: Provider, apiKey: string) => {
    setStatus({ type: 'idle', message: '' });
    const res = await fetch(`/api/ai/providers/${provider}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey }),
    });
    if (res.ok) {
      setStatus({ type: 'success', message: `${PROVIDER_LABELS[provider]} key saved` });
      await load();
    } else {
      setStatus({ type: 'error', message: `Failed to save ${PROVIDER_LABELS[provider]} key` });
    }
  };

  const setModel = async (provider: Provider, model: string) => {
    const res = await fetch(`/api/ai/providers/${provider}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model }),
    });
    if (res.ok) await load();
  };

  const clearKey = async (provider: Provider) => {
    if (!confirm(`Remove the ${PROVIDER_LABELS[provider]} API key?`)) return;
    await fetch(`/api/ai/providers/${provider}/key`, { method: 'DELETE' });
    await load();
  };

  const test = async (provider: Provider) => {
    setStatus({ type: 'idle', message: '' });
    const res = await fetch(`/api/ai/providers/${provider}/test`, { method: 'POST' });
    const data = await res.json();
    if (data.ok) {
      setStatus({ type: 'success', message: `${PROVIDER_LABELS[provider]} connection OK (${data.model || 'default model'})` });
    } else {
      setStatus({ type: 'error', message: `${PROVIDER_LABELS[provider]}: ${data.error || 'unreachable'}` });
    }
  };

  const setDefault = async (provider: Provider, model: string) => {
    await fetch('/api/ai/default-provider', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider, model }),
    });
    await load();
  };

  const setAgentProvider = async (agent: string, provider: Provider) => {
    await fetch('/api/ai/agent-provider', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent, provider }),
    });
    await load();
  };

  if (loading) return <SkeletonCard />;

  return (
    <div className="space-y-6">
      <StatusBanner status={status} />

      <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-4 sm:p-6 shadow-sm">
        <h2 className="text-lg font-medium">AI Providers</h2>
        <p className="mt-1 text-sm text-[var(--text-muted)]">
          Add API keys for the providers you want to use. Test each before saving. Pick a default for new agents.
        </p>

        <div className="mt-6 space-y-4">
          {providers.map((p) => (
            <ProviderCard
              key={p.name}
              provider={p}
              onSaveKey={(apiKeyValue) => saveKey(p.name, apiKeyValue)}
              onSetModel={(m) => setModel(p.name, m)}
              onClearKey={() => clearKey(p.name)}
              onTest={() => test(p.name)}
              onSetDefault={(m) => setDefault(p.name, m)}
            />
          ))}
        </div>
      </div>

      <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-4 sm:p-6 shadow-sm">
        <h2 className="text-lg font-medium">Per-Agent Provider</h2>
        <p className="mt-1 text-sm text-[var(--text-muted)]">
          Route a specific agent (e.g. Playwright Coder) to a specific provider. Useful when one model is better at code than another.
        </p>
        <div className="mt-4 grid grid-cols-1 gap-2 md:grid-cols-2">
          {Object.keys(AGENT_LABELS).map((agent) => (
            <div key={agent} className="flex items-center justify-between gap-2 rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] p-3">
              <div>
                <div className="text-sm font-medium">{AGENT_LABELS[agent].label}</div>
                <div className="text-xs text-[var(--text-muted)]">{AGENT_LABELS[agent].description}</div>
              </div>
              <select
                value={agentMap[agent] || defaultProvider}
                onChange={(e) => setAgentProvider(agent, e.target.value as Provider)}
                className="rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 py-1 text-xs"
              >
                {providers.map((p) => (
                  <option key={p.name} value={p.name}>
                    {PROVIDER_LABELS[p.name]}
                  </option>
                ))}
              </select>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function ProviderCard({ provider, onSaveKey, onSetModel, onClearKey, onTest, onSetDefault }: React.PropsWithChildren<{
  provider: ProviderInfo;
  onSaveKey: (apiKeyValue: string) => void;
  onSetModel: (model: string) => void;
  onClearKey: () => void;
  onTest: () => void;
  onSetDefault: (model: string) => void;
}>) {
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);

  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] p-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-md bg-[var(--bg-primary)] text-[var(--accent)]">
          {provider.name === 'gemini' ? <Sparkles className="h-5 w-5" /> : provider.name === 'openai' ? <Bot className="h-5 w-5" /> : <Shield className="h-5 w-5" />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-medium">{PROVIDER_LABELS[provider.name]}</h3>
            {provider.configured ? (
              <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-500">
                <CheckCircle className="h-3 w-3" /> Configured
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-xs text-amber-500">
                <AlertCircle className="h-3 w-3" /> Not configured
              </span>
            )}
          </div>
          {provider.apiKeyMasked && <div className="text-xs text-[var(--text-muted)]">key: {provider.apiKeyMasked}</div>}
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={onTest}
            className="inline-flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-3 py-1.5 text-xs font-medium hover:border-[var(--accent)]"
          >
            <Activity className="h-3 w-3" /> Test
          </button>
          <button
            type="button"
            onClick={() => onSetDefault(provider.model)}
            className="inline-flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-3 py-1.5 text-xs font-medium hover:border-[var(--accent)]"
          >
            <Zap className="h-3 w-3" /> Set as default
          </button>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto]">
        <div className="flex gap-2">
          <input
            type={showKey ? 'text' : 'password'}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={provider.apiKeyMasked ? 'Replace API key' : 'Paste API key'}
            className="flex-1 rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
          />
          <button
            type="button"
            onClick={() => setShowKey((s) => !s)}
            className="inline-flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-3 py-2 text-xs hover:border-[var(--accent)]"
            title={showKey ? 'Hide' : 'Show'}
          >
            {showKey ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
          </button>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => {
              if (!apiKey) return;
              onSaveKey(apiKey);
              setApiKey('');
            }}
            disabled={!apiKey}
            className="inline-flex items-center gap-1 rounded-md bg-[var(--accent)] px-3 py-2 text-xs font-medium text-white hover:bg-[var(--accent-hover)] disabled:opacity-50"
          >
            <Save className="h-3 w-3" /> Save Key
          </button>
          {provider.apiKeyMasked && (
            <button
              type="button"
              onClick={onClearKey}
              className="inline-flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-3 py-2 text-xs text-red-500 hover:border-red-500"
            >
              <Trash2 className="h-3 w-3" /> Remove
            </button>
          )}
        </div>
      </div>

      <div className="mt-3">
        <label className="text-xs text-[var(--text-muted)]">Model</label>
        <div className="mt-1 flex flex-wrap gap-2">
          <select
            value={provider.model}
            onChange={(e) => onSetModel(e.target.value)}
            className="rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
          >
            {[provider.defaultModel, ...provider.alternatives].map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        </div>
      </div>
    </div>
  );
}

function PromptsSection() {
  const [prompts, setPrompts] = useState<AgentPrompt[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [editBody, setEditBody] = useState('');
  const [editNotes, setEditNotes] = useState('');
  const [status, setStatus] = useState<SaveStatus>({ type: 'idle', message: '' });
  const [testing, setTesting] = useState<string | null>(null);
  const [testInput, setTestInput] = useState('');
  const [testOutput, setTestOutput] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/ai/prompts');
      const data = await res.json();
      setPrompts(data.agents || []);
    } catch {
      setStatus({ type: 'error', message: 'Failed to load prompts' });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const startEdit = (p: AgentPrompt) => {
    setEditing(p.agent);
    setEditBody(p.activeBody);
    setEditNotes('');
  };

  const save = async (agent: string) => {
    setStatus({ type: 'idle', message: '' });
    const res = await fetch(`/api/ai/prompts/${agent}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: editBody, notes: editNotes, createdBy: 'admin' }),
    });
    if (res.ok) {
      setStatus({ type: 'success', message: `Saved new version of ${AGENT_LABELS[agent]?.label || agent}` });
      setEditing(null);
      await load();
    } else {
      setStatus({ type: 'error', message: 'Failed to save' });
    }
  };

  const reset = async (agent: string) => {
    if (!confirm(`Reset ${AGENT_LABELS[agent]?.label || agent} to the system default?`)) return;
    await fetch(`/api/ai/prompts/${agent}/reset`, { method: 'POST' });
    await load();
  };

  const activate = async (agent: string, versionId: string) => {
    await fetch(`/api/ai/prompts/${agent}/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ versionId }),
    });
    await load();
  };

  const runTest = async (agent: string) => {
    setTesting(agent);
    setTestOutput('');
    try {
      const taskTypeMap: Record<string, string> = {
        chatAssistant: 'case',
        caseWriter: 'case',
        testPlanner: 'plan',
        suiteDesigner: 'suite',
        playwrightCoder: 'case',
        appInspector: 'case',
        defectTriage: 'defect',
      };
      const res = await fetch('/api/agent/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskType: taskTypeMap[agent] || 'case', prompt: testInput || 'Generate a sample test case' }),
      });
      const data = await res.json();
      setTestOutput(JSON.stringify(data, null, 2));
    } catch (e: any) {
      setTestOutput(`Error: ${e.message}`);
    } finally {
      setTesting(null);
    }
  };

  if (loading) return <SkeletonCard />;

  return (
    <div className="space-y-6">
      <StatusBanner status={status} />
      <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-4 sm:p-6 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-lg font-medium">System Prompts</h2>
            <p className="mt-1 text-sm text-[var(--text-muted)]">
              Every AI agent is governed by a layered system prompt: identity, scope policy, safety, output format, and the agent's own instructions.
              Override any of them here. New versions are saved with the default as a fallback.
            </p>
          </div>
          <button onClick={load} className="inline-flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-1.5 text-xs hover:border-[var(--accent)]">
            <RefreshCw className="h-3 w-3" /> Reload
          </button>
        </div>

        <div className="mt-6 space-y-3">
          {prompts.map((p) => {
            const isExpanded = expanded === p.agent;
            const isEditing = editing === p.agent;
            const meta = AGENT_LABELS[p.agent] || { label: p.agent, description: '' };
            return (
              <div key={p.agent} className="rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)]">
                <button
                  onClick={() => setExpanded(isExpanded ? null : p.agent)}
                  className="flex w-full items-center justify-between gap-3 p-4 text-left"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{meta.label}</span>
                      {p.source === 'override' ? (
                        <span className="inline-flex items-center gap-1 rounded-full border border-indigo-500/30 bg-indigo-500/10 px-2 py-0.5 text-xs text-indigo-500">
                          <Pencil className="h-3 w-3" /> Override v{p.version}
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 rounded-full border border-[var(--border)] bg-[var(--bg-primary)] px-2 py-0.5 text-xs text-[var(--text-muted)]">
                          <BookOpen className="h-3 w-3" /> Default
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-[var(--text-muted)]">{meta.description}</div>
                  </div>
                  {isExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                </button>
                {isExpanded && (
                  <div className="space-y-3 border-t border-[var(--border)] p-4">
                    {isEditing ? (
                      <div className="space-y-2">
                        <textarea
                          value={editBody}
                          onChange={(e) => setEditBody(e.target.value)}
                          rows={12}
                          className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-primary)] p-3 font-mono text-xs"
                        />
                        <input
                          type="text"
                          value={editNotes}
                          onChange={(e) => setEditNotes(e.target.value)}
                          placeholder="Notes (e.g. 'CFO asked for tighter security scope')"
                          className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-primary)] p-2 text-xs"
                        />
                        <div className="flex flex-wrap gap-2">
                          <button onClick={() => save(p.agent)} className="inline-flex items-center gap-1 rounded-md bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-white hover:bg-[var(--accent-hover)]">
                            <Save className="h-3 w-3" /> Save & Activate
                          </button>
                          <button onClick={() => setEditing(null)} className="inline-flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-3 py-1.5 text-xs hover:border-[var(--accent)]">
                            <X className="h-3 w-3" /> Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="space-y-3">
                        <div>
                          <div className="mb-1 text-xs font-medium text-[var(--text-muted)]">Active prompt</div>
                          <pre className="max-h-64 overflow-auto rounded-md border border-[var(--border)] bg-[var(--bg-primary)] p-3 text-xs whitespace-pre-wrap">{p.activeBody}</pre>
                        </div>
                        {p.versions.length > 1 && (
                          <div>
                            <div className="mb-1 text-xs font-medium text-[var(--text-muted)]">Version history</div>
                            <div className="space-y-1">
                              {p.versions.map((v) => (
                                <div key={v.id} className="flex items-center justify-between gap-2 rounded border border-[var(--border)] bg-[var(--bg-primary)] p-2 text-xs">
                                  <div>
                                    <span className="font-medium">v{v.version}</span>
                                    {v.isActive && <span className="ml-2 text-emerald-500">active</span>}
                                    <span className="ml-2 text-[var(--text-muted)]">{v.notes || '(no notes)'}</span>
                                  </div>
                                  {!v.isActive && (
                                    <button onClick={() => activate(p.agent, v.id)} className="text-xs text-[var(--accent)] hover:underline">
                                      Activate
                                    </button>
                                  )}
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                        <div>
                          <div className="mb-1 text-xs font-medium text-[var(--text-muted)]">Test this agent</div>
                          <div className="flex flex-col gap-2 sm:flex-row">
                            <input
                              type="text"
                              value={testInput}
                              onChange={(e) => setTestInput(e.target.value)}
                              placeholder="Try a prompt (e.g. 'login flow at https://example.com')"
                              className="flex-1 rounded-md border border-[var(--border)] bg-[var(--bg-primary)] p-2 text-sm"
                            />
                            <button
                              onClick={() => runTest(p.agent)}
                              disabled={testing === p.agent}
                              className="inline-flex items-center gap-1 rounded-md bg-[var(--accent)] px-3 py-2 text-xs font-medium text-white hover:bg-[var(--accent-hover)] disabled:opacity-50"
                            >
                              {testing === p.agent ? <RefreshCw className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}
                              Test
                            </button>
                          </div>
                          {testOutput && (
                            <pre className="mt-2 max-h-64 overflow-auto rounded-md border border-[var(--border)] bg-[var(--bg-primary)] p-3 text-xs">{testOutput}</pre>
                          )}
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <button onClick={() => startEdit(p)} className="inline-flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-3 py-1.5 text-xs hover:border-[var(--accent)]">
                            <Pencil className="h-3 w-3" /> Edit prompt
                          </button>
                          {p.source === 'override' && (
                            <button onClick={() => reset(p.agent)} className="inline-flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-3 py-1.5 text-xs hover:border-[var(--accent)]">
                              <RotateCcw className="h-3 w-3" /> Reset to default
                            </button>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

type CredRow = {
  key: string;
  websiteId?: string;
  userId?: string;
  name: string;
  url: string;
  username: string;
  password: string;
  useForPlaywright: boolean;
  saving?: boolean;
};

function CredentialsSection() {
  const [rows, setRows] = useState<CredRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<SaveStatus>({ type: 'idle', message: '' });
  const keyRef = useRef(0);
  const newKey = () => `row-${keyRef.current++}`;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/credentials/websites');
      const data = await res.json();
      const sites: Website[] = data.websites || [];
      const built = await Promise.all(
        sites.map(async (w) => {
          let user: any = null;
          try {
            const ur = await fetch(`/api/credentials/websites/${w.id}/users`);
            const ud = await ur.json();
            user = (ud.users || [])[0] || null;
          } catch {
            /* ignore */
          }
          return {
            key: newKey(),
            websiteId: w.id,
            userId: user?.id,
            name: w.name,
            url: w.baseUrl,
            username: user?.username || '',
            password: '',
            useForPlaywright: user ? !String(user.notes || '').includes('no-playwright') : true,
          } as CredRow;
        }),
      );
      setRows(built);
    } catch {
      setStatus({ type: 'error', message: 'Failed to load credentials' });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const patch = (key: string, p: Partial<CredRow>) =>
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...p } : r)));

  const addRow = () =>
    setRows((prev) => [
      ...prev,
      { key: newKey(), name: '', url: '', username: '', password: '', useForPlaywright: true },
    ]);

  const saveRow = async (key: string) => {
    const r = rows.find((x) => x.key === key);
    if (!r || r.saving) return;
    if (!r.name || !r.url) return; // need at least a name + URL to persist
    setRows((prev) => prev.map((x) => (x.key === key ? { ...x, saving: true } : x)));
    try {
      let websiteId = r.websiteId;
      if (websiteId) {
        await fetch(`/api/credentials/websites/${websiteId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: r.name, baseUrl: r.url }),
        });
      } else {
        const res = await fetch('/api/credentials/websites', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: r.name, baseUrl: r.url, environment: 'staging' }),
        });
        const d = await res.json().catch(() => ({}));
        websiteId = d?.website?.id;
      }
      if (!websiteId) throw new Error('no website id');

      const notes = r.useForPlaywright ? '' : 'no-playwright';
      let userId = r.userId;
      if (userId) {
        const body: any = { username: r.username, notes };
        if (r.password) body.password = r.password; // blank = keep existing
        await fetch(`/api/credentials/users/${userId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      } else if (r.username && r.password) {
        const res = await fetch(`/api/credentials/websites/${websiteId}/users`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ label: r.name || r.username, username: r.username, password: r.password, role: 'standard', notes }),
        });
        const d = await res.json().catch(() => ({}));
        userId = d?.user?.id;
      }

      setRows((prev) => prev.map((x) => (x.key === key ? { ...x, websiteId, userId, password: '', saving: false } : x)));
      setStatus({ type: 'success', message: 'Saved' });
    } catch {
      setRows((prev) => prev.map((x) => (x.key === key ? { ...x, saving: false } : x)));
      setStatus({ type: 'error', message: 'Failed to save credential' });
    }
  };

  const deleteRow = async (key: string) => {
    const r = rows.find((x) => x.key === key);
    if (!r) return;
    if (r.websiteId) {
      if (!confirm('Delete this website credential?')) return;
      await fetch(`/api/credentials/websites/${r.websiteId}`, { method: 'DELETE' });
    }
    setRows((prev) => prev.filter((x) => x.key !== key));
  };

  if (loading) return <SkeletonCard />;

  return (
    <div className="space-y-6">
      <StatusBanner status={status} />

      <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-4 sm:p-6 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h2 className="text-lg font-medium">Website Credentials</h2>
            <p className="mt-1 text-sm text-[var(--text-muted)]">
              Save login credentials per website. Mention the website name in chat, or it is matched by URL for Playwright.
            </p>
          </div>
          <button
            onClick={addRow}
            className="inline-flex items-center gap-1 rounded-md bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-white hover:bg-[var(--accent-hover)]"
          >
            <Plus className="h-4 w-4" /> Add Website
          </button>
        </div>

        <div className="mt-4 space-y-2">
          {rows.length === 0 && (
            <div className="rounded-lg border border-dashed border-[var(--border)] bg-[var(--bg-secondary)] p-6 text-center text-sm text-[var(--text-muted)]">
              No credentials yet. Click &ldquo;Add Website&rdquo; to store a login.
            </div>
          )}

          {rows.length > 0 && (
            <div className="hidden grid-cols-[1.2fr_1.5fr_1.2fr_1.2fr_auto_auto] gap-2 px-1 text-xs font-medium text-[var(--text-muted)] lg:grid">
              <div>Website Name</div>
              <div>Website URL</div>
              <div>Username / Email</div>
              <div>Password</div>
              <div>Playwright</div>
              <div />
            </div>
          )}

          {rows.map((r) => (
            <div
              key={r.key}
              className="grid grid-cols-1 items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] p-2 lg:grid-cols-[1.2fr_1.5fr_1.2fr_1.2fr_auto_auto]"
            >
              <input value={r.name} onChange={(e) => patch(r.key, { name: e.target.value })} onBlur={() => saveRow(r.key)} placeholder="Website name" className="rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 py-1.5 text-sm outline-none focus:border-[var(--accent)]" />
              <input value={r.url} onChange={(e) => patch(r.key, { url: e.target.value })} onBlur={() => saveRow(r.key)} placeholder="https://app.example.com" className="rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 py-1.5 text-sm outline-none focus:border-[var(--accent)]" />
              <input value={r.username} onChange={(e) => patch(r.key, { username: e.target.value })} onBlur={() => saveRow(r.key)} placeholder="Username / email" className="rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 py-1.5 text-sm outline-none focus:border-[var(--accent)]" />
              <input type="password" value={r.password} onChange={(e) => patch(r.key, { password: e.target.value })} onBlur={() => saveRow(r.key)} placeholder={r.userId ? 'unchanged' : 'Password'} className="rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 py-1.5 text-sm outline-none focus:border-[var(--accent)]" />
              <label className="flex items-center justify-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 py-1.5 text-xs text-[var(--text-muted)]">
                <input type="checkbox" checked={r.useForPlaywright} onChange={(e) => { patch(r.key, { useForPlaywright: e.target.checked }); setTimeout(() => saveRow(r.key), 0); }} className="accent-[var(--accent)]" />
                <span className="hidden sm:inline">Use for Playwright</span>
              </label>
              <div className="flex items-center justify-center">
                {r.saving ? (
                  <Loader2 className="h-4 w-4 animate-spin text-[var(--accent)]" />
                ) : (
                  <button onClick={() => deleteRow(r.key)} title="Delete" className="rounded-md border border-[var(--border)] bg-[var(--bg-primary)] p-2 text-[var(--text-muted)] hover:border-red-500 hover:text-red-500">
                    <Trash2 className="h-4 w-4" />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function AutonomySection() {
  const [autonomy, setAutonomy] = useState<'autonomous' | 'review' | 'manual'>('review');
  const [status, setStatus] = useState<SaveStatus>({ type: 'idle', message: '' });

  useEffect(() => {
    fetch('/api/ai/cost')
      .then((r) => r.json())
      .then((data) => {
        if (data?.autonomyLevel) setAutonomy(data.autonomyLevel);
      })
      .catch(() => undefined);
  }, []);

  const save = async (level: typeof autonomy) => {
    setAutonomy(level);
    setStatus({ type: 'idle', message: '' });
    const res = await fetch('/api/settings/autonomy', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ level }),
    });
    if (res.ok) setStatus({ type: 'success', message: 'Autonomy level saved' });
  };

  return (
    <div className="space-y-6">
      <StatusBanner status={status} />
      <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-4 sm:p-6 shadow-sm">
        <h2 className="text-lg font-medium">Autonomy Level</h2>
        <p className="mt-1 text-sm text-[var(--text-muted)]">
          How much should the AI do on its own before asking you?
        </p>
        <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-3">
          {([
            { value: 'manual', label: 'Manual', desc: 'AI proposes; I approve every step.', icon: <Eye className="h-5 w-5" /> },
            { value: 'review', label: 'Review (Recommended)', desc: 'AI runs BVT and obvious cases; I approve the rest.', icon: <Shield className="h-5 w-5" /> },
            { value: 'autonomous', label: 'Autonomous', desc: 'AI runs everything; only blocks on critical failures.', icon: <Zap className="h-5 w-5" /> },
          ] as const).map((opt) => (
            <button
              key={opt.value}
              onClick={() => save(opt.value)}
              className={`flex flex-col items-start gap-2 rounded-lg border-2 p-4 text-left transition-all ${
                autonomy === opt.value ? 'border-[var(--accent)] bg-[var(--accent)]/5' : 'border-[var(--border)] hover:border-[var(--text-muted)]'
              }`}
            >
              <div className="text-[var(--accent)]">{opt.icon}</div>
              <div className="font-medium">{opt.label}</div>
              <div className="text-xs text-[var(--text-muted)]">{opt.desc}</div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function CostSection() {
  const [cost, setCost] = useState<{ used: number; limit: number; guardrailLogs: any[] }>({ used: 0, limit: 50, guardrailLogs: [] });
  const [usage, setUsage] = useState<any[]>([]);
  const [limit, setLimit] = useState(50);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [c, u] = await Promise.all([
        fetch('/api/ai/cost').then((r) => r.json()),
        fetch('/api/ai/usage').then((r) => r.json()),
      ]);
      setCost(c);
      setUsage(u.usage || []);
      setLimit(c.limit || 50);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const saveLimit = async () => {
    await fetch('/api/ai/cost/limit', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ limit }),
    });
    await load();
  };

  if (loading) return <SkeletonCard />;

  const usedPct = cost.limit > 0 ? Math.min(100, (cost.used / cost.limit) * 100) : 0;

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-4 sm:p-6 shadow-sm">
        <h2 className="text-lg font-medium">Daily AI Cost</h2>
        <p className="mt-1 text-sm text-[var(--text-muted)]">Track what TestFlowAI spends on AI providers and set a hard cap.</p>
        <div className="mt-4">
          <div className="flex items-baseline gap-2">
            <span className="text-3xl font-bold">${cost.used.toFixed(4)}</span>
            <span className="text-sm text-[var(--text-muted)]">/ ${cost.limit.toFixed(2)} today</span>
          </div>
          <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-[var(--bg-secondary)]">
            <div
              className={`h-full transition-all ${usedPct > 90 ? 'bg-red-500' : usedPct > 60 ? 'bg-amber-500' : 'bg-emerald-500'}`}
              style={{ width: `${usedPct}%` }}
            />
          </div>
        </div>
        <div className="mt-4 flex flex-wrap items-end gap-2">
          <div>
            <label className="mb-1 block text-xs text-[var(--text-muted)]">Daily limit (USD)</label>
            <input
              type="number"
              min="0"
              step="1"
              value={limit}
              onChange={(e) => setLimit(Number(e.target.value))}
              className="w-32 rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-3 py-2 text-sm"
            />
          </div>
          <button onClick={saveLimit} className="inline-flex items-center gap-1 rounded-md bg-[var(--accent)] px-3 py-2 text-xs font-medium text-white">
            <Save className="h-3 w-3" /> Save limit
          </button>
        </div>
      </div>

      <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-4 sm:p-6 shadow-sm">
        <h2 className="text-lg font-medium">Recent Usage</h2>
        <div className="mt-3 max-h-96 overflow-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-[var(--bg-card)] text-xs text-[var(--text-muted)]">
              <tr>
                <th className="px-2 py-1 text-left">When</th>
                <th className="px-2 py-1 text-left">Agent</th>
                <th className="px-2 py-1 text-left">Provider</th>
                <th className="px-2 py-1 text-left">Model</th>
                <th className="px-2 py-1 text-right">Tokens</th>
                <th className="px-2 py-1 text-right">Cost</th>
              </tr>
            </thead>
            <tbody>
              {usage.length === 0 && (
                <tr><td colSpan={6} className="px-2 py-4 text-center text-xs text-[var(--text-muted)]">No usage recorded yet.</td></tr>
              )}
              {usage.map((u) => (
                <tr key={u.id} className="border-t border-[var(--border)]">
                  <td className="px-2 py-1 text-xs">{new Date(u.createdAt).toLocaleString()}</td>
                  <td className="px-2 py-1 text-xs">{u.agent}</td>
                  <td className="px-2 py-1 text-xs">{u.provider}</td>
                  <td className="px-2 py-1 text-xs">{u.model}</td>
                  <td className="px-2 py-1 text-right text-xs">{(u.inputTokens || 0) + (u.outputTokens || 0)}</td>
                  <td className="px-2 py-1 text-right text-xs">${(u.costUsd || 0).toFixed(4)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-4 sm:p-6 shadow-sm">
        <h2 className="text-lg font-medium">Guardrail Activity</h2>
        <p className="mt-1 text-sm text-[var(--text-muted)]">Every short-circuit (greeting, off-topic, injection) is logged here.</p>
        <div className="mt-3 max-h-64 space-y-1 overflow-auto">
          {cost.guardrailLogs.length === 0 && (
            <div className="rounded border border-dashed border-[var(--border)] p-3 text-center text-xs text-[var(--text-muted)]">No activity yet.</div>
          )}
          {cost.guardrailLogs.slice().reverse().map((l, i) => (
            <div key={i} className="rounded border border-[var(--border)] bg-[var(--bg-primary)] p-2 text-xs">
              <div className="flex items-center gap-2">
                <span className={`inline-block h-2 w-2 rounded-full ${l.decision === 'short-circuit' ? 'bg-amber-500' : l.decision === 'sanitize' ? 'bg-indigo-500' : 'bg-emerald-500'}`} />
                <span className="font-medium">{l.agent}</span>
                <span className="text-[var(--text-muted)]">{l.layer}</span>
                <span className="text-[var(--text-muted)]">·</span>
                <span className="text-[var(--text-muted)]">{l.reason}</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function StatusBanner({ status }: { status: SaveStatus }) {
  if (status.type === 'idle' || !status.message) return null;
  return (
    <div
      className={`flex items-center gap-2 rounded-md border p-3 text-sm ${
        status.type === 'success' ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-500' : 'border-red-500/20 bg-red-500/10 text-red-500'
      }`}
    >
      {status.type === 'success' ? <CheckCircle className="h-4 w-4 shrink-0" /> : <AlertCircle className="h-4 w-4 shrink-0" />}
      <span>{status.message}</span>
    </div>
  );
}

function SkeletonCard() {
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-6 shadow-sm">
      <div className="h-4 w-32 animate-pulse rounded bg-[var(--bg-secondary)]" />
      <div className="mt-3 h-3 w-64 animate-pulse rounded bg-[var(--bg-secondary)]" />
      <div className="mt-6 h-24 animate-pulse rounded bg-[var(--bg-secondary)]" />
    </div>
  );
}
