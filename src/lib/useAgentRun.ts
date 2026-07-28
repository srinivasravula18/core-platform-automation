import { useCallback, useEffect, useRef, useState } from 'react';
import { withEventSourceAuth } from '@/src/lib/base-path';

const TERMINAL = ['completed', 'failed', 'review_required', 'coverage_options', 'cancelled'];

// Stop polling a non-terminal run after this long with no observable change (stall guard).
const STALL_MS = 15 * 60 * 1000;

export function useAgentRun(runId: string) {
  const [run, setRun] = useState<any>(null);
  const activeRef = useRef(true);
  const lastChangeAtRef = useRef(Date.now());
  const lastFingerprintRef = useRef('');

  // Track whether the run visibly progressed (status or message stream changed) to feed the stall guard.
  const noteActivity = useCallback((data: any) => {
    const messages = Array.isArray(data?.messages) ? data.messages : [];
    const fingerprint = `${data?.status ?? ''}|${messages.length}|${JSON.stringify(messages[messages.length - 1] ?? null)}`;
    if (fingerprint !== lastFingerprintRef.current) {
      lastFingerprintRef.current = fingerprint;
      lastChangeAtRef.current = Date.now();
    }
  }, []);

  const fetchDetails = useCallback(async () => {
    if (!runId) return null;
    const r = await fetch(`/api/agent-runs/${runId}/details`, { cache: 'no-store' });
    if (!r.ok) throw new Error(r.status === 404 ? 'This agent run is no longer available. Start a new run to continue.' : `Failed to load run (${r.status}).`);
    const data = await r.json();
    if (activeRef.current) setRun(data);
    return data;
  }, [runId]);

  // Artifact counts from the last status payload — when they grow mid-run (scripts compiled,
  // evidence captured), the slim status stream doesn't carry the arrays, so refetch full details.
  const lastCountsRef = useRef('');

  const applyStatus = useCallback((data: any) => {
    if (!activeRef.current) return;
    noteActivity(data);
    setRun((prev: any) => ({ ...(prev || {}), ...data }));
    const c = data?.counts;
    const countsSig = c ? `${c.cases ?? 0}|${c.scripts ?? 0}|${c.evidence ?? 0}` : '';
    const countsGrew = countsSig !== '' && countsSig !== lastCountsRef.current;
    if (countsSig !== '') lastCountsRef.current = countsSig;
    if (TERMINAL.includes(data?.status) || countsGrew) void fetchDetails().catch(() => undefined);
  }, [fetchDetails, noteActivity]);

  const pollStatus = useCallback(async () => {
    if (!activeRef.current || !runId) return;
    try {
      const r = await fetch(`/api/agent-runs/${runId}/status`, { cache: 'no-store' });
      if (!r.ok) throw new Error(`Failed to load run (${r.status}).`);
      const data = await r.json();
      applyStatus(data);
      if (!TERMINAL.includes(data?.status) && activeRef.current) {
        // Stall guard: a non-terminal run with no visible change for STALL_MS stops polling forever.
        if (Date.now() - lastChangeAtRef.current > STALL_MS) {
          console.warn(`[useAgentRun] run ${runId} appears stalled (no change for ${Math.round(STALL_MS / 60000)} min); stopping polling.`);
          setRun((prev: any) => ({
            ...(prev || {}),
            status: 'stalled',
            messages: [
              ...(Array.isArray(prev?.messages) ? prev.messages : []),
              { agent: 'System', status: 'failed', output: 'This run appears stalled: no progress was observed for 15 minutes. Polling stopped — start a new run or refresh to retry.' },
            ],
          }));
          return;
        }
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
    lastChangeAtRef.current = Date.now();
    lastFingerprintRef.current = '';
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
