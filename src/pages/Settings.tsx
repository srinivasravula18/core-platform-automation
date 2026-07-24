import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useTheme } from '@/src/store/theme';
import { useUiSettings } from '@/src/store/uiSettings';
import {
  Moon, Sun, CheckCircle, AlertCircle, Plus, Trash2, RefreshCw, Bot, Key,
  Globe, Users, Sparkles, MessageSquare, ChevronDown, ChevronUp, Send, Shield,
  Eye, EyeOff, Zap, RotateCcw, Save, BookOpen, Pencil, Check, X, Activity, Loader2, FolderTree,
} from 'lucide-react';
import { GoogleSheetsIntegration } from '../components/GoogleSheetsIntegration';
import { isAdmin } from '../components/AuthGate';
import { showConfirm } from '@/src/lib/dialog';

type Provider = 'gemini' | 'openai' | 'anthropic';

type ProviderInfo = {
  name: Provider;
  defaultModel: string;
  alternatives: string[];
  enabled: boolean;
  configured: boolean;
  callable: boolean;
  model: string;
  authMode: 'api_key' | 'account';
  accountTool: string;
  accountCliAllowed: boolean;
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
  featureAnalyst: { label: 'Feature Analyst', description: 'Analyzes one source-grounded feature and its business rules.' },
  featureDiscoveryAgent: { label: 'Feature Discovery', description: 'Maps source-grounded features and subfeatures across the app.' },
  e2eFlowAgent: { label: 'E2E Flow Mapper', description: 'Finds cross-feature source-grounded end-to-end journeys.' },
};

