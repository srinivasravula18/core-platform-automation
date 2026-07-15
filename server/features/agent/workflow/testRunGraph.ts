/**
 * TestRunGraph — Phase 5: the complete deep-run workflow graph (LangGraph migration).
 *
 * Topology:
 *   START → load_context → discover_and_ground
 *   discover_and_ground → gate router: targeted_retry → discover_and_ground | blocked → finalize | continue → author_cases
 *   author_cases → router: no cases → finalize | manual review → review_cases | else → author_plans
 *   review_cases (interrupt kind 'cases') → rejected → finalize | revised (bounded) → author_cases | else → author_plans
 *   author_plans (per-case, bounded concurrency) → compile_and_validate
 *   compile_and_validate → router: unresolved targets + attempts left → discover_and_ground | no clean scripts → finalize
 *                                  | manual review → review_scripts | else → execute_tests
 *   review_scripts (interrupt kind 'scripts') → rejected → finalize | else → execute_tests
 *   execute_tests → finalize → END
 *
 * Composes the Phase 3-5 node MODULES directly (same pattern as graphs/discoveryGraph.ts): the node files
 * stay the unit-testable seams, only this file fuses them into one graph. Full payloads (evidence graph,
 * registry, plans, compiled sources) live in the run-scoped artifact stash; state carries refs/digests only.
 */
import { createHash } from 'crypto';
import { StateGraph, START, END, type BaseCheckpointSaver } from '@langchain/langgraph';
import { ensureRunAuthState, clearRunAuthState } from './authSession';
import { runContextNode } from './nodes/context';
import { runDiscoveryNode } from './nodes/discovery';
import { runGroundingNode, MAX_REDISCOVERY_ATTEMPTS } from './nodes/grounding';
import { authorTestCases, authorAbstractPlan, type AuthoredTestCase } from './nodes/authoring';
import { runCompilationNode } from './nodes/compilation';
import { buildPendingReview, requestReviewInterrupt } from './nodes/review';
import { runExecutionNode } from './nodes/execution';
import { routeAfterDiscoverAndGround, type ResolvedCredential } from './graphs/discoveryGraph';
import { stashArtifacts, readArtifacts } from './artifactStash';
import { WorkflowRuntimeError, WORKFLOW_ERROR_CLASSES, backoffDelayMs, type WorkflowError } from './errors';
import {
  WorkflowStateAnnotation,
  type CasePlanResult,
  type CredentialRef,
  type MissionRef,
  type UsageRecord,
  type WorkflowCase,
  type WorkflowCompilation,
  type WorkflowExecution,
  type WorkflowState,
  type WorkflowStateUpdate,
  type WorkflowStatus,
} from './state';
import type { MissionContext } from '../mission/missionContext';

// Re-exported so runtime/tests import every router from one place.
export { routeAfterDiscoverAndGround, MAX_REDISCOVERY_ATTEMPTS };

/** A 'revised' review decision re-authors cases at most this many times, then proceeds with a warning. */
export const MAX_REVIEW_REVISE = 1;
/** Per-case plan authoring fan-out bound. */
export const PLAN_AUTHORING_CONCURRENCY = 3;

export interface TestRunGraphDeps {
  /** Resolves a CredentialRef to a real secret INSIDE a node right before use (never stored in state). */
  resolveCredential?: (ref: CredentialRef | null) => Promise<ResolvedCredential | undefined>;
  /** Test seams — default to the real node functions. */
  contextNode?: typeof runContextNode;
  discoveryNode?: typeof runDiscoveryNode;
  groundingNode?: typeof runGroundingNode;
  authorCases?: typeof authorTestCases;
  authorPlan?: typeof authorAbstractPlan;
  executionNode?: typeof runExecutionNode;
  /** Topbar per-run provider/model/effort — forwarded to every authoring model call, like the legacy path. */
  modelOverrides?: { provider?: string; model?: string; effort?: string };
  /** Coverage "reuse": existing cases (with steps) used INSTEAD of LLM authoring. */
  seedCases?: any[];
  /** Coverage "gaps": existing case titles the author must not duplicate. */
  avoidCaseTitles?: string[];
}

