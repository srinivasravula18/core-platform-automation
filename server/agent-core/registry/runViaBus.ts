/**
 * Shadow-mode agent execution over the coordination bus — Phase 2.
 *
 * Runs a REGISTERED agent (agents.ts) using its REGISTERED tools (tools.ts), and records the interaction
 * as typed A2A messages + a blackboard fact (Phase 1). This is the seam the router will call in later
 * phases; for now it is invoked only in shadow mode / tests, so it changes no live behavior.
 *
 * The actual model work is delegated to the EXISTING tool-loop (getOrchestrator().runToolLoop) — this
 * module adds coordination, not a second inference engine. The executor is injectable so tests can run
 * the coordination path without a live provider.
 */
import type { AgentRunResult, RunToolLoopOptions, ToolContext } from '../../ai/tools/types';
import { getAgentRegistry, type AgentRegistry } from './agents';
import { getToolRegistry, type ToolRegistry } from './tools';
import { getBlackboard, type Blackboard } from '../bus/blackboard';
import { getMessageBus, type MessageBus } from '../bus/messageBus';

/** Injectable executor — defaults to the existing per-agent tool-loop. */
export type AgentExecutor = (agent: string, opts: RunToolLoopOptions) => Promise<AgentRunResult>;

export interface RunRegisteredAgentInput {
  agent: string;
  task: string;
  runId: string;
  /** Caller/orchestrator identity for the HANDOFF (default 'router'). */
  from?: string;
  causationId?: string | null;
  toolContext?: ToolContext;
  maxSteps?: number;
  maxTotalTokens?: number;
  signal?: AbortSignal;
  // Seams (tests / alternate wiring).
  executor?: AgentExecutor;
  agents?: AgentRegistry;
  tools?: ToolRegistry;
  bus?: MessageBus;
  blackboard?: Blackboard;
}

export interface RunRegisteredAgentOutput {
  result: AgentRunResult;
  handoffId: string;
  resultMessageId: string;
}

/** The default executor: the real Settings-routed tool-loop for the given agent. Imported lazily. */
async function defaultExecutor(agent: string, opts: RunToolLoopOptions): Promise<AgentRunResult> {
  const { getOrchestrator } = await import('../../ai/orchestrator');
  const orch = await getOrchestrator(agent, { workspaceId: opts.toolContext?.workspaceId, userId: opts.toolContext?.userId });
  return orch.runToolLoop(opts);
}

/**
 * Execute a registered agent: publish a HANDOFF, run it with its registered tools, write the outcome to
 * the blackboard, and publish a RESULT linked by causationId. Throws on an unknown agent (fail loud).
 */
export async function runRegisteredAgent(input: RunRegisteredAgentInput): Promise<RunRegisteredAgentOutput> {
  const agents = input.agents ?? getAgentRegistry();
  const tools = input.tools ?? getToolRegistry();
  const bus = input.bus ?? getMessageBus();
  const blackboard = input.blackboard ?? getBlackboard();
  const executor = input.executor ?? defaultExecutor;
  const from = input.from ?? 'router';

  const def = agents.get(input.agent);
  if (!def) throw new Error(`runRegisteredAgent: no registered agent named '${input.agent}'.`);

  // 1. HANDOFF: ownership transfers to the agent (typed message, not a run: any mutation).
  const handoff = await bus.publish({
    runId: input.runId, from, to: def.name, type: 'HANDOFF',
    payload: { task: input.task.slice(0, 2000) }, causationId: input.causationId ?? null,
  });

  // 2. Execute via the existing tool-loop with the agent's REGISTERED tools (session-scoped ones skipped).
  const agentTools = tools.toolsFor(def.toolNames);
  const result = await executor(def.name, {
    task: input.task,
    system: def.resolveSystem?.(),
    tools: agentTools,
    toolContext: { ...input.toolContext, runId: input.runId },
    maxSteps: input.maxSteps,
    maxTotalTokens: input.maxTotalTokens,
    signal: input.signal,
  });

  // 3. Record the outcome on the blackboard (append-only, provenance-stamped) — shared, not re-derived.
  await blackboard.put(
    input.runId,
    `agent.result.${def.name}`,
    { accepted: result.accepted, stoppedReason: result.stoppedReason, finalText: result.finalText.slice(0, 4000), toolCalls: result.toolResults.map((t) => t.name) },
    def.name,
    { causationId: handoff.id },
  );

  // 4. RESULT back to the caller, linked to the HANDOFF for traceability.
  const resultMsg = await bus.publish({
    runId: input.runId, from: def.name, to: from, type: 'RESULT',
    payload: { accepted: result.accepted, stoppedReason: result.stoppedReason, summary: result.finalText.slice(0, 500) },
    causationId: handoff.id,
  });

  return { result, handoffId: handoff.id, resultMessageId: resultMsg.id };
}
