import { create } from 'zustand';
import type { AgentExecutionSnapshot, AgentSessionSnapshot } from '@/src/lib/agentSession/types';

const STORAGE_KEY = 'tfa_agent_session_manager_v1';

type PersistedState = Pick<AgentSessionState, 'sessions' | 'executions' | 'activeSessionId'>;

function readPersisted(): Partial<PersistedState> {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value ? JSON.parse(value) : {};
  } catch { return {}; }
}

function persist(state: PersistedState): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, ...state })); } catch { /* quota/private mode */ }
}

interface AgentSessionState {
  hydrated: boolean;
  activeSessionId: string | null;
  sessions: Record<string, AgentSessionSnapshot>;
  executions: Record<string, AgentExecutionSnapshot>;
  hydrate: () => void;
  upsertSession: (session: AgentSessionSnapshot) => void;
  upsertExecution: (execution: AgentExecutionSnapshot) => void;
  setActiveSession: (id: string | null) => void;
  removeSession: (id: string) => void;
}

function persisted(state: AgentSessionState): PersistedState {
  return { sessions: state.sessions, executions: state.executions, activeSessionId: state.activeSessionId };
}

export const useAgentSessionStore = create<AgentSessionState>((set, get) => ({
  hydrated: false,
  activeSessionId: null,
  sessions: {},
  executions: {},
  hydrate: () => {
    if (get().hydrated) return;
    const saved = readPersisted();
    set({ hydrated: true, sessions: saved.sessions || {}, executions: saved.executions || {}, activeSessionId: saved.activeSessionId || null });
  },
  upsertSession: (session) => set((state) => {
    const next = { ...state, sessions: { ...state.sessions, [session.id]: session } };
    persist(persisted(next));
    return next;
  }),
  upsertExecution: (execution) => set((state) => {
    const next = { ...state, executions: { ...state.executions, [execution.id]: execution } };
    persist(persisted(next));
    return next;
  }),
  setActiveSession: (id) => set((state) => {
    const next = { ...state, activeSessionId: id };
    persist(persisted(next));
    return next;
  }),
  removeSession: (id) => set((state) => {
    const session = state.sessions[id];
    const sessions = { ...state.sessions };
    delete sessions[id];
    const executions = { ...state.executions };
    session?.executionIds.forEach((executionId) => delete executions[executionId]);
    const next = { ...state, sessions, executions, activeSessionId: state.activeSessionId === id ? null : state.activeSessionId };
    persist(persisted(next));
    return next;
  }),
}));
