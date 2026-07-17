/**
 * Session projector (Phase 2) — folds session events into the versioned snapshot and turns
 * durable run outcomes into events + entity-recency rows. Idempotent by construction: every
 * projection event carries a deterministic sourceKey, so at-least-once delivery (legacy
 * pipeline, LangGraph hook, reconciliation) projects exactly once.
 */

import type { EntityRef, SessionContext, SessionEventType } from '../domain/types';
import { applySessionEvent, createInitialSession, type RunProjectionPayload } from '../domain/session';
import type { EntityRefIndexPort, SessionRepositoryPort, StoredSession } from '../ports';
import { sessionRepository, entityRefIndex } from '../adapters/sessionRepository';

export interface ProjectorDeps { sessions: SessionRepositoryPort; refs: EntityRefIndexPort }
export const defaultProjectorDeps: ProjectorDeps = { sessions: sessionRepository, refs: entityRefIndex };

/** Stored snapshots may predate newer state fields; hydrate onto a fresh initial shape. */
export function hydrateSessionState(stored: StoredSession | null, conversationId: string): SessionContext {
  const base = createInitialSession({
    conversationId,
    workspaceId: stored?.workspaceId,
    ownerId: stored?.ownerId,
    projectId: stored?.projectId ?? null,
  });
  const state = stored?.state && typeof stored.state === 'object' ? stored.state : {};
  return { ...base, ...state, conversationId, version: stored?.version ?? 0 } as SessionContext;
}

export interface SessionCommandEvent {
  eventType: SessionEventType;
  payload?: Record<string, unknown>;
  sourceKey: string;
  correlationId?: string;
  causationId?: string;
  actorId?: string;
}

// Per-conversation in-process mutex: same-node writers serialize instead of burning
// optimistic retries (PG advisory locks only serialize the commit itself, not the fold).
const commitChains = new Map<string, Promise<void>>();
function withConversationLock<T>(conversationId: string, fn: () => Promise<T>): Promise<T> {
  const prev = commitChains.get(conversationId) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(fn);
  const tail = run.then(() => undefined, () => undefined);
  commitChains.set(conversationId, tail);
  void tail.finally(() => { if (commitChains.get(conversationId) === tail) commitChains.delete(conversationId); });
  return run;
}

/**
 * Load → fold events onto state → commit atomically with optimistic version, retrying on
 * concurrent writers (other nodes). Duplicate sourceKeys fold idempotently.
 */
export async function foldAndCommit(
  input: {
    conversationId: string;
    events: SessionCommandEvent[];
    ownerId?: string;
    workspaceId?: string;
    projectId?: string | null;
  },
  deps: ProjectorDeps = defaultProjectorDeps,
): Promise<{ ok: boolean; session: SessionContext; appendedEvents: number }> {
  const conversationId = String(input.conversationId || '').trim();
  if (!conversationId) throw new Error('foldAndCommit: conversationId required');
  return withConversationLock(conversationId, () => foldAndCommitLocked(conversationId, input, deps));
}

async function foldAndCommitLocked(
  conversationId: string,
  input: Parameters<typeof foldAndCommit>[0],
  deps: ProjectorDeps,
): Promise<{ ok: boolean; session: SessionContext; appendedEvents: number }> {
  // Retries handle OTHER nodes' commits (multi-instance PG); local writers are serialized above.
  for (let attempt = 0; attempt < 5; attempt++) {
    const stored = await deps.sessions.get(conversationId);
    let state = hydrateSessionState(stored, conversationId);
    if (input.ownerId && !state.ownerId) state = { ...state, ownerId: input.ownerId };
    if (input.projectId && !state.projectId) state = { ...state, projectId: input.projectId };
    for (const event of input.events) {
      state = applySessionEvent(state, event.eventType, event.payload || {});
    }
    const res = await deps.sessions.commit({
      conversationId,
      ownerId: input.ownerId || stored?.ownerId || undefined,
      workspaceId: input.workspaceId || stored?.workspaceId || undefined,
      projectId: input.projectId ?? stored?.projectId ?? undefined,
      state,
      expectedVersion: stored?.version ?? 0,
      events: input.events,
    });
    if (res.ok) {
      return { ok: true, session: hydrateSessionState(res.session, conversationId), appendedEvents: res.appendedEvents };
    }
    // Version conflict: another writer committed first — reload and refold.
  }
  const latest = await deps.sessions.get(conversationId);
  return { ok: false, session: hydrateSessionState(latest, conversationId), appendedEvents: 0 };
}

