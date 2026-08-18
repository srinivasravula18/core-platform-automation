import { useCallback, useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type Loadable<T> = {
  data: T | null;
  error: string | null;
  errorCode: string;
  loading: boolean;
  reload: () => void;
};

/** Fetch on mount and on an interval while `live`; never overlaps requests. */
export const usePolled = <T>(loader: () => Promise<T>, deps: unknown[], intervalMs: number, live = true): Loadable<T> => {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState('');
  const [loading, setLoading] = useState(true);
  const inFlight = useRef(false);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  const run = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const result = await loaderRef.current();
      setData(result);
      setError(null);
      setErrorCode('');
    } catch (cause) {
      setError((cause as Error).message);
      setErrorCode((cause as { code?: string }).code || '');
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    if (!live || intervalMs <= 0) return;
    const timer = setInterval(() => void run(), intervalMs);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, intervalMs, ...deps]);

  return { data, error, errorCode, loading, reload: run };
};

export type TimeRange = { from: string; to: string };

interface VitalsViewState {
  range: TimeRange;
  refreshMs: number;
  live: boolean;
  setRange: (range: TimeRange) => void;
  setRefreshMs: (ms: number) => void;
  setLive: (live: boolean) => void;
}

/** Time range, refresh interval and live/paused are shared by every Vitals page and persisted. */
export const useVitalsView = create<VitalsViewState>()(
  persist(
    (set) => ({
      range: { from: 'now-1h', to: 'now' },
      refreshMs: 30_000,
      live: true,
      setRange: (range) => set({ range }),
      setRefreshMs: (refreshMs) => set({ refreshMs }),
      setLive: (live) => set({ live }),
    }),
    { name: 'vitals-view' },
  ),
);
