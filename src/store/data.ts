import { create } from 'zustand';

// Global data-version counter: bump it after any create/update/delete so open list views refetch.
interface DataVersionState {
  version: number;
  invalidate: () => void;
}

export const useDataVersion = create<DataVersionState>((set) => ({
  version: 0,
  invalidate: () => set((s) => ({ version: s.version + 1 })),
}));

// Non-hook helper so plain functions (event handlers, services) can signal data changes.
export const invalidateData = () => useDataVersion.getState().invalidate();
