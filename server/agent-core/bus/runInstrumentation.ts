/**
 * Live-run instrumentation (Phase 1 cutover) — records the graph runtime's stage transitions onto the
 * coordination bus + blackboard so a real run populates the A2A substrate.
 *
 * SHADOW / observability only: it records what the existing graph already decided; it changes NO control
 * flow and makes NO decision. Flag-gated by AGENT_NATIVE_V1 (off → no-op) and fully best-effort — any bus/
 * blackboard hiccup is swallowed so a run can never be affected by instrumentation. This is the first live
 * consumer of the Phase 1 substrate; it proves the bus/blackboard end-to-end against the SUT before any
 * decision-bearing agent is migrated onto them.
 */
import { isAgentNativeEnabled } from '../agentNativeFlag';
import { getMessageBus } from './messageBus';
import { getBlackboard } from './blackboard';

/**
 * Emit one transition when a run advances to a new stage. `prevStage` is the stage we were on (null at
 * start). Best-effort + flag-gated. Awaited so per-run seq ordering is deterministic, but it never throws.
 */
export async function recordRunStageTransition(
  runId: string,
  stage: string,
  status: string,
  prevStage: string | null,
): Promise<void> {
  if (!isAgentNativeEnabled()) return;
  try {
    // HANDOFF: the run handed off from prevStage → stage (broadcast; any observer/agent can read it).
    await getMessageBus().publish({
      runId, from: 'workflow', to: null, type: 'HANDOFF',
      payload: { stage, status, prevStage },
    });
    // Blackboard fact: the current run stage (append-only history of the run's progression).
    await getBlackboard().put(runId, 'run.stage', { stage, status, prevStage }, 'workflow');
  } catch (err) {
    console.warn(`[run-instrumentation] failed to record stage '${stage}' for run ${runId} (non-fatal):`, (err as Error)?.message);
  }
}
