import path from 'path';
import fs from 'fs/promises';

export const db = {
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
  },
  reports: [] as any[],
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
  } catch (error: any) {
    if (error?.code !== 'ENOENT') {
      console.error(`Failed to load persisted data from ${dataFilePath}:`, error);
    }
    // Missing data file is valid on first run.
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

export function addActivity(message: string) {
  db.recentActivity.unshift({ message, time: 'Just now' });
  if (db.recentActivity.length > 6) db.recentActivity.length = 6;
  persistDataInBackground('activity log');
}
