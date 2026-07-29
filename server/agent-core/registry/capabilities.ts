/**
 * Deterministic capability delegation (Phase 6) — the orchestrator DELEGATEs to the compiler and executor
 * as registered capabilities, and their outcomes become RESULT messages + blackboard facts.
 *
 * The design invariant: agents DECIDE, deterministic code EXECUTES and VERIFIES. The compiler (grounded
 * plans → verified Playwright) and the executor (run against the live app) are NOT LLM agents — they are
 * deterministic tools. This module records their invocation as first-class A2A traffic so the console shows
 * them as delegated capabilities (distinct from the reasoning specialists), without moving any correctness
 * into an LLM. The capability name is validated against the tool registry — an unregistered capability is a
 * loud error, never a silent no-op. Flag-gated by AGENT_NATIVE_V1 via callers; best-effort, never throws.
 */
import { isAgentNativeEnabled } from '../agentNativeFlag';
import { getMessageBus } from '../bus/messageBus';
import { getBlackboard } from '../bus/blackboard';
import { getToolRegistry, type ToolRegistry } from './tools';

const ORCHESTRATOR = 'orchestrator';

export interface CapabilityDelegationInput {
  runId: string;
  /** Registered deterministic capability name (e.g. 'compile_scripts', 'execute_scripts'). */
  capability: string;
  /** One-line description of what was asked of the capability. */
  requestSummary: string;
  /** One-line outcome the capability produced. */
  resultSummary: string;
  /** Bounded structured outcome recorded on the blackboard for downstream agents. */
  resultValue?: Record<string, unknown>;
  tools?: ToolRegistry;
}

/**
 * Record a deterministic capability invocation as a DELEGATE → RESULT exchange + a blackboard fact. Returns
 * false when the flag is off or the capability is not a registered deterministic capability (drift surfaced).
 */
export async function recordCapabilityDelegation(input: CapabilityDelegationInput): Promise<boolean> {
  if (!isAgentNativeEnabled()) return false;
  try {
    const tools = input.tools ?? getToolRegistry();
    const def = tools.get(input.capability);
    if (!def || !def.deterministic) {
      console.warn(`[capabilities] '${input.capability}' is not a registered deterministic capability — delegation skipped.`);
      return false;
    }
    const bus = getMessageBus();
    // The orchestrator DELEGATEs the deterministic step (it is a tool invocation, not a reasoning hand-off).
    const delegate = await bus.publish({ runId: input.runId, from: ORCHESTRATOR, to: input.capability, type: 'DELEGATE', payload: { summary: input.requestSummary, task: input.requestSummary, deterministic: true } });
    // The capability RESULTs its outcome, causally linked to the delegation.
    await bus.publish({ runId: input.runId, from: input.capability, to: ORCHESTRATOR, type: 'RESULT', payload: { summary: input.resultSummary, deterministic: true, ...(input.resultValue ?? {}) }, causationId: delegate.id });
    await getBlackboard().put(input.runId, `capability.result.${input.capability}`, input.resultValue ?? { summary: input.resultSummary }, input.capability, { causationId: delegate.id });
    return true;
  } catch (err) {
    console.warn(`[capabilities] failed to record '${input.capability}' delegation for run ${input.runId} (non-fatal):`, (err as Error)?.message);
    return false;
  }
}