export default function Settings() {
  const { theme, setTheme } = useTheme();
  const [tab, setTab] = useState<'appearance' | 'providers' | 'prompts' | 'credentials' | 'cost' | 'data' | 'profiles' | 'deployment'>('providers');
  const admin = isAdmin();

  const tabs: Array<[typeof tab, string, any]> = [
    ['providers', 'AI Providers', Bot],
    ['prompts', 'System Prompts', MessageSquare],
    ['credentials', 'Credentials', Globe],
    ['cost', 'Cost & Logs', Activity],
    ...(admin ? [['data', 'Data', Trash2] as [typeof tab, string, any]] : []),
    // Admin-only: create/manage the people who can log in and use the app.
    ...(admin ? [['profiles', 'Profiles', Users] as [typeof tab, string, any]] : []),
    // Admin-only: where repos live on THIS server (so a deployed instance finds the right folders).
    ...(admin ? [['deployment', 'Deployment', FolderTree] as [typeof tab, string, any]] : []),
    ['appearance', 'Appearance', Sun],
  ];

  return (
    <div className="app-page-shell space-y-6 px-1 sm:px-0">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
        <p className="mt-1 text-sm text-[var(--text-muted)]">AI providers, prompts, credentials, and cost. Set autonomy from the Agent Console chat.</p>
      </div>

      <div className="flex gap-1 overflow-x-auto rounded-lg border border-[var(--border)] bg-[var(--bg-card)] p-1 text-sm">
        {tabs.map(([key, label, Icon]) => (
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
      {tab === 'data' && admin && <DataSection />}
      {tab === 'profiles' && admin && <ProfilesSection />}
      {tab === 'deployment' && admin && <DeploymentSection />}
    </div>
  );
}

function DataSection() {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<SaveStatus>({ type: 'idle', message: '' });

  const clearArtifacts = async () => {
    if (!await showConfirm("Delete all QA artifacts and this signed-in user's chat history? Other users' chat history and all automation data and uploads will be kept.", { tone: 'danger' })) return;
    setBusy(true);
    setStatus({ type: 'idle', message: '' });
    try {
      const res = await fetch('/api/settings/artifacts', { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || 'Failed to delete artifacts');
      const total = Object.values(data.removed || {}).reduce((sum: number, value: any) => sum + Number(value || 0), 0);
      Object.keys(localStorage)
        .filter((key) => key.startsWith('tfa_active_conversation::'))
        .forEach((key) => localStorage.removeItem(key));
      setStatus({ type: 'success', message: `Deleted ${total} stored record${total === 1 ? '' : 's'}, including your chat history. Other users' chats and automation data were kept.` });
    } catch (error: any) {
      setStatus({ type: 'error', message: error?.message || 'Failed to delete artifacts' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <StatusBanner status={status} />
      <div className="rounded-xl border border-red-500/40 bg-[var(--bg-card)] p-4 shadow-sm sm:p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h2 className="text-lg font-medium text-red-400">Delete Stored Artifacts</h2>
            <p className="mt-1 max-w-2xl text-sm text-[var(--text-muted)]">
              Clears folders, plans, suites, test cases, runs, scripts, reports, requirements, links, defects, agent runs, selector blackboards, and the signed-in user's chat history. Other users' chat history, run memory, automation agents, recordings, jobs, schedules, uploaded automation artifacts, settings, credentials, users, projects, and apps are kept.
            </p>
          </div>
          <button
            onClick={clearArtifacts}
            disabled={busy}
            className="inline-flex items-center justify-center gap-2 rounded-md border border-red-500 bg-red-500/10 px-3 py-2 text-sm font-medium text-red-300 hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
            Delete artifacts
          </button>
        </div>
      </div>
    </div>
  );
}

interface AppUserRow {
  id: string;
  username: string;
  name: string;
  role: 'admin' | 'tester';
  createdAt: string;
}

/**
 * Admin-only: create login profiles (name + login id + password). Each new profile
 * is a tester who can immediately sign in and gets their own isolated, empty workspace.
 */
function ProfilesSection() {
  const [users, setUsers] = useState<AppUserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<SaveStatus>({ type: 'idle', message: '' });

  const load = useCallback(() => {
    setLoading(true);
    fetch('/api/users')
      .then((r) => r.json())
      .then((d) => setUsers(Array.isArray(d.users) ? d.users : []))
      .catch(() => setUsers([]))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => { load(); }, [load]);

  const create = async () => {
    const n = name.trim();
    const u = username.trim();
    if (!n || !u || !password) {
      setStatus({ type: 'error', message: 'Name, login ID, and password are all required.' });
      return;
    }
    setBusy(true);
    setStatus({ type: 'idle', message: '' });
    try {
      const res = await fetch('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // role defaults to tester: the new person signs in and gets their own empty workspace.
        body: JSON.stringify({ name: n, username: u, password, role: 'tester' }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setStatus({ type: 'error', message: data?.error || 'Could not create the profile.' });
        return;
      }
      setStatus({ type: 'success', message: `Profile "${u}" created — they can sign in now with their login ID and password.` });
      setName(''); setUsername(''); setPassword('');
      load();
    } finally {
      setBusy(false);
    }
  };

  const remove = async (user: AppUserRow) => {
    if (!await showConfirm(`Delete profile "${user.username}"? Their data becomes inaccessible.`, { tone: 'danger' })) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/users/${user.id}`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) setStatus({ type: 'error', message: data?.error || 'Could not delete the profile.' });
      else load();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-6 shadow-sm">
        <h2 className="flex items-center gap-2 text-lg font-medium"><Users className="h-5 w-5 text-[var(--accent)]" /> Profiles</h2>
        <p className="mt-1 text-sm text-[var(--text-muted)]">
          Create a login profile for a teammate. Give a name, a login ID, and a password — they can sign in immediately and start
          with their own private, empty workspace. Each profile only sees their own data.
        </p>
      </div>

      {/* Create form */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-5 shadow-sm">
        <h3 className="mb-3 font-medium text-[var(--text-primary)]">New profile</h3>
        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <label className="mb-1.5 block text-xs font-medium text-[var(--text-muted)]">Name</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Jane Doe"
              className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-[var(--text-muted)]">Login ID</label>
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="jane"
              autoComplete="off"
              className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-[var(--text-muted)]">Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              autoComplete="new-password"
              className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
            />
          </div>
        </div>
        <div className="mt-3 flex items-center gap-3">
          <button
            onClick={create}
            disabled={busy}
            className="inline-flex items-center gap-2 rounded-md bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-60"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            Create profile
          </button>
          {status.type !== 'idle' && (
            <span className={`text-xs ${status.type === 'success' ? 'text-emerald-500' : 'text-red-500'}`}>{status.message}</span>
          )}
        </div>
      </div>

      {/* Existing profiles */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-5 shadow-sm">
        <h3 className="mb-3 font-medium text-[var(--text-primary)]">Existing profiles</h3>
        {loading ? (
          <p className="text-sm text-[var(--text-muted)]">Loading…</p>
        ) : users.length === 0 ? (
          <p className="text-sm text-[var(--text-muted)]">No profiles yet.</p>
        ) : (
          <div className="space-y-1.5">
            {users.map((u) => (
              <div key={u.id} className="flex items-center gap-3 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-sm">
                <span className="font-medium text-[var(--text-primary)]">{u.name}</span>
                <span className="text-[var(--text-muted)]">@{u.username}</span>
                <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${u.role === 'admin' ? 'bg-[var(--accent)]/15 text-[var(--accent)]' : 'bg-[var(--bg-card)] text-[var(--text-muted)]'}`}>
                  {u.role}
                </span>
                <button
                  onClick={() => remove(u)}
                  disabled={busy || u.role === 'admin'}
                  title={u.role === 'admin' ? 'Admin profiles cannot be removed here' : 'Delete profile'}
                  className="ml-auto rounded p-1.5 text-[var(--text-muted)] hover:text-red-500 disabled:opacity-30"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function DeploymentSection() {
  const [root, setRoot] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [status, setStatus] = useState<SaveStatus>({ type: 'idle', message: '' });

  useEffect(() => {
    fetch('/api/settings')
      .then((r) => r.json())
      .then((s) => setRoot(String(s?.serverRepoRoot || '')))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const save = async () => {
    setBusy(true);
    setStatus({ type: 'idle', message: '' });
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serverRepoRoot: root.trim() }),
      });
      if (!res.ok) throw new Error('Save failed');
      setStatus({ type: 'success', message: 'Server repository root saved.' });
    } catch (e: any) {
      setStatus({ type: 'error', message: e?.message || 'Could not save.' });
    } finally {
      setBusy(false);
    }
  };

  // Verify the folder exists on THIS server and report how many files it holds — so you can confirm
  // the deployed instance can actually read your code, entirely from the UI.
  const verify = async () => {
    setVerifying(true);
    setVerifyResult(null);
    try {
      const res = await fetch('/api/settings/verify-repo-root', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: root.trim() }),
      });
      const data = await res.json();
      if (data?.ok) {
        setVerifyResult({ ok: true, message: `Verified — ${Number(data.fileCount).toLocaleString()} file${data.fileCount === 1 ? '' : 's'} found${data.truncated ? '+ (stopped counting at the cap)' : ''}.` });
      } else {
        setVerifyResult({ ok: false, message: data?.reason || 'Could not verify the folder.' });
      }
    } catch {
      setVerifyResult({ ok: false, message: 'Verification request failed.' });
    } finally {
      setVerifying(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-6 shadow-sm">
        <h2 className="text-lg font-medium">Server repository root</h2>
        <p className="mt-1 text-sm text-[var(--text-muted)]">
          The folder on this server that holds your project repositories. A project keeps the path it
          was created with, which usually doesn't exist on the deployed server. Set that base folder
          here and the agent finds each project's repo under it — matched by folder name, then by
          project slug. Leave blank to use each project's stored path as-is.
        </p>
        <div className="mt-4 flex flex-col gap-2 sm:flex-row">
          <input
            value={root}
            onChange={(e) => setRoot(e.target.value)}
            placeholder="/srv/repos  or  /home/deploy/projects"
            disabled={loading}
            className="min-w-0 flex-1 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
          />
          <button
            onClick={verify}
            disabled={verifying || loading || !root.trim()}
            title="Check the folder exists on this server and count its files"
            className="inline-flex items-center justify-center gap-2 rounded-md border border-[var(--border)] bg-[var(--bg-card)] px-4 py-2 text-sm font-medium text-[var(--text-primary)] hover:border-[var(--accent)] disabled:opacity-50"
          >
            {verifying ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle className="h-4 w-4" />} Verify
          </button>
          <button
            onClick={save}
            disabled={busy || loading}
            className="inline-flex items-center justify-center gap-2 rounded-md bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--accent-hover)] disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Save
          </button>
        </div>
        {verifyResult && (
          <div className={`mt-3 flex items-center gap-2 rounded-md border px-3 py-2 text-sm ${verifyResult.ok ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400' : 'border-red-500/30 bg-red-500/10 text-red-400'}`}>
            {verifyResult.ok ? <CheckCircle className="h-4 w-4 shrink-0" /> : <AlertCircle className="h-4 w-4 shrink-0" />}
            <span>{verifyResult.message}</span>
          </div>
        )}
        <p className="mt-3 text-xs text-[var(--text-muted)]">
          Example: with the root set to <code>/home/ubuntu/projects</code>, a project's repo folder is
          found at <code>/home/ubuntu/projects/&lt;repo-folder&gt;</code> when its stored path isn't present.
        </p>
        <div className="mt-3"><StatusBanner status={status} /></div>
      </div>
    </div>
  );
}

function AppearanceSection({ theme, setTheme }: { theme: string; setTheme: (t: 'light' | 'dark') => void }) {
  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-6 shadow-sm">
        <h2 className="text-lg font-medium">Appearance</h2>
        <p className="mt-1 text-sm text-[var(--text-muted)]">Customize how Test Flow AI looks on your device.</p>
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

  // All mutations update local state optimistically and DON'T refetch the whole list,
  // so changing a model/provider/toggle never flashes or "refreshes" the page. We only
  // re-sync from the server (load) if a request actually fails.
  const saveKey = async (provider: Provider, apiKey: string) => {
    setStatus({ type: 'idle', message: '' });
    const masked = apiKey.length <= 8 ? '****' : `${apiKey.slice(0, 4)}****${apiKey.slice(-4)}`;
    setProviders((prev) => prev.map((p) => (
      p.name === provider
        ? { ...p, apiKeyMasked: masked, configured: p.authMode === 'account' ? p.configured : true, callable: (p.authMode === 'account' ? p.configured : true) && p.enabled }
        : p
    )));
    const res = await fetch(`/api/ai/providers/${provider}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey }),
    });
    if (res.ok) {
      setStatus({ type: 'success', message: `${PROVIDER_LABELS[provider]} key saved` });
    } else {
      setStatus({ type: 'error', message: `Failed to save ${PROVIDER_LABELS[provider]} key` });
      load();
    }
  };

  const setAuthMode = async (provider: Provider, authMode: ProviderInfo['authMode']) => {
    setStatus({ type: 'idle', message: '' });
    const current = providers.find((p) => p.name === provider);
    if (authMode === 'account' && current && !current.accountCliAllowed) {
      setStatus({ type: 'error', message: 'Subscription/account CLI auth is local-only. Use API key mode in test and production.' });
      return;
    }
    setProviders((prev) => prev.map((p) => (
      p.name === provider
        ? {
            ...p,
            authMode,
            configured: authMode === 'api_key' ? !!p.apiKeyMasked : p.accountCliAllowed && (provider === 'openai' || provider === 'anthropic'),
            callable: authMode === 'api_key' ? !!p.apiKeyMasked && p.enabled : p.enabled && p.accountCliAllowed && (provider === 'openai' || provider === 'anthropic'),
            accountTool: authMode === 'account' && provider === 'openai' ? 'codex' : authMode === 'account' && provider === 'anthropic' ? 'claude' : '',
          }
        : p
    )));
    const res = await fetch(`/api/ai/providers/${provider}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ authMode }),
    });
    if (res.ok) {
      setStatus({
        type: 'success',
        message: authMode === 'api_key'
          ? `${PROVIDER_LABELS[provider]} will use API key billing`
          : `${PROVIDER_LABELS[provider]} saved as subscription/account auth`,
      });
    } else {
      setStatus({ type: 'error', message: `Failed to save ${PROVIDER_LABELS[provider]} auth mode` });
      load();
    }
  };

  const setEnabled = async (provider: Provider, enabled: boolean) => {
    setStatus({ type: 'idle', message: '' });
    setProviders((prev) => prev.map((p) => (p.name === provider ? { ...p, enabled, callable: enabled && p.configured } : p)));
    if (enabled && providers.find((p) => p.name === provider)?.configured && !providers.find((p) => p.name === defaultProvider)?.callable) {
      setDefaultProvider(provider);
    }
    const res = await fetch(`/api/ai/providers/${provider}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    if (res.ok) {
      setStatus({ type: 'success', message: `${PROVIDER_LABELS[provider]} ${enabled ? 'enabled' : 'disabled'}` });
    } else {
      setStatus({ type: 'error', message: `Failed to ${enabled ? 'enable' : 'disable'} ${PROVIDER_LABELS[provider]}` });
      load();
    }
  };

  const setModel = async (provider: Provider, model: string) => {
    setProviders((prev) => prev.map((p) => (p.name === provider ? { ...p, model } : p)));
    const res = await fetch(`/api/ai/providers/${provider}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model }),
    });
    if (!res.ok) load();
  };

  const clearKey = async (provider: Provider) => {
    if (!await showConfirm(`Remove the ${PROVIDER_LABELS[provider]} API key?`, { tone: 'danger' })) return;
    setProviders((prev) => prev.map((p) => (
      p.name === provider ? { ...p, apiKeyMasked: '', configured: p.authMode === 'account' ? p.configured : false, callable: false } : p
    )));
    const res = await fetch(`/api/ai/providers/${provider}/key`, { method: 'DELETE' });
    if (!res.ok) load();
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
    setDefaultProvider(provider);
    setProviders((prev) => prev.map((p) => (p.name === provider ? { ...p, model, enabled: true, callable: p.configured } : p)));
    setStatus({ type: 'success', message: `${PROVIDER_LABELS[provider]} set as default` });
    const res = await fetch('/api/ai/default-provider', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider, model }),
    });
    if (!res.ok) load();
  };

  const setAgentProvider = async (agent: string, provider: Provider) => {
    setAgentMap((prev) => ({ ...prev, [agent]: provider }));
    const res = await fetch('/api/ai/agent-provider', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent, provider }),
    });
    if (!res.ok) load();
  };

  // Only show the skeleton on the very first load. Refetches after a save/toggle
  // (load() flips `loading` again) must NOT unmount the section — otherwise the whole
  // page flashes/reconfigures and the API key being typed in a card is lost.
  if (loading && providers.length === 0) return <SkeletonCard />;
  const enabledProviders = providers.filter((p) => p.enabled);

  return (
    <div className="space-y-6">
      <StatusBanner status={status} />

      <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-4 sm:p-6 shadow-sm">
        <h2 className="text-lg font-medium">AI Providers</h2>
        <p className="mt-1 text-sm text-[var(--text-muted)]">
          Keep service configuration here. API key mode is used by Test Flow AI server calls; subscription/account mode documents external Codex or Claude Code auth and is not called as an API key.
        </p>

        <div className="mt-6 space-y-4">
          {providers.map((p) => (
            <ProviderCard
              key={p.name}
              provider={p}
              onSaveKey={(apiKeyValue) => saveKey(p.name, apiKeyValue)}
              onSetEnabled={(enabled) => setEnabled(p.name, enabled)}
              onSetAuthMode={(authMode) => setAuthMode(p.name, authMode)}
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
                {(enabledProviders.length ? enabledProviders : providers).map((p) => (
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

function ProviderCard({ provider, onSaveKey, onSetEnabled, onSetAuthMode, onSetModel, onClearKey, onTest, onSetDefault }: React.PropsWithChildren<{
  provider: ProviderInfo;
  onSaveKey: (apiKeyValue: string) => void;
  onSetEnabled: (enabled: boolean) => void;
  onSetAuthMode: (authMode: ProviderInfo['authMode']) => void;
  onSetModel: (model: string) => void;
  onClearKey: () => void;
  onTest: () => void;
  onSetDefault: (model: string) => void;
}>) {
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const authMode = provider.authMode === 'account' ? 'account' : 'api_key';
  const accountCliSupported = provider.name === 'openai' || provider.name === 'anthropic';
  const showAccountMode = provider.accountCliAllowed && accountCliSupported;

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
                <CheckCircle className="h-3 w-3" /> {provider.enabled && provider.callable ? 'Active' : 'Configured'}
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-xs text-amber-500">
                <AlertCircle className="h-3 w-3" /> Not configured
              </span>
            )}
          </div>
          <div className="text-xs text-[var(--text-muted)]">
            {authMode === 'api_key'
              ? provider.apiKeyMasked ? `key: ${provider.apiKeyMasked}` : 'API key mode'
              : provider.accountTool ? `Local CLI: ${provider.accountTool}` : 'Subscription/account auth'}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => onSetEnabled(!provider.enabled)}
            className={`inline-flex items-center gap-1 rounded-md border px-3 py-1.5 text-xs font-medium ${
              provider.enabled
                ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-500'
                : 'border-[var(--border)] bg-[var(--bg-primary)] text-[var(--text-muted)] hover:border-[var(--accent)]'
            }`}
          >
            {provider.enabled ? 'On' : 'Off'}
          </button>
          <button
            type="button"
            onClick={onTest}
            // The connection check tests the configured credential, not whether the
            // provider is toggled on — so it's available as soon as a key is saved
            // (or account auth is available), even if the provider is currently Off.
            disabled={!provider.configured}
            title={!provider.configured ? 'Add an API key (or account auth) first' : 'Run a connection check'}
            className="inline-flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-3 py-1.5 text-xs font-medium hover:border-[var(--accent)] disabled:opacity-50"
          >
            <Activity className="h-3 w-3" /> Test
          </button>
          <button
            type="button"
            onClick={() => onSetDefault(provider.model)}
            disabled={!provider.enabled || !provider.configured}
            className="inline-flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-3 py-1.5 text-xs font-medium hover:border-[var(--accent)] disabled:opacity-50"
          >
            <Zap className="h-3 w-3" /> Set as default
          </button>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
        <button
          type="button"
          onClick={() => onSetAuthMode('api_key')}
          className={`flex cursor-pointer items-start gap-2 rounded-md border p-3 text-left text-sm ${authMode === 'api_key' ? 'border-[var(--accent)] bg-[var(--accent)]/5' : 'border-[var(--border)] bg-[var(--bg-primary)]'}`}
        >
          <input
            type="radio"
            checked={authMode === 'api_key'}
            readOnly
            tabIndex={-1}
            className="mt-1 pointer-events-none accent-[var(--accent)]"
          />
          <span>
            <span className="block font-medium">API key</span>
            <span className="block text-xs text-[var(--text-muted)]">Used by Test Flow AI backend calls and cost tracking.</span>
          </span>
        </button>
        {showAccountMode && (
          <button
            type="button"
            onClick={() => onSetAuthMode('account')}
            className={`flex cursor-pointer items-start gap-2 rounded-md border p-3 text-left text-sm ${authMode === 'account' ? 'border-[var(--accent)] bg-[var(--accent)]/5' : 'border-[var(--border)] bg-[var(--bg-primary)]'}`}
          >
            <input
              type="radio"
              checked={authMode === 'account'}
              readOnly
              tabIndex={-1}
              className="mt-1 pointer-events-none accent-[var(--accent)]"
            />
            <span>
              <span className="block font-medium">Subscription / account</span>
              <span className="block text-xs text-[var(--text-muted)]">
                Uses your local Codex or Claude Code login where supported.
              </span>
            </span>
          </button>
        )}
      </div>

      {authMode === 'account' && showAccountMode && (
        <div className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-600">
          Test Flow AI will run {provider.accountTool} locally for this provider, using the account already authenticated on this machine.
        </div>
      )}

      <div className={`mt-3 grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto] ${authMode === 'account' ? 'opacity-50' : ''}`}>
        <div className="flex gap-2">
          <input
            type={showKey ? 'text' : 'password'}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={provider.apiKeyMasked ? 'Replace API key' : 'Paste API key'}
            disabled={authMode === 'account'}
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
            disabled={!apiKey || authMode === 'account'}
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
    if (!await showConfirm(`Reset ${AGENT_LABELS[agent]?.label || agent} to the system default?`)) return;
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
  revealedPassword?: string;
  passwordVisible?: boolean;
  revealing?: boolean;
  useForPlaywright: boolean;
  saving?: boolean;
};

const SAVED_PASSWORD_MASK = '********';

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
            revealedPassword: '',
            passwordVisible: false,
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
      { key: newKey(), name: '', url: '', username: '', password: '', revealedPassword: '', passwordVisible: false, useForPlaywright: true },
    ]);

  const togglePasswordVisible = async (key: string) => {
    const row = rows.find((x) => x.key === key);
    if (!row) return;

    if (row.passwordVisible) {
      patch(key, { passwordVisible: false });
      return;
    }

    if (!row.userId || row.revealedPassword || row.password) {
      patch(key, { passwordVisible: true });
      return;
    }

    patch(key, { revealing: true });
    try {
      const res = await fetch('/api/credentials/reveal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: row.userId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Failed to reveal password');
      patch(key, { revealedPassword: data.password || '', passwordVisible: true, revealing: false });
    } catch (error: any) {
      patch(key, { revealing: false });
      setStatus({ type: 'error', message: error?.message || 'Failed to reveal password' });
    }
  };

  const saveRow = async (key: string) => {
    const r = rows.find((x) => x.key === key);
    if (!r || r.saving) return;
    if (!r.name || !r.url) return; // need at least a name + URL to persist
    setRows((prev) => prev.map((x) => (x.key === key ? { ...x, saving: true } : x)));
    try {
      // Read the server's error text on any non-2xx so the UI shows the REAL reason
      // (e.g. session expired → 401, or forbidden → 403) instead of a generic message.
      const failIfNotOk = async (res: Response, fallback: string) => {
        if (res.ok) return;
        const d = await res.json().catch(() => ({} as any));
        throw new Error(d?.error || `${fallback} (HTTP ${res.status})`);
      };

      let websiteId = r.websiteId;
      if (websiteId) {
        const res = await fetch(`/api/credentials/websites/${websiteId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: r.name, baseUrl: r.url }),
        });
        await failIfNotOk(res, 'Could not update website');
      } else {
        const res = await fetch('/api/credentials/websites', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: r.name, baseUrl: r.url, environment: 'staging' }),
        });
        await failIfNotOk(res, 'Could not create website');
        const d = await res.json().catch(() => ({}));
        websiteId = d?.website?.id;
      }
      if (!websiteId) throw new Error('The server did not return a website id.');

      const notes = r.useForPlaywright ? '' : 'no-playwright';
      let userId = r.userId;
      if (userId) {
        const body: any = { username: r.username, notes };
        if (r.password) body.password = r.password; // blank = keep existing
        const res = await fetch(`/api/credentials/users/${userId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        await failIfNotOk(res, 'Could not update login');
      } else if (r.username && r.password) {
        const res = await fetch(`/api/credentials/websites/${websiteId}/users`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ label: r.name || r.username, username: r.username, password: r.password, role: 'standard', notes }),
        });
        await failIfNotOk(res, 'Could not save login');
        const d = await res.json().catch(() => ({}));
        userId = d?.user?.id;
      }

      setRows((prev) => prev.map((x) => (x.key === key ? {
        ...x,
        websiteId,
        userId,
        revealedPassword: x.password ? x.password : x.revealedPassword,
        password: '',
        saving: false,
      } : x)));
      setStatus({ type: 'success', message: 'Saved' });
    } catch (err: any) {
      setRows((prev) => prev.map((x) => (x.key === key ? { ...x, saving: false } : x)));
      setStatus({ type: 'error', message: err?.message || 'Failed to save credential' });
    }
  };

  const deleteRow = async (key: string) => {
    const r = rows.find((x) => x.key === key);
    if (!r) return;
    if (r.websiteId) {
      if (!await showConfirm('Delete this website credential?', { tone: 'danger' })) return;
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

          {rows.map((r) => {
            const hasSavedPassword = Boolean(r.userId);
            const passwordValue = r.password || (r.passwordVisible ? r.revealedPassword || '' : hasSavedPassword ? SAVED_PASSWORD_MASK : '');
            return (
              <div
                key={r.key}
                className="grid grid-cols-1 items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] p-2 lg:grid-cols-[1.2fr_1.5fr_1.2fr_1.2fr_auto_auto]"
              >
              <input value={r.name} onChange={(e) => patch(r.key, { name: e.target.value })} onBlur={() => saveRow(r.key)} placeholder="Website name" className="rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 py-1.5 text-sm outline-none focus:border-[var(--accent)]" />
              <input value={r.url} onChange={(e) => patch(r.key, { url: e.target.value })} onBlur={() => saveRow(r.key)} placeholder="https://app.example.com" className="rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 py-1.5 text-sm outline-none focus:border-[var(--accent)]" />
              <input value={r.username} onChange={(e) => patch(r.key, { username: e.target.value })} onBlur={() => saveRow(r.key)} placeholder="Username / email" className="rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 py-1.5 text-sm outline-none focus:border-[var(--accent)]" />
              <div className="flex min-w-0 rounded-md border border-[var(--border)] bg-[var(--bg-primary)] focus-within:border-[var(--accent)]">
                <input
                  type={r.passwordVisible ? 'text' : 'password'}
                  value={passwordValue}
                  onChange={(e) => {
                    const next = !r.passwordVisible && hasSavedPassword && !r.password
                      ? e.target.value.replace(SAVED_PASSWORD_MASK, '')
                      : e.target.value;
                    patch(r.key, { password: next });
                  }}
                  onBlur={() => saveRow(r.key)}
                  onFocus={(e) => {
                    if (!r.passwordVisible && hasSavedPassword && !r.password) e.currentTarget.select();
                  }}
                  placeholder="Password"
                  className="min-w-0 flex-1 bg-transparent px-2 py-1.5 text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none"
                />
                <button
                  type="button"
                  onClick={() => togglePasswordVisible(r.key)}
                  disabled={r.revealing}
                  title={r.passwordVisible ? 'Hide password' : 'Show password'}
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-r-md text-[var(--text-muted)] hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)] disabled:opacity-50"
                >
                  {r.revealing ? <Loader2 className="h-4 w-4 animate-spin" /> : r.passwordVisible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
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
            );
          })}
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

const emptyWin = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, costUsd: 0, calls: 0 };
const WINDOW_META: Array<{ key: string; capKey: string; label: string }> = [
  { key: 'today', capKey: 'day', label: 'Today' },
  { key: 'week', capKey: 'week', label: 'Last 7 days' },
  { key: 'month', capKey: 'month', label: 'Last 30 days' },
  { key: 'year', capKey: 'year', label: 'Last 365 days' },
  { key: 'all', capKey: '', label: 'All time' },
];
const fmtInt = (n: number) => Number(n || 0).toLocaleString();
const fmtUsd = (n: number) => `$${Number(n || 0).toFixed(Number(n) >= 1 ? 2 : 4)}`;

function CostSection() {
  const { showQueryLogs, load: loadUiSettings, setShowQueryLogs } = useUiSettings();
  useEffect(() => { void loadUiSettings(); }, [loadUiSettings]);
  const [cost, setCost] = useState<{ guardrailLogs: any[] }>({ guardrailLogs: [] });
  const [summary, setSummary] = useState<any>(null);
  const [usage, setUsage] = useState<any[]>([]);
  const [caps, setCaps] = useState<{ day: number; week: number; month: number; year: number }>({ day: 50, week: 0, month: 0, year: 0 });
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [c, s, u] = await Promise.all([
        fetch('/api/ai/cost').then((r) => r.json()),
        fetch('/api/ai/usage/summary').then((r) => r.json()),
        fetch('/api/ai/usage').then((r) => r.json()),
      ]);
      setCost(c);
      setSummary(s);
      setUsage(u.usage || []);
      if (s?.caps) setCaps(s.caps);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const saveCaps = async () => {
    await fetch('/api/ai/cost/caps', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(caps),
    });
    await load();
  };

  if (loading || !summary) return <SkeletonCard />;

  const windows = summary.windows || {};
  const capStatus = summary.capStatus || {};
  const byModel: any[] = summary.byModel || [];
  const allTime = windows.all || emptyWin;

  return (
    <div className="space-y-6">
      {/* Chat log visibility: gates the per-query "Background communication" panels in the Agent Console. */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-4 sm:p-6 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-medium">Chat logs</h2>
            <p className="mt-1 text-sm text-[var(--text-muted)]">Show the per-query background communication logs under each chat message and agent run.</p>
          </div>
          <button
            onClick={() => setShowQueryLogs(!showQueryLogs)}
            aria-pressed={showQueryLogs}
            className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-semibold transition-colors ${
              showQueryLogs
                ? 'bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)]'
                : 'border border-[var(--border)] bg-[var(--bg-primary)] text-[var(--text-muted)] hover:text-[var(--text-primary)]'
            }`}
          >
            {showQueryLogs ? 'On' : 'Off'}
          </button>
        </div>
      </div>

      {/* Spend by window, each with its cap progress. */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-4 sm:p-6 shadow-sm">
        <h2 className="text-lg font-medium">Spend</h2>
        <p className="mt-1 text-sm text-[var(--text-muted)]">Real cost across every AI call, priced from each provider's official rates for the model you selected. Deployment-wide.</p>
        <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-5">
          {WINDOW_META.map(({ key, capKey, label }) => {
            const w = windows[key] || emptyWin;
            const cap = capKey ? (capStatus[capKey]?.limit || 0) : 0;
            const over = capKey ? capStatus[capKey]?.over : false;
            const pct = cap > 0 ? Math.min(100, (w.costUsd / cap) * 100) : 0;
            return (
              <div key={key} className="rounded-lg border border-[var(--border)] bg-[var(--bg-primary)] p-3">
                <div className="text-[11px] uppercase tracking-wide text-[var(--text-muted)]">{label}</div>
                <div className={`mt-1 text-xl font-bold ${over ? 'text-red-500' : ''}`}>{fmtUsd(w.costUsd)}</div>
                <div className="text-[11px] text-[var(--text-muted)]">{fmtInt(w.totalTokens)} tokens · {fmtInt(w.calls)} calls</div>
                {cap > 0 && (
                  <>
                    <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-[var(--bg-secondary)]">
                      <div className={`h-full ${pct > 90 ? 'bg-red-500' : pct > 60 ? 'bg-amber-500' : 'bg-emerald-500'}`} style={{ width: `${pct}%` }} />
                    </div>
                    <div className="mt-1 text-[10px] text-[var(--text-muted)]">cap {fmtUsd(cap)}</div>
                  </>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* All-time token breakdown: input / output / cache read / cache write. */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-4 sm:p-6 shadow-sm">
        <h2 className="text-lg font-medium">Tokens by type (all time)</h2>
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            { k: 'inputTokens', label: 'Input' },
            { k: 'outputTokens', label: 'Output' },
            { k: 'cacheReadTokens', label: 'Cache read' },
            { k: 'cacheWriteTokens', label: 'Cache write' },
          ].map(({ k, label }) => (
            <div key={k} className="rounded-lg border border-[var(--border)] bg-[var(--bg-primary)] p-3">
              <div className="text-[11px] uppercase tracking-wide text-[var(--text-muted)]">{label}</div>
              <div className="mt-1 text-lg font-semibold">{fmtInt(allTime[k])}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Per-window spend caps. 0 = no cap. */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-4 sm:p-6 shadow-sm">
        <h2 className="text-lg font-medium">Spend caps</h2>
        <p className="mt-1 text-sm text-[var(--text-muted)]">Set a USD cap per window. 0 means no cap. The daily cap also gates new agent runs.</p>
        <div className="mt-4 flex flex-wrap items-end gap-3">
          {[
            { k: 'day', label: 'Per day' },
            { k: 'week', label: 'Per 7 days' },
            { k: 'month', label: 'Per 30 days' },
            { k: 'year', label: 'Per 365 days' },
          ].map(({ k, label }) => (
            <div key={k}>
              <label className="mb-1 block text-xs text-[var(--text-muted)]">{label} (USD)</label>
              <input
                type="number" min="0" step="1"
                value={(caps as any)[k]}
                onChange={(e) => setCaps((c) => ({ ...c, [k]: Number(e.target.value) }))}
                className="w-28 rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-3 py-2 text-sm"
              />
            </div>
          ))}
          <button onClick={saveCaps} className="inline-flex items-center gap-1 rounded-md bg-[var(--accent)] px-3 py-2 text-xs font-medium text-white">
            <Save className="h-3 w-3" /> Save caps
          </button>
        </div>
      </div>

      {/* Per-model breakdown. */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-4 sm:p-6 shadow-sm">
        <h2 className="text-lg font-medium">By model (all time)</h2>
        <div className="mt-3 max-h-96 overflow-auto">
          <table className="w-full text-sm whitespace-nowrap">
            <thead className="sticky top-0 z-10 bg-[var(--bg-card)] text-xs text-[var(--text-muted)]">
              <tr>
                <th className="px-2 py-1 text-left">Model</th>
                <th className="px-2 py-1 text-right">Input</th>
                <th className="px-2 py-1 text-right">Output</th>
                <th className="px-2 py-1 text-right">Cache read</th>
                <th className="px-2 py-1 text-right">Cache write</th>
                <th className="px-2 py-1 text-right">Calls</th>
                <th className="px-2 py-1 text-right">Cost</th>
              </tr>
            </thead>
            <tbody>
              {byModel.length === 0 && (
                <tr><td colSpan={7} className="px-2 py-4 text-center text-xs text-[var(--text-muted)]">No usage recorded yet.</td></tr>
              )}
              {byModel.map((m) => (
                <tr key={m.model} className="border-t border-[var(--border)]">
                  <td className="px-2 py-1 text-xs font-medium">{m.model}</td>
                  <td className="px-2 py-1 text-right text-xs">{fmtInt(m.inputTokens)}</td>
                  <td className="px-2 py-1 text-right text-xs">{fmtInt(m.outputTokens)}</td>
                  <td className="px-2 py-1 text-right text-xs">{fmtInt(m.cacheReadTokens)}</td>
                  <td className="px-2 py-1 text-right text-xs">{fmtInt(m.cacheWriteTokens)}</td>
                  <td className="px-2 py-1 text-right text-xs">{fmtInt(m.calls)}</td>
                  <td className="px-2 py-1 text-right text-xs font-medium">{fmtUsd(m.costUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-4 sm:p-6 shadow-sm">
        <h2 className="text-lg font-medium">Recent Usage</h2>
        <div className="mt-3 max-h-96 overflow-auto">
          <table className="w-full text-sm whitespace-nowrap">
            <thead className="sticky top-0 z-10 bg-[var(--bg-card)] text-xs text-[var(--text-muted)]">
              <tr>
                <th className="px-2 py-1 text-left">When</th>
                <th className="px-2 py-1 text-left">Agent</th>
                <th className="px-2 py-1 text-left">Provider</th>
                <th className="px-2 py-1 text-left">Model</th>
                <th className="px-2 py-1 text-right">In</th>
                <th className="px-2 py-1 text-right">Out</th>
                <th className="px-2 py-1 text-right">Cache r/w</th>
                <th className="px-2 py-1 text-right">Cost</th>
              </tr>
            </thead>
            <tbody>
              {usage.length === 0 && (
                <tr><td colSpan={8} className="px-2 py-4 text-center text-xs text-[var(--text-muted)]">No usage recorded yet.</td></tr>
              )}
              {usage.map((u) => (
                <tr key={u.id} className="border-t border-[var(--border)]">
                  <td className="px-2 py-1 text-xs">{new Date(u.createdAt).toLocaleString()}</td>
                  <td className="px-2 py-1 text-xs">{u.agent}</td>
                  <td className="px-2 py-1 text-xs">{u.provider}</td>
                  <td className="px-2 py-1 text-xs">{u.model}</td>
                  <td className="px-2 py-1 text-right text-xs">{fmtInt(u.inputTokens)}</td>
                  <td className="px-2 py-1 text-right text-xs">{fmtInt(u.outputTokens)}</td>
                  <td className="px-2 py-1 text-right text-xs">{fmtInt(u.cacheReadTokens)}/{fmtInt(u.cacheWriteTokens)}</td>
                  <td className="px-2 py-1 text-right text-xs">{fmtUsd(u.costUsd)}</td>
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
