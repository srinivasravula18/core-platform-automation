import path from 'path';
import fs from 'fs/promises';

export const db: any = {
  folders: [] as any[],
  plans: [] as any[],
  suites: [] as any[],
  cases: [] as any[],
  runs: [] as any[],
  defects: [] as any[],
  scripts: [] as any[],
  agentRuns: [] as any[],
  recentActivity: [] as any[],
  settings: {
    geminiModel: 'gemini-2.5-flash',
    siteCredentials: [] as any[],
    providerSettings: {
      gemini: { apiKey: '', model: '' },
      openai: { apiKey: '', model: '' },
      anthropic: { apiKey: '', model: '' },
    } as Record<'gemini' | 'openai' | 'anthropic', { apiKey: string; model: string }>,
    defaultProvider: 'gemini' as 'gemini' | 'openai' | 'anthropic',
    agentProviderMap: {} as Record<string, 'gemini' | 'openai' | 'anthropic'>,
    agentModelMap: {} as Record<string, string>,
    dailyCostLimit: 50,
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
  };
}

export async function loadPersistedData() {
  try {
    const raw = (await fs.readFile(dataFilePath, 'utf-8')).replace(/^\uFEFF/, '');
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
  } catch (error: any) {
    if (error?.code !== 'ENOENT') {
      console.error(`Failed to load persisted data from ${dataFilePath}:`, error);
    }
  }
}

export async function savePersistedData() {
  await fs.writeFile(dataFilePath, JSON.stringify(getPersistableDbSnapshot(), null, 2), 'utf-8');
}

export async function loadPersistedSettings() {
  try {
    const raw = await fs.readFile(settingsFilePath, 'utf-8');
    const settings = JSON.parse(raw);
    db.settings = {
      ...db.settings,
      ...settings,
      siteCredentials: Array.isArray(settings.siteCredentials) ? settings.siteCredentials : [],
      providerSettings: settings.providerSettings || db.settings.providerSettings,
      defaultProvider: settings.defaultProvider || db.settings.defaultProvider,
      agentProviderMap: settings.agentProviderMap || db.settings.agentProviderMap,
      agentModelMap: settings.agentModelMap || db.settings.agentModelMap,
      dailyCostLimit: typeof settings.dailyCostLimit === 'number' ? settings.dailyCostLimit : db.settings.dailyCostLimit,
      autonomyLevel: settings.autonomyLevel || db.settings.autonomyLevel,
    };
  } catch {
    // Missing settings file is valid on first run.
  }
}

export async function savePersistedSettings() {
  await fs.writeFile(settingsFilePath, JSON.stringify(db.settings, null, 2), 'utf-8');
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

export function addActivity(message: string) {
  db.recentActivity.unshift({ message, time: 'Just now' });
  if (db.recentActivity.length > 6) db.recentActivity.length = 6;
  persistDataInBackground('activity log');
}
