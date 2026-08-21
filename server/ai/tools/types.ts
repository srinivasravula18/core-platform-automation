/**
 * Agent tool + loop types.
 *
 * A `ToolSpec` (server/ai/providers/types.ts) is what the MODEL sees. An `AgentTool`
 * pairs that spec with an `execute` that actually does the work — almost always a thin
 * wrapper around an existing service (inspectApplicationFlow, generateCasesForRun, the
 * repository upserts, etc.).
 *
 * AgentOrchestrator.runToolLoop publishes these through the scoped MCP bridge and runs one
 * Codex thread: the runtime calls the tools natively and iterates on its own, while the
 * orchestrator keeps guardrails, usage, tracing, the honesty gate, and accept-driven retries.
 */
import type { ToolSpec, ProviderUsage } from '../providers/types';

export type LiveEvidenceScopeKind = 'target' | 'application' | 'all_applications' | 'filtered';

export interface LiveEvidence {
  subject: string;
  scope: { kind: LiveEvidenceScopeKind; id?: string; label?: string };
  source: { method: string; operation: string };
  completeness: { complete: boolean; returned: number; total?: number };
  observedAt: string;
}

export type EvidenceResult<T extends Record<string, unknown> = Record<string, unknown>> = T & { evidence: LiveEvidence };

/** Ambient data a tool needs that the model should not have to supply. */
export interface ToolContext {
  workspaceId?: string;
  userId?: string;
  /** Server-derived console role. Tool selection narrows from this value; it never trusts model text. */
  role?: string;
  projectId?: string;
  appId?: string | null;
  /** Exact target credentials selected in the Console; never model-authored. */
  targetApps?: Array<{ id?: string; name: string; baseUrl: string }>;
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

export type StopReason = 'accepted' | 'final_text' | 'max_steps' | 'budget' | 'aborted' | 'empty_response' | 'truncated';

export interface AggregateUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costUsd: number;
}

export function addUsage(total: AggregateUsage, usage: ProviderUsage): void {
  total.inputTokens += usage.inputTokens ?? 0;
  total.outputTokens += usage.outputTokens ?? 0;
  total.cacheReadTokens += usage.cacheReadTokens ?? 0;
  total.cacheWriteTokens += usage.cacheWriteTokens ?? 0;
  total.totalTokens += usage.totalTokens ?? 0;
  total.costUsd += usage.costUsd ?? 0;
}

export interface AgentRunResult {
  finalText: string;
  steps: AgentStep[];
  accepted: boolean;
  stoppedReason: StopReason;
  /** Every successful tool result, in call order (for downstream consumers). */
  toolResults: Array<{ name: string; arguments: Record<string, unknown>; result: unknown }>;
  totalUsage: AggregateUsage;
}

/** Grounded acceptance gate. Return ok:false plus feedback to make the agent retry
 * with a verbal critique appended (Reflexion), anchored in real signals. */
export type AcceptCheck = (
  state: { finalText: string; steps: AgentStep[]; ctx: ToolContext },
) => Promise<{ ok: boolean; feedback?: string }> | { ok: boolean; feedback?: string };

/** A prior conversational turn replayed as context for a new loop. */
export interface LoopMessage {
  role: 'user' | 'assistant' | 'system';
  content?: string;
}

export interface RunToolLoopOptions {
  /** The goal / initial user instruction. */
  task: string;
  /** Original user-authored input for guardrails when task also contains memory/context. */
  guardrailInput?: string;
  /** Prior text turns, rendered as leading context before the task. */
  seedMessages?: LoopMessage[];
  /** Override the system prompt; defaults to the agent's assembled system prompt. */
  system?: string;
  tools: AgentTool[];
  toolContext?: ToolContext;
  /** Hard backstop against a runaway loop: the tool-call ceiling for the whole run. Default 32.
   *  Past it, further calls are refused with an instruction to answer from what it already has. */
  maxSteps?: number;
  /** Token budget across the whole loop. When exceeded, stop. */
  maxTotalTokens?: number;
  /** Context-manifest id used to correlate usage with assembly decisions. */
  contextManifestId?: string;
  temperature?: number;
  accept?: AcceptCheck;
  /** How many accept-driven retries before giving up. Default 2. */
  maxAcceptRetries?: number;
  onStep?: (step: AgentStep) => void;
  /** Fired immediately before a granted tool begins executing. */
  onToolStart?: (invocation: ToolInvocation) => void;
  /** Native agent-message deltas, forwarded while the model is still producing its answer. */
  onTextDelta?: (delta: string) => void;
  /** Hosted Codex search, enabled only for explicit capability-discovery requests. */
  webSearchMode?: 'disabled' | 'cached' | 'live';
  signal?: AbortSignal;
}
