/** Conversational Runtime — internal service exports (stable boundary for the app layer). */

export * from './domain/types';
export { createInitialSession, applySessionEvent, validateSessionInvariants } from './domain/session';
export {
  extractReferenceExpressions,
  resolveReferences,
  entityTypeForId,
  type ResolverInput,
  type RecencyRef,
  type WorkspaceRecord,
} from './domain/entityResolver';
export { sessionContextManager } from './application/sessionContextManager';
export {
  projectRunLifecycle,
  buildRunProjection,
  foldAndCommit,
  hydrateSessionState,
} from './application/sessionProjector';
export { decideCapability } from './domain/capabilityRouter';
export { CAPABILITIES, CAPABILITY_RULES_VERSION, getCapability } from './domain/capabilities';
export { analyzeRequest } from './application/requestAnalyzer';
export { routeTurn, capabilityToLegacyRouteKind } from './application/routeTurn';
export { aggregateEvidence } from './application/evidenceAggregator';
export { createCapabilityPlan } from './application/capabilityPlanner';
export { assemblePreparedContext } from './application/contextAssembler';
export { runConversationTurn } from './application/conversationalRuntime';
export { readWorkspaceEntities } from './adapters/workspaceEntityReader';
export { sessionRepository, canonicalMessages, entityRefIndex, runReader } from './adapters/sessionRepository';
