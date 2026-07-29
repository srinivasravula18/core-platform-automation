/**
 * Run orchestration (Phase 3) — the orchestrator DELEGATES the run's plan over the bus instead of a stage
 * label being stamped on a switch.
 *
 * At run start the orchestrator asks the router agent to produce a routing plan, VALIDATES it against the
 * agent registry (unknown agents are dropped, never dispatched — killing the "declared-but-no-handler"
 * drift), then publishes the plan as real A2A traffic: a REQUEST to the router, the router's RESULT, and one
 * DELEGATE per planned specialist, plus a `routing.plan` blackboard fact any agent can read. This is a
 * genuine decision-bearing exchange the console renders — the orchestrator deciding who does what.
 *
 * Deterministic executor preserved: the LangGraph pipeline still RUNS the stages (correctness stays
 * deterministic); this layer makes the DELEGATION explicit and observable. Flag-gated by AGENT_NATIVE_V1
 * (off → no-op) and best-effort — it is fired at run start and never blocks or fails the run.
 */
import { isAgentNativeEnabled } from '../agentNativeFlag';
import { getMessageBus } from '../bus/messageBus';
import { getBlackboard } from '../bus/blackboard';
import { routeRequest, type RoutingClassifier, type RoutingPlan } from './routerAgent';
import type { AgentRegistry } from '../registry/agents';

const ORCHESTRATOR = 'orchestrator';
const ROUTER = 'router';

export interface OrchestrateRunStartInput {
  runId: string;
  goal: string;
  /** Optional prior context (understanding/blackboard summary) the router may weigh — advisory. */
  context?: string;
  // Seams (tests / alternate wiring) — default to the live router + registry.
  classify?: RoutingClassifier;
  agents?: AgentRegistry;
}

/**
 * Publish the orchestrator's routing delegation for a run and return the registry-validated plan (or null
 * when the flag is off / nothing routable). Never throws — a substrate hiccup or router failure degrades to
 * the deterministic graph, which is the executor regardless.
 */
export async function orchestrateRunStart(input: OrchestrateRunStartInput): Promise<RoutingPlan | null> {
  if (!isAgentNativeEnabled()) return null;
  try {
    const bus = getMessageBus();
    const blackboard = getBlackboard();

    // 1. Orchestrator REQUESTs a plan from the router.
    const request = await bus.publish({
      runId: input.runId, from: ORCHESTRATOR, to: ROUTER, type: 'REQUEST',
      payload: { summary: 'Route this run.', goal: input.goal.slice(0, 500) },
    });

    // 2. The router decides — validated against the agent registry (drift dropped, never dispatched).
    const plan = await routeRequest({ goal: input.goal, context: input.context }, { classify: input.classify, agents: input.agents });

    // 3. The router RESULTs its plan back to the orchestrator, linked to the REQUEST.
    const result = await bus.publish({
      runId: input.runId, from: ROUTER, to: ORCHESTRATOR, type: 'RESULT',
      payload: { summary: `Plan: ${plan.steps.map((s) => s.agent).join(' → ') || '(none)'}.`, rationale: plan.rationale, steps: plan.steps, droppedAgents: plan.droppedAgents },
      causationId: request.id,
    });

    // 4. The orchestrator DELEGATEs each planned specialist (real A2A hand-off), and records the plan as a
    //    shared fact so downstream agents read one decision instead of re-deriving routing.
    for (const step of plan.steps) {
      await bus.publish({
        runId: input.runId, from: ORCHESTRATOR, to: step.agent, type: 'DELEGATE',
        payload: { summary: step.task, task: step.task }, causationId: result.id,
      });
    }
    await blackboard.put(input.runId, 'routing.plan', { steps: plan.steps, droppedAgents: plan.droppedAgents, rationale: plan.rationale }, ORCHESTRATOR, { causationId: result.id });

    return plan;
  } catch (err) {
    console.warn(`[orchestrate] routing delegation failed for run ${input.runId} (non-fatal):`, (err as Error)?.message);
    return null;
  }
}