export interface BuildTestRunGraphOptions {
  checkpointer?: BaseCheckpointSaver;
}

/** Full authored cases (steps included) per run — same transient in-process philosophy as artifactStash; state.cases stays bounded. */
const authoredCasesByRun = new Map<string, AuthoredTestCase[]>();

/** Full authored cases for the legacy projection (steps/priority/preconditions); empty after a restart — projection then falls back to the bounded state.cases. */
export function getAuthoredCases(runId: string): AuthoredTestCase[] {
  return authoredCasesByRun.get(runId) ?? [];
}

function sha1(value: unknown): string {
  return createHash('sha1').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
}

function nowIso(): string {
  return new Date().toISOString();
}

function nodeError(node: string, message: string): WorkflowError {
  return new WorkflowRuntimeError(WORKFLOW_ERROR_CLASSES.INVARIANT_VIOLATION, message, undefined, node).toWorkflowError();
}

/** The execution channel's reducer handles partial updates at runtime; the Annotation type is the full shape. */
function executionUpdate(partial: Partial<WorkflowExecution>): WorkflowExecution {
  return partial as WorkflowExecution;
}

/** Rehydrates the compiler's MissionContext from the checkpointed MissionRef (ids stand in for display names). */
export function missionContextFromRef(ref: MissionRef): MissionContext {
  return {
    platform: ref.platform,
    platformType: ref.platformType,
    runtimeSurface: ref.runtimeSurface,
    application: ref.applicationId ? { id: ref.applicationId, name: ref.applicationId } : null,
    module: ref.moduleId ? { id: ref.moduleId, name: ref.moduleId } : null,
    tab: ref.tabId ? { id: ref.tabId, name: ref.tabId } : null,
    targetUrl: ref.targetUrl,
    executionScope: ref.executionScope,
  };
}

/** Deterministic digest of the cases under review — the resumed re-run must rebuild the identical correlation id. */
export function casesReviewDigest(cases: WorkflowCase[]): string {
  return sha1(cases);
}

/** Deterministic digest of the compiled script set under review (sorted so ordering can never change identity). */
export function scriptsReviewDigest(compilation: WorkflowCompilation): string {
  return sha1((compilation?.scripts ?? []).map((s) => s.digest).sort());
}

/** Distinct unresolved/ambiguous semantic targets derived from the checkpointed diagnostics — drives targeted rediscovery. */
export function rediscoveryTargetsFromCompilation(compilation: WorkflowCompilation | null | undefined): string[] {
  const targets = new Set<string>();
  for (const d of compilation?.diagnostics ?? []) {
    if ((d.kind === 'AMBIGUOUS_SELECTOR' || d.kind === 'UNRESOLVED_SELECTOR') && d.target) targets.add(d.target);
  }
  return Array.from(targets);
}

// ---------------------------------------------------------------------------------------------
// Routers — exported for unit tests; each reads only persisted state, never in-memory artifacts.
// ---------------------------------------------------------------------------------------------

export function routeAfterAuthorCases(state: Pick<WorkflowState, 'cases' | 'request'>): 'finalize' | 'review_cases' | 'author_plans' {
  if (!state.cases || state.cases.length === 0) return 'finalize';
  return state.request.reviewPolicy === 'manual' ? 'review_cases' : 'author_plans';
}

export function routeAfterReviewCases(state: Pick<WorkflowState, 'review' | 'retryCounters'>): 'finalize' | 'author_cases' | 'author_plans' {
  const decision = state.review?.resolution?.decision;
  if (decision === 'rejected') return 'finalize';
  // 'revised' re-authors while within the bound (counter already incremented by the review node); beyond it, proceed.
  if (decision === 'revised' && (state.retryCounters?.['review_revise'] ?? 0) <= MAX_REVIEW_REVISE) return 'author_cases';
  return 'author_plans';
}

