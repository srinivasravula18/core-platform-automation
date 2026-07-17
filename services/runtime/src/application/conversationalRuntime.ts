/**
 * Conversational Runtime (Phase 5) — the single turn coordinator:
 * append message → merge scope → resolve+route → aggregate evidence → assemble context
 * → plan → provider-neutral invocation → record response + state. Emits typed progress
 * events for the SSE API. The LLM synthesizes prose only; it holds no state authority.
 */

import { randomUUID } from 'crypto';
import type { CapabilityDecision, EntityRef, EvidenceBundle, ReferenceBinding, WorkspaceScope } from '../domain/types';
import { routeTurn } from './routeTurn';
import { aggregateEvidence } from './evidenceAggregator';
import { createCapabilityPlan } from './capabilityPlanner';
import { assemblePreparedContext } from './contextAssembler';
import { recordAssistantResponse } from './responseRecorder';
import { sessionContextManager } from './sessionContextManager';
import { canonicalMessages } from '../adapters/sessionRepository';
import { CAPABILITIES } from '../domain/capabilities';

export type TurnEvent =
  | { type: 'session_loaded'; sessionVersion: number }
  | { type: 'references_resolved'; bindings: ReferenceBinding[] }
  | { type: 'capability_selected'; capability: string; interaction: string }
  | { type: 'evidence_collected'; items: number; gaps: number }
  | { type: 'plan_ready'; planId: string; steps: number }
  | { type: 'answer_delta'; text: string }
  | { type: 'final'; payload: TurnResult }
  | { type: 'error'; message: string };

export interface TurnResult {
  messageId: string;
  requestId: string;
  capability: string;
  interaction: string;
  answer: string;
  resolvedEntities: EntityRef[];
  evidenceRefs: string[];
  evidenceGaps: string[];
  manifestId: string;
  sessionVersion: number;
  clarification: boolean;
}

export interface LLMInvoker {
  (input: { systemContract: string; task: string; nativeMessages: Array<{ role: string; content: string }>; capability: string; requestId: string; scope: WorkspaceScope }): Promise<string>;
}

/** Default gateway: existing orchestrator — provider mapping stays untouched (plan §17.2). */
async function defaultInvoke(input: Parameters<LLMInvoker>[0]): Promise<string> {
  const { getOrchestrator } = await import('../../../../server/ai/orchestrator');
  const orch = await getOrchestrator('chatAssistant', { workspaceId: input.scope.workspaceId, userId: input.scope.ownerId || undefined });
  const prompt = `${input.systemContract}\n\n${input.nativeMessages.length ? `CONVERSATION (oldest first):\n${input.nativeMessages.map((m) => `${m.role}: ${m.content}`).join('\n')}\n\n` : ''}${input.task}`;
  const result = await orch.generateText({
    prompt,
    temperature: 0.2,
    userMessage: input.task.slice(0, 2_000),
    hasHistory: input.nativeMessages.length > 0,
    meta: { requestId: input.requestId, capability: input.capability },
  } as any);
  return (result as any).shortCircuit || result.text || '';
}

function clarificationText(decision: CapabilityDecision, bindings: ReferenceBinding[]): string {
  const ambiguous = bindings.find((b) => b.status === 'ambiguous');
  if (ambiguous && ambiguous.candidatesConsidered.length) {
    const options = ambiguous.candidatesConsidered.slice(0, 4)
      .map((c) => `${c.candidate.type} ${c.candidate.id}${c.candidate.label ? ` (${c.candidate.label})` : ''}`);
    return `"${ambiguous.expression}" could mean more than one thing here. Did you mean: ${options.join(' — or — ')}?`;
  }
  if (decision.missing.length) {
    return `I need one more detail before I can proceed: ${decision.missing.map((m) => m.reason).join('; ')}.`;
  }
  return 'Could you say a bit more about what you want me to look at?';
}

export interface RunTurnInput {
  conversationId: string;
  message: string;
  clientMessageId?: string;
  scope: WorkspaceScope;
  requestContext?: {
    projectId?: string;
    appId?: string;
    appName?: string;
    pagePath?: string;
    selectedEntity?: { type: string; id: string; label?: string };
  };
  model?: string;
  onEvent?: (event: TurnEvent) => void;
  invoke?: LLMInvoker;
}