/** Deterministic projection of one run's artifact graph (plan §13.4 edges). */
export function buildRunProjection(run: any): RunProjectionPayload {
  const runId = String(run?.id || '');
  const runRef: EntityRef = { type: 'run', id: runId, label: run?.artifactName || run?.prompt?.slice(0, 80) || runId };

  const cases: any[] = Array.isArray(run?.generated_cases) ? run.generated_cases : (Array.isArray(run?.generatedCases) ? run.generatedCases : []);
  const scripts: any[] = Array.isArray(run?.playwright_scripts) ? run.playwright_scripts : (Array.isArray(run?.playwrightScripts) ? run.playwrightScripts : []);
  const tests: any[] = Array.isArray(run?.execution_result?.tests) ? run.execution_result.tests : [];

  const caseRefs: EntityRef[] = cases
    .filter((c) => c && (c.id || c.title))
    .map((c) => ({ type: 'test_case' as const, id: String(c.id || c.title), label: String(c.title || c.id) }));
  const scriptRefs: EntityRef[] = scripts
    .filter((s) => s && (s.id || s.name || s.title || s.filename))
    .map((s) => ({ type: 'script' as const, id: String(s.id || s.name || s.filename || s.title), label: String(s.title || s.name || s.filename || s.id) }));

  // Verdict → case/script correlation uses stable IDs when present, exact title otherwise.
  const failedTests = tests.filter((t) => String(t?.status || '').toLowerCase() === 'failed');
  const failedTitles = new Set(failedTests.map((t) => String(t?.title || '').trim()).filter(Boolean));
  const failedCaseIds = new Set(failedTests.filter((t) => t?.caseId).map((t) => String(t.caseId)));
  const failedCaseRefs = caseRefs.filter((c) => failedCaseIds.has(c.id) || failedTitles.has(String(c.label || '').trim()));
  const failedScriptRefs = scriptRefs.filter((s) => failedTitles.has(String(s.label || '').trim()));

  const screenshots: any[] = Array.isArray(run?.evidence_screenshots) ? run.evidence_screenshots : [];
  const artifactSet = (caseRefs.length || scriptRefs.length || screenshots.length)
    ? {
        id: `artifacts:${runId}`,
        sourceRunId: runId,
        artifactRefs: screenshots.slice(0, 20).map((s: any, i: number) => ({
          artifactId: String(s?.id || s?.path || s?.url || `${runId}:shot:${i}`), kind: 'screenshot',
        })),
      }
    : null;

  return { runRef, status: String(run?.status || ''), caseRefs, scriptRefs, failedCaseRefs, failedScriptRefs, defectRefs: [], artifactSet };
}

/** Persist entity-recency rows for a run's graph so the resolver can traverse it. */
async function indexRunGraph(
  conversationId: string,
  projection: RunProjectionPayload,
  scope: { ownerId?: string; projectId?: string; appId?: string },
  deps: ProjectorDeps,
): Promise<void> {
  const runId = projection.runRef.id;
  const base = { conversationId, sourceRunId: runId, ownerId: scope.ownerId, projectId: scope.projectId, appId: scope.appId };
  await deps.refs.upsert({ ...base, entityType: 'run', entityId: runId, relation: 'latest', salience: 3 });
  for (const c of projection.caseRefs || []) await deps.refs.upsert({ ...base, entityType: 'test_case', entityId: c.id, relation: 'generated', salience: 1, metadata: { label: c.label } });
  for (const s of projection.scriptRefs || []) await deps.refs.upsert({ ...base, entityType: 'script', entityId: s.id, relation: 'generated', salience: 1, metadata: { label: s.label } });
  for (const c of projection.failedCaseRefs || []) await deps.refs.upsert({ ...base, entityType: 'test_case', entityId: c.id, relation: 'failed', salience: 2, metadata: { label: c.label } });
  for (const s of projection.failedScriptRefs || []) await deps.refs.upsert({ ...base, entityType: 'script', entityId: s.id, relation: 'failed', salience: 2, metadata: { label: s.label } });
}

