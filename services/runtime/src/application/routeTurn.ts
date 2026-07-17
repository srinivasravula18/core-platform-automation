/**
 * routeTurn (Phase 3) — the correct decision ordering: load authoritative session,
 * resolve references, THEN select a capability. In 'shadow' mode nothing is persisted
 * (plan §22.3: shadow evaluates deterministic logic with no extra LLM call).
 */

import type { CapabilityDecision, EntityRef, ReferenceBinding, SessionContext, WorkspaceScope } from '../domain/types';
import { resolveReferences } from '../domain/entityResolver';
import { createInitialSession } from '../domain/session';
import { decideCapability } from '../domain/capabilityRouter';
import { analyzeRequest, type AnalyzedRequest } from './requestAnalyzer';
import { sessionContextManager } from './sessionContextManager';
import { readWorkspaceEntities } from '../adapters/workspaceEntityReader';
import { entityRefIndex } from '../adapters/sessionRepository';

export interface RouteTurnInput {
  conversationId: string;
  message: string;
  scope: WorkspaceScope;
  explicitSelections?: EntityRef[];
  mode?: 'shadow' | 'authoritative';
}

export interface RoutedTurn {
  decision: CapabilityDecision;
  bindings: ReferenceBinding[];
  analysis: AnalyzedRequest;
  session: SessionContext;
}

export async function routeTurn(input: RouteTurnInput): Promise<RoutedTurn> {
  const conversationId = String(input.conversationId || '').trim();
  const mode = input.mode || 'shadow';

  // 1) Authoritative state first — never classify text before loading it.
  const session = conversationId
    ? await sessionContextManager.getSession(conversationId, { reconcile: mode === 'authoritative' })
    : createInitialSession({ conversationId: '', workspaceId: input.scope.workspaceId, ownerId: input.scope.ownerId, projectId: input.scope.projectId });

  // 2) Deterministic reference resolution against session + recency index + workspace.
  const conversationRefs = conversationId ? await entityRefIndex.list(conversationId, { limit: 200 }).catch(() => []) : [];
  const analysis = analyzeRequest(input.message);
  const workspaceRecords = await readWorkspaceEntities(input.scope).catch(() => []);
  const bindings = resolveReferences({
    utterance: input.message,
    session,
    conversationRefs: conversationRefs.map((r) => ({
      entityType: r.entityType, entityId: r.entityId, relation: r.relation,
      sourceRunId: r.sourceRunId, lastSeenAt: String(r.lastSeenAt || ''), label: (r.metadata as any)?.label,
      appId: r.appId || undefined, projectId: r.projectId || undefined,
    })),
    workspaceRecords,
    explicitSelections: input.explicitSelections,
  });

  // 3) Pure capability decision.
  const decision = decideCapability({
    speechAct: analysis.speechAct,
    isQuestion: analysis.isQuestion,
    wantsExecution: analysis.wantsExecution,
    topics: analysis.topics,
    bindings,
    session,
  });

  // 4) Authoritative turns record the route; shadow never mutates state.
  if (mode === 'authoritative' && conversationId) {
    await sessionContextManager
      .recordCapabilityRouted(conversationId, decision.capability, decision.interaction)
      .catch(() => undefined);
  }

  return { decision, bindings, analysis, session };
}

/** Compatibility projection onto the legacy RouteKind vocabulary (plan §21.4). */
export function capabilityToLegacyRouteKind(decision: CapabilityDecision): string {
  if (decision.interaction === 'clarify') return 'clarify';
  switch (decision.capability) {
    case 'test_generation': return 'generate_cases';
    case 'automation': return 'deep_test_run';
    case 'api_testing': return decision.interaction === 'action' ? 'deep_test_run' : 'answer';
    case 'code_review':
    case 'architecture_review': return 'code_analysis';
    case 'requirement_review': return decision.interaction === 'action' ? 'requirement_draft' : 'answer';
    case 'workspace_action':
    case 'documentation': return 'workspace_action';
    default: return 'answer';
  }
}
