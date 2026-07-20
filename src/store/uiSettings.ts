import { create } from 'zustand';

// UI preferences persisted in the backend key/value settings (GET/POST /api/settings).
interface UiSettingsState {
  // Show the per-query "Background communication" log panels in the Agent Console chat.
  showQueryLogs: boolean;
  loaded: boolean;
  load: () => Promise<void>;
  setShowQueryLogs: (value: boolean) => void;
}

export const useUiSettings = create<UiSettingsState>((set, get) => ({
  showQueryLogs: true,
  loaded: false,
  load: async () => {
    if (get().loaded) return;
    set({ loaded: true }); // guard against concurrent loads before the fetch settles
    try {
      const res = await fetch('/api/settings');
      if (!res.ok) return;
      const settings = await res.json();
      set({ showQueryLogs: settings?.showQueryLogs !== false }); // default ON when unset
    } catch { /* keep defaults offline */ }
  },
  setShowQueryLogs: (value) => {
    set({ showQueryLogs: value }); // optimistic; generic settings POST merges the key
    void fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ showQueryLogs: value }),
    }).catch(() => {});
  },
}));
