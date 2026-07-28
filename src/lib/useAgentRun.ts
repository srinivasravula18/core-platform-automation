import { useCallback, useEffect } from 'react';
import { useAgentSessionManager } from '@/src/lib/agentSession/AgentSessionProvider';
import { useAgentSessionStore } from '@/src/store/agentSession';

/**
 * View adapter for a durable agent run. The manager, not this component, owns the EventSource
 * and reconnect lifecycle, so unmounting a routed card never stops backend work or monitoring.
 */
export function useAgentRun(runId: string) {
  const manager = useAgentSessionManager();
  const execution = useAgentSessionStore((state) => Object.values(state.executions)
    .find((item) => item.serverId === runId && item.kind === 'agent-run'));
  const executionId = execution?.id || '';
  // Run payloads are intentionally backend-extensible; preserve the legacy hook's `any` contract.
  const run: any = execution?.progress || null;

  useEffect(() => {
    if (!runId) return;
    manager.observeRun(runId);
  }, [runId, manager]);

  useEffect(() => {
    if (!executionId) return;
    void manager.refreshRun(executionId).catch(() => {});
  }, [executionId, manager]);

  const setRun = useCallback((update: any | ((previous: any) => any)) => {
    if (executionId) manager.updateRun(executionId, update);
  }, [executionId, manager]);
  const refreshRun = useCallback(() => executionId ? manager.refreshRun(executionId) : Promise.resolve(null), [executionId, manager]);
  const pollStatus = refreshRun;
  return { run, setRun, refreshRun, pollStatus };
}