/** SESSION_RUN_PROJECTION_V1 (default on): both run engines publish lifecycle projections. */
export function runProjectionEnabled(): boolean {
  return String(process.env.SESSION_RUN_PROJECTION_V1 ?? 'true').toLowerCase() !== 'false';
}

/** Fire-and-forget engine hook: never throws, never blocks the run pipeline. */
export function projectRunLifecycleSafe(input: { run: any; phase: 'started' | 'completed' }): void {
  if (!runProjectionEnabled()) return;
  const conversationId = String(input.run?.conversationId || '').trim();
  if (!conversationId || !input.run?.id) return;
  void projectRunLifecycle({ conversationId, run: input.run, phase: input.phase })
    .catch((err) => console.warn(`[session-projection] run ${input.run?.id} ${input.phase} failed:`, err?.message || err));
}

/**
 * Project a run lifecycle transition into the conversation session. Safe to call from both
 * run engines and from reconciliation: duplicate (runId, status) deliveries are no-ops.
 */
export async function projectRunLifecycle(
  input: { conversationId: string; run: any; phase: 'started' | 'completed'; actorId?: string },
  deps: ProjectorDeps = defaultProjectorDeps,
): Promise<{ projected: boolean }> {
  const conversationId = String(input.conversationId || '').trim();
  const runId = String(input.run?.id || '').trim();
  if (!conversationId || !runId) return { projected: false };

  const scope = {
    ownerId: input.run?.ownerId || undefined,
    projectId: input.run?.projectId || undefined,
    appId: input.run?.appId || undefined,
  };

  // At-least-once delivery precheck: an already-projected sourceKey must not even bump the
  // snapshot version (the repo would dedupe the event but still rewrite state).
  const status = ['completed', 'failed', 'cancelled'].includes(String(input.run?.status || '')) ? String(input.run.status) : 'completed';
  const sourceKey = input.phase === 'started' ? `run:${runId}:started` : `run:${runId}:${status}`;
  const priorEvents = await deps.sessions.listEvents(conversationId).catch(() => []);
  if (priorEvents.some((e: any) => e.sourceKey === sourceKey)) return { projected: false };
  // Out-of-order delivery: a late "started" after a terminal projection is retained as
  // history nowhere — it must never regress terminal state (plan §27 run projections).
  if (input.phase === 'started'
    && priorEvents.some((e: any) => typeof e.sourceKey === 'string' && e.sourceKey.startsWith(`run:${runId}:`) && e.sourceKey !== `run:${runId}:started`)) {
    return { projected: false };
  }

  if (input.phase === 'started') {
    const runRef: EntityRef = { type: 'run', id: runId };
    const res = await foldAndCommit({
      conversationId, ownerId: scope.ownerId, projectId: scope.projectId,
      events: [{ eventType: 'RunStarted', payload: { runRef } as any, sourceKey: `run:${runId}:started`, actorId: input.actorId }],
    }, deps);
    if (res.ok && res.appendedEvents > 0) {
      await deps.refs.upsert({ conversationId, entityType: 'run', entityId: runId, relation: 'current', sourceRunId: runId, ...scope, salience: 3 });
      return { projected: true };
    }
    return { projected: false };
  }

  const projection = buildRunProjection(input.run);
  const res = await foldAndCommit({
    conversationId, ownerId: scope.ownerId, projectId: scope.projectId,
    events: [{ eventType: 'RunCompleted', payload: projection as any, sourceKey: `run:${runId}:${status}`, actorId: input.actorId }],
  }, deps);
  if (res.ok && res.appendedEvents > 0) {
    await indexRunGraph(conversationId, projection, scope, deps);
    return { projected: true };
  }
  return { projected: false };
}