// Script→evidence is fully automatic: once scripts compile and pass the deterministic validation gate,
// they go straight to execution. The human gate lives at CASE review (author_cases); a second script
// review only slowed the loop without adding safety, since the compiler already refuses anything unverified.
export function routeAfterCompile(state: Pick<WorkflowState, 'compilation' | 'rediscoveryAttempts' | 'request'>): 'discover_and_ground' | 'finalize' | 'execute_tests' {
  if (rediscoveryTargetsFromCompilation(state.compilation).length > 0 && (state.rediscoveryAttempts ?? 0) < MAX_REDISCOVERY_ATTEMPTS) {
    return 'discover_and_ground';
  }
  if (!state.compilation?.scripts?.length) return 'finalize';
  return 'execute_tests';
}

// ---------------------------------------------------------------------------------------------
// Small utilities.
// ---------------------------------------------------------------------------------------------

/** Bounded worker pool — preserves input order in the results. */
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) break;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Bounded terminal failure reason — the most specific persisted cause wins. */
function terminalFailureReason(state: WorkflowState): string {
  if (state.review?.resolution?.decision === 'rejected') {
    return `Review rejected (${state.review.pending?.kind ?? 'unknown'} review).`;
  }
  const gate = state.evidence?.gate;
  if (gate && gate.decision === 'blocked') {
    const reasons = gate.reasons.join('; ');
    // Older gates (or resumed threads) may carry only the generic no-targets line while the real
    // discovery failure sits in state.errors — surface that root cause instead of masking it.
    const rootCause = [...(state.errors ?? [])].reverse().find((e) => e.nodeName === 'discovery');
    const suffix = rootCause && !reasons.includes(rootCause.message)
      ? `; root cause: [${rootCause.class}] ${rootCause.message}` : '';
    return `Evidence gate blocked: ${reasons}${suffix}`.slice(0, 400);
  }
  if (!state.cases?.length) return 'Authoring produced no test cases.';
  if (!state.compilation?.scripts?.length) {
    const diags = state.compilation?.diagnostics ?? [];
    if (diags.length) {
      const head = diags.slice(0, 3).map((d) => `${d.kind}${d.target ? `(${d.target})` : ''}`).join(', ');
      return `No clean compiled scripts: ${head}${diags.length > 3 ? ` (+${diags.length - 3} more)` : ''}`;
    }
    return 'Compilation produced no scripts.';
  }
  const lastError = state.errors?.[state.errors.length - 1];
  return lastError ? `Execution did not complete: ${lastError.message}`.slice(0, 400) : 'Run ended without an execution result.';
}

// ---------------------------------------------------------------------------------------------
// Graph builder.
// ---------------------------------------------------------------------------------------------

