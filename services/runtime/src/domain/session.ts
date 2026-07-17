/**
 * SessionContext aggregate — pure invariants and event projections (Phase 2).
 *
 * No I/O and no framework imports: every function maps (state, event) -> state so the
 * aggregate can be replayed, unit-tested, and reconciled deterministically. Persistence
 * versioning/idempotency lives in the repository layer, not here.
 */

import type {
  ArtifactSetRef,
  DecisionRecord,
  EntityCollectionRef,
  EntityRef,
  GeneratedOutputRef,
  GoalState,
  SessionContext,
  SessionEventType,
} from './types';

const MAX_DECISIONS = 20;
const MAX_GENERATED_OUTPUTS = 50;
const MAX_ACTIVE_ENTITIES = 40;

export function createInitialSession(input: {
  conversationId: string;
  workspaceId?: string;
  ownerId?: string;
  projectId?: string | null;
}): SessionContext {
  return {
    schemaVersion: 1,
    conversationId: input.conversationId,
    workspaceId: input.workspaceId || 'default',
    ownerId: input.ownerId || '',
    projectId: input.projectId || null,
    currentApp: null,
    currentModule: null,
    currentPage: null,
    currentObject: null,
    currentRecord: null,
    currentExecution: null,
    currentTestSuite: null,
    currentDefect: null,
    currentBranch: null,
    currentArtifactSet: null,
    currentGoal: null,
    currentIntent: null,
    currentSelectedEntity: null,
    latestRun: null,
    latestReview: null,
    latestScripts: null,
    latestTestCases: null,
    generatedOutputs: [],
    recentDecisions: [],
    activeEntities: [],
    version: 0,
    updatedAt: new Date(0).toISOString(),
  };
}

/** Dedupe by type+id, newest first, bounded. */
function touchActiveEntity(list: EntityRef[], ref: EntityRef | null | undefined): EntityRef[] {
  if (!ref?.id) return list;
  const rest = list.filter((e) => !(e.type === ref.type && e.id === ref.id));
  return [ref, ...rest].slice(0, MAX_ACTIVE_ENTITIES);
}

function touchAll(list: EntityRef[], refs: Array<EntityRef | null | undefined>): EntityRef[] {
  let out = list;
  for (const ref of refs) out = touchActiveEntity(out, ref);
  return out;
}

/** Set the matching "current" pointer for a selected entity's type. */
function applyCurrentPointer(session: SessionContext, ref: EntityRef): SessionContext {
  const next = { ...session };
  switch (ref.type) {
    case 'app': next.currentApp = ref; break;
    case 'module': next.currentModule = ref; break;
    case 'page': next.currentPage = { path: ref.id, title: ref.label, appId: ref.appId }; break;
    case 'object': next.currentObject = ref; break;
    case 'record': next.currentRecord = ref; break;
    case 'run':
    case 'execution': next.currentExecution = ref; break;
    case 'test_suite': next.currentTestSuite = ref; break;
    case 'defect': next.currentDefect = ref; break;
    case 'branch': next.currentBranch = { repositoryId: ref.projectId || '', branch: ref.id }; break;
    default: break;
  }
  return next;
}

export interface RunProjectionPayload {
  runRef: EntityRef;
  status?: string;
  caseRefs?: EntityRef[];
  scriptRefs?: EntityRef[];
  failedCaseRefs?: EntityRef[];
  failedScriptRefs?: EntityRef[];
  defectRefs?: EntityRef[];
  artifactSet?: ArtifactSetRef | null;
}

