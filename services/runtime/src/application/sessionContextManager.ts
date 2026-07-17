/**
 * Session Context Manager (Phase 2) — the single owner of conversation working state.
 * Commands fold events through the aggregate and commit optimistically; queries are
 * side-effect free except the explicit, audited reconciliation on load (plan §11.4).
 */

import { randomUUID } from 'crypto';
import type { DecisionRecord, EntityRef, GoalState, SessionContext } from '../domain/types';
import {
  buildRunProjection,
  defaultProjectorDeps,
  foldAndCommit,
  hydrateSessionState,
  projectRunLifecycle,
  type ProjectorDeps,
  type SessionCommandEvent,
} from './sessionProjector';
import type { RunReadPort } from '../ports';
import { runReader } from '../adapters/sessionRepository';

export interface ManagerDeps extends ProjectorDeps { runs: RunReadPort }
const defaultDeps: ManagerDeps = { ...defaultProjectorDeps, runs: runReader };

/** Unique per invocation — user commands are deduplicated upstream by clientMessageId, not sourceKey. */
function commandKey(kind: string): string {
  return `cmd:${kind}:${randomUUID()}`;
}

async function apply(
  conversationId: string,
  events: SessionCommandEvent[],
  scope: { ownerId?: string; workspaceId?: string; projectId?: string | null } = {},
  deps: ManagerDeps = defaultDeps,
): Promise<SessionContext> {
  const res = await foldAndCommit({ conversationId, events, ...scope }, deps);
  return res.session;
}