export async function runConversationTurn(input: RunTurnInput): Promise<TurnResult> {
  const requestId = `req-${randomUUID()}`;
  const emit = (event: TurnEvent) => { try { input.onEvent?.(event); } catch { /* observer errors never break the turn */ } };
  const conversationId = String(input.conversationId || '').trim();
  if (!conversationId) throw new Error('conversationId is required');

  // 1) Canonical user message (idempotent on clientMessageId).
  const appended = await canonicalMessages.append({
    conversationId,
    workspaceId: input.scope.workspaceId,
    clientMessageId: input.clientMessageId,
    role: 'user',
    content: input.message,
    correlationId: requestId,
  });

  // 2) Merge the request's scope hints into the session (selection hints, not authorization).
  const rc = input.requestContext || {};
  await sessionContextManager.mergeRequestScope(conversationId, {
    projectId: rc.projectId ?? undefined,
    app: rc.appId ? { type: 'app', id: rc.appId, label: rc.appName } : undefined,
    page: rc.pagePath ? { path: rc.pagePath } : undefined,
    ownerId: input.scope.ownerId || undefined,
    workspaceId: input.scope.workspaceId,
  }).catch(() => undefined);
  if (rc.selectedEntity?.id) {
    await sessionContextManager.selectEntity(conversationId, { type: rc.selectedEntity.type as any, id: rc.selectedEntity.id, label: rc.selectedEntity.label }).catch(() => undefined);
  }

  // 3) Resolve + route with authoritative state.
  const routed = await routeTurn({ conversationId, message: input.message, scope: input.scope, mode: 'authoritative' });
  emit({ type: 'session_loaded', sessionVersion: routed.session.version });
  emit({ type: 'references_resolved', bindings: routed.bindings });
  emit({ type: 'capability_selected', capability: routed.decision.capability, interaction: routed.decision.interaction });

  // Clarify without any provider call.
  if (routed.decision.interaction === 'clarify') {
    const answer = clarificationText(routed.decision, routed.bindings);
    const recorded = await recordAssistantResponse({
      conversationId, requestId, causationMessageId: appended.message.id,
      answer, decision: routed.decision, evidence: null, manifestId: '',
    });
    const result: TurnResult = {
      messageId: recorded.messageId, requestId,
      capability: routed.decision.capability, interaction: 'clarify',
      answer, resolvedEntities: [], evidenceRefs: [], evidenceGaps: [],
      manifestId: '', sessionVersion: routed.session.version, clarification: true,
    };
    emit({ type: 'final', payload: result });
    return result;
  }

  // 4) Capability-owned evidence aggregation (no raw tools reach the model).
  const evidence = await aggregateEvidence({
    capability: routed.decision.capability,
    subjectRefs: routed.decision.resolvedEntities,
    scope: input.scope,
    conversationId,
  });
  emit({ type: 'evidence_collected', items: evidence.items.length, gaps: evidence.gaps.length });

  // 5) Deterministic plan + evidence-first prepared context.
  const plan = createCapabilityPlan(routed.decision, evidence);
  emit({ type: 'plan_ready', planId: plan.id, steps: plan.steps.length });
  const recentMessages = await canonicalMessages.list(conversationId, { limit: 30 }).catch(() => []);
  const prepared = await assemblePreparedContext({
    requestId, conversationId,
    message: input.message,
    session: routed.session,
    decision: routed.decision,
    bindings: routed.bindings,
    evidence, plan,
    recentMessages: recentMessages.filter((m) => m.id !== appended.message.id),
    model: input.model || 'gpt-4o',
  });

  // 6) Provider-neutral synthesis.
  const invoke = input.invoke || defaultInvoke;
  let answer: string;
  try {
    answer = await invoke({
      systemContract: prepared.systemContract,
      task: prepared.task,
      nativeMessages: prepared.nativeMessages,
      capability: routed.decision.capability,
      requestId,
      scope: input.scope,
    });
  } catch (err: any) {
    emit({ type: 'error', message: err?.message || String(err) });
    throw err;
  }
  if (!answer.trim()) {
    const def = CAPABILITIES[routed.decision.capability];
    answer = def.observedEvidenceMandatory && evidence.gaps.length
      ? `I could not find the runtime evidence needed to answer this (${evidence.gaps.map((g) => g.requirement.kind).join(', ')} missing). Run the tests first, then ask again.`
      : 'I could not produce an answer for this request.';
  }
  emit({ type: 'answer_delta', text: answer });

  // 7) Close the loop: persist the assistant message + refresh recency index.
  const recorded = await recordAssistantResponse({
    conversationId, requestId, causationMessageId: appended.message.id,
    answer, decision: routed.decision, evidence, manifestId: prepared.manifest.id,
  });
  const session = await sessionContextManager.getSession(conversationId, { reconcile: false });
  const result: TurnResult = {
    messageId: recorded.messageId, requestId,
    capability: routed.decision.capability, interaction: routed.decision.interaction,
    answer,
    resolvedEntities: routed.decision.resolvedEntities,
    evidenceRefs: evidence.items.map((i) => i.id),
    evidenceGaps: evidence.gaps.map((g) => g.requirement.kind),
    manifestId: prepared.manifest.id,
    sessionVersion: session.version,
    clarification: false,
  };
  emit({ type: 'final', payload: result });
  return result;
}
