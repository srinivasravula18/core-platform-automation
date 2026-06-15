/**
 * Agent tool + loop types.
 *
 * A `ToolSpec` (server/ai/providers/types.ts) is what the MODEL sees. An `AgentTool`
 * pairs that spec with an `execute` that actually does the work — almost always a thin
 * wrapper around an existing service (inspectApplicationFlow, generateCasesForRun, the
 * repository upserts, etc.). The agent loop (server/ai/agentLoop.ts via
 * AgentOrchestrator.runToolLoop) calls chatWithTools, runs the requested tools, feeds
 * results back, and repeats until the model answers, an accept-check passes, or a budget
 * is hit.
 */
import type { ToolSpec, ProviderUsage } from '../providers/types';

/** Ambient data a tool needs that the model should not have to supply. */
export interface ToolContext {
  workspaceId?: string;
  userId?: string;
  runId?: string;
  /** Free-form scratch shared across a single agent run (e.g. the inspection context). */
  scratch?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface AgentTool {
  spec: ToolSpec;
  /** Run the tool. Throwing is allowed — the loop captures it as a tool error the
   * model can see and react to (grounded self-correction). */
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown>;
}

export interface ToolInvocation {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  result?: unknown;
  error?: string;
  ms?: number;
}

export interface AgentStep {
  index: number;
  text?: string;
  toolCalls: ToolInvocation[];
  usage?: ProviderUsage;
}

export type StopReason = 'accepted' | 'final_text' | 'max_steps' | 'budget' | 'aborted';

export interface AgentRunResult {
  finalText: string;
  steps: AgentStep[];
  accepted: boolean;
  stoppedReason: StopReason;
  /** Every successful tool result, in call order (for downstream consumers). */
  toolResults: Array<{ name: string; arguments: Record<string, unknown>; result: unknown }>;
  totalUsage: { inputTokens: number; outputTokens: number; totalTokens: number; costUsd: number };
}

/** Grounded acceptance gate. Return ok:false plus feedback to make the agent retry
 * with a verbal critique appended (Reflexion), anchored in real signals. */
export type AcceptCheck = (
  state: { finalText: string; steps: AgentStep[]; ctx: ToolContext },
) => Promise<{ ok: boolean; feedback?: string }> | { ok: boolean; feedback?: string };

export interface RunToolLoopOptions {
  /** The goal / initial user instruction. */
  task: string;
  /** Override the system prompt; defaults to the agent's assembled system prompt. */
  system?: string;
  tools: AgentTool[];
  toolContext?: ToolContext;
  /** Max chatWithTools round-trips. Default 12. Hard backstop against runaway loops. */
  maxSteps?: number;
  /** Token budget across the whole loop. When exceeded, stop. */
  maxTotalTokens?: number;
  maxTokensPerCall?: number;
  temperature?: number;
  accept?: AcceptCheck;
  /** How many accept-driven retries before giving up. Default 2. */
  maxAcceptRetries?: number;
  onStep?: (step: AgentStep) => void;
  signal?: AbortSignal;
}
