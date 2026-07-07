import { useCallback, useEffect, useRef, useState } from 'react';
import { withEventSourceAuth } from '@/src/lib/base-path';

const TERMINAL = ['completed', 'failed', 'review_required', 'coverage_options', 'cancelled'];

export function useAgentRun(runId: string) {
  const [run, setRun] = useState<any>(null);
  const activeRef = useRef(true);

  const fetchDetails = useCallback(async () => {
    if (!runId) return null;
    const r = await fetch(`/api/agent-runs/${runId}/details`, { cache: 'no-store' });
    if (!r.ok) throw new Error(r.status === 404 ? 'This agent run is no longer available. Start a new run to continue.' : `Failed to load run (${r.status}).`);
    const data = await r.json();
    if (activeRef.current) setRun(data);
    return data;
  }, [runId]);

  const applyStatus = useCallback((data: any) => {
    if (!activeRef.current) return;
    setRun((prev: any) => ({ ...(prev || {}), ...data }));
    if (TERMINAL.includes(data?.status)) void fetchDetails().catch(() => undefined);
  }, [fetchDetails]);

  const pollStatus = useCallback(async () => {
    if (!activeRef.current || !runId) return;
    try {
      const r = await fetch(`/api/agent-runs/${runId}/status`, { cache: 'no-store' });
      if (!r.ok) throw new Error(`Failed to load run (${r.status}).`);
      const data = await r.json();
      applyStatus(data);
      if (!TERMINAL.includes(data?.status) && activeRef.current) {
        window.setTimeout(pollStatus, document.hidden ? 30000 : 5000);
      }
    } catch (error: any) {
      if (activeRef.current) {
        setRun((prev: any) => prev || {
          id: runId,
          status: 'failed',
          messages: [{ agent: 'System', status: 'failed', output: error?.message || 'Failed to reach the backend for this run.' }],
          generated_cases: [],
          playwright_scripts: [],
          evidence_screenshots: [],
        });
      }
    }
  }, [runId, applyStatus]);

  useEffect(() => {
    activeRef.current = true;
    let es: EventSource | null = null;
    let fallback: number | undefined;
    let settled = false;
    void fetchDetails().catch(() => pollStatus());
    try {
      es = new EventSource(withEventSourceAuth(`/api/agent-runs/${runId}/events`));
      es.addEventListener('status', (ev) => applyStatus(JSON.parse((ev as MessageEvent).data)));
      es.addEventListener('done', (ev) => {
        settled = true;
        applyStatus(JSON.parse((ev as MessageEvent).data));
        es?.close();
      });
      es.onerror = () => {
        if (settled) return;
        es?.close();
        if (activeRef.current && !fallback) fallback = window.setTimeout(pollStatus, 3000);
      };
    } catch {
      fallback = window.setTimeout(pollStatus, 3000);
    }
    return () => {
      activeRef.current = false;
      es?.close();
      if (fallback) window.clearTimeout(fallback);
    };
  }, [runId, applyStatus, fetchDetails, pollStatus]);

  return { run, setRun, refreshRun: fetchDetails, pollStatus };
}
