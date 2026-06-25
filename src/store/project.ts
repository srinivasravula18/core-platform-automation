import { create } from 'zustand';

export type RepoKind = 'local' | 'remote';
export type SyncStatus = 'idle' | 'connecting' | 'syncing' | 'ready' | 'error';

export interface ProjectApp {
  id: string;
  projectId: string;
  name: string;
  slug: string;
  description?: string;
  baseUrl?: string;
  environment?: string;
  /** How this app's metadata catalog is grounded. Default 'swagger' (metadata-driven apps). */
  catalogStrategy?: 'swagger' | 'api' | 'source' | 'none';
  /** Path to the app's OpenAPI spec (probed if unset). Default '/api/openapi.json'. */
  specPath?: string;
  repoSubpath?: string;
  searchRoots?: Record<string, string>;
  knowledgePackId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Project {
  id: string;
  name: string;
  slug: string;
  description?: string;
  repoKind: RepoKind;
  repoPath?: string;
  repoUrl?: string;
  defaultBranch?: string;
  lastSyncedSha?: string;
  syncStatus: SyncStatus;
  lastError?: string;
  /** Whether a private-repo access token is stored server-side. The token itself is never sent to the client. */
  hasToken?: boolean;
  createdAt: string;
  updatedAt: string;
  apps: ProjectApp[];
}

/** Project create/update payload, plus write-only credential fields never read back. */
export type ProjectInput = Partial<Project> & {
  /** A private-repo access token to store (encrypted server-side). Omit to leave unchanged. */
  repoToken?: string;
  /** Set true to remove the stored token. */
  removeToken?: boolean;
};

const SEL_PROJECT_KEY = 'tfa_project_id';
const SEL_APP_KEY = 'tfa_app_id';

function readLS(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeLS(key: string, val: string | null) {
  try {
    if (val === null) localStorage.removeItem(key);
    else localStorage.setItem(key, val);
  } catch {
    /* ignore */
  }
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as any)?.error || `Request failed (${res.status})`);
  return data as T;
}

interface ProjectState {
  projects: Project[];
  selectedProjectId: string | null;
  /** null = project-level (all apps / cross-app). */
  selectedAppId: string | null;
  loading: boolean;
  loaded: boolean;
  error: string | null;

  fetchProjects: () => Promise<void>;
  selectProject: (id: string | null) => void;
  selectApp: (id: string | null) => void;

  createProject: (input: ProjectInput) => Promise<Project>;
  updateProject: (id: string, input: ProjectInput) => Promise<void>;
  deleteProject: (id: string) => Promise<void>;
  createApp: (projectId: string, input: Partial<ProjectApp>) => Promise<ProjectApp>;
  updateApp: (id: string, input: Partial<ProjectApp>) => Promise<void>;
  deleteApp: (id: string) => Promise<void>;

  selectedProject: () => Project | null;
  selectedApp: () => ProjectApp | null;
}

export const useProjects = create<ProjectState>((set, get) => ({
  projects: [],
  selectedProjectId: readLS(SEL_PROJECT_KEY),
  selectedAppId: readLS(SEL_APP_KEY),
  loading: false,
  loaded: false,
  error: null,

  fetchProjects: async () => {
    set({ loading: true, error: null });
    try {
      const { projects } = await api<{ projects: Project[] }>('/api/projects');
      // Reconcile the persisted selection against what still exists.
      let { selectedProjectId, selectedAppId } = get();
      if (!selectedProjectId || !projects.some((p) => p.id === selectedProjectId)) {
        selectedProjectId = projects[0]?.id ?? null;
        selectedAppId = null;
      }
      const proj = projects.find((p) => p.id === selectedProjectId);
      if (selectedAppId && !proj?.apps.some((a) => a.id === selectedAppId)) {
        selectedAppId = null;
      }
      writeLS(SEL_PROJECT_KEY, selectedProjectId);
      writeLS(SEL_APP_KEY, selectedAppId);
      set({ projects, selectedProjectId, selectedAppId, loading: false, loaded: true });
    } catch (e: any) {
      set({ loading: false, loaded: true, error: e?.message || 'Failed to load projects.' });
    }
  },

  selectProject: (id) => {
    writeLS(SEL_PROJECT_KEY, id);
    writeLS(SEL_APP_KEY, null);
    set({ selectedProjectId: id, selectedAppId: null });
  },

  selectApp: (id) => {
    writeLS(SEL_APP_KEY, id);
    set({ selectedAppId: id });
  },

  createProject: async (input) => {
    const project = await api<Project>('/api/projects', { method: 'POST', body: JSON.stringify(input) });
    await get().fetchProjects();
    get().selectProject(project.id);
    return project;
  },

  updateProject: async (id, input) => {
    await api(`/api/projects/${id}`, { method: 'PUT', body: JSON.stringify(input) });
    await get().fetchProjects();
  },

  deleteProject: async (id) => {
    await api(`/api/projects/${id}`, { method: 'DELETE' });
    if (get().selectedProjectId === id) {
      writeLS(SEL_PROJECT_KEY, null);
      writeLS(SEL_APP_KEY, null);
      set({ selectedProjectId: null, selectedAppId: null });
    }
    await get().fetchProjects();
  },

  createApp: async (projectId, input) => {
    const created = await api<ProjectApp>(`/api/projects/${projectId}/apps`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
    await get().fetchProjects();
    if (get().selectedProjectId === projectId) get().selectApp(created.id);
    return created;
  },

  updateApp: async (id, input) => {
    await api(`/api/apps/${id}`, { method: 'PUT', body: JSON.stringify(input) });
    await get().fetchProjects();
  },

  deleteApp: async (id) => {
    await api(`/api/apps/${id}`, { method: 'DELETE' });
    if (get().selectedAppId === id) get().selectApp(null);
    await get().fetchProjects();
  },

  selectedProject: () => {
    const { projects, selectedProjectId } = get();
    return projects.find((p) => p.id === selectedProjectId) ?? null;
  },

  selectedApp: () => {
    const proj = get().selectedProject();
    const { selectedAppId } = get();
    return proj?.apps.find((a) => a.id === selectedAppId) ?? null;
  },
}));