export const sessionContextManager = {
  /** StartSession — idempotent: an existing session is returned untouched. */
  async startSession(
    input: { conversationId: string; workspaceId?: string; ownerId?: string; projectId?: string | null },
    deps: ManagerDeps = defaultDeps,
  ): Promise<SessionContext> {
    const stored = await deps.sessions.get(input.conversationId);
    if (stored) return hydrateSessionState(stored, input.conversationId);
    const res = await foldAndCommit({
      conversationId: input.conversationId,
      ownerId: input.ownerId,
      workspaceId: input.workspaceId,
      projectId: input.projectId ?? null,
      events: [{ eventType: 'ConversationStarted', sourceKey: `session:${input.conversationId}:started` }],
    }, deps);
    return res.session;
  },

  /**
   * GetSessionSnapshot with lazy reconciliation: when the indexed latest conversation run is
   * newer than the projected pointer, project it (audited SessionReconciled) before returning.
   */
  async getSession(
    conversationId: string,
    opts: { reconcile?: boolean } = {},
    deps: ManagerDeps = defaultDeps,
  ): Promise<SessionContext> {
    const stored = await deps.sessions.get(conversationId);
    let session = hydrateSessionState(stored, conversationId);
    if (opts.reconcile === false) return session;
    const latest = await deps.runs.latestByConversation(conversationId, { terminal: true }).catch(() => null);
    if (latest && latest.id && session.latestRun?.id !== latest.id) {
      const projection = buildRunProjection(latest);
      const res = await foldAndCommit({
        conversationId,
        events: [{ eventType: 'SessionReconciled', payload: projection as any, sourceKey: `reconcile:${latest.id}:${latest.status || 'completed'}` }],
      }, deps);
      session = res.session;
    }
    return session;
  },

  /** MergeRequestScope — client page/app context is a selection hint, never authorization. */
  async mergeRequestScope(
    conversationId: string,
    scope: { projectId?: string | null; app?: EntityRef | null; module?: EntityRef | null; page?: { path: string; title?: string; appId?: string } | null; ownerId?: string; workspaceId?: string },
    deps: ManagerDeps = defaultDeps,
  ): Promise<SessionContext> {
    const payload: Record<string, unknown> = {};
    if (scope.projectId !== undefined) payload.projectId = scope.projectId;
    if (scope.app !== undefined) payload.app = scope.app;
    if (scope.module !== undefined) payload.module = scope.module;
    if (scope.page !== undefined) payload.page = scope.page;
    if (!Object.keys(payload).length) return this.getSession(conversationId, { reconcile: false }, deps);
    return apply(conversationId, [{ eventType: 'ScopeSelected', payload, sourceKey: commandKey('scope') }],
      { ownerId: scope.ownerId, workspaceId: scope.workspaceId, projectId: scope.projectId ?? undefined }, deps);
  },

  async selectEntity(conversationId: string, entity: EntityRef, deps: ManagerDeps = defaultDeps): Promise<SessionContext> {
    const session = await apply(conversationId, [{ eventType: 'EntitySelected', payload: { entity }, sourceKey: commandKey('select') }], {}, deps);
    await deps.refs.upsert({ conversationId, entityType: entity.type, entityId: entity.id, relation: 'selected', salience: 4, metadata: { label: entity.label } }).catch(() => undefined);
    return session;
  },

  async recordGoal(conversationId: string, goal: GoalState, deps: ManagerDeps = defaultDeps): Promise<SessionContext> {
    return apply(conversationId, [{ eventType: 'GoalAccepted', payload: { goal }, sourceKey: commandKey('goal') }], {}, deps);
  },

  async recordDecision(conversationId: string, decision: DecisionRecord, deps: ManagerDeps = defaultDeps): Promise<SessionContext> {
    return apply(conversationId, [{ eventType: 'DecisionRecorded', payload: { decision }, sourceKey: commandKey('decision') }], {}, deps);
  },

  async recordCapabilityRouted(conversationId: string, capability: string, interaction: string, deps: ManagerDeps = defaultDeps): Promise<SessionContext> {
    return apply(conversationId, [{ eventType: 'CapabilityRouted', payload: { capability, interaction }, sourceKey: commandKey('route') }], {}, deps);
  },

  async linkGeneratedOutput(
    conversationId: string,
    output: { kind: string; refs: EntityRef[]; sourceRunId?: string; sourceMessageId?: string },
    deps: ManagerDeps = defaultDeps,
  ): Promise<SessionContext> {
    const payload = { output: { ...output, createdAt: new Date().toISOString() } };
    const session = await apply(conversationId, [{ eventType: 'ArtifactGenerated', payload, sourceKey: commandKey('artifact') }], {}, deps);
    for (const ref of output.refs.slice(0, 50)) {
      await deps.refs.upsert({
        conversationId, entityType: ref.type, entityId: ref.id, relation: 'generated',
        sourceRunId: output.sourceRunId, sourceMessageId: output.sourceMessageId, salience: 1, metadata: { label: ref.label },
      }).catch(() => undefined);
    }
    return session;
  },

  /** ProjectRunLifecycle — deterministic sourceKey; duplicates are no-ops (delegates to projector). */
  async projectRunLifecycle(
    input: { conversationId: string; run: any; phase: 'started' | 'completed' },
    deps: ManagerDeps = defaultDeps,
  ): Promise<{ projected: boolean }> {
    return projectRunLifecycle(input, deps);
  },

  async clearStaleEntity(conversationId: string, entity: EntityRef, reason: string, deps: ManagerDeps = defaultDeps): Promise<SessionContext> {
    return apply(conversationId, [{ eventType: 'EntityInvalidated', payload: { entity, reason }, sourceKey: commandKey('invalidate') }], {}, deps);
  },

  async archiveSession(conversationId: string, deps: ManagerDeps = defaultDeps): Promise<SessionContext> {
    return apply(conversationId, [{ eventType: 'ConversationArchived', sourceKey: `session:${conversationId}:archived` }], {}, deps);
  },

  /** Explicit audited correction: rebuild pointers from the indexed latest run. */
  async reconcileSession(conversationId: string, deps: ManagerDeps = defaultDeps): Promise<SessionContext> {
    return this.getSession(conversationId, { reconcile: true }, deps);
  },

  async getRecentDecisions(conversationId: string, deps: ManagerDeps = defaultDeps): Promise<DecisionRecord[]> {
    const session = await this.getSession(conversationId, { reconcile: false }, deps);
    return session.recentDecisions;
  },

  async getActiveEntities(conversationId: string, deps: ManagerDeps = defaultDeps): Promise<EntityRef[]> {
    const session = await this.getSession(conversationId, { reconcile: false }, deps);
    return session.activeEntities;
  },
};
