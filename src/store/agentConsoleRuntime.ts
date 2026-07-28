import { create } from 'zustand';

type TurnUpdater = unknown[] | ((previous: any[]) => any[]);

interface ConsoleRuntimeState {
  sessions: Record<string, { turns: any[]; busy: boolean }>;
  setTurns: (conversationId: string, update: TurnUpdater) => void;
  setBusy: (conversationId: string, busy: boolean) => void;
}

/**
 * In-memory runtime state intentionally lives above routed pages. It contains no credentials and
 * is kept separate from durable conversation storage, which remains the server-side source of truth.
 */
export const useAgentConsoleRuntime = create<ConsoleRuntimeState>((set) => ({
  sessions: {},
  setTurns: (conversationId, update) => set((state) => {
    const previous = state.sessions[conversationId] || { turns: [], busy: false };
    const turns = typeof update === 'function' ? update(previous.turns) : update;
    return { sessions: { ...state.sessions, [conversationId]: { ...previous, turns } } };
  }),
  setBusy: (conversationId, busy) => set((state) => {
    const previous = state.sessions[conversationId] || { turns: [], busy: false };
    return { sessions: { ...state.sessions, [conversationId]: { ...previous, busy } } };
  }),
}));
