/** Executes a registered agent for one coordinator-dispatched task. Coordination lives in the coordinator. */
import type { AgentRunResult, RunToolLoopOptions, ToolContext } from '../../ai/tools/types';
import { getAgentRegistry, type AgentRegistry } from './agents';
import { getToolRegistry, type ToolRegistry } from './tools';
import { getBlackboard, type Blackboard } from '../bus/blackboard';
import { getMessageBus, type MessageBus } from '../bus/messageBus';
import type { SpecialistRunner } from '../orchestration/coordinator';
import type { AgentUsage } from '../orchestration/contracts';

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
export async function defaultAgentExecutor(agent: string, opts: RunToolLoopOptions): Promise<AgentRunResult> {
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
  const executor = input.executor ?? defaultAgentExecutor;
  const from = input.from ?? 'router';

  const def = agents.get(input.agent);
  if (!def) throw new Error(`runRegisteredAgent: no registered agent named '${input.agent}'.`);

  const handoff = await bus.publish({
    runId: input.runId, from, to: def.name, type: 'HANDOFF',
    payload: { task: input.task.slice(0, 2000) }, causationId: input.causationId ?? null,
  });

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

  await blackboard.put(
    input.runId,
    `agent.result.${def.name}`,
    { accepted: result.accepted, stoppedReason: result.stoppedReason, finalText: result.finalText.slice(0, 4000), toolCalls: result.toolResults.map((t) => t.name) },
    def.name,
    { causationId: handoff.id },
  );

  const resultMsg = await bus.publish({
    runId: input.runId, from: def.name, to: from, type: 'RESULT',
    payload: { accepted: result.accepted, stoppedReason: result.stoppedReason, summary: result.finalText.slice(0, 500) },
    causationId: handoff.id,
  });

  return { result, handoffId: handoff.id, resultMessageId: resultMsg.id };
}

/** Parse a specialist's structured answer. A non-JSON reply is a contract violation, not prose to salvage. */
function parseStructured(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
  return JSON.parse(trimmed);
}

function toUsage(result: AgentRunResult): AgentUsage {
  // AgentRunResult exposes totalUsage; reading `.usage` through an `as` cast silently booked every
  // coordinator-dispatched agent as zero tokens.
  const u: Partial<AgentUsage> = result?.totalUsage ?? {};
  return {
    inputTokens: u.inputTokens ?? 0,
    cachedInputTokens: u.cachedInputTokens ?? 0,
    outputTokens: u.outputTokens ?? 0,
    reasoningOutputTokens: u.reasoningOutputTokens ?? 0,
    codexTurns: 1,
    toolCalls: result.toolResults?.length ?? 0,
  };
}

/**
 * The SpecialistRunner the coordinator dispatches through. The HANDOFF/RESULT traffic and the fact
 * lifecycle belong to the coordinator, so this only runs the model turn and returns the raw answer.
 */
export function createSpecialistRunner(opts: { executor?: AgentExecutor; tools?: ToolRegistry; toolContext?: ToolContext } = {}): SpecialistRunner {
  const executor = opts.executor ?? defaultAgentExecutor;
  return async ({ task, roster, prompt, system, signal }) => {
    const tools = (opts.tools ?? getToolRegistry()).toolsFor(roster.allowedToolNames);
    const result = await executor(roster.agentKey, {
      task: prompt,
      system,
      tools,
      toolContext: { ...opts.toolContext, runId: task.runId },
      maxSteps: task.budget.maxCodexTurns,
      maxTotalTokens: task.budget.maxTokens ?? undefined,
      signal,
    });
    return {
      raw: parseStructured(result.finalText),
      usage: toUsage(result),
      codexThreadId: (result as AgentRunResult & { threadId?: string }).threadId ?? null,
    };
  };
}