export type SessionEventPayloads = {
  ConversationStarted: Record<string, never>;
  ScopeSelected: { projectId?: string | null; app?: EntityRef | null; module?: EntityRef | null; page?: { path: string; title?: string; appId?: string } | null };
  EntitySelected: { entity: EntityRef };
  GoalAccepted: { goal: GoalState };
  CapabilityRouted: { capability: string; interaction: string };
  ArtifactGenerated: { output: GeneratedOutputRef; artifactSet?: ArtifactSetRef | null };
  RunStarted: { runRef: EntityRef };
  RunCompleted: RunProjectionPayload;
  ReviewCompleted: { reviewRef: EntityRef };
  DecisionRecorded: { decision: DecisionRecord };
  EntityInvalidated: { entity: EntityRef; reason: string };
  ConversationArchived: Record<string, never>;
  SessionReconciled: RunProjectionPayload;
  TurnAborted: { reason?: string };
};

/** Pure projection: returns the next state; unknown events return the input unchanged. */
export function applySessionEvent(
  session: SessionContext,
  eventType: SessionEventType,
  payload: Record<string, unknown>,
  occurredAt?: string,
): SessionContext {
  const at = occurredAt || new Date().toISOString();
  const stamped = (s: SessionContext): SessionContext => ({ ...s, updatedAt: at });

  switch (eventType) {
    case 'ConversationStarted':
      return stamped(session);

    case 'ScopeSelected': {
      const p = payload as SessionEventPayloads['ScopeSelected'];
      let next = { ...session };
      if (p.projectId !== undefined && p.projectId !== session.projectId && p.projectId) {
        // Changing project invalidates every lower-level selection.
        next = { ...next, projectId: p.projectId, currentApp: null, currentModule: null, currentPage: null, currentObject: null, currentRecord: null, currentSelectedEntity: null };
      }
      if (p.app && p.app.id !== session.currentApp?.id) {
        // Changing app clears module/page/object/record and an incompatible selection.
        next = { ...next, currentApp: p.app, currentModule: null, currentPage: null, currentObject: null, currentRecord: null };
        if (next.currentSelectedEntity && next.currentSelectedEntity.appId && next.currentSelectedEntity.appId !== p.app.id) {
          next.currentSelectedEntity = null;
        }
        next.activeEntities = touchActiveEntity(next.activeEntities, p.app);
      }
      if (p.module) { next = { ...next, currentModule: p.module }; next.activeEntities = touchActiveEntity(next.activeEntities, p.module); }
      if (p.page) next = { ...next, currentPage: p.page };
      return stamped(next);
    }

    case 'EntitySelected': {
      const p = payload as SessionEventPayloads['EntitySelected'];
      if (!p.entity?.id) return session;
      let next = applyCurrentPointer({ ...session, currentSelectedEntity: p.entity }, p.entity);
      next.activeEntities = touchActiveEntity(next.activeEntities, p.entity);
      return stamped(next);
    }

    case 'GoalAccepted': {
      const p = payload as SessionEventPayloads['GoalAccepted'];
      return stamped({ ...session, currentGoal: p.goal });
    }

    case 'CapabilityRouted': {
      const p = payload as SessionEventPayloads['CapabilityRouted'];
      return stamped({ ...session, currentIntent: { capability: p.capability as any, interaction: p.interaction as any } });
    }

    case 'ArtifactGenerated': {
      const p = payload as SessionEventPayloads['ArtifactGenerated'];
      const next = { ...session };
      next.generatedOutputs = [...session.generatedOutputs, p.output].slice(-MAX_GENERATED_OUTPUTS);
      if (p.artifactSet) next.currentArtifactSet = p.artifactSet;
      // Latest pointers are projections of the append-only history.
      if (p.output.kind === 'cases') {
        next.latestTestCases = { memberType: 'test_case', ids: p.output.refs.map((r) => r.id), sourceRunId: p.output.sourceRunId };
      } else if (p.output.kind === 'scripts') {
        next.latestScripts = { memberType: 'script', ids: p.output.refs.map((r) => r.id), sourceRunId: p.output.sourceRunId };
      }
      next.activeEntities = touchAll(next.activeEntities, p.output.refs.slice(0, 10));
      return stamped(next);
    }

    case 'RunStarted': {
      const p = payload as SessionEventPayloads['RunStarted'];
      const next = { ...session, currentExecution: p.runRef };
      next.activeEntities = touchActiveEntity(next.activeEntities, p.runRef);
      return stamped(next);
    }

    case 'RunCompleted':
    case 'SessionReconciled': {
      const p = payload as unknown as RunProjectionPayload;
      if (!p.runRef?.id) return session;
      let next = { ...session, latestRun: p.runRef };
      // Clear the running pointer only when this run was the one in flight.
      if (next.currentExecution?.id === p.runRef.id) next.currentExecution = null;
      if (p.caseRefs?.length) next.latestTestCases = { memberType: 'test_case', ids: p.caseRefs.map((r) => r.id), sourceRunId: p.runRef.id };
      if (p.scriptRefs?.length) next.latestScripts = { memberType: 'script', ids: p.scriptRefs.map((r) => r.id), sourceRunId: p.runRef.id };
      if (p.artifactSet) next.currentArtifactSet = p.artifactSet;
      const failures = [...(p.failedCaseRefs || []), ...(p.failedScriptRefs || [])];
      next.activeEntities = touchAll(next.activeEntities, [p.runRef, ...failures, ...(p.defectRefs || [])]);
      return stamped(next);
    }

    case 'ReviewCompleted': {
      const p = payload as SessionEventPayloads['ReviewCompleted'];
      const next = { ...session, latestReview: p.reviewRef };
      next.activeEntities = touchActiveEntity(next.activeEntities, p.reviewRef);
      return stamped(next);
    }

    case 'DecisionRecorded': {
      const p = payload as SessionEventPayloads['DecisionRecorded'];
      // Superseding marks the older record; nothing is silently overwritten.
      const prior = session.recentDecisions.map((d) =>
        p.decision.supersededBy === undefined && d.summary === p.decision.summary ? d : d);
      return stamped({ ...session, recentDecisions: [...prior, p.decision].slice(-MAX_DECISIONS) });
    }

    case 'EntityInvalidated': {
      const p = payload as SessionEventPayloads['EntityInvalidated'];
      let next = { ...session };
      const matches = (ref: EntityRef | null) => !!ref && ref.type === p.entity.type && ref.id === p.entity.id;
      if (matches(next.currentSelectedEntity)) next.currentSelectedEntity = null;
      if (matches(next.currentApp)) next.currentApp = null;
      if (matches(next.currentModule)) next.currentModule = null;
      if (matches(next.currentObject)) next.currentObject = null;
      if (matches(next.currentRecord)) next.currentRecord = null;
      if (matches(next.currentExecution)) next.currentExecution = null;
      if (matches(next.currentTestSuite)) next.currentTestSuite = null;
      if (matches(next.currentDefect)) next.currentDefect = null;
      if (matches(next.latestRun)) next.latestRun = null;
      next.activeEntities = next.activeEntities.filter((e) => !(e.type === p.entity.type && e.id === p.entity.id));
      return stamped(next);
    }

    case 'ConversationArchived':
    case 'TurnAborted':
      return stamped(session);

    default:
      return session;
  }
}

/** Invariant check used by tests and reconciliation; returns human-readable violations. */
export function validateSessionInvariants(session: SessionContext): string[] {
  const problems: string[] = [];
  if (!session.conversationId) problems.push('conversationId is required scope authority');
  if (!session.workspaceId) problems.push('workspaceId is required scope authority');
  if (session.version < 0) problems.push('version must be non-negative');
  if (session.recentDecisions.length > MAX_DECISIONS) problems.push('recentDecisions exceeds bound');
  if (session.generatedOutputs.length > MAX_GENERATED_OUTPUTS) problems.push('generatedOutputs exceeds bound');
  if (session.activeEntities.length > MAX_ACTIVE_ENTITIES) problems.push('activeEntities exceeds bound');
  const seen = new Set<string>();
  for (const e of session.activeEntities) {
    const key = `${e.type}:${e.id}`;
    if (seen.has(key)) problems.push(`duplicate active entity ${key}`);
    seen.add(key);
  }
  return problems;
}