/** Builds and compiles the Phase 5 deep-run graph; real nodes by default, injectable for tests. */
export function buildTestRunGraph(deps: TestRunGraphDeps = {}, opts: BuildTestRunGraphOptions = {}) {
  const contextNode = deps.contextNode ?? runContextNode;
  const discoveryNode = deps.discoveryNode ?? runDiscoveryNode;
  const groundingNode = deps.groundingNode ?? runGroundingNode;
  const authorCases = deps.authorCases ?? authorTestCases;
  const authorPlan = deps.authorPlan ?? authorAbstractPlan;
  const executionNode = deps.executionNode ?? runExecutionNode;
  // No resolver injected → run credential-less (the runtime wires the real per-run resolver).
  const resolveCredential = deps.resolveCredential ?? (async () => undefined);

  const loadContext = async (state: WorkflowState): Promise<WorkflowStateUpdate> => {
    // Resolved just-in-time, used immediately, never returned — checkpoints stay secret-free.
    const credential = await resolveCredential(state.credentialRef ?? null);
    const result = await contextNode({ mission: state.mission, credential });
    // API-acceptance test data: fetch the mission object's backend schema once, stash for the compiler (best-effort).
    // Real path only — an injected context seam (tests) skips the live schema fetch, same as the auth prep.
    if (!deps.contextNode && state.mission?.applicationId && credential) {
      try {
        const { fetchObjectSchema } = await import('../../../ai/tools/corePlatformData');
        const conn = { baseUrl: state.mission.targetUrl, token: credential.token, username: credential.username, password: credential.password };
        const hints = [state.mission.moduleId, state.mission.tabId].filter(Boolean) as string[];
        const schema = await fetchObjectSchema(conn as any, state.mission.applicationId, hints);
        if (schema.length) stashArtifacts(state.runId, { objectSchema: schema });
      } catch { /* schema is an enhancement — its absence just falls back to DOM-semantic generation */ }
    }
    return {
      context: { ...(state.context ?? { metadata: null, repository: null, roles: [], budget: [] }), metadata: result.context.metadata },
      status: 'running',
      startedAt: state.startedAt ?? nowIso(),
      updatedAt: nowIso(),
      stage: 'load_context',
      errors: result.errors,
    };
  };

  const discoverAndGround = async (state: WorkflowState): Promise<WorkflowStateUpdate> => {
    // One bounded attempt per RE-entry: gate-driven targeted_retry OR compile-driven rediscovery (stage tells which node sent us back).
    const reEntered = state.evidence?.gate?.decision === 'targeted_retry' || state.stage === 'compile_and_validate';
    const attempts = reEntered ? (state.rediscoveryAttempts ?? 0) + 1 : (state.rediscoveryAttempts ?? 0);
    const credential = await resolveCredential(state.credentialRef ?? null);
    // ONE real login per run: first attempt logs in and caches state; rediscovery attempts reuse it.
    let auth = deps.discoveryNode
      ? undefined // injected discovery seam (tests) owns its own setup — no real login here
      : await ensureRunAuthState(state.runId, state.mission?.targetUrl || '', credential);
    let discovery = await discoveryNode({ mission: state.mission, credential, runId: state.runId, auth });
    let discoveryAttempts = 1;
    // The node returns classified errors instead of throwing, so the retry policy (workflow/errors.ts) is
    // applied HERE at the invocation layer — with real backoff, real path only. Without this, a transient
    // network/browser blip yields 0 elements and the evidence gate burns its rediscovery budget in seconds.
    if (!deps.discoveryNode) {
      for (;;) {
        const failure = discovery.elements.length === 0 ? discovery.errors.find((e) => e.retryable) : undefined;
        if (!failure || discoveryAttempts >= failure.maxAttempts) break;
        // An auth-classified failure invalidates the cached session so the next attempt logs in fresh.
        if (failure.class === WORKFLOW_ERROR_CLASSES.AUTH_FAILURE) clearRunAuthState(state.runId);
        const delay = backoffDelayMs(failure.class, discoveryAttempts);
        if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
        if (failure.class === WORKFLOW_ERROR_CLASSES.AUTH_FAILURE) {
          auth = await ensureRunAuthState(state.runId, state.mission?.targetUrl || '', credential);
        }
        discovery = await discoveryNode({ mission: state.mission, credential, runId: state.runId, auth });
        discoveryAttempts += 1;
      }
      // Still auth-failed after the policy attempts — drop the cached session so any later re-entry logs in fresh.
      if (discovery.errors.some((e) => e.class === WORKFLOW_ERROR_CLASSES.AUTH_FAILURE)) clearRunAuthState(state.runId);
    }
    // Raw elements never reach state — grounding projects them into the bounded evidence envelope.
    const grounding = groundingNode({
      elements: discovery.elements,
      metadataDigest: state.context?.metadata?.digest ?? null,
      rediscoveryAttempts: attempts,
      // Zero elements WITH a classified error = discovery never read the page (its throw path always returns
      // empty) — the gate then blocks with this root cause instead of looping on an unreachable target.
      discoveryFailure: discovery.elements.length === 0 ? (discovery.errors[0] ?? null) : null,
      discoveryAttempts,
    });
    // Full graph/registry go to the run stash for authoring/compilation; state gets refs/digests only.
    stashArtifacts(state.runId, { evidenceGraph: grounding.evidenceGraph, verifiedSelectors: grounding.verifiedSelectors });
    return {
      evidence: grounding.evidence,
      rediscoveryAttempts: attempts,
      stage: 'discover_and_ground',
      updatedAt: nowIso(),
      errors: [...discovery.errors, ...grounding.errors],
    };
  };

  // Authors are TOLD stored credentials exist (auth handled by session injection) — never given them.
  const hasStoredCredentials = async (state: WorkflowState): Promise<boolean> =>
    Boolean((await resolveCredential(state.credentialRef ?? null).catch(() => undefined))?.username);

  const authorCasesNode = async (state: WorkflowState): Promise<WorkflowStateUpdate> => {
    // Coverage "reuse": use the user-selected existing cases verbatim — NO LLM authoring. Plans are still
    // re-authored against fresh live evidence, so reused cases execute against verified current selectors.
    if (deps.seedCases?.length) {
      const seeded = deps.seedCases.map((c: any) => ({
        title: String(c.title || 'Untitled'),
        description: String(c.description || ''),
        preconditions: String(c.preconditions || ''),
        tags: Array.isArray(c.tags) ? c.tags : [],
        priority: c.priority || 'Medium',
        type: c.type || 'Automated',
        steps: Array.isArray(c.steps) ? c.steps : [],
      }));
      authoredCasesByRun.set(state.runId, seeded as AuthoredTestCase[]);
      const cases: WorkflowCase[] = seeded.map((c, i) => ({ id: `case-${i + 1}`, title: c.title, description: c.description || undefined, tags: c.tags?.length ? c.tags : undefined }));
      return { cases, stage: 'author_cases', updatedAt: nowIso(), errors: [], usage: [] };
    }

    const { evidenceGraph } = readArtifacts(state.runId);
    const result = await authorCases({
      mission: state.mission,
      goal: state.request.goal,
      requestedCaseCount: state.request.requestedCaseCount,
      evidenceGraph: evidenceGraph ?? null,
      overrides: deps.modelOverrides,
      hasStoredCredentials: await hasStoredCredentials(state),
      // Coverage "gaps": don't re-author cases the user already has.
      avoidCaseTitles: deps.avoidCaseTitles,
    });
    // Full cases (steps included) stay in-process for plan authoring; state holds the bounded WorkflowCase shape.
    authoredCasesByRun.set(state.runId, result.cases);
    const cases: WorkflowCase[] = result.cases.map((c, i) => ({
      id: `case-${i + 1}`,
      title: c.title,
      description: c.description || undefined,
      tags: c.tags?.length ? c.tags : undefined,
    }));
    return { cases, stage: 'author_cases', updatedAt: nowIso(), errors: result.errors, usage: result.usage };
  };

  const reviewCasesNode = (state: WorkflowState): WorkflowStateUpdate => {
    // Routed to only under manual policy; guarded anyway so an auto run can never block on a human.
    if (state.request.reviewPolicy !== 'manual') return { stage: 'review_cases', updatedAt: nowIso() };
    const digest = casesReviewDigest(state.cases);
    const pending = buildPendingReview('cases', digest);
    // interrupt() throws GraphInterrupt on the first pass — everything above this line must stay pure.
    const resolution = requestReviewInterrupt('cases', digest);
    const retryCounters = { ...(state.retryCounters ?? {}) };
    const errors: WorkflowError[] = [];
    if (resolution.decision === 'revised') {
      const next = (retryCounters['review_revise'] ?? 0) + 1;
      retryCounters['review_revise'] = next;
      if (next > MAX_REVIEW_REVISE) {
        errors.push(nodeError('review_cases', `Review revise limit (${MAX_REVIEW_REVISE}) reached — proceeding with the current cases despite the 'revised' decision.`));
      }
    }
    return { review: { pending, resolution }, retryCounters, stage: 'review_cases', updatedAt: nowIso(), errors };
  };

  const authorPlansNode = async (state: WorkflowState): Promise<WorkflowStateUpdate> => {
    const { evidenceGraph } = readArtifacts(state.runId);
    const fullCases = authoredCasesByRun.get(state.runId) ?? [];
    const authed = await hasStoredCredentials(state);
    const authored = await mapWithConcurrency(state.cases, PLAN_AUTHORING_CONCURRENCY, async (testCase, index) => {
      // Index-aligned with author_cases's mapping; a stash-less resumed thread degrades to title/description only.
      const full = fullCases[index];
      const result = await authorPlan({
        mission: state.mission,
        testCase: { title: testCase.title, description: testCase.description ?? full?.description, steps: full?.steps },
        evidenceGraph: evidenceGraph ?? null,
        overrides: deps.modelOverrides,
        hasStoredCredentials: authed,
      });
      return { caseId: testCase.id, result };
    });
    const planResults: CasePlanResult[] = [];
    const errors: WorkflowError[] = [];
    const usage: UsageRecord[] = [];
    for (const { caseId, result } of authored) {
      usage.push(...result.usage);
      if (result.plan) {
        // Full plan → stash; state carries only the ref/digest per A.4.
        stashArtifacts(state.runId, { plansByCase: { [caseId]: result.plan } });
        planResults.push({ caseId, status: 'planned', planRef: `plan:${caseId}:${sha1(result.plan)}` });
      } else {
        errors.push(...result.errors);
        planResults.push({ caseId, status: 'failed', planRef: null, error: result.errors[0] });
      }
    }
    return { plansByCase: planResults, stage: 'author_plans', updatedAt: nowIso(), errors, usage };
  };

  const compileAndValidate = (state: WorkflowState): WorkflowStateUpdate => {
    if (!state.mission) {
      return {
        compilation: { scripts: [], diagnostics: [], compilerVersion: null },
        stage: 'compile_and_validate',
        updatedAt: nowIso(),
        errors: [nodeError('compile_and_validate', 'Compilation requires a resolved mission.')],
      };
    }
    const artifacts = readArtifacts(state.runId);
    // A resumed thread whose stash is gone compiles against empty evidence → explicit diagnostics, never a silent guess.
    const result = runCompilationNode({
      mission: missionContextFromRef(state.mission),
      cases: state.cases,
      plansByCase: artifacts.plansByCase ?? {},
      evidenceGraph: artifacts.evidenceGraph ?? { nodes: [], edges: [], selectorRegistryRef: 'selector_registry' },
      verifiedSelectors: artifacts.verifiedSelectors ?? [],
      objectSchema: artifacts.objectSchema, // stashed at load_context — threaded to the compiler for API-conformant data.
    });
    if (Object.keys(result.compiledSources).length) stashArtifacts(state.runId, { compiledSources: result.compiledSources });
    return {
      coveragePlan: result.coveragePlan,
      riskScores: result.riskScores,
      compilation: result.compilation,
      stage: 'compile_and_validate',
      updatedAt: nowIso(),
      errors: result.errors,
    };
  };

  // Script review intentionally removed — compiled+validated scripts flow straight to execution (see routeAfterCompile).
  const executeTests = async (state: WorkflowState): Promise<WorkflowStateUpdate> => {
    const compiledSources = readArtifacts(state.runId).compiledSources ?? {};
    const titleByCase = new Map(state.cases.map((c) => [c.id, c.title]));
    const scripts = (state.compilation?.scripts ?? [])
      .filter((s) => s.ok && compiledSources[s.caseId])
      .map((s) => ({ filename: `${s.caseId}.spec.ts`, title: titleByCase.get(s.caseId) ?? s.caseId, code: compiledSources[s.caseId] }));
    if (!scripts.length) {
      return {
        stage: 'execute_tests',
        updatedAt: nowIso(),
        errors: [nodeError('execute_tests', 'No compiled sources available to execute (artifact stash empty for the compiled script set).')],
      };
    }
    // Replay-safe idempotency key: digest of the compiled script-set digests (A.3.3).
    const scriptSetDigest = sha1((state.compilation?.scripts ?? []).map((s) => s.digest).sort());
    // Compiled specs never log in themselves (MissionRunner expects an injected authenticated session):
    // resolve the credential just-in-time and prepare storage/session state with the proven pipeline login.
    let storageStatePath: string | undefined;
    let sessionStorageState: { origin: string; items: Record<string, string> } | undefined;
    // Auth prep belongs to REAL execution only — an injected execution seam (tests) owns its own setup.
    // Reuses the run's ONE cached login (workflow/authSession) — no fresh login for execution.
    const credential = deps.executionNode ? undefined : await resolveCredential(state.credentialRef ?? null).catch(() => undefined);
    if (credential?.username && credential?.password && state.mission?.targetUrl) {
      try {
        const auth = await ensureRunAuthState(state.runId, state.mission.targetUrl, credential);
        storageStatePath = auth.storageStatePath;
        sessionStorageState = auth.sessionStorageState;
      } catch { /* execution proceeds unauthenticated; failures will name the real cause */ }
    }
    const result = await executionNode({
      runId: state.runId,
      scripts,
      baseUrl: state.mission?.targetUrl,
      scriptSetDigest,
      priorAttempts: state.execution?.attempts ?? [],
      storageStatePath,
      sessionStorageState,
    });
    if (result.evidenceShots?.length) stashArtifacts(state.runId, { evidenceShots: result.evidenceShots });
    return {
      execution: executionUpdate({
        attempts: result.attempt ? [result.attempt] : [],
        ...(result.aggregate !== null ? { aggregate: result.aggregate } : {}),
        ...(result.evidenceRefs.length ? { evidenceRefs: result.evidenceRefs } : {}),
      }),
      stage: 'execute_tests',
      updatedAt: nowIso(),
      errors: result.errors,
    };
  };

  const finalize = (state: WorkflowState): WorkflowStateUpdate => {
    const completedAttempt = (state.execution?.attempts ?? []).some((a) => a.status === 'completed');
    let status: WorkflowStatus;
    let reason: string | undefined;
    if (state.cancelRequested) {
      status = 'cancelled';
      reason = 'Cancellation requested.';
    } else if (state.execution?.aggregate || completedAttempt) {
      status = 'completed';
    } else {
      status = 'failed';
      reason = terminalFailureReason(state);
    }
    const agg = state.execution?.aggregate;
    const summary = status === 'completed'
      ? `${state.cases.length} case(s), ${state.compilation?.scripts?.length ?? 0} compiled script(s)`
        + (agg ? `, execution ${agg.passed}/${agg.totalCases} passed` : ', execution result reused from a prior attempt')
      : `Run ${status}: ${reason}`;
    return {
      status,
      stage: 'finalize',
      completedAt: nowIso(),
      updatedAt: nowIso(),
      output: { summary: summary.slice(0, 500), reportRef: null, ...(reason ? { reason: reason.slice(0, 500) } : {}) },
    };
  };

  // Node names deliberately avoid every state channel name (LangGraph rejects collisions).
  const graph = new StateGraph(WorkflowStateAnnotation)
    .addNode('load_context', loadContext)
    .addNode('discover_and_ground', discoverAndGround)
    .addNode('author_cases', authorCasesNode)
    .addNode('review_cases', reviewCasesNode)
    .addNode('author_plans', authorPlansNode)
    .addNode('compile_and_validate', compileAndValidate)
    .addNode('execute_tests', executeTests)
    .addNode('finalize', finalize)
    .addEdge(START, 'load_context')
    .addEdge('load_context', 'discover_and_ground')
    .addConditionalEdges('discover_and_ground', routeAfterDiscoverAndGround, {
      continue: 'author_cases',
      blocked: 'finalize',
      targeted_retry: 'discover_and_ground',
    })
    .addConditionalEdges('author_cases', routeAfterAuthorCases, {
      finalize: 'finalize',
      review_cases: 'review_cases',
      author_plans: 'author_plans',
    })
    .addConditionalEdges('review_cases', routeAfterReviewCases, {
      finalize: 'finalize',
      author_cases: 'author_cases',
      author_plans: 'author_plans',
    })
    .addEdge('author_plans', 'compile_and_validate')
    .addConditionalEdges('compile_and_validate', routeAfterCompile, {
      discover_and_ground: 'discover_and_ground',
      finalize: 'finalize',
      execute_tests: 'execute_tests',
    })
    .addEdge('execute_tests', 'finalize')
    .addEdge('finalize', END);

  return graph.compile({ checkpointer: opts.checkpointer });
}
