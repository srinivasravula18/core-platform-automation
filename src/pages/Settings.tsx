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
import { FEATURE_OPTIONS } from '../lib/features';
import { useUrlState } from '@/src/lib/useUrlState';

/** The one AI runtime. Kept as a named constant because usage records and RBAC grants key on it. */
const CODEX_RUNTIME = 'codex';

type ProviderInfo = {
  name: string;
  defaultModel: string;
  alternatives: string[];
  enabled: boolean;
  configured: boolean;
  apiKeyConfigured: boolean;
  callable: boolean;
  model: string;
  effort: string;
  authMode: 'api_key' | 'account';
  apiKeyMasked: string;
  /** Live runtime auth, not stored config — whether Codex can actually run right now. */
  authenticated: boolean;
  authMethod: string | null;
  authError: string;
};

type DeviceLogin = {
  loginId: string;
  verificationUrl: string;
  userCode: string;
  state: 'pending' | 'success' | 'error' | 'cancelled';
  error?: string;
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

/** The orchestration roster, in pipeline order. Maestro supervises; each specialist owns one deliverable. */
const ORCHESTRATION_ROSTER = ['maestro', 'atlas', 'compass', 'appInspector', 'scribeRequirements', 'testPlanner', 'suiteDesigner', 'forgeCases', 'sentinel', 'anvil', 'sleuth', 'herald'];

const AGENT_LABELS: Record<string, { label: string; description: string; role?: string }> = {
  maestro: { label: 'Maestro — Orchestrator', description: 'Decides only scope ambiguity, repair-vs-escalate, and budget breach. Never routes nodes.', role: 'Supervisor' },
  atlas: { label: 'Atlas — Repo Cartographer', description: 'Reads the codebase once and produces the repo map every other agent depends on.', role: 'Grounding' },
  compass: { label: 'Compass — Scope Resolver', description: 'Subtraction: reduces the repo map to the minimal slice needed to test the target.', role: 'Grounding' },
  scribeRequirements: { label: 'Scribe — Requirements Analyst', description: 'Produces testable requirements with acceptance criteria and source references.', role: 'Authoring' },
  forgeCases: { label: 'Forge — Test Case Designer', description: 'Designs executable cases from one approved requirement, using only inventory selectors.', role: 'Authoring' },
  sentinel: { label: 'Sentinel — Critic', description: 'Adversarially refutes ungrounded, duplicate, unverifiable, or unsafe drafts before compile.', role: 'Verification' },
  anvil: { label: 'Anvil — Script Engineer', description: 'Generates executable specs from approved cases; evidence capture comes from the shared fixture.', role: 'Authoring' },
  sleuth: { label: 'Sleuth — Triage Analyst', description: 'Triages one stable failure, ruling out the test before blaming the product.', role: 'Analysis' },
  herald: { label: 'Herald — Report Composer', description: 'Composes the run report: verdict, counts, new defects, regressions, suite health, coverage.', role: 'Analysis' },
  chatAssistant: { label: 'Chat Assistant', description: 'Routes greetings, QA tasks, and names artifacts/runs.' },
  caseWriter: { label: 'Case Writer', description: 'Writes, reworks, expands cases, and covers code changes.' },
  testPlanner: { label: 'Test Planner', description: 'Drafts a structured test plan from a user request.' , role: 'Planning' },
  suiteDesigner: { label: 'Suite & Folder Organizer', description: 'Groups cases into suites and organizes the repository.' , role: 'Planning' },
  playwrightCoder: { label: 'Playwright Coder', description: 'Generates Playwright TypeScript scripts.' },
  appInspector: { label: 'Application Inspector', description: 'Drives a headless browser to inspect a flow.' , role: 'Grounding' },
  defectTriage: { label: 'Defect & Report Analyst', description: 'Triages defects and writes report narratives.' },
  featureAnalyst: { label: 'Feature Analyst', description: 'Analyzes one source-grounded feature and its business rules.' },
  featureDiscoveryAgent: { label: 'Feature Discovery', description: 'Maps source-grounded features and subfeatures across the app.' },
  e2eFlowAgent: { label: 'E2E Flow Mapper', description: 'Finds cross-feature source-grounded end-to-end journeys.' },
};

export default function Settings() {
  const { theme, setTheme } = useTheme();
  const [tab, setTab] = useUrlState('tab', 'providers', ['appearance', 'providers', 'prompts', 'credentials', 'cost', 'data', 'profiles', 'deployment'] as const);
  const admin = isAdmin();

  const tabs: Array<[typeof tab, string, any]> = [
    ['providers', 'AI Runtime', Bot],
    ['prompts', 'System Prompts', MessageSquare],
    ['credentials', 'Credentials', Globe],
    ['cost', 'Cost & Logs', Activity],
    ...(admin ? [['data', 'Data', Trash2] as [typeof tab, string, any]] : []),
    // Admin-only: manage the people who can log in (People) and the access groups that grant them
    // features/projects/providers/URLs (Access Groups) — both live under one Profiles tab.
    ...(admin ? [['profiles', 'Profiles', Users] as [typeof tab, string, any]] : []),
    // Admin-only: where repos live on THIS server (so a deployed instance finds the right folders).
    ...(admin ? [['deployment', 'Deployment', FolderTree] as [typeof tab, string, any]] : []),
    ['appearance', 'Appearance', Sun],
  ];

  // A copied admin-only URL must not leave a standard user on an empty page.
  useEffect(() => {
    if (!tabs.some(([key]) => key === tab)) setTab('providers');
  }, [tab, tabs, setTab]);

  return (
    <div className="app-page-shell space-y-6 px-1 sm:px-0">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
        <p className="mt-1 text-sm text-[var(--text-muted)]">AI runtime, prompts, credentials, and cost. Set autonomy from the Agent Console chat.</p>
      </div>

      <div className="flex gap-1 overflow-x-auto rounded-lg border border-[var(--border)] bg-[var(--bg-card)] p-1 text-sm">
        {tabs.map(([key, label, Icon]) => (
          <button
            key={key}
            data-delete-style={key === 'data' ? 'ignore' : undefined}
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
      {tab === 'profiles' && admin && <AccessManagement />}
      {tab === 'deployment' && admin && <DeploymentSection />}
    </div>
  );
}

function DataSection() {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<SaveStatus>({ type: 'idle', message: '' });

  const clearArtifacts = async () => {
    if (!await showConfirm('Reset the workspace? This permanently deletes ALL data — test artifacts, agent runs, every user\'s chat history, and all automation data. Only users, projects/apps, and settings are kept. This cannot be undone.', { tone: 'danger' })) return;
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
      const byGroup = Object.entries(data.removed || {})
        .filter(([, value]) => Number(value) > 0)
        .map(([key, value]) => `${key}: ${value}`)
        .join(' · ');
      setStatus({ type: 'success', message: `Workspace reset — ${total} record${total === 1 ? '' : 's'} deleted.${byGroup ? ` (${byGroup})` : ''} Users, projects, and settings were kept.` });
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
            <h2 className="text-lg font-medium text-red-400">Reset Workspace Data</h2>
            <p className="mt-1 max-w-2xl text-sm text-[var(--text-muted)]">
              Permanently deletes everything except users, projects, and settings. This is not a soft delete — nothing lands in the Recycle Bin and it cannot be undone.
            </p>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-3">
                <div className="text-xs font-semibold uppercase tracking-wider text-red-400">Deleted</div>
                <ul className="mt-1 space-y-0.5 text-xs text-[var(--text-muted)]">
                  <li>Test cases, plans, suites, runs, requirements, reports, folders, defects, scripts, tags</li>
                  <li>Agent runs, orchestration ledger, blackboard facts, messages, run memory, graph checkpoints</li>
                  <li>Chat history for <span className="font-medium text-[var(--text-primary)]">every user</span></li>
                  <li>Automation: paired agents, recordings, jobs, schedules, datasets, uploads</li>
                  <li>Activity and audit logs</li>
                </ul>
              </div>
              <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] p-3">
                <div className="text-xs font-semibold uppercase tracking-wider text-[var(--accent)]">Kept</div>
                <ul className="mt-1 space-y-0.5 text-xs text-[var(--text-muted)]">
                  <li>Users, sessions, and access groups</li>
                  <li>Projects and apps</li>
                  <li>All settings, including system-prompt overrides</li>
                  <li>Website credentials and connected repositories</li>
                </ul>
              </div>
            </div>
          </div>
          <button
            onClick={clearArtifacts}
            disabled={busy}
            className="inline-flex items-center justify-center gap-2 rounded-md border border-red-500 bg-red-500/10 px-3 py-2 text-sm font-medium text-red-300 hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
            Reset Workspace
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
 * Admin-only Profiles tab: manage the People who can log in and the Access Groups that grant them
 * features/projects/providers/URLs — one screen, a segmented toggle between the two related jobs
 * (create users in People, then bundle + restrict them in Access Groups).
 */
function AccessManagement() {
  const [view, setView] = useUrlState('view', 'people', ['people', 'groups'] as const);
  const items: Array<['people' | 'groups', string, any]> = [
    ['people', 'People', Users],
    ['groups', 'Access Groups', Shield],
  ];
  return (
    <div className="space-y-4">
      <div className="inline-flex gap-1 rounded-lg border border-[var(--border)] bg-[var(--bg-card)] p-1 text-sm">
        {items.map(([key, label, Icon]) => (
          <button
            key={key}
            onClick={() => setView(key)}
            className={`inline-flex items-center gap-2 rounded-md px-3 py-1.5 font-medium transition-colors ${
              view === key ? 'bg-[var(--accent)] text-white' : 'text-[var(--text-muted)] hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)]'
            }`}
          >
            <Icon className="h-4 w-4" /> {label}
          </button>
        ))}
      </div>
      {view === 'people' ? <ProfilesSection /> : <GroupsSection />}
    </div>
  );
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
  const [accessFor, setAccessFor] = useState<string | null>(null); // user id whose direct access is open

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
        <h3 className="mb-3 font-medium text-[var(--text-primary)]">New Profile</h3>
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
            Create Profile
          </button>
          {status.type !== 'idle' && (
            <span className={`text-xs ${status.type === 'success' ? 'text-emerald-500' : 'text-red-500'}`}>{status.message}</span>
          )}
        </div>
      </div>

      {/* Existing profiles */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-5 shadow-sm">
        <h3 className="mb-3 font-medium text-[var(--text-primary)]">Existing Profiles</h3>
        {loading ? (
          <p className="text-sm text-[var(--text-muted)]">Loading…</p>
        ) : users.length === 0 ? (
          <p className="text-sm text-[var(--text-muted)]">No profiles yet.</p>
        ) : (
          <div className="space-y-1.5">
            {users.map((u) => (
              <div key={u.id}>
                <div className="flex items-center gap-3 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-sm">
                  <span className="font-medium text-[var(--text-primary)]">{u.name}</span>
                  <span className="text-[var(--text-muted)]">@{u.username}</span>
                  <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${u.role === 'admin' ? 'bg-[var(--accent)]/15 text-[var(--accent)]' : 'bg-[var(--bg-card)] text-[var(--text-muted)]'}`}>
                    {u.role}
                  </span>
                  <div className="ml-auto flex items-center gap-1">
                    {u.role !== 'admin' && (
                      <button
                        onClick={() => setAccessFor(accessFor === u.id ? null : u.id)}
                        title="Edit this user's direct access (in addition to their groups)"
                        className={`rounded p-1.5 hover:text-[var(--accent)] ${accessFor === u.id ? 'text-[var(--accent)]' : 'text-[var(--text-muted)]'}`}
                      >
                        <Shield className="h-4 w-4" />
                      </button>
                    )}
                    <button
                      onClick={() => remove(u)}
                      disabled={busy || u.role === 'admin'}
                      title={u.role === 'admin' ? 'Admin profiles cannot be removed here' : 'Delete Profile'}
                      className="rounded p-1.5 text-[var(--text-muted)] hover:text-red-500 disabled:opacity-30"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>
                {accessFor === u.id && <UserAccessEditor userId={u.id} label={`${u.name} @${u.username}`} onClose={() => setAccessFor(null)} />}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// A grant category value is either '*' (all) or an explicit list of ids.
type GrantValue = string[] | '*';
interface GroupGrants { features: GrantValue; projects: GrantValue; websites: GrantValue; providers: GrantValue; actions?: GrantValue; capabilities?: GrantValue; denies?: GrantValue }
interface GroupRow { id: string; name: string; description?: string; memberUserIds: string[]; grants: GroupGrants; createdAt: string }

// Permission catalog served by GET /api/auth/rbac/catalog (resource verbs + capabilities).
interface RbacCatalog { resources: Array<{ resource: string; verbs: string[]; feature: string }>; capabilities: Array<{ id: string; label: string }> }
const VERB_ORDER = ['read', 'create', 'update', 'delete', 'execute', 'export', 'start', 'stop', 'apply'];
const TIER_VERBS: Record<'readOnly' | 'editor' | 'full', (verbs: string[]) => string[]> = {
  readOnly: (v) => v.filter((x) => x === 'read'),
  editor: (v) => v.filter((x) => x !== 'delete'),
  full: (v) => v,
};

const PROVIDER_OPTIONS = [{ id: CODEX_RUNTIME, name: 'Codex' }];
const EMPTY_GRANTS: GroupGrants = { features: [], projects: [], websites: [], providers: [] };

const humanizeToken = (s: string) => s.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

/** One grant category: an "All" master toggle plus a checkbox per option. `value` is '*' or ids. */
function GrantCheckboxes({ title, options, value, onChange }: { title: string; options: Array<{ id: string; name: string }>; value: GrantValue; onChange: (v: GrantValue) => void }) {
  const all = value === '*';
  const ids = Array.isArray(value) ? value : [];
  const toggleOne = (id: string) => onChange(ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]);
  return (
    <div className="rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">{title}</span>
        <label className="flex items-center gap-1.5 text-xs text-[var(--text-primary)]">
          <input type="checkbox" className="accent-[var(--accent)]" checked={all} onChange={(e) => onChange(e.target.checked ? '*' : [])} />
          All (Unrestricted)
        </label>
      </div>
      {all ? (
        <p className="text-xs text-[var(--text-muted)]">All {title.toLowerCase()} granted.</p>
      ) : options.length === 0 ? (
        <p className="text-xs text-[var(--text-muted)]">None available.</p>
      ) : (
        <div className="grid grid-cols-2 gap-1 sm:grid-cols-3">
          {options.map((o) => (
            <label key={o.id} className="flex cursor-pointer items-center gap-1.5 truncate rounded px-1.5 py-1 text-xs text-[var(--text-primary)] hover:bg-[var(--bg-card)]" title={o.name}>
              <input type="checkbox" className="accent-[var(--accent)]" checked={ids.includes(o.id)} onChange={() => toggleOne(o.id)} />
              <span className="truncate">{o.name}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

function grantSummary(v: GrantValue): string {
  if (v === '*') return 'All';
  return v.length ? String(v.length) : 'None';
}

/**
 * Verb-level permission editor: rows = resources, columns = verbs. Writes a flat `resource:verb`
 * list (or '*'). Per-row Read-only / Editor / Full quick-set the access tier. Granting a page under
 * "Features" already implies read; this is where write/execute/delete are handed out.
 */
function ActionsMatrix({ catalog, value, onChange }: { catalog: RbacCatalog; value: GrantValue; onChange: (v: GrantValue) => void }) {
  const all = value === '*';
  const ids = Array.isArray(value) ? value : [];
  const has = (id: string) => ids.includes(id);
  const toggle = (id: string) => onChange(has(id) ? ids.filter((x) => x !== id) : [...ids, id]);
  const setRow = (resource: string, verbs: string[]) => {
    const others = ids.filter((id) => !id.startsWith(`${resource}:`));
    onChange([...others, ...verbs.map((v) => `${resource}:${v}`)]);
  };
  const orderVerbs = (verbs: string[]) => [...verbs].sort((a, b) => VERB_ORDER.indexOf(a) - VERB_ORDER.indexOf(b));
  return (
    <div className="rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">Permissions (Per Action)</span>
        <label className="flex items-center gap-1.5 text-xs text-[var(--text-primary)]">
          <input type="checkbox" className="accent-[var(--accent)]" checked={all} onChange={(e) => onChange(e.target.checked ? '*' : [])} />
          All (Unrestricted)
        </label>
      </div>
      {all ? (
        <p className="text-xs text-[var(--text-muted)]">Every action on every resource granted.</p>
      ) : (
        <div className="space-y-1">
          {catalog.resources.map((r) => (
            <div key={r.resource} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded px-1.5 py-1 hover:bg-[var(--bg-card)]">
              <span className="w-28 shrink-0 truncate text-xs font-medium text-[var(--text-primary)]" title={r.resource}>{humanizeToken(r.resource)}</span>
              <div className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5">
                {orderVerbs(r.verbs).map((v) => (
                  <label key={v} className="flex cursor-pointer items-center gap-1 text-xs text-[var(--text-muted)]">
                    <input type="checkbox" className="accent-[var(--accent)]" checked={has(`${r.resource}:${v}`)} onChange={() => toggle(`${r.resource}:${v}`)} />
                    {v}
                  </label>
                ))}
              </div>
              <div className="ml-auto flex items-center gap-1">
                {(['readOnly', 'editor', 'full'] as const).map((tier) => (
                  <button key={tier} type="button" onClick={() => setRow(r.resource, TIER_VERBS[tier](r.verbs))}
                    className="rounded border border-[var(--border)] px-1.5 py-0.5 text-[10px] text-[var(--text-muted)] hover:border-[var(--accent)] hover:text-[var(--accent)]">
                    {tier === 'readOnly' ? 'Read-only' : tier === 'editor' ? 'Editor' : 'Full'}
                  </button>
                ))}
                <button type="button" onClick={() => setRow(r.resource, [])} className="rounded px-1.5 py-0.5 text-[10px] text-[var(--text-muted)] hover:text-red-500">Clear</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Per-user direct access editor (Profiles tab). Grants a single user permissions ON TOP of their
 * groups — the concrete "give only this one person Record & Play" flow. Saved via /api/users/:id/grants.
 */
function UserAccessEditor({ userId, label, onClose }: { userId: string; label: string; onClose: () => void }) {
  const [grants, setGrants] = useState<GroupGrants>({ ...EMPTY_GRANTS });
  const [catalog, setCatalog] = useState<RbacCatalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<SaveStatus>({ type: 'idle', message: '' });

  useEffect(() => {
    setLoading(true);
    Promise.all([
      fetch(`/api/users/${userId}/grants`).then((r) => r.json()).catch(() => ({})),
      fetch('/api/auth/rbac/catalog').then((r) => r.json()).catch(() => ({})),
    ]).then(([g, c]) => {
      setGrants({ ...EMPTY_GRANTS, ...(g?.grants || {}) });
      if (Array.isArray(c?.resources)) setCatalog({ resources: c.resources, capabilities: Array.isArray(c.capabilities) ? c.capabilities : [] });
    }).finally(() => setLoading(false));
  }, [userId]);

  const setGrant = (cat: keyof GroupGrants, v: GrantValue) => setGrants((s) => ({ ...s, [cat]: v }));

  const save = async () => {
    setBusy(true); setStatus({ type: 'idle', message: '' });
    try {
      const res = await fetch(`/api/users/${userId}/grants`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ grants }) });
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || 'Could not save.');
      setStatus({ type: 'success', message: 'Direct access saved.' });
    } catch (e: any) {
      setStatus({ type: 'error', message: e?.message || 'Could not save.' });
    } finally { setBusy(false); }
  };

  return (
    <div className="mt-1 rounded-md border border-[var(--border)] bg-[var(--bg-card)] p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs text-[var(--text-muted)]">Direct access for <span className="font-medium text-[var(--text-primary)]">{label}</span> — added on top of any group grants.</span>
        <button onClick={onClose} className="rounded p-1 text-[var(--text-muted)] hover:text-[var(--text-primary)]"><X className="h-4 w-4" /></button>
      </div>
      {loading ? (
        <p className="text-xs text-[var(--text-muted)]">Loading…</p>
      ) : (
        <div className="space-y-3">
          <GrantCheckboxes title="Features" options={FEATURE_OPTIONS} value={grants.features} onChange={(v) => setGrant('features', v)} />
          {catalog && <ActionsMatrix catalog={catalog} value={grants.actions ?? []} onChange={(v) => setGrant('actions', v)} />}
          {catalog && catalog.capabilities.length > 0 && (
            <GrantCheckboxes title="Capabilities" options={catalog.capabilities.map((c) => ({ id: c.id, name: c.label }))} value={grants.capabilities ?? []} onChange={(v) => setGrant('capabilities', v)} />
          )}
          <div className="flex items-center gap-2">
            <button onClick={save} disabled={busy} className="inline-flex items-center gap-2 rounded-md bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-white hover:bg-[var(--accent-hover)] disabled:opacity-60">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Save Access
            </button>
            {status.type !== 'idle' && <span className={`text-xs ${status.type === 'success' ? 'text-emerald-500' : 'text-red-500'}`}>{status.message}</span>}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Admin-only: Access Groups. Put non-admin users in a group and toggle what it grants — features
 * (pages), projects, deployment URLs, and AI providers. A user's effective access is the union of
 * their groups; admins and ungrouped users are unrestricted. Saved via /api/groups.
 */
function GroupsSection() {
  const [groups, setGroups] = useState<GroupRow[]>([]);
  const [users, setUsers] = useState<AppUserRow[]>([]);
  const [projects, setProjects] = useState<Array<{ id: string; name: string }>>([]);
  const [websites, setWebsites] = useState<Array<{ id: string; name: string }>>([]);
  const [catalog, setCatalog] = useState<RbacCatalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<SaveStatus>({ type: 'idle', message: '' });
  // `editing` holds the working draft; id '' = creating a new group.
  const [editing, setEditing] = useState<GroupRow | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      fetch('/api/groups').then((r) => r.json()).catch(() => ({})),
      fetch('/api/users').then((r) => r.json()).catch(() => ({})),
      fetch('/api/projects').then((r) => r.json()).catch(() => ({})),
      fetch('/api/credentials/websites').then((r) => r.json()).catch(() => ({})),
      fetch('/api/auth/rbac/catalog').then((r) => r.json()).catch(() => ({})),
    ]).then(([g, u, p, w, c]) => {
      setGroups(Array.isArray(g.groups) ? g.groups : []);
      setUsers(Array.isArray(u.users) ? u.users : []);
      const projList = Array.isArray(p) ? p : (Array.isArray(p.projects) ? p.projects : []);
      setProjects(projList.map((x: any) => ({ id: x.id, name: x.name || x.id })));
      setWebsites((Array.isArray(w.websites) ? w.websites : []).map((x: any) => ({ id: x.id, name: x.name || x.baseUrl || x.id })));
      if (Array.isArray(c?.resources)) setCatalog({ resources: c.resources, capabilities: Array.isArray(c.capabilities) ? c.capabilities : [] });
    }).finally(() => setLoading(false));
  }, []);
  useEffect(() => { load(); }, [load]);

  const nonAdminUsers = users.filter((u) => u.role !== 'admin');
  const startCreate = () => setEditing({ id: '', name: '', description: '', memberUserIds: [], grants: { ...EMPTY_GRANTS }, createdAt: '' });
  const startEdit = (g: GroupRow) => setEditing({ ...g, grants: { ...EMPTY_GRANTS, ...g.grants } });

  const save = async () => {
    if (!editing) return;
    if (!editing.name.trim()) { setStatus({ type: 'error', message: 'Give the group a name.' }); return; }
    setBusy(true);
    setStatus({ type: 'idle', message: '' });
    try {
      const body = JSON.stringify({ name: editing.name.trim(), description: editing.description || '', memberUserIds: editing.memberUserIds, grants: editing.grants });
      const res = editing.id
        ? await fetch(`/api/groups/${editing.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body })
        : await fetch('/api/groups', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || 'Could not save group.');
      setStatus({ type: 'success', message: `Group "${editing.name.trim()}" saved.` });
      setEditing(null);
      load();
    } catch (e: any) {
      setStatus({ type: 'error', message: e?.message || 'Could not save group.' });
    } finally {
      setBusy(false);
    }
  };

  const remove = async (g: GroupRow) => {
    if (!await showConfirm(`Delete access group "${g.name}"? Members without another group will lose access.`, { tone: 'danger' })) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/groups/${g.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || 'Could not delete group.');
      load();
    } catch (e: any) {
      setStatus({ type: 'error', message: e?.message || 'Could not delete group.' });
    } finally {
      setBusy(false);
    }
  };

  const setGrant = (cat: keyof GroupGrants, v: GrantValue) => setEditing((e) => e ? { ...e, grants: { ...e.grants, [cat]: v } } : e);
  const toggleMember = (id: string) => setEditing((e) => e ? { ...e, memberUserIds: e.memberUserIds.includes(id) ? e.memberUserIds.filter((x) => x !== id) : [...e.memberUserIds, id] } : e);

  return (
    <div className="space-y-4">
      <StatusBanner status={status} />
      <div className="flex items-center justify-between">
        <p className="max-w-2xl text-sm text-[var(--text-muted)]">
          Group non-admin users and grant each group access to specific features, projects, deployment URLs, and AI providers. A user's access is the union of their groups. Admins have full access; users in no group have no access.
        </p>
        {!editing && (
          <button onClick={startCreate} className="inline-flex shrink-0 items-center gap-2 rounded-md bg-[var(--accent)] px-3 py-2 text-sm font-medium text-white hover:bg-[var(--accent-hover)]">
            <Plus className="h-4 w-4" /> New group
          </button>
        )}
      </div>

      {editing && (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-5 shadow-sm">
          <h3 className="mb-3 font-medium text-[var(--text-primary)]">{editing.id ? 'Edit Group' : 'New Group'}</h3>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-[var(--text-muted)]">Name</span>
              <input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder="e.g. QA Team" className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2.5 py-1.5 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent)]" />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-[var(--text-muted)]">Description (Optional)</span>
              <input value={editing.description || ''} onChange={(e) => setEditing({ ...editing, description: e.target.value })} placeholder="What this group is for" className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2.5 py-1.5 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent)]" />
            </label>
          </div>

          <div className="mt-3 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] p-3">
            <span className="mb-2 block text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">Members</span>
            {nonAdminUsers.length === 0 ? (
              <p className="text-xs text-[var(--text-muted)]">No non-admin profiles yet. Create some in the Profiles tab.</p>
            ) : (
              <div className="grid grid-cols-2 gap-1 sm:grid-cols-3">
                {nonAdminUsers.map((u) => (
                  <label key={u.id} className="flex cursor-pointer items-center gap-1.5 truncate rounded px-1.5 py-1 text-xs text-[var(--text-primary)] hover:bg-[var(--bg-card)]" title={`${u.name} @${u.username}`}>
                    <input type="checkbox" className="accent-[var(--accent)]" checked={editing.memberUserIds.includes(u.id)} onChange={() => toggleMember(u.id)} />
                    <span className="truncate">{u.name} <span className="text-[var(--text-muted)]">@{u.username}</span></span>
                  </label>
                ))}
              </div>
            )}
          </div>

          <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-2">
            <GrantCheckboxes title="Features" options={FEATURE_OPTIONS} value={editing.grants.features} onChange={(v) => setGrant('features', v)} />
            <GrantCheckboxes title="Projects" options={projects} value={editing.grants.projects} onChange={(v) => setGrant('projects', v)} />
            <GrantCheckboxes title="Deployment URLs" options={websites} value={editing.grants.websites} onChange={(v) => setGrant('websites', v)} />
            <GrantCheckboxes title="AI Runtime" options={PROVIDER_OPTIONS} value={editing.grants.providers} onChange={(v) => setGrant('providers', v)} />
          </div>

          {catalog && (
            <div className="mt-3 space-y-3">
              <ActionsMatrix catalog={catalog} value={editing.grants.actions ?? []} onChange={(v) => setGrant('actions', v)} />
              {catalog.capabilities.length > 0 && (
                <GrantCheckboxes title="Capabilities" options={catalog.capabilities.map((c) => ({ id: c.id, name: c.label }))} value={editing.grants.capabilities ?? []} onChange={(v) => setGrant('capabilities', v)} />
              )}
            </div>
          )}

          <div className="mt-4 flex items-center gap-2">
            <button onClick={save} disabled={busy} className="inline-flex items-center gap-2 rounded-md bg-[var(--accent)] px-3 py-2 text-sm font-medium text-white hover:bg-[var(--accent-hover)] disabled:opacity-60">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Save Group
            </button>
            <button onClick={() => setEditing(null)} disabled={busy} className="rounded-md border border-[var(--border)] px-3 py-2 text-sm text-[var(--text-muted)] hover:text-[var(--text-primary)]">Cancel</button>
          </div>
        </div>
      )}

      <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-5 shadow-sm">
        <h3 className="mb-3 font-medium text-[var(--text-primary)]">Access Groups</h3>
        {loading ? (
          <p className="text-sm text-[var(--text-muted)]">Loading…</p>
        ) : groups.length === 0 ? (
          <p className="text-sm text-[var(--text-muted)]">No groups yet. Create one to restrict what a set of users can access.</p>
        ) : (
          <div className="space-y-1.5">
            {groups.map((g) => (
              <div key={g.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-sm">
                <span className="font-medium text-[var(--text-primary)]">{g.name}</span>
                <span className="text-xs text-[var(--text-muted)]">{g.memberUserIds.length} member{g.memberUserIds.length === 1 ? '' : 's'}</span>
                <span className="text-xs text-[var(--text-muted)]">
                  Features {grantSummary(g.grants?.features ?? [])} · Actions {grantSummary(g.grants?.actions ?? [])} · Capabilities {grantSummary(g.grants?.capabilities ?? [])} · Projects {grantSummary(g.grants?.projects ?? [])} · URLs {grantSummary(g.grants?.websites ?? [])} · Providers {grantSummary(g.grants?.providers ?? [])}
                </span>
                <div className="ml-auto flex items-center gap-1">
                  <button onClick={() => startEdit(g)} disabled={busy} title="Edit group" className="rounded p-1.5 text-[var(--text-muted)] hover:text-[var(--accent)] disabled:opacity-30">
                    <Pencil className="h-4 w-4" />
                  </button>
                  <button onClick={() => remove(g)} disabled={busy} title="Delete group" className="rounded p-1.5 text-[var(--text-muted)] hover:text-red-500 disabled:opacity-30">
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
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
        <h2 className="text-lg font-medium">Server Repository Root</h2>
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
  const [runtime, setRuntime] = useState<ProviderInfo | null>(null);
  const [agentModels, setAgentModels] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<SaveStatus>({ type: 'idle', message: '' });
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<SaveStatus>({ type: 'idle', message: '' });
  const [login, setLogin] = useState<DeviceLogin | null>(null);
  const [signingIn, setSigningIn] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/ai/providers');
      const data = await res.json();
      setRuntime((data.providers || [])[0] || null);
      setAgentModels(data.agentModelMap || {});
    } catch {
      setStatus({ type: 'error', message: 'Failed to load the AI runtime' });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Mutations update local state optimistically and do NOT refetch, so changing a model or
  // toggle never flashes the page. We only re-sync from the server when a request fails.
  const save = async (body: Record<string, unknown>, optimistic: Partial<ProviderInfo>, message: string) => {
    setStatus({ type: 'idle', message: '' });
    setRuntime((prev) => (prev ? { ...prev, ...optimistic } : prev));
    const res = await fetch(`/api/ai/providers/${CODEX_RUNTIME}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.ok) setStatus({ type: 'success', message });
    else { setStatus({ type: 'error', message: `Failed to save — ${message.toLowerCase()}` }); load(); }
  };

  const clearKey = async () => {
    if (!await showConfirm('Remove the OpenAI API key? Codex will fall back to your ChatGPT login.', { tone: 'danger' })) return;
    setRuntime((prev) => (prev ? { ...prev, apiKeyMasked: '', apiKeyConfigured: false, authMode: 'account' } : prev));
    const res = await fetch(`/api/ai/providers/${CODEX_RUNTIME}/key`, { method: 'DELETE' });
    if (!res.ok) load();
  };

  const test = async () => {
    setTesting(true);
    setTestResult({ type: 'idle', message: '' });
    try {
      const res = await fetch(`/api/ai/providers/${CODEX_RUNTIME}/test`, { method: 'POST' });
      const data = await res.json();
      setTestResult(data.ok
        ? { type: 'success', message: `Connected · ${data.model || 'default model'}` }
        : { type: 'error', message: `Failed · ${data.error || 'unreachable'}` });
    } catch (error) {
      setTestResult({ type: 'error', message: `Failed · ${error instanceof Error ? error.message : 'unreachable'}` });
    } finally {
      setTesting(false);
    }
  };

  // Device-code sign-in: the admin completes the code in their OWN browser, so a deployed
  // server needs neither a browser nor shell access. We poll until the runtime settles it.
  const startSignIn = async () => {
    setSigningIn(true);
    setStatus({ type: 'idle', message: '' });
    try {
      const res = await fetch('/api/ai/runtime/login', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Could not start sign-in');
      setLogin(data);
    } catch (error) {
      setStatus({ type: 'error', message: error instanceof Error ? error.message : 'Could not start sign-in' });
      setSigningIn(false);
    }
  };

  const cancelSignIn = async (loginId: string) => {
    await fetch(`/api/ai/runtime/login/${loginId}/cancel`, { method: 'POST' }).catch(() => {});
    setLogin(null);
    setSigningIn(false);
  };

  const signOut = async () => {
    if (!await showConfirm('Sign out of the ChatGPT account? Agents stop running until you sign in again.', { tone: 'danger' })) return;
    const res = await fetch('/api/ai/runtime/logout', { method: 'POST' });
    setStatus(res.ok
      ? { type: 'success', message: 'Signed out of Codex' }
      : { type: 'error', message: 'Could not sign out' });
    load();
  };

  useEffect(() => {
    if (!login || login.state !== 'pending') return;
    const timer = setInterval(async () => {
      try {
        const res = await fetch(`/api/ai/runtime/login/${login.loginId}`);
        if (!res.ok) return;
        const data: DeviceLogin = await res.json();
        if (data.state === 'pending') return;
        setLogin(data.state === 'success' ? null : data);
        setSigningIn(false);
        if (data.state === 'success') {
          setStatus({ type: 'success', message: 'Signed in to ChatGPT — Codex is connected' });
          load();
        } else if (data.state === 'error') {
          setStatus({ type: 'error', message: data.error || 'Sign-in did not complete' });
        }
      } catch { /* transient; the next tick retries */ }
    }, 2500);
    return () => clearInterval(timer);
  }, [login, load]);

  const setAgentModel = async (agent: string, model: string) => {
    setAgentModels((prev) => ({ ...prev, [agent]: model }));
    const res = await fetch('/api/ai/agent-provider', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent, model }),
    });
    if (!res.ok) load();
  };

  // Only skeleton on the very first load — a refetch after a save must not unmount the
  // section, or the page flashes and a key being typed is lost.
  if (loading && !runtime) return <SkeletonCard />;
  if (!runtime) return <StatusBanner status={{ type: 'error', message: 'The AI runtime could not be loaded.' }} />;

  const models = [runtime.defaultModel, ...runtime.alternatives];
  const usingApiKey = runtime.authMode === 'api_key';

  return (
    <div className="space-y-6">
      <StatusBanner status={status} />

      <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-4 sm:p-6 shadow-sm">
        <h2 className="text-lg font-medium">AI Runtime</h2>
        <p className="mt-1 text-sm text-[var(--text-muted)]">
          Every agent runs on Codex. <strong>Sign in with ChatGPT</strong> below to connect an account — it works on a
          deployed server too: you get a short code and finish in a browser on your own machine, so the server needs
          neither a browser nor an API key. Subscription turns are not billed per token. Add an OpenAI API key instead
          to run in API-key mode, where spend is tracked under Cost.
        </p>

        <div className="mt-6 rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] p-4">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-md bg-[var(--bg-primary)] text-[var(--accent)]">
              <Bot className="h-5 w-5" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="font-medium">Codex</h3>
                {runtime.callable && runtime.authenticated ? (
                  <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-500">
                    <CheckCircle className="h-3 w-3" /> Active
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-xs text-amber-500">
                    <AlertCircle className="h-3 w-3" /> {runtime.enabled ? 'Not signed in' : 'Disabled'}
                  </span>
                )}
              </div>
              <div className="text-xs text-[var(--text-muted)]">
                {usingApiKey
                  ? runtime.apiKeyMasked ? `API key: ${runtime.apiKeyMasked}` : 'API key mode'
                  : runtime.authenticated ? `Signed in with ${runtime.authMethod === 'apikey' ? 'an API key' : 'a ChatGPT account'}` : (runtime.authError || 'Not signed in')}
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => save({ enabled: !runtime.enabled }, { enabled: !runtime.enabled, callable: !runtime.enabled }, `Runtime ${runtime.enabled ? 'disabled' : 'enabled'}`)}
                className={`inline-flex items-center gap-1 rounded-md border px-3 py-1.5 text-xs font-medium ${
                  runtime.enabled
                    ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-500'
                    : 'border-[var(--border)] bg-[var(--bg-primary)] text-[var(--text-muted)] hover:border-[var(--accent)]'
                }`}
              >
                {runtime.enabled ? 'On' : 'Off'}
              </button>
              <button
                type="button"
                onClick={test}
                disabled={testing}
                className="inline-flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-3 py-1.5 text-xs font-medium hover:border-[var(--accent)] disabled:opacity-50"
              >
                {testing ? 'Testing…' : 'Test connection'}
              </button>
              {runtime.authenticated ? (
                <button type="button" onClick={signOut} className="rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-3 py-1.5 text-xs font-medium text-[var(--text-muted)] hover:border-red-500/40 hover:text-red-500">
                  Sign out
                </button>
              ) : (
                <button
                  type="button"
                  onClick={startSignIn}
                  disabled={signingIn}
                  className="rounded-md border border-[var(--accent)] bg-[var(--accent)]/10 px-3 py-1.5 text-xs font-medium text-[var(--accent)] disabled:opacity-50"
                >
                  {signingIn ? 'Waiting…' : 'Sign in with ChatGPT'}
                </button>
              )}
            </div>
          </div>

          {login && login.state === 'pending' && (
            <div className="mt-4 rounded-lg border border-[var(--accent)]/40 bg-[var(--accent)]/5 p-4">
              <div className="text-sm font-medium">Finish signing in from any browser</div>
              <ol className="mt-2 space-y-2 text-sm text-[var(--text-muted)]">
                <li>
                  1. Open{' '}
                  <a href={login.verificationUrl} target="_blank" rel="noreferrer" className="text-[var(--accent)] underline">
                    {login.verificationUrl}
                  </a>
                </li>
                <li className="flex flex-wrap items-center gap-2">
                  2. Enter this code:
                  <code className="rounded bg-[var(--bg-primary)] px-2 py-1 font-mono text-base tracking-widest text-[var(--text-primary)]">{login.userCode}</code>
                  <button
                    type="button"
                    onClick={() => navigator.clipboard?.writeText(login.userCode)}
                    className="rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 py-1 text-xs"
                  >
                    Copy
                  </button>
                </li>
                <li>3. Approve the request. This page updates on its own.</li>
              </ol>
              <p className="mt-3 text-xs text-[var(--text-muted)]">
                The server never opens a browser — you complete this on your own machine, and the code expires shortly.
              </p>
              <button type="button" onClick={() => cancelSignIn(login.loginId)} className="mt-3 rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-3 py-1.5 text-xs">
                Cancel
              </button>
            </div>
          )}

          {testResult.type !== 'idle' && (
            <div className={`mt-3 text-xs ${testResult.type === 'success' ? 'text-emerald-500' : 'text-red-500'}`}>{testResult.message}</div>
          )}

          <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
            <div>
              <label className="text-xs font-medium text-[var(--text-muted)]">Model</label>
              <select
                value={runtime.model}
                onChange={(e) => save({ model: e.target.value }, { model: e.target.value }, 'Model saved')}
                className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 py-1.5 text-sm"
              >
                {models.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs font-medium text-[var(--text-muted)]">Default reasoning effort</label>
              <select
                value={runtime.effort || 'medium'}
                onChange={(e) => save({ effort: e.target.value }, { effort: e.target.value }, 'Reasoning effort saved')}
                className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 py-1.5 text-sm"
              >
                {['low', 'medium', 'high'].map((e) => <option key={e} value={e}>{e}</option>)}
              </select>
            </div>
          </div>

          <div className="mt-4">
            <label className="text-xs font-medium text-[var(--text-muted)]">OpenAI API key (optional)</label>
            <div className="mt-1 flex flex-wrap gap-2">
              <input
                type={showKey ? 'text' : 'password'}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={runtime.apiKeyMasked || 'Leave empty to use the ChatGPT login'}
                className="min-w-0 flex-1 rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 py-1.5 text-sm"
              />
              <button type="button" onClick={() => setShowKey(!showKey)} className="rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-3 py-1.5 text-xs">
                {showKey ? 'Hide' : 'Show'}
              </button>
              <button
                type="button"
                disabled={!apiKey.trim()}
                onClick={() => {
                  const value = apiKey.trim();
                  const masked = value.length <= 8 ? '****' : `${value.slice(0, 4)}****${value.slice(-4)}`;
                  save({ apiKey: value, authMode: 'api_key' }, { apiKeyMasked: masked, apiKeyConfigured: true, authMode: 'api_key' }, 'API key saved');
                  setApiKey('');
                }}
                className="rounded-md border border-[var(--accent)] bg-[var(--accent)]/10 px-3 py-1.5 text-xs font-medium text-[var(--accent)] disabled:opacity-50"
              >
                Save
              </button>
              {runtime.apiKeyMasked && (
                <button type="button" onClick={clearKey} className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-1.5 text-xs text-red-500">
                  Remove
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-4 sm:p-6 shadow-sm">
        <h2 className="text-lg font-medium">Per-Agent Model</h2>
        <p className="mt-1 text-sm text-[var(--text-muted)]">
          Route a specific agent to a specific Codex model — for example a larger model for the Playwright Coder and a faster one for routine chat.
        </p>
        <div className="mt-4 grid grid-cols-1 gap-2 md:grid-cols-2">
          {Object.keys(AGENT_LABELS).map((agent) => (
            <div key={agent} className="flex items-center justify-between gap-2 rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] p-3">
              <div>
                <div className="text-sm font-medium">{AGENT_LABELS[agent].label}</div>
                <div className="text-xs text-[var(--text-muted)]">{AGENT_LABELS[agent].description}</div>
              </div>
              <select
                value={agentModels[agent] || runtime.model}
                onChange={(e) => setAgentModel(agent, e.target.value)}
                className="rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 py-1 text-xs"
              >
                {models.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
          ))}
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
        body: JSON.stringify({ taskType: taskTypeMap[agent] || 'case', prompt: testInput || 'Generate a Sample Test Case' }),
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
            <div className="mt-3 rounded-lg border border-[var(--accent)]/30 bg-[var(--accent)]/5 p-3 text-xs text-[var(--text-muted)]">
              <div className="font-semibold text-[var(--accent)]">Agent orchestration</div>
              <p className="mt-1">
                A run is planned as a <span className="font-medium text-[var(--text-primary)]">mission</span> — the request decides which agents wake and where the run stops.
                <span className="font-medium text-[var(--text-primary)]"> Maestro</span> supervises but never routes nodes; deterministic graph edges do that.
                Specialists propose, and evidence, critique, compile and human-review gates decide. A specialist can only read facts the coordinator has
                <span className="font-medium text-[var(--text-primary)]"> accepted</span>, never another agent's private reasoning.
              </p>
              <p className="mt-2">
                {ORCHESTRATION_ROSTER.map((a) => AGENT_LABELS[a]?.label?.split(' — ')[0]).filter(Boolean).join(' → ')}
              </p>
            </div>
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
            const inRoster = ORCHESTRATION_ROSTER.includes(p.agent);
            return (
              <div key={p.agent} className="rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)]">
                <button
                  onClick={() => setExpanded(isExpanded ? null : p.agent)}
                  className="flex w-full items-center justify-between gap-3 p-4 text-left"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{meta.label}</span>
                      {inRoster && meta.role && (
                        <span className="inline-flex items-center rounded-full border border-[var(--accent)]/40 bg-[var(--accent)]/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--accent)]">
                          {meta.role}
                        </span>
                      )}
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
                          <div className="mb-1 text-xs font-medium text-[var(--text-muted)]">Active Prompt</div>
                          <pre className="max-h-64 overflow-auto rounded-md border border-[var(--border)] bg-[var(--bg-primary)] p-3 text-xs whitespace-pre-wrap">{p.activeBody}</pre>
                        </div>
                        {p.versions.length > 1 && (
                          <div>
                            <div className="mb-1 text-xs font-medium text-[var(--text-muted)]">Version History</div>
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
                          <div className="mb-1 text-xs font-medium text-[var(--text-muted)]">Test This Agent</div>
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
  /** Keeps a cleared edit field empty instead of immediately restoring the saved mask. */
  passwordEdited?: boolean;
  revealedPassword?: string;
  passwordVisible?: boolean;
  revealing?: boolean;
  useForPlaywright: boolean;
  /** Admin-only: share this URL with the admin's testers. Ignored for tester-owned URLs. */
  shared?: boolean;
  saving?: boolean;
  saved?: CredentialValues;
};

type CredentialValues = Pick<CredRow, 'name' | 'url' | 'username' | 'useForPlaywright' | 'shared'>;

const SAVED_PASSWORD_MASK = '********';

const credentialValues = (row: CredRow): CredentialValues => ({
  name: row.name,
  url: row.url,
  username: row.username,
  useForPlaywright: row.useForPlaywright,
  shared: row.shared === true,
});

const hasCredentialChanges = (row: CredRow) => {
  // A new row has no persisted snapshot. It becomes saveable once it is valid.
  if (!row.saved) return true;

  const current = credentialValues(row);
  return row.password !== ''
    || current.name !== row.saved.name
    || current.url !== row.saved.url
    || current.username !== row.saved.username
    || current.useForPlaywright !== row.saved.useForPlaywright
    || current.shared !== row.saved.shared;
};

const credentialUrlKey = (value: string) => {
  try {
    const url = new URL(value.trim());
    url.hash = '';
    url.search = '';
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    return url.toString().toLowerCase();
  } catch {
    return value.trim().replace(/\/+$/, '').toLowerCase();
  }
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
          const row = {
            key: newKey(),
            websiteId: w.id,
            userId: user?.id,
            name: w.name,
            url: w.baseUrl,
            username: user?.username || '',
            password: '',
            passwordEdited: false,
            revealedPassword: '',
            passwordVisible: false,
            useForPlaywright: user ? !String(user.notes || '').includes('no-playwright') : true,
            shared: (w as any).shared === true,
          } as CredRow;
          return { ...row, saved: credentialValues(row) };
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
      { key: newKey(), name: '', url: '', username: '', password: '', passwordEdited: false, revealedPassword: '', passwordVisible: false, useForPlaywright: true },
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
    if (!r.name.trim() || !r.url.trim() || !r.username.trim() || (!r.userId && !r.password)) return;
    const duplicate = rows.find((candidate) =>
      candidate.key !== r.key
      && credentialUrlKey(candidate.url) === credentialUrlKey(r.url)
      && candidate.username.trim().toLowerCase() === r.username.trim().toLowerCase(),
    );
    if (duplicate) {
      setStatus({ type: 'error', message: 'Credentials for this website and username already exist.' });
      return;
    }
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
          body: JSON.stringify({ name: r.name, baseUrl: r.url, shared: r.shared === true }),
        });
        await failIfNotOk(res, 'Could not update website');
      } else {
        const res = await fetch('/api/credentials/websites', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: r.name, baseUrl: r.url, environment: 'staging', shared: r.shared === true }),
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
        passwordEdited: false,
        saving: false,
        saved: credentialValues(r),
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

        <div className="mt-4 max-h-[min(60dvh,32rem)] space-y-2 overflow-y-auto pr-1">
          {rows.length === 0 && (
            <div className="rounded-lg border border-dashed border-[var(--border)] bg-[var(--bg-secondary)] p-6 text-center text-sm text-[var(--text-muted)]">
              No credentials yet. Click &ldquo;Add Website&rdquo; to store a login.
            </div>
          )}

          {rows.length > 0 && (
            <div className="hidden grid-cols-[1.2fr_1.5fr_1.2fr_1.2fr_auto_auto_auto] gap-2 px-1 text-xs font-medium text-[var(--text-muted)] lg:grid">
              <div>Website Name</div>
              <div>Website URL</div>
              <div>Username / Email</div>
              <div>Password</div>
              <div>Playwright</div>
              {isAdmin() && <div>Share</div>}
              <div>Actions</div>
            </div>
          )}

          {rows.map((r) => {
            const hasSavedPassword = Boolean(r.userId);
            const canSave = Boolean(
              r.name.trim()
              && r.url.trim()
              && r.username.trim()
              && (r.userId || r.password)
              && hasCredentialChanges(r),
            );
            const passwordValue = r.passwordEdited
              ? r.password
              : r.password || (r.passwordVisible ? r.revealedPassword || '' : hasSavedPassword ? SAVED_PASSWORD_MASK : '');
            return (
              <div
                key={r.key}
                className="grid grid-cols-1 items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] p-2 lg:grid-cols-[1.2fr_1.5fr_1.2fr_1.2fr_auto_auto_auto]"
              >
              <input value={r.name} onChange={(e) => patch(r.key, { name: e.target.value })} placeholder="Website name" className="rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 py-1.5 text-sm outline-none focus:border-[var(--accent)]" />
              <input value={r.url} onChange={(e) => patch(r.key, { url: e.target.value })} placeholder="https://app.example.com" className="rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 py-1.5 text-sm outline-none focus:border-[var(--accent)]" />
              <input value={r.username} onChange={(e) => patch(r.key, { username: e.target.value })} placeholder="Username / email" className="rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 py-1.5 text-sm outline-none focus:border-[var(--accent)]" />
              <div className="flex min-w-0 rounded-md border border-[var(--border)] bg-[var(--bg-primary)] focus-within:border-[var(--accent)]">
                <input
                  type={r.passwordVisible ? 'text' : 'password'}
                  value={passwordValue}
                  onChange={(e) => {
                    const next = !r.passwordVisible && hasSavedPassword && !r.password
                      ? e.target.value.replace(SAVED_PASSWORD_MASK, '')
                      : e.target.value;
                    patch(r.key, { password: next, passwordEdited: true });
                  }}
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
                <input type="checkbox" checked={r.useForPlaywright} onChange={(e) => patch(r.key, { useForPlaywright: e.target.checked })} className="accent-[var(--accent)]" />
                <span className="hidden sm:inline">Use for Playwright</span>
              </label>
              {isAdmin() && (
                <label className="flex items-center justify-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 py-1.5 text-xs text-[var(--text-muted)]" title="Share this URL with your testers (tester URLs stay private)">
                  <input type="checkbox" checked={r.shared === true} onChange={(e) => patch(r.key, { shared: e.target.checked })} className="accent-[var(--accent)]" />
                  <span className="hidden sm:inline">Share with Team</span>
                </label>
              )}
              <div className="flex items-center justify-center gap-1">
                <button
                  type="button"
                  onClick={() => saveRow(r.key)}
                  disabled={!canSave || r.saving}
                  title="Save credential"
                  className="rounded-md bg-[var(--accent)] p-2 text-white hover:bg-[var(--accent-hover)] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {r.saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                </button>
                <button type="button" onClick={() => deleteRow(r.key)} disabled={r.saving} title="Delete" className="rounded-md border border-[var(--border)] bg-[var(--bg-primary)] p-2 text-[var(--text-muted)] hover:border-red-500 hover:text-red-500 disabled:cursor-not-allowed disabled:opacity-50">
                  <Trash2 className="h-4 w-4" />
                </button>
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
  { key: 'week', capKey: 'week', label: 'Last 7 Days' },
  { key: 'month', capKey: 'month', label: 'Last 30 Days' },
  { key: 'year', capKey: 'year', label: 'Last 365 Days' },
  { key: 'all', capKey: '', label: 'All Time' },
];
const fmtInt = (n: number) => Number(n || 0).toLocaleString();
const fmtUsd = (n: number) => `$${Number(n || 0).toFixed(Number(n) >= 1 ? 2 : 4)}`;
type SpendCaps = { day: number; week: number; month: number; year: number };
const SPEND_CAP_FIELDS: Array<{ k: keyof SpendCaps; label: string }> = [
  { k: 'day', label: 'Per Day' },
  { k: 'week', label: 'Per 7 Days' },
  { k: 'month', label: 'Per 30 Days' },
  { k: 'year', label: 'Per 365 Days' },
];
const sameSpendCaps = (left: SpendCaps, right: SpendCaps) => SPEND_CAP_FIELDS.every(({ k }) => left[k] === right[k]);

function CostSection() {
  const { showQueryLogs, load: loadUiSettings, setShowQueryLogs } = useUiSettings();
  useEffect(() => { void loadUiSettings(); }, [loadUiSettings]);
  const [cost, setCost] = useState<{ guardrailLogs: any[] }>({ guardrailLogs: [] });
  const [summary, setSummary] = useState<any>(null);
  const [usage, setUsage] = useState<any[]>([]);
  const [caps, setCaps] = useState<SpendCaps>({ day: 50, week: 0, month: 0, year: 0 });
  const [savedCaps, setSavedCaps] = useState<SpendCaps>({ day: 50, week: 0, month: 0, year: 0 });
  const [savingCaps, setSavingCaps] = useState(false);
  const [capsSaveError, setCapsSaveError] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      const [c, s, u] = await Promise.all([
        fetch('/api/ai/cost').then(async (r) => {
          const data = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(data?.error || 'Could not load cost details.');
          return data;
        }),
        fetch('/api/ai/usage/summary').then(async (r) => {
          const data = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(data?.error || 'Could not load usage summary.');
          return data;
        }),
        fetch('/api/ai/usage').then(async (r) => {
          const data = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(data?.error || 'Could not load usage history.');
          return data;
        }),
      ]);
      setCost(c);
      setSummary(s);
      setUsage(u.usage || []);
      if (s?.caps) {
        setCaps(s.caps);
        setSavedCaps(s.caps);
      }
    } catch (error: any) {
      setLoadError(error?.message || 'Could not load Cost & Logs.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const saveCaps = async () => {
    if (savingCaps || sameSpendCaps(caps, savedCaps)) return;
    setSavingCaps(true);
    setCapsSaveError('');
    try {
      const res = await fetch('/api/ai/cost/caps', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(caps),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || 'Could not save spend caps.');
      const saved = data?.caps as SpendCaps | undefined;
      if (saved) {
        setCaps(saved);
        setSavedCaps(saved);
      } else {
        setSavedCaps(caps);
      }
      await load();
    } catch (error: any) {
      setCapsSaveError(error?.message || 'Could not save spend caps.');
    } finally {
      setSavingCaps(false);
    }
  };

  if (loading) return <SkeletonCard />;
  if (loadError || !summary) {
    return (
      <div className="rounded-xl border border-red-500/30 bg-[var(--bg-card)] p-5 shadow-sm">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-medium">Cost & Logs Unavailable</h2>
            <p className="mt-1 text-sm text-[var(--text-muted)]">{loadError || 'The cost summary did not return usable data.'}</p>
          </div>
          <button onClick={() => void load()} className="inline-flex shrink-0 items-center gap-2 rounded-md border border-[var(--border)] px-3 py-2 text-sm hover:bg-[var(--bg-secondary)]">
            <RefreshCw className="h-4 w-4" /> Retry
          </button>
        </div>
      </div>
    );
  }

  const windows = summary.windows || {};
  const capStatus = summary.capStatus || {};
  const byModel: any[] = summary.byModel || [];
  const allTime = windows.all || emptyWin;
  const capsDirty = !sameSpendCaps(caps, savedCaps);

  return (
    <div className="space-y-6">
      {/* Chat log visibility: gates the per-query "Background communication" panels in the Agent Console. */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-4 sm:p-6 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-medium">Chat Logs</h2>
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
        <p className="mt-1 text-sm text-[var(--text-muted)]">Your AI usage and estimated cost, priced from each provider's official rates for the model used.</p>
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
        <h2 className="text-lg font-medium">Tokens by Type (All Time)</h2>
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            { k: 'inputTokens', label: 'Input' },
            { k: 'outputTokens', label: 'Output' },
            { k: 'cacheReadTokens', label: 'Cache Read' },
            { k: 'cacheWriteTokens', label: 'Cache Write' },
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
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-medium">Spend Caps</h2>
            <p className="mt-1 text-sm text-[var(--text-muted)]">Set a USD cap per window. 0 means no cap. The daily cap also gates new agent runs.</p>
          </div>
          <button
            onClick={saveCaps}
            disabled={!capsDirty || savingCaps}
            title={!capsDirty ? 'Change a spend cap to enable saving' : undefined}
            className="inline-flex shrink-0 items-center gap-1 rounded-md bg-[var(--accent)] px-3 py-2 text-xs font-medium text-white hover:bg-[var(--accent-hover)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Save className="h-3 w-3" /> {savingCaps ? 'Saving capsâ€¦' : 'Save Caps'}
          </button>
        </div>
        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {SPEND_CAP_FIELDS.map(({ k, label }) => (
            <div key={k}>
              <label className="mb-1 block text-xs text-[var(--text-muted)]">{label} (USD)</label>
              <input
                type="number" min="0" step="1"
                value={caps[k]}
                onChange={(e) => {
                  setCaps((current) => ({ ...current, [k]: Number(e.target.value) }));
                  setCapsSaveError('');
                }}
                className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-3 py-2 text-sm"
              />
            </div>
          ))}
        </div>
        {capsSaveError && <p className="mt-3 text-xs text-red-500">{capsSaveError}</p>}
      </div>

      {/* Per-model breakdown. */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-4 sm:p-6 shadow-sm">
        <h2 className="text-lg font-medium">Your usage by model (all time)</h2>
        <div className="mt-3 max-h-96 overflow-auto">
          <table className="w-full text-sm whitespace-nowrap">
            <thead className="sticky top-0 z-10 bg-[var(--bg-card)] text-xs text-[var(--text-muted)]">
              <tr>
                <th className="px-2 py-1 text-left">Model</th>
                <th className="px-2 py-1 text-right">Input</th>
                <th className="px-2 py-1 text-right">Output</th>
                <th className="px-2 py-1 text-right">Cache Read</th>
                <th className="px-2 py-1 text-right">Cache Write</th>
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
                <th className="px-2 py-1 text-right">Cache R/W</th>
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
